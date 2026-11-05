# D3.2 Replay of 3 completed real deals

> **Criterion (as submitted):** Replay of 3 completed real deals' actual payout data reproduces historical amounts exactly.

**Result:** 149 recorded settlements x 7 components = **1043 amounts, every one reproduced to the cent** (difference 0.00 EUR per investor and in total), given 2 paid amounts that depart from the rule, each declared as an adjustment with its reason, and 1 declared position with no payout record (see Exceptions).

The engine and replay logic are public: `src/compute/waterfall.ts`, `src/compute/waterfall-replay.ts`, API `POST /v1/deals/{dealId}/waterfall/replay` (api/openapi.yaml); `npm test` replays synthetic deals everywhere and skips the real-deal suite unless the private `fixtures/real` is present. The input files below are private; their SHA-256 digests pin exactly what this report was computed from.

| Deal | Payout date | Positions | Settlements compared | Amounts compared | Differences | Net paid (recorded) | Net (computed) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Velázquez 87 | 2025-09-17 | 52 | 51 | 357 | 0 | 979,398.92 | 979,398.92 |
| Orense 9 | 2026-06-22 | 51 | 51 | 357 | 0 | 1,949,852.50 | 1,949,852.50 |
| General Perón 26 | 2025-11-26 | 47 | 47 | 329 | 0 | 1,721,056.12 | 1,721,056.12 |

## How a settlement is computed

Each position is a fixed tranche plus a variable tranche (Urbanflip participative loans):

```
fixed interest     = fixed principal x rate x accrual         (act/365, or 2-decimal months)
variable interest  = variable pool x weight / total weight     (weight: capital, or capital x days)
fee                = fee pool x weight x feeShare / total fee-bearing weight
interest after fee = fixed + variable - fee
withholding        = interest after fee x withholding rate
net paid           = principal + interest after fee - withholding
```

- **Exact arithmetic.** Money is integer cents, rates exact decimals; no float anywhere.
- **Rounding rule (as the platform settled):** every row is rounded half up to the cent on its own. Leftover cents are not redistributed: the difference between a pool and the sum of its rows (the residual below) stays with the SPV when positive and was paid by it when negative.
- **Live payouts** computed by the engine use largest-remainder instead: the rows sum to each pool exactly, the leftover cents going to the largest fractional remainders, ties by investorId. Only those results are converted to USDC and emitted as SDP files.
- **Investor ids** are pseudonyms: HMAC-SHA256 with a salt held only by Urbanflip, per deal (the same investor cannot be linked across deals). Amounts and dates are real.

## Velázquez 87

Payout 2025-09-17 · fixed tranche actual/365 · variable and fee by capital x days · variable pool 163,528.80 · fee pool 51,081.62 · residual: variable 0.00, fee 0.00

- Fixed tranche: principal x rate x days / 365, days = payout date - start date. Variable tranche and fee: shared by capital x days.
- variablePool and feePool are not in the export. They are the deal-level amounts that reproduce every row under the rule, found by exact interval intersection over all rows: variable pool in [163528.7802, 163528.8235] (163,528.79 to 163,528.82 all fit; the row sum, 163,528.80, is used), fee pool in [51081.5956, 51081.6294] (the row sum, 51,081.62, is used). Confirmed by Urbanflip (2026-11-01).
- Terms: fixed rate 0.08 x51, 0.09 x1; fee share 1 x43, 0 x9; withholding 0.19 x43, 0.10 x2, 0 x7. fixedRate, feeShare and withholdingRate are not in the export: read off each payout within closed sets ({0.08, 0.09}, {1, 0.5, 0}, {0, 0.19, 0.10}) unless stated in fixtures/real/deals.config.json.

| Component | Recorded | Computed | Difference |
| --- | ---: | ---: | ---: |
| Principal | 873,250.00 | 873,250.00 | 0.00 |
| Fixed interest | 13,569.40 | 13,569.40 | 0.00 |
| Variable interest | 163,528.80 | 163,528.80 | 0.00 |
| Success fee | 52,489.37 | 52,489.37 | 0.00 |
| Interest after fee | 124,608.83 | 124,608.83 | 0.00 |
| Withholding | 18,459.91 | 18,459.91 | 0.00 |
| Net paid | 979,398.92 | 979,398.92 | 0.00 |

## Orense 9

Payout 2026-06-22 · fixed tranche months = (days + 1) / 30.4375, 2 decimals · variable and fee by capital · variable pool 336,335.19 · fee pool 28,606.03 · residual: variable 0.08, fee -0.03

- Fixed tranche: months = (payout date - start date + 1) / 30.4375 (365.25 / 12), rounded to 2 decimals; interest = principal x 8% / 12 x months. Reconstructed from the payouts: it reproduces 38 of the 39 fixed tranches (a 30.436875-day month fits equally well). Velázquez 87 and General Perón 26, settled earlier, use actual/365. Confirmed by Urbanflip (2026-11-01).
- Variable tranche and fee: shared by capital only (not by days): every 2,500.00 variable position gets 580.71 whatever its start date.
- variablePool and feePool are not in the export. They are the only cent amounts that reproduce every row under the rule (exact interval intersection over all rows): variable pool in [336335.1843, 336335.1920], fee pool in [28606.0248, 28606.0400]. Per-row rounding left the variable rows 0.08 under the pool (they sum to 336,335.11) and the fee rows 0.03 over it (28,606.06). Confirmed by Urbanflip (2026-11-01).
- Terms: fixed rate 0.08 x51; fee share 1 x46, 0.5 x2, 0 x3; withholding 0.19 x37, 0 x14. fixedRate, feeShare and withholdingRate are not in the export: read off each payout within closed sets ({0.08, 0.09}, {1, 0.5, 0}, {0, 0.19, 0.10}) unless stated in fixtures/real/deals.config.json.

| Component | Recorded | Computed | Difference |
| --- | ---: | ---: | ---: |
| Principal | 1,671,305.70 | 1,671,305.70 | 0.00 |
| Fixed interest | 24,895.90 | 24,895.90 | 0.00 |
| Variable interest | 336,335.11 | 336,335.11 | 0.00 |
| Success fee | 28,606.06 | 28,606.06 | 0.00 |
| Interest after fee | 332,624.95 | 332,624.95 | 0.00 |
| Withholding | 54,078.15 | 54,078.15 | 0.00 |
| Net paid | 1,949,852.50 | 1,949,852.50 | 0.00 |

## General Perón 26

Payout 2025-11-26 · fixed tranche actual/365 · variable and fee by capital x days · variable pool 196,692.19 · fee pool 19,301.24 · residual: variable 0.04, fee 0.00

- Fixed tranche: principal x rate x days / 365. Variable tranche and fee: shared by capital x days.
- variablePool and feePool are not in the export. They are the only cent amounts that reproduce every row under the rule (exact interval intersection over all rows): variable pool in [196692.1828, 196692.1951], fee pool in [19301.2362, 19301.2496]. Per-row rounding left the variable rows 0.04 under the pool (they sum to 196,692.15); the fee rows sum to the pool. Confirmed by Urbanflip (2026-11-01).
- Terms: fixed rate 0.08 x46, 0.09 x1; fee share 1 x43, 0.5 x2, 0 x2; withholding 0.19 x40, 0 x6, 0.10 x1. fixedRate, feeShare and withholdingRate are not in the export: read off each payout within closed sets ({0.08, 0.09}, {1, 0.5, 0}, {0, 0.19, 0.10}) unless stated in fixtures/real/deals.config.json.

| Component | Recorded | Computed | Difference |
| --- | ---: | ---: | ---: |
| Principal | 1,563,509.00 | 1,563,509.00 | 0.00 |
| Fixed interest | 12,488.94 | 12,488.94 | 0.00 |
| Variable interest | 196,692.15 | 196,692.15 | 0.00 |
| Success fee | 19,301.24 | 19,301.24 | 0.00 |
| Interest after fee | 189,879.85 | 189,879.85 | 0.00 |
| Withholding | 32,332.73 | 32,332.73 | 0.00 |
| Net paid | 1,721,056.12 | 1,721,056.12 | 0.00 |

## Exceptions

- **Velázquez 87:** a success fee set by hand at settlement for a position the rule leaves without one, entered as a declared override; the figures are kept in the private record.
- **Velázquez 87:** a position with no payout record in the export, declared unrecorded and excluded from the comparison.
- **Orense 9:** a fixed interest paid 0.66 EUR below the rule, entered as a declared override; the rule figure is kept beside it in the private record.

Confirmed by Urbanflip on 2026-11-01: the deal-level pools (not in the export; each is the cent amount that reproduces every row), the investor terms (read off the payouts within closed sets), the Orense 9 month formula, and the three exceptions above.

## Provenance and privacy

Investor-level payout data is personal data and stays out of this repository: it lives in Urbanflip's private repo, pseudonymized per deal (HMAC-SHA256 with a salt held only by Urbanflip, so one investor cannot be linked across deals). Pseudonymized per-investor rows are available to reviewers on request.

Each private input file this replay was computed from is pinned below; a reviewer holding the private data verifies the report by matching these digests and re-running `npm run replay:report`.

| Private input file (fixtures/real/) | SHA-256 |
| --- | --- |
| deals.config.json | 6d6cb759c312757d0bd573cbc0ada5f2e900e5df2a9eb83a592d9a1ac4ef2103 |
| velazquez-87.json | 8473b4e75a5cada451148647af5ef8b79136e55878f4a6366914c528334a2a87 |
| orense-9.json | d699750aeea1dd86d07286f2da07b7ee2236186f15ffc05ca4c3784ee80bcf82 |
| general-peron-26.json | 1077ae97f9513da44e874870b3e4af18a75818d0c689c81e63fa45ad461f0a6c |
