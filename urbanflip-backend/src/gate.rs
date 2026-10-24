//! Compliance gate (D1 port): the ONLY thing issuance knows about compliance.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GateStatus {
    Approved,
    Rejected,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateDecision {
    pub status: GateStatus,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub evaluated_at: String,
}

#[derive(Debug, thiserror::Error)]
#[error("compliance gate '{provider}' returned {status:?}{}: settlement refused", reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default())]
pub struct GateRejected {
    pub provider: String,
    pub status: GateStatus,
    pub reason: Option<String>,
}

#[derive(Deserialize)]
struct UrbanflipResponse {
    status: String,
    #[serde(default)]
    evidence_id: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    evaluated_at: Option<String>,
}

/// Provider binding: Urbanflip KYC over HTTP, or a static allowlist for ops/tests.
pub enum ComplianceGate {
    Urbanflip { base_url: String, token: Option<String>, http: reqwest::Client },
    StaticAllowlist { allow: Vec<(String, String)> }, // (investor_id, deal_id or "*")
}

impl ComplianceGate {
    pub fn urbanflip(base_url: &str, token: Option<String>) -> Self {
        Self::Urbanflip { base_url: base_url.trim_end_matches('/').to_string(), token, http: reqwest::Client::new() }
    }

    pub fn static_allowlist(entries: Vec<(String, String)>) -> Self {
        Self::StaticAllowlist { allow: entries }
    }

    /// Fail-closed semantics live at the call sites: anything but Approved blocks.
    pub async fn evaluate(&self, investor_id: &str, stellar_address: &str, deal_id: &str) -> Result<GateDecision, String> {
        match self {
            Self::StaticAllowlist { allow } => Ok(GateDecision {
                status: if allow.iter().any(|(inv, deal)| inv == investor_id && (deal == "*" || deal == deal_id)) {
                    GateStatus::Approved
                } else {
                    GateStatus::Rejected
                },
                provider: "static-allowlist".into(),
                evidence_id: None,
                reason: None,
                evaluated_at: chrono_now(),
            }),
            Self::Urbanflip { base_url, token, http } => {
                let url = format!("{base_url}/api/v1/compliance/decision?investorId={investor_id}&dealId={deal_id}");
                let mut req = http.get(&url);
                if let Some(t) = token {
                    req = req.bearer_auth(t);
                }
                let res = req.send().await.map_err(|e| format!("gate unreachable: {e}"))?;
                if !res.status().is_success() {
                    return Err(format!("gate HTTP {}", res.status()));
                }
                let body: UrbanflipResponse = res.json().await.map_err(|e| format!("gate payload: {e}"))?;
                let status = match body.status.as_str() {
                    "approved" => GateStatus::Approved,
                    "rejected" => GateStatus::Rejected,
                    "pending" => GateStatus::Pending,
                    other => return Err(format!("gate returned invalid status '{other}' — failing closed")),
                };
                Ok(GateDecision {
                    status,
                    provider: "urbanflip-kyc".into(),
                    evidence_id: body.evidence_id,
                    reason: body.reason,
                    evaluated_at: body.evaluated_at.unwrap_or_else(chrono_now),
                })
                .map(|d| {
                    let _ = stellar_address;
                    d
                })
            }
        }
    }
}

fn chrono_now() -> String {
    crate::gate_now()
}
