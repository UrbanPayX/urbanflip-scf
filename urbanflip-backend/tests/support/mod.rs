//! Test harness: an in-process fake Horizon (+ SDP) and app launcher.
//!
//! The fake is strict where real failures happened: every required signer's
//! Ed25519 signature is verified against the network hash, sequence numbers
//! must be next, ops apply atomically with Stellar's result codes. It can
//! also misbehave on demand (timeouts that did or did not apply, slow
//! submissions) to exercise the backend's crash-safety paths.

#![allow(dead_code)]

use axum::extract::{Form, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use stellar_xdr::{
    AccountId, Asset, ChangeTrustAsset, FeeBumpTransactionInnerTx, Limits, MuxedAccount, OperationBody, PublicKey, ReadXdr,
    Transaction, TransactionEnvelope,
};
use urbanflip_backend::api::state::{try_build_state, Config, SharedState};
use urbanflip_backend::stellar::keys::{decode_public, Keypair};
use urbanflip_backend::stellar::xdr as x;

pub const PASSPHRASE: &str = "Test SDF Network ; September 2015";
pub const USDC_CODE: &str = "USDC";

#[derive(Clone, Debug, Default)]
pub struct Line {
    pub balance: i64,
    pub authorized: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Account {
    pub seq: i64,
    pub flags: u32,
    pub xlm: i64,
    /// (code, issuer) -> line
    pub lines: HashMap<(String, String), Line>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SubmitMode {
    Normal,
    /// Applies the tx but answers 504 (Horizon saw no close in time).
    TimeoutAfterApply,
    /// Answers 504 without the tx ever applying.
    TimeoutWithoutApply,
}

pub struct Net {
    pub accounts: HashMap<String, Account>,
    pub txs: HashMap<String, bool>,
    pub mode: SubmitMode,
    pub submit_delay_ms: u64,
    pub submissions: usize,
    /// Raw Horizon payment records served for any account's /payments.
    pub payments: Vec<Value>,
    pub sdp_creates: Vec<Value>,
    pub base_url: String,
}

pub type FakeNet = Arc<Mutex<Net>>;

pub fn address(public: &[u8; 32]) -> String {
    stellar_strkey::ed25519::PublicKey(*public).to_string()
}

fn account_str(id: &AccountId) -> String {
    let AccountId(PublicKey::PublicKeyTypeEd25519(k)) = id;
    address(&k.0)
}

fn muxed_str(m: &MuxedAccount) -> String {
    match m {
        MuxedAccount::Ed25519(k) => address(&k.0),
        MuxedAccount::MuxedEd25519(m) => address(&m.ed25519.0),
    }
}

fn code_str(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string()
}

fn asset_key(asset: &Asset) -> Option<(String, String)> {
    match asset {
        Asset::Native => None,
        Asset::CreditAlphanum4(a) => Some((code_str(&a.asset_code.0), account_str(&a.issuer))),
        Asset::CreditAlphanum12(a) => Some((code_str(&a.asset_code.0), account_str(&a.issuer))),
    }
}

pub fn stroops(amount: i64) -> String {
    format!("{}.{:07}", amount / 10_000_000, amount % 10_000_000)
}

impl Net {
    pub fn fund(&mut self, address: &str, xlm: i64) {
        self.accounts.insert(address.to_string(), Account { seq: 1 << 32, xlm, ..Default::default() });
    }

    pub fn balance(&self, address: &str, code: &str, issuer: &str) -> Option<i64> {
        self.accounts.get(address)?.lines.get(&(code.to_string(), issuer.to_string())).map(|l| l.balance)
    }

    pub fn line(&self, address: &str, code: &str, issuer: &str) -> Option<Line> {
        self.accounts.get(address)?.lines.get(&(code.to_string(), issuer.to_string())).cloned()
    }

    /// Verifies signatures, sequence, and applies ops atomically.
    fn apply(&mut self, envelope: &TransactionEnvelope) -> Result<String, (String, Vec<String>)> {
        let bad_auth = || ("tx_bad_auth".to_string(), vec![]);
        let (tx, hash, signatures) = match envelope {
            TransactionEnvelope::Tx(env) => (env.tx.clone(), network_hash(2, &env.tx), env.signatures.to_vec()),
            TransactionEnvelope::TxFeeBump(fb) => {
                let fee_source = muxed_str(&fb.tx.fee_source);
                let outer = network_hash(5, &fb.tx);
                if !signed_by(&fee_source, &outer, &fb.signatures.to_vec()) {
                    return Err(bad_auth());
                }
                let FeeBumpTransactionInnerTx::Tx(inner) = &fb.tx.inner_tx;
                let inner_hash = network_hash(2, &inner.tx);
                self.check_and_apply(&inner.tx, &inner_hash, &inner.signatures.to_vec())?;
                return Ok(hex::encode(outer));
            }
            TransactionEnvelope::TxV0(_) => return Err(("tx_not_supported".into(), vec![])),
        };
        self.check_and_apply(&tx, &hash, &signatures)?;
        Ok(hex::encode(hash))
    }

    fn check_and_apply(&mut self, tx: &Transaction, hash: &[u8; 32], sigs: &[stellar_xdr::DecoratedSignature]) -> Result<(), (String, Vec<String>)> {
        let source = muxed_str(&tx.source_account);
        let mut signers = vec![source.clone()];
        signers.extend(tx.operations.iter().filter_map(|op| op.source_account.as_ref().map(muxed_str)));
        // An op may name an account the same tx creates; its key must still sign.
        if signers.iter().any(|s| !signed_by(s, hash, sigs)) {
            return Err(("tx_bad_auth".into(), vec![]));
        }
        let Some(src) = self.accounts.get(&source) else { return Err(("tx_no_source_account".into(), vec![])) };
        if tx.seq_num.0 != src.seq + 1 {
            return Err(("tx_bad_seq".into(), vec![]));
        }
        let mut next = self.accounts.clone();
        next.get_mut(&source).unwrap().seq += 1;
        let mut codes = Vec::new();
        let mut failed = false;
        for op in tx.operations.iter() {
            let op_source = op.source_account.as_ref().map(muxed_str).unwrap_or_else(|| source.clone());
            let code = if failed { "op_not_attempted".to_string() } else { apply_op(&mut next, &op_source, &op.body) };
            failed |= code != "op_success";
            codes.push(code);
        }
        if failed {
            // The fee and sequence are consumed; the ops are not.
            self.accounts.get_mut(&source).unwrap().seq += 1;
            return Err(("tx_failed".into(), codes));
        }
        self.accounts = next;
        Ok(())
    }
}

/// Independent of the backend's hashing on purpose: sha256(sha256(passphrase)
/// || envelope type || xdr), with ENVELOPE_TYPE_TX = 2, TX_FEE_BUMP = 5.
fn network_hash<T: stellar_xdr::WriteXdr>(envelope_type: u8, body: &T) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(Sha256::digest(PASSPHRASE.as_bytes()));
    h.update([0, 0, 0, envelope_type]);
    h.update(body.to_xdr(Limits::none()).unwrap());
    h.finalize().into()
}

fn signed_by(address: &str, hash: &[u8; 32], sigs: &[stellar_xdr::DecoratedSignature]) -> bool {
    let Ok(public) = decode_public(address) else { return false };
    sigs.iter().any(|s| {
        s.hint.0 == public[28..32]
            && <[u8; 64]>::try_from(s.signature.0.as_slice()).map(|sig| Keypair::verify(&public, hash, &sig)).unwrap_or(false)
    })
}

fn apply_op(accounts: &mut HashMap<String, Account>, source: &str, body: &OperationBody) -> String {
    match body {
        OperationBody::CreateAccount(op) => {
            let dest = account_str(&op.destination);
            if accounts.contains_key(&dest) {
                return "op_already_exists".into();
            }
            accounts.insert(dest, Account { seq: 7 << 32, xlm: op.starting_balance, ..Default::default() });
        }
        OperationBody::SetOptions(op) => {
            let account = accounts.get_mut(source).expect("source exists");
            account.flags |= op.set_flags.unwrap_or(0);
            account.flags &= !op.clear_flags.unwrap_or(0);
        }
        OperationBody::ChangeTrust(op) => {
            let key = match &op.line {
                ChangeTrustAsset::CreditAlphanum4(a) => (code_str(&a.asset_code.0), account_str(&a.issuer)),
                ChangeTrustAsset::CreditAlphanum12(a) => (code_str(&a.asset_code.0), account_str(&a.issuer)),
                _ => return "op_malformed".into(),
            };
            let Some(issuer) = accounts.get(&key.1) else { return "op_no_issuer".into() };
            let authorized = issuer.flags & x::AUTH_REQUIRED_FLAG == 0;
            let Some(account) = accounts.get_mut(source) else { return "op_no_account".into() };
            account.lines.entry(key).or_insert(Line { balance: 0, authorized });
        }
        OperationBody::SetTrustLineFlags(op) => {
            let Some(key) = asset_key(&op.asset) else { return "op_malformed".into() };
            if key.1 != source {
                return "op_malformed".into();
            }
            let Some(line) = accounts.get_mut(&account_str(&op.trustor)).and_then(|a| a.lines.get_mut(&key)) else {
                return "op_no_trust_line".into();
            };
            if op.set_flags & x::TRUSTLINE_AUTHORIZED_FLAG != 0 {
                line.authorized = true;
            }
            if op.clear_flags & x::TRUSTLINE_AUTHORIZED_FLAG != 0 {
                line.authorized = false;
            }
        }
        OperationBody::Payment(op) => {
            let Some(key) = asset_key(&op.asset) else { return "op_malformed".into() };
            if key.1 != source {
                return "op_malformed".into(); // only issuer payments are modelled
            }
            let Some(account) = accounts.get_mut(&muxed_str(&op.destination)) else { return "op_no_destination".into() };
            let Some(line) = account.lines.get_mut(&key) else { return "op_no_trust".into() };
            if !line.authorized {
                return "op_not_authorized".into();
            }
            line.balance += op.amount;
        }
        OperationBody::Clawback(op) => {
            let Some(key) = asset_key(&op.asset) else { return "op_malformed".into() };
            let Some(line) = accounts.get_mut(&muxed_str(&op.from)).and_then(|a| a.lines.get_mut(&key)) else {
                return "op_no_trust".into();
            };
            if line.balance < op.amount {
                return "op_underfunded".into();
            }
            line.balance -= op.amount;
        }
        OperationBody::BeginSponsoringFutureReserves(_) | OperationBody::EndSponsoringFutureReserves => {}
        _ => return "op_not_supported".into(),
    }
    "op_success".into()
}

async fn get_account(State(net): State<FakeNet>, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    let net = net.lock().unwrap();
    let Some(a) = net.accounts.get(&id) else { return (StatusCode::NOT_FOUND, Json(json!({ "status": 404 }))) };
    let mut balances: Vec<Value> = a
        .lines
        .iter()
        .map(|((code, issuer), l)| {
            json!({ "asset_type": if code.len() <= 4 { "credit_alphanum4" } else { "credit_alphanum12" },
                "asset_code": code, "asset_issuer": issuer, "balance": stroops(l.balance), "is_authorized": l.authorized })
        })
        .collect();
    balances.push(json!({ "asset_type": "native", "balance": stroops(a.xlm) }));
    (
        StatusCode::OK,
        Json(json!({
            "sequence": a.seq.to_string(),
            "flags": { "auth_required": a.flags & 1 != 0, "auth_revocable": a.flags & 2 != 0, "auth_clawback_enabled": a.flags & 8 != 0 },
            "balances": balances,
        })),
    )
}

async fn submit(State(net): State<FakeNet>, Form(form): Form<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    let delay = net.lock().unwrap().submit_delay_ms;
    if delay > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    let mut net = net.lock().unwrap();
    net.submissions += 1;
    let Ok(envelope) = TransactionEnvelope::from_xdr_base64(&form["tx"], Limits::none()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "extras": { "result_codes": { "transaction": "tx_malformed" } } })));
    };
    let timeout = (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "title": "Timeout", "status": 504 })));
    if net.mode == SubmitMode::TimeoutWithoutApply {
        return timeout;
    }
    match net.apply(&envelope) {
        Ok(hash) => {
            net.txs.insert(hash.clone(), true);
            if net.mode == SubmitMode::TimeoutAfterApply {
                return timeout;
            }
            (StatusCode::OK, Json(json!({ "hash": hash, "successful": true })))
        }
        Err((tx, ops)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "status": 400, "extras": { "result_codes": { "transaction": tx, "operations": ops } } })),
        ),
    }
}

async fn get_tx(State(net): State<FakeNet>, Path(hash): Path<String>) -> (StatusCode, Json<Value>) {
    match net.lock().unwrap().txs.get(&hash) {
        Some(ok) => (StatusCode::OK, Json(json!({ "hash": hash, "successful": ok }))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "status": 404 }))),
    }
}

async fn payments(State(net): State<FakeNet>, axum::extract::RawQuery(q): axum::extract::RawQuery) -> Json<Value> {
    // First page: every configured record; the cursor page is empty.
    let net = net.lock().unwrap();
    let records = if q.unwrap_or_default().contains("cursor=") { vec![] } else { net.payments.clone() };
    let next = format!("{}/accounts/next/payments?cursor=1", net.base_url);
    Json(json!({ "_embedded": { "records": records }, "_links": { "next": { "href": next } } }))
}

async fn sdp_create(State(net): State<FakeNet>, Json(body): Json<Value>) -> Json<Value> {
    let mut net = net.lock().unwrap();
    net.sdp_creates.push(body.clone());
    Json(json!({ "id": format!("disb-{}", net.sdp_creates.len()), "name": body["name"] }))
}

pub struct Fake {
    pub net: FakeNet,
    pub url: String,
}

pub async fn spawn_fake() -> Fake {
    let net: FakeNet = Arc::new(Mutex::new(Net {
        accounts: HashMap::new(),
        txs: HashMap::new(),
        mode: SubmitMode::Normal,
        submit_delay_ms: 0,
        submissions: 0,
        payments: vec![],
        sdp_creates: vec![],
        base_url: String::new(),
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    net.lock().unwrap().base_url = url.clone();
    let app = Router::new()
        .route("/accounts/{id}", get(get_account))
        .route("/accounts/{id}/payments", get(payments))
        .route("/transactions", post(submit))
        .route("/transactions/{hash}", get(get_tx))
        .route("/disbursements", post(sdp_create))
        .with_state(net.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fake { net, url }
}

pub struct App {
    pub url: String,
    pub http: reqwest::Client,
    pub state: SharedState,
    server: tokio::task::JoinHandle<()>,
}

impl App {
    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        let res = self.http.post(format!("{}{path}", self.url)).json(&body).send().await.unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        let res = self.http.get(format!("{}{path}", self.url)).send().await.unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// Simulates a crash: the server stops; persisted state is all that
    /// survives. Returns once every connection has released the state (and
    /// with it the state-file lock), as process exit would.
    pub async fn stop(self) {
        let state = self.state.clone();
        self.server.abort();
        drop(self);
        for _ in 0..250 {
            if Arc::strong_count(&state) == 1 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("server still holds the state after stop");
    }
}

impl Drop for App {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub const STATE_KEY: &str = "4f3c2b1a00112233445566778899aabbccddeeff0123456789abcdef01234567";

pub struct Env {
    pub fake: Fake,
    pub channel: Keypair,
    pub collection: Keypair,
    pub usdc_issuer: Keypair,
    pub state_path: Option<std::path::PathBuf>,
}

impl Env {
    pub async fn new(persistent: bool) -> Self {
        let fake = spawn_fake().await;
        let channel = Keypair::random();
        let collection = Keypair::random();
        let usdc_issuer = Keypair::random();
        {
            let mut net = fake.net.lock().unwrap();
            net.fund(&channel.public_str(), 10_000 * 10_000_000);
            net.fund(&collection.public_str(), 10 * 10_000_000);
            net.fund(&usdc_issuer.public_str(), 10 * 10_000_000);
        }
        let state_path = persistent
            .then(|| std::env::temp_dir().join(format!("uf-it-{}", rand::random::<u64>())).join("state.json"));
        Self { fake, channel, collection, usdc_issuer, state_path }
    }

    pub fn config(&self) -> Config {
        Config {
            horizon_url: self.fake.url.clone(),
            network_passphrase: PASSPHRASE.into(),
            home_domain: "urbanflip.io".into(),
            channel_secret: Some(self.channel.secret_str()),
            collection_address: self.collection.public_str(),
            usdc_code: USDC_CODE.into(),
            usdc_issuer: self.usdc_issuer.public_str(),
            spv_iban: "ES9121000418450200051332".into(),
            bind: "127.0.0.1:0".into(),
            audit_path: None,
            state_path: self.state_path.as_ref().map(|p| p.display().to_string()),
            state_key: Some(STATE_KEY.into()),
            gate_provider: "static".into(),
            gate_url: None,
            gate_token: None,
            static_gate_allow: vec![("inv-a".into(), "*".into()), ("inv-b".into(), "*".into())],
            sdp_base_url: Some(self.fake.url.clone()),
            sdp_token: Some("test-token".into()),
        }
    }

    pub async fn start(&self) -> App {
        start_with(self.config()).await
    }

    pub fn net(&self) -> std::sync::MutexGuard<'_, Net> {
        self.fake.net.lock().unwrap()
    }
}

pub async fn start_with(config: Config) -> App {
    let state = try_build_state(config).expect("state");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = urbanflip_backend::api::routes::router(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    App { url, http: reqwest::Client::new(), state, server }
}

/// A Horizon payment record (with joined transaction) as the payments endpoint returns it.
pub fn payment_record(to: &str, code: &str, issuer: &str, amount: &str, memo: &str, hash: &str) -> Value {
    json!({
        "type": "payment", "to": to, "from": address(&Keypair::random().public_bytes()), "amount": amount,
        "asset_type": "credit_alphanum4", "asset_code": code, "asset_issuer": issuer,
        "transaction_hash": hash, "transaction_successful": true,
        "transaction": { "memo_type": "text", "memo": memo },
    })
}
