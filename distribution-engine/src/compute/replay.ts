import { fromUnits } from '../money/stroops';
import {
  computeDistribution,
  type ComputeOptions,
  type DealLedger,
  type DealOutcome,
} from './pro-rata';

/** One row of the historical bank-ledger payout record for a completed deal. */
export interface HistoricalPayout {
  investorId: string;
  /** Total amount actually paid out (EUR decimal string, recorded precision). */
  amount: string;
}

export interface ReplayDiff {
  investorId: string;
  recordedStroops: bigint;
  computedStroops: bigint;
  deltaStroops: bigint;
}

export interface ReplayReport {
  dealId: string;
  match: boolean;
  comparedRows: number;
  diffs: ReplayDiff[];
  recordedTotalStroops: bigint;
  computedTotalStroops: bigint;
}

/**
 * Acceptance criterion: "Replay of 3 completed real deals' actual payout data
 * reproduces historical amounts exactly." Recompute the deal at the recorded
 * ledger's precision and policy, then diff against the bank payout record,
 * row by row, to the stroop. One cent of drift on one investor fails the replay.
 */
export function replayDeal(
  ledger: DealLedger,
  outcome: DealOutcome,
  historical: HistoricalPayout[],
  opts: ComputeOptions = {},
): ReplayReport {
  const schedule = computeDistribution(ledger, outcome, opts);

  const recorded = new Map(historical.map((h) => [h.investorId, h.amount]));
  const computed = new Map(schedule.rows.map((r) => [r.investorId, r.totalStroops]));

  const diffs: ReplayDiff[] = [];
  for (const row of schedule.rows) {
    const recordedAmount = recorded.get(row.investorId);
    if (recordedAmount === undefined) {
      throw new Error(`historical record missing investor '${row.investorId}'`);
    }
    const recordedStroops = toRecordedStroops(recordedAmount);
    const delta = row.totalStroops - recordedStroops;
    if (delta !== 0n) {
      diffs.push({ investorId: row.investorId, recordedStroops, computedStroops: row.totalStroops, deltaStroops: delta });
    }
  }
  for (const id of recorded.keys()) {
    if (!computed.has(id)) throw new Error(`historical record has unknown investor '${id}'`);
  }

  return {
    dealId: ledger.dealId,
    match: diffs.length === 0,
    comparedRows: schedule.rows.length,
    diffs,
    recordedTotalStroops: historical.reduce((a, h) => a + toRecordedStroops(h.amount), 0n),
    computedTotalStroops: schedule.totals.totalStroops,
  };
}

/** Recorded amounts are 2-decimal EUR; accept whole-euro and trailing-zero variants. */
function toRecordedStroops(amount: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`invalid recorded payout amount '${amount}' (expected EUR decimal, <= 2 decimals)`);
  }
  const [int, frac = ''] = amount.split('.');
  return fromUnits(BigInt(int! + frac.padEnd(2, '0')), 2);
}
