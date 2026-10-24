//! Bridge (Stripe) ramp client: the two conversion legs of the fiat boundary.
//!
//! - Off-ramp: a liquidation address per deal turns USDC on Stellar into EUR
//!   paid by SEPA to the deal's SPV account (an IBAN external account).
//! - Funding: a virtual account (EUR IBAN) per deal turns SEPA deposits into
//!   USDC delivered on Stellar to the SDP distribution wallet.
//!
//! Every POST carries a deterministic `Idempotency-Key` derived from our own
//! intent, so a retried request can never create a second object (Bridge
//! replays the original response for 24h). Webhooks are verified with the
//! endpoint's RSA public key over SHA256(SHA256("<t>.<raw body>")).
//! API reference: https://apidocs.bridge.xyz

use rsa::pkcs1v15::{Signature, VerifyingKey};
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Bridge not configured (BRIDGE_API_KEY, BRIDGE_CUSTOMER_ID)")]
    NotConfigured,
    #[error("Bridge unreachable: {0}")]
    Transport(String),
    #[error("Bridge returned HTTP {status}: {body}")]
    Api { status: u16, body: String },
    #[error("unexpected Bridge response: {0}")]
    Shape(String),
}

/// The SPV's bank account, as Bridge's IBAN external account needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpvBankAccount {
    pub iban: String,
    #[serde(default)]
    pub bic: Option<String>,
    /// ISO 3166-1 alpha-3, e.g. "ESP".
    pub country: String,
    /// The SPV's legal name (3-35 chars).
    pub account_owner_name: String,
    pub address: BankAddress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BankAddress {
    pub street_line_1: String,
    pub city: String,
    #[serde(default)]
    pub postal_code: Option<String>,
    /// ISO 3166-1 alpha-3.
    pub country: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiquidationAddress {
    pub id: String,
    pub address: String,
    /// Stellar M-address embedding the routing memo (preferred for sends).
    pub memoless_address: Option<String>,
    /// Memo to attach when paying `address` directly, if Bridge returns one.
    pub blockchain_memo: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Drain {
    pub id: String,
    pub state: String,
    #[serde(default)]
    pub deposit_tx_hash: Option<String>,
    #[serde(default)]
    pub destination: Option<DrainDestination>,
    #[serde(default)]
    pub receipt: Option<DrainReceipt>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DrainDestination {
    #[serde(default)]
    pub sepa_reference: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DrainReceipt {
    /// Final amount paid out, after fees and conversion.
    #[serde(default)]
    pub outgoing_amount: Option<String>,
    #[serde(default)]
    pub destination_currency: Option<String>,
    #[serde(default)]
    pub exchange_rate: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

impl Drain {
    pub const PROCESSED: &'static str = "payment_processed";
    /// States after which the drain will never pay out.
    pub fn failed(&self) -> bool {
        matches!(self.state.as_str(), "canceled" | "error" | "undeliverable" | "returned" | "refund_in_flight" | "refund_failed" | "refunded")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualAccount {
    pub id: String,
    pub iban: Option<String>,
    pub bic: Option<String>,
    pub account_holder_name: Option<String>,
    pub bank_name: Option<String>,
    pub bank_address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VirtualAccountEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub deposit_id: Option<String>,
    #[serde(default)]
    pub destination_tx_hash: Option<String>,
}

#[derive(Clone)]
pub struct BridgeClient {
    base: String,
    api_key: Option<String>,
    customer_id: Option<String>,
    /// Sandbox: deposits are simulated through Bridge's sandbox endpoints.
    pub sandbox: bool,
    http: reqwest::Client,
}

impl BridgeClient {
    pub fn new(base: &str, api_key: Option<String>, customer_id: Option<String>, sandbox: bool) -> Self {
        Self { base: base.trim_end_matches('/').to_string(), api_key, customer_id, sandbox, http: reqwest::Client::new() }
    }

    pub fn configured(&self) -> bool {
        self.api_key.is_some() && self.customer_id.is_some()
    }

    fn customer_path(&self, rest: &str) -> Result<String, BridgeError> {
        let customer = self.customer_id.as_ref().ok_or(BridgeError::NotConfigured)?;
        Ok(format!("{}/customers/{customer}/{rest}", self.base))
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, BridgeError> {
        let key = self.api_key.as_ref().ok_or(BridgeError::NotConfigured)?;
        let res = req.header("Api-Key", key).send().await.map_err(|e| BridgeError::Transport(e.to_string()))?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| BridgeError::Transport(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(BridgeError::Api { status, body });
        }
        serde_json::from_str(&body).map_err(|e| BridgeError::Shape(format!("{e}: {body}")))
    }

    async fn post(&self, url: String, idempotency_key: &str, body: Value) -> Result<Value, BridgeError> {
        self.send(self.http.post(url).header("Idempotency-Key", idempotency_key).json(&body)).await
    }

    async fn get(&self, url: String) -> Result<Value, BridgeError> {
        self.send(self.http.get(url)).await
    }

    pub async fn create_external_account(&self, idempotency_key: &str, account: &SpvBankAccount) -> Result<String, BridgeError> {
        let mut iban = json!({ "account_number": account.iban, "country": account.country });
        if let Some(bic) = &account.bic {
            iban["bic"] = json!(bic);
        }
        let mut address = json!({ "street_line_1": account.address.street_line_1, "city": account.address.city, "country": account.address.country });
        if let Some(postal) = &account.address.postal_code {
            address["postal_code"] = json!(postal);
        }
        let body = json!({
            "account_type": "iban",
            "currency": "eur",
            "account_owner_name": account.account_owner_name,
            "account_owner_type": "business",
            "business_name": account.account_owner_name,
            "iban": iban,
            "address": address,
        });
        let created = self.post(self.customer_path("external_accounts")?, idempotency_key, body).await?;
        string_field(&created, "id")
    }

    /// USDC on Stellar -> EUR by SEPA to `external_account_id`. Returns go
    /// back to `return_address` with `return_memo` (required on Stellar).
    pub async fn create_liquidation_address(
        &self,
        idempotency_key: &str,
        external_account_id: &str,
        sepa_reference: &str,
        return_address: Option<(&str, &str)>,
    ) -> Result<LiquidationAddress, BridgeError> {
        let mut body = json!({
            "chain": "stellar",
            "currency": "usdc",
            "external_account_id": external_account_id,
            "destination_payment_rail": "sepa",
            "destination_currency": "eur",
            "destination_sepa_reference": sepa_reference,
        });
        if let Some((address, memo)) = return_address {
            body["return_instructions"] = json!({ "address": address, "memo": memo });
        }
        let created = self.post(self.customer_path("liquidation_addresses")?, idempotency_key, body).await?;
        Ok(LiquidationAddress {
            id: string_field(&created, "id")?,
            address: string_field(&created, "address")?,
            memoless_address: created.get("memoless_address").and_then(Value::as_str).map(str::to_string),
            blockchain_memo: created.get("blockchain_memo").and_then(Value::as_str).map(str::to_string),
        })
    }

    /// Drains of a liquidation address, narrowed by drain id or deposit tx hash.
    pub async fn drains(&self, liquidation_address_id: &str, drain_id: Option<&str>, tx_hash: Option<&str>) -> Result<Vec<Drain>, BridgeError> {
        let mut url = self.customer_path(&format!("liquidation_addresses/{liquidation_address_id}/drains?limit=100"))?;
        if let Some(id) = drain_id {
            url.push_str(&format!("&drain_id={id}"));
        }
        if let Some(hash) = tx_hash {
            url.push_str(&format!("&tx_hash={hash}"));
        }
        let page = self.get(url).await?;
        serde_json::from_value(page.get("data").cloned().unwrap_or(json!([]))).map_err(|e| BridgeError::Shape(e.to_string()))
    }

    /// Sandbox only: a USDC deposit into a liquidation address; returns the drain id.
    pub async fn simulate_liquidation_deposit(&self, idempotency_key: &str, liquidation_address_id: &str, amount: &str) -> Result<String, BridgeError> {
        let url = self.customer_path(&format!("liquidation_addresses/{liquidation_address_id}/simulate_deposit"))?;
        let res = self.post(url, idempotency_key, json!({ "currency": "usdc", "amount": amount })).await?;
        string_field(&res, "drain_id")
    }

    /// EUR (SEPA virtual IBAN) -> USDC on Stellar to `destination`.
    pub async fn create_virtual_account(&self, idempotency_key: &str, destination: &str, memo: Option<&str>) -> Result<VirtualAccount, BridgeError> {
        let mut dest = json!({ "currency": "usdc", "payment_rail": "stellar", "address": destination });
        if let Some(m) = memo {
            dest["blockchain_memo"] = json!(m);
        }
        let created = self
            .post(self.customer_path("virtual_accounts")?, idempotency_key, json!({ "source": { "currency": "eur" }, "destination": dest }))
            .await?;
        let instructions = created.get("source_deposit_instructions").cloned().unwrap_or(json!({}));
        let text = |key: &str| instructions.get(key).and_then(Value::as_str).map(str::to_string);
        Ok(VirtualAccount {
            id: string_field(&created, "id")?,
            iban: text("iban"),
            bic: text("bic"),
            account_holder_name: text("account_holder_name"),
            bank_name: text("bank_name"),
            bank_address: text("bank_address"),
        })
    }

    /// Every event of a virtual account, oldest page last (follows `starting_after`).
    pub async fn virtual_account_history(&self, virtual_account_id: &str) -> Result<Vec<VirtualAccountEvent>, BridgeError> {
        let mut events: Vec<VirtualAccountEvent> = Vec::new();
        for _ in 0..50 {
            let mut url = self.customer_path(&format!("virtual_accounts/{virtual_account_id}/history?limit=100"))?;
            if let Some(last) = events.last() {
                url.push_str(&format!("&starting_after={}", last.id));
            }
            let page: Vec<VirtualAccountEvent> = serde_json::from_value(self.get(url).await?.get("data").cloned().unwrap_or(json!([])))
                .map_err(|e| BridgeError::Shape(e.to_string()))?;
            let full = page.len() == 100;
            events.extend(page);
            if !full {
                break;
            }
        }
        Ok(events)
    }

    /// Sandbox only: an EUR deposit into a virtual account.
    pub async fn simulate_virtual_account_deposit(&self, idempotency_key: &str, virtual_account_id: &str, amount: &str) -> Result<(), BridgeError> {
        let url = self.customer_path(&format!("virtual_accounts/{virtual_account_id}/simulate_deposit"))?;
        self.post(url, idempotency_key, json!({ "currency": "eur", "amount": amount })).await.map(|_| ())
    }
}

fn string_field(value: &Value, key: &str) -> Result<String, BridgeError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BridgeError::Shape(format!("missing '{key}' in {value}")))
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WebhookError {
    #[error("malformed X-Webhook-Signature header")]
    Malformed,
    #[error("signature does not verify")]
    BadSignature,
    #[error("event timestamp outside the {0}s window")]
    Stale(u64),
}

/// Rejects deliveries older (or newer) than this; Bridge retries with a fresh timestamp.
pub const WEBHOOK_TOLERANCE_SECS: u64 = 600;

/// Verifies `X-Webhook-Signature: t=<ms>,v0=<base64>` over the raw body.
pub fn verify_webhook(public_key_pem: &str, header: &str, raw_body: &[u8], now_ms: u64) -> Result<(), WebhookError> {
    let (mut timestamp, mut signature) = (None, None);
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", t)) => timestamp = t.parse::<u64>().ok(),
            Some(("v0", s)) => signature = Some(s),
            _ => {}
        }
    }
    let (Some(t), Some(sig_b64)) = (timestamp, signature) else { return Err(WebhookError::Malformed) };
    if now_ms.abs_diff(t) > WEBHOOK_TOLERANCE_SECS * 1000 {
        return Err(WebhookError::Stale(WEBHOOK_TOLERANCE_SECS));
    }
    let sig_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sig_b64).map_err(|_| WebhookError::Malformed)?;
    let mut signed = t.to_string().into_bytes();
    signed.push(b'.');
    signed.extend_from_slice(raw_body);
    // Bridge signs SHA256(SHA256(msg)): hand the first digest to a verifier
    // that hashes once more.
    let digest = Sha256::digest(&signed);
    let key = RsaPublicKey::from_public_key_pem(public_key_pem).map_err(|_| WebhookError::Malformed)?;
    let signature = Signature::try_from(sig_bytes.as_slice()).map_err(|_| WebhookError::Malformed)?;
    VerifyingKey::<Sha256>::new(key).verify(&digest, &signature).map_err(|_| WebhookError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs1v15::SigningKey;
    use rsa::pkcs8::{DecodePrivateKey, EncodePublicKey, LineEnding};
    use rsa::signature::{SignatureEncoding, Signer};
    use rsa::RsaPrivateKey;

    // Throwaway keys generated for these tests only.
    const TEST_KEY: &str = include_str!("../tests/fixtures/webhook-test-key.pem");
    const OTHER_KEY: &str = include_str!("../tests/fixtures/webhook-other-key.pem");

    fn sign(private_pem: &str, message: &[u8]) -> String {
        let key = RsaPrivateKey::from_pkcs8_pem(private_pem).unwrap();
        let sig = SigningKey::<Sha256>::new(key).sign(message);
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig.to_bytes())
    }

    fn public_pem(private_pem: &str) -> String {
        RsaPrivateKey::from_pkcs8_pem(private_pem).unwrap().to_public_key().to_public_key_pem(LineEnding::LF).unwrap()
    }

    #[test]
    fn webhook_signatures_verify_over_the_double_hash() {
        let pem = public_pem(TEST_KEY);
        let body = br#"{"event_id":"wh_1","event_category":"liquidation_address.drain"}"#;
        let t = 1_792_800_000_000u64;
        let mut signed = format!("{t}.").into_bytes();
        signed.extend_from_slice(body);
        let header = format!("t={t},v0={}", sign(TEST_KEY, &Sha256::digest(&signed)));

        assert_eq!(verify_webhook(&pem, &header, body, t + 1_000), Ok(()));
        assert_eq!(verify_webhook(&pem, &header, b"{\"tampered\":true}", t), Err(WebhookError::BadSignature));
        assert_eq!(verify_webhook(&pem, &header, body, t + 11 * 60 * 1000), Err(WebhookError::Stale(WEBHOOK_TOLERANCE_SECS)));
        assert_eq!(verify_webhook(&pem, "v0=abc", body, t), Err(WebhookError::Malformed));
        assert_eq!(verify_webhook(&public_pem(OTHER_KEY), &header, body, t), Err(WebhookError::BadSignature), "another endpoint's key");
        // A single SHA256 (the common mistake) must not verify.
        let once = format!("t={t},v0={}", sign(TEST_KEY, &signed));
        assert_eq!(verify_webhook(&pem, &once, body, t), Err(WebhookError::BadSignature));
    }

    #[test]
    fn drain_failure_states() {
        let drain = |state: &str| Drain { id: "d".into(), state: state.into(), deposit_tx_hash: None, destination: None, receipt: None };
        assert!(drain("returned").failed() && drain("refunded").failed() && drain("error").failed());
        assert!(!drain("funds_received").failed() && !drain(Drain::PROCESSED).failed());
    }
}
