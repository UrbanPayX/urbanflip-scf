//! API access control. Staff callers present a bearer token whose SHA-256
//! is configured with one role (API_TOKENS); investors present a short-lived
//! session token (issued to the investor app's backend) that reaches only
//! their own external-wallet endpoints. Every route has an explicit policy;
//! a route without one is refused, so a new route can't ship open by mistake.

use super::state::SharedState;
use axum::extract::{MatchedPath, RawPathParams, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Everything.
    Admin,
    /// Day-to-day platform flows: ledgers, issuers, onboarding, subscriptions, settlement, distributions.
    Operations,
    /// Off-ramp, payouts and SDP disbursement.
    Treasury,
    /// Trustline authorization and offboarding (freeze, clawback).
    Compliance,
    /// Read-only views.
    Read,
}

/// One configured staff token: only its SHA-256 is kept.
#[derive(Debug, Clone, Deserialize)]
pub struct ApiToken {
    pub name: String,
    pub role: Role,
    /// Hex SHA-256 of the token (`printf %s "$TOKEN" | sha256sum`).
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub enum Caller {
    Staff { name: String, role: Role },
    Investor { investor_id: String },
    /// ALLOW_UNAUTHENTICATED=true (local development only).
    Unauthenticated,
}

impl Caller {
    fn label(&self) -> String {
        match self {
            Caller::Staff { name, .. } => name.clone(),
            Caller::Investor { investor_id } => format!("investor:{investor_id}"),
            Caller::Unauthenticated => "unauthenticated".into(),
        }
    }
}

struct Session {
    investor_id: String,
    expires_at: u64,
}

/// Investor sessions, keyed by the token's SHA-256. In memory: a restart
/// simply makes the investor app fetch a new one.
#[derive(Default)]
pub struct Sessions {
    by_hash: std::sync::Mutex<HashMap<[u8; 32], Session>>,
}

impl Sessions {
    /// Issues a random session token for one investor; returns (token, expires_at).
    pub fn issue(&self, investor_id: &str, ttl_secs: u64, now: u64) -> (String, u64) {
        let mut raw = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let token = hex::encode(raw);
        let expires_at = now + ttl_secs;
        let mut sessions = self.by_hash.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, s| s.expires_at > now);
        sessions.insert(Sha256::digest(token.as_bytes()).into(), Session { investor_id: investor_id.to_string(), expires_at });
        (token, expires_at)
    }

    fn investor_for(&self, digest: &[u8; 32], now: u64) -> Option<String> {
        let sessions = self.by_hash.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(digest).filter(|s| s.expires_at > now).map(|s| s.investor_id.clone())
    }
}

enum Access {
    Public,
    /// Staff with one of these roles (admin always qualifies).
    Staff(&'static [Role]),
    /// Staff as above, or the session of the investor named in the path.
    StaffOrOwnInvestor(&'static [Role]),
}

use Role::{Compliance, Operations, Read, Treasury};

fn policy(method: &Method, route: &str) -> Option<Access> {
    let access = match (method.as_str(), route) {
        ("GET", "/healthz") | ("GET", "/widget/{*file}") => Access::Public,
        ("POST", "/v1/deals/{deal_id}/ledger")
        | ("POST", "/v1/deals/{deal_id}/provision-issuer")
        | ("POST", "/v1/investors/{investor_id}/profile")
        | ("POST", "/v1/investors/{investor_id}/onboard")
        | ("POST", "/v1/investors/{investor_id}/session")
        | ("POST", "/v1/subscriptions/fiat")
        | ("POST", "/v1/subscriptions/crypto/expect")
        | ("POST", "/v1/subscriptions/crypto/reconcile")
        | ("POST", "/v1/subscriptions/{subscription_ref}/settle")
        | ("POST", "/v1/deals/{deal_id}/distributions")
        | ("POST", "/v1/deals/{deal_id}/distributions/replay") => Access::Staff(&[Operations]),
        ("POST", "/v1/deals/{deal_id}/authorize/{investor_id}") => Access::Staff(&[Operations, Compliance]),
        ("POST", "/v1/deals/{deal_id}/freeze/{investor_id}") | ("POST", "/v1/deals/{deal_id}/clawback/{investor_id}") => {
            Access::Staff(&[Compliance])
        }
        ("POST", "/v1/deals/{deal_id}/offramp/build")
        | ("POST", "/v1/deals/{deal_id}/offramp/complete")
        | ("POST", "/v1/deals/{deal_id}/offramp/top-up")
        | ("POST", "/v1/deals/{deal_id}/payouts/split")
        | ("POST", "/v1/deals/{deal_id}/sdp/disburse") => Access::Staff(&[Treasury]),
        ("GET", "/v1/deals/{deal_id}/eligibility") => Access::Staff(&[Operations, Treasury, Compliance, Read]),
        ("POST", "/v1/trustline-check") => Access::Staff(&[Operations, Treasury, Compliance, Read]),
        ("GET", "/v1/audit") => Access::Staff(&[Compliance, Read]),
        ("POST", "/v1/investors/{investor_id}/external-wallet/challenge")
        | ("POST", "/v1/investors/{investor_id}/external-wallet/verify")
        | ("POST", "/v1/investors/{investor_id}/external-wallet/trustline")
        | ("POST", "/v1/investors/{investor_id}/external-wallet/trustline/submit") => {
            Access::StaffOrOwnInvestor(&[Operations])
        }
        _ => return None,
    };
    Some(access)
}

/// Equal-time comparison, so a token check leaks nothing through timing.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn deny(status: StatusCode, message: &str) -> Response {
    let mut response = (status, Json(json!({ "error": message }))).into_response();
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, header::HeaderValue::from_static("Bearer"));
    }
    response
}

fn identify(state: &SharedState, request: &Request) -> Option<Caller> {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?
        .trim();
    let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    for configured in &state.config.api_tokens {
        let Ok(expected) = hex::decode(configured.sha256.trim()) else { continue };
        if ct_eq(&expected, &digest) {
            return Some(Caller::Staff { name: configured.name.clone(), role: configured.role });
        }
    }
    let now = super::routes::now_unix();
    state.sessions.investor_for(&digest, now).map(|investor_id| Caller::Investor { investor_id })
}

/// Route layer: resolves the caller, enforces the route's policy, and audits
/// every state-changing call with the caller's name and the outcome.
pub async fn guard(
    State(state): State<SharedState>,
    matched: MatchedPath,
    params: RawPathParams,
    mut request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let Some(access) = policy(&method, matched.as_str()) else {
        return deny(StatusCode::FORBIDDEN, "no access policy for this route");
    };
    let caller = if matches!(access, Access::Public) {
        Caller::Unauthenticated
    } else if state.config.allow_unauthenticated {
        identify(&state, &request).unwrap_or(Caller::Unauthenticated)
    } else {
        let Some(caller) = identify(&state, &request) else {
            return deny(StatusCode::UNAUTHORIZED, "missing or invalid bearer token");
        };
        let allowed = match (&access, &caller) {
            (Access::Public, _) => true,
            (_, Caller::Staff { role: Role::Admin, .. }) => true,
            (Access::Staff(roles) | Access::StaffOrOwnInvestor(roles), Caller::Staff { role, .. }) => roles.contains(role),
            (Access::StaffOrOwnInvestor(_), Caller::Investor { investor_id }) => {
                params.iter().any(|(key, value)| key == "investor_id" && value == investor_id)
            }
            _ => false,
        };
        if !allowed {
            return deny(StatusCode::FORBIDDEN, "this token may not call this route");
        }
        caller
    };
    let path = request.uri().path().to_string();
    request.extensions_mut().insert(caller.clone());
    let response = next.run(request).await;
    if method != Method::GET {
        state
            .audit
            .write()
            .await
            .append(json!({ "kind": "API_CALL", "method": method.as_str(), "path": path, "caller": caller.label(),
                "status": response.status().as_u16() }))
            .await;
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    #[test]
    fn sessions_expire_and_are_scoped() {
        let sessions = Sessions::default();
        let (token, expires_at) = sessions.issue("inv-a", 60, 1_000);
        assert_eq!(expires_at, 1_060);
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        assert_eq!(sessions.investor_for(&digest, 1_059).as_deref(), Some("inv-a"));
        assert_eq!(sessions.investor_for(&digest, 1_060), None, "expired");
        assert_eq!(sessions.investor_for(&[0u8; 32], 1_000), None);
    }

    #[test]
    fn unknown_routes_have_no_policy() {
        assert!(policy(&Method::POST, "/v1/new-route").is_none());
        assert!(policy(&Method::DELETE, "/v1/deals/{deal_id}/ledger").is_none());
    }
}
