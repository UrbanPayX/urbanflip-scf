//! End-to-end rehearsal against the real Stellar testnet. Ignored by default
//! (needs the network; takes ~1 min). Run with:
//!
//!   cargo test --test testnet -- --ignored --nocapture
//!
//! Funds a fresh channel via friendbot, then drives the D1/D2 lifecycle
//! through the HTTP API and checks every effect on Horizon. Prints
//! stellar.expert links for each transaction.

mod support;

use serde_json::{json, Value};
use support::{start_with, App, PASSPHRASE};
use urbanflip_backend::api::state::Config;
use urbanflip_backend::stellar::keys::Keypair;

const HORIZON: &str = "https://horizon-testnet.stellar.org";

fn explorer(hash: &Value) -> String {
    format!("https://stellar.expert/explorer/testnet/tx/{}", hash.as_str().unwrap_or("-"))
}

async fn ok(app: &App, path: &str, body: Value) -> Value {
    let (status, response) = app.post(path, body).await;
    assert!((200..300).contains(&status), "{path} -> {status}: {response}");
    response
}

async fn horizon_account(address: &str) -> Value {
    reqwest::get(format!("{HORIZON}/accounts/{address}")).await.unwrap().json().await.unwrap()
}

fn line<'a>(account: &'a Value, code: &str, issuer: &str) -> Option<&'a Value> {
    account["balances"].as_array()?.iter().find(|b| b["asset_code"] == code && b["asset_issuer"] == issuer)
}

#[tokio::test]
#[ignore = "hits Stellar testnet; run with --ignored"]
async fn testnet_lifecycle() {
    let channel = Keypair::random();
    let funded = reqwest::get(format!("https://friendbot.stellar.org/?addr={}", channel.public_str())).await.unwrap();
    assert!(funded.status().is_success(), "friendbot: {}", funded.text().await.unwrap_or_default());
    println!("channel: {}", channel.public_str());

    let run = rand::random::<u16>();
    let (deal, code) = (format!("E2E-{run}"), format!("UFE2E{run}"));
    let (good, bad) = (format!("e2e-ok-{run}"), format!("e2e-no-{run}"));
    let state_dir = std::env::temp_dir().join(format!("uf-testnet-{run}"));
    let config = Config {
        horizon_url: HORIZON.into(),
        network_passphrase: PASSPHRASE.into(),
        home_domain: "urbanflip.io".into(),
        channel_secret: Some(channel.secret_str()),
        collection_address: String::new(),
        usdc_code: "USDC".into(),
        usdc_issuer: String::new(),
        spv_iban: "ES9121000418450200051332".into(),
        bind: "127.0.0.1:0".into(),
        audit_path: None,
        state_path: Some(state_dir.join("state.json").display().to_string()),
        state_key: Some(support::STATE_KEY.into()),
        gate_provider: "static".into(),
        gate_url: None,
        gate_token: None,
        static_gate_allow: vec![(good.clone(), "*".into())],
        sdp_base_url: None,
        sdp_token: None,
        api_tokens: support::test_api_tokens(),
        allow_unauthenticated: false,
        session_ttl_secs: 900,
        widget_dir: None,
        widget_frame_ancestors: vec![],
    };
    let app = start_with(config.clone()).await;

    let issued = ok(&app, &format!("/v1/deals/{deal}/provision-issuer"), json!({ "asset_code": code })).await;
    let issuer = issued["issuer"].as_str().unwrap().to_string();
    println!("issuer provisioned:   {}", explorer(&issued["txHash"]));
    let flags = &horizon_account(&issuer).await["flags"];
    assert_eq!((flags["auth_required"].as_bool(), flags["auth_revocable"].as_bool(), flags["auth_clawback_enabled"].as_bool()), (Some(true), Some(true), Some(true)));

    let onboarded = ok(&app, &format!("/v1/investors/{good}/onboard"), json!({ "deal_id": deal })).await;
    let address = onboarded["stellarAddress"].as_str().unwrap().to_string();
    println!("sponsored account:    {}", explorer(&onboarded["accountCreationTxHash"]));
    println!("sponsored trustline:  {}", explorer(&onboarded["trustlineTxHash"]));
    let account = horizon_account(&address).await;
    let native = account["balances"].as_array().unwrap().iter().find(|b| b["asset_type"] == "native").unwrap();
    assert_eq!(native["balance"], "0.0000000", "investor holds zero XLM");
    assert_eq!(account["sponsor"], channel.public_str().as_str());
    ok(&app, &format!("/v1/investors/{bad}/onboard"), json!({ "deal_id": deal })).await;

    let authorized = ok(&app, &format!("/v1/deals/{deal}/authorize/{good}"), json!({})).await;
    println!("trustline authorized: {}", explorer(&authorized["txHash"]));
    let (status, _) = app.post(&format!("/v1/deals/{deal}/authorize/{bad}"), json!({})).await;
    assert_eq!(status, 403, "gate refuses the non-allowlisted investor");

    ok(&app, "/v1/subscriptions/fiat", json!({ "deal_id": deal, "investor_id": good, "subscription_ref": "e2e-1", "amount": "1250.50", "bank_ref": "TRF-E2E" })).await;
    ok(&app, "/v1/subscriptions/fiat", json!({ "deal_id": deal, "investor_id": bad, "subscription_ref": "e2e-2", "amount": "100", "bank_ref": "TRF-E2E-2" })).await;
    let settled = ok(&app, "/v1/subscriptions/e2e-1/settle", json!({})).await;
    println!("units issued:         {}", explorer(&settled["settlement"]["tx_hash"]));
    assert_eq!(line(&horizon_account(&address).await, &code, &issuer).unwrap()["balance"], "1250.5000000");
    let (status, _) = app.post("/v1/subscriptions/e2e-2/settle", json!({})).await;
    assert_eq!(status, 409, "unauthorized trustline blocks issuance");

    // Restart from the sealed state file: same issuer, no second mint.
    app.stop().await;
    let app = start_with(config).await;
    let again = ok(&app, "/v1/subscriptions/e2e-1/settle", json!({})).await;
    assert_eq!(again["idempotent"], true);
    assert_eq!(line(&horizon_account(&address).await, &code, &issuer).unwrap()["balance"], "1250.5000000");

    let frozen = ok(&app, &format!("/v1/deals/{deal}/freeze/{good}"), json!({})).await;
    println!("trustline frozen:     {}", explorer(&frozen["txHash"]));
    assert_eq!(line(&horizon_account(&address).await, &code, &issuer).unwrap()["is_authorized"], false);
    let clawed = ok(&app, &format!("/v1/deals/{deal}/clawback/{good}"), json!({})).await;
    println!("clawed back:          {}", explorer(&clawed["txHash"]));
    assert_eq!(line(&horizon_account(&address).await, &code, &issuer).unwrap()["balance"], "0.0000000");

    let _ = std::fs::remove_dir_all(state_dir);
}
