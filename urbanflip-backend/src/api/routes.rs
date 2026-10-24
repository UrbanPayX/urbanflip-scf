//! HTTP API: every deliverable wired into one surface.

use super::state::{
    BankSettlement, ClawbackRecord, IssuerRecord, IssuerStatus, PendingSettlement, SettlementRecord, SharedState,
};
use crate::domain::money::display_amount;
use crate::domain::prorata::{
    compute_distribution, replay_deal, ComputeOptions, DealLedger, DealOutcome, HistoricalPayout,
    LoanPosition, RemainderPolicy,
};
use crate::domain::rails::{eligibility, emit_bank_file, split_by_rail, CollectionState, OffRampStatus, PaymentRequest, PayoutRowIn};
use crate::ops::OpsError;
use crate::sdp::{convert_on_chain, emit_sdp_files};
use crate::stellar::horizon::HorizonError;
use crate::stellar::keys::Keypair;
use crate::stellar::xdr as x;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/deals/{deal_id}/ledger", post(register_ledger))
        .route("/v1/deals/{deal_id}/provision-issuer", post(provision_issuer))
        .route("/v1/investors/{investor_id}/profile", post(register_profile))
        .route("/v1/investors/{investor_id}/onboard", post(onboard_investor))
        .route("/v1/deals/{deal_id}/authorize/{investor_id}", post(authorize))
        .route("/v1/deals/{deal_id}/freeze/{investor_id}", post(freeze))
        .route("/v1/deals/{deal_id}/clawback/{investor_id}", post(clawback))
        .route("/v1/subscriptions/fiat", post(fiat_settlement))
        .route("/v1/subscriptions/crypto/expect", post(crypto_expect))
        .route("/v1/subscriptions/crypto/reconcile", post(crypto_reconcile))
        .route("/v1/deals/{deal_id}/offramp/build", post(offramp_build))
        .route("/v1/deals/{deal_id}/offramp/complete", post(offramp_complete))
        .route("/v1/deals/{deal_id}/offramp/top-up", post(offramp_top_up))
        .route("/v1/deals/{deal_id}/eligibility", get(eligibility_view))
        .route("/v1/subscriptions/{subscription_ref}/settle", post(settle))
        .route("/v1/deals/{deal_id}/distributions", post(compute))
        .route("/v1/deals/{deal_id}/distributions/replay", post(replay))
        .route("/v1/deals/{deal_id}/payouts/split", post(payouts_split))
        .route("/v1/deals/{deal_id}/sdp/disburse", post(sdp_disburse))
        .route("/v1/trustline-check", post(trustline_check))
        .route("/v1/audit", get(audit_view))
        .with_state(state)
}

async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "service": "urbanflip-backend" }))
}

fn err(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

type ApiError = (StatusCode, Json<Value>);

/// Seconds past a tx's max_time before "not on the ledger" is treated as
/// "never will be" (absorbs clock skew against ledger close times).
const MAX_TIME_GRACE_SECS: u64 = 30;

fn ops_err(e: OpsError) -> ApiError {
    let status = match &e {
        OpsError::Gate(_) => StatusCode::FORBIDDEN,
        OpsError::GateUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
        OpsError::TrustlineNotReady(..) | OpsError::NothingToClawBack(_) => StatusCode::CONFLICT,
        OpsError::Horizon(HorizonError::Rejected(_)) => StatusCode::UNPROCESSABLE_ENTITY,
        OpsError::Horizon(HorizonError::NoAccount(_)) => StatusCode::NOT_FOUND,
        OpsError::Horizon(_) => StatusCode::BAD_GATEWAY,
        OpsError::Signature(_) | OpsError::Wallet(_) | OpsError::Build(_) | OpsError::Money(_) => StatusCode::UNPROCESSABLE_ENTITY,
    };
    err(status, e.to_string())
}

fn in_progress(key: &str) -> ApiError {
    err(StatusCode::CONFLICT, format!("{key} already in progress; retry when it finishes"))
}

async fn persist(state: &SharedState) -> Result<(), ApiError> {
    state
        .persist()
        .await
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("state not persisted: {e}")))
}

/// What became of a tx recorded before submission.
enum Pending {
    /// It closed successfully: finish without resubmitting.
    Landed,
    /// It failed on-chain or expired off-ledger: it never applied; rebuild.
    Gone,
    /// Not on the ledger yet, but still valid until this unix time.
    MayStillLand(u64),
}

async fn resolve_pending(state: &SharedState, hash: &str, max_time: u64) -> Result<Pending, ApiError> {
    let outcome = state
        .ops
        .horizon
        .transaction_outcome(hash)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let retry_after = max_time.saturating_add(MAX_TIME_GRACE_SECS);
    Ok(match outcome {
        Some(true) => Pending::Landed,
        Some(false) => Pending::Gone,
        None if now_unix() <= retry_after => Pending::MayStillLand(retry_after),
        None => Pending::Gone,
    })
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn issuer_for(state: &SharedState, deal_id: &str) -> Result<IssuerRecord, ApiError> {
    let record = state
        .issuers
        .read()
        .await
        .get(deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("deal '{deal_id}' has no issuer; provision first")))?;
    if record.status != IssuerStatus::Active {
        return Err(err(
            StatusCode::CONFLICT,
            format!("deal '{deal_id}' issuer is not confirmed on-chain; retry provision-issuer"),
        ));
    }
    Ok(record)
}

fn issuer_kp(record: &IssuerRecord) -> Result<Keypair, ApiError> {
    Keypair::from_secret_str(&record.issuer_secret).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn wallet_address(state: &SharedState, investor_id: &str) -> Result<String, ApiError> {
    if let Some(a) = state.wallets.read().await.address_of(investor_id) {
        return Ok(a);
    }
    state
        .profiles
        .read()
        .await
        .get(investor_id)
        .map(|p| p.stellar_address.clone())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "investor has no wallet; onboard first"))
}

fn channel_of(state: &SharedState) -> Result<Keypair, ApiError> {
    state
        .channel
        .clone()
        .ok_or_else(|| err(StatusCode::PRECONDITION_FAILED, "CHANNEL_SECRET not configured"))
}

// ---------------- ledger + issuer ----------------

#[derive(Deserialize)]
struct LedgerBody {
    positions: Vec<PositionBody>,
}

#[derive(Deserialize)]
struct PositionBody {
    investor_id: String,
    email: String,
    #[serde(default)]
    wallet_address: Option<String>,
    principal: String,
}

async fn register_ledger(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<LedgerBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let ledger = DealLedger {
        deal_id: deal_id.clone(),
        positions: body
            .positions
            .into_iter()
            .map(|p| LoanPosition {
                investor_id: p.investor_id,
                email: p.email,
                wallet_address: p.wallet_address,
                principal: p.principal,
            })
            .collect(),
    };
    let count = ledger.positions.len();
    state.ledgers.write().await.insert(deal_id.clone(), ledger);
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "LEDGER_REGISTERED", "dealId": deal_id, "positions": count }))
        .await;
    Ok((StatusCode::CREATED, Json(json!({ "stored": count, "dealId": deal_id }))))
}

#[derive(Deserialize)]
struct ProvisionBody {
    #[serde(default)]
    asset_code: Option<String>,
}

async fn provision_issuer(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<ProvisionBody>,
) -> Result<Json<Value>, ApiError> {
    let channel = channel_of(&state)?;
    let key = format!("provisioning deal '{deal_id}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| in_progress(&key))?;
    let existing = state.issuers.read().await.get(&deal_id).cloned();
    let record = match existing {
        Some(r) if r.status == IssuerStatus::Active => {
            return Ok(Json(json!({ "dealId": deal_id, "assetCode": r.asset_code, "issuer": r.issuer_public,
                "txHash": r.provisioning_tx_hash, "idempotent": true })));
        }
        Some(r) => {
            if body.asset_code.as_ref().is_some_and(|code| code != &r.asset_code) {
                return Err(err(StatusCode::CONFLICT, format!("deal '{deal_id}' already has a pending issuer for {}", r.asset_code)));
            }
            r
        }
        None => {
            let asset_code = body.asset_code.unwrap_or_else(|| derive_asset_code(&deal_id));
            x::validate_asset_code(&asset_code).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
            let issuer = Keypair::random();
            let record = IssuerRecord {
                deal_id: deal_id.clone(),
                asset_code,
                issuer_public: issuer.public_str(),
                issuer_secret: issuer.secret_str(),
                provisioning_tx_hash: None,
                status: IssuerStatus::Pending,
            };
            state.issuers.write().await.insert(deal_id.clone(), record.clone());
            record
        }
    };
    // The key is durable BEFORE the account can exist on-chain (re-persisted
    // on retries too, in case an earlier write failed).
    persist(&state).await?;
    let issuer = issuer_kp(&record)?;
    // A pending issuer may already be on-chain (lost response, crash): adopt it.
    let landed = match state.ops.horizon.account(&record.issuer_public).await {
        Ok(a) if a.auth_required && a.auth_revocable && a.auth_clawback_enabled => true,
        Ok(_) => {
            return Err(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("issuer {} exists without auth flags; manual review required", record.issuer_public),
            ))
        }
        Err(HorizonError::NoAccount(_)) => false,
        Err(e) => return Err(err(StatusCode::BAD_GATEWAY, e.to_string())),
    };
    let hash = if landed {
        record.provisioning_tx_hash.clone()
    } else {
        Some(
            state
                .ops
                .provision_issuer(&channel, &issuer, Some(&state.config.home_domain))
                .await
                .map_err(ops_err)?,
        )
    };
    let active = IssuerRecord { provisioning_tx_hash: hash.clone(), status: IssuerStatus::Active, ..record };
    state.issuers.write().await.insert(deal_id.clone(), active.clone());
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "ISSUER_PROVISIONED", "dealId": deal_id, "assetCode": active.asset_code,
            "issuer": active.issuer_public, "txHash": hash, "adoptedExisting": landed }))
        .await;
    Ok(Json(json!({ "dealId": deal_id, "assetCode": active.asset_code, "issuer": active.issuer_public, "txHash": hash })))
}

fn derive_asset_code(deal_id: &str) -> String {
    let digits: String = deal_id.chars().filter(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() && digits.len() <= 2 {
        format!("UF{digits:0>2}")
    } else {
        deal_id.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect()
    }
}

// ---------------- investor rails ----------------

#[derive(Deserialize)]
struct ProfileBody {
    email: String,
    subscription_rail: crate::domain::rails::SubscriptionRail,
    payout_rail: crate::domain::rails::PayoutRail,
    stellar_address: String,
    #[serde(default)]
    iban: Option<String>,
    #[serde(default)]
    bank_account_name: Option<String>,
    #[serde(default)]
    screening_ref: Option<String>,
}

async fn register_profile(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<ProfileBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let profile = crate::domain::rails::InvestorProfile {
        investor_id: investor_id.clone(),
        email: body.email,
        subscription_rail: body.subscription_rail,
        payout_rail: body.payout_rail,
        stellar_address: body.stellar_address,
        iban: body.iban,
        bank_account_name: body.bank_account_name,
        screening_ref: body.screening_ref,
    };
    state
        .profiles
        .write()
        .await
        .register(profile)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(&state).await?;
    Ok((StatusCode::CREATED, Json(json!({ "investorId": investor_id, "status": "registered" }))))
}

// ---------------- D2 onboarding (sponsored, zero XLM, fee-bumped) ----------------

#[derive(Deserialize)]
struct OnboardBody {
    deal_id: String,
}

async fn onboard_investor(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<OnboardBody>,
) -> Result<Json<Value>, ApiError> {
    let issuer = issuer_for(&state, &body.deal_id).await?;
    let channel = channel_of(&state)?;
    let key = format!("onboarding investor '{investor_id}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| in_progress(&key))?;
    let address = state.wallets.write().await.get_or_create(&investor_id).public_str();
    // The key is durable BEFORE its account can exist on-chain.
    persist(&state).await?;
    let sign_raw = state
        .wallets
        .read()
        .await
        .raw_signer(&investor_id)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let onboarded = state
        .ops
        .onboard_sponsored(&channel, &address, &issuer.asset_code, &issuer.issuer_public, |hash| sign_raw(hash))
        .await
        .map_err(ops_err)?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "INVESTOR_ONBOARDED", "investorId": investor_id, "dealId": body.deal_id,
            "address": address, "creationTxHash": onboarded.creation_tx_hash,
            "trustlineTxHash": onboarded.trustline_tx_hash, "zeroXlm": true }))
        .await;
    Ok(Json(json!({
        "investorId": investor_id,
        "stellarAddress": address,
        "accountCreationTxHash": onboarded.creation_tx_hash,
        "trustlineTxHash": onboarded.trustline_tx_hash,
        "zeroXlm": true,
    })))
}

// ---------------- D1 gate + authorization + offboarding ----------------

async fn authorize(
    State(state): State<SharedState>,
    Path((deal_id, investor_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let issuer = issuer_for(&state, &deal_id).await?;
    let issuer_kp = issuer_kp(&issuer)?;
    let address = wallet_address(&state, &investor_id).await?;
    let (decision, result) = state
        .ops
        .authorize_trustline(&state.gate, &deal_id, &issuer.asset_code, &issuer_kp, &investor_id, &address)
        .await;
    // Every request's gate outcome is logged, approvals and refusals alike.
    let gate_event = match (&decision, &result) {
        (Some(d), _) => json!({ "kind": "GATE_DECISION", "dealId": deal_id, "investorId": investor_id, "address": address, "decision": d }),
        (None, Err(e)) => json!({ "kind": "GATE_UNAVAILABLE", "dealId": deal_id, "investorId": investor_id, "address": address, "error": e.to_string() }),
        (None, Ok(_)) => unreachable!("authorization never proceeds without a gate decision"),
    };
    state.audit.write().await.append(gate_event).await;
    let hash = result.map_err(ops_err)?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "TRUSTLINE_AUTHORIZED", "dealId": deal_id, "investorId": investor_id, "txHash": hash }))
        .await;
    Ok(Json(json!({ "authorized": true, "decision": decision, "txHash": hash })))
}

async fn freeze(
    State(state): State<SharedState>,
    Path((deal_id, investor_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let issuer = issuer_for(&state, &deal_id).await?;
    let issuer_kp = issuer_kp(&issuer)?;
    let address = wallet_address(&state, &investor_id).await?;
    let hash = state
        .ops
        .freeze_trustline(&issuer.asset_code, &issuer_kp, &address)
        .await
        .map_err(ops_err)?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "TRUSTLINE_FROZEN", "dealId": deal_id, "investorId": investor_id, "txHash": hash }))
        .await;
    Ok(Json(json!({ "frozen": true, "asset": issuer.asset_code, "txHash": hash })))
}

#[derive(Deserialize)]
struct ClawbackBody {
    /// Omitted = the investor's whole balance (offboarding).
    #[serde(default)]
    amount: Option<String>,
    /// Idempotency key, required with an explicit amount: a retry with the
    /// same ref resolves the first attempt and never claws back twice.
    #[serde(default)]
    clawback_ref: Option<String>,
    /// Optional cross-check: must equal the investor's resolved address.
    #[serde(default)]
    investor_address: Option<String>,
}

async fn clawback(
    State(state): State<SharedState>,
    Path((deal_id, investor_id)): Path<(String, String)>,
    Json(body): Json<ClawbackBody>,
) -> Result<Json<Value>, ApiError> {
    let issuer = issuer_for(&state, &deal_id).await?;
    let issuer_kp = issuer_kp(&issuer)?;
    let address = wallet_address(&state, &investor_id).await?;
    if body.investor_address.as_ref().is_some_and(|a| a != &address) {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("investor '{investor_id}' holds {address}, not the address given")));
    }
    let clawback_ref = match (&body.clawback_ref, &body.amount) {
        (Some(r), _) => r.clone(),
        (None, Some(_)) => {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "clawback_ref is required with an explicit amount: it makes a retry after a timeout safe",
            ))
        }
        // A whole-balance clawback is safe to repeat: once one lands there is
        // nothing left, and a later one fails rather than claws again.
        (None, None) => format!("full-{deal_id}-{investor_id}-{:016x}", rand::random::<u64>()),
    };
    let key = format!("clawback '{clawback_ref}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| in_progress(&key))?;

    let existing = state.clawbacks.read().await.get(&clawback_ref).cloned();
    if let Some(r) = existing {
        if r.deal_id != deal_id || r.investor_id != investor_id || r.requested != body.amount {
            return Err(err(StatusCode::CONFLICT, format!("clawback_ref '{clawback_ref}' was used for a different clawback")));
        }
        if r.done {
            return Ok(Json(clawback_json(&r, json!({ "idempotent": true }))));
        }
        match resolve_pending(&state, &r.tx_hash, r.max_time).await? {
            Pending::Landed => return finish_clawback(&state, r, true).await,
            Pending::MayStillLand(after) => {
                return Err(err(
                    StatusCode::CONFLICT,
                    format!("clawback tx {} may still land; retry after unix time {after}", r.tx_hash),
                ))
            }
            Pending::Gone => {
                state.clawbacks.write().await.remove(&clawback_ref);
                persist(&state).await?;
            }
        }
    }

    let prepared = state
        .ops
        .prepare_clawback(&issuer.asset_code, &issuer_kp, &address, body.amount.as_deref())
        .await
        .map_err(ops_err)?;
    let record = ClawbackRecord {
        clawback_ref: clawback_ref.clone(),
        deal_id,
        investor_id,
        address,
        requested: body.amount.clone(),
        amount: prepared.amount.clone(),
        tx_hash: prepared.hash.clone(),
        max_time: prepared.max_time,
        done: false,
    };
    state.clawbacks.write().await.insert(clawback_ref.clone(), record.clone());
    // Durable BEFORE submission.
    persist(&state).await?;
    match state.ops.horizon.submit(&prepared.envelope).await {
        Ok(_) => finish_clawback(&state, record, false).await,
        Err(HorizonError::Rejected(failure)) => {
            state.clawbacks.write().await.remove(&clawback_ref);
            persist(&state).await?;
            Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("clawback rejected: {failure:?}")))
        }
        Err(e) => Err(err(
            StatusCode::BAD_GATEWAY,
            format!("clawback tx {} outcome unknown ({e}); retry with clawback_ref '{clawback_ref}' to resolve it", prepared.hash),
        )),
    }
}

async fn finish_clawback(state: &SharedState, mut record: ClawbackRecord, resolved_by_hash: bool) -> Result<Json<Value>, ApiError> {
    record.done = true;
    state.clawbacks.write().await.insert(record.clawback_ref.clone(), record.clone());
    persist(state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "CLAWBACK", "dealId": record.deal_id, "investorId": record.investor_id, "address": record.address,
            "amount": record.amount, "clawbackRef": record.clawback_ref, "txHash": record.tx_hash, "resolvedByHash": resolved_by_hash }))
        .await;
    Ok(Json(clawback_json(&record, json!({}))))
}

fn clawback_json(record: &ClawbackRecord, mut extra: Value) -> Value {
    extra["clawedBack"] = json!(record.amount);
    extra["address"] = json!(record.address);
    extra["clawbackRef"] = json!(record.clawback_ref);
    extra["txHash"] = json!(record.tx_hash);
    extra
}

// ---------------- subscriptions: fiat + crypto collection + off-ramp ----------------

#[derive(Deserialize)]
struct FiatSettlementBody {
    deal_id: String,
    investor_id: String,
    subscription_ref: String,
    amount: String,
    bank_ref: String,
}

async fn fiat_settlement(
    State(state): State<SharedState>,
    Json(body): Json<FiatSettlementBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    crate::domain::money::to_stroops(&body.amount).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    if state.collections.read().await.record(&body.subscription_ref).is_some() {
        return Err(err(StatusCode::CONFLICT, format!("subscription '{}' is a crypto collection", body.subscription_ref)));
    }
    {
        let mut banks = state.bank_settlements.write().await;
        if banks.iter().any(|b| b.subscription_ref == body.subscription_ref) {
            return Err(err(StatusCode::CONFLICT, format!("subscription '{}' already recorded", body.subscription_ref)));
        }
        banks.push(BankSettlement {
            deal_id: body.deal_id.clone(),
            subscription_ref: body.subscription_ref.clone(),
            investor_id: body.investor_id.clone(),
            amount: body.amount.clone(),
            bank_ref: body.bank_ref.clone(),
        });
    }
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "FIAT_SETTLEMENT_RECORDED", "dealId": body.deal_id, "investorId": body.investor_id,
            "subscriptionRef": body.subscription_ref, "amount": body.amount, "bankRef": body.bank_ref }))
        .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "recorded": true, "eligibleForIssuance": true, "subscriptionRef": body.subscription_ref })),
    ))
}

#[derive(Deserialize)]
struct CryptoExpectBody {
    deal_id: String,
    investor_id: String,
    subscription_ref: String,
    /// The investor's EUR commitment: the units they will hold.
    eur_amount: String,
    /// The USDC they pay for it, per the ramp quote.
    usdc_amount: String,
    #[serde(default)]
    quote_ref: Option<String>,
}

async fn crypto_expect(
    State(state): State<SharedState>,
    Json(body): Json<CryptoExpectBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if state.config.collection_address.is_empty() {
        return Err(err(StatusCode::PRECONDITION_FAILED, "COLLECTION_ADDRESS not configured"));
    }
    let taken = state.collections.read().await.record(&body.subscription_ref).is_some()
        || state.bank_settlements.read().await.iter().any(|b| b.subscription_ref == body.subscription_ref);
    if taken {
        return Err(err(StatusCode::CONFLICT, format!("subscription '{}' already recorded", body.subscription_ref)));
    }
    let expected = state
        .collections
        .write()
        .await
        .expect_payment(PaymentRequest {
            subscription_ref: body.subscription_ref.clone(),
            investor_id: body.investor_id.clone(),
            deal_id: body.deal_id.clone(),
            eur_amount: body.eur_amount.clone(),
            usdc_amount: body.usdc_amount.clone(),
            quote_ref: body.quote_ref.clone(),
            collection_address: state.config.collection_address.clone(),
            asset_code: state.config.usdc_code.clone(),
            asset_issuer: state.config.usdc_issuer.clone(),
        })
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(&state).await?;
    Ok((StatusCode::CREATED, Json(json!({ "expected": expected }))))
}

async fn crypto_reconcile(State(state): State<SharedState>) -> Result<Json<Value>, ApiError> {
    let address = state.config.collection_address.clone();
    if address.is_empty() {
        return Err(err(StatusCode::PRECONDITION_FAILED, "COLLECTION_ADDRESS not configured"));
    }
    let incoming = state
        .ops
        .horizon
        .incoming_payments(&address, &state.config.usdc_code, &state.config.usdc_issuer)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let updated = state
        .collections
        .write()
        .await
        .reconcile(&incoming)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    persist(&state).await?;
    let summary: Vec<Value> = updated
        .iter()
        .map(|r| json!({ "subscriptionRef": r.expected.subscription_ref, "state": r.state }))
        .collect();
    Ok(Json(json!({ "reconciled": summary })))
}

#[derive(Deserialize)]
struct OffRampBuildBody {
    #[serde(default)]
    target_iban: Option<String>,
    #[serde(default = "default_slice")]
    max_slice_usdc: String,
}

fn default_slice() -> String {
    "50000".into()
}

async fn offramp_build(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<OffRampBuildBody>,
) -> Result<Json<Value>, ApiError> {
    let reconciled = state.collections.read().await.reconciled_for(&deal_id);
    if reconciled.is_empty() {
        return Err(err(StatusCode::NOT_FOUND, "no reconciled collections for deal"));
    }
    let instruction = state
        .offramp
        .write()
        .await
        .build(
            &deal_id,
            &reconciled,
            body.target_iban.unwrap_or_else(|| state.config.spv_iban.clone()),
            &body.max_slice_usdc,
        )
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(&state).await?;
    Ok(Json(json!({ "instruction": instruction })))
}

#[derive(Deserialize)]
struct OffRampCompleteBody {
    bank_ref: String,
    /// EUR the conversion actually landed at the SPV.
    eur_received: String,
}

async fn offramp_complete(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<OffRampCompleteBody>,
) -> Result<Json<Value>, ApiError> {
    let instruction = state
        .offramp
        .write()
        .await
        .complete(&deal_id, body.bank_ref.clone(), &body.eur_received)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "OFFRAMP_COMPLETED", "dealId": deal_id, "batch": instruction.batch,
            "bankRef": instruction.bank_ref, "totalUsdc": instruction.total_usdc, "eurCommitted": instruction.eur_committed,
            "eurReceived": instruction.eur_received, "fxResultEur": instruction.fx_result_eur, "status": instruction.status,
            "subscriptionRefs": instruction.subscription_refs }))
        .await;
    offramp_response(instruction)
}

#[derive(Deserialize)]
struct OffRampTopUpBody {
    bank_ref: String,
    eur_amount: String,
}

/// Urbanflip covers a conversion shortfall so the batch's units can mint.
async fn offramp_top_up(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<OffRampTopUpBody>,
) -> Result<Json<Value>, ApiError> {
    let instruction = state
        .offramp
        .write()
        .await
        .top_up(&deal_id, body.bank_ref.clone(), &body.eur_amount)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "OFFRAMP_TOPPED_UP", "dealId": deal_id, "batch": instruction.batch,
            "bankRef": body.bank_ref, "eur": body.eur_amount, "status": instruction.status }))
        .await;
    offramp_response(instruction)
}

fn offramp_response(instruction: crate::domain::rails::OffRampInstruction) -> Result<Json<Value>, ApiError> {
    let shortfall = instruction.shortfall_eur().map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let now_eligible = if instruction.status == OffRampStatus::Executed { instruction.subscription_refs.clone() } else { vec![] };
    Ok(Json(json!({
        "instruction": instruction,
        "shortfallEur": crate::domain::money::from_stroops(shortfall),
        "cryptoSettlementsNowEligible": now_eligible,
    })))
}

async fn eligibility_view(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let collections = state.collections.read().await.reconciled_for(&deal_id);
    let bank: Vec<(String, String, String, String)> = state
        .bank_settlements
        .read()
        .await
        .iter()
        .filter(|b| b.deal_id == deal_id)
        .map(|b| (b.subscription_ref.clone(), b.investor_id.clone(), b.amount.clone(), b.bank_ref.clone()))
        .collect();
    let off_ramp = state.offramp.read().await;
    Ok(Json(json!({ "eligibility": eligibility(&collections, &off_ramp, &bank) })))
}

// ---------------- issuance on settled money ----------------

async fn settle(
    State(state): State<SharedState>,
    Path(subscription_ref): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let key = format!("settling '{subscription_ref}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| in_progress(&key))?;
    if let Some(existing) = state.settled.read().await.get(&subscription_ref) {
        return Ok(Json(json!({ "settlement": existing, "idempotent": true })));
    }

    // An earlier attempt recorded its tx before submitting: resolve it by
    // hash, so an unknown outcome can never become a second mint.
    let pending = state.pending_settlements.read().await.get(&subscription_ref).cloned();
    if let Some(p) = pending {
        match resolve_pending(&state, &p.record.tx_hash, p.max_time).await? {
            Pending::Landed => return finish_settlement(&state, p.record, true).await,
            Pending::MayStillLand(after) => {
                return Err(err(
                    StatusCode::CONFLICT,
                    format!("issuance tx {} may still land; retry after unix time {after}", p.record.tx_hash),
                ));
            }
            Pending::Gone => {}
        }
        state.pending_settlements.write().await.remove(&subscription_ref);
        persist(&state).await?;
    }

    // Locate the subscription and its EUR-at-SPV evidence.
    // Ok((investor, amount, bank_ref, deal_id)); Err(reason) = ineligible.
    let located: Result<(String, String, String, String), String> = {
        let banks = state.bank_settlements.read().await;
        if let Some(found) = banks.iter().find(|b| b.subscription_ref == subscription_ref) {
            Ok((found.investor_id.clone(), found.amount.clone(), found.bank_ref.clone(), found.deal_id.clone()))
        } else {
            drop(banks);
            let collections = state.collections.read().await;
            match collections.record(&subscription_ref) {
                None => Err(format!("unknown subscription '{subscription_ref}'")),
                Some(record) if record.state != CollectionState::Reconciled => Err(format!("collection state is {:?}", record.state)),
                Some(record) => match state.offramp.read().await.executed_batch_for(&record.expected.deal_id, &subscription_ref) {
                    None => Err("off-ramp not completed for this collection: EUR not yet at SPV".into()),
                    Some(batch) => Ok((
                        record.expected.investor_id.clone(),
                        record.expected.eur_amount.clone(),
                        batch.bank_ref.clone().unwrap_or_default(),
                        record.expected.deal_id.clone(),
                    )),
                },
            }
        }
    };
    let (investor_id, amount, bank_ref, deal_id) =
        located.map_err(|reason| err(StatusCode::PRECONDITION_FAILED, reason))?;

    let issuer = issuer_for(&state, &deal_id).await?;
    let issuer_kp = issuer_kp(&issuer)?;
    let address = wallet_address(&state, &investor_id).await?;
    let prepared = state
        .ops
        .prepare_issuance(&issuer.asset_code, &issuer_kp, &address, &amount)
        .await
        .map_err(ops_err)?;
    let record = SettlementRecord {
        subscription_ref: subscription_ref.clone(),
        investor_id,
        deal_id,
        units: prepared.amount.clone(),
        bank_ref,
        tx_hash: prepared.hash.clone(),
    };
    state
        .pending_settlements
        .write()
        .await
        .insert(subscription_ref.clone(), PendingSettlement { record: record.clone(), max_time: prepared.max_time });
    // Durable BEFORE submission.
    persist(&state).await?;
    match state.ops.horizon.submit(&prepared.envelope).await {
        Ok(_) => finish_settlement(&state, record, false).await,
        Err(HorizonError::Rejected(failure)) => {
            state.pending_settlements.write().await.remove(&subscription_ref);
            persist(&state).await?;
            Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("issuance rejected: {failure:?}")))
        }
        Err(e) => Err(err(
            StatusCode::BAD_GATEWAY,
            format!("issuance tx {} outcome unknown ({e}); retry settle to resolve it", prepared.hash),
        )),
    }
}

async fn finish_settlement(state: &SharedState, record: SettlementRecord, resolved_by_hash: bool) -> Result<Json<Value>, ApiError> {
    state.pending_settlements.write().await.remove(&record.subscription_ref);
    state.settled.write().await.insert(record.subscription_ref.clone(), record.clone());
    persist(state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "SUBSCRIPTION_SETTLED", "dealId": record.deal_id, "subscriptionRef": record.subscription_ref,
            "investorId": record.investor_id, "units": record.units, "bankRef": record.bank_ref, "txHash": record.tx_hash,
            "resolvedByHash": resolved_by_hash }))
        .await;
    Ok(Json(json!({ "settlement": record })))
}

// ---------------- D3 distributions ----------------

#[derive(Deserialize)]
struct ComputeBody {
    outcome: DealOutcome,
}

async fn compute(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<ComputeBody>,
) -> Result<Json<Value>, ApiError> {
    let ledger = state
        .ledgers
        .read()
        .await
        .get(&deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "unknown deal ledger"))?;
    let schedule = compute_distribution(&ledger, &body.outcome, &ComputeOptions::default())
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    let response = schedule_json(&schedule);
    state.schedules.write().await.insert(deal_id.clone(), schedule);
    persist(&state).await?;
    Ok(response)
}

fn schedule_json(s: &crate::domain::prorata::DistributionSchedule) -> Json<Value> {
    Json(json!({
        "dealId": s.deal_id,
        "remainderPolicy": s.remainder_policy,
        "rows": s.rows.iter().map(|r| json!({
            "investorId": r.investor_id,
            "principal": display_amount(r.principal_stroops, 2),
            "interest": display_amount(r.interest_stroops, 2),
            "total": display_amount(r.total_stroops, 2),
            "walletAddress": r.wallet_address,
        })).collect::<Vec<_>>(),
        "totals": {
            "principal": display_amount(s.totals.principal_stroops, 2),
            "interest": display_amount(s.totals.interest_stroops, 2),
            "total": display_amount(s.totals.total_stroops, 2),
        }
    }))
}

#[derive(Deserialize)]
struct ReplayBody {
    outcome: DealOutcome,
    historical: Vec<HistoricalPayout>,
    #[serde(default)]
    policy: Option<RemainderPolicy>,
}

async fn replay(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<ReplayBody>,
) -> Result<Json<Value>, ApiError> {
    let ledger = state
        .ledgers
        .read()
        .await
        .get(&deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "unknown deal ledger"))?;
    let report = replay_deal(
        &ledger,
        &body.outcome,
        &body.historical,
        &ComputeOptions { decimals: 2, policy: body.policy.unwrap_or(RemainderPolicy::LargestRemainder) },
    )
    .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    Ok(Json(json!({
        "match": report.match_,
        "comparedRows": report.compared_rows,
        "diffs": report.diffs.iter().map(|d| json!({
            "investorId": d.investor_id,
            "recorded": display_amount(d.recorded_stroops, 2),
            "computed": display_amount(d.computed_stroops, 2),
            "delta": display_amount(d.delta_stroops, 2),
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct SplitQuery {
    /// USDC the treasury bought for the on-chain cohort; when given, the
    /// response includes the converted payouts and SDP files.
    #[serde(default)]
    usdc_funded: Option<String>,
}

/// EUR worklists per rail; the on-chain EUR total is what treasury converts.
async fn payouts_split(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Query(query): Query<SplitQuery>,
) -> Result<Json<Value>, ApiError> {
    let (schedule, worklists, on_chain_addresses) = payout_worklists(&state, &deal_id).await?;
    let bank_file = emit_bank_file(&worklists.bank, &deal_id, "Urbanflip SPV", &state.config.spv_iban);
    let mut response = json!({
        "onChain": worklists.on_chain,
        "bank": worklists.bank,
        "totals": worklists.totals,
        "onChainEurToConvert": worklists.totals.on_chain,
        "bankFile": bank_file,
    });
    if let Some(usdc_funded) = &query.usdc_funded {
        let conversion = convert_on_chain(&schedule, &on_chain_addresses, usdc_funded)
            .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
        response["sdpFiles"] = json!(emit_sdp_files(&deal_id, &conversion.payouts));
        response["usdcConversion"] = json!(conversion);
    }
    Ok(Json(response))
}

async fn payout_worklists(
    state: &SharedState,
    deal_id: &str,
) -> Result<(crate::domain::prorata::DistributionSchedule, crate::domain::rails::PayoutWorklists, HashSet<String>), ApiError> {
    let schedule = state
        .schedules
        .read()
        .await
        .get(deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no distribution computed for deal"))?;
    let rows: Vec<PayoutRowIn> = schedule
        .rows
        .iter()
        .map(|r| PayoutRowIn { investor_id: r.investor_id.clone(), amount: display_amount(r.total_stroops, 2) })
        .collect();
    let worklists = {
        let profiles = state.profiles.read().await;
        split_by_rail(&rows, &profiles).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?
    };
    let on_chain_addresses = worklists.on_chain.iter().map(|r| r.stellar_address.clone()).collect();
    Ok((schedule, worklists, on_chain_addresses))
}

#[derive(Deserialize)]
struct DisburseBody {
    /// USDC the treasury bought for the on-chain cohort (at most 2 decimals).
    usdc_funded: String,
}

async fn sdp_disburse(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<DisburseBody>,
) -> Result<Json<Value>, ApiError> {
    let key = format!("disbursing deal '{deal_id}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| in_progress(&key))?;
    let (schedule, _, on_chain_addresses) = payout_worklists(&state, &deal_id).await?;
    let conversion = convert_on_chain(&schedule, &on_chain_addresses, &body.usdc_funded)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let files = emit_sdp_files(&deal_id, &conversion.payouts);

    // Each file is created in the SDP at most once. The digest covers the
    // USDC file AND the EUR owed behind it, so a recomputed schedule or a
    // different funding is refused rather than re-sent or silently skipped.
    let created_before = state.disbursements.read().await.get(&deal_id).cloned().unwrap_or_default();
    let eur_basis: String = conversion.payouts.iter().map(|p| format!("{}={}\n", p.investor_id, p.eur)).collect();
    let mut to_create = Vec::new();
    for file in &files {
        let digest = hex::encode(Sha256::digest(format!("{}#eur\n{eur_basis}", file.content).as_bytes()));
        match created_before.iter().find(|c| c["file"] == file.name.as_str()) {
            Some(c) if c["sha256"] == digest.as_str() => {}
            Some(_) => {
                return Err(err(
                    StatusCode::CONFLICT,
                    format!("{} was already disbursed with different content; reconcile in the SDP first", file.name),
                ))
            }
            None => to_create.push((file, digest)),
        }
    }
    if to_create.is_empty() && !created_before.is_empty() {
        return Ok(Json(json!({ "created": created_before, "idempotent": true })));
    }
    if !state.sdp.configured() {
        return Err(err(
            StatusCode::NOT_IMPLEMENTED,
            "SDP not configured (SDP_BASE_URL/SDP_TOKEN); files are available via /payouts/split for manual upload",
        ));
    }
    for (file, digest) in to_create {
        let resp = state
            .sdp
            .create_disbursement(&file.name, &file.content)
            .await
            .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let entry = json!({ "file": file.name, "sha256": digest, "rows": file.row_count, "sdp": resp });
        state.disbursements.write().await.entry(deal_id.clone()).or_default().push(entry);
        persist(&state).await?;
    }
    let created = state.disbursements.read().await.get(&deal_id).cloned().unwrap_or_default();
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "SDP_DISBURSEMENTS_CREATED", "dealId": deal_id, "files": created.iter().map(|c| c["file"].clone()).collect::<Vec<_>>(),
            "eurTotal": conversion.eur_total, "usdcTotal": conversion.usdc_total, "rate": conversion.rate }))
        .await;
    Ok(Json(json!({ "created": created, "usdcConversion": conversion })))
}

#[derive(Deserialize)]
struct TrustlineCheckBody {
    asset_code: String,
    asset_issuer: String,
    addresses: Vec<String>,
}

async fn trustline_check(
    State(state): State<SharedState>,
    Json(body): Json<TrustlineCheckBody>,
) -> Result<Json<Value>, ApiError> {
    let mut statuses = Vec::new();
    for address in &body.addresses {
        let s = state
            .ops
            .horizon
            .trustline_state(address, &body.asset_code, &body.asset_issuer)
            .await
            .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
        statuses.push(json!({ "address": address, "state": format!("{s:?}") }));
    }
    Ok(Json(json!({ "statuses": statuses })))
}

async fn audit_view(State(state): State<SharedState>) -> Json<Value> {
    Json(json!({ "events": state.audit.read().await.recent(50) }))
}
