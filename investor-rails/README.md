# investor-rails

The backend's rail orchestration layer: it differentiates fiat investors from
crypto-native investors and drives the money movement around the participation
token - collection for crypto-native subscriptions, the raise-close off-ramp,
and the distribution-day split into SDP (on-chain) and SEPA (bank) worklists.

## The rail model

Every investor has a rail profile; the participation token is independent of it
(all investors hold units whatever their rails):

| rail | values | rules |
| --- | --- | --- |
| subscription | `FIAT_WIRE` (default) / `USDC_ONCHAIN` | crypto-native requires wallet screening evidence (`screeningRef`, Merkle T2) - no screening, no trustline |
| payout | `FIAT_BANK` / `USDC_ONCHAIN` | fiat payout requires IBAN + account name |

## Crypto-native subscription: collect → off-ramp → issue

The one legal invariant this package enforces above all others: **units are
minted only when EUR is at the SPV.** Every loan is EUR-denominated and **one
participation unit is EUR 1 of loan principal, whatever the rail**. A
crypto-native investor commits a EUR amount and pays the USDC the ramp quotes
for it; their units are the EUR commitment, never the USDC amount. FX is
Urbanflip's, not the investor's: a conversion that lands short is topped up by
Urbanflip before anything mints, a surplus is recorded as an FX gain, and the
investor's units never move. The crypto-native journey:

1. `CryptoCollectionService.expectPayment({ eurAmount, usdcAmount, quoteRef?, ... })`
   - records the EUR commitment and its USDC quote, with a unique memo
   (`UF-<deal>-<subscriptionRef>`); the investor pays the USDC from **their own
   wallet** to the company collection address. Refused, never overwritten: a
   subscription already expected, an invalid amount, a quote whose implied rate
   is outside 0.5-2 USDC per EUR (`checkRate`, catches swapped or mistyped
   amounts), a memo over Stellar's 28-byte `MEMO_TEXT` limit, and a memo
   another subscription already uses (deal `A-B` + ref `C` and deal `A` + ref
   `B-C` would collide).
2. `HorizonIncomingPayments` (Horizon adapter) feeds `reconcile()`: it reads
   the collection address's payments newest first (`order=desc`), following
   `_links.next` up to `PAYMENT_PAGES` pages, with the memo from the joined
   transaction (`join=transactions`). Only successful `payment` / path-payment
   credits of the exact asset count - another issuer's "USDC", XLM or a failed
   tx is ignored. Settlement requires an **exact** match of memo + USDC amount +
   asset + destination, and one payment (tx hash) settles at most one
   subscription. Wrong amount → `MISMATCH` for manual handling - money is never
   auto-credited on a partial payment.
3. At raise close, `OffRampQueue.build(...)` batches the deal's reconciled
   collections that no executed batch covers yet into a ramp instruction,
   sliced to per-transaction caps. A batch records exactly which subscriptions
   it converts (`subscriptionRefs`), its USDC total and its `eurCommitted`. A
   collection reconciled after a batch executed was never converted by it and
   goes into the next batch. One batch per deal is open at a time; rebuilding
   replaces a still-`PENDING` batch, and executed batches are immutable.
4. `OffRampQueue.complete(dealId, bankRef, eurReceived)` - treasury records the
   EUR the conversion landed in the SPV account (`fxResultEur` =
   received − committed). Short of the commitment the batch is
   `AWAITING_TOP_UP` and nothing in it is eligible until
   `OffRampQueue.topUp(dealId, bankRef, eur)` (idempotent per bank reference)
   covers the `shortfallEur(...)`; then it is `EXECUTED`.
5. `eligibility(...)` marks a crypto settlement **eligible for issuance** only
   once an `EXECUTED` batch covers that subscription; the eligible `amount` is
   its **EUR commitment**, and it carries the batch's bank reference as EUR
   evidence into D1's `SubscriptionSettlementService.settle(...)`.
   (FIAT_WIRE settlements are eligible the moment their bank settlement is
   recorded.)

## Distribution day: one schedule, two worklists

`splitByRail(scheduleRows, registry)` routes each payout row by the investor's
payout rail: the on-chain cohort becomes the SDP cohort (fed to D3's
`emitSdpFiles` - see `test/d3-handoff.test.ts` for the verbatim handoff), the
fiat cohort becomes a generated SEPA worklist file (`emitBankFile`) for the
SPV's bank. Unknown investors or missing rail prerequisites are **fatal** - a
payout may never silently drop or default to the wrong rail. Worklist totals
must reconcile to the schedule.

## Status

23/23 tests green (profiles, collection matching and its guards, Horizon
watcher filtering and pagination, off-ramp batches with top-ups and FX,
EUR-denominated eligibility gate, rail split, bank file, D3 handoff).
Production seams: registry and collection/off-ramp books are in-memory
(platform DB in production), the observer polls Horizon (production adds a
persisted cursor + webhook), and the ramp execution itself is the T2
integration.
