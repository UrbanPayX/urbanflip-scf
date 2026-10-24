import { fromUnits, toStroops, toUnitsExact } from '../money/stroops';

/**
 * The loan ledger as Urbanflip's platform already knows it: one row per
 * investor participation (a participative loan position against the deal SPV).
 */
export interface LoanPosition {
  investorId: string;
  email: string;
  /** Destination Stellar address for payout (resolved from D2 onboarding). */
  walletAddress?: string;
  /** Invested principal, decimal string (EUR). */
  principal: string;
}

export interface DealLedger {
  dealId: string;
  positions: LoanPosition[];
}

/** The deal's realised outcome: what the waterfall repays. */
export interface DealOutcome {
  /** Total principal repaid — must equal the ledger's principal sum. */
  principalRepayment: string;
  /** Total performance interest to distribute pro-rata by principal. */
  performanceInterest: string;
}

export type RemainderPolicy = 'largest-remainder' | 'last-absorbs';

export interface DistributionRow {
  investorId: string;
  email: string;
  walletAddress?: string;
  principalStroops: bigint;
  interestStroops: bigint;
  totalStroops: bigint;
}

export interface DistributionSchedule {
  dealId: string;
  rows: DistributionRow[];
  totals: { principalStroops: bigint; interestStroops: bigint; totalStroops: bigint };
  remainderPolicy: RemainderPolicy;
  computationDecimals: number;
}

export interface ComputeOptions {
  /**
   * Precision of the arithmetic units. 2 = EUR bank-ledger semantics (replay);
   * 7 = on-chain stroop semantics. Principal is always exact at any precision;
   * interest is allocated in integer units of 10^-decimals.
   */
  decimals?: number;
  remainderPolicy?: RemainderPolicy;
}

/**
 * Computes the distribution: principal repaid per position (exact), performance
 * interest allocated pro-rata by principal share in exact integer arithmetic.
 * Remainder (dust) is distributed per the policy so that the sum of rows
 * ALWAYS equals the outcome totals — no rounding drift, ever.
 */
export function computeDistribution(
  ledger: DealLedger,
  outcome: DealOutcome,
  opts: ComputeOptions = {},
): DistributionSchedule {
  if (ledger.positions.length === 0) throw new Error('ledger has no positions');

  const decimals = opts.decimals ?? 7;
  const policy = opts.remainderPolicy ?? 'largest-remainder';

  // Amounts finer than `decimals` are refused, never truncated: a dropped
  // residue would leave the rows summing short of the outcome.
  const unit = (dec: string) => toUnitsExact(toStroops(dec), decimals);
  const principalUnits = ledger.positions.map((p) => unit(p.principal));
  const principalTotalUnits = principalUnits.reduce((a, b) => a + b, 0n);
  const outcomePrincipalUnits = unit(outcome.principalRepayment);
  if (outcomePrincipalUnits !== principalTotalUnits) {
    throw new Error(
      `outcome principal ${outcome.principalRepayment} != ledger principal sum ` +
        `${fromUnits(principalTotalUnits, decimals)} (decimals=${decimals})`,
    );
  }

  const interestTotalUnits = unit(outcome.performanceInterest);
  const interestUnits = allocate(
    interestTotalUnits,
    principalUnits,
    policy,
    ledger.positions.map((p) => p.investorId),
  );

  const rows: DistributionRow[] = ledger.positions.map((p, i) => {
    const principalStroops = fromUnits(principalUnits[i]!, decimals);
    const interestStroops = fromUnits(interestUnits[i]!, decimals);
    return {
      investorId: p.investorId,
      email: p.email,
      walletAddress: p.walletAddress,
      principalStroops,
      interestStroops,
      totalStroops: principalStroops + interestStroops,
    };
  });

  const totals = {
    principalStroops: rows.reduce((a, r) => a + r.principalStroops, 0n),
    interestStroops: rows.reduce((a, r) => a + r.interestStroops, 0n),
    totalStroops: rows.reduce((a, r) => a + r.totalStroops, 0n),
  };

  return { dealId: ledger.dealId, rows, totals, remainderPolicy: policy, computationDecimals: decimals };
}

/**
 * Allocates `total` units pro-rata by `weights` in exact BigInt arithmetic.
 * largest-remainder: floor shares, then +1 unit to the largest fractional
 * remainders (ties broken by investorId for determinism).
 * last-absorbs: floor shares, the dust goes to the final position (the
 * convention several legacy bank ledgers used).
 */
export function allocate(total: bigint, weights: bigint[], policy: RemainderPolicy, ids: string[]): bigint[] {
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) throw new Error('total principal weight is zero');

  const bases = weights.map((w) => (total * w) / weightSum);
  const fracs = weights.map((w) => (total * w) % weightSum);
  let dust = total - bases.reduce((a, b) => a + b, 0n);
  const out = [...bases];

  if (dust > 0n) {
    if (policy === 'last-absorbs') {
      out[out.length - 1]! += dust;
    } else {
      const order = weights
        .map((_, i) => i)
        .sort((a, b) => (fracs[b]! === fracs[a]! ? (ids[a]! < ids[b]! ? -1 : 1) : Number(fracs[b]! - fracs[a]!)));
      let i = 0;
      while (dust > 0n) {
        const idx = order[i % order.length]!;
        out[idx] = (out[idx] ?? 0n) + 1n;
        dust -= 1n;
        i += 1;
      }
    }
  }
  return out;
}
