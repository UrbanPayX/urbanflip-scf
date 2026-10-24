# urbanflip-backend

One Rust service (axum) wiring the SCF Tranche 1 deliverables into a single
HTTP API: compliance-gated issuance (**D1**), invisible-crypto wallet
onboarding (**D2**), the pro-rata distribution engine (**D3**), the investor
rails (fiat / USDC subscription, raise-close off-ramp, payout split), and the
SDP disbursement hand-off (**D4**).

Transactions are built as raw XDR and signed in-process. Signature payloads
are pinned byte-for-byte to `@stellar/stellar-sdk` by test vectors, and the
full lifecycle is rehearsed against the real testnet (see [Testing](#testing)).

## Denomination

Every loan is in **EUR**; one unit of a deal's asset is **EUR 1 of
participative-loan principal**, whichever rail the investor uses. USDC is
only a way to pay in and get paid out:

- **Subscribing in USDC.** The investor commits a EUR amount and pays the
  USDC the ramp quotes for it. Units mint at the EUR commitment once the
  off-ramp has landed that EUR at the SPV. If the conversion comes in short,
  Urbanflip tops up the difference first; a surplus is recorded as an FX
  gain. Either way, the investor's units never move.
- **Getting paid in USDC.** Distributions are computed in EUR. Treasury
  converts the on-chain cohort's EUR total, and the USDC actually bought is
  split pro-rata, exact to the cent, so everyone gets that day's rate. Bank
  payees receive EUR as today.

## Guarantees

- **Flags before trustlines.** A deal's issuer is created with
  `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED` in the same
  transaction, so no trustline can predate them.
- **The gate is the only grant path.** `authorize` evaluates the compliance
  gate first and fails closed (rejected, pending and unreachable all refuse).
  Every decision is written to the audit log, refusals included.
- **Units mint only on settled money.** Fiat: a recorded bank settlement.
  USDC: an exact-match collection (memo, amount, asset code *and* issuer)
  that an **executed** off-ramp batch converted. A batch executes only when
  the EUR at the SPV (conversion plus top-ups) covers its commitments. A
  collection reconciled after a batch executed waits for its own batch.
- **No double mint, no double clawback.** Issuance and clawbacks are
  recorded with their precomputed tx hash *before* submission. After a
  timeout, crash or restart, the retry (`settle`, or a clawback with the
  same `clawback_ref`) resolves that hash on Horizon. It never rebuilds
  while the old tx could still land (until its `max_time` + 30 s).
  Concurrent duplicates of the same operation get `409`.
- **No orphaned keys.** Issuer and wallet keys are persisted before their
  accounts can exist on-chain. A provisioning that timed out is adopted on
  retry, not duplicated.
- **Investors never hold XLM.** Accounts and trustlines are sponsored by the
  channel (CAP-33) and the trustline is fee-bumped. The wallet signs a raw tx
  hash (Privy's contract), verified locally before anything is submitted.
- **Retry-safe onboarding.** Steps already on-chain are skipped (an
  investor's second deal reuses the account).

## Running

```bash
ALLOW_UNAUTHENTICATED=true cargo run       # local only: 0.0.0.0:8080, testnet, in-memory state, no auth
TOKEN=$(openssl rand -hex 32)              # give this to the caller; configure only its hash
API_TOKENS="[{\"name\":\"bubble\",\"role\":\"operations\",\"sha256\":\"$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)\"}]" \
STATE_PATH=./data/state.json STATE_KEY=$(openssl rand -hex 32) \
CHANNEL_SECRET=S... STATIC_GATE_ALLOW='[["inv-1","*"]]' cargo run
```

| variable | default | meaning |
| --- | --- | --- |
| `STELLAR_NETWORK` | `testnet` | `mainnet`/`public` switches Horizon and passphrase |
| `HORIZON_URL` | testnet Horizon | override (testnet only; mainnet uses horizon.stellar.org) |
| `NETWORK_PASSPHRASE` | per network | override |
| `CHANNEL_SECRET` | — | funds issuers, sponsors investors, pays fees (required for on-chain routes) |
| `STATE_PATH` | — | JSON state snapshot; without it, state is in memory only. An exclusive OS lock on `<state>.lock` makes a second instance on the same file refuse to start; the lock dies with the process, so a crash never leaves it stale |
| `STATE_KEY` | — | 64 hex chars; required with `STATE_PATH`. Seals issuer and wallet secrets (ChaCha20-Poly1305). A wrong key stops startup; state is never silently replaced |
| `AUDIT_PATH` | — | append-only JSONL audit log |
| `GATE_PROVIDER` | `static` | `static` or `urbanflip` |
| `STATIC_GATE_ALLOW` | `[]` | `[[investorId, dealId or "*"], ...]` |
| `URBANFLIP_GATE_URL`, `URBANFLIP_GATE_TOKEN` | — | KYC decision endpoint for `GATE_PROVIDER=urbanflip` |
| `HOME_DOMAIN` | `urbanflip.io` | issuer `home_domain` (SEP-1) |
| `COLLECTION_ADDRESS`, `USDC_CODE`, `USDC_ISSUER` | —, `USDC`, — | crypto-subscription collection |
| `SPV_IBAN` | sample | default off-ramp target |
| `SDP_BASE_URL`, `SDP_TOKEN` | — | self-hosted SDP; without them, `sdp/disburse` returns `501` and files come from `payouts/split` |
| `BIND_ADDR` | `0.0.0.0:8080` | listen address |
| `API_TOKENS` | — | staff tokens: `[{"name", "role", "sha256"}]` (see [Access control](#access-control)). Without any, startup is refused |
| `ALLOW_UNAUTHENTICATED` | — | `true` serves every route without a token. Local development only |
| `SESSION_TTL_SECS` | `900` | lifetime of investor session tokens |
| `WIDGET_DIR` | — | built wallet widget (`wallet-onboarding/web/dist`), served at `/widget/` |
| `WIDGET_FRAME_ANCESTORS` | none | origins allowed to frame the widget, e.g. `https://app.urbanflip.io` |
| `BRIDGE_API_URL` | `https://api.sandbox.bridge.xyz/v0` | Bridge API; a URL containing `sandbox` turns on simulated deposits. Production: `https://api.bridge.xyz/v0` |
| `BRIDGE_API_KEY`, `BRIDGE_CUSTOMER_ID` | — | Bridge API key (`sk-test-...` in sandbox) and Urbanflip's KYB-approved Bridge customer. Without them the ramp routes return `501` |
| `BRIDGE_WEBHOOK_PUBLIC_KEY` | — | PEM public key of the Bridge webhook endpoint (enables `/v1/webhooks/bridge`) |
| `COLLECTION_SECRET` | — | collection account key, so live off-ramp deposits are signed by the backend; must match `COLLECTION_ADDRESS`. Without it, pay the batch yourself and register the tx hash |
| `DISTRIBUTION_ADDRESS` | — | the SDP distribution wallet that Bridge funding delivers USDC to |

The state file is written atomically (temp file, fsync, rename, mode 0600)
after every mutation. Back it up together with `STATE_KEY`, but store them
separately; either one alone is useless.

## Access control

Every call except `/healthz` and `/widget/*` needs `Authorization: Bearer
<token>`; a missing or unknown token gets `401`, a token whose role doesn't
cover the route gets `403`. Only each token's SHA-256 is configured, and it
is compared in constant time. Every route has an explicit policy, and a route
without one is refused, so a new route can't ship open by mistake. Every
state-changing call is written to the audit log as `API_CALL` with the
caller's name and the response status.

| role | may call |
| --- | --- |
| `admin` | everything |
| `operations` | ledgers, issuer provisioning, profiles, onboarding, investor sessions, subscriptions, settle, distributions, authorize, eligibility, trustline checks |
| `treasury` | off-ramp build/complete/top-up, payouts split, SDP disbursement, eligibility, trustline checks |
| `compliance` | authorize, freeze, clawback, eligibility, trustline checks, audit |
| `read` | eligibility, trustline checks, audit |

**Investor sessions.** A browser must never hold a staff token. The investor
app's backend (a Bubble backend workflow with a private `operations` token)
calls `POST /v1/investors/{investor}/session` and passes the returned
`session_token` to the widget. A session reaches only that investor's
`external-wallet/*` routes and expires after `SESSION_TTL_SECS`.

## API

All bodies are JSON. Errors are `{"error": "..."}`. Amounts are decimal
strings (up to 7 decimals).

### D1: issuer, gate, offboarding

| route | body | result |
| --- | --- | --- |
| `POST /v1/deals/{deal}/provision-issuer` | `{"asset_code"?: "UFMADRID1"}` (1-12 alphanumerics; default derived from the deal id) | `{dealId, assetCode, issuer, txHash}`. Repeating returns the same issuer with `idempotent: true`. `422` bad code (nothing submitted), `409` provisioning already running, `502` outcome unknown (retry adopts the issuer if it landed) |
| `POST /v1/deals/{deal}/authorize/{investor}` | — | `{authorized, decision, txHash}`. `403` gate refused, `503` gate unreachable; both are audited |
| `POST /v1/deals/{deal}/freeze/{investor}` | — | `{frozen, asset, txHash}` (revokes trustline authorization) |
| `POST /v1/deals/{deal}/clawback/{investor}` | `{"amount"?: "100.00", "clawback_ref"?: "cb-1", "investor_address"?: "G..."}` | `{clawedBack, address, clawbackRef, txHash}`. With no amount, claws back the whole balance (`409` if nothing is held). An explicit amount requires `clawback_ref` (`422` without): the clawback is recorded with its tx hash before submission, so retrying with the same ref after a `502` resolves it by hash and never claws twice (`idempotent: true` once done; `409` while the lost tx may still land, or if the ref was used for a different clawback). `investor_address` is only a cross-check (`422` if it differs) |

### D2: onboarding

| route | body | result |
| --- | --- | --- |
| `POST /v1/investors/{investor}/onboard` | `{"deal_id": "MADRID"}` | `{stellarAddress, accountCreationTxHash, trustlineTxHash, zeroXlm}`. A hash is `null` when that step already existed. `409` if the deal's issuer is unconfirmed or the same investor is mid-onboarding |
| `POST /v1/investors/{investor}/profile` | `{email, subscription_rail: FIAT_WIRE\|USDC_ONCHAIN, payout_rail: FIAT_BANK\|USDC_ONCHAIN, stellar_address, iban?, bank_account_name?, screening_ref?}` | `201`. USDC subscription requires `screening_ref`; bank payout requires IBAN and account name |

### D2: external wallets (Stellar Wallets Kit)

For crypto-native investors with their own wallet. The embeddable widget
(`wallet-onboarding/web`) drives these; Bubble frames it from `/widget/connect.html`.

| route | body | result |
| --- | --- | --- |
| `POST /v1/investors/{investor}/session` | — | `201 {session_token, expires_at}` (`operations`) |
| `POST /v1/investors/{investor}/external-wallet/challenge` | `{"address": "G..."}` | `{challenge_xdr, network_passphrase, expires_at}`: a SEP-10-style tx (sequence 0, so it can never be submitted) for the wallet to sign |
| `POST /v1/investors/{investor}/external-wallet/verify` | `{"signed_xdr"}` | `{linked, address}`. The challenge is single-use and expires in 5 minutes (`410`: request a new one), and must carry a valid signature by the claimed address (`422` otherwise). `409` if the investor already has an embedded wallet or a different linked wallet |
| `POST /v1/investors/{investor}/external-wallet/trustline` | `{"deal_id"}` | `{status: "ready"}` if the trustline exists, else `{status: "sign", xdr, network_passphrase, expires_at}`: a channel-sponsored trustline (and account, if new) for the wallet to sign |
| `POST /v1/investors/{investor}/external-wallet/trustline/submit` | `{"deal_id", "signed_xdr"}` | `{status: "submitted", trustline_tx_hash}`. Only the tx built for this investor and deal, signed by their wallet, is fee-bumped by the channel and submitted; the investor spends no XLM |
| `GET /widget/{file}` | — | the built widget, public, with `Content-Security-Policy: frame-ancestors <WIDGET_FRAME_ANCESTORS>` |

A linked wallet becomes the investor's address for authorization, issuance
and clawback; `onboard` (embedded wallet) is refused for them.

### Subscriptions and issuance

| route | body | result |
| --- | --- | --- |
| `POST /v1/subscriptions/fiat` | `{deal_id, investor_id, subscription_ref, amount, bank_ref}` | `201`. `409` if the ref is already used (fiat or crypto) |
| `POST /v1/subscriptions/crypto/expect` | `{deal_id, investor_id, subscription_ref, eur_amount, usdc_amount, quote_ref?}` (the EUR commitment and its USDC quote; the implied rate must be within 0.5–2 USDC per EUR) | `201 {expected: {memo, collection_address, ...}}`. The memo `UF-<deal>-<ref>` must fit 28 bytes and be unique across subscriptions (`422`). `409` if the ref is already used. Each payment tx reconciles at most one subscription |
| `POST /v1/subscriptions/crypto/reconcile` | — | Reads payments to the collection address from Horizon; `{reconciled: [{subscriptionRef, state}]}` |
| `POST /v1/deals/{deal}/offramp/build` | `{"target_iban"?, "max_slice_usdc"?: "50000"}` | `{instruction: {batch, subscription_refs, total_usdc, eur_committed, slices, status}}` covering the reconciled collections no executed batch has converted. Rebuilding replaces a still-pending batch; a batch awaiting a top-up blocks |
| `POST /v1/deals/{deal}/offramp/complete` | `{"bank_ref": "SEPA-1", "eur_received": "998.00"}` | Records the conversion. `EXECUTED` if the EUR covers the commitments (its subscriptions become eligible), else `AWAITING_TOP_UP` with `shortfallEur`. `fx_result_eur` is received minus committed |
| `POST /v1/deals/{deal}/offramp/top-up` | `{"bank_ref": "TOPUP-1", "eur_amount": "2.00"}` | Urbanflip covers a shortfall; the batch executes once it is covered. Repeating a `bank_ref` changes nothing |
| `GET /v1/deals/{deal}/eligibility` | — | Per-subscription eligibility for issuance |
| `POST /v1/subscriptions/{ref}/settle` | — | Issues units (EUR principal, for either rail): `{settlement: {units, txHash, ...}}`. Repeating returns `idempotent: true`. `412` not eligible, `409` trustline not ready / in flight / may still land, `502` outcome unknown (retry resolves by hash) |

### D5: Bridge ramp

Both conversion legs run through [Bridge](https://apidocs.bridge.xyz). Every
call to Bridge carries an `Idempotency-Key` derived from the deal, so a
retry never creates a second account, address or deposit. Webhooks only
trigger the syncs; polling the sync routes works on its own (the Bridge
sandbox sends no webhooks).

| route | body | result |
| --- | --- | --- |
| `POST /v1/deals/{deal}/offramp/bridge-route` | the SPV account: `{iban, bic?, country, account_owner_name, address: {street_line_1, city, postal_code?, country}}` (ISO alpha-3 countries) | `{route}`: the SPV IBAN as a Bridge external account and a Stellar USDC liquidation address that pays it in EUR by SEPA. Idempotent; `409` for a different IBAN |
| `POST /v1/deals/{deal}/offramp/send` | `{"deposit_tx_hash"?}` | Sends the pending batch's USDC to the liquidation address, once: sandbox simulates the deposit; live, the backend pays from the collection account (recorded by tx hash before submitting, resolved by hash after a timeout) or registers a deposit you made. A sent batch can no longer be rebuilt |
| `POST /v1/deals/{deal}/offramp/sync` | — | Reads Bridge's drain: `202` while it's in progress; once paid out, completes the batch with the EUR actually received (receipt's outgoing amount) and the SEPA reference, so a shortfall waits for a top-up. `409` if Bridge returned or refunded it |
| `POST /v1/deals/{deal}/funding/bridge-account` | — | `{funding_account}`: a virtual EUR IBAN whose deposits Bridge converts to USDC on Stellar for `DISTRIBUTION_ADDRESS`. Treasury wires the deal's distribution EUR there |
| `POST /v1/deals/{deal}/funding/simulate-deposit` | `{amount, reference?}` | sandbox only |
| `POST /v1/deals/{deal}/funding/sync` / `GET .../funding` | — | `{funding: {eur_deposited, usdc_received, deposits}}` from Bridge's activity |
| `POST /v1/webhooks/bridge` | Bridge event | Public, but verified: RSA signature over SHA256(SHA256(`<t>.<body>`)) with `BRIDGE_WEBHOOK_PUBLIC_KEY`, 10-minute window, duplicates ignored. Triggers the matching sync |

With funding synced, `sdp/disburse` can omit `usdc_funded` and pays exactly
the USDC Bridge delivered (whole cents); a typed figure that differs is
refused. One funding account per deal: it assumes one distribution per deal.

### D3/D4: distributions

| route | body | result |
| --- | --- | --- |
| `POST /v1/deals/{deal}/ledger` | `{positions: [{investor_id, email, wallet_address?, principal}]}` | `201` |
| `POST /v1/deals/{deal}/distributions` | `{outcome: {principal_repayment, performance_interest}}` | Exact pro-rata schedule; rows always sum to the totals |
| `POST /v1/deals/{deal}/distributions/replay` | `{outcome, historical: [{investor_id, amount}], policy?}` | `{match, diffs}` against a historical payout |
| `POST /v1/deals/{deal}/payouts/split?usdc_funded=39060.00` | — | EUR worklists per rail, the bank (SEPA) file, and `onChainEurToConvert` for treasury. With `usdc_funded`, also the USDC conversion and SDP files |
| `POST /v1/deals/{deal}/sdp/disburse` | `{"usdc_funded"?: "39060.00"}` (USDC bought for the on-chain cohort, at most 2 decimals; omitted = the Bridge-confirmed funding) | Splits the USDC pro-rata to the EUR owed and creates each SDP file once (`idempotent: true` on repeat). `409` if a file already sent would now differ, in USDC or in the EUR behind it (reconcile in the SDP first) |
| `POST /v1/trustline-check` | `{asset_code, asset_issuer, addresses: [...]}` | `Ready` / `Missing` / `Unauthorized` / `NoAccount` per address |
| `GET /v1/audit` | — | Last 50 audit events |

## Testing

```bash
cargo test                                          # unit + offline HTTP tests
cargo test --test testnet -- --ignored --nocapture  # live testnet rehearsal (~90 s)
```

- **Unit tests** cover the money math, eligibility rules and off-ramp
  batching, sealed-secret storage, Horizon payment parsing, and XDR
  signature payloads pinned to SDK vectors.
- **`tests/api.rs`** drives the HTTP API against an in-process fake Horizon
  (and SDP). The fake verifies every required Ed25519 signature with its own
  hashing, checks sequence numbers, applies operations atomically with
  Stellar result codes, and can simulate a timeout that landed, one that
  didn't, and slow submissions. It covers the lifecycle, double-mint
  safety, restart from sealed state, issuer adoption, input validation,
  counterfeit-asset rejection, off-ramp batches and SDP idempotency.
- **`testnet_sponsored_cohort`** (in `tests/testnet.rs`, ignored by default)
  onboards a cohort through the API and checks each account on Horizon:
  zero XLM, account and trustline sponsored by the channel. It writes the
  evidence for D2 criterion 2 (`COHORT=22 EVIDENCE_PATH=evidence/... cargo
  test --test testnet testnet_sponsored_cohort -- --ignored`); the 22-account
  run is in `evidence/d2-sponsored-cohort-testnet.json`.
- **`tests/testnet.rs`** funds a channel through friendbot and runs the D1/D2
  lifecycle on the real testnet, including a restart from the state file. It
  asserts each effect on Horizon and prints stellar.expert links for evidence.

## Not yet covered

- `DevWalletProvider` keeps investor keys server-side for testnet and demos.
  Production signing goes through the Privy adapter in `wallet-onboarding`
  (same raw-signature contract).
- Issuer keys are sealed at rest under one `STATE_KEY`. The production key
  ceremony and signer segregation are Deliverable 8.
- One instance per state file, enforced by the lock; there is no clustering
  across instances.
- Bridge is wired against its documented API and a strict fake; it has not
  run against Bridge itself yet. EUR and SEPA must be enabled by Bridge
  sales (with a SEPA endorsement) before the sandbox or production can be
  used, and the EUR IBAN to USDC-on-Stellar route should be confirmed with
  them. `COLLECTION_SECRET` is a hot key until the D8 key ceremony.
