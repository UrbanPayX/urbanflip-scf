//! D5: Bridge wired into the two money legs.
//!
//! Off-ramp (raise close): each deal gets a liquidation address that pays the
//! SPV's IBAN by SEPA. A pending batch's USDC is sent there, then `sync`
//! reads Bridge's drain and completes the batch with the EUR that actually
//! landed, so the shortfall/top-up rules apply to real conversion results.
//!
//! Funding (distribution day): each deal gets a virtual EUR IBAN whose
//! deposits Bridge converts to USDC on Stellar for the SDP distribution
//! wallet; `sync` records the USDC delivered, which `sdp/disburse` then uses
//! as the funded amount instead of a typed figure.
//!
//! Webhooks only trigger these syncs; polling works on its own (the Bridge
//! sandbox sends no webhooks).

use super::routes::{err, now_unix, offramp_response, persist, resolve_pending, ApiError, Pending};
use super::state::SharedState;
use crate::bridge::{BridgeError, Drain, LiquidationAddress, SpvBankAccount, VirtualAccount};
use crate::domain::money::{display_amount, from_stroops, to_stroops};
use crate::domain::rails::{OffRampStatus, MAX_TEXT_MEMO_BYTES};
use crate::stellar::horizon::HorizonError;
use crate::stellar::keys::Keypair;
use crate::stellar::xdr as x;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// A deal's off-ramp route: SPV IBAN (as a Bridge external account) and the
/// liquidation address that pays it.
#[derive(Clone, Serialize, Deserialize)]
pub struct OfframpRoute {
    pub deal_id: String,
    pub external_account_id: String,
    pub iban_fingerprint: String,
    pub liquidation: LiquidationAddress,
    pub sepa_reference: String,
}

/// A batch's USDC on its way to Bridge: a simulated deposit (sandbox, by
/// drain id) or a Stellar payment (live, by tx hash, recorded before submit).
#[derive(Clone, Serialize, Deserialize)]
pub struct OfframpSend {
    pub deal_id: String,
    pub batch: u32,
    pub amount_usdc: String,
    pub drain_id: Option<String>,
    pub deposit_tx_hash: Option<String>,
    /// Set while our own payment's outcome is unknown.
    pub pending_max_time: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FundingAccount {
    pub deal_id: String,
    pub account: VirtualAccount,
    pub destination: String,
    pub memo: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FundedDeposit {
    pub deposit_id: String,
    pub eur: Option<String>,
    pub usdc: Option<String>,
    pub destination_tx_hash: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FundingSummary {
    pub deal_id: String,
    pub eur_deposited: String,
    /// USDC Bridge confirmed delivered to the distribution wallet.
    pub usdc_received: String,
    pub deposits: Vec<FundedDeposit>,
    pub synced_at: u64,
}

pub fn send_key(deal_id: &str, batch: u32) -> String {
    format!("{deal_id}#{batch}")
}

fn bridge_err(e: BridgeError) -> ApiError {
    match e {
        BridgeError::NotConfigured => err(StatusCode::NOT_IMPLEMENTED, e.to_string()),
        BridgeError::Api { status, .. } if (400..500).contains(&status) => err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()),
        _ => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

fn bridge_ready(state: &SharedState) -> Result<(), ApiError> {
    if state.bridge.configured() {
        Ok(())
    } else {
        Err(bridge_err(BridgeError::NotConfigured))
    }
}

/// Memo text if it fits Stellar's 28 bytes.
fn memo_for(text: String) -> Option<String> {
    (text.len() <= MAX_TEXT_MEMO_BYTES).then_some(text)
}

// ---------------- off-ramp ----------------

pub async fn offramp_route(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(account): Json<SpvBankAccount>,
) -> Result<Json<Value>, ApiError> {
    bridge_ready(&state)?;
    let fingerprint = hex::encode(&Sha256::digest(account.iban.replace(' ', "").to_uppercase().as_bytes())[..8]);
    if let Some(route) = state.bridge_routes.read().await.get(&deal_id) {
        if route.iban_fingerprint != fingerprint {
            return Err(err(StatusCode::CONFLICT, format!("deal '{deal_id}' already pays another IBAN through Bridge")));
        }
        return Ok(Json(json!({ "route": route, "idempotent": true })));
    }
    let external_account_id = state
        .bridge
        .create_external_account(&format!("uf-ext-{deal_id}-{fingerprint}"), &account)
        .await
        .map_err(bridge_err)?;
    let sepa_reference = format!("UF {deal_id} OFFRAMP");
    let return_to = (!state.config.collection_address.is_empty()).then(|| state.config.collection_address.clone());
    let liquidation = state
        .bridge
        .create_liquidation_address(
            &format!("uf-liq-{deal_id}-{external_account_id}"),
            &external_account_id,
            &sepa_reference,
            return_to.as_deref().map(|a| (a, "UF-RETURN")),
        )
        .await
        .map_err(bridge_err)?;
    let route = OfframpRoute { deal_id: deal_id.clone(), external_account_id, iban_fingerprint: fingerprint, liquidation, sepa_reference };
    state.bridge_routes.write().await.insert(deal_id.clone(), route.clone());
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "BRIDGE_OFFRAMP_ROUTE", "dealId": deal_id, "liquidationAddressId": route.liquidation.id,
            "externalAccountId": route.external_account_id }))
        .await;
    Ok(Json(json!({ "route": route })))
}

#[derive(Deserialize, Default)]
pub struct SendBody {
    /// A deposit made outside the backend (no COLLECTION_SECRET): its tx hash.
    #[serde(default)]
    deposit_tx_hash: Option<String>,
}

/// Sends the deal's pending batch to its liquidation address, exactly once.
pub async fn offramp_send(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<SendBody>,
) -> Result<Json<Value>, ApiError> {
    bridge_ready(&state)?;
    let key = format!("bridge send for deal '{deal_id}'");
    let _guard = state.begin(key.clone()).ok_or_else(|| super::routes::in_progress(&key))?;
    let route = state
        .bridge_routes
        .read()
        .await
        .get(&deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::CONFLICT, "no Bridge off-ramp route for this deal; create it first"))?;
    let batch = state
        .offramp
        .read()
        .await
        .batches(&deal_id)
        .last()
        .filter(|b| b.status == OffRampStatus::Pending)
        .cloned()
        .ok_or_else(|| err(StatusCode::CONFLICT, "no pending off-ramp batch; build one first"))?;
    let send_id = send_key(&deal_id, batch.batch);

    // Bound first: the read lock must be released before the arms below write.
    let existing = state.bridge_sends.read().await.get(&send_id).cloned();
    if let Some(sent) = existing {
        match sent.pending_max_time {
            None => return Ok(Json(json!({ "send": sent, "idempotent": true }))),
            Some(max_time) => match resolve_pending(&state, sent.deposit_tx_hash.as_deref().unwrap_or_default(), max_time).await? {
                Pending::Landed => return finish_send(&state, sent).await,
                Pending::MayStillLand(after) => {
                    return Err(err(StatusCode::CONFLICT, format!("deposit tx may still land; retry after unix time {after}")))
                }
                Pending::Gone => {
                    state.bridge_sends.write().await.remove(&send_id);
                    persist(&state).await?;
                }
            },
        }
    }

    let amount = display_amount(to_stroops(&batch.total_usdc).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?, 2);
    let mut sent = OfframpSend {
        deal_id: deal_id.clone(),
        batch: batch.batch,
        amount_usdc: batch.total_usdc.clone(),
        drain_id: None,
        deposit_tx_hash: None,
        pending_max_time: None,
    };

    if state.bridge.sandbox {
        // No real chain in the sandbox: Bridge simulates the deposit.
        let drain_id = state
            .bridge
            .simulate_liquidation_deposit(&format!("uf-sim-{send_id}"), &route.liquidation.id, &amount)
            .await
            .map_err(bridge_err)?;
        sent.drain_id = Some(drain_id);
        return finish_send(&state, sent).await;
    }
    if let Some(hash) = body.deposit_tx_hash {
        sent.deposit_tx_hash = Some(hash);
        return finish_send(&state, sent).await;
    }
    let Some(collection) = &state.collection else {
        return Err(err(
            StatusCode::CONFLICT,
            format!(
                "COLLECTION_SECRET not configured: pay {} {} to {} yourself, then call again with deposit_tx_hash",
                batch.total_usdc,
                state.config.usdc_code,
                route.liquidation.memoless_address.as_deref().unwrap_or(&route.liquidation.address)
            ),
        ));
    };
    let prepared = prepare_deposit(&state, collection, &route.liquidation, &batch.total_usdc).await?;
    sent.deposit_tx_hash = Some(prepared.hash.clone());
    sent.pending_max_time = Some(prepared.max_time);
    state.bridge_sends.write().await.insert(send_id.clone(), sent.clone());
    // Durable BEFORE submission.
    persist(&state).await?;
    match state.ops.horizon.submit(&prepared.envelope).await {
        Ok(_) => finish_send(&state, sent).await,
        Err(HorizonError::Rejected(failure)) => {
            state.bridge_sends.write().await.remove(&send_id);
            persist(&state).await?;
            Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("deposit rejected: {failure:?}")))
        }
        Err(e) => Err(err(StatusCode::BAD_GATEWAY, format!("deposit tx {} outcome unknown ({e}); call send again to resolve it", prepared.hash))),
    }
}

async fn finish_send(state: &SharedState, mut sent: OfframpSend) -> Result<Json<Value>, ApiError> {
    sent.pending_max_time = None;
    state.bridge_sends.write().await.insert(send_key(&sent.deal_id, sent.batch), sent.clone());
    persist(state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "BRIDGE_OFFRAMP_SENT", "dealId": sent.deal_id, "batch": sent.batch, "usdc": sent.amount_usdc,
            "drainId": sent.drain_id, "depositTxHash": sent.deposit_tx_hash }))
        .await;
    Ok(Json(json!({ "send": sent })))
}

/// The USDC payment from the collection account to the liquidation address:
/// to its memo-less M-address when Bridge provides one, else with its memo.
async fn prepare_deposit(state: &SharedState, collection: &Keypair, to: &LiquidationAddress, amount: &str) -> Result<crate::ops::PreparedTx, ApiError> {
    let issuer = crate::stellar::keys::decode_public(&state.config.usdc_issuer).map_err(|e| err(StatusCode::PRECONDITION_FAILED, format!("USDC_ISSUER: {e}")))?;
    let (destination, memo) = match (&to.memoless_address, &to.blockchain_memo) {
        (Some(m), _) => (m.as_str(), None),
        (None, memo) => (to.address.as_str(), memo.as_deref()),
    };
    let stroops = to_stroops(amount).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let op = x::op_payment_to(destination, &state.config.usdc_code, &issuer, stroops as i64).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let seq = state
        .ops
        .horizon
        .next_sequence(&collection.public_str())
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let tx = x::build_tx_with_memo(&collection.public_bytes(), seq, crate::ops::DEFAULT_FEE, vec![op], memo).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    Ok(crate::ops::PreparedTx {
        envelope: x::sign_and_encode(&state.ops.passphrase, &tx, &[collection]),
        hash: hex::encode(x::tx_hash(&state.ops.passphrase, &tx)),
        max_time: x::max_time(&tx),
        amount: from_stroops(stroops),
    })
}

pub async fn offramp_sync(State(state): State<SharedState>, Path(deal_id): Path<String>) -> Result<(StatusCode, Json<Value>), ApiError> {
    bridge_ready(&state)?;
    sync_offramp(&state, &deal_id).await
}

/// Completes the deal's sent batch from Bridge's drain: EUR received is the
/// drain receipt's outgoing amount, the bank reference its SEPA reference.
pub async fn sync_offramp(state: &SharedState, deal_id: &str) -> Result<(StatusCode, Json<Value>), ApiError> {
    let route = state
        .bridge_routes
        .read()
        .await
        .get(deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no Bridge off-ramp route for this deal"))?;
    let latest = state.offramp.read().await.batches(deal_id).last().cloned();
    let Some(batch) = latest else { return Err(err(StatusCode::NOT_FOUND, "no off-ramp batch for this deal")) };
    if batch.status != OffRampStatus::Pending {
        return Ok((StatusCode::OK, offramp_response(batch)?));
    }
    let Some(sent) = state.bridge_sends.read().await.get(&send_key(deal_id, batch.batch)).cloned() else {
        return Err(err(StatusCode::CONFLICT, "the pending batch has not been sent to Bridge"));
    };
    if sent.pending_max_time.is_some() {
        return Err(err(StatusCode::CONFLICT, "the deposit's outcome is unknown; call send again to resolve it"));
    }
    let drains: Vec<Drain> = state
        .bridge
        .drains(&route.liquidation.id, sent.drain_id.as_deref(), sent.drain_id.is_none().then_some(sent.deposit_tx_hash.as_deref()).flatten())
        .await
        .map_err(bridge_err)?;
    let Some(drain) = drains.into_iter().next() else {
        return Ok((StatusCode::ACCEPTED, Json(json!({ "status": "awaiting_deposit", "batch": batch.batch }))));
    };
    if drain.failed() {
        return Err(err(StatusCode::CONFLICT, format!("Bridge drain {} is {}: investigate before retrying", drain.id, drain.state)));
    }
    if drain.state != Drain::PROCESSED {
        return Ok((StatusCode::ACCEPTED, Json(json!({ "status": "in_progress", "drainId": drain.id, "drainState": drain.state }))));
    }
    let receipt = drain.receipt.clone().ok_or_else(|| err(StatusCode::BAD_GATEWAY, format!("drain {} has no receipt", drain.id)))?;
    if receipt.destination_currency.as_deref().is_some_and(|c| !c.eq_ignore_ascii_case("eur")) {
        return Err(err(StatusCode::BAD_GATEWAY, format!("drain {} paid out {:?}, not EUR", drain.id, receipt.destination_currency)));
    }
    let eur = receipt.outgoing_amount.ok_or_else(|| err(StatusCode::BAD_GATEWAY, format!("drain {} receipt has no outgoing amount", drain.id)))?;
    let bank_ref = drain.destination.and_then(|d| d.sepa_reference).map(|r| format!("{r} / {}", drain.id)).unwrap_or_else(|| format!("bridge-drain:{}", drain.id));
    let instruction = state
        .offramp
        .write()
        .await
        .complete(deal_id, bank_ref, &eur)
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    persist(state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "OFFRAMP_COMPLETED", "via": "bridge", "dealId": deal_id, "batch": instruction.batch,
            "drainId": drain.id, "bankRef": instruction.bank_ref, "eurCommitted": instruction.eur_committed,
            "eurReceived": instruction.eur_received, "fxResultEur": instruction.fx_result_eur, "status": instruction.status,
            "exchangeRate": receipt.exchange_rate, "receipt": receipt.url }))
        .await;
    Ok((StatusCode::OK, offramp_response(instruction)?))
}

// ---------------- funding ----------------

pub async fn funding_account(State(state): State<SharedState>, Path(deal_id): Path<String>) -> Result<Json<Value>, ApiError> {
    bridge_ready(&state)?;
    if let Some(existing) = state.funding_accounts.read().await.get(&deal_id) {
        return Ok(Json(json!({ "funding_account": existing, "idempotent": true })));
    }
    let destination = state
        .config
        .distribution_address
        .clone()
        .ok_or_else(|| err(StatusCode::PRECONDITION_FAILED, "DISTRIBUTION_ADDRESS (the SDP distribution wallet) not configured"))?;
    let memo = memo_for(format!("UF-FUND-{deal_id}"));
    let account = state
        .bridge
        .create_virtual_account(&format!("uf-va-{deal_id}"), &destination, memo.as_deref())
        .await
        .map_err(bridge_err)?;
    let funding = FundingAccount { deal_id: deal_id.clone(), account, destination, memo };
    state.funding_accounts.write().await.insert(deal_id.clone(), funding.clone());
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "BRIDGE_FUNDING_ACCOUNT", "dealId": deal_id, "virtualAccountId": funding.account.id }))
        .await;
    Ok(Json(json!({ "funding_account": funding })))
}

#[derive(Deserialize)]
pub struct SimulateBody {
    amount: String,
    /// Distinguishes deliberate repeat simulations (idempotency key).
    #[serde(default)]
    reference: Option<String>,
}

/// Sandbox only: an EUR deposit into the deal's funding IBAN.
pub async fn funding_simulate(
    State(state): State<SharedState>,
    Path(deal_id): Path<String>,
    Json(body): Json<SimulateBody>,
) -> Result<Json<Value>, ApiError> {
    bridge_ready(&state)?;
    if !state.bridge.sandbox {
        return Err(err(StatusCode::CONFLICT, "deposits are simulated only against the Bridge sandbox"));
    }
    to_stroops(&body.amount).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;
    let account = funding_of(&state, &deal_id).await?;
    let reference = body.reference.unwrap_or_else(|| format!("{:016x}", rand::random::<u64>()));
    state
        .bridge
        .simulate_virtual_account_deposit(&format!("uf-va-sim-{deal_id}-{reference}"), &account.account.id, &body.amount)
        .await
        .map_err(bridge_err)?;
    Ok(Json(json!({ "simulated": true, "eur": body.amount, "reference": reference })))
}

async fn funding_of(state: &SharedState, deal_id: &str) -> Result<FundingAccount, ApiError> {
    state
        .funding_accounts
        .read()
        .await
        .get(deal_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "no Bridge funding account for this deal; create it first"))
}

pub async fn funding_sync(State(state): State<SharedState>, Path(deal_id): Path<String>) -> Result<Json<Value>, ApiError> {
    bridge_ready(&state)?;
    let summary = sync_funding(&state, &deal_id).await?;
    Ok(Json(json!({ "funding": summary })))
}

/// Totals the deal's funding IBAN: EUR deposited, USDC delivered on Stellar.
pub async fn sync_funding(state: &SharedState, deal_id: &str) -> Result<FundingSummary, ApiError> {
    let account = funding_of(state, deal_id).await?;
    let events = state.bridge.virtual_account_history(&account.account.id).await.map_err(bridge_err)?;
    let mut deposits: Vec<FundedDeposit> = Vec::new();
    let (mut eur_total, mut usdc_total) = (0i128, 0i128);
    for event in &events {
        let Some(deposit_id) = event.deposit_id.clone() else { continue };
        let amount = event.amount.as_deref().map(to_stroops).transpose().map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Bridge amount: {e}")))?;
        let index = match deposits.iter().position(|d| d.deposit_id == deposit_id) {
            Some(i) => i,
            None => {
                deposits.push(FundedDeposit { deposit_id, eur: None, usdc: None, destination_tx_hash: None });
                deposits.len() - 1
            }
        };
        let entry = &mut deposits[index];
        match (event.kind.as_str(), amount) {
            ("funds_received", Some(a)) if entry.eur.is_none() => {
                eur_total += a;
                entry.eur = Some(from_stroops(a));
            }
            ("payment_processed", Some(a)) if entry.usdc.is_none() => {
                usdc_total += a;
                entry.usdc = Some(from_stroops(a));
                entry.destination_tx_hash = event.destination_tx_hash.clone();
            }
            _ => {}
        }
    }
    let summary = FundingSummary {
        deal_id: deal_id.to_string(),
        eur_deposited: from_stroops(eur_total),
        usdc_received: from_stroops(usdc_total),
        deposits,
        synced_at: now_unix(),
    };
    state.funding.write().await.insert(deal_id.to_string(), summary.clone());
    persist(state).await?;
    Ok(summary)
}

pub async fn funding_view(State(state): State<SharedState>, Path(deal_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let account = state.funding_accounts.read().await.get(&deal_id).cloned();
    let summary = state.funding.read().await.get(&deal_id).cloned();
    if account.is_none() && summary.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "no Bridge funding for this deal"));
    }
    Ok(Json(json!({ "funding_account": account, "funding": summary })))
}

/// USDC the SDP batch may pay, from Bridge-confirmed funding: whole cents
/// only (any sub-cent remainder stays in the distribution wallet).
pub async fn confirmed_usdc_funded(state: &SharedState, deal_id: &str) -> Option<String> {
    let summary = state.funding.read().await.get(deal_id).cloned()?;
    let stroops = to_stroops(&summary.usdc_received).ok()?;
    (stroops > 0).then(|| display_amount(stroops - stroops % 100_000, 2))
}

// ---------------- webhook ----------------

/// Bridge webhook: verified, deduplicated by event id, and used only to
/// trigger the matching sync (non-2xx makes Bridge retry).
pub async fn webhook(State(state): State<SharedState>, headers: HeaderMap, body: Bytes) -> Result<Json<Value>, ApiError> {
    let Some(public_key) = &state.config.bridge_webhook_public_key else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "BRIDGE_WEBHOOK_PUBLIC_KEY not configured"));
    };
    let signature = headers.get("x-webhook-signature").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    crate::bridge::verify_webhook(public_key, signature, &body, now_ms).map_err(|e| match e {
        crate::bridge::WebhookError::Stale(_) => err(StatusCode::BAD_REQUEST, e.to_string()),
        _ => err(StatusCode::UNAUTHORIZED, e.to_string()),
    })?;
    let event: Value = serde_json::from_slice(&body).map_err(|e| err(StatusCode::BAD_REQUEST, format!("event JSON: {e}")))?;
    let event_id = event.get("event_id").and_then(Value::as_str).unwrap_or_default().to_string();
    if state.webhook_events.lock().unwrap_or_else(|e| e.into_inner()).contains(&event_id) {
        return Ok(Json(json!({ "duplicate": true })));
    }
    let object = event.get("event_object").cloned().unwrap_or(Value::Null);
    let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
    let outcome = match event.get("event_category").and_then(Value::as_str) {
        Some("liquidation_address.drain") => {
            let liquidation_id = field("liquidation_address_id");
            let deal = state.bridge_routes.read().await.values().find(|r| Some(&r.liquidation.id) == liquidation_id.as_ref()).map(|r| r.deal_id.clone());
            match deal {
                Some(deal) => sync_offramp(&state, &deal).await.map(|(_, Json(v))| json!({ "synced": "offramp", "dealId": deal, "result": v })),
                None => Ok(json!({ "ignored": "unknown liquidation address" })),
            }
        }
        Some("virtual_account.activity") => {
            let va_id = field("virtual_account_id");
            let deal = state.funding_accounts.read().await.values().find(|f| Some(&f.account.id) == va_id.as_ref()).map(|f| f.deal_id.clone());
            match deal {
                Some(deal) => sync_funding(&state, &deal).await.map(|s| json!({ "synced": "funding", "dealId": deal, "usdcReceived": s.usdc_received })),
                None => Ok(json!({ "ignored": "unknown virtual account" })),
            }
        }
        other => Ok(json!({ "ignored": other })),
    }?;
    state.webhook_events.lock().unwrap_or_else(|e| e.into_inner()).insert(event_id);
    Ok(Json(outcome))
}
