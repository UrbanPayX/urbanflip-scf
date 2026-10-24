import { fromStroops, toStroops } from '../money';

/**
 * A USDC payment we are waiting for, addressable by memo. Every loan is
 * EUR-denominated and one participation unit is EUR 1 of principal, whatever
 * the rail: the investor commits EUR and pays the USDC the ramp quoted for it.
 */
export interface ExpectedPayment {
  subscriptionRef: string;
  investorId: string;
  dealId: string;
  /** The investor's EUR commitment: the loan principal, and the units minted. */
  eurAmount: string;
  /** The USDC the investor pays for it (the ramp quote); matched exactly. */
  usdcAmount: string;
  /** The ramp quote the USDC amount comes from, for the audit trail. */
  quoteRef?: string;
  /** Company collection wallet. */
  collectionAddress: string;
  asset: { code: string; issuer: string };
  /** Memo carried by the investor's payment — the matching key. */
  memo: string;
  createdAt: string;
}

/** A crypto subscription to expect: the EUR commitment and its USDC quote. */
export type PaymentRequest = Omit<ExpectedPayment, 'memo' | 'createdAt'>;

/** A USDC payment observed on-chain arriving at the collection address. */
export interface ObservedPayment {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  asset: { code: string; issuer: string };
  memo?: string;
  createdAt: string;
}

/**
 * Port: how the backend watches the collection wallet. The Horizon adapter
 * polls; tests fake it. Memo-based matching requires reading the enclosing
 * transaction, so the adapter joins payments to transactions.
 */
export interface IncomingPaymentObserver {
  incoming(address: string, asset: { code: string; issuer: string }): Promise<ObservedPayment[]>;
}

export type CollectionState = 'PENDING' | 'RECONCILED' | 'MISMATCH';

export interface CollectionRecord {
  expected: ExpectedPayment;
  state: CollectionState;
  /** Set when RECONCILED: the incoming payment that satisfied the expectation. */
  settledBy?: ObservedPayment;
  /** Set when MISMATCH: why the payment did not settle. */
  mismatchReason?: string;
}

export interface CryptoCollectionDeps {
  observer: IncomingPaymentObserver;
}

/** Stellar MEMO_TEXT holds at most 28 bytes. */
export const MAX_TEXT_MEMO_BYTES = 28;

/**
 * USDC-per-EUR bounds (numerator, denominator) for a quote or a conversion:
 * wide enough for any real market, narrow enough to catch a swapped or
 * mistyped amount.
 */
export const MIN_USDC_PER_EUR: readonly [bigint, bigint] = [1n, 2n];
export const MAX_USDC_PER_EUR: readonly [bigint, bigint] = [2n, 1n];

/** Refuses a USDC/EUR pair (in stroops) whose implied rate is outside the sanity bounds. */
export function checkRate(usdcStroops: bigint, eurStroops: bigint): void {
  const [minN, minD] = MIN_USDC_PER_EUR;
  const [maxN, maxD] = MAX_USDC_PER_EUR;
  if (usdcStroops <= 0n || eurStroops <= 0n) throw new Error('amounts must be positive');
  if (usdcStroops * minD < eurStroops * minN || usdcStroops * maxD > eurStroops * maxN) {
    throw new Error(
      `implied rate ${rateDisplay(usdcStroops, eurStroops)} USDC per EUR is outside ${minN}/${minD}-${maxN}/${maxD}; check the amounts`,
    );
  }
}

/** USDC per EUR to 6 decimals, for display only. */
export function rateDisplay(usdcStroops: bigint, eurStroops: bigint): string {
  const micro = (usdcStroops * 1_000_000n) / eurStroops;
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
}

/**
 * Collection for crypto-native subscriptions: the investor pays from their own
 * wallet to the company collection address with a unique memo. Settlement
 * requires an EXACT match of memo + USDC amount + asset + destination, and a
 * payment (one tx, one memo) settles at most one subscription. A memo-matched
 * payment of the wrong amount is surfaced as MISMATCH for manual handling —
 * money is never auto-credited on a partial or wrong payment.
 */
export class CryptoCollectionService {
  private readonly expected = new Map<string, CollectionRecord>();

  constructor(private readonly deps: CryptoCollectionDeps) {}

  /**
   * Registers a subscription to collect. Refuses — never overwrites — a
   * subscription already expected, an invalid amount, a quote outside the
   * rate bounds, and a memo that is too long for MEMO_TEXT or already in use.
   */
  expectPayment(args: PaymentRequest): ExpectedPayment {
    if (this.expected.has(args.subscriptionRef)) {
      throw new Error(`subscription '${args.subscriptionRef}' already expected`);
    }
    checkRate(toStroops(args.usdcAmount), toStroops(args.eurAmount));
    const memo = `UF-${args.dealId}-${args.subscriptionRef}`;
    if (Buffer.byteLength(memo, 'utf8') > MAX_TEXT_MEMO_BYTES) {
      throw new Error(`memo '${memo}' exceeds ${MAX_TEXT_MEMO_BYTES} bytes; use a shorter subscription ref`);
    }
    // "UF-A-B" + "-C" and "UF-A" + "-B-C" render alike; one payment must
    // never be able to match two subscriptions.
    for (const record of this.expected.values()) {
      if (record.expected.memo === memo) {
        throw new Error(`memo '${memo}' is already used by subscription '${record.expected.subscriptionRef}'`);
      }
    }
    const expected: ExpectedPayment = { ...args, memo, createdAt: new Date().toISOString() };
    this.expected.set(args.subscriptionRef, { expected, state: 'PENDING' });
    return expected;
  }

  /** Reconciles everything still PENDING against incoming payments. */
  async reconcile(): Promise<CollectionRecord[]> {
    const pending = [...this.expected.values()].filter((r) => r.state === 'PENDING');
    const watched = new Map<string, { address: string; asset: { code: string; issuer: string } }>();
    for (const { expected } of pending) {
      const key = `${expected.collectionAddress}|${expected.asset.code}:${expected.asset.issuer}`;
      watched.set(key, { address: expected.collectionAddress, asset: expected.asset });
    }
    const incoming: ObservedPayment[] = [];
    for (const { address, asset } of watched.values()) {
      incoming.push(...(await this.deps.observer.incoming(address, asset)));
    }

    // A payment (one tx, one memo) settles at most one subscription, ever.
    const used = new Set<string>();
    for (const record of this.expected.values()) {
      if (record.settledBy) used.add(record.settledBy.txHash);
    }

    const results: CollectionRecord[] = [];
    for (const record of pending) {
      const { expected } = record;
      // Another issuer's "USDC" is ignored, never coerced into the expected asset.
      const candidates = incoming.filter(
        (p) =>
          p.to === expected.collectionAddress &&
          p.memo === expected.memo &&
          p.asset.code === expected.asset.code &&
          p.asset.issuer === expected.asset.issuer &&
          !used.has(p.txHash),
      );
      const exact = candidates.find((p) => sameAmount(p.amount, expected.usdcAmount));
      if (exact) {
        used.add(exact.txHash);
        record.state = 'RECONCILED';
        record.settledBy = exact;
      } else if (candidates.length > 0) {
        record.state = 'MISMATCH';
        record.mismatchReason = `memo matched but amount mismatch: expected ${expected.usdcAmount} ${expected.asset.code}, got ${candidates[0]!.amount}`;
      }
      results.push(record);
    }
    return results;
  }

  /** A copy: state only changes through expectPayment and reconcile. */
  record(subscriptionRef: string): CollectionRecord | undefined {
    const record = this.expected.get(subscriptionRef);
    return record && structuredClone(record);
  }

  /** Deal-level aggregate: the USDC collected and the EUR it commits. */
  reconciledTotal(dealId: string): { count: number; totalUsdc: string; totalEur: string } {
    const rows = this.reconciledFor(dealId);
    const sum = (pick: (e: ExpectedPayment) => string) =>
      fromStroops(rows.reduce((acc, r) => acc + toStroops(pick(r.expected)), 0n));
    return { count: rows.length, totalUsdc: sum((e) => e.usdcAmount), totalEur: sum((e) => e.eurAmount) };
  }

  /** Copies, like record(). */
  reconciledFor(dealId: string): CollectionRecord[] {
    return structuredClone(
      [...this.expected.values()].filter((r) => r.expected.dealId === dealId && r.state === 'RECONCILED'),
    );
  }
}

/** Exact stroop comparison; an unparseable observed amount never matches. */
function sameAmount(observed: string, expected: string): boolean {
  try {
    return toStroops(observed) === toStroops(expected);
  } catch {
    return false;
  }
}
