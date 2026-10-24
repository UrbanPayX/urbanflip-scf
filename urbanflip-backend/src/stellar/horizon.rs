//! Horizon REST client: account loads, submission with result-code
//! extraction, and payment observation (joined to transactions for memos).

use crate::domain::rails::ObservedPayment;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct BalanceLine {
    pub asset_type: String,
    pub asset_code: Option<String>,
    pub asset_issuer: Option<String>,
    pub balance: String,
    pub is_authorized: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct AccountInfo {
    pub sequence: u64,
    pub auth_required: bool,
    pub auth_revocable: bool,
    pub auth_clawback_enabled: bool,
    pub balances: Vec<BalanceLine>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TrustlineState {
    Ready,
    NoAccount,
    Missing,
    Unauthorized,
}

#[derive(Debug, Clone)]
pub struct SubmitFailure {
    pub tx_result_code: Option<String>,
    pub op_result_codes: Vec<String>,
    pub http_status: Option<u16>,
}

#[derive(Debug, thiserror::Error)]
pub enum HorizonError {
    #[error("horizon transport: {0}")]
    Transport(String),
    #[error("account not found: {0}")]
    NoAccount(String),
    /// The network refused the tx (result codes present): it did not apply.
    #[error("transaction rejected: {0:?}")]
    Rejected(SubmitFailure),
    /// Submission timed out or the connection dropped: the tx MAY still apply
    /// until its max_time; resolve by hash before acting again.
    #[error("submission outcome unknown: {0}")]
    Indeterminate(String),
}

#[derive(Deserialize)]
struct HorizonAccount {
    sequence: String,
    #[serde(default)]
    flags: HorizonFlags,
    #[serde(default)]
    balances: Vec<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct HorizonFlags {
    #[serde(default)]
    auth_required: serde_json::Value,
    #[serde(default)]
    auth_revocable: serde_json::Value,
    #[serde(default)]
    auth_clawback_enabled: serde_json::Value,
}

fn truthy(v: &serde_json::Value) -> bool {
    matches!(v, serde_json::Value::Bool(true)) || v.as_str() == Some("true")
}

#[derive(Clone)]
pub struct HorizonClient {
    base: String,
    http: reqwest::Client,
}

impl HorizonClient {
    pub fn new(base: &str) -> Self {
        Self { base: base.trim_end_matches('/').to_string(), http: reqwest::Client::new() }
    }

    pub async fn account(&self, address: &str) -> Result<AccountInfo, HorizonError> {
        let url = format!("{}/accounts/{}", self.base, address);
        let res = self.http.get(&url).send().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
        if res.status().as_u16() == 404 {
            return Err(HorizonError::NoAccount(address.to_string()));
        }
        let account: HorizonAccount = res.json().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
        let balances = account
            .balances
            .iter()
            .map(|b| BalanceLine {
                asset_type: b.get("asset_type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                asset_code: b.get("asset_code").and_then(|v| v.as_str()).map(str::to_string),
                asset_issuer: b.get("asset_issuer").and_then(|v| v.as_str()).map(str::to_string),
                balance: b.get("balance").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
                is_authorized: b.get("is_authorized").and_then(|v| v.as_bool()),
            })
            .collect();
        Ok(AccountInfo {
            sequence: account.sequence.parse().map_err(|e| HorizonError::Transport(format!("bad sequence: {e}")))?,
            auth_required: truthy(&account.flags.auth_required),
            auth_revocable: truthy(&account.flags.auth_revocable),
            auth_clawback_enabled: truthy(&account.flags.auth_clawback_enabled),
            balances,
        })
    }

    pub async fn next_sequence(&self, address: &str) -> Result<u64, HorizonError> {
        Ok(self.account(address).await?.sequence + 1)
    }

    pub async fn trustline_state(&self, address: &str, code: &str, issuer: &str) -> Result<TrustlineState, HorizonError> {
        let account = match self.account(address).await {
            Ok(a) => a,
            Err(HorizonError::NoAccount(_)) => return Ok(TrustlineState::NoAccount),
            Err(e) => return Err(e),
        };
        let Some(line) = account
            .balances
            .iter()
            .find(|b| b.asset_code.as_deref() == Some(code) && b.asset_issuer.as_deref() == Some(issuer))
        else {
            return Ok(TrustlineState::Missing);
        };
        if line.is_authorized == Some(false) {
            return Ok(TrustlineState::Unauthorized);
        }
        Ok(TrustlineState::Ready)
    }

    /// Submits a base64 envelope; returns the tx hash or structured failure.
    pub async fn submit(&self, envelope_b64: &str) -> Result<String, HorizonError> {
        let url = format!("{}/transactions", self.base);
        let res = self
            .http
            .post(&url)
            .form(&[("tx", envelope_b64)])
            .send()
            .await
            .map_err(|e| HorizonError::Indeterminate(e.to_string()))?;
        let status = res.status().as_u16();
        let body: serde_json::Value = res.json().await.map_err(|e| HorizonError::Indeterminate(format!("HTTP {status}: {e}")))?;
        if (200..300).contains(&status) {
            return Ok(body.get("hash").and_then(|h| h.as_str()).unwrap_or_default().to_string());
        }
        let codes = &body["extras"]["result_codes"];
        if codes["transaction"].as_str().is_none() {
            // e.g. 504 Timeout: Horizon accepted the tx but did not see it close.
            let title = body.get("title").and_then(|t| t.as_str()).unwrap_or("no result codes");
            return Err(HorizonError::Indeterminate(format!("HTTP {status}: {title}")));
        }
        Err(HorizonError::Rejected(SubmitFailure {
            tx_result_code: codes["transaction"].as_str().map(str::to_string),
            op_result_codes: codes["operations"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            http_status: Some(status),
        }))
    }

    /// Whether a submitted tx closed: None = not on the ledger (yet),
    /// Some(successful) once it has.
    pub async fn transaction_outcome(&self, hash: &str) -> Result<Option<bool>, HorizonError> {
        let url = format!("{}/transactions/{}", self.base, hash);
        let res = self.http.get(&url).send().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
        if res.status().as_u16() == 404 {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(HorizonError::Transport(format!("transaction lookup HTTP {}", res.status())));
        }
        let tx: serde_json::Value = res.json().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
        Ok(Some(tx.get("successful").and_then(|v| v.as_bool()).unwrap_or(false)))
    }

    /// Successful payments of exactly `code:issuer` arriving at `address`
    /// (newest first, up to PAYMENT_PAGES pages), with text memos.
    pub async fn incoming_payments(
        &self,
        address: &str,
        code: &str,
        issuer: &str,
    ) -> Result<Vec<ObservedPayment>, HorizonError> {
        let mut url = format!("{}/accounts/{}/payments?limit=200&order=desc&join=transactions", self.base, address);
        let mut out = Vec::new();
        for _ in 0..PAYMENT_PAGES {
            let res = self.http.get(&url).send().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
            if !res.status().is_success() {
                return Err(HorizonError::Transport(format!("payments HTTP {}", res.status())));
            }
            let page: serde_json::Value = res.json().await.map_err(|e| HorizonError::Transport(e.to_string()))?;
            let records = page["_embedded"]["records"].as_array().cloned().unwrap_or_default();
            if records.is_empty() {
                break;
            }
            out.extend(records.iter().filter_map(|r| observed_payment(r, address, code, issuer)));
            match page["_links"]["next"]["href"].as_str() {
                Some(next) => url = next.to_string(),
                None => break,
            }
        }
        Ok(out)
    }
}

const PAYMENT_PAGES: usize = 10;

/// A payment record counts only if it credited `address` with the exact asset
/// in a successful tx; anything else (other issuers' "USDC", XLM, failed
/// txs) is ignored, never coerced into the expected asset.
fn observed_payment(r: &serde_json::Value, address: &str, code: &str, issuer: &str) -> Option<ObservedPayment> {
    let str_of = |key: &str| r.get(key).and_then(|v| v.as_str());
    let kind = str_of("type")?;
    if !matches!(kind, "payment" | "path_payment_strict_receive" | "path_payment_strict_send") {
        return None;
    }
    if str_of("to")? != address || str_of("asset_code")? != code || str_of("asset_issuer")? != issuer {
        return None;
    }
    if r.get("transaction_successful").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }
    let tx = r.get("transaction");
    let memo = match tx.and_then(|t| t.get("memo_type")).and_then(|v| v.as_str()) {
        Some("text") => tx.and_then(|t| t.get("memo")).and_then(|v| v.as_str()).map(str::to_string),
        _ => None,
    };
    Some(ObservedPayment {
        tx_hash: str_of("transaction_hash")?.to_string(),
        from: str_of("from").unwrap_or("").to_string(),
        to: address.to_string(),
        amount: str_of("amount")?.to_string(),
        asset_code: code.to_string(),
        asset_issuer: issuer.to_string(),
        memo,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(code: &str, issuer: &str, kind: &str, memo: Option<&str>) -> serde_json::Value {
        json!({
            "type": kind, "to": "COLL", "from": "GFROM", "amount": "25000.0000000",
            "asset_type": "credit_alphanum4", "asset_code": code, "asset_issuer": issuer,
            "transaction_hash": "ab", "transaction_successful": true,
            "transaction": memo.map(|m| json!({ "memo_type": "text", "memo": m })).unwrap_or(json!({ "memo_type": "none" })),
        })
    }

    #[test]
    fn only_the_exact_asset_counts() {
        let ok = observed_payment(&record("USDC", "ISS", "payment", Some("UF-1-s1")), "COLL", "USDC", "ISS").unwrap();
        assert_eq!(ok.memo.as_deref(), Some("UF-1-s1"));
        assert!(observed_payment(&record("USDC", "FAKE", "payment", Some("UF-1-s1")), "COLL", "USDC", "ISS").is_none());
        assert!(observed_payment(&record("USDX", "ISS", "payment", Some("UF-1-s1")), "COLL", "USDC", "ISS").is_none());
        let mut native = record("USDC", "ISS", "payment", None);
        native.as_object_mut().unwrap().retain(|k, _| k != "asset_code" && k != "asset_issuer");
        assert!(observed_payment(&native, "COLL", "USDC", "ISS").is_none());
        assert!(observed_payment(&record("USDC", "ISS", "create_account", None), "COLL", "USDC", "ISS").is_none());
        assert!(observed_payment(&record("USDC", "ISS", "path_payment_strict_send", None), "COLL", "USDC", "ISS").is_some());
        let mut failed = record("USDC", "ISS", "payment", Some("UF-1-s1"));
        failed["transaction_successful"] = json!(false);
        assert!(observed_payment(&failed, "COLL", "USDC", "ISS").is_none());
    }
}
