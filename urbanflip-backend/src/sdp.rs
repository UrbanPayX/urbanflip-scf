//! SDP integration: emits disbursement CSVs in the Stellar Disbursement
//! Platform's format (amount,id,destination,memo,memo_type, 10k rows/file),
//! and — when SDP_BASE_URL is configured — creates disbursements over the
//! SDP API so the batch is executed and reconciled by the platform itself.

use crate::domain::money::{display_amount, to_stroops};
use crate::domain::prorata::{allocate, DistributionSchedule, RemainderPolicy};
use crate::domain::rails::{check_rate, rate_display};
use serde::Serialize;

pub const SDP_MAX_ROWS: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
pub struct SdpFile {
    pub name: String,
    pub content: String,
    pub row_count: usize,
}

/// One on-chain payout: the investor's EUR distribution and the USDC sent for it.
#[derive(Debug, Clone, Serialize)]
pub struct UsdcPayout {
    pub investor_id: String,
    pub email: String,
    pub destination: String,
    pub eur: String,
    pub usdc: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsdcConversion {
    pub payouts: Vec<UsdcPayout>,
    pub eur_total: String,
    pub usdc_total: String,
    /// USDC per EUR actually achieved, for display.
    pub rate: String,
}

/// Distributions are owed in EUR; on-chain investors are paid in USDC. The
/// USDC the treasury actually bought for the cohort (`usdc_funded`) is split
/// pro-rata to each EUR payout, exact to the cent (largest remainder), so the
/// batch pays precisely what was funded and every investor gets the same rate.
pub fn convert_on_chain(
    schedule: &DistributionSchedule,
    on_chain_addresses: &std::collections::HashSet<String>,
    usdc_funded: &str,
) -> Result<UsdcConversion, String> {
    let rows: Vec<_> = schedule
        .rows
        .iter()
        .filter(|r| r.wallet_address.as_deref().map(|a| on_chain_addresses.contains(a)).unwrap_or(false))
        .collect();
    // Everyone the caller marked on-chain must appear in the schedule — a
    // missing destination means someone we owe would be silently dropped.
    let emitted: std::collections::HashSet<&str> =
        rows.iter().filter_map(|r| r.wallet_address.as_deref()).collect();
    for wanted in on_chain_addresses {
        if !emitted.contains(wanted.as_str()) {
            return Err(format!("on-chain destination {wanted} missing from the schedule"));
        }
    }
    let usdc_stroops = to_stroops(usdc_funded).map_err(|e| e.to_string())?;
    if usdc_stroops % STROOPS_PER_CENT != 0 {
        return Err(format!("usdc_funded '{usdc_funded}' must have at most 2 decimals"));
    }
    let eur_total: i128 = rows.iter().map(|r| r.total_stroops).sum();
    if rows.is_empty() || eur_total == 0 {
        return Err("no on-chain payouts in this schedule; nothing to convert".into());
    }
    check_rate(usdc_stroops, eur_total)?;
    let weights: Vec<i128> = rows.iter().map(|r| r.total_stroops).collect();
    let ids: Vec<String> = rows.iter().map(|r| r.investor_id.clone()).collect();
    let cents = allocate(usdc_stroops / STROOPS_PER_CENT, &weights, &ids, RemainderPolicy::LargestRemainder)
        .map_err(|e| e.to_string())?;
    let payouts = rows
        .iter()
        .zip(cents)
        .map(|(r, c)| UsdcPayout {
            investor_id: r.investor_id.clone(),
            email: r.email.clone(),
            destination: r.wallet_address.clone().unwrap_or_default(),
            eur: display_amount(r.total_stroops, 2),
            usdc: display_amount(c * STROOPS_PER_CENT, 2),
        })
        .collect();
    Ok(UsdcConversion {
        payouts,
        eur_total: display_amount(eur_total, 2),
        usdc_total: display_amount(usdc_stroops, 2),
        rate: rate_display(usdc_stroops, eur_total),
    })
}

const STROOPS_PER_CENT: i128 = 100_000;

/// SDP CSVs (USDC amounts) for converted on-chain payouts.
pub fn emit_sdp_files(deal_id: &str, payouts: &[UsdcPayout]) -> Vec<SdpFile> {
    payouts
        .chunks(SDP_MAX_ROWS)
        .enumerate()
        .map(|(file_idx, chunk)| {
            let mut content = String::from("amount,id,destination,memo,memo_type\n");
            for p in chunk {
                // amount,id,destination,memo,memo_type (memo fields empty)
                content.push_str(&format!("{},{},{},,\n", p.usdc, csv_field(&p.email), p.destination));
            }
            SdpFile { name: format!("sdp-{deal_id}-{:03}.csv", file_idx + 1), content, row_count: chunk.len() }
        })
        .collect()
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// Thin client over the self-hosted SDP (T2/D4 deployment target on the VPS).
/// When SDP_BASE_URL/SDP_TOKEN are unset, the API returns files for manual
/// upload instead of creating disbursements.
#[derive(Clone)]
pub struct SdpClient {
    pub base_url: Option<String>,
    pub token: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug, Serialize)]
struct SdpDisbursementRequest {
    name: String,
    /// CSV content per the disbursement format.
    file_content: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SdpError {
    #[error("SDP not configured (set SDP_BASE_URL and SDP_TOKEN); files were emitted for manual upload instead")]
    NotConfigured,
    #[error("SDP call failed: {0}")]
    Transport(String),
}

impl SdpClient {
    pub fn new(base_url: Option<String>, token: Option<String>) -> Self {
        Self { base_url, token, http: reqwest::Client::new() }
    }

    pub fn configured(&self) -> bool {
        self.base_url.is_some() && self.token.is_some()
    }

    /// Creates a disbursement in the SDP for the given file.
    pub async fn create_disbursement(&self, name: &str, csv: &str) -> Result<serde_json::Value, SdpError> {
        let Some(base) = &self.base_url else { return Err(SdpError::NotConfigured) };
        let Some(token) = &self.token else { return Err(SdpError::NotConfigured) };
        let body = SdpDisbursementRequest { name: name.to_string(), file_content: csv.to_string() };
        let res = self
            .http
            .post(format!("{}/disbursements", base.trim_end_matches('/')))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| SdpError::Transport(e.to_string()))?;
        if !res.status().is_success() {
            return Err(SdpError::Transport(format!("HTTP {}", res.status())));
        }
        res.json().await.map_err(|e| SdpError::Transport(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::prorata::{compute_distribution, ComputeOptions, DealLedger, DealOutcome, LoanPosition};
    use crate::domain::money::to_stroops;

    fn wallet(c: char) -> String {
        "G".to_string() + &c.to_string().repeat(55)
    }

    fn schedule(principals: &[(&str, char, &str)], interest: &str) -> DistributionSchedule {
        let total: i128 = principals.iter().map(|(_, _, p)| to_stroops(p).unwrap()).sum();
        let ledger = DealLedger {
            deal_id: "UF-0042".into(),
            positions: principals
                .iter()
                .map(|(id, w, p)| LoanPosition { investor_id: id.to_string(), email: format!("{id}@x.y"), wallet_address: Some(wallet(*w)), principal: p.to_string() })
                .collect(),
        };
        let outcome = DealOutcome { principal_repayment: crate::domain::money::from_stroops(total), performance_interest: interest.into() };
        compute_distribution(&ledger, &outcome, &ComputeOptions::default()).unwrap()
    }

    #[test]
    fn emits_exact_cohort_in_sdp_format() {
        let schedule = schedule(&[("i1", 'W', "30000.00"), ("i2", 'X', "10000.00")], "8000.00");
        let cohort: std::collections::HashSet<String> = [wallet('W')].into();
        // i1 is owed EUR 36,000; the treasury bought USDC 39,060 for it.
        let conversion = convert_on_chain(&schedule, &cohort, "39060.00").unwrap();
        assert_eq!(conversion.rate, "1.085000");
        let files = emit_sdp_files("UF-0042", &conversion.payouts);
        assert_eq!(files.len(), 1);
        let lines: Vec<&str> = files[0].content.trim().split('\n').collect();
        assert_eq!(lines[0], "amount,id,destination,memo,memo_type");
        assert!(lines[1].starts_with("39060.00,i1@x.y,G"), "{lines:?}");
        assert!(lines.iter().all(|l| l.split(',').count() == 5), "every row has the header's 5 fields: {lines:?}");
        assert_eq!(files[0].row_count, 1);
        assert_eq!(csv_field("a,b\"c"), "\"a,b\"\"c\"");
    }

    #[test]
    fn funded_usdc_is_split_exactly_at_one_rate() {
        let schedule = schedule(&[("a", 'A', "100.00"), ("b", 'B', "100.00"), ("c", 'C', "100.00")], "0");
        let cohort: std::collections::HashSet<String> = [wallet('A'), wallet('B'), wallet('C')].into();
        let conversion = convert_on_chain(&schedule, &cohort, "325.01").unwrap();
        let cents: Vec<&str> = conversion.payouts.iter().map(|p| p.usdc.as_str()).collect();
        assert_eq!(cents, vec!["108.34", "108.34", "108.33"], "the odd cent goes by largest remainder, ties by id");
        let sum: i128 = conversion.payouts.iter().map(|p| to_stroops(&p.usdc).unwrap()).sum();
        assert_eq!(sum, to_stroops("325.01").unwrap(), "pays exactly what was funded");

        assert!(convert_on_chain(&schedule, &cohort, "325.015").unwrap_err().contains("2 decimals"));
        assert!(convert_on_chain(&schedule, &cohort, "3.00").unwrap_err().contains("implied rate"), "EUR typed as USDC cents");
        let absent: std::collections::HashSet<String> = [wallet('Z')].into();
        assert!(convert_on_chain(&schedule, &absent, "325.01").unwrap_err().contains("missing"));
    }
}
