import { fromStroops, toStroops } from '../money';
import { checkRate, type CollectionRecord } from './crypto-collection';

/**
 * Raise-close off-ramp: crypto subscriptions only become EUR — and only EUR
 * may land in the SPV — once their USDC is converted and banked. Every loan
 * is EUR-denominated and one unit is EUR 1 of principal, so a crypto
 * subscription mints its EUR commitment (never its USDC amount), and only
 * once an EXECUTED batch that converted THAT subscription landed the full
 * committed EUR at the SPV.
 *
 * Batch status:
 *   PENDING          built, USDC not yet converted; the next build replaces it
 *   AWAITING_TOP_UP  converted, but less EUR landed than committed; nothing in
 *                    the batch is eligible until Urbanflip tops up the difference
 *   EXECUTED         EUR at the SPV covers the commitment; immutable from here
 *
 * FX never moves the investor's units: a shortfall is Urbanflip's top-up, a
 * surplus is recorded as an FX gain (fxResultEur).
 */
export type OffRampStatus = 'PENDING' | 'AWAITING_TOP_UP' | 'EXECUTED';

/** Urbanflip's transfer covering a conversion shortfall. */
export interface TopUp {
  bankRef: string;
  eur: string;
}

export interface OffRampInstruction {
  dealId: string;
  /** 1-based batch number within the deal. */
  batch: number;
  totalUsdc: string;
  /** Sum of the batch's EUR commitments: the units its subscriptions mint. */
  eurCommitted: string;
  paymentCount: number;
  /** The collections this batch converts; only these become eligible when it executes. */
  subscriptionRefs: string[];
  /** SPV account the EUR lands in. */
  targetIban: string;
  /** Ramp slice cap (ramp per-transaction limits; larger blocks go via exchange). */
  maxSliceUsdc: string;
  slices: string[];
  status: OffRampStatus;
  /** Set on conversion: proof EUR reached the SPV. */
  bankRef?: string;
  /** EUR the conversion actually landed at the SPV. */
  eurReceived?: string;
  /** Urbanflip's transfers covering a conversion shortfall. */
  topUps: TopUp[];
  /**
   * eurReceived - eurCommitted: positive is an FX gain, negative an FX cost
   * Urbanflip covers with top-ups. Investors' units never move.
   */
  fxResultEur?: string;
  /** Set when the batch EXECUTED. */
  completedAt?: string;
}

/**
 * Off-ramp batches per deal. Executed batches are immutable (callers only
 * ever get copies); at most one batch per deal is open (PENDING or
 * AWAITING_TOP_UP), and it is always the deal's last batch.
 */
export class OffRampQueue {
  private readonly batchesByDeal = new Map<string, OffRampInstruction[]>();

  /**
   * Batches every reconciled collection of the deal that no EXECUTED batch
   * covers yet. A still-PENDING batch is replaced (nothing was converted);
   * one AWAITING_TOP_UP blocks until it is topped up.
   */
  build(args: {
    dealId: string;
    reconciled: CollectionRecord[];
    targetIban: string;
    maxSliceUsdc?: string;
  }): OffRampInstruction {
    const batches = this.batchesByDeal.get(args.dealId) ?? [];
    const last = batches.at(-1);
    if (last?.status === 'AWAITING_TOP_UP') {
      throw new Error(`batch ${last.batch} of deal ${args.dealId} awaits a top-up; complete it first`);
    }
    const covered = new Set(batches.filter((b) => b.status === 'EXECUTED').flatMap((b) => b.subscriptionRefs));
    const uncovered = new Map<string, CollectionRecord>();
    for (const r of args.reconciled) {
      if (r.expected.dealId !== args.dealId || r.state !== 'RECONCILED') continue;
      if (covered.has(r.expected.subscriptionRef)) continue;
      uncovered.set(r.expected.subscriptionRef, r);
    }
    const rows = [...uncovered.values()];
    const total = rows.reduce((acc, r) => acc + toStroops(r.expected.usdcAmount), 0n);
    const eurCommitted = rows.reduce((acc, r) => acc + toStroops(r.expected.eurAmount), 0n);
    if (total === 0n) throw new Error(`no reconciled collections awaiting off-ramp for deal ${args.dealId}`);
    const maxSliceUsdc = args.maxSliceUsdc ?? '50000';
    const sliceCap = toStroops(maxSliceUsdc);
    if (sliceCap === 0n) throw new Error('maxSliceUsdc must be positive');
    const slices: string[] = [];
    let remaining = total;
    while (remaining > 0n) {
      const slice = remaining > sliceCap ? sliceCap : remaining;
      slices.push(fromStroops(slice));
      remaining -= slice;
    }
    if (last?.status === 'PENDING') batches.pop();
    const instruction: OffRampInstruction = {
      dealId: args.dealId,
      batch: batches.length + 1,
      totalUsdc: fromStroops(total),
      eurCommitted: fromStroops(eurCommitted),
      paymentCount: rows.length,
      subscriptionRefs: rows.map((r) => r.expected.subscriptionRef).sort(),
      targetIban: args.targetIban,
      maxSliceUsdc,
      slices,
      status: 'PENDING',
      topUps: [],
    };
    batches.push(instruction);
    this.batchesByDeal.set(args.dealId, batches);
    return structuredClone(instruction);
  }

  /**
   * Treasury records the conversion: eurReceived landed in the SPV account
   * under this bank reference. Short of the commitment, the batch awaits a
   * top-up. Repeating after execution returns the executed batch unchanged.
   */
  complete(dealId: string, bankRef: string, eurReceived: string): OffRampInstruction {
    const received = toStroops(eurReceived);
    if (!bankRef) throw new Error('a bank reference is required: it is the EUR-at-SPV evidence');
    const last = this.lastBatch(dealId);
    if (last.status === 'EXECUTED') return structuredClone(last);
    if (last.status === 'AWAITING_TOP_UP') {
      throw new Error(`batch ${last.batch} already converted; record the top-up instead`);
    }
    // A swapped or mistyped amount is caught, not booked.
    checkRate(toStroops(last.totalUsdc), received);
    last.bankRef = bankRef;
    last.eurReceived = fromStroops(received);
    last.fxResultEur = fromStroops(received - toStroops(last.eurCommitted));
    settleStatus(last);
    return structuredClone(last);
  }

  /**
   * Urbanflip covers a conversion shortfall; the batch executes once the EUR
   * at the SPV reaches the commitment. Idempotent per bank reference.
   */
  topUp(dealId: string, bankRef: string, eur: string): OffRampInstruction {
    const amount = toStroops(eur);
    if (amount === 0n) throw new Error('top-up must be positive');
    if (!bankRef) throw new Error('a bank reference is required for a top-up');
    const last = this.lastBatch(dealId);
    const recorded = last.topUps.find((t) => t.bankRef === bankRef);
    if (recorded) {
      if (toStroops(recorded.eur) !== amount) {
        throw new Error(`top-up ${bankRef} is already recorded for EUR ${recorded.eur}`);
      }
      return structuredClone(last);
    }
    if (last.status !== 'AWAITING_TOP_UP') {
      throw new Error(`batch ${last.batch} is ${last.status}; no top-up needed`);
    }
    if (bankRef === last.bankRef) {
      throw new Error(`${bankRef} is the conversion itself, not a top-up`);
    }
    last.topUps.push({ bankRef, eur: fromStroops(amount) });
    settleStatus(last);
    return structuredClone(last);
  }

  /** The executed batch that converted this subscription's USDC, if any. */
  executedBatchFor(dealId: string, subscriptionRef: string): OffRampInstruction | undefined {
    const batch = this.batchesByDeal
      .get(dealId)
      ?.find((b) => b.status === 'EXECUTED' && b.subscriptionRefs.includes(subscriptionRef));
    return batch && structuredClone(batch);
  }

  /** The deal's latest batch (the open one, if any). */
  instruction(dealId: string): OffRampInstruction | undefined {
    const last = this.batchesByDeal.get(dealId)?.at(-1);
    return last && structuredClone(last);
  }

  batches(dealId: string): OffRampInstruction[] {
    return structuredClone(this.batchesByDeal.get(dealId) ?? []);
  }

  private lastBatch(dealId: string): OffRampInstruction {
    const last = this.batchesByDeal.get(dealId)?.at(-1);
    if (!last) throw new Error(`no off-ramp instruction for deal ${dealId}`);
    return last;
  }
}

/** EUR still needed at the SPV before the batch can execute ("0.0000000" once covered). */
export function shortfallEur(instruction: OffRampInstruction): string {
  const short = toStroops(instruction.eurCommitted) - eurAtSpv(instruction);
  return fromStroops(short > 0n ? short : 0n);
}

function eurAtSpv(batch: OffRampInstruction): bigint {
  const received = batch.eurReceived ? toStroops(batch.eurReceived) : 0n;
  return batch.topUps.reduce((acc, t) => acc + toStroops(t.eur), received);
}

function settleStatus(batch: OffRampInstruction): void {
  if (eurAtSpv(batch) >= toStroops(batch.eurCommitted)) {
    batch.status = 'EXECUTED';
    batch.completedAt = new Date().toISOString();
  } else {
    batch.status = 'AWAITING_TOP_UP';
  }
}

export type SettlementEligibility =
  | { investorId: string; subscriptionRef: string; eligible: true; amount: string; bankRef: string }
  | { investorId: string; subscriptionRef: string; eligible: false; reason: string };

/**
 * The single rule the issuance step (D1 SubscriptionSettlementService) consults:
 * a subscription may mint units iff money is EUR at the SPV, and it mints its
 * EUR amount (1 unit = EUR 1 of principal).
 *   FIAT_WIRE    → eligible as soon as the bank settlement is recorded
 *   USDC_ONCHAIN → eligible only once an EXECUTED off-ramp batch covers that
 *                  subscription; the amount is its EUR commitment, not its USDC
 */
export function eligibility(args: {
  dealId: string;
  collections: CollectionRecord[];
  offRamp: OffRampQueue;
  bankSettlements: Array<{ subscriptionRef: string; investorId: string; amount: string; bankRef: string }>;
}): SettlementEligibility[] {
  const out: SettlementEligibility[] = [];
  for (const b of args.bankSettlements) {
    out.push({ investorId: b.investorId, subscriptionRef: b.subscriptionRef, eligible: true, amount: b.amount, bankRef: b.bankRef });
  }
  for (const c of args.collections) {
    const who = { investorId: c.expected.investorId, subscriptionRef: c.expected.subscriptionRef };
    if (c.expected.dealId !== args.dealId) {
      out.push({ ...who, eligible: false, reason: `collection belongs to deal ${c.expected.dealId}, not ${args.dealId}` });
      continue;
    }
    if (c.state !== 'RECONCILED') {
      out.push({ ...who, eligible: false, reason: `collection state ${c.state}` });
      continue;
    }
    const batch = args.offRamp.executedBatchFor(args.dealId, c.expected.subscriptionRef);
    if (!batch?.bankRef) {
      out.push({ ...who, eligible: false, reason: 'off-ramp not completed: EUR not yet at SPV' });
    } else {
      out.push({ ...who, eligible: true, amount: c.expected.eurAmount, bankRef: batch.bankRef });
    }
  }
  return out;
}
