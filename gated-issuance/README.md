# gated-issuance

Compliance-gated asset issuance layer for Stellar — a standalone implementation of
**SCF #45 Tranche 1, Deliverable 1** (Urbanflip: "Compliance-Gated Issuance Layer").

The design requirement this repo answers: **the issuance core is generic; Urbanflip
is only the gate.** The core depends on a one-method `ComplianceGate` port
("may this investor hold this deal's asset?"). Urbanflip's KYC pipeline plugs in as
an HTTP adapter; a static allowlist ships as a second adapter for tests, dry-runs
and out-of-band operations. Nothing in `src/issuance` or `src/sep1` imports
anything Urbanflip-specific.

```
                    ┌─────────────────────────────────────────────┐
                    │              issuance core                  │
                    │                                             │
  deal config ────► │  IssuerProvisioner   TrustlineAuthorizer    │
                    │  (flags before any    (gate-gated auth,     │
                    │   trustline)           freeze, clawback)    │
                    │            Sep1Publisher   AuditLog         │
                    └───────────────┬─────────────────────────────┘
                                    │ depends only on
                            ComplianceGate (port)
                                    ▲
              ┌─────────────────────┴─────────────────────┐
              │                                           │
 UrbanflipComplianceGate                        StaticComplianceGate
 (GET /api/v1/compliance/decision)              (JSON allowlist; tests/ops)
```

## What it enforces

- **Per-deal issuer provisioning**: `AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED`
  set in the same transaction that creates the issuer account — strictly before any
  trustline can exist (clawback cannot be enabled retroactively; CAP-35). A
  self-check (`assertProvisioningInvariant`) rejects any provisioning envelope that
  contains trustline or payment operations.
- **One issuer per deal, key never lost**: `provision()` is idempotent per `dealId`.
  The issuer keypair is recorded `PENDING` in an `IssuerStore` *before* the creation
  transaction is submitted; a re-run returns the `ACTIVE` record, adopts a `PENDING`
  issuer that already landed (lost response, crash), or resubmits with the *same*
  keypair if it did not. See [Crash and timeout safety](#crash-and-timeout-safety).
- **Units minted once per settlement**: `SubscriptionSettlementService.settle()` records
  the signed payment's hash and `maxTime` before submitting, and resolves an unknown
  outcome by hash instead of minting again.
- **Gate-gated authorization**: `TrustlineAuthorizer.authorize()` is the only code
  path that emits `setTrustLineFlags(authorized: true)`, and it always evaluates the
  gate first. `rejected` and `pending` are treated identically (fail closed), as are
  unreachable gates.
- **Protocol-level rejection**: with the flags in place, a payment to an
  unauthorized trustline fails with `op_not_authorized` — enforced by the Stellar
  protocol, not by this service.
- **Offboarding**: `freeze()` (revoke authorization; blocks the position) and
  `clawback()` (reclaim balance), both audited. Clawback is exactly-once per caller-supplied
  `clawbackId`, recorded `PENDING` before submission like settlement; omitting the amount
  claws back the holder's whole balance.
- **One process per state directory**: the JSON-file stores lock their directory
  (`<dir>/.lock`); a second process or instance is refused, a dead holder's lock is taken over.
- **SEP-1**: generates `stellar.toml` with one `[[CURRENCIES]]` block per deal asset.
- **Asset codes**: 1-12 ASCII alphanumerics, as the protocol allows (1-4 encode as
  `credit_alphanum4`, 5-12 as `credit_alphanum12`; e.g. `UFMADRID1`). Derived codes are
  the uppercased deal id without separators, truncated to 12 and never padded
  (`UF-0042` → `UF0042`; 1-2 digit ids → `UF42`, `UF07`). Deals provisioned by earlier
  versions under the old `X`-padding rule (`UF0042XXXXXX`) must pass that `assetCode`
  explicitly.
- **Audit trail**: every gate decision and state change is logged with its tx hash,
  producing a KYC-record ↔ on-chain-transaction mapping.

## Quick start

```bash
npm install
npm test                 # offline structural + adapter tests (no network)
npm run coverage         # same suite with v8 coverage; fails below 90% on the authorization path
npm run demo             # full lifecycle on Stellar testnet, with evidence links
RUN_LIVE=1 npm run test:live   # the same lifecycle as an assertion suite
```

The demo provisions a real testnet issuer, walks an investor through
trustline → rejection → gate approval → authorization → payment → clawback → freeze,
and prints stellar.expert links for every step.

## The Urbanflip gate contract

`UrbanflipComplianceGate` expects exactly one endpoint:

```
GET {URBANFLIP_GATE_BASE_URL}/api/v1/compliance/decision?investorId=...&dealId=...
Authorization: Bearer {URBANFLIP_GATE_TOKEN}

200 OK
{
  "status": "approved" | "rejected" | "pending",   // required
  "evidenceId": "kyc-rec-123",                     // optional, lands in the audit trail
  "reason": "...",                                 // optional
  "evaluatedAt": "2026-10-23T10:00:00Z"            // optional, defaults to now
}
```

Anything else (4xx/5xx after retries, timeout, malformed body) raises
`GateUnavailableError` and the core **fails closed**: no authorization transaction
is built or submitted. KYC logic, scoring, and professional-status rules stay
entirely inside Urbanflip — this layer never sees them.

Wire it up via `src/config.ts` (`GATE_PROVIDER=urbanflip`) or directly:

```ts
const service = createIssuance({
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  homeDomain: 'urbanflip.io',
  funderSecret: process.env.FUNDER_SECRET!,
  gate: { kind: 'urbanflip', baseUrl: 'https://platform.urbanflip.io', apiToken: '...' },
  auditLogPath: 'dist/audit-log.jsonl',
  stateDir: 'var/state',              // issuers.json, settlements.json, clawbacks.json survive restarts
  stateKey: process.env.STATE_KEY!,   // 64 hex chars; seals issuer secrets at rest
});
// ... and on shutdown: await service.close();   // flushes writes, releases var/state/.lock

// Idempotent: calling it again for the same deal returns the same issuer.
const issuer = await service.provisioner.provision({ dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' });
await service.authorizer.authorize(issuer.deal, Keypair.fromSecret(issuer.issuerSecret), {
  investorId: 'inv-001',
  stellarAddress: 'G...',
});
```

`issuer.deal` carries the recorded `assetCode`, so later calls address exactly the
provisioned asset. Environment equivalents: `STATE_DIR`, `STATE_KEY` (`STATE_DIR`
without `STATE_KEY` is refused). Without a state directory, stores live in process
memory: idempotent within one process, lost on restart.

## Crash and timeout safety

`TxSubmitter.submit()` distinguishes two failures:

| Error | Meaning | What callers do |
| --- | --- | --- |
| `TransactionRejectedError` | Horizon 400 with `extras.result_codes.transaction` (or SEP-29 memo refusal before sending): the tx did **not** apply | safe to rebuild |
| `TransactionOutcomeUnknownError` (`.hash`) | 504, timeout, dropped connection, any error without result codes: the tx **may still apply** until its `maxTime` | resolve by hash first |

`TxSubmitter` also implements the `LedgerLookup` port — `transactionOutcome(hash)`
(`SUCCESS` / `FAILED` / `NOT_FOUND`) and `accountFlags(address)` — which provisioning,
settlement and clawback use to resolve unknown outcomes, and the `BalanceLookup` port —
`assetBalance(address, asset)` — which full-balance clawbacks use.

**Provisioning** (`IssuerProvisioner`, store: `IssuerStore`):

- `ACTIVE` record → returned, nothing submitted.
- `PENDING` record → issuer looked up on-chain: present with all three flags → adopted
  (`ISSUER_PROVISIONED` audited with `adoptedExisting: true`); present without them →
  error, manual review; absent → resubmitted with the same keypair (a `createAccount` to
  one address can only succeed once, so there is never a second issuer).
- No record → keypair generated, recorded `PENDING` (with the tx hash), then submitted.

**Settlement** (`SubscriptionSettlementService`, store: `SettlementStore`):

- After the gate check and trustline pre-flight, the signed payment's hash and `maxTime`
  are stored `PENDING` before submission. Success → `SETTLED`; definitive rejection →
  pending cleared; unknown outcome → pending kept, `TransactionOutcomeUnknownError` thrown.
- The next `settle()` for that `settlementId` resolves the pending tx by hash: applied →
  recorded as settled without resubmitting (audited with `resolvedByHash: true`); failed
  on-chain → rebuilt; not found and `now <= maxTime + 30s` → `SettlementPendingError`
  (`.retryAfter`, unix seconds); not found and expired → rebuilt.

**Clawback** (`TrustlineAuthorizer.clawback()`, store: `ClawbackStore`):

```ts
// explicit amount: clawbackId is required (ClawbackIdRequiredError otherwise)
await authorizer.clawback(deal, issuerKp, holder, { amount: '5', clawbackId: 'offboard-inv-001-1' });
await authorizer.clawback(deal, issuerKp, holder, '5', 'offboard-inv-001-1'); // positional form
// full balance: amount omitted; the id is optional
await authorizer.clawback(deal, issuerKp, holder, { clawbackId: 'offboard-inv-001-all' });
```

- The signed clawback's hash and `maxTime` are stored `PENDING` (`clawbackId`, deal, asset,
  holder, requested and actual amount) before submission. Success → completed; definitive
  rejection → pending cleared; unknown outcome → pending kept, error thrown.
- A repeat with the same id returns the recorded result (`ClawbackResult`: amount, tx hash,
  `clawedBackAt`) without submitting. A pending id is resolved by hash exactly like
  settlement: applied → recorded with `resolvedByHash: true` (also on the `CLAWBACK` audit
  event); failed on-chain or expired → rebuilt; not found within `maxTime + 30s` →
  `ClawbackPendingError` (`.retryAfter`).
- The same id with a different deal, asset, issuer, holder or amount → `ClawbackIdConflictError`
  (amounts compare at 7 decimals, so `'5'` and `'5.0000000'` are the same clawback).
- Full-balance mode reads the holder's balance (`BalanceLookup`) and claws back all of it.
  With nothing left — the repeat of a completed full-balance clawback, or no trustline —
  it throws `NothingToClawBackError` instead of submitting a zero clawback. Without an id,
  that is its only retry protection (plus the issuer's sequence number while a first attempt
  is still in flight); pass an id for exact-once semantics and by-hash resolution.
- `TrustlineAuthorizerDeps` gains `clawbackStore` (default in-memory) and `ledger` (lookups;
  defaults to `submitter`, which `TxSubmitter` satisfies).

**Concurrency**: a second `provision()` for the same deal, `settle()` for the same
settlement id, or `clawback()` for the same clawback id, is refused with
`OperationInProgressError` while the first is in flight. The guard is shared by every
service built over the same store instance; the state lock below makes that the only
instance.

**Stores**: `MemoryIssuerStore` / `JsonFileIssuerStore(path, key)`,
`MemorySettlementStore` / `JsonFileSettlementStore(path)` and
`MemoryClawbackStore` / `JsonFileClawbackStore(path)`. JSON files are replaced
atomically (temp file, mode `0600`, fsync, rename). Issuer secrets are sealed with
AES-256-GCM (`SecretBox`, 32-byte key) and bound to `issuer:<dealId>` as associated
data; the file never contains a plaintext secret. Loading fails closed: a wrong key, a
tampered record or a corrupt file throws instead of starting empty.

**State lock (one process per state directory)**: opening a JSON-file store creates
`<its directory>/.lock` with flag `wx`, containing `{pid, hostname, startedAt}`.

- Held by a live process (or by a host whose processes cannot be checked) →
  `StateLockedError` naming the holder (`.holder`), nothing is read.
- Holder on this host and gone (`process.kill(pid, 0)` → `ESRCH`) → stale, taken over
  (a `.lock.takeover` file serializes concurrent takeovers). A lock carrying this process's
  own pid but taken before this process started (pid reuse, e.g. pid 1 in containers) is
  stale as well. An unreadable lock is never taken over.
- Stores of one process in one directory share the lock (reference-counted), so
  `createIssuance` with `STATE_DIR` holds exactly one; a second instance of the same file in
  the same process is refused too.
- `close()` (stores, and `IssuanceService.close()`) waits for queued writes and releases the
  lock; locks still held are removed on normal process exit. A killed process leaves its
  lock behind for the next start on the same host to take over.

## Upgrade notes (breaking changes)

- **`clawback()` with an explicit amount needs a `clawbackId`.** The old call
  `clawback(deal, kp, holder, amount)` no longer type-checks and, from untyped callers,
  throws `ClawbackIdRequiredError` without submitting. Use
  `clawback(deal, kp, holder, { amount, clawbackId })` or `clawback(deal, kp, holder, amount, clawbackId)`.
  The result (`ClawbackResult`) still satisfies `OffboardingRecord`. A clawback with an id
  needs `transactionOutcome` from `deps.ledger` or the submitter (`TxSubmitter` has it), and a
  full-balance clawback needs `assetBalance`; a missing lookup is a `TypeError` up front.
- **JSON-file stores are exclusive.** Opening a second `JsonFile*Store` on the same file
  (or any store in a directory another process holds) throws `StateLockedError`; close the
  first with `await store.close()` (or `IssuanceService.close()`) before reopening. Opening a
  store now creates its directory and `.lock` immediately.
- `createIssuance` with `STATE_DIR` also writes `clawbacks.json`; `IssuanceService` gains
  `close()`. Store ports gain an optional `close()`; the `CLAWBACK` audit event gains the
  optional fields `clawbackId`, `fullBalance` and `resolvedByHash`.

## D1 acceptance criteria mapping

| SCF D1 criterion | Where |
| --- | --- |
| Issuer/asset resolve with verified domain (SEP-1) | `IssuerProvisioner` (home_domain) + `generateStellarToml`; live test asserts toml is emitted |
| Non-KYC wallet rejected at protocol level (`op_not_authorized`); KYC-approved wallet authorized and receiving | `test/live-testnet-lifecycle.test.ts` — asserted against real testnet result codes |
| Authorization service API documented; integration tests passing with >=90% coverage on the authorization path | This README + `test/authorization-gate.test.ts`, `test/trustline-authorizer-errors.test.ts`, `test/static-gate.test.ts`, `test/urbanflip-gate.test.ts`, `test/tx-submitter.test.ts`, `test/clawback-store.test.ts`, `test/provisioning-structure.test.ts`, `test/provisioning-idempotency.test.ts`, `test/settlement-idempotency.test.ts`, `test/clawback-idempotency.test.ts`, `test/state-lock.test.ts`; coverage gate below |
| Clawback and freeze flows executed and verifiable | `TrustlineAuthorizer.freeze/clawback`; executed on testnet in demo and live test |

## Coverage (D1 criterion 3)

```bash
npm run coverage   # vitest run --coverage (v8); text table + coverage/coverage-summary.json + coverage/index.html
```

**The authorization path** is the code that decides and executes trustline authorization
and offboarding. These files are listed in `AUTHORIZATION_PATH` in `vitest.config.ts`, and
each one must reach **90% statements, branches, functions and lines on its own**.
`npm run coverage` exits non-zero if any of them drops below that, including a file no test
imports, which counts as 0%.

| File | Role | Stmts | Branch | Funcs | Lines |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/gate/compliance-gate.ts` | gate port, `GateRejectedError` / `GateUnavailableError` | 100 | 100 | 100 | 100 |
| `src/gate/static-gate.ts` | static allowlist adapter | 100 | 100 | 100 | 100 |
| `src/gate/urbanflip-gate.ts` | Urbanflip HTTP adapter (retries, timeout, fail closed) | 100 | 100 | 100 | 100 |
| `src/issuance/trustline-authorizer.ts` | authorize (gate first), freeze, clawback | 100 | 98.86 | 100 | 100 |
| `src/store/clawback-store.ts` | clawback journal (memory + JSON file) | 100 | 100 | 100 | 100 |
| `src/issuance/in-flight.ts` | concurrent same-id clawback refused | 100 | 100 | 100 | 100 |
| `src/issuance/pending-tx.ts` | PENDING tx: applied / never applies / may still apply | 100 | 100 | 100 | 100 |
| `src/issuance/issuer-provisioner.ts` | issuer flags strictly before any trustline | 100 | 100 | 100 | 100 |
| `src/stellar/tx-submitter.ts` | rejected (did not apply) vs unknown (may apply) | 100 | 100 | 100 | 100 |
| **Authorization path, aggregate** | | **100** (331/331) | **99.56** (227/228) | **100** (80/80) | **100** (298/298) |

Measured on 2026-10-24 with vitest 5.0.5 and @vitest/coverage-v8 5.0.5: 138 tests passed,
7 skipped (the opt-in live testnet suite). All of `src/` together comes to 91.28 / 82.52 /
92.72 / 93.11. Settlement, SEP-1, the other stores, the audit log, config and the
composition root (`src/index.ts`) appear in the report but are not held to the threshold.
`src/testkit`, `demo`, `test` and `dist` are excluded from the report, and so is
`src/types.ts`, which contains only type declarations.

The one uncovered branch is the `?? 0` fallback in
`maxTime: Number(tx.timeBounds?.maxTime ?? 0)` in `TrustlineAuthorizer`. It can't be
reached through the public API because every clawback transaction is built with
`setTimeout(30)` and so always has a `maxTime`. It stays in the code as a defensive default
and is not excluded from the count.

## Production notes (deliberately out of scope here)

- **Key management**: `JsonFileIssuerStore` keeps issuer secrets sealed on local disk so a
  lost response can never strand a funded issuer. Production backs the `IssuerStore`
  port with a KMS/HSM (the submission's T3/D8 key ceremony) and keeps `STATE_KEY` in a
  secrets manager.
- **Retries of flag operations**: `authorize()` and `freeze()` only set flags and are safe
  to retry; `clawback()` is idempotent per `clawbackId` (see above).
- **Shared state across hosts**: the state lock checks liveness only on the holder's own
  host; on a network filesystem shared by several hosts, a lock from another host is never
  taken over automatically (delete it once that host's process is known to be gone).
- **TOML hosting**: `LocalSep1Publisher` writes the file; production serves it at
  `https://urbanflip.io/.well-known/stellar.toml` behind the existing site/CDN.
- **Sequence-number management** under concurrency (per-issuer sequence tracking).
- Rate limiting/circuit breaking on the gate adapter beyond the built-in retry.

## Layout

- `src/gate/` — the `ComplianceGate` port and its two adapters
- `src/issuance/` — issuer provisioning, gate-gated trustline authorization, settlement, asset-code rules
- `src/store/` — issuer, settlement and clawback stores (memory + JSON file), `SecretBox` sealing, the state-directory lock
- `src/stellar/` — `TxSubmitter`: submission with rejected/unknown classification, lookups by hash
- `src/sep1/` — stellar.toml generation and publication
- `src/audit/` — JSONL audit log
- `src/testkit/` — investor-side helpers and the full lifecycle runner (demo/test only)
- `test/` — offline suites + opt-in live testnet suite (`RUN_LIVE=1`)
