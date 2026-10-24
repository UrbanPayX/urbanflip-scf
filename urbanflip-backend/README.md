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
cargo run                                  # 0.0.0.0:8080, testnet, in-memory state
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

The state file is written atomically (temp file, fsync, rename, mode 0600)
after every mutation. Back it up together with `STATE_KEY`, but store them
separately; either one alone is useless.

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

### D3/D4: distributions

| route | body | result |
| --- | --- | --- |
| `POST /v1/deals/{deal}/ledger` | `{positions: [{investor_id, email, wallet_address?, principal}]}` | `201` |
| `POST /v1/deals/{deal}/distributions` | `{outcome: {principal_repayment, performance_interest}}` | Exact pro-rata schedule; rows always sum to the totals |
| `POST /v1/deals/{deal}/distributions/replay` | `{outcome, historical: [{investor_id, amount}], policy?}` | `{match, diffs}` against a historical payout |
| `POST /v1/deals/{deal}/payouts/split?usdc_funded=39060.00` | — | EUR worklists per rail, the bank (SEPA) file, and `onChainEurToConvert` for treasury. With `usdc_funded`, also the USDC conversion and SDP files |
| `POST /v1/deals/{deal}/sdp/disburse` | `{"usdc_funded": "39060.00"}` (USDC bought for the on-chain cohort, at most 2 decimals) | Splits the USDC pro-rata to the EUR owed and creates each SDP file once (`idempotent: true` on repeat). `409` if a file already sent would now differ, in USDC or in the EUR behind it (reconcile in the SDP first) |
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
