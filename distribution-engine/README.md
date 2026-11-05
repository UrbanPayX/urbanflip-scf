# distribution-engine

**SCF #45 Tranche 1, Deliverable 3** - Pro-rata distribution engine.

Computes per-investor **EUR** settlements with **Urbanflip's participative-loan
waterfall** (fixed tranche + pro-rata share of the variable profit, less success
fee and withholding), converts them at the USDC the treasury actually bought and
emits **SDP-ready USDC payment files** (`amount,id,destination,memo,memo_type`,
10,000-row batches), pre-checks destination trustlines against Horizon, and
**replays three completed real deals' recorded payouts to the cent** (1,043
amounts, [evidence/d3-replay-report.md](evidence/d3-replay-report.md)).

## Design: exact integer money

Every amount is a BigInt stroop (10^-7, Stellar's own precision) or a BigInt
unit at the recorded ledger's precision (10^-2 for EUR bank records). There
are no floats in any computation path. Interest allocation floors each share
and redistributes the dust deterministically under an explicit policy:

- `largest-remainder` - +1 unit to the largest fractional remainders,
  ties broken by investorId (deterministic across runs and replays);
- `last-absorbs` - dust lands on the final position (the convention some
  legacy bank ledgers used, needed to replay older deals).

Either way, **the sum of rows always equals the outcome totals exactly** -
there is no rounding drift, by construction and by test. Amounts finer than
the computation precision (e.g. `8.005` at `decimals: 2`) are refused with an
error, never truncated.

## Urbanflip's waterfall (`src/compute/waterfall.ts`)

How the platform settles a completed deal, reconstructed from the payouts of
Velázquez 87, Orense 9 and General Perón 26 and reproduced to the cent:

```
fixed interest     = fixed principal x rate x accrual          act/365, or 2-decimal months
variable interest  = variablePool x weight / total weight       weight: capital, or capital x days
fee                = feePool x weight x feeShare / fee-bearing weight
interest after fee = fixed + variable - fee
withholding        = interest after fee x withholding rate
net                = principal + interest after fee - withholding
```

- Per position: `fixedRate` (8%, one investor 9%), `feeShare` (1, 0.5, 0) and
  `withholdingRate` (19%, 10%, 0) are terms; per deal: the accrual basis, the
  weighting and the two pools.
- `rounding: 'per-row-half-up'` is the platform's convention (each row rounded
  on its own; the rows may miss a pool by a few cents, reported as `residual`).
  `'largest-remainder'` (the default) makes the rows sum to each pool exactly;
  only such a result converts to a payable schedule (`toDistributionSchedule`,
  each investor owed their net), so live payouts never drift.
- Manual corrections made at settlement enter only as `adjustments` with a
  reason, kept beside the rule's figure.

The simple model (`src/compute/pro-rata.ts`: principal + interest pro-rata by
principal) is kept for the backend's handoff and its tests.

## EUR schedule -> USDC payment file

Every loan is EUR-denominated, so schedules are EUR. Investors paid on-chain
receive USDC: the treasury converts the cohort's EUR total, and the USDC it
actually bought (`usdcFunded`) is split pro-rata to each investor's EUR payout,
exact to the cent (largest remainder, ties by investorId). The batch pays
exactly what was funded and everyone gets the same rate.

```ts
const schedule = computeDistribution(ledger, outcome);          // EUR
const conversion = convertOnChain(schedule, '39060.00', {       // USDC bought
  onChainCohort: usdcPayees,                                    // mixed deal: others paid by bank
  onlyAddresses: readySet,                                      // optional trustline gate
});
conversion.otherRail;                                           // bank-paid rows, with EUR amounts
const files = emitSdpFiles(conversion);                         // CSV amounts = USDC
```

- `convertOnChain` refuses: `usdcFunded` with more than 2 decimals; an implied
  rate outside **0.5-2 USDC per EUR** (catches swapped or mistyped amounts);
  a payout that would round to 0.00 USDC; rows without a wallet address
  (outside `onChainCohort`, when given, rows are reported in `otherRail`
  instead of converted); with `onlyAddresses`, any converted row outside the set
  or any requested address missing from the schedule (no silent exclusions);
  wallet addresses that are not a checksum-valid Stellar account StrKey
  (`G...`, via the SDK's `StrKey`).
- `emitSdpFiles` takes **only** a `UsdcConversion` (breaking change: it no
  longer accepts the schedule, and throws if handed one at runtime), so EUR
  amounts can never be emitted as USDC. It re-checks each destination and
  2-decimal amount at the sink, and quotes `id` fields containing `,` `"` CR
  or LF, so every row is exactly 5 fields.

## Replay (acceptance criterion D3.2)

`fixtures/real/` holds the three completed deals Urbanflip exported
(Velázquez 87, Orense 9, General Perón 26: 149 recorded settlements, EUR 4.65M
net paid), with pseudonymized investor ids and real amounts and dates.
`replayWaterfall` recomputes each deal and diffs **all seven components**
(principal, fixed interest, variable interest, fee, interest after fee,
withholding, net) of every settlement: **1,043 amounts, 0 differences**
(`test/waterfall.test.ts`; report: [evidence/d3-replay-report.md](evidence/d3-replay-report.md)).

- **Exceptions are declared, never absorbed:** 2 paid amounts depart from the
  rule (a manual fee in Velázquez 87, 0.66 EUR of fixed interest in Orense 9)
  and enter as adjustments with their reason; 1 position has no payout record
  and is declared as such. A test proves the adjustments explain their own
  positions and nothing else, and a one-cent change anywhere is detected.
- **What was reconstructed, confirmed by Urbanflip on 2026-11-01:** the export has
  no deal-level pools and no investor terms. Each pool is the cent amount that
  reproduces every row (exact interval intersection; for Orense 9 and General
  Perón 26 it is the only one, and a pool one cent off fails the test). Terms
  are read off each payout within closed sets. See `fixtures/real/deals.config.json`.
- **Import** (at Urbanflip, never in CI): `PSEUDONYM_SALT=<hex> npm run
  import:export -- <export.xlsx>` checks the export's consistency, pseudonymizes
  ids per deal (HMAC-SHA256, salt held by Urbanflip) and rewrites the fixtures,
  all or nothing. The raw export is gitignored.

The synthetic fixtures in `fixtures/` (8 / 17 / 29 investors) still exercise
the simple model's dust policies.

## API

`api/openapi.yaml` (published spec) is implemented by a dependency-free
`node:http` server (`src/api/server.ts`):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/deals/{dealId}/waterfall` | settle a deal with the waterfall; a largest-remainder result becomes the payable schedule |
| `POST /v1/deals/{dealId}/waterfall/replay` | diff every component against the recorded settlements |
| `POST /v1/deals/{dealId}/ledger` | register the loan ledger (simple model) |
| `POST /v1/deals/{dealId}/distributions` | compute schedule (stroop precision) |
| `POST /v1/deals/{dealId}/distributions/replay` | diff against historical payouts |
| `POST /v1/distributions/{dealId}/sdp-files` | body `{ usdcFunded, onChainCohort?, onlyAddresses? }` (required): USDC conversion + SDP CSV payment files |
| `POST /v1/trustline-check` | READY / NO_ACCOUNT / TRUSTLINE_MISSING / TRUSTLINE_UNAUTHORIZED per address |

## Run

```bash
npm test                       # 60 offline tests
npm run coverage               # per-file 90% gate on the computation logic (vitest.config.ts)
npm run demo                   # real replay + live waterfall + USDC conversion + SDP emission
npm run replay:report          # regenerate evidence/d3-replay-report.{md,json}
RUN_LIVE=1 npm run test:live   # trustline checker against real Horizon testnet
```

Measured coverage of the computation logic (`src/money/stroops.ts`,
`src/compute/{pro-rata,replay,waterfall,waterfall-replay}.ts`), 2026-10-28,
vitest 5.0.5 + @vitest/coverage-v8: **100% statements (274/274), 99.31%
branches (143/144), 100% functions (67/67), 100% lines (225/225)**
(criterion: >= 90%; every file is held to 90% on its own). Whole package:
93.58 / 91.37 / 96.15 / 94.1.

## Production notes (out of scope here)

- Actual SDP deployment: **Tranche 2 (D4)** - this engine's USDC files are the
  direct input to that deliverable. Buying the USDC (`usdcFunded`) is a
  treasury step outside the engine.
- The trustline pre-check complements D1's authorization service: D1 guarantees
  the trustline at onboarding, this re-verifies immediately before a batch.
- Durable stores, authn/authz on the API, and scheduler integration live in the
  platform, not the engine.
- `urbanflip-backend` (Rust) still carries the simple model (`domain/prorata.rs`);
  porting the waterfall there is the next step before it settles a real deal.
