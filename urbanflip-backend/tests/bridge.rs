//! Bridge wired into the off-ramp and payout funding, against a strict fake
//! Bridge (documented paths, Api-Key, Idempotency-Key replay rules) that runs
//! next to the fake Horizon and, like Bridge, watches the chain for deposits.

mod support;

use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use support::*;

const SPV_ACCOUNT: &str = r#"{ "iban": "ES9121000418450200051332", "bic": "CAIXESBBXXX", "country": "ESP",
    "account_owner_name": "UF Madrid 1 SPV SL",
    "address": { "street_line_1": "Calle de Velazquez 87", "city": "Madrid", "postal_code": "28006", "country": "ESP" } }"#;

fn spv() -> Value {
    serde_json::from_str(SPV_ACCOUNT).unwrap()
}

/// Issuer, two authorized investors, and one reconciled crypto subscription
/// (EUR 1,000 committed, USDC 1,085 paid) batched for off-ramp.
async fn reconciled_batch(env: &Env, app: &App) {
    let (status, body) = app.post("/v1/deals/MADRID/provision-issuer", json!({ "asset_code": "UFMADRID1" })).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(app.post("/v1/investors/inv-a/onboard", json!({ "deal_id": "MADRID" })).await.0, 200);
    assert_eq!(app.post("/v1/deals/MADRID/authorize/inv-a", json!({})).await.0, 200);
    let (_, expected) = app
        .post("/v1/subscriptions/crypto/expect", json!({ "deal_id": "MADRID", "investor_id": "inv-a", "subscription_ref": "c-a", "eur_amount": "1000", "usdc_amount": "1085" }))
        .await;
    let memo = expected["expected"]["memo"].as_str().unwrap().to_string();
    let record = payment_record(&env.collection.public_str(), USDC_CODE, &env.usdc_issuer.public_str(), "1085.0000000", &memo, "h1");
    env.net().payments = vec![record];
    let (_, r) = app.post("/v1/subscriptions/crypto/reconcile", json!({})).await;
    assert_eq!(r["reconciled"][0]["state"], "RECONCILED", "{r}");
    let (status, batch) = app.post("/v1/deals/MADRID/offramp/build", json!({})).await;
    assert_eq!(status, 200, "{batch}");
}

#[tokio::test]
async fn sandbox_offramp_completes_from_the_bridge_drain() {
    let env = Env::new(false).await;
    let app = env.start().await;
    reconciled_batch(&env, &app).await;

    let (status, route) = app.post("/v1/deals/MADRID/offramp/bridge-route", spv()).await;
    assert_eq!(status, 200, "{route}");
    let (_, again) = app.post("/v1/deals/MADRID/offramp/bridge-route", spv()).await;
    assert_eq!(again["idempotent"], true);
    let mut other = spv();
    other["iban"] = json!("ES7921000813610123456789");
    assert_eq!(app.post("/v1/deals/MADRID/offramp/bridge-route", other).await.0, 409, "one SPV IBAN per deal");

    let (status, sent) = app.post("/v1/deals/MADRID/offramp/send", json!({})).await;
    assert_eq!(status, 200, "{sent}");
    let creations = env.net().bridge.creations;
    let (_, repeat) = app.post("/v1/deals/MADRID/offramp/send", json!({})).await;
    assert_eq!(repeat["idempotent"], true);
    assert_eq!(env.net().bridge.creations, creations, "sent once");
    assert_eq!(app.post("/v1/deals/MADRID/offramp/build", json!({})).await.0, 409, "a sent batch can't be rebuilt");

    let (status, waiting) = app.post("/v1/deals/MADRID/offramp/sync", json!({})).await;
    assert_eq!((status, waiting["status"].as_str()), (202, Some("in_progress")), "{waiting}");

    // Bridge pays EUR 998 to the SPV: EUR 2 short of the commitment.
    let drain = env.net().bridge.last_drain_id();
    env.net().bridge.process_drain(&drain, "998.00");
    let (status, synced) = app.post("/v1/deals/MADRID/offramp/sync", json!({})).await;
    assert_eq!(status, 200, "{synced}");
    assert_eq!((synced["instruction"]["status"].as_str(), synced["shortfallEur"].as_str()), (Some("AWAITING_TOP_UP"), Some("2.0000000")));
    assert_eq!(app.post("/v1/subscriptions/c-a/settle", json!({})).await.0, 412, "nothing mints before the top-up");
    let (_, covered) = app.post("/v1/deals/MADRID/offramp/top-up", json!({ "bank_ref": "TOPUP-1", "eur_amount": "2.00" })).await;
    assert_eq!(covered["instruction"]["status"], "EXECUTED", "{covered}");
    let (status, settled) = app.post("/v1/subscriptions/c-a/settle", json!({})).await;
    assert_eq!((status, settled["settlement"]["units"].as_str()), (200, Some("1000.0000000")), "{settled}");
    assert!(settled["settlement"]["bank_ref"].as_str().unwrap().contains(&drain), "the drain is the EUR evidence");
}

#[tokio::test]
async fn live_offramp_sends_the_usdc_on_stellar_exactly_once() {
    let env = Env::new(false).await;
    let mut config = env.config();
    config.bridge_sandbox = false;
    config.collection_secret = Some(env.collection.secret_str());
    let app = start_with(config).await;
    reconciled_batch(&env, &app).await;
    let usdc = (USDC_CODE.to_string(), env.usdc_issuer.public_str());
    env.net().accounts.get_mut(&env.collection.public_str()).unwrap().lines.insert(usdc.clone(), Line { balance: 10_850_000_000, authorized: true });

    let (_, route) = app.post("/v1/deals/MADRID/offramp/bridge-route", spv()).await;
    let bridge_address = route["route"]["liquidation"]["address"].as_str().unwrap().to_string();
    env.net().accounts.get_mut(&bridge_address).unwrap().lines.insert(usdc.clone(), Line { balance: 0, authorized: true });

    // The deposit lands but the response is lost: the retry resolves it by hash.
    env.net().mode = SubmitMode::TimeoutAfterApply;
    let (status, body) = app.post("/v1/deals/MADRID/offramp/send", json!({})).await;
    assert_eq!(status, 502, "{body}");
    env.net().mode = SubmitMode::Normal;
    let submissions = env.net().submissions;
    let (status, sent) = app.post("/v1/deals/MADRID/offramp/send", json!({})).await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(env.net().submissions, submissions, "not resubmitted");
    assert_eq!(env.net().balance(&env.collection.public_str(), &usdc.0, &usdc.1), Some(0), "1,085 USDC left once");
    assert_eq!(env.net().balance(&bridge_address, &usdc.0, &usdc.1), Some(10_850_000_000));
    let deposit = sent["send"]["deposit_tx_hash"].as_str().unwrap().to_string();

    // Bridge saw the deposit on chain (by its tx hash) and pays EUR 1,001.50.
    let drain = env.net().bridge.drains.iter().find(|d| d["deposit_tx_hash"] == deposit.as_str()).expect("drain for our deposit")["id"]
        .as_str()
        .unwrap()
        .to_string();
    env.net().bridge.process_drain(&drain, "1001.50");
    let (_, synced) = app.post("/v1/deals/MADRID/offramp/sync", json!({})).await;
    assert_eq!((synced["instruction"]["status"].as_str(), synced["instruction"]["fx_result_eur"].as_str()), (Some("EXECUTED"), Some("1.5000000")), "{synced}");
    assert_eq!(app.post("/v1/subscriptions/c-a/settle", json!({})).await.0, 200);
}

#[tokio::test]
async fn bridge_funding_is_the_amount_the_sdp_batch_pays() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let wallet = address(&urbanflip_backend::stellar::keys::Keypair::random().public_bytes());
    let (status, body) = app
        .post("/v1/deals/MADRID/ledger", json!({ "positions": [{ "investor_id": "inv-a", "email": "a@example.com", "wallet_address": wallet, "principal": "30000.00" }] }))
        .await;
    assert_eq!(status, 201, "{body}");
    let profile = json!({ "email": "a@example.com", "subscription_rail": "USDC_ONCHAIN", "payout_rail": "USDC_ONCHAIN", "stellar_address": wallet, "screening_ref": "ms-1" });
    assert_eq!(app.post("/v1/investors/inv-a/profile", profile).await.0, 201);
    let outcome = json!({ "outcome": { "principal_repayment": "30000.00", "performance_interest": "6000.00" } });
    assert_eq!(app.post("/v1/deals/MADRID/distributions", outcome).await.0, 200);
    assert_eq!(app.post("/v1/deals/MADRID/sdp/disburse", json!({})).await.0, 422, "no funding confirmed yet");

    let (status, account) = app.post("/v1/deals/MADRID/funding/bridge-account", json!({})).await;
    assert_eq!(status, 200, "{account}");
    let instructions = &account["funding_account"]["account"];
    assert!(instructions["iban"].is_string() && instructions["bic"].is_string(), "{account}");
    assert_eq!(account["funding_account"]["destination"], env.distribution.public_str().as_str());
    assert_eq!(app.post("/v1/deals/MADRID/funding/bridge-account", json!({})).await.1["idempotent"], true);

    // Treasury wires EUR 36,000; Bridge delivers USDC 39,060 on Stellar.
    let (status, _) = app.post("/v1/deals/MADRID/funding/simulate-deposit", json!({ "amount": "36000.00", "reference": "wire-1" })).await;
    assert_eq!(status, 200);
    let (_, synced) = app.post("/v1/deals/MADRID/funding/sync", json!({})).await;
    assert_eq!((synced["funding"]["eur_deposited"].as_str(), synced["funding"]["usdc_received"].as_str()), (Some("36000.0000000"), Some("39060.0000000")), "{synced}");

    assert_eq!(app.post("/v1/deals/MADRID/sdp/disburse", json!({ "usdc_funded": "39100.00" })).await.0, 422, "typed figure must match Bridge");
    let (status, disbursed) = app.post("/v1/deals/MADRID/sdp/disburse", json!({})).await;
    assert_eq!(status, 200, "{disbursed}");
    assert_eq!(disbursed["usdcConversion"]["usdc_total"], "39060.00");
    let csv = env.net().sdp_creates[0]["file_content"].as_str().unwrap().to_string();
    assert!(csv.contains(&format!("39060.00,a@example.com,{wallet},,")), "{csv}");
}

fn signed_event(event: &Value, at_ms: u64) -> (String, String) {
    let body = event.to_string();
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(include_str!("fixtures/webhook-test-key.pem")).unwrap();
    let digest = Sha256::digest(format!("{at_ms}.{body}").as_bytes());
    let sig = SigningKey::<Sha256>::new(key).sign(&digest);
    (body, format!("t={at_ms},v0={}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sig.to_bytes())))
}

async fn deliver(app: &App, body: String, signature: &str) -> (u16, Value) {
    let res = app
        .http
        .post(format!("{}/v1/webhooks/bridge", app.url))
        .header("content-type", "application/json")
        .header("x-webhook-signature", signature)
        .body(body)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn a_verified_bridge_webhook_triggers_the_sync() {
    let env = Env::new(false).await;
    let app = env.start().await;
    reconciled_batch(&env, &app).await;
    let (_, route) = app.post("/v1/deals/MADRID/offramp/bridge-route", spv()).await;
    assert_eq!(app.post("/v1/deals/MADRID/offramp/send", json!({})).await.0, 200);
    let drain = env.net().bridge.last_drain_id();
    env.net().bridge.process_drain(&drain, "1000.00");

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let event = json!({ "api_version": "v0", "event_id": "wh_1", "event_category": "liquidation_address.drain",
        "event_type": "liquidation_address.drain.updated.status_transitioned", "event_object_id": drain,
        "event_object": { "id": drain, "liquidation_address_id": route["route"]["liquidation"]["id"], "state": "payment_processed" } });

    let (body, signature) = signed_event(&event, now);
    let (status, _) = deliver(&app, body.replace("wh_1", "wh_X"), &signature).await;
    assert_eq!(status, 401, "a body that isn't what Bridge signed");
    let (old_body, old_signature) = signed_event(&event, now - 11 * 60 * 1000);
    assert_eq!(deliver(&app, old_body, &old_signature).await.0, 400, "stale: Bridge retries with a fresh timestamp");

    let (status, result) = deliver(&app, body.clone(), &signature).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["result"]["instruction"]["status"], "EXECUTED", "{result}");
    let (_, again) = deliver(&app, body, &signature).await;
    assert_eq!(again["duplicate"], true, "redelivery is a no-op");
    assert_eq!(app.post("/v1/subscriptions/c-a/settle", json!({})).await.0, 200);
}

#[tokio::test]
async fn without_bridge_credentials_the_ramp_routes_say_so() {
    let env = Env::new(false).await;
    let mut config = env.config();
    config.bridge_api_key = None;
    let app = start_with(config).await;
    let (status, body) = app.post("/v1/deals/MADRID/offramp/bridge-route", spv()).await;
    assert_eq!(status, 501, "{body}");
    assert!(body["error"].as_str().unwrap().contains("BRIDGE_API_KEY"));
    assert_eq!(app.post_as(Some(OPS_TOKEN), "/v1/deals/MADRID/funding/bridge-account", json!({})).await.0, 403, "treasury's job");
}
