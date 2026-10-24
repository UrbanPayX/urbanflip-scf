import type { LedgerLookup } from '../stellar/tx-submitter';

/** Ledger close time and local clock can disagree; wait this long past maxTime before rebuilding. */
export const MAX_TIME_GRACE_SECONDS = 30;

/**
 * Where a transaction recorded PENDING before submission stands now:
 *   APPLIED          on the ledger and successful — record it, never resubmit;
 *   NEVER_APPLIES    failed on-chain, or expired off-ledger — safe to rebuild;
 *   MAY_STILL_APPLY  not seen, but still within maxTime + grace — wait until retryAfter.
 */
export type PendingTxStatus =
  | { status: 'APPLIED' }
  | { status: 'NEVER_APPLIES' }
  | { status: 'MAY_STILL_APPLY'; retryAfter: number };

export async function resolvePendingTx(
  ledger: Pick<LedgerLookup, 'transactionOutcome'>,
  txHash: string,
  maxTime: number,
): Promise<PendingTxStatus> {
  const outcome = await ledger.transactionOutcome(txHash);
  if (outcome === 'SUCCESS') return { status: 'APPLIED' };
  const retryAfter = maxTime + MAX_TIME_GRACE_SECONDS;
  // maxTime 0 means no upper time bound: such a tx never expires.
  if (outcome === 'NOT_FOUND' && (maxTime === 0 || Date.now() / 1000 <= retryAfter)) {
    return { status: 'MAY_STILL_APPLY', retryAfter };
  }
  return { status: 'NEVER_APPLIES' };
}
