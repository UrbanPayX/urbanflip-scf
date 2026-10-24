//! HTTP-level tests against a strict fake Horizon (see support/mod.rs).
//! Each test runs its own fake network and backend on random ports.

mod support;

use serde_json::{json, Value};
use support::*;
use urbanflip_backend::stellar::keys::Keypair;

async fn provision(app: &App, deal: &str, code: &str) -> String {
    let (status, body) = app.post(&format!("/v1/deals/{deal}/provision-issuer"), json!({ "asset_code": code })).await;
    assert_eq!(status, 200, "{body}");
    body["issuer"].as_str().unwrap().to_string()
}

async fn onboard(app: &App, investor: &str, deal: &str) -> Value {
    let (status, body) = app.post(&format!("/v1/investors/{investor}/onboard"), json!({ "deal_id": deal })).await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn fiat(app: &App, deal: &str, investor: &str, sub: &str, amount: &str) -> (u16, Value) {
    app.post(
        "/v1/subscriptions/fiat",
        json!({ "deal_id": deal, "investor_id": investor, "subscription_ref": sub, "amount": amount, "bank_ref": format!("TRF-{sub}") }),
    )
    .await
}

/// Issuer + one authorized, onboarded investor with a recorded fiat subscription.
async fn ready_to_settle(env: &Env, app: &App, sub: &str) -> (String, String) {
    let issuer = provision(app, "MADRID", "UFMADRID1").await;
    let address = onboard(app, "inv-a", "MADRID").await["stellarAddress"].as_str().unwrap().to_string();
    let (status, body) = app.post("/v1/deals/MADRID/authorize/inv-a", json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(fiat(app, "MADRID", "inv-a", sub, "2500.50").await.0, 201);
    let _ = env;
    (issuer, address)
}

fn audit_kinds(events: &Value) -> Vec<String> {
    events["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn full_lifecycle_issue_freeze_clawback() {
    let env = Env::new(false).await;
    let app = env.start().await;

    let issuer = provision(&app, "MADRID", "UFMADRID1").await;
    assert_eq!(env.net().accounts[&issuer].flags, 0b1011, "AUTH_REQUIRED | REVOCABLE | CLAWBACK_ENABLED");
    let (_, again) = app.post("/v1/deals/MADRID/provision-issuer", json!({})).await;
    assert_eq!((again["issuer"].as_str(), again["idempotent"].as_bool()), (Some(issuer.as_str()), Some(true)));

    let first = onboard(&app, "inv-a", "MADRID").await;
    let address = first["stellarAddress"].as_str().unwrap().to_string();
    assert!(first["accountCreationTxHash"].is_string() && first["trustlineTxHash"].is_string());
    assert_eq!(env.net().accounts[&address].xlm, 0, "investor holds zero XLM");
    let repeat = onboard(&app, "inv-a", "MADRID").await;
    assert!(repeat["accountCreationTxHash"].is_null() && repeat["trustlineTxHash"].is_null(), "{repeat}");

    // Gate: allowlisted investor authorized, unknown investor refused; both logged.
    onboard(&app, "inv-z", "MADRID").await;
    assert_eq!(app.post("/v1/deals/MADRID/authorize/inv-a", json!({})).await.0, 200);
    let (status, refused) = app.post("/v1/deals/MADRID/authorize/inv-z", json!({})).await;
    assert_eq!(status, 403, "{refused}");
    let (_, audit) = app.get("/v1/audit").await;
    let decisions: Vec<&str> = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "GATE_DECISION")
        .map(|e| e["decision"]["status"].as_str().unwrap())
        .collect();
    assert_eq!(decisions, vec!["REJECTED", "APPROVED"]);

    // Issuance on settled money, exactly once.
    assert_eq!(fiat(&app, "MADRID", "inv-a", "s-1", "2500.50").await.0, 201);
    let (status, settled) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(status, 200, "{settled}");
    assert_eq!(settled["settlement"]["units"], "2500.5000000");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(25_005_000_000));
    let submissions = env.net().submissions;
    let (_, replay) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(replay["idempotent"], true);
    assert_eq!(env.net().submissions, submissions, "an idempotent settle submits nothing");

    // The unauthorized investor's trustline blocks issuance pre-flight.
    assert_eq!(fiat(&app, "MADRID", "inv-z", "s-z", "100").await.0, 201);
    let (status, body) = app.post("/v1/subscriptions/s-z/settle", json!({})).await;
    assert_eq!(status, 409, "{body}");

    // Offboarding: freeze, then claw back the whole balance.
    assert_eq!(app.post("/v1/deals/MADRID/freeze/inv-a", json!({})).await.0, 200);
    assert!(!env.net().line(&address, "UFMADRID1", &issuer).unwrap().authorized);
    let (status, clawed) = app.post("/v1/deals/MADRID/clawback/inv-a", json!({})).await;
    assert_eq!(status, 200, "{clawed}");
    assert_eq!(clawed["clawedBack"], "2500.5000000");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(0));
    assert_eq!(app.post("/v1/deals/MADRID/clawback/inv-a", json!({})).await.0, 409, "nothing left");
    let (status, _) = app.post("/v1/deals/MADRID/clawback/inv-a", json!({ "investor_address": issuer })).await;
    assert_eq!(status, 422, "address cross-check");
}

#[tokio::test]
async fn second_deal_reuses_the_account_and_settles_the_right_asset() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let madrid = provision(&app, "MADRID", "UFMADRID1").await;
    let sevilla = provision(&app, "SEVILLA", "UFSEV2").await;
    let address = onboard(&app, "inv-a", "MADRID").await["stellarAddress"].as_str().unwrap().to_string();
    let second = onboard(&app, "inv-a", "SEVILLA").await;
    assert_eq!(second["stellarAddress"], address.as_str());
    assert!(second["accountCreationTxHash"].is_null() && second["trustlineTxHash"].is_string());
    for deal in ["MADRID", "SEVILLA"] {
        assert_eq!(app.post(&format!("/v1/deals/{deal}/authorize/inv-a"), json!({})).await.0, 200);
    }
    assert_eq!(fiat(&app, "SEVILLA", "inv-a", "s-sev", "700").await.0, 201);
    assert_eq!(app.post("/v1/subscriptions/s-sev/settle", json!({})).await.0, 200);
    assert_eq!(env.net().balance(&address, "UFSEV2", &sevilla), Some(7_000_000_000));
    assert_eq!(env.net().balance(&address, "UFMADRID1", &madrid), Some(0));

    let (_, view) = app.get("/v1/deals/MADRID/eligibility").await;
    assert_eq!(view["eligibility"], json!([]), "MADRID's view excludes SEVILLA's settlement");
}

#[tokio::test]
async fn settle_timeout_that_landed_resolves_by_hash_without_a_second_mint() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let (issuer, address) = ready_to_settle(&env, &app, "s-1").await;

    env.net().mode = SubmitMode::TimeoutAfterApply;
    let (status, body) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(status, 502, "{body}");
    assert!(body["error"].as_str().unwrap().contains("outcome unknown"));

    env.net().mode = SubmitMode::Normal;
    let submissions = env.net().submissions;
    let (status, body) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(env.net().submissions, submissions, "resolved by hash, not resubmitted");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(25_005_000_000), "minted exactly once");
    let (_, audit) = app.get("/v1/audit").await;
    let settled = audit["events"].as_array().unwrap().iter().find(|e| e["kind"] == "SUBSCRIPTION_SETTLED").unwrap();
    assert_eq!(settled["resolvedByHash"], true);
}

#[tokio::test]
async fn settle_timeout_that_never_landed_waits_out_max_time_then_issues_once() {
    let env = Env::new(true).await;
    let app = env.start().await;
    let (issuer, address) = ready_to_settle(&env, &app, "s-1").await;

    env.net().mode = SubmitMode::TimeoutWithoutApply;
    assert_eq!(app.post("/v1/subscriptions/s-1/settle", json!({})).await.0, 502);
    env.net().mode = SubmitMode::Normal;
    let (status, body) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(status, 409, "the lost tx may still land before max_time: {body}");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(0));

    // Crash, and come back after the pending tx's max_time has passed.
    app.stop().await;
    let path = env.state_path.clone().unwrap();
    let mut state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    state["pending_settlements"]["s-1"]["max_time"] = json!(0);
    std::fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let app = env.start().await;

    let (status, body) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(25_005_000_000), "minted exactly once");
}

#[tokio::test]
async fn clawback_with_a_ref_is_never_applied_twice() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let (issuer, address) = ready_to_settle(&env, &app, "s-1").await;
    assert_eq!(app.post("/v1/subscriptions/s-1/settle", json!({})).await.0, 200);
    let balance = || env.net().balance(&address, "UFMADRID1", &issuer);
    let claw = |body: Value| app.post("/v1/deals/MADRID/clawback/inv-a", body);

    let (status, body) = claw(json!({ "amount": "100" })).await;
    assert_eq!(status, 422, "an explicit amount needs a ref: {body}");

    // The tx lands but the response is lost; the retry resolves it by hash.
    env.net().mode = SubmitMode::TimeoutAfterApply;
    assert_eq!(claw(json!({ "amount": "100", "clawback_ref": "cb-1" })).await.0, 502);
    env.net().mode = SubmitMode::Normal;
    let submissions = env.net().submissions;
    let (status, body) = claw(json!({ "amount": "100", "clawback_ref": "cb-1" })).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(env.net().submissions, submissions, "resolved by hash, not resubmitted");
    assert_eq!(balance(), Some(24_005_000_000), "clawed back exactly once");
    let (_, again) = claw(json!({ "amount": "100", "clawback_ref": "cb-1" })).await;
    assert_eq!((again["idempotent"].as_bool(), again["clawedBack"].as_str()), (Some(true), Some("100.0000000")));
    assert_eq!(claw(json!({ "amount": "250", "clawback_ref": "cb-1" })).await.0, 409, "a ref names one clawback");
    let (_, audit) = app.get("/v1/audit").await;
    let event = audit["events"].as_array().unwrap().iter().find(|e| e["kind"] == "CLAWBACK").unwrap();
    assert_eq!((event["clawbackRef"].as_str(), event["resolvedByHash"].as_bool()), (Some("cb-1"), Some(true)));

    // The tx is lost: no retry while it could still land, one clawback after.
    env.net().mode = SubmitMode::TimeoutWithoutApply;
    assert_eq!(claw(json!({ "amount": "50", "clawback_ref": "cb-2" })).await.0, 502);
    env.net().mode = SubmitMode::Normal;
    assert_eq!(claw(json!({ "amount": "50", "clawback_ref": "cb-2" })).await.0, 409);
    app.state.clawbacks.write().await.get_mut("cb-2").unwrap().max_time = 0;
    assert_eq!(claw(json!({ "amount": "50", "clawback_ref": "cb-2" })).await.0, 200);
    assert_eq!(balance(), Some(23_505_000_000));
}

#[tokio::test]
async fn concurrent_settles_mint_once() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let (issuer, address) = ready_to_settle(&env, &app, "s-1").await;

    env.net().submit_delay_ms = 300;
    let (a, b) = tokio::join!(
        app.post("/v1/subscriptions/s-1/settle", json!({})),
        app.post("/v1/subscriptions/s-1/settle", json!({}))
    );
    let mut statuses = [a.0, b.0];
    statuses.sort();
    assert_eq!(statuses, [200, 409], "{a:?} {b:?}");
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(25_005_000_000));
}

#[tokio::test]
async fn state_survives_restart_with_secrets_sealed() {
    let env = Env::new(true).await;
    let app = env.start().await;
    let (issuer, address) = ready_to_settle(&env, &app, "s-1").await;
    assert_eq!(app.post("/v1/subscriptions/s-1/settle", json!({})).await.0, 200);
    let issuer_secret = app.state.issuers.read().await["MADRID"].issuer_secret.clone();
    let wallet_secrets: Vec<String> = app.state.wallets.read().await.export_secrets().into_iter().map(|(_, s)| s).collect();
    app.stop().await;

    let raw = std::fs::read_to_string(env.state_path.as_ref().unwrap()).unwrap();
    assert!(!raw.contains(&issuer_secret), "issuer secret must be sealed on disk");
    assert!(wallet_secrets.iter().all(|s| !raw.contains(s.as_str())), "wallet secrets must be sealed on disk");
    assert!(raw.contains("\"sealed_secret\": \"v1:"));

    let app = env.start().await;
    let (_, again) = app.post("/v1/deals/MADRID/provision-issuer", json!({})).await;
    assert_eq!((again["issuer"].as_str(), again["idempotent"].as_bool()), (Some(issuer.as_str()), Some(true)));
    let same = onboard(&app, "inv-a", "MADRID").await;
    assert_eq!(same["stellarAddress"], address.as_str());
    let (_, replay) = app.post("/v1/subscriptions/s-1/settle", json!({})).await;
    assert_eq!(replay["idempotent"], true, "no second mint after restart");
    // The restored issuer key still signs.
    assert_eq!(fiat(&app, "MADRID", "inv-a", "s-2", "10").await.0, 201);
    assert_eq!(app.post("/v1/subscriptions/s-2/settle", json!({})).await.0, 200);
    assert_eq!(env.net().balance(&address, "UFMADRID1", &issuer), Some(25_105_000_000));
    app.stop().await;

    // A wrong key refuses to start instead of discarding the state.
    let mut config = env.config();
    config.state_key = Some("11".repeat(32));
    let refused = urbanflip_backend::api::state::try_build_state(config).err().expect("must refuse");
    assert!(refused.contains("cannot unseal"), "{refused}");
    let mut config = env.config();
    config.state_key = None;
    assert!(urbanflip_backend::api::state::try_build_state(config).is_err(), "STATE_PATH without STATE_KEY");
}

#[tokio::test]
async fn provisioning_timeout_adopts_the_issuer_that_landed() {
    let env = Env::new(false).await;
    let app = env.start().await;

    env.net().mode = SubmitMode::TimeoutAfterApply;
    let (status, body) = app.post("/v1/deals/MADRID/provision-issuer", json!({ "asset_code": "UFMADRID1" })).await;
    assert_eq!(status, 502, "{body}");
    let (status, _) = app.post("/v1/investors/inv-a/onboard", json!({ "deal_id": "MADRID" })).await;
    assert_eq!(status, 409, "an unconfirmed issuer is not usable");

    env.net().mode = SubmitMode::Normal;
    let pending = app.state.issuers.read().await["MADRID"].issuer_public.clone();
    let (status, body) = app.post("/v1/deals/MADRID/provision-issuer", json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["issuer"], pending.as_str(), "the same key, adopted");
    let issuers = env.net().accounts.values().filter(|a| a.flags == 0b1011).count();
    assert_eq!(issuers, 1, "no second issuer account");
    let (_, audit) = app.get("/v1/audit").await;
    assert!(audit_kinds(&audit).contains(&"ISSUER_PROVISIONED".to_string()));
}

#[tokio::test]
async fn bad_input_is_refused_before_touching_the_chain() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let (status, _) = app.post("/v1/deals/BAD/provision-issuer", json!({ "asset_code": "UF-BAD" })).await;
    assert_eq!(status, 422);
    assert_eq!(env.net().submissions, 0);
    assert!(app.state.issuers.read().await.is_empty());

    assert_eq!(fiat(&app, "MADRID", "inv-a", "s-1", "ten").await.0, 422);
    assert_eq!(fiat(&app, "MADRID", "inv-a", "s-1", "10").await.0, 201);
    assert_eq!(fiat(&app, "MADRID", "inv-a", "s-1", "10").await.0, 409, "duplicate ref");

    let expect = |sub: &str| json!({ "deal_id": "MADRID", "investor_id": "inv-a", "subscription_ref": sub, "eur_amount": "10", "usdc_amount": "10.85" });
    assert_eq!(app.post("/v1/subscriptions/crypto/expect", expect("s-1")).await.0, 409, "ref already fiat");
    assert_eq!(app.post("/v1/subscriptions/crypto/expect", expect("a-very-long-subscription-ref")).await.0, 422, "memo > 28 bytes");
    let swapped = json!({ "deal_id": "MADRID", "investor_id": "inv-a", "subscription_ref": "c-9", "eur_amount": "1085", "usdc_amount": "10" });
    assert_eq!(app.post("/v1/subscriptions/crypto/expect", swapped).await.0, 422, "implied rate out of bounds");
    assert_eq!(app.post("/v1/subscriptions/crypto/expect", expect("c-1")).await.0, 201);
    assert_eq!(app.post("/v1/subscriptions/crypto/expect", expect("c-1")).await.0, 409, "duplicate ref");
    assert_eq!(fiat(&app, "MADRID", "inv-a", "c-1", "10").await.0, 409, "ref already crypto");
}

#[tokio::test]
async fn crypto_subscriptions_mint_eur_units_after_an_exact_payment_and_a_covered_offramp() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let issuer = provision(&app, "MADRID", "UFMADRID1").await;
    let mut addresses = Vec::new();
    for investor in ["inv-a", "inv-b"] {
        addresses.push(onboard(&app, investor, "MADRID").await["stellarAddress"].as_str().unwrap().to_string());
        assert_eq!(app.post(&format!("/v1/deals/MADRID/authorize/{investor}"), json!({})).await.0, 200);
    }
    // inv-a commits EUR 1,000 and pays the quoted USDC 1,085.
    let expect = |sub: &str, investor: &str, eur: &str, usdc: &str| {
        json!({ "deal_id": "MADRID", "investor_id": investor, "subscription_ref": sub, "eur_amount": eur, "usdc_amount": usdc, "quote_ref": format!("q-{sub}") })
    };
    let (_, a) = app.post("/v1/subscriptions/crypto/expect", expect("c-a", "inv-a", "1000", "1085")).await;
    let memo_a = a["expected"]["memo"].as_str().unwrap().to_string();
    let collection = env.collection.public_str();
    let usdc = env.usdc_issuer.public_str();
    let counterfeit = env.channel.public_str();

    // Right memo and amount, wrong issuer: stays pending.
    env.net().payments = vec![payment_record(&collection, USDC_CODE, &counterfeit, "1085.0000000", &memo_a, "h1")];
    let (_, r) = app.post("/v1/subscriptions/crypto/reconcile", json!({})).await;
    assert_eq!(r["reconciled"][0]["state"], "PENDING", "{r}");
    env.net().payments.push(payment_record(&collection, USDC_CODE, &usdc, "1085.0000000", &memo_a, "h2"));
    let (_, r) = app.post("/v1/subscriptions/crypto/reconcile", json!({})).await;
    assert_eq!(r["reconciled"][0]["state"], "RECONCILED", "{r}");

    let (status, batch1) = app.post("/v1/deals/MADRID/offramp/build", json!({})).await;
    assert_eq!(status, 200, "{batch1}");
    assert_eq!(batch1["instruction"]["subscription_refs"], json!(["c-a"]));
    assert_eq!(batch1["instruction"]["eur_committed"], "1000.0000000");
    assert_eq!(app.post("/v1/subscriptions/c-a/settle", json!({})).await.0, 412, "EUR not yet at SPV");

    // The conversion lands EUR 2 short: Urbanflip tops up before anything mints.
    let (_, short) = app.post("/v1/deals/MADRID/offramp/complete", json!({ "bank_ref": "SEPA-1", "eur_received": "998.00" })).await;
    assert_eq!((short["instruction"]["status"].as_str(), short["shortfallEur"].as_str()), (Some("AWAITING_TOP_UP"), Some("2.0000000")), "{short}");
    assert_eq!(app.post("/v1/subscriptions/c-a/settle", json!({})).await.0, 412, "shortfall not yet covered");
    let (_, covered) = app.post("/v1/deals/MADRID/offramp/top-up", json!({ "bank_ref": "TOPUP-1", "eur_amount": "2.00" })).await;
    assert_eq!(covered["instruction"]["status"], "EXECUTED", "{covered}");
    let (status, settled) = app.post("/v1/subscriptions/c-a/settle", json!({})).await;
    assert_eq!(status, 200, "{settled}");
    assert_eq!(settled["settlement"]["units"], "1000.0000000", "units are the EUR commitment, not the USDC paid");
    assert_eq!(env.net().balance(&addresses[0], "UFMADRID1", &issuer), Some(10_000_000_000));

    // A collection reconciled after batch 1 executed was never converted.
    let (_, b) = app.post("/v1/subscriptions/crypto/expect", expect("c-b", "inv-b", "500", "542.50")).await;
    let memo_b = b["expected"]["memo"].as_str().unwrap().to_string();
    env.net().payments.push(payment_record(&collection, USDC_CODE, &usdc, "542.5000000", &memo_b, "h3"));
    app.post("/v1/subscriptions/crypto/reconcile", json!({})).await;
    assert_eq!(app.post("/v1/subscriptions/c-b/settle", json!({})).await.0, 412, "not covered by batch 1");
    let (_, batch2) = app.post("/v1/deals/MADRID/offramp/build", json!({})).await;
    assert_eq!((batch2["instruction"]["batch"].as_u64(), batch2["instruction"]["total_usdc"].as_str()), (Some(2), Some("542.5000000")));
    // A favourable conversion: the gain is recorded, the units don't move.
    let (_, done) = app.post("/v1/deals/MADRID/offramp/complete", json!({ "bank_ref": "SEPA-2", "eur_received": "500.10" })).await;
    assert_eq!((done["instruction"]["status"].as_str(), done["instruction"]["fx_result_eur"].as_str()), (Some("EXECUTED"), Some("0.1000000")));
    let (status, settled) = app.post("/v1/subscriptions/c-b/settle", json!({})).await;
    assert_eq!(status, 200, "{settled}");
    assert_eq!((settled["settlement"]["units"].as_str(), settled["settlement"]["bank_ref"].as_str()), (Some("500.0000000"), Some("SEPA-2")));
}

#[tokio::test]
async fn sdp_disbursement_is_created_once_per_file() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let wallet = support::address(&urbanflip_backend::stellar::keys::Keypair::random().public_bytes());
    let (status, body) = app
        .post(
            "/v1/deals/MADRID/ledger",
            json!({ "positions": [
                { "investor_id": "inv-a", "email": "a@example.com", "wallet_address": wallet, "principal": "30000.00" },
                { "investor_id": "inv-f", "email": "f@example.com", "principal": "10000.00" },
            ] }),
        )
        .await;
    assert_eq!(status, 201, "{body}");
    let profile = |rail: &str, address: &str| {
        json!({ "email": "x@example.com", "subscription_rail": if rail == "USDC_ONCHAIN" { "USDC_ONCHAIN" } else { "FIAT_WIRE" },
            "payout_rail": rail, "stellar_address": address, "iban": "ES00", "bank_account_name": "Investor F", "screening_ref": "ms-1" })
    };
    assert_eq!(app.post("/v1/investors/inv-a/profile", profile("USDC_ONCHAIN", &wallet)).await.0, 201);
    let fiat_wallet = env.collection.public_str();
    assert_eq!(app.post("/v1/investors/inv-f/profile", profile("FIAT_BANK", &fiat_wallet)).await.0, 201);
    let outcome = |interest: &str| json!({ "outcome": { "principal_repayment": "40000.00", "performance_interest": interest } });
    assert_eq!(app.post("/v1/deals/MADRID/distributions", outcome("8000.00")).await.0, 200);

    // inv-a is owed EUR 36,000; inv-f is paid by bank. Treasury bought USDC 39,060.
    let (_, split) = app.post("/v1/deals/MADRID/payouts/split", json!({})).await;
    assert_eq!(split["onChainEurToConvert"], "36000.0000000", "{split}");
    assert!(split.get("sdpFiles").is_none(), "no SDP file until the USDC is funded");
    let funded = json!({ "usdc_funded": "39060.00" });
    let (status, first) = app.post("/v1/deals/MADRID/sdp/disburse", funded.clone()).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["usdcConversion"]["rate"], "1.085000");
    let (status, second) = app.post("/v1/deals/MADRID/sdp/disburse", funded.clone()).await;
    assert_eq!((status, second["idempotent"].as_bool()), (200, Some(true)));
    let creates = env.net().sdp_creates.clone();
    assert_eq!(creates.len(), 1, "one file, created once");
    let csv = creates[0]["file_content"].as_str().unwrap();
    assert!(csv.lines().all(|l| l.split(',').count() == 5), "{csv}");
    assert!(csv.contains(&format!("39060.00,a@example.com,{wallet},,")), "USDC, not EUR: {csv}");

    // A different funding or a changed schedule must not silently re-send or skip.
    let (status, body) = app.post("/v1/deals/MADRID/sdp/disburse", json!({ "usdc_funded": "39100.00" })).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(app.post("/v1/deals/MADRID/distributions", outcome("9000.00")).await.0, 200);
    let (status, body) = app.post("/v1/deals/MADRID/sdp/disburse", funded).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(env.net().sdp_creates.len(), 1);
}

#[tokio::test]
async fn every_route_needs_the_right_token() {
    let env = Env::new(false).await;
    let app = env.start().await;
    assert_eq!(app.get_as(None, "/healthz").await.0, 200, "health is public");
    let provision = |token| app.post_as(token, "/v1/deals/MADRID/provision-issuer", json!({}));
    assert_eq!(provision(None).await.0, 401);
    assert_eq!(provision(Some("not-a-token")).await.0, 401);
    assert_eq!(provision(Some(READ_TOKEN)).await.0, 403, "read-only");
    assert_eq!(provision(Some(TREASURY_TOKEN)).await.0, 403);
    assert_eq!(provision(Some(OPS_TOKEN)).await.0, 200);

    // Offboarding is compliance's; payouts are treasury's.
    assert_eq!(app.post_as(Some(OPS_TOKEN), "/v1/deals/MADRID/clawback/inv-a", json!({})).await.0, 403);
    assert_eq!(app.post_as(Some(TREASURY_TOKEN), "/v1/deals/MADRID/freeze/inv-a", json!({})).await.0, 403);
    assert_ne!(app.post_as(Some(COMPLIANCE_TOKEN), "/v1/deals/MADRID/freeze/inv-a", json!({})).await.0, 403);
    assert_eq!(app.post_as(Some(OPS_TOKEN), "/v1/deals/MADRID/sdp/disburse", json!({ "usdc_funded": "1" })).await.0, 403);
    assert_eq!(app.get_as(Some(READ_TOKEN), "/v1/audit").await.0, 200);
    assert_eq!(app.get_as(Some(OPS_TOKEN), "/v1/audit").await.0, 403);

    // An investor session reaches only that investor's wallet endpoints.
    let (status, session) = app.post_as(Some(OPS_TOKEN), "/v1/investors/inv-a/session", json!({})).await;
    assert_eq!(status, 201, "{session}");
    let token = session["session_token"].as_str().unwrap().to_string();
    let address = Keypair::random().public_str();
    let challenge = |investor: &str| format!("/v1/investors/{investor}/external-wallet/challenge");
    assert_eq!(app.post_as(Some(&token), &challenge("inv-a"), json!({ "address": address })).await.0, 200);
    assert_eq!(app.post_as(Some(&token), &challenge("inv-b"), json!({ "address": address })).await.0, 403);
    assert_eq!(app.post_as(Some(&token), "/v1/deals/MADRID/provision-issuer", json!({})).await.0, 403);
    assert_eq!(app.post_as(Some(&token), "/v1/investors/inv-a/session", json!({})).await.0, 403, "no self-renewal");

    // Every state-changing call is audited with its caller.
    let (_, audit) = app.get_as(Some(READ_TOKEN), "/v1/audit").await;
    let calls: Vec<(String, u64)> = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "API_CALL" && e["path"] == "/v1/deals/MADRID/provision-issuer")
        .map(|e| (e["caller"].as_str().unwrap().to_string(), e["status"].as_u64().unwrap()))
        .collect();
    assert!(calls.contains(&("operations".to_string(), 200)), "{calls:?}");
}

#[tokio::test]
async fn sessions_expire_and_an_open_api_refuses_to_start() {
    let env = Env::new(false).await;
    let mut config = env.config();
    config.session_ttl_secs = 0;
    let app = start_with(config).await;
    let (_, session) = app.post_as(Some(OPS_TOKEN), "/v1/investors/inv-a/session", json!({})).await;
    let token = session["session_token"].as_str().unwrap().to_string();
    let (status, _) = app
        .post_as(Some(&token), "/v1/investors/inv-a/external-wallet/challenge", json!({ "address": Keypair::random().public_str() }))
        .await;
    assert_eq!(status, 401, "expired");

    let mut open = env.config();
    open.api_tokens = vec![];
    let refused = urbanflip_backend::api::state::try_build_state(open.clone()).err().expect("no tokens, no API");
    assert!(refused.contains("API_TOKENS"), "{refused}");
    open.allow_unauthenticated = true;
    assert!(urbanflip_backend::api::state::try_build_state(open).is_ok(), "explicit opt-in for local development");
}

async fn wallet_call(app: &App, session: &str, path: &str, body: Value) -> (u16, Value) {
    app.post_as(Some(session), &format!("/v1/investors/inv-b/external-wallet/{path}"), body).await
}

#[tokio::test]
async fn an_external_wallet_proves_ownership_and_signs_its_own_sponsored_trustline() {
    let env = Env::new(false).await;
    let app = env.start().await;
    let issuer = provision(&app, "MADRID", "UFMADRID1").await;
    let wallet = Keypair::random(); // the investor's own wallet (Freighter, xBull, ...)
    let (_, session) = app.post_as(Some(OPS_TOKEN), "/v1/investors/inv-b/session", json!({})).await;
    let session = session["session_token"].as_str().unwrap().to_string();

    // Ownership: only a signature by the claimed address links it, once.
    let (_, c) = wallet_call(&app, &session, "challenge", json!({ "address": wallet.public_str() })).await;
    let challenge = c["challenge_xdr"].as_str().unwrap().to_string();
    let (status, _) = wallet_call(&app, &session, "verify", json!({ "signed_xdr": sign_envelope(&challenge, &Keypair::random()) })).await;
    assert_eq!(status, 422, "signed by someone else");
    let (_, c) = wallet_call(&app, &session, "challenge", json!({ "address": wallet.public_str() })).await;
    let signed = sign_envelope(c["challenge_xdr"].as_str().unwrap(), &wallet);
    let (status, linked) = wallet_call(&app, &session, "verify", json!({ "signed_xdr": signed })).await;
    assert_eq!((status, linked["address"].as_str()), (200, Some(wallet.public_str().as_str())), "{linked}");
    assert_eq!(wallet_call(&app, &session, "verify", json!({ "signed_xdr": signed })).await.0, 410, "a challenge is single-use");
    let (status, _) = app.post("/v1/investors/inv-b/onboard", json!({ "deal_id": "MADRID" })).await;
    assert_eq!(status, 409, "no embedded wallet for an external-wallet investor");

    // The trustline: sponsored and fee-bumped by the channel, signed by the wallet.
    let (_, built) = wallet_call(&app, &session, "trustline", json!({ "deal_id": "MADRID" })).await;
    assert_eq!(built["status"], "sign", "{built}");
    let unsigned = built["xdr"].as_str().unwrap().to_string();
    let (status, _) = wallet_call(&app, &session, "trustline/submit", json!({ "deal_id": "MADRID", "signed_xdr": unsigned })).await;
    assert_eq!(status, 422, "the wallet's signature is required");
    let (_, built) = wallet_call(&app, &session, "trustline", json!({ "deal_id": "MADRID" })).await;
    let signed = sign_envelope(built["xdr"].as_str().unwrap(), &wallet);
    let (status, submitted) = wallet_call(&app, &session, "trustline/submit", json!({ "deal_id": "MADRID", "signed_xdr": signed })).await;
    assert_eq!(status, 200, "{submitted}");
    assert_eq!(env.net().accounts[&wallet.public_str()].xlm, 0, "the investor spent no XLM");
    assert!(env.net().line(&wallet.public_str(), "UFMADRID1", &issuer).is_some());
    let (_, again) = wallet_call(&app, &session, "trustline", json!({ "deal_id": "MADRID" })).await;
    assert_eq!(again["status"], "ready");

    // From here it is an ordinary investor: gated authorization, then units.
    assert_eq!(app.post("/v1/deals/MADRID/authorize/inv-b", json!({})).await.0, 200);
    assert_eq!(fiat(&app, "MADRID", "inv-b", "s-b", "500").await.0, 201);
    assert_eq!(app.post("/v1/subscriptions/s-b/settle", json!({})).await.0, 200);
    assert_eq!(env.net().balance(&wallet.public_str(), "UFMADRID1", &issuer), Some(5_000_000_000));
}

#[tokio::test]
async fn the_widget_is_served_only_to_its_allowed_frames() {
    let env = Env::new(false).await;
    let dir = std::env::temp_dir().join(format!("uf-widget-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("connect.html"), "<!doctype html><title>Connect</title>").unwrap();
    std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
    let mut config = env.config();
    config.widget_dir = Some(dir.display().to_string());
    config.widget_frame_ancestors = vec!["https://app.urbanflip.io".into()];
    let app = start_with(config).await;

    let res = app.http.get(format!("{}/widget/connect.html", app.url)).send().await.unwrap();
    assert_eq!(res.status(), 200, "public, no token");
    assert_eq!(res.headers()["content-security-policy"], "frame-ancestors https://app.urbanflip.io");
    assert_eq!(res.headers()["content-type"], "text/html; charset=utf-8");
    for path in ["/widget/.env", "/widget/%2e%2e/Cargo.toml", "/widget/connect.exe", "/widget/missing.html"] {
        assert_eq!(app.http.get(format!("{}{path}", app.url)).send().await.unwrap().status(), 404, "{path}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
