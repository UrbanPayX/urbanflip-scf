//! Investor rails: fiat vs crypto-native differentiation, crypto collection
//! from investor-owned wallets, raise-close off-ramp, and the distribution-day
//! split into SDP (on-chain) and SEPA (bank) worklists.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::money::to_stroops;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SubscriptionRail {
    FiatWire,
    UsdcOnchain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PayoutRail {
    FiatBank,
    UsdcOnchain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvestorProfile {
    pub investor_id: String,
    pub email: String,
    pub subscription_rail: SubscriptionRail,
    pub payout_rail: PayoutRail,
    pub stellar_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iban: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank_account_name: Option<String>,
    /// Merkle screening reference; required for USDC_ONCHAIN subscriptions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screening_ref: Option<String>,
}

pub fn validate_profile(p: &InvestorProfile) -> Vec<String> {
    let mut problems = Vec::new();
    if p.stellar_address.len() != 56 || !p.stellar_address.starts_with('G') {
        problems.push("stellarAddress must be a valid G... StrKey address".into());
    }
    if p.payout_rail == PayoutRail::FiatBank {
        if p.iban.as_deref().unwrap_or("").is_empty() {
            problems.push("FIAT_BANK payout requires an iban".into());
        }
        if p.bank_account_name.as_deref().unwrap_or("").is_empty() {
            problems.push("FIAT_BANK payout requires a bankAccountName".into());
        }
    }
    if p.subscription_rail == SubscriptionRail::UsdcOnchain && p.screening_ref.is_none() {
        problems.push("USDC_ONCHAIN subscription requires screening evidence (screeningRef)".into());
    }
    problems
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct RailRegistry {
    profiles: HashMap<String, InvestorProfile>,
}

impl RailRegistry {
    pub fn register(&mut self, profile: InvestorProfile) -> Result<(), String> {
        let problems = validate_profile(&profile);
        if !problems.is_empty() {
            return Err(problems.join("; "));
        }
        self.profiles.insert(profile.investor_id.clone(), profile);
        Ok(())
    }
    pub fn get(&self, investor_id: &str) -> Option<&InvestorProfile> {
        self.profiles.get(investor_id)
    }
    pub fn all(&self) -> Vec<&InvestorProfile> {
        self.profiles.values().collect()
    }
}

// ---- crypto-native collection (investor's own wallet -> company wallet) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedPayment {
    pub subscription_ref: String,
    pub investor_id: String,
    pub deal_id: String,
    /// The investor's EUR commitment: the loan principal, and the units minted.
    pub eur_amount: String,
    /// The USDC the investor pays for it (the ramp quote); matched exactly.
    pub usdc_amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_ref: Option<String>,
    pub collection_address: String,
    pub asset_code: String,
    pub asset_issuer: String,
    pub memo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservedPayment {
    pub tx_hash: String,
    pub from: String,
    pub to: String,
    pub amount: String,
    pub asset_code: String,
    pub asset_issuer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CollectionState {
    Pending,
    Reconciled,
    Mismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionRecord {
    pub expected: ExpectedPayment,
    pub state: CollectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_by: Option<ObservedPayment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mismatch_reason: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub struct CollectionError(#[from] super::money::InvalidAmount);

/// Exact-match reconciliation: memo + amount + asset + destination. Anything
/// else is MISMATCH for manual handling — money is never auto-credited.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct CollectionBook {
    records: HashMap<String, CollectionRecord>,
}

/// Stellar MEMO_TEXT holds at most 28 bytes.
pub const MAX_TEXT_MEMO_BYTES: usize = 28;

/// USDC-per-EUR bounds for a quote or a conversion: wide enough for any
/// real market, narrow enough to catch a swapped or mistyped amount.
pub const MIN_USDC_PER_EUR: (i128, i128) = (1, 2);
pub const MAX_USDC_PER_EUR: (i128, i128) = (2, 1);

/// Refuses a USDC/EUR pair whose implied rate is outside the sanity bounds.
pub fn check_rate(usdc_stroops: i128, eur_stroops: i128) -> Result<(), String> {
    let (min_n, min_d) = MIN_USDC_PER_EUR;
    let (max_n, max_d) = MAX_USDC_PER_EUR;
    if eur_stroops <= 0 || usdc_stroops <= 0 {
        return Err("amounts must be positive".into());
    }
    if usdc_stroops * min_d < eur_stroops * min_n || usdc_stroops * max_d > eur_stroops * max_n {
        return Err(format!(
            "implied rate {} USDC per EUR is outside {min_n}/{min_d}-{max_n}/{max_d}; check the amounts",
            rate_display(usdc_stroops, eur_stroops)
        ));
    }
    Ok(())
}

/// USDC per EUR to 6 decimals, for display only.
pub fn rate_display(usdc_stroops: i128, eur_stroops: i128) -> String {
    let micro = usdc_stroops * 1_000_000 / eur_stroops;
    format!("{}.{:06}", micro / 1_000_000, micro % 1_000_000)
}

/// A crypto subscription to expect: the EUR commitment and its USDC quote.
pub struct PaymentRequest {
    pub subscription_ref: String,
    pub investor_id: String,
    pub deal_id: String,
    pub eur_amount: String,
    pub usdc_amount: String,
    pub quote_ref: Option<String>,
    pub collection_address: String,
    pub asset_code: String,
    pub asset_issuer: String,
}

impl CollectionBook {
    pub fn new() -> Self {
        Self { records: HashMap::new() }
    }

    pub fn expect_payment(&mut self, request: PaymentRequest) -> Result<ExpectedPayment, String> {
        let PaymentRequest { subscription_ref, investor_id, deal_id, eur_amount, usdc_amount, quote_ref, collection_address, asset_code, asset_issuer } =
            request;
        if self.records.contains_key(&subscription_ref) {
            return Err(format!("subscription '{subscription_ref}' already expected"));
        }
        let eur = to_stroops(&eur_amount).map_err(|e| e.to_string())?;
        let usdc = to_stroops(&usdc_amount).map_err(|e| e.to_string())?;
        check_rate(usdc, eur)?;
        let memo = format!("UF-{deal_id}-{subscription_ref}");
        if memo.len() > MAX_TEXT_MEMO_BYTES {
            return Err(format!("memo '{memo}' exceeds {MAX_TEXT_MEMO_BYTES} bytes; use a shorter subscription ref"));
        }
        // "UF-A-B" + "-C" and "UF-A" + "-B-C" render alike; one payment must
        // never be able to match two subscriptions.
        if self.records.values().any(|r| r.expected.memo == memo) {
            return Err(format!("memo '{memo}' is already used by another subscription"));
        }
        let expected = ExpectedPayment {
            subscription_ref,
            investor_id,
            deal_id,
            eur_amount,
            usdc_amount,
            quote_ref,
            collection_address,
            asset_code,
            asset_issuer,
            memo,
        };
        self.records.insert(
            expected.subscription_ref.clone(),
            CollectionRecord { expected: expected.clone(), state: CollectionState::Pending, settled_by: None, mismatch_reason: None },
        );
        Ok(expected)
    }

    pub fn reconcile(&mut self, incoming: &[ObservedPayment]) -> Result<Vec<CollectionRecord>, CollectionError> {
        // A payment (one tx, one memo) settles at most one subscription.
        let mut used: std::collections::HashSet<String> =
            self.records.values().filter_map(|r| r.settled_by.as_ref().map(|p| p.tx_hash.clone())).collect();
        let mut updated = Vec::new();
        for record in self.records.values_mut() {
            if record.state != CollectionState::Pending {
                continue;
            }
            let candidates: Vec<&ObservedPayment> = incoming
                .iter()
                .filter(|p| p.to == record.expected.collection_address && p.memo.as_deref() == Some(record.expected.memo.as_str()))
                .filter(|p| !used.contains(&p.tx_hash))
                .collect();
            let Ok(expected_amount) = to_stroops(&record.expected.usdc_amount) else {
                continue;
            };
            let exact = candidates.iter().find(|p| {
                to_stroops(&p.amount).map(|a| a == expected_amount).unwrap_or(false)
                    && p.asset_code == record.expected.asset_code
                    && p.asset_issuer == record.expected.asset_issuer
            });
            match exact {
                Some(p) => {
                    used.insert(p.tx_hash.clone());
                    record.state = CollectionState::Reconciled;
                    record.settled_by = Some((*p).clone());
                }
                None if !candidates.is_empty() => {
                    record.state = CollectionState::Mismatch;
                    record.mismatch_reason = Some(format!(
                        "memo matched but amount mismatch: expected {} {}, got {}",
                        record.expected.usdc_amount, record.expected.asset_code, candidates[0].amount
                    ));
                }
                None => {}
            }
            updated.push(record.clone());
        }
        Ok(updated)
    }

    pub fn record(&self, ref_: &str) -> Option<&CollectionRecord> {
        self.records.get(ref_)
    }

    pub fn reconciled_for(&self, deal_id: &str) -> Vec<CollectionRecord> {
        self.records
            .values()
            .filter(|r| r.expected.deal_id == deal_id && r.state == CollectionState::Reconciled)
            .cloned()
            .collect()
    }
}

// ---- raise-close off-ramp + issuance eligibility ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffRampInstruction {
    pub deal_id: String,
    /// 1-based batch number within the deal.
    pub batch: u32,
    pub total_usdc: String,
    /// Sum of the batch's EUR commitments: the units its subscriptions mint.
    pub eur_committed: String,
    pub payment_count: usize,
    /// The collections this batch converts; only these become eligible when it executes.
    pub subscription_refs: Vec<String>,
    pub target_iban: String,
    pub slices: Vec<String>,
    pub status: OffRampStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank_ref: Option<String>,
    /// EUR the conversion actually landed at the SPV.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eur_received: Option<String>,
    /// Urbanflip's transfers covering a conversion shortfall.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_ups: Vec<TopUp>,
    /// eur_received - eur_committed: positive is an FX gain, negative an FX
    /// cost Urbanflip covered with top-ups. Investors' units never move.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fx_result_eur: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopUp {
    pub bank_ref: String,
    pub eur: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OffRampStatus {
    Pending,
    /// Converted, but less EUR landed than was committed; nothing in the
    /// batch is eligible until Urbanflip tops up the difference.
    AwaitingTopUp,
    Executed,
}

impl OffRampInstruction {
    fn eur_at_spv(&self) -> Result<i128, String> {
        let received = self.eur_received.as_deref().map(to_stroops).transpose().map_err(|e| e.to_string())?.unwrap_or(0);
        let topped: i128 = self.top_ups.iter().map(|t| to_stroops(&t.eur)).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?.into_iter().sum();
        Ok(received + topped)
    }

    fn settle_status(&mut self) -> Result<(), String> {
        let committed = to_stroops(&self.eur_committed).map_err(|e| e.to_string())?;
        let at_spv = self.eur_at_spv()?;
        self.status = if at_spv >= committed { OffRampStatus::Executed } else { OffRampStatus::AwaitingTopUp };
        Ok(())
    }

    /// EUR still needed at the SPV before the batch can execute.
    pub fn shortfall_eur(&self) -> Result<i128, String> {
        let committed = to_stroops(&self.eur_committed).map_err(|e| e.to_string())?;
        Ok((committed - self.eur_at_spv()?).max(0))
    }
}

/// Off-ramp batches per deal. Executed batches are immutable; at most one
/// batch per deal is open (pending or awaiting a top-up).
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct OffRampQueue {
    batches: HashMap<String, Vec<OffRampInstruction>>,
}

impl OffRampQueue {
    /// Batches every reconciled collection that no executed batch covers yet.
    /// A still-pending batch is replaced; one awaiting a top-up blocks.
    pub fn build(&mut self, deal_id: &str, reconciled: &[CollectionRecord], target_iban: String, max_slice_usdc: &str) -> Result<OffRampInstruction, String> {
        let batches = self.batches.entry(deal_id.to_string()).or_default();
        if let Some(open) = batches.last().filter(|b| b.status == OffRampStatus::AwaitingTopUp) {
            return Err(format!("batch {} awaits a top-up; complete it first", open.batch));
        }
        let covered: std::collections::HashSet<&str> = batches
            .iter()
            .filter(|b| b.status == OffRampStatus::Executed)
            .flat_map(|b| b.subscription_refs.iter().map(String::as_str))
            .collect();
        let uncovered: Vec<&CollectionRecord> = reconciled
            .iter()
            .filter(|r| r.expected.deal_id == deal_id && !covered.contains(r.expected.subscription_ref.as_str()))
            .collect();
        let sum = |pick: fn(&ExpectedPayment) -> &str| -> Result<i128, String> {
            uncovered.iter().map(|r| to_stroops(pick(&r.expected))).collect::<Result<Vec<_>, _>>().map(|v| v.into_iter().sum()).map_err(|e| e.to_string())
        };
        let total = sum(|e| &e.usdc_amount)?;
        let eur_committed = sum(|e| &e.eur_amount)?;
        if total == 0 {
            return Err(format!("no reconciled collections awaiting off-ramp for deal {deal_id}"));
        }
        let cap = to_stroops(max_slice_usdc).map_err(|e| e.to_string())?;
        if cap == 0 {
            return Err("max slice must be positive".into());
        }
        let mut slices = Vec::new();
        let mut remaining = total;
        while remaining > 0 {
            let slice = remaining.min(cap);
            slices.push(super::money::from_stroops(slice));
            remaining -= slice;
        }
        if batches.last().is_some_and(|b| b.status == OffRampStatus::Pending) {
            batches.pop();
        }
        let mut subscription_refs: Vec<String> = uncovered.iter().map(|r| r.expected.subscription_ref.clone()).collect();
        subscription_refs.sort();
        let instruction = OffRampInstruction {
            deal_id: deal_id.to_string(),
            batch: batches.len() as u32 + 1,
            total_usdc: super::money::from_stroops(total),
            eur_committed: super::money::from_stroops(eur_committed),
            payment_count: uncovered.len(),
            subscription_refs,
            target_iban,
            slices,
            status: OffRampStatus::Pending,
            bank_ref: None,
            eur_received: None,
            top_ups: Vec::new(),
            fx_result_eur: None,
        };
        batches.push(instruction.clone());
        Ok(instruction)
    }

    /// Records the conversion: `eur_received` landed at the SPV under
    /// `bank_ref`. Short of the commitment, the batch awaits a top-up.
    /// Repeating after execution returns the executed batch unchanged.
    pub fn complete(&mut self, deal_id: &str, bank_ref: String, eur_received: &str) -> Result<OffRampInstruction, String> {
        let received = to_stroops(eur_received).map_err(|e| e.to_string())?;
        let last = self.open_or_last(deal_id)?;
        match last.status {
            OffRampStatus::Executed => return Ok(last.clone()),
            OffRampStatus::AwaitingTopUp => {
                return Err(format!("batch {} already converted; record the top-up instead", last.batch));
            }
            OffRampStatus::Pending => {}
        }
        let usdc = to_stroops(&last.total_usdc).map_err(|e| e.to_string())?;
        check_rate(usdc, received)?;
        let committed = to_stroops(&last.eur_committed).map_err(|e| e.to_string())?;
        last.bank_ref = Some(bank_ref);
        last.eur_received = Some(super::money::from_stroops(received));
        last.fx_result_eur = Some(super::money::from_stroops(received - committed));
        last.settle_status()?;
        Ok(last.clone())
    }

    /// Urbanflip covers a conversion shortfall; the batch executes once the
    /// EUR at the SPV reaches the commitment.
    pub fn top_up(&mut self, deal_id: &str, bank_ref: String, eur: &str) -> Result<OffRampInstruction, String> {
        let amount = to_stroops(eur).map_err(|e| e.to_string())?;
        if amount == 0 {
            return Err("top-up must be positive".into());
        }
        let last = self.open_or_last(deal_id)?;
        if last.status != OffRampStatus::AwaitingTopUp {
            return Err(format!("batch {} is {:?}; no top-up needed", last.batch, last.status));
        }
        if last.top_ups.iter().any(|t| t.bank_ref == bank_ref) {
            return Ok(last.clone());
        }
        last.top_ups.push(TopUp { bank_ref, eur: super::money::from_stroops(amount) });
        last.settle_status()?;
        Ok(last.clone())
    }

    fn open_or_last(&mut self, deal_id: &str) -> Result<&mut OffRampInstruction, String> {
        self.batches
            .get_mut(deal_id)
            .and_then(|b| b.last_mut())
            .ok_or_else(|| format!("no off-ramp instruction for deal {deal_id}"))
    }

    /// The executed batch that converted this subscription's USDC, if any.
    pub fn executed_batch_for(&self, deal_id: &str, subscription_ref: &str) -> Option<&OffRampInstruction> {
        self.batches.get(deal_id)?.iter().find(|b| {
            b.status == OffRampStatus::Executed && b.subscription_refs.iter().any(|r| r == subscription_ref)
        })
    }

    pub fn batches(&self, deal_id: &str) -> &[OffRampInstruction] {
        self.batches.get(deal_id).map(Vec::as_slice).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "eligible", rename_all = "snake_case")]
pub enum SettlementEligibility {
    Eligible { investor_id: String, subscription_ref: String, amount: String, bank_ref: String },
    Ineligible { investor_id: String, subscription_ref: String, reason: String },
}

/// THE rule issuance consults: units mint only when EUR is at the SPV.
/// FIAT_WIRE: eligible on recorded bank settlement.
/// USDC_ONCHAIN: eligible only once an EXECUTED off-ramp batch covers it
/// (its EUR fully at the SPV); the amount is the EUR commitment.
pub fn eligibility(
    collections: &[CollectionRecord],
    off_ramp: &OffRampQueue,
    bank_settlements: &[(String, String, String, String)], // (ref, investorId, amount, bankRef)
) -> Vec<SettlementEligibility> {
    let mut out = Vec::new();
    for (r, id, amount, bank_ref) in bank_settlements {
        out.push(SettlementEligibility::Eligible {
            investor_id: id.clone(),
            subscription_ref: r.clone(),
            amount: amount.clone(),
            bank_ref: bank_ref.clone(),
        });
    }
    for c in collections {
        if c.state != CollectionState::Reconciled {
            out.push(SettlementEligibility::Ineligible {
                investor_id: c.expected.investor_id.clone(),
                subscription_ref: c.expected.subscription_ref.clone(),
                reason: format!("collection state {:?}", c.state),
            });
            continue;
        }
        match off_ramp.executed_batch_for(&c.expected.deal_id, &c.expected.subscription_ref) {
            None => out.push(SettlementEligibility::Ineligible {
                investor_id: c.expected.investor_id.clone(),
                subscription_ref: c.expected.subscription_ref.clone(),
                reason: "off-ramp not completed: EUR not yet at SPV".into(),
            }),
            Some(batch) => out.push(SettlementEligibility::Eligible {
                investor_id: c.expected.investor_id.clone(),
                subscription_ref: c.expected.subscription_ref.clone(),
                amount: c.expected.eur_amount.clone(),
                bank_ref: batch.bank_ref.clone().unwrap_or_default(),
            }),
        }
    }
    out
}

// ---- distribution-day rail split ----

#[derive(Debug, Clone, Serialize)]
pub struct PayoutRowIn {
    pub investor_id: String,
    pub amount: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OnChainPayout {
    pub investor_id: String,
    pub amount: String,
    pub stellar_address: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BankPayout {
    pub investor_id: String,
    pub amount: String,
    pub iban: String,
    pub bank_account_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayoutWorklists {
    pub on_chain: Vec<OnChainPayout>,
    pub bank: Vec<BankPayout>,
    pub totals: PayoutTotals,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayoutTotals {
    pub on_chain: String,
    pub bank: String,
    pub combined: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SplitError {
    #[error("duplicate payout row for {0}")]
    Duplicate(String),
    #[error("no rail profile for {0}; refusing to route payout")]
    UnknownInvestor(String),
    #[error("{0} chose FIAT_BANK but rail prerequisites are missing")]
    IncompleteFiat(String),
    #[error(transparent)]
    Money(#[from] super::money::InvalidAmount),
}

pub fn split_by_rail(rows: &[PayoutRowIn], registry: &RailRegistry) -> Result<PayoutWorklists, SplitError> {
    let mut seen = std::collections::HashSet::new();
    let mut on_chain = Vec::new();
    let mut bank = Vec::new();
    for row in rows {
        if !seen.insert(row.investor_id.clone()) {
            return Err(SplitError::Duplicate(row.investor_id.clone()));
        }
        let profile = registry
            .get(&row.investor_id)
            .ok_or_else(|| SplitError::UnknownInvestor(row.investor_id.clone()))?;
        match profile.payout_rail {
            PayoutRail::UsdcOnchain => on_chain.push(OnChainPayout {
                investor_id: row.investor_id.clone(),
                amount: row.amount.clone(),
                stellar_address: profile.stellar_address.clone(),
                email: profile.email.clone(),
            }),
            PayoutRail::FiatBank => {
                let (Some(iban), Some(name)) = (profile.iban.clone(), profile.bank_account_name.clone()) else {
                    return Err(SplitError::IncompleteFiat(row.investor_id.clone()));
                };
                bank.push(BankPayout {
                    investor_id: row.investor_id.clone(),
                    amount: row.amount.clone(),
                    iban,
                    bank_account_name: name,
                });
            }
        }
    }
    let on_chain_total: i128 = on_chain.iter().map(|r| to_stroops(&r.amount)).collect::<Result<Vec<_>, _>>()?.into_iter().sum();
    let bank_total: i128 = bank.iter().map(|r| to_stroops(&r.amount)).collect::<Result<Vec<_>, _>>()?.into_iter().sum();
    Ok(PayoutWorklists {
        on_chain,
        bank,
        totals: PayoutTotals {
            on_chain: super::money::from_stroops(on_chain_total),
            bank: super::money::from_stroops(bank_total),
            combined: super::money::from_stroops(on_chain_total + bank_total),
        },
    })
}

/// SEPA worklist file for the SPV's bank — the generated equivalent of today's
/// manual run, exact and reconcilable against the schedule.
pub fn emit_bank_file(bank: &[BankPayout], deal_id: &str, remitter_name: &str, remitter_iban: &str) -> String {
    let total: i128 = bank.iter().map(|r| to_stroops(&r.amount)).map(|r| r.unwrap_or(0)).sum();
    let mut out = format!(
        "# SEPA worklist {deal_id} — {} payments — {} EUR total\n# remitter: {remitter_name} ({remitter_iban})\namount,iban,beneficiary,remittance_information\n",
        bank.len(),
        super::money::display_amount(total, 2)
    );
    for row in bank {
        let remittance = format!("UF {deal_id} payout {}", row.investor_id);
        out.push_str(&format!("{},{},{},{}\n", row.amount, row.iban, row.bank_account_name, remittance));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, payout: PayoutRail, sub: SubscriptionRail) -> InvestorProfile {
        InvestorProfile {
            investor_id: id.into(),
            email: format!("{id}@x.y"),
            subscription_rail: sub,
            payout_rail: payout,
            stellar_address: "G".to_string() + &"A".repeat(55),
            iban: if payout == PayoutRail::FiatBank { Some("ES9121000418450200051332".into()) } else { None },
            bank_account_name: if payout == PayoutRail::FiatBank { Some("Maria Lopez".into()) } else { None },
            screening_ref: if sub == SubscriptionRail::UsdcOnchain { Some("merkle-1".into()) } else { None },
        }
    }

    #[test]
    fn profile_rules() {
        assert!(validate_profile(&profile("a", PayoutRail::UsdcOnchain, SubscriptionRail::UsdcOnchain)).is_empty());
        let mut p = profile("b", PayoutRail::UsdcOnchain, SubscriptionRail::UsdcOnchain);
        p.screening_ref = None;
        assert!(validate_profile(&p).iter().any(|x| x.contains("screening")));
        let mut p = profile("c", PayoutRail::FiatBank, SubscriptionRail::FiatWire);
        p.iban = None;
        assert!(validate_profile(&p).iter().any(|x| x.contains("iban")));
    }

    #[test]
    fn collection_requires_exact_match() {
        let mut book = CollectionBook::new();
        let expected = book.expect_payment(req("s1", "inv-1", "UF-0042", "25000.00")).unwrap();
        assert_eq!(expected.memo, "UF-UF-0042-s1");

        let exact = ObservedPayment {
            tx_hash: "a".repeat(64),
            from: "G".to_string() + &"B".repeat(55),
            to: "COLL".into(),
            amount: "25000.00".into(),
            asset_code: "USDC".into(),
            asset_issuer: "ISS".into(),
            memo: Some(expected.memo.clone()),
        };
        book.reconcile(&[exact.clone()]).unwrap();
        assert_eq!(book.record("s1").unwrap().state, CollectionState::Reconciled);

        let mut book2 = CollectionBook::new();
        let expected2 = book2.expect_payment(req("s2", "inv-2", "UF-0042", "25000.00")).unwrap();
        let wrong_amount = ObservedPayment { amount: "24000.00".into(), memo: Some(expected2.memo.clone()), ..exact };
        book2.reconcile(&[wrong_amount]).unwrap();
        assert_eq!(book2.record("s2").unwrap().state, CollectionState::Mismatch);
    }

    fn req(sub: &str, inv: &str, deal: &str, usdc: &str) -> PaymentRequest {
        req_eur(sub, inv, deal, usdc, usdc)
    }

    fn req_eur(sub: &str, inv: &str, deal: &str, eur: &str, usdc: &str) -> PaymentRequest {
        PaymentRequest {
            subscription_ref: sub.into(),
            investor_id: inv.into(),
            deal_id: deal.into(),
            eur_amount: eur.into(),
            usdc_amount: usdc.into(),
            quote_ref: None,
            collection_address: "COLL".into(),
            asset_code: "USDC".into(),
            asset_issuer: "ISS".into(),
        }
    }

    fn reconciled(book: &mut CollectionBook, sub: &str, inv: &str, amount: &str) {
        reconciled_eur(book, sub, inv, amount, amount);
    }

    fn reconciled_eur(book: &mut CollectionBook, sub: &str, inv: &str, eur: &str, amount: &str) {
        let expected = book.expect_payment(req_eur(sub, inv, "UF-0042", eur, amount)).unwrap();
        let paid = ObservedPayment {
            tx_hash: format!("{sub:a>64}"),
            from: "G".to_string() + &"B".repeat(55),
            to: "COLL".into(),
            amount: amount.into(),
            asset_code: "USDC".into(),
            asset_issuer: "ISS".into(),
            memo: Some(expected.memo),
        };
        book.reconcile(&[paid]).unwrap();
    }

    #[test]
    fn expect_payment_guards() {
        let mut book = CollectionBook::new();
        book.expect_payment(req("s1", "inv-1", "UF-0042", "10")).unwrap();
        let dup = book.expect_payment(req("s1", "inv-9", "UF-0042", "10"));
        assert!(dup.unwrap_err().contains("already expected"));
        let long = book.expect_payment(req("subscription-000001", "inv-1", "UF-0042", "10"));
        assert!(long.unwrap_err().contains("28 bytes"));
        let bad = book.expect_payment(req("s2", "inv-1", "UF-0042", "ten"));
        assert!(bad.is_err());
        // Deal "A-B" ref "C" and deal "A" ref "B-C" would share memo UF-A-B-C.
        book.expect_payment(req("C", "inv-1", "A-B", "10")).unwrap();
        let clash = book.expect_payment(req("B-C", "inv-2", "A", "10"));
        assert!(clash.unwrap_err().contains("already used"));
    }

    #[test]
    fn offramp_gates_eligibility() {
        let mut book = CollectionBook::new();
        reconciled(&mut book, "s1", "inv-1", "30000.00");

        let mut queue = OffRampQueue::default();
        let instruction = queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap();
        assert_eq!(instruction.slices, vec!["30000.0000000".to_string()]);
        assert_eq!(instruction.subscription_refs, vec!["s1".to_string()]);

        let before = eligibility(&book.reconciled_for("UF-0042"), &queue, &[]);
        assert!(matches!(&before[0], SettlementEligibility::Ineligible { reason, .. } if reason.contains("off-ramp")));

        queue.complete("UF-0042", "TRF-9".into(), "30000.00").unwrap();
        let after = eligibility(&book.reconciled_for("UF-0042"), &queue, &[("f1".into(), "fiat-inv".into(), "10000.00".into(), "TRF-1".into())]);
        assert_eq!(after.len(), 2);
        assert!(after.iter().all(|e| matches!(e, SettlementEligibility::Eligible { .. })));
    }

    #[test]
    fn late_collections_need_their_own_batch() {
        let mut book = CollectionBook::new();
        reconciled(&mut book, "s1", "inv-1", "30000.00");
        let mut queue = OffRampQueue::default();
        queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap();
        queue.complete("UF-0042", "TRF-1".into(), "30000.00").unwrap();

        // Reconciled after batch 1 executed: its USDC was never converted.
        reconciled(&mut book, "s2", "inv-2", "5000.00");
        let view = eligibility(&book.reconciled_for("UF-0042"), &queue, &[]);
        let late = view.iter().find(|e| matches!(e, SettlementEligibility::Ineligible { subscription_ref, .. } if subscription_ref == "s2"));
        assert!(late.is_some(), "late collection must not ride on batch 1");

        // Batch 2 covers only the late collection; batch 1 is untouched.
        let second = queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap();
        assert_eq!((second.batch, second.total_usdc.as_str()), (2, "5000.0000000"));
        assert_eq!(second.subscription_refs, vec!["s2".to_string()]);
        assert_eq!(queue.batches("UF-0042")[0].bank_ref.as_deref(), Some("TRF-1"));
        queue.complete("UF-0042", "TRF-2".into(), "5000.00").unwrap();
        assert_eq!(queue.executed_batch_for("UF-0042", "s2").unwrap().bank_ref.as_deref(), Some("TRF-2"));

        // Nothing left to convert.
        assert!(queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").is_err());
    }

    #[test]
    fn units_follow_the_eur_commitment_and_shortfalls_need_a_top_up() {
        let mut book = CollectionBook::new();
        reconciled_eur(&mut book, "s1", "inv-1", "10000.00", "10850.00");
        let mut queue = OffRampQueue::default();
        let batch = queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap();
        assert_eq!((batch.total_usdc.as_str(), batch.eur_committed.as_str()), ("10850.0000000", "10000.0000000"));

        // A swapped amount is caught, not booked.
        assert!(queue.complete("UF-0042", "TRF-X".into(), "1085000").unwrap_err().contains("implied rate"));

        // The conversion lands EUR 10 short: nothing mints until Urbanflip covers it.
        let short = queue.complete("UF-0042", "TRF-1".into(), "9990.00").unwrap();
        assert_eq!(short.status, OffRampStatus::AwaitingTopUp);
        assert_eq!(short.shortfall_eur().unwrap(), 100_000_000);
        assert_eq!(short.fx_result_eur.as_deref(), Some("-10.0000000"));
        let view = eligibility(&book.reconciled_for("UF-0042"), &queue, &[]);
        assert!(matches!(&view[0], SettlementEligibility::Ineligible { .. }));
        assert!(queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap_err().contains("top-up"));

        let done = queue.top_up("UF-0042", "TOPUP-1".into(), "10.00").unwrap();
        assert_eq!(done.status, OffRampStatus::Executed);
        assert_eq!(queue.top_up("UF-0042", "TOPUP-1".into(), "10.00").unwrap_err(), "batch 1 is Executed; no top-up needed");
        let view = eligibility(&book.reconciled_for("UF-0042"), &queue, &[]);
        assert!(matches!(&view[0], SettlementEligibility::Eligible { amount, .. } if amount == "10000.00"), "units = EUR, not USDC: {view:?}");
    }

    #[test]
    fn fx_gain_is_recorded_and_units_do_not_move() {
        let mut book = CollectionBook::new();
        reconciled_eur(&mut book, "s1", "inv-1", "10000.00", "10850.00");
        let mut queue = OffRampQueue::default();
        queue.build("UF-0042", &book.reconciled_for("UF-0042"), "ES00".into(), "50000").unwrap();
        let done = queue.complete("UF-0042", "TRF-1".into(), "10004.50").unwrap();
        assert_eq!((done.status, done.fx_result_eur.as_deref()), (OffRampStatus::Executed, Some("4.5000000")));
        let view = eligibility(&book.reconciled_for("UF-0042"), &queue, &[]);
        assert!(matches!(&view[0], SettlementEligibility::Eligible { amount, .. } if amount == "10000.00"));
    }

    #[test]
    fn quotes_outside_sane_rates_are_refused() {
        let mut book = CollectionBook::new();
        assert!(book.expect_payment(req_eur("s1", "inv-1", "D", "10000", "100")).unwrap_err().contains("implied rate"));
        assert!(book.expect_payment(req_eur("s2", "inv-1", "D", "10000", "0")).is_err());
        assert!(book.expect_payment(req_eur("s3", "inv-1", "D", "10000", "10850")).is_ok());
    }

    #[test]
    fn split_routes_everyone_exactly_once() {
        let mut registry = RailRegistry::default();
        registry.register(profile("onchain-1", PayoutRail::UsdcOnchain, SubscriptionRail::UsdcOnchain)).unwrap();
        registry.register(profile("fiat-1", PayoutRail::FiatBank, SubscriptionRail::FiatWire)).unwrap();

        let rows = vec![
            PayoutRowIn { investor_id: "onchain-1".into(), amount: "1166.67".into() },
            PayoutRowIn { investor_id: "fiat-1".into(), amount: "833.33".into() },
        ];
        let wl = split_by_rail(&rows, &registry).unwrap();
        assert_eq!(wl.on_chain.len(), 1);
        assert_eq!(wl.bank.len(), 1);
        assert_eq!(wl.totals.combined, "2000.0000000");

        assert!(split_by_rail(&[PayoutRowIn { investor_id: "ghost".into(), amount: "1.00".into() }], &registry).is_err());
    }
}
