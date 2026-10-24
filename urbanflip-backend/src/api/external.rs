//! D2 external wallets (Stellar Wallets Kit): a crypto-native investor
//! proves they control an address by signing a SEP-10-style challenge, then
//! opens a sponsored trustline that their own wallet signs and the channel
//! fee-bumps, so they still never spend XLM. Also serves the widget's files.

use super::routes::{channel_of, err, issuer_for, now_unix, persist, ApiError};
use super::state::SharedState;
use crate::stellar::horizon::{HorizonError, TrustlineState};
use crate::stellar::keys::{decode_public, Keypair};
use crate::stellar::xdr as x;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use stellar_xdr::{DecoratedSignature, Limits, ReadXdr, Transaction, TransactionEnvelope};

/// How long a challenge or a built trustline tx may be signed.
const SIGNING_WINDOW_SECS: u64 = 300;

/// An issued, not yet used challenge (keyed by its tx hash).
pub struct Challenge {
    investor_id: String,
    address: String,
    expires_at: u64,
}

/// A trustline tx handed to the investor's wallet (keyed by its tx hash).
pub struct TrustlineBuild {
    investor_id: String,
    deal_id: String,
    address: String,
    expires_at: u64,
}

#[derive(Default)]
pub struct PendingSignatures {
    challenges: std::sync::Mutex<std::collections::HashMap<String, Challenge>>,
    builds: std::sync::Mutex<std::collections::HashMap<String, TrustlineBuild>>,
}

fn decode_tx(envelope_b64: &str) -> Result<(Transaction, Vec<DecoratedSignature>), ApiError> {
    match TransactionEnvelope::from_xdr_base64(envelope_b64, Limits::none()) {
        Ok(TransactionEnvelope::Tx(env)) => Ok((env.tx, env.signatures.to_vec())),
        _ => Err(err(StatusCode::UNPROCESSABLE_ENTITY, "expected a signed v1 transaction envelope")),
    }
}

/// True when `signatures` hold a valid signature by `address` over `hash`.
fn signed_by(address: &str, hash: &[u8; 32], signatures: &[DecoratedSignature]) -> bool {
    let Ok(public) = decode_public(address) else { return false };
    signatures.iter().any(|s| {
        s.hint.0 == public[28..32]
            && <[u8; 64]>::try_from(s.signature.0.as_slice()).map(|sig| Keypair::verify(&public, hash, &sig)).unwrap_or(false)
    })
}

// ---------------- session (issued to the investor app's backend) ----------------

pub async fn create_session(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (token, expires_at) = state.sessions.issue(&investor_id, state.config.session_ttl_secs, now_unix());
    Ok((StatusCode::CREATED, Json(json!({ "session_token": token, "expires_at": expires_at }))))
}

// ---------------- ownership proof ----------------

#[derive(Deserialize)]
pub struct ChallengeBody {
    address: String,
}

pub async fn challenge(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<ChallengeBody>,
) -> Result<Json<Value>, ApiError> {
    let client = decode_public(&body.address).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let server = channel_of(&state)?;
    let mut nonce = [0u8; 48];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let nonce_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce);
    let name = format!("{} auth", state.config.home_domain);
    let op = x::op_manage_data(&client, &name, nonce_b64.as_bytes()).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    // Sequence 0 can never be valid on-chain: the challenge cannot be submitted.
    let tx = x::build_tx(&server.public_bytes(), 0, 100, vec![op]);
    let hash = hex::encode(x::tx_hash(&state.ops.passphrase, &tx));
    let expires_at = x::max_time(&tx);
    state.pending_signatures.challenges.lock().unwrap_or_else(|e| e.into_inner()).insert(
        hash,
        Challenge { investor_id, address: body.address, expires_at },
    );
    Ok(Json(json!({
        "challenge_xdr": x::sign_and_encode(&state.ops.passphrase, &tx, &[&server]),
        "network_passphrase": state.ops.passphrase,
        "expires_at": expires_at,
    })))
}

#[derive(Deserialize)]
pub struct SignedBody {
    signed_xdr: String,
}

pub async fn verify(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<SignedBody>,
) -> Result<Json<Value>, ApiError> {
    let (tx, signatures) = decode_tx(&body.signed_xdr)?;
    let hash = x::tx_hash(&state.ops.passphrase, &tx);
    // The challenge is looked up by the hash of the exact tx we issued, so
    // any change to it fails here; it is single-use either way.
    let issued = state.pending_signatures.challenges.lock().unwrap_or_else(|e| e.into_inner()).remove(&hex::encode(hash));
    let Some(issued) = issued.filter(|c| c.investor_id == investor_id) else {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, "unknown, used or foreign challenge; request a new one"));
    };
    if now_unix() > issued.expires_at {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, "challenge expired; request a new one"));
    }
    if !signed_by(&issued.address, &hash, &signatures) {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("challenge is not signed by {}", issued.address)));
    }
    if state.wallets.read().await.address_of(&investor_id).is_some() {
        return Err(err(StatusCode::CONFLICT, format!("investor '{investor_id}' already has an embedded wallet")));
    }
    {
        let mut linked = state.external_wallets.write().await;
        match linked.get(&investor_id) {
            Some(existing) if existing != &issued.address => {
                return Err(err(
                    StatusCode::CONFLICT,
                    format!("investor '{investor_id}' is linked to {existing}; changing wallets needs support"),
                ))
            }
            Some(_) => return Ok(Json(json!({ "linked": true, "address": issued.address, "idempotent": true }))),
            None => {
                linked.insert(investor_id.clone(), issued.address.clone());
            }
        }
    }
    persist(&state).await?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "EXTERNAL_WALLET_LINKED", "investorId": investor_id, "address": issued.address }))
        .await;
    Ok(Json(json!({ "linked": true, "address": issued.address })))
}

// ---------------- sponsored trustline signed by the investor's wallet ----------------

#[derive(Deserialize)]
pub struct TrustlineBody {
    deal_id: String,
}

async fn linked_address(state: &SharedState, investor_id: &str) -> Result<String, ApiError> {
    state
        .external_wallets
        .read()
        .await
        .get(investor_id)
        .cloned()
        .ok_or_else(|| err(StatusCode::CONFLICT, "no external wallet linked; complete the ownership challenge first"))
}

pub async fn trustline(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<TrustlineBody>,
) -> Result<Json<Value>, ApiError> {
    let issuer = issuer_for(&state, &body.deal_id).await?;
    let channel = channel_of(&state)?;
    let address = linked_address(&state, &investor_id).await?;
    let trustline = state
        .ops
        .horizon
        .trustline_state(&address, &issuer.asset_code, &issuer.issuer_public)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
    if matches!(trustline, TrustlineState::Ready | TrustlineState::Unauthorized) {
        return Ok(Json(json!({ "status": "ready", "address": address })));
    }
    let investor = decode_public(&address).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let issuer_pub = decode_public(&issuer.issuer_public).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let mut ops = vec![x::op_begin_sponsoring(&investor)];
    if trustline == TrustlineState::NoAccount {
        ops.push(x::op_create_account(&investor, 0));
    }
    ops.push(x::op_change_trust(&issuer.asset_code, &issuer_pub, i64::MAX, Some(&investor)).map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e))?);
    ops.push(x::op_end_sponsoring(&investor));
    let seq = state
        .ops
        .horizon
        .next_sequence(&channel.public_str())
        .await
        .map_err(|e: HorizonError| err(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let tx = x::build_tx(&channel.public_bytes(), seq, crate::ops::DEFAULT_FEE, ops);
    let hash = hex::encode(x::tx_hash(&state.ops.passphrase, &tx));
    let expires_at = x::max_time(&tx).min(now_unix() + SIGNING_WINDOW_SECS);
    state.pending_signatures.builds.lock().unwrap_or_else(|e| e.into_inner()).insert(
        hash,
        TrustlineBuild { investor_id, deal_id: body.deal_id, address, expires_at },
    );
    Ok(Json(json!({
        "status": "sign",
        "xdr": x::sign_and_encode(&state.ops.passphrase, &tx, &[&channel]),
        "network_passphrase": state.ops.passphrase,
        "expires_at": expires_at,
    })))
}

#[derive(Deserialize)]
pub struct TrustlineSubmitBody {
    deal_id: String,
    signed_xdr: String,
}

pub async fn trustline_submit(
    State(state): State<SharedState>,
    Path(investor_id): Path<String>,
    Json(body): Json<TrustlineSubmitBody>,
) -> Result<Json<Value>, ApiError> {
    let channel = channel_of(&state)?;
    let (tx, signatures) = decode_tx(&body.signed_xdr)?;
    let hash = x::tx_hash(&state.ops.passphrase, &tx);
    let built = state.pending_signatures.builds.lock().unwrap_or_else(|e| e.into_inner()).remove(&hex::encode(hash));
    let Some(built) = built.filter(|b| b.investor_id == investor_id && b.deal_id == body.deal_id) else {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, "unknown, used or foreign transaction; request a new one"));
    };
    if now_unix() > built.expires_at {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, "transaction expired; request a new one"));
    }
    if !signed_by(&built.address, &hash, &signatures) {
        return Err(err(StatusCode::UNPROCESSABLE_ENTITY, format!("transaction is not signed by {}", built.address)));
    }
    // Keep the channel's own signature; drop anything else the wallet added.
    let kept: Vec<DecoratedSignature> = signatures
        .into_iter()
        .filter(|s| {
            [channel.public_str(), built.address.clone()].iter().any(|a| signed_by(a, &hash, std::slice::from_ref(s)))
        })
        .collect();
    let envelope = x::fee_bump_wrap(&state.ops.passphrase, &channel, crate::ops::DEFAULT_FEE, &tx, kept);
    let tx_hash = state.ops.horizon.submit(&envelope).await.map_err(|e| match e {
        HorizonError::Rejected(f) => err(StatusCode::UNPROCESSABLE_ENTITY, format!("trustline rejected: {f:?}")),
        other => err(StatusCode::BAD_GATEWAY, format!("{other}; request the trustline again to see whether it landed")),
    })?;
    state
        .audit
        .write()
        .await
        .append(json!({ "kind": "EXTERNAL_TRUSTLINE_OPENED", "investorId": investor_id, "dealId": built.deal_id,
            "address": built.address, "txHash": tx_hash, "zeroXlm": true }))
        .await;
    Ok(Json(json!({ "status": "submitted", "trustline_tx_hash": tx_hash })))
}

// ---------------- widget files ----------------

/// Serves the built widget from WIDGET_DIR. Only plain file names inside
/// the directory are served, and only the configured origins may frame it.
pub async fn widget_file(State(state): State<SharedState>, Path(file): Path<String>) -> Response {
    let Some(dir) = &state.config.widget_dir else {
        return err(StatusCode::NOT_FOUND, "widget not configured (WIDGET_DIR)").into_response();
    };
    let safe = !file.is_empty()
        && file.split('/').all(|seg| !seg.is_empty() && !seg.starts_with('.') && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)));
    let content_type = match file.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("json") | Some("map") => "application/json",
        _ => return err(StatusCode::NOT_FOUND, "not found").into_response(),
    };
    let Ok(bytes) = (if safe { tokio::fs::read(std::path::Path::new(dir).join(&file)).await } else { Err(std::io::ErrorKind::NotFound.into()) }) else {
        return err(StatusCode::NOT_FOUND, "not found").into_response();
    };
    let ancestors = if state.config.widget_frame_ancestors.is_empty() {
        "'none'".to_string()
    } else {
        state.config.widget_frame_ancestors.join(" ")
    };
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(csp) = HeaderValue::from_str(&format!("frame-ancestors {ancestors}")) {
        headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}
