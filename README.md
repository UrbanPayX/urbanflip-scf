# Urbanflip × Stellar — SCF #45 build

[![ci](https://github.com/UrbanPayX/urbanflip-scf/actions/workflows/ci.yml/badge.svg)](https://github.com/UrbanPayX/urbanflip-scf/actions/workflows/ci.yml)

Urbanflip's Stellar Community Fund #45 build: EUR participative loans in Madrid
real estate, issued as compliance-flagged Stellar assets and distributed in
USDC. Everything here runs on **Stellar testnet**.

## Tranche 1 (MVP): evidence per acceptance criterion

Each criterion is quoted as submitted. All evidence is public: either a
stellar.expert link or a file in this repo.

### D1 · Compliance-Gated Issuance Layer → [`gated-issuance/`](gated-issuance)

| # | Criterion | Evidence |
|---|---|---|
| 1 | Testnet issuer and asset resolve on stellar.expert with verified urbanflip.io domain (SEP-1). | Asset [UF0042](https://stellar.expert/explorer/testnet/asset/UF0042-GCCINLXJ3LXDQNSPSYSQZQBFCNGN637I76PRBBGFXY2G45KULS3Z3EPB). Issuer `home_domain` = urbanflip.io; [stellar.toml](https://urbanflip.io/.well-known/stellar.toml) (source: [`gated-issuance/evidence/stellar.toml`](gated-issuance/evidence/stellar.toml)) |
| 2 | Recorded demo: non-KYC wallet rejected at protocol level (op_not_authorized); KYC-approved wallet authorized and receiving. | Rejected, `op_not_authorized`, failed tx on-ledger: [7eaa4e64…](https://stellar.expert/explorer/testnet/tx/7eaa4e645b26deb01de86b124e2e9424a762eaf1d327a2439bbeca0f2173456e). Authorized after KYC: [8221b35d…](https://stellar.expert/explorer/testnet/tx/8221b35d2cfcab76af393511960306136daded871b20da4cf15b135857fff6ae). Received: [7c191da0…](https://stellar.expert/explorer/testnet/tx/7c191da0c3d055adc583cdc2683ea393a00a083caadcbebe74e2be618603212e). Record: [`d1-lifecycle-testnet.json`](gated-issuance/evidence/d1-lifecycle-testnet.json). **Recording:** [`d1-lifecycle-demo.mp4`](gated-issuance/evidence/video/d1-lifecycle-demo.mp4) (2:52, a separate live run on testnet; [scene guide and links](gated-issuance/evidence/video/README.md)) |
| 3 | Authorization service API documented; integration test suite passing with >=90% coverage on the authorization path. | API: [`gated-issuance/README.md`](gated-issuance/README.md), backend routes in [`urbanflip-backend/README.md`](urbanflip-backend/README.md). Coverage: [`gated-issuance/evidence/coverage.txt`](gated-issuance/evidence/coverage.txt) (gate ≥90% per file, enforced in CI) |
| 4 | Clawback and freeze flows executed and verifiable on testnet. | Freeze: [6e81dfb0…](https://stellar.expert/explorer/testnet/tx/6e81dfb05a4c687d1c89eeed005deae1efbe61edb5ceae0a5a0bf98a48f3db1b). Clawback: [84428d95…](https://stellar.expert/explorer/testnet/tx/84428d95a37f77dcdf2c45fa0e2fbb8c3227f26c809bdf053db7fab6282d596c) |

The issuer flags (AUTH_REQUIRED, AUTH_REVOCABLE, AUTH_CLAWBACK_ENABLED) are
set in the [account-creation transaction](https://stellar.expert/explorer/testnet/tx/cafc2f460ae2d7c0595973154372c1612e8ce3a3a3c9f6e3903702179b916884),
before any trustline exists ([issuer account](https://stellar.expert/explorer/testnet/account/GCCINLXJ3LXDQNSPSYSQZQBFCNGN637I76PRBBGFXY2G45KULS3Z3EPB)).

### D2 · Invisible-Crypto Wallet Onboarding → [`wallet-onboarding/`](wallet-onboarding), [`urbanflip-backend/`](urbanflip-backend)

| # | Criterion | Evidence |
|---|---|---|
| 1 | Recorded flow: email signup to embedded wallet to sponsored trustline, with the investor holding zero XLM at every step. | Investor with 0 XLM and sponsored reserves: [GB23ABY7…NRIU](https://stellar.expert/explorer/testnet/account/GB23ABY7N5IZH3CDX5XOZ6SW44T2A6M57RXEYRPI534EDRASK4PDNRIU); sponsor [GAXPAR6Z…CBNP](https://stellar.expert/explorer/testnet/account/GAXPAR6ZNO3W4DODL4GB2UVNQYQ7MJY73XMDWDMJRTYY3NJXUMI2CBNP) |
| 2 | 20+ sponsored accounts created on testnet with sponsored trustlines verifiable on-chain. | 22 accounts: [`d2-sponsored-cohort-testnet.csv`](urbanflip-backend/evidence/d2-sponsored-cohort-testnet.csv) (one stellar.expert link per account, creation tx and trustline tx) |
| 3 | Fee-bump pipeline covers 100% of investor-initiated transactions in the test suite. | [`wallet-onboarding/evidence/test-report.txt`](wallet-onboarding/evidence/test-report.txt) ("submits every investor transaction as a fee-bump paid by the channel account") |
| 4 | Duplicate-submission, timeout and rejected-signature test suites pass. | [CI](https://github.com/UrbanPayX/urbanflip-scf/actions/workflows/ci.yml) and [`test-report.txt`](wallet-onboarding/evidence/test-report.txt) |

### D3 · Pro-Rata Distribution Engine → [`distribution-engine/`](distribution-engine)

| # | Criterion | Evidence |
|---|---|---|
| 1 | API specification published. | [`distribution-engine/api/openapi.yaml`](distribution-engine/api/openapi.yaml) (OpenAPI 3.1) |
| 2 | Replay of 3 completed real deals' actual payout data reproduces historical amounts exactly. | [`d3-replay-report.md`](distribution-engine/evidence/d3-replay-report.md): Velázquez 87, Orense 9 and General Perón 26, i.e. 149 settlements × 7 components = 1,043 amounts, 0.00 difference per investor and in total. Investor IDs are pseudonymized; the amounts are real. Exceptions are declared in the report and confirmed by Urbanflip. |
| 3 | Test coverage >=90% on computation logic. | [`distribution-engine/evidence/coverage.txt`](distribution-engine/evidence/coverage.txt) (gate ≥90% per file, enforced in CI) |

## Layout

| Path | What |
|---|---|
| [`gated-issuance/`](gated-issuance) | D1: issuer provisioning, KYC-gated trustline authorization, freeze/clawback, SEP-1 toml (TypeScript) |
| [`wallet-onboarding/`](wallet-onboarding) | D2: Privy embedded wallets, Stellar Wallets Kit widget, sponsorship (CAP-33), fee-bump pipeline (TypeScript) |
| [`distribution-engine/`](distribution-engine) | D3: Urbanflip's settlement waterfall, pro-rata payouts, SDP payment files (TypeScript) |
| [`investor-rails/`](investor-rails) | Fiat/USDC subscription and payout rails feeding D4/D5 (TypeScript) |
| [`urbanflip-backend/`](urbanflip-backend) | One HTTP service (Rust, axum) wiring D1–D3, the rails, the Bridge ramp and the SDP export |

## Running the tests

```sh
# TypeScript packages (Node 22). Install distribution-engine first: investor-rails imports it.
for p in distribution-engine gated-issuance wallet-onboarding investor-rails; do
  (cd $p && npm ci && npm test)
done
# coverage gates (D1 authorization path, D3 computation logic)
(cd gated-issuance && npm run coverage); (cd distribution-engine && npm run coverage)
# Rust backend
(cd urbanflip-backend && cargo test --locked)
```

Live testnet suites are opt-in. `RUN_LIVE=1` runs the TypeScript ones and
`cargo test --test testnet -- --ignored` runs the Rust one. Each package
README covers its API, configuration and guarantees.
