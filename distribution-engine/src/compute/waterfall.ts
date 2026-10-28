import { divHalfUp, formatCents, fromUnits, toRatio, toStroops, toUnitsExact } from '../money/stroops';
import { allocate, type DistributionRow, type DistributionSchedule } from './pro-rata';

/**
 * Urbanflip's participative-loan waterfall: how a completed deal pays each
 * position. A position is a fixed tranche (simple interest at the contract
 * rate) plus a variable tranche (a share of the deal's variable profit). The
 * success fee comes out of the variable tranche, withholding tax out of the
 * interest net of fee, and principal comes back in full:
 *
 *   net = principal + (fixed + variable - fee) - withholding
 *
 * This is the model the platform settled Velázquez 87, Orense 9 and General
 * Perón 26 with (fixtures/real), reproduced to the cent. Money is BigInt
 * cents (bank-ledger precision) and every rate an exact decimal; nothing
 * passes through a float.
 */

export type FixedAccrual =
  /** interest = principal x rate x days / 365 */
  | { basis: 'act/365' }
  /**
   * months = round(days / daysPerMonth, 2 decimals), counting the payout day
   * too when `inclusiveDays`; interest = principal x rate / 12 x months.
   */
  | { basis: 'months'; daysPerMonth: string; inclusiveDays: boolean };

/** What the variable profit and the success fee are shared by: capital, or capital x days invested. */
export type VariableWeighting = 'capital' | 'capital-days';

/**
 * per-row-half-up: every row rounded on its own, as the platform has always
 * settled; the rows can miss the pool by a few cents (reported as residual).
 * largest-remainder: rows sum to the pool exactly, the leftover cents going to
 * the largest fractional remainders (ties by investorId).
 */
export type AllocationRounding = 'per-row-half-up' | 'largest-remainder';

export interface WaterfallTerms {
  /** Annual rate of the fixed tranche, e.g. '0.08'. */
  fixedRate: string;
  /** Share of the standard success fee this position bears: '1', '0.5', '0' (exempt). */
  feeShare: string;
  /** Withholding tax on interest net of fee, e.g. '0.19'. */
  withholdingRate: string;
}

export interface WaterfallPosition {
  investorId: string;
  /** Date the money started working, YYYY-MM-DD. */
  startDate: string;
  /** EUR decimal strings, at most 2 decimals. */
  fixedPrincipal: string;
  variablePrincipal: string;
  terms: WaterfallTerms;
  /** Needed only to pay on-chain (SDP receiver id and destination). */
  email?: string;
  walletAddress?: string;
}

export interface WaterfallDeal {
  dealId: string;
  /** Payout date, YYYY-MM-DD: interest accrues up to it. */
  endDate: string;
  fixedAccrual: FixedAccrual;
  variableWeighting: VariableWeighting;
  /** Variable profit shared among the variable tranches, EUR. */
  variablePool: string;
  /** Success fee charged, EUR, shared over the fee-bearing weights (weight x feeShare). */
  feePool: string;
  /** Default 'largest-remainder'. */
  rounding?: AllocationRounding;
  positions: WaterfallPosition[];
}

export type AdjustableComponent = 'fixedInterest' | 'variableInterest' | 'fee' | 'withholding';

/** A manual correction made at settlement time: the rule's figure was replaced by `amount`. */
export interface WaterfallAdjustment {
  investorId: string;
  component: AdjustableComponent;
  amount: string;
  reason: string;
}

export interface AppliedAdjustment {
  component: AdjustableComponent;
  /** What the rule gives. */
  ruleCents: bigint;
  /** What was applied instead. */
  appliedCents: bigint;
  reason: string;
}

export interface WaterfallRow {
  investorId: string;
  email?: string;
  walletAddress?: string;
  days: number;
  principalCents: bigint;
  fixedInterestCents: bigint;
  variableInterestCents: bigint;
  grossInterestCents: bigint;
  feeCents: bigint;
  interestAfterFeeCents: bigint;
  withholdingCents: bigint;
  netCents: bigint;
  adjustments: AppliedAdjustment[];
}

export type WaterfallTotals = Record<
  | 'principalCents'
  | 'fixedInterestCents'
  | 'variableInterestCents'
  | 'grossInterestCents'
  | 'feeCents'
  | 'interestAfterFeeCents'
  | 'withholdingCents'
  | 'netCents',
  bigint
>;

export interface WaterfallResult {
  dealId: string;
  rounding: AllocationRounding;
  rows: WaterfallRow[];
  totals: WaterfallTotals;
  /** Pool minus what the rule allocated (before adjustments): 0 under largest-remainder. */
  residual: { variableCents: bigint; feeCents: bigint };
}

export interface WaterfallOptions {
  adjustments?: WaterfallAdjustment[];
}

const MS_PER_DAY = 86_400_000;
const TOTAL_KEYS = [
  'principalCents',
  'fixedInterestCents',
  'variableInterestCents',
  'grossInterestCents',
  'feeCents',
  'interestAfterFeeCents',
  'withholdingCents',
  'netCents',
] as const;

export function computeWaterfall(deal: WaterfallDeal, opts: WaterfallOptions = {}): WaterfallResult {
  const { positions } = deal;
  if (positions.length === 0) throw new Error('deal has no positions');
  const ids = positions.map((p) => p.investorId);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`duplicate investorId '${duplicate}'`);

  const rounding = deal.rounding ?? 'largest-remainder';
  const cents = (amount: string) => toUnitsExact(toStroops(amount), 2);
  const variablePool = cents(deal.variablePool);
  const feePool = cents(deal.feePool);

  const base = positions.map((p) => {
    const days = daysBetween(p.startDate, deal.endDate);
    const fixed = cents(p.fixedPrincipal);
    const variable = cents(p.variablePrincipal);
    if (fixed + variable === 0n) throw new Error(`position '${p.investorId}' has no principal`);
    if (!p.terms) throw new Error(`position '${p.investorId}' has no terms`);
    for (const [name, rate] of Object.entries(p.terms)) {
      const [num, den] = toRatio(rate);
      if (num > den) throw new Error(`position '${p.investorId}': ${name} ${rate} is above 1`);
    }
    const weight = deal.variableWeighting === 'capital-days' ? variable * BigInt(days) : variable;
    return { p, days, fixed, variable, weight };
  });

  const weights = base.map((b) => b.weight);
  const variableShares = share(variablePool, weights, rounding, ids, 'variable pool');

  // Fee shares are decimals ('0.5'): scale every one to the finest denominator
  // so the fee weights stay integers.
  const feeRatios = base.map((b) => toRatio(b.p.terms.feeShare));
  const scale = feeRatios.reduce((max, [, den]) => (den > max ? den : max), 1n);
  const feeWeights = base.map((b, i) => b.weight * feeRatios[i]![0] * (scale / feeRatios[i]![1]));
  const feeShares = share(feePool, feeWeights, rounding, ids, 'fee pool');

  const adjustments = indexAdjustments(opts.adjustments ?? [], new Set(ids));

  const rows = base.map((b, i): WaterfallRow => {
    const applied: AppliedAdjustment[] = [];
    const pick = (component: AdjustableComponent, ruleCents: bigint): bigint => {
      const adj = adjustments.get(`${b.p.investorId}\u0000${component}`);
      if (!adj) return ruleCents;
      const amount = cents(adj.amount);
      applied.push({ component, ruleCents, appliedCents: amount, reason: adj.reason });
      return amount;
    };

    const fixedInterest = pick(
      'fixedInterest',
      fixedInterestCents(b.fixed, b.p.terms.fixedRate, b.days, deal.fixedAccrual),
    );
    const variableInterest = pick('variableInterest', variableShares[i]!);
    const grossInterest = fixedInterest + variableInterest;
    const fee = pick('fee', feeShares[i]!);
    const interestAfterFee = grossInterest - fee;
    if (interestAfterFee < 0n) {
      throw new Error(`position '${b.p.investorId}': fee exceeds its interest`);
    }
    const [wNum, wDen] = toRatio(b.p.terms.withholdingRate);
    const withholding = pick('withholding', divHalfUp(interestAfterFee * wNum, wDen));
    if (withholding > interestAfterFee) {
      throw new Error(`position '${b.p.investorId}': withholding exceeds its interest`);
    }
    const principal = b.fixed + b.variable;
    return {
      investorId: b.p.investorId,
      email: b.p.email,
      walletAddress: b.p.walletAddress,
      days: b.days,
      principalCents: principal,
      fixedInterestCents: fixedInterest,
      variableInterestCents: variableInterest,
      grossInterestCents: grossInterest,
      feeCents: fee,
      interestAfterFeeCents: interestAfterFee,
      withholdingCents: withholding,
      netCents: principal + interestAfterFee - withholding,
      adjustments: applied,
    };
  });

  const totals = Object.fromEntries(
    TOTAL_KEYS.map((key) => [key, rows.reduce((a, r) => a + r[key], 0n)]),
  ) as WaterfallTotals;

  return {
    dealId: deal.dealId,
    rounding,
    rows,
    totals,
    residual: {
      variableCents: variablePool - variableShares.reduce((a, b) => a + b, 0n),
      feeCents: feePool - feeShares.reduce((a, b) => a + b, 0n),
    },
  };
}

/** Fixed-tranche interest in cents for `principal` cents over `days`, rounded half up. */
export function fixedInterestCents(principal: bigint, rate: string, days: number, accrual: FixedAccrual): bigint {
  const [rNum, rDen] = toRatio(rate);
  if (accrual.basis === 'act/365') return divHalfUp(principal * rNum * BigInt(days), rDen * 365n);
  const [mNum, mDen] = toRatio(accrual.daysPerMonth);
  if (mNum === 0n) throw new Error('daysPerMonth must be positive');
  const counted = BigInt(days + (accrual.inclusiveDays ? 1 : 0));
  const monthsHundredths = divHalfUp(counted * 100n * mDen, mNum);
  return divHalfUp(principal * rNum * monthsHundredths, rDen * 1200n);
}

/** Whole days from `start` to `end` (YYYY-MM-DD, calendar dates). */
export function daysBetween(start: string, end: string): number {
  const days = (isoDay(end) - isoDay(start)) / MS_PER_DAY;
  if (days < 0) throw new Error(`start date ${start} is after end date ${end}`);
  return days;
}

function isoDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const time = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  // Date.UTC rolls 2025-02-30 over to March: only a round trip proves the date exists.
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new Error(`invalid date '${date}' (expected YYYY-MM-DD)`);
  }
  return time;
}

function share(
  pool: bigint,
  weights: bigint[],
  rounding: AllocationRounding,
  ids: string[],
  what: string,
): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) {
    if (pool === 0n) return weights.map(() => 0n);
    throw new Error(`${what} is not zero but no position bears it`);
  }
  if (rounding === 'largest-remainder') return allocate(pool, weights, 'largest-remainder', ids);
  return weights.map((w) => divHalfUp(pool * w, total));
}

function indexAdjustments(list: WaterfallAdjustment[], known: Set<string>): Map<string, WaterfallAdjustment> {
  const index = new Map<string, WaterfallAdjustment>();
  for (const adj of list) {
    if (!known.has(adj.investorId)) throw new Error(`adjustment for unknown investor '${adj.investorId}'`);
    if (!adj.reason?.trim()) throw new Error(`adjustment for '${adj.investorId}' has no reason`);
    const key = `${adj.investorId}\u0000${adj.component}`;
    if (index.has(key)) throw new Error(`two ${adj.component} adjustments for '${adj.investorId}'`);
    index.set(key, adj);
  }
  return index;
}

/**
 * The waterfall as a schedule the USDC conversion and SDP emission take: each
 * investor is owed their net payout (principal + interest after fee and
 * withholding). Only largest-remainder results qualify, so a live payout sums
 * to the pools exactly; per-row-half-up is the legacy convention for replays.
 */
export function toDistributionSchedule(result: WaterfallResult): DistributionSchedule {
  if (result.rounding !== 'largest-remainder') {
    throw new Error(
      `${result.rounding} is the legacy replay convention; compute payouts with largest-remainder so rows sum to the pools`,
    );
  }
  const rows = result.rows.map((r): DistributionRow => {
    if (r.walletAddress !== undefined && !r.email) {
      throw new Error(`investor '${r.investorId}' has a wallet but no email (the SDP receiver id)`);
    }
    return {
      investorId: r.investorId,
      email: r.email ?? '',
      walletAddress: r.walletAddress,
      principalStroops: fromUnits(r.principalCents, 2),
      interestStroops: fromUnits(r.interestAfterFeeCents - r.withholdingCents, 2),
      totalStroops: fromUnits(r.netCents, 2),
    };
  });
  return {
    dealId: result.dealId,
    rows,
    totals: {
      principalStroops: rows.reduce((a, r) => a + r.principalStroops, 0n),
      interestStroops: rows.reduce((a, r) => a + r.interestStroops, 0n),
      totalStroops: rows.reduce((a, r) => a + r.totalStroops, 0n),
    },
    remainderPolicy: 'largest-remainder',
    computationDecimals: 2,
  };
}

/**
 * JSON view of a waterfall result or replay report: every `...Cents` bigint
 * becomes a EUR string under the name without the suffix (feeCents: 2000n ->
 * fee: '20.00'), every record keyed by component likewise, other bigints
 * become strings.
 */
export function eurJson(value: unknown): unknown {
  if (typeof value === 'bigint') return formatCents(value);
  if (Array.isArray(value)) return value.map(eurJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key.endsWith('Cents') ? key.slice(0, -5) : key, eurJson(v)]),
    );
  }
  return value;
}
