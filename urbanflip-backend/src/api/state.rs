//! Application state and environment configuration.

use crate::audit::AuditLog;
use crate::gate::ComplianceGate;
use crate::ops::Ops;
use crate::sdp::SdpClient;
use crate::stellar::horizon::HorizonClient;
use crate::stellar::keys::Keypair;
use crate::domain::rails::{CollectionBook, OffRampQueue, RailRegistry};
use crate::domain::prorata::DistributionSchedule;
use crate::store::{SecretBox, Snapshot, Store, StoredIssuer, SNAPSHOT_VERSION};
use crate::wallet::DevWalletProvider;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct Config {
    pub horizon_url: String,
    pub network_passphrase: String,
    pub home_domain: String,
    pub channel_secret: Option<String>,
    pub collection_address: String,
    pub usdc_code: String,
    pub usdc_issuer: String,
    pub spv_iban: String,
    pub bind: String,
    pub audit_path: Option<String>,
    pub state_path: Option<String>,
    pub state_key: Option<String>,
    /// "static" (allowlist) or "urbanflip" (KYC pipeline over HTTP).
    pub gate_provider: String,
    pub gate_url: Option<String>,
    pub gate_token: Option<String>,
    /// (investor_id, deal_id or "*") pairs for the static gate.
    pub static_gate_allow: Vec<(String, String)>,
    pub sdp_base_url: Option<String>,
    pub sdp_token: Option<String>,
    /// Staff bearer tokens (SHA-256 + role). Empty refuses startup unless
    /// allow_unauthenticated (local development only).
    pub api_tokens: Vec<crate::api::auth::ApiToken>,
    pub allow_unauthenticated: bool,
    pub session_ttl_secs: u64,
    /// Built widget files (wallet-onboarding/web/dist), served at /widget/.
    pub widget_dir: Option<String>,
    /// Origins allowed to frame the widget (e.g. https://app.urbanflip.io).
    pub widget_frame_ancestors: Vec<String>,
    /// Bridge API base, e.g. https://api.sandbox.bridge.xyz/v0 (default) or https://api.bridge.xyz/v0.
    pub bridge_api_url: String,
    pub bridge_api_key: Option<String>,
    /// The Bridge customer (Urbanflip, KYB-approved) that owns the routes.
    pub bridge_customer_id: Option<String>,
    /// Sandbox: deposits are simulated by Bridge instead of sent on-chain.
    pub bridge_sandbox: bool,
    /// PEM public key of the Bridge webhook endpoint.
    pub bridge_webhook_public_key: Option<String>,
    /// Signs off-ramp deposits from the collection account (live Bridge only).
    pub collection_secret: Option<String>,
    /// The SDP distribution wallet that Bridge funding delivers USDC to.
    pub distribution_address: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let network = std::env::var("STELLAR_NETWORK").unwrap_or_else(|_| "testnet".into());
        let (horizon, passphrase) = match network.as_str() {
            "mainnet" | "public" => (
                "https://horizon.stellar.org".to_string(),
                "Public Global Stellar Network ; September 2015".to_string(),
            ),
            _ => (
                std::env::var("HORIZON_URL").unwrap_or_else(|_| "https://horizon-testnet.stellar.org".into()),
                "Test SDF Network ; September 2015".to_string(),
            ),
        };
        Self {
            horizon_url: horizon,
            network_passphrase: std::env::var("NETWORK_PASSPHRASE").unwrap_or(passphrase),
            home_domain: std::env::var("HOME_DOMAIN").unwrap_or_else(|_| "urbanflip.io".into()),
            channel_secret: std::env::var("CHANNEL_SECRET").ok(),
            collection_address: std::env::var("COLLECTION_ADDRESS").unwrap_or_default(),
            usdc_code: std::env::var("USDC_CODE").unwrap_or_else(|_| "USDC".into()),
            usdc_issuer: std::env::var("USDC_ISSUER").unwrap_or_default(),
            spv_iban: std::env::var("SPV_IBAN").unwrap_or_else(|_| "ES9121000418450200051332".into()),
            bind: std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            audit_path: std::env::var("AUDIT_PATH").ok(),
            state_path: std::env::var("STATE_PATH").ok(),
            state_key: std::env::var("STATE_KEY").ok(),
            gate_provider: std::env::var("GATE_PROVIDER").unwrap_or_else(|_| "static".into()),
            gate_url: std::env::var("URBANFLIP_GATE_URL").ok(),
            gate_token: std::env::var("URBANFLIP_GATE_TOKEN").ok(),
            static_gate_allow: std::env::var("STATIC_GATE_ALLOW")
                .ok()
                .map(|raw| serde_json::from_str(&raw).expect("STATIC_GATE_ALLOW must be JSON [[investorId, dealId|\"*\"], ...]"))
                .unwrap_or_default(),
            sdp_base_url: std::env::var("SDP_BASE_URL").ok(),
            sdp_token: std::env::var("SDP_TOKEN").ok(),
            api_tokens: std::env::var("API_TOKENS")
                .ok()
                .map(|raw| serde_json::from_str(&raw).expect("API_TOKENS must be JSON [{\"name\", \"role\", \"sha256\"}, ...]"))
                .unwrap_or_default(),
            allow_unauthenticated: std::env::var("ALLOW_UNAUTHENTICATED").is_ok_and(|v| v == "true"),
            session_ttl_secs: std::env::var("SESSION_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(900),
            widget_dir: std::env::var("WIDGET_DIR").ok(),
            widget_frame_ancestors: std::env::var("WIDGET_FRAME_ANCESTORS")
                .map(|v| v.split([' ', ',']).filter(|o| !o.is_empty()).map(str::to_string).collect())
                .unwrap_or_default(),
            bridge_api_url: std::env::var("BRIDGE_API_URL").unwrap_or_else(|_| "https://api.sandbox.bridge.xyz/v0".into()),
            bridge_api_key: std::env::var("BRIDGE_API_KEY").ok(),
            bridge_customer_id: std::env::var("BRIDGE_CUSTOMER_ID").ok(),
            bridge_sandbox: std::env::var("BRIDGE_API_URL").map(|u| u.contains("sandbox")).unwrap_or(true),
            bridge_webhook_public_key: std::env::var("BRIDGE_WEBHOOK_PUBLIC_KEY").ok(),
            collection_secret: std::env::var("COLLECTION_SECRET").ok(),
            distribution_address: std::env::var("DISTRIBUTION_ADDRESS").ok(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IssuerStatus {
    /// Keypair recorded; the creation tx may or may not have landed.
    Pending,
    Active,
}

#[derive(Clone, Serialize)]
pub struct IssuerRecord {
    pub deal_id: String,
    pub asset_code: String,
    pub issuer_public: String,
    #[serde(skip_serializing)]
    pub issuer_secret: String,
    pub provisioning_tx_hash: Option<String>,
    pub status: IssuerStatus,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SettlementRecord {
    pub subscription_ref: String,
    pub investor_id: String,
    pub deal_id: String,
    pub units: String,
    pub bank_ref: String,
    pub tx_hash: String,
}

/// An issuance recorded BEFORE submission, so a crash or timeout can never
/// lead to a second mint: the next settle resolves it by hash on Horizon.
#[derive(Clone, Serialize, Deserialize)]
pub struct PendingSettlement {
    pub record: SettlementRecord,
    /// The tx can no longer apply after this unix time.
    pub max_time: u64,
}

/// A clawback recorded BEFORE submission under the caller's ref, so a retry
/// after a timeout resolves the same tx by hash instead of clawing twice.
#[derive(Clone, Serialize, Deserialize)]
pub struct ClawbackRecord {
    pub clawback_ref: String,
    pub deal_id: String,
    pub investor_id: String,
    pub address: String,
    /// The amount asked for; None = the investor's whole balance.
    pub requested: Option<String>,
    /// The amount the tx claws back.
    pub amount: String,
    pub tx_hash: String,
    pub max_time: u64,
    pub done: bool,
}

/// EUR received at the deal's SPV for a fiat subscription.
#[derive(Clone, Serialize, Deserialize)]
pub struct BankSettlement {
    pub deal_id: String,
    pub subscription_ref: String,
    pub investor_id: String,
    pub amount: String,
    pub bank_ref: String,
}

pub struct AppState {
    pub config: Config,
    pub ops: Ops,
    pub gate: ComplianceGate,
    pub channel: Option<Keypair>,
    pub sdp: SdpClient,
    pub store: Option<Store>,
    pub ledgers: RwLock<HashMap<String, crate::domain::prorata::DealLedger>>,
    pub issuers: RwLock<HashMap<String, IssuerRecord>>,
    pub profiles: RwLock<RailRegistry>,
    pub collections: RwLock<CollectionBook>,
    pub offramp: RwLock<OffRampQueue>,
    pub schedules: RwLock<HashMap<String, DistributionSchedule>>,
    pub bank_settlements: RwLock<Vec<BankSettlement>>,
    pub settled: RwLock<HashMap<String, SettlementRecord>>,
    pub pending_settlements: RwLock<HashMap<String, PendingSettlement>>,
    pub clawbacks: RwLock<HashMap<String, ClawbackRecord>>,
    pub wallets: RwLock<DevWalletProvider>,
    /// investor_id -> address proven through the ownership challenge.
    pub external_wallets: RwLock<HashMap<String, String>>,
    pub sessions: crate::api::auth::Sessions,
    pub bridge: crate::bridge::BridgeClient,
    /// Collection account key (live Bridge off-ramp deposits), when configured.
    pub collection: Option<Keypair>,
    pub bridge_routes: RwLock<HashMap<String, crate::api::ramp::OfframpRoute>>,
    pub bridge_sends: RwLock<HashMap<String, crate::api::ramp::OfframpSend>>,
    pub funding_accounts: RwLock<HashMap<String, crate::api::ramp::FundingAccount>>,
    pub funding: RwLock<HashMap<String, crate::api::ramp::FundingSummary>>,
    /// Bridge webhook event ids already processed (redeliveries are no-ops).
    pub webhook_events: Mutex<HashSet<String>>,
    pub pending_signatures: crate::api::external::PendingSignatures,
    pub disbursements: RwLock<HashMap<String, Vec<serde_json::Value>>>,
    pub audit: RwLock<AuditLog>,
    inflight: Mutex<HashSet<String>>,
}

pub type SharedState = Arc<AppState>;

/// Held while an operation on one key runs; a concurrent duplicate is refused.
pub struct InflightGuard<'a> {
    state: &'a AppState,
    key: String,
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.state.inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
    }
}

impl AppState {
    /// None when the same operation is already running for this key.
    pub fn begin(&self, key: impl Into<String>) -> Option<InflightGuard<'_>> {
        let key = key.into();
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        inflight.insert(key.clone()).then(|| InflightGuard { state: self, key })
    }

    /// Writes the full state snapshot; a no-op without STATE_PATH.
    pub async fn persist(&self) -> Result<(), String> {
        let Some(store) = &self.store else { return Ok(()) };
        let _writer = store.write_lock.lock().await;
        let snapshot = Snapshot {
            version: SNAPSHOT_VERSION,
            ledgers: self.ledgers.read().await.clone(),
            issuers: self
                .issuers
                .read()
                .await
                .values()
                .map(|r| {
                    (
                        r.deal_id.clone(),
                        StoredIssuer {
                            deal_id: r.deal_id.clone(),
                            asset_code: r.asset_code.clone(),
                            issuer_public: r.issuer_public.clone(),
                            sealed_secret: store.secrets.seal(&r.issuer_secret, &format!("issuer:{}", r.deal_id)),
                            provisioning_tx_hash: r.provisioning_tx_hash.clone(),
                            status: r.status,
                        },
                    )
                })
                .collect(),
            profiles: self.profiles.read().await.clone(),
            collections: self.collections.read().await.clone(),
            offramp: self.offramp.read().await.clone(),
            schedules: self.schedules.read().await.clone(),
            bank_settlements: self.bank_settlements.read().await.clone(),
            settled: self.settled.read().await.clone(),
            pending_settlements: self.pending_settlements.read().await.clone(),
            clawbacks: self.clawbacks.read().await.clone(),
            external_wallets: self.external_wallets.read().await.clone(),
            bridge_routes: self.bridge_routes.read().await.clone(),
            bridge_sends: self.bridge_sends.read().await.clone(),
            funding_accounts: self.funding_accounts.read().await.clone(),
            funding: self.funding.read().await.clone(),
            wallets: self
                .wallets
                .read()
                .await
                .export_secrets()
                .into_iter()
                .map(|(id, secret)| {
                    let sealed = store.secrets.seal(&secret, &format!("wallet:{id}"));
                    (id, sealed)
                })
                .collect(),
            disbursements: self.disbursements.read().await.clone(),
        };
        store.save(&snapshot)
    }
}

/// Loads STATE_PATH (sealed with STATE_KEY) when set. Fails closed: a state
/// file that cannot be read or unsealed stops startup rather than being
/// silently replaced by empty state.
pub fn build_state(config: Config) -> SharedState {
    try_build_state(config).unwrap_or_else(|e| panic!("startup refused: {e}"))
}

pub fn try_build_state(config: Config) -> Result<SharedState, String> {
    if config.api_tokens.is_empty() && !config.allow_unauthenticated {
        return Err("no API_TOKENS configured; refusing to serve an open API (ALLOW_UNAUTHENTICATED=true for local development)".into());
    }
    for token in &config.api_tokens {
        if hex::decode(token.sha256.trim()).map(|d| d.len()) != Ok(32) {
            return Err(format!("API token '{}': sha256 must be 64 hex chars", token.name));
        }
    }
    let gate = match config.gate_provider.as_str() {
        "urbanflip" => ComplianceGate::urbanflip(
            config.gate_url.as_deref().ok_or("GATE_PROVIDER=urbanflip requires URBANFLIP_GATE_URL")?,
            config.gate_token.clone(),
        ),
        "static" => ComplianceGate::static_allowlist(config.static_gate_allow.clone()),
        other => return Err(format!("unknown GATE_PROVIDER '{other}'")),
    };
    let channel = config
        .channel_secret
        .as_ref()
        .map(|s| Keypair::from_secret_str(s).map_err(|e| format!("CHANNEL_SECRET invalid: {e}")))
        .transpose()?;
    let sdp = SdpClient::new(config.sdp_base_url.clone(), config.sdp_token.clone());
    let collection = config
        .collection_secret
        .as_ref()
        .map(|s| Keypair::from_secret_str(s).map_err(|e| format!("COLLECTION_SECRET invalid: {e}")))
        .transpose()?;
    if let Some(kp) = &collection {
        if kp.public_str() != config.collection_address {
            return Err("COLLECTION_SECRET does not match COLLECTION_ADDRESS".into());
        }
    }
    let store = match &config.state_path {
        Some(path) => {
            let key = config.state_key.as_deref().ok_or("STATE_PATH requires STATE_KEY (64 hex chars)")?;
            Some(Store::new(PathBuf::from(path), SecretBox::from_hex(key)?)?)
        }
        None => None,
    };
    let snapshot = match &store {
        Some(s) => s.load()?.unwrap_or_default(),
        None => Snapshot::default(),
    };
    let unseal = |sealed: &str, record_id: String| -> Result<String, String> {
        store.as_ref().ok_or("snapshot without store")?.secrets.open(sealed, &record_id)
    };
    let issuers = snapshot
        .issuers
        .into_iter()
        .map(|(deal_id, s)| {
            let issuer_secret = unseal(&s.sealed_secret, format!("issuer:{deal_id}"))?;
            let record = IssuerRecord {
                deal_id: s.deal_id,
                asset_code: s.asset_code,
                issuer_public: s.issuer_public,
                issuer_secret,
                provisioning_tx_hash: s.provisioning_tx_hash,
                status: s.status,
            };
            Ok((deal_id, record))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;
    let mut wallets = DevWalletProvider::new();
    for (investor_id, sealed) in snapshot.wallets {
        let secret = unseal(&sealed, format!("wallet:{investor_id}"))?;
        wallets.import(&investor_id, &secret)?;
    }
    Ok(Arc::new(AppState {
        ops: Ops { horizon: HorizonClient::new(&config.horizon_url), passphrase: config.network_passphrase.clone() },
        gate,
        channel,
        sdp,
        store,
        ledgers: RwLock::new(snapshot.ledgers),
        issuers: RwLock::new(issuers),
        profiles: RwLock::new(snapshot.profiles),
        collections: RwLock::new(snapshot.collections),
        offramp: RwLock::new(snapshot.offramp),
        schedules: RwLock::new(snapshot.schedules),
        bank_settlements: RwLock::new(snapshot.bank_settlements),
        settled: RwLock::new(snapshot.settled),
        pending_settlements: RwLock::new(snapshot.pending_settlements),
        clawbacks: RwLock::new(snapshot.clawbacks),
        external_wallets: RwLock::new(snapshot.external_wallets),
        sessions: Default::default(),
        bridge: crate::bridge::BridgeClient::new(
            &config.bridge_api_url,
            config.bridge_api_key.clone(),
            config.bridge_customer_id.clone(),
            config.bridge_sandbox,
        ),
        collection,
        bridge_routes: RwLock::new(snapshot.bridge_routes),
        bridge_sends: RwLock::new(snapshot.bridge_sends),
        funding_accounts: RwLock::new(snapshot.funding_accounts),
        funding: RwLock::new(snapshot.funding),
        webhook_events: Mutex::new(HashSet::new()),
        pending_signatures: Default::default(),
        wallets: RwLock::new(wallets),
        disbursements: RwLock::new(snapshot.disbursements),
        audit: RwLock::new(AuditLog::new(config.audit_path.clone().map(std::path::PathBuf::from))),
        inflight: Mutex::new(HashSet::new()),
        config,
    }))
}
