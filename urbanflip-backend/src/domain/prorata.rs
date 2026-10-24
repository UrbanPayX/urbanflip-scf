//! Pro-rata distribution computation (D3): principal repaid exactly,
//! performance interest allocated by principal share in exact integer math.
//! Row sums ALWAYS equal outcome totals — no rounding drift, ever.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::money::{from_stroops, to_stroops};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoanPosition {
    pub investor_id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    /// Invested principal, EUR decimal string.
    pub principal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealLedger {
    pub deal_id: String,
    pub positions: Vec<LoanPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealOutcome {
    pub principal_repayment: String,
    pub performance_interest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemainderPolicy {
    /// +1 unit to the largest fractional remainders, ties by investor id.
    LargestRemainder,
    /// Dust lands on the final position (legacy bank-ledger convention).
    LastAbsorbs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributionRow {
    pub investor_id: String,
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_address: Option<String>,
    pub principal_stroops: i128,
    pub interest_stroops: i128,
    pub total_stroops: i128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributionSchedule {
    pub deal_id: String,
    pub rows: Vec<DistributionRow>,
    pub totals: Totals,
    pub remainder_policy: RemainderPolicy,
    pub computation_decimals: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Totals {
    pub principal_stroops: i128,
    pub interest_stroops: i128,
    pub total_stroops: i128,
}

#[derive(Debug, thiserror::Error)]
pub enum ComputeError {
    #[error("ledger has no positions")]
    EmptyLedger,
    #[error("outcome principal {repayment} != ledger principal sum {sum}")]
    PrincipalMismatch { repayment: String, sum: String },
    #[error("total principal weight is zero")]
    ZeroWeight,
    #[error("amount '{0}' has more than {1} decimals; it would be silently truncated")]
    Precision(String, u32),
    #[error(transparent)]
    Money(#[from] super::money::InvalidAmount),
}

pub struct ComputeOptions {
    pub decimals: u32,
    pub policy: RemainderPolicy,
}

impl Default for ComputeOptions {
    fn default() -> Self {
        Self { decimals: 7, policy: RemainderPolicy::LargestRemainder }
    }
}

pub fn compute_distribution(
    ledger: &DealLedger,
    outcome: &DealOutcome,
    opts: &ComputeOptions,
) -> Result<DistributionSchedule, ComputeError> {
    if ledger.positions.is_empty() {
        return Err(ComputeError::EmptyLedger);
    }
    let unit_div = 10i128.pow(MAX_DECIMALS.saturating_sub(opts.decimals));
    let unit = |d: &str| -> Result<i128, ComputeError> {
        let stroops = to_stroops(d)?;
        if stroops % unit_div != 0 {
            return Err(ComputeError::Precision(d.to_string(), opts.decimals));
        }
        Ok(stroops / unit_div)
    };

    let weights: Vec<i128> = ledger.positions.iter().map(|p| unit(&p.principal)).collect::<Result<Vec<_>, _>>()?;
    let weight_sum: i128 = weights.iter().sum();
    let outcome_principal = unit(&outcome.principal_repayment)?;
    if outcome_principal != weight_sum {
        return Err(ComputeError::PrincipalMismatch {
            repayment: outcome.principal_repayment.clone(),
            sum: from_stroops(weight_sum * unit_div),
        });
    }

    let interest_total = unit(&outcome.performance_interest)?;
    let interest_units = allocate(
        interest_total,
        &weights,
        &ledger.positions.iter().map(|p| p.investor_id.clone()).collect::<Vec<_>>(),
        opts.policy,
    )?;

    let rows: Vec<DistributionRow> = ledger
        .positions
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let principal_stroops = weights[i] * unit_div;
            let interest_stroops = interest_units[i] * unit_div;
            DistributionRow {
                investor_id: p.investor_id.clone(),
                email: p.email.clone(),
                wallet_address: p.wallet_address.clone(),
                principal_stroops,
                interest_stroops,
                total_stroops: principal_stroops + interest_stroops,
            }
        })
        .collect();

    let totals = Totals {
        principal_stroops: rows.iter().map(|r| r.principal_stroops).sum(),
        interest_stroops: rows.iter().map(|r| r.interest_stroops).sum(),
        total_stroops: rows.iter().map(|r| r.total_stroops).sum(),
    };
    Ok(DistributionSchedule {
        deal_id: ledger.deal_id.clone(),
        rows,
        totals,
        remainder_policy: opts.policy,
        computation_decimals: opts.decimals,
    })
}

/// Floors every share, then distributes dust per policy so the sum is exact.
pub fn allocate(
    total: i128,
    weights: &[i128],
    ids: &[String],
    policy: RemainderPolicy,
) -> Result<Vec<i128>, ComputeError> {
    let weight_sum: i128 = weights.iter().sum();
    if weight_sum == 0 {
        return Err(ComputeError::ZeroWeight);
    }
    let bases: Vec<i128> = weights.iter().map(|w| total * w / weight_sum).collect();
    let fracs: Vec<i128> = weights.iter().map(|w| (total * w) % weight_sum).collect();
    let mut dust = total - bases.iter().sum::<i128>();
    let mut out = bases;
    if dust > 0 {
        match policy {
            RemainderPolicy::LastAbsorbs => {
                let last = out.len() - 1;
                out[last] += dust;
            }
            RemainderPolicy::LargestRemainder => {
                let mut order: Vec<usize> = (0..weights.len()).collect();
                order.sort_by(|&a, &b| {
                    fracs[b]
                        .cmp(&fracs[a])
                        .then_with(|| ids[a].cmp(&ids[b]))
                });
                let mut i = 0;
                while dust > 0 {
                    let idx = order[i % order.len()];
                    out[idx] += 1;
                    dust -= 1;
                    i += 1;
                }
            }
        }
    }
    Ok(out)
}

// ---- replay (acceptance criterion: reproduce historical payouts exactly) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoricalPayout {
    pub investor_id: String,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplayDiff {
    pub investor_id: String,
    pub recorded_stroops: i128,
    pub computed_stroops: i128,
    pub delta_stroops: i128,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplayReport {
    pub deal_id: String,
    pub match_: bool,
    pub compared_rows: usize,
    pub diffs: Vec<ReplayDiff>,
    pub recorded_total_stroops: i128,
    pub computed_total_stroops: i128,
}

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("historical record missing investor '{0}'")]
    MissingInvestor(String),
    #[error("historical record has unknown investor '{0}'")]
    UnknownInvestor(String),
    #[error(transparent)]
    Compute(#[from] ComputeError),
    #[error(transparent)]
    Money(#[from] super::money::InvalidAmount),
}

fn recorded_to_stroops(amount: &str) -> Result<i128, super::money::InvalidAmount> {
    // recorded amounts are 2-decimal EUR; accept whole-euro and trailing zeros
    let normalized = if amount.contains('.') {
        amount.to_string()
    } else {
        format!("{amount}.00")
    };
    let decimals = normalized.split('.').nth(1).map(|f| f.len()).unwrap_or(0);
    if decimals > 2 {
        return Err(super::money::InvalidAmount(amount.to_string()));
    }
    to_stroops(&normalized)
}

pub fn replay_deal(
    ledger: &DealLedger,
    outcome: &DealOutcome,
    historical: &[HistoricalPayout],
    opts: &ComputeOptions,
) -> Result<ReplayReport, ReplayError> {
    let schedule = compute_distribution(ledger, outcome, opts)?;
    let mut recorded: HashMap<&str, i128> = HashMap::new();
    for h in historical {
        recorded.insert(h.investor_id.as_str(), recorded_to_stroops(&h.amount)?);
    }
    let mut diffs = Vec::new();
    for row in &schedule.rows {
        let Some(&rec) = recorded.get(row.investor_id.as_str()) else {
            return Err(ReplayError::MissingInvestor(row.investor_id.clone()));
        };
        let delta = row.total_stroops - rec;
        if delta != 0 {
            diffs.push(ReplayDiff {
                investor_id: row.investor_id.clone(),
                recorded_stroops: rec,
                computed_stroops: row.total_stroops,
                delta_stroops: delta,
            });
        }
    }
    for id in recorded.keys() {
        if !schedule.rows.iter().any(|r| r.investor_id == *id) {
            return Err(ReplayError::UnknownInvestor(id.to_string()));
        }
    }
    let recorded_total: i128 = historical.iter().map(|h| recorded_to_stroops(&h.amount)).sum::<Result<i128, _>>()?;
    Ok(ReplayReport {
        deal_id: ledger.deal_id.clone(),
        match_: diffs.is_empty(),
        compared_rows: schedule.rows.len(),
        diffs,
        recorded_total_stroops: recorded_total,
        computed_total_stroops: schedule.totals.total_stroops,
    })
}

const MAX_DECIMALS: u32 = crate::domain::money::MAX_DECIMALS;

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(positions: &[(&str, &str, &str)]) -> DealLedger {
        DealLedger {
            deal_id: "UF-0042".into(),
            positions: positions
                .iter()
                .map(|(id, email, principal)| LoanPosition {
                    investor_id: (*id).into(),
                    email: (*email).into(),
                    wallet_address: None,
                    principal: (*principal).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn finer_than_decimals_is_refused_not_truncated() {
        let ledger = DealLedger {
            deal_id: "D".into(),
            positions: vec![LoanPosition { investor_id: "a".into(), email: "a@x.y".into(), wallet_address: None, principal: "100.00".into() }],
        };
        let opts = ComputeOptions { decimals: 2, policy: RemainderPolicy::LargestRemainder };
        let outcome = |interest: &str| DealOutcome { principal_repayment: "100.00".into(), performance_interest: interest.into() };
        assert!(matches!(compute_distribution(&ledger, &outcome("8.005"), &opts), Err(ComputeError::Precision(..))));
        assert!(compute_distribution(&ledger, &outcome("8.01"), &opts).is_ok());
    }

    #[test]
    fn rows_sum_to_totals_exactly() {
        let l = ledger(&[("i1", "a@x.y", "30000.00"), ("i2", "b@x.y", "10000.00")]);
        let s = compute_distribution(
            &l,
            &DealOutcome { principal_repayment: "40000.00".into(), performance_interest: "8000.00".into() },
            &ComputeOptions::default(),
        )
        .unwrap();
        assert_eq!(s.totals.principal_stroops, to_stroops("40000.00").unwrap());
        assert_eq!(s.totals.interest_stroops, to_stroops("8000.00").unwrap());
        assert_eq!(s.rows[0].interest_stroops, to_stroops("6000.00").unwrap()); // 3:1 split
        assert_eq!(s.rows[1].interest_stroops, to_stroops("2000.00").unwrap());
    }

    #[test]
    fn principal_mismatch_is_fatal() {
        let l = ledger(&[("i1", "a@x.y", "100.00")]);
        assert!(matches!(
            compute_distribution(&l, &DealOutcome { principal_repayment: "200.00".into(), performance_interest: "10.00".into() }, &ComputeOptions::default()),
            Err(ComputeError::PrincipalMismatch { .. })
        ));
    }

    #[test]
    fn dust_is_deterministic_per_policy() {
        let l = ledger(&[("a", "a@x.y", "100.00"), ("b", "b@x.y", "100.00"), ("c", "c@x.y", "100.00")]);
        let outcome = DealOutcome { principal_repayment: "300.00".into(), performance_interest: "0.01".into() };
        let lr = compute_distribution(&l, &outcome, &ComputeOptions { decimals: 2, policy: RemainderPolicy::LargestRemainder }).unwrap();
        assert_eq!(lr.rows.iter().map(|r| r.interest_stroops).collect::<Vec<_>>(), vec![100000, 0, 0]); // tie -> first id wins
        let la = compute_distribution(&l, &outcome, &ComputeOptions { decimals: 2, policy: RemainderPolicy::LastAbsorbs }).unwrap();
        assert_eq!(la.rows[2].interest_stroops, 100000);
    }

    #[test]
    fn replay_reproduces_and_detects_tampering() {
        let l = ledger(&[("i1", "a@x.y", "75000.00"), ("i2", "b@x.y", "25000.00")]);
        let outcome = DealOutcome { principal_repayment: "100000.00".into(), performance_interest: "1000.00".into() };
        let historical = vec![
            HistoricalPayout { investor_id: "i1".into(), amount: "75750.00".into() },
            HistoricalPayout { investor_id: "i2".into(), amount: "25250.00".into() },
        ];
        let report = replay_deal(&l, &outcome, &historical, &ComputeOptions { decimals: 2, policy: RemainderPolicy::LastAbsorbs }).unwrap();
        assert!(report.match_);

        let tampered = vec![
            HistoricalPayout { investor_id: "i1".into(), amount: "75750.01".into() },
            HistoricalPayout { investor_id: "i2".into(), amount: "25250.00".into() },
        ];
        let report = replay_deal(&l, &outcome, &tampered, &ComputeOptions { decimals: 2, policy: RemainderPolicy::LastAbsorbs }).unwrap();
        assert!(!report.match_);
        assert_eq!(report.diffs.len(), 1);
        assert_eq!(report.diffs[0].delta_stroops, -100000); // one cent in stroops
    }
}
