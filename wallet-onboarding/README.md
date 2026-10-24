# wallet-onboarding

**SCF #45 Tranche 1, Deliverable 2** — Invisible-crypto wallet onboarding.

Investors register with the email they already have; a wallet appears; their
Stellar account and trustlines are created — and they hold **zero XLM at every
step**. The channel (operations) account sponsors all reserves (CAP-33) and
pays all fees (fee-bump). Same pattern as D1: the core depends on ports, and
concrete providers are adapters.

```
 investor (email)          backend                          Stellar
 ─────────────────  ───────────────────────────────  ─────────────────
 register ─────────► WalletProvider.getOrCreateWallet
                    (Privy stellar wallet, raw_sign,
                     or DevKey provider in tests)
                    SponsorService reads the account first ──────────► skip steps already
                    (LedgerReader)                                      on-chain
                    ┌──────────────────────────────────────────────┐
                    │ InvestorTxPipeline (the ONLY submit path)    │
                    │  1. idempotency check: applied → returned;   │
                    │     unknown → settled by hash on Horizon     │
                    │  2. build inner tx (source = channel)        │
                    │  3. channel signs                            │
                    │  4. WalletProvider.signRaw(txHash) ──────────┼──► raw Ed25519 sig
                    │  5. VERIFY signature locally (fail fast)     │
                    │  6. addSignature (investor)                  │
                    │  7. wrap in fee-bump (channel pays), record  │
                    │     its hash + maxTime, then submit   ───────┼──► submit
                    │  8. lost response → one retry, same envelope │
                    └──────────────────────────────────────────────┘
                    SponsorService builds the CAP-33 envelopes:
                      [beginSponsoring(investor),
                       createAccount(investor, 0 XLM)   — or changeTrust(source: investor)
                       endSponsoring(source: investor)]  ← must be investor-sourced
```

External wallets (Stellar Wallets Kit) skip sponsorship — those users manage
their own keys and XLM — but arrive on the same pipeline: an (address, raw
signature) pair is all the backend ever consumes from any wallet.

## Guarantees (all tested)

- **100% fee-bump coverage**: `InvestorTxPipeline` has no code path that submits
  a bare investor transaction; every submission is wrapped with the channel as
  fee source.
- **Signature verification before submission**: a wallet signature that does not
  verify against the investor's address raises `SignatureRejectedError` and
  nothing is sent.
- **Duplicate safety**: a key whose transaction applied returns the recorded
  outcome; nothing is rebuilt or resubmitted. Concurrent calls with one key
  share a single submission.
- **Retry policy**: a definitive rejection (Horizon result codes) is recorded as
  `failed` and rebuilt on the next call. A lost response (504, timeout, dropped
  connection: no result codes) is retried once with the identical envelope and
  then recorded as `unknown` with its hash and `maxTime` (written before the
  first submission, so a crash is covered too). The next call looks the hash up
  on Horizon: applied → `submitted`, nothing resubmitted; failed on-chain or
  still absent 30s after `maxTime` → rebuilt; absent before that →
  `SubmissionPendingError` (`retryAfter`, unix seconds). Investor transactions
  must therefore carry a bounded timeout.
- **Re-runnable onboarding**: `provisionInvestorAccount` creates the account only
  when Horizon returns 404; `openSponsoredTrustline` skips a trustline that
  exists for the exact asset (code AND issuer — idempotency keys include the
  issuer too). Skipped steps return `alreadyExisted: true` and no `txHash`. A
  second deal, a retry after an unknown outcome, or a restart is safe.
- **Zero-XLM by construction**: accounts are created with `startingBalance: 0`
  inside a sponsorship sandwich; reserves come from the channel. For an account
  that already existed, `zeroXlm` reports its current native balance.

## Run

```bash
npm test                    # offline suites (54 tests)
npm run demo                # single-investor live walkthrough on testnet
RUN_LIVE=1 npm run test:live  # 21 sponsored accounts, zero-XLM assertions
```

Live evidence from the latest run: 21/21 investors holding exactly `0.0000000`
XLM with open sponsored trustlines, 3 parallel channels, ~80s total. The live
suite also re-runs onboarding through a fresh pipeline (a restart: nothing is
submitted) and opens `UF42` from a second issuer as a distinct trustline.

## Wiring

`createOnboarding({ horizonUrl, networkPassphrase, channelSecret, ... })`.
Reads (`LedgerReader`: `loadAccountSnapshot`, `transactionOutcome`) default to
the submitter — `TxSubmitter` implements both ports; a custom `submitter` must
implement `LedgerReader` too or come with `ledger`, otherwise construction
fails. The idempotency ledger still defaults to in-memory; the chain checks
keep onboarding correct across restarts, but production should persist it.

## Privy setup

`PrivyWalletProvider` talks to Privy's server-side wallet REST API. New
investors get a native **`stellar`** wallet (Privy tier-2 chain): its address
is the investor's G-address, and the backend asks Privy to `raw_sign` the
32-byte Stellar transaction hash. The pipeline verifies every signature
against the investor's address before anything is submitted.

### Required configuration

The package reads no environment variables itself. Pass these in (suggested
env names in brackets):

| Option | Required | Meaning |
| --- | --- | --- |
| `appId` (`PRIVY_APP_ID`) | yes | Privy app id: sent as `privy-app-id` and as the Basic-auth username |
| `appSecret` (`PRIVY_APP_SECRET`) | yes | Privy app secret: the Basic-auth password. Server-side only |
| `directory` | yes in production | Where the investorId → wallet binding is stored. The default is in-memory and is lost on restart |

```ts
new PrivyWalletProvider({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
  directory: new JsonFileWalletDirectory('/var/lib/urbanflip/wallets.json'),
});
```

Optional settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `chainType` | `'stellar'` | `'solana'` creates Ed25519 Solana wallets instead. They are signed with `rpc` `signMessage`, and the base58 address is re-encoded as a G-address by `toStellarAddress` |
| `externalId` | `defaultExternalId` | The wallet's `external_id`: `inv-<investorId>`, or `invh-<sha256>` when the id is not URL-safe or is longer than 60 characters. Privy keeps it unique per app and write-once, so it must stay stable for the life of the app. `false` turns it off |
| `createIdempotencyKey` | `wallet-create:<external_id>` | The `privy-idempotency-key` sent on create. `false` turns it off |
| `privyUserId` | none | `(investorId, email) => 'did:privy:…'`. Links the wallet to the investor's Privy user as its `entity`. This records who the wallet is for but gives that user no control over it |
| `ownerId` + `authorizationSignature` | none | Makes a key quorum the wallet's owner. Each signing request then carries `privy-authorization-signature`. `privyAuthorizationSigner('wallet-auth:…')` builds it as the docs describe |
| `baseUrl`, `timeoutMs`, `fetchImpl` | `https://api.privy.io`, 8 s, global `fetch` | Transport settings |

Breaking change: the earlier `authToken` (Bearer) and `signPath` options are
gone. Privy does not document either one.

### Request flow

1. Look in `directory` first. If the investor is bound, no Privy call is made.
2. `GET /v1/wallets?external_id=…` finds a wallet Privy already holds for
   this investor, for example after a lost directory or a lost create
   response. A match is bound and no new wallet is created.
3. `POST /v1/wallets` sends `{ chain_type, external_id, entity?, owner_id? }`
   with a stable `privy-idempotency-key`.
   - If the response is lost (timeout or dropped connection), the next
     attempt reuses the same key, so Privy replays the result instead of
     creating a second wallet.
   - If Privy answers with an error, it caches that error under the key for
     24 hours. The next attempt in this process therefore appends
     `:retry-N` to the key.
   - If the create is refused, the adapter looks the wallet up by
     `external_id` once more, because the wallet may already exist.
4. The record `{ walletId, address, chainType }` is written to the directory
   before the handle is returned.
5. Signing:
   - `stellar` wallets: `POST /v1/wallets/{id}/raw_sign` with
     `{ params: { hash: '0x<hex>' } }`. Privy returns
     `data.signature = '0x<128 hex>'` and `encoding: 'hex'`.
   - `solana` wallets, including directory records from before chain types
     were stored: `POST /v1/wallets/{id}/rpc` with
     `{ method: 'signMessage', params: { message: <base64>, encoding: 'base64' } }`.
     Privy returns `data.signature` in base64.

Wallets are created **without an owner**. Privy then needs only the app
secret (Basic auth) to sign. A wallet owned by a user (`owner: { user_id }`)
would need that user's JWT for every signature. The backend signs while the
investor is offline, so that option is deliberately not offered. Use
`privyUserId` (entity) to link the wallet to the user.

### Verified against Privy's docs

| Fact | Source |
| --- | --- |
| Base URL `https://api.privy.io`. Every request needs `Authorization: Basic base64(appId:appSecret)` and `privy-app-id` | [REST API setup](https://docs.privy.io/basics/rest-api/setup) |
| `POST /v1/wallets`: `chain_type` (enum includes `stellar` and `solana`), `external_id`, `entity`, `owner`/`owner_id`, `additional_signers`. Extra fields are not allowed. Optional `privy-idempotency-key` with a 24 h window | [Create wallet](https://docs.privy.io/api-reference/wallets/create) |
| Idempotency: key of at most 256 characters. Same key and same body replays the stored response. Same key and a different body returns 400. On wallet create, both 4xx and 5xx are cached, so a retry after an error needs a new key | [Idempotency keys](https://docs.privy.io/guide/server-wallets/idempotency-key) |
| `external_id`: unique per app, write-once, `[a-zA-Z0-9_-]{1,64}`. Can be looked up with `GET /v1/wallets?external_id=` or `/v1/wallets/ext_wal_<id>` | [External IDs](https://docs.privy.io/wallets/wallets/external-ids), [Get wallets](https://docs.privy.io/api-reference/wallets/get-all) |
| Stellar is a tier-2 chain: Privy creates wallets for it and signs | [Chain support](https://docs.privy.io/wallets/overview/chains) |
| `raw_sign`: `{ params: { hash: '0x…' } }`. Returns `data.signature` as hex with `encoding: 'hex'`. Privy signs the hash as given. The Stellar example checks the signature with `Keypair.fromPublicKey(address).verify(hash, sig)` | [Raw sign API](https://docs.privy.io/api-reference/wallets/raw-sign), [Raw signing](https://docs.privy.io/wallets/using-wallets/other-chains/raw-sign), [Tier-2 recipe: Stellar](https://docs.privy.io/recipes/tier-2-wallet-integration) |
| Solana `rpc` `signMessage`: message and signature are both base64 | [signMessage](https://docs.privy.io/api-reference/wallets/solana/sign-message) |
| Owned wallets need `privy-authorization-signature` (app secret plus authorization key). The signature is computed over `{version:1, method, url, body, headers:{privy-app-id,…}}`, canonicalized with RFC 8785, then signed with ECDSA P-256/SHA-256 and base64-encoded. An ownerless wallet needs no owner signature | [Authorization signatures](https://docs.privy.io/api-reference/authorization-signatures), [Signing requests](https://docs.privy.io/controls/authorization-keys/using-owners/sign), [Direct implementation](https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation), [Security checklist](https://docs.privy.io/security/implementation-guide/security-checklist), [Automations](https://docs.privy.io/wallets/automations/create-and-attach) |
| `entity` (user or organization) records who the wallet is for. It grants no control and is immutable. A user-owned wallet needs the user's JWT to sign | [Wallet entities](https://docs.privy.io/kyc-kyb/entities), [Server-side user wallets](https://docs.privy.io/recipes/wallets/server-side-user-wallets) |
| A wallet can also be looked up by id with `GET /v1/wallets/{id}` | [Get wallet](https://docs.privy.io/api-reference/wallets/get) |

### Not yet verified (needs a sandbox run with real credentials)

- **Stellar address format.** The docs never show a sample `address` for a
  `stellar` wallet. The Stellar example passes it to `Keypair.fromPublicKey`,
  which implies a G-address. If Privy returns anything else, the adapter
  refuses the wallet.
- **`raw_sign` signature format.** The docs' sample signature is a
  placeholder. The adapter accepts 128 hex characters with or without `0x`.
- **Duplicate `external_id`.** The docs do not give the HTTP status for this
  error. The adapter re-checks by `external_id` after any error response.
- **Ownerless wallets.** No page says outright that `raw_sign` or `rpc` on an
  ownerless wallet needs only Basic auth. The automations page and the
  security checklist imply it.
- **`privyAuthorizationSigner`.** It is built from the docs (DER signature,
  base64) but has never been run against Privy.

## Wallet directory

`WalletDirectory` stores the investor → wallet binding. It is consulted before
any Privy call and written before a handle is returned, and concurrent first
calls share one lookup and create. `JsonFileWalletDirectory(path)`:

- Rewrites the file atomically (temp file and rename) with mode 0600.
- Fails closed if the file is unreadable.
- Allows only **one process per file**. The constructor creates
  `<file>.lock` with `wx`, holding `{pid, hostname, startedAt}`. If the lock
  already exists:
  - The adapter takes it over when it was written on this host by a pid that
    is gone (`process.kill(pid, 0)` returns `ESRCH`), for example after a
    SIGKILL.
  - It refuses with `WalletDirectoryLockedError`, naming the holder, when the
    holder is alive, on another host, or the lock file is unreadable. Delete
    the lock only after confirming that no process uses the file.
- Releases the lock on `close()` and on a normal process exit. SIGTERM
  without a handler leaves the lock behind as stale, and the next start takes
  it over.

Records written by earlier versions have no `chainType` and are read as
`solana`. Every earlier wallet was created as a Solana wallet.

## Production notes (out of scope here)

- Channel account key custody + rotation (T3/D8 key ceremony).
- Durable idempotency (here: in-memory; production: Postgres keyed by idempotency key).
- Multi-instance wallet directory (the JSON file adapter is single-process,
  enforced by its lock file): a database-backed `WalletDirectory` for HA.
- Privy webhook handling for wallet recovery events; SDP passkey wallets as the
  documented fallback path.
