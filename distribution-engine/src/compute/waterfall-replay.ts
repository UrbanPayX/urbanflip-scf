import { toStroops, toUnitsExact } from '../money/stroops';
import {
  computeWaterfall,
  type AppliedAdjustment,
  type WaterfallAdjustment,
  type WaterfallDeal,
  type WaterfallResult,
  type WaterfallRow,
} from './waterfall';

/** One investor's settlement as the platform recorded and paid it (EUR, 2 decimals). */
export interface RecordedSettlement {
  investorId: string;
  principal: string;
  fixedInterest: string;
  variableInterest: string;
  fee: string;
  interestAfterFee: string;
  withholding: string;
  net: string;
}

export const REPLAYED_COMPONENTS = [
  'principal',
  'fixedInterest',
  'variableInterest',
  'fee',
  'interestAfterFee',
  'withholding',
  'net',
] as const;
export type ReplayedComponent = (typeof REPLAYED_COMPONENTS)[number];

/** A position the payout record does not cover, declared with the reason; never skipped silently. */
export interface UnrecordedPosition {
  investorId: string;
  reason: string;
}

export interface WaterfallReplayOptions {
  /** Manual corrections made at settlement time, each with its reason. */
  adjustments?: WaterfallAdjustment[];
  unrecorded?: UnrecordedPosition[];
}

export interface ComponentDiff {
  investorId: string;
  component: ReplayedComponent;
  recordedCents: bigint;
  computedCents: bigint;
  deltaCents: bigint;
}

export interface WaterfallReplayReport {
  dealId: string;
  /** Every compared value equal to the cent. */
  match: boolean;
  comparedRows: number;
  /** comparedRows x the 7 replayed components. */
  comparedValues: number;
  diffs: ComponentDiff[];
  recordedTotals: Record<ReplayedComponent, bigint>;
  computedTotals: Record<ReplayedComponent, bigint>;
  adjustments: Array<{ investorId: string } & AppliedAdjustment>;
  unrecorded: Array<UnrecordedPosition & { computed: WaterfallRow }>;
  result: WaterfallResult;
}

const COMPUTED_FIELD: Record<ReplayedComponent, keyof WaterfallRow> = {
  principal: 'principalCents',
  fixedInterest: 'fixedInterestCents',
  variableInterest: 'variableInterestCents',
  fee: 'feeCents',
  interestAfterFee: 'interestAfterFeeCents',
  withholding: 'withholdingCents',
  net: 'netCents',
};

/**
 * Acceptance criterion D3.2: "Replay of 3 completed real deals' actual payout
 * data reproduces historical amounts exactly." Recompute the deal and diff
 * every component of every recorded settlement to the cent. Manual corrections
 * the platform made at the time enter only as declared adjustments, and are
 * reported next to what the rule would have paid.
 */
export function replayWaterfall(
  deal: WaterfallDeal,
  recorded: RecordedSettlement[],
  opts: WaterfallReplayOptions = {},
): WaterfallReplayReport {
  const result = computeWaterfall(deal, { adjustments: opts.adjustments });
  const rows = new Map(result.rows.map((r) => [r.investorId, r]));

  const records = new Map<string, RecordedSettlement>();
  for (const rec of recorded) {
    if (!rows.has(rec.investorId)) throw new Error(`payout record has unknown investor '${rec.investorId}'`);
    if (records.has(rec.investorId)) throw new Error(`payout record lists '${rec.investorId}' twice`);
    records.set(rec.investorId, rec);
  }
  const unrecorded = new Map<string, UnrecordedPosition>();
  for (const u of opts.unrecorded ?? []) {
    if (!rows.has(u.investorId)) throw new Error(`unrecorded position '${u.investorId}' is not in the deal`);
    if (records.has(u.investorId)) throw new Error(`'${u.investorId}' is declared unrecorded but has a record`);
    if (!u.reason?.trim()) throw new Error(`unrecorded position '${u.investorId}' has no reason`);
    unrecorded.set(u.investorId, u);
  }
  for (const id of rows.keys()) {
    if (!records.has(id) && !unrecorded.has(id)) {
      throw new Error(`payout record missing investor '${id}' (declare it unrecorded, with the reason)`);
    }
  }

  const zero = () => Object.fromEntries(REPLAYED_COMPONENTS.map((c) => [c, 0n])) as Record<ReplayedComponent, bigint>;
  const recordedTotals = zero();
  const computedTotals = zero();
  const diffs: ComponentDiff[] = [];
  for (const row of result.rows) {
    const rec = records.get(row.investorId);
    if (!rec) continue;
    for (const component of REPLAYED_COMPONENTS) {
      const recordedCents = toRecordedCents(rec[component], row.investorId, component);
      const computedCents = row[COMPUTED_FIELD[component]] as bigint;
      recordedTotals[component] += recordedCents;
      computedTotals[component] += computedCents;
      if (recordedCents !== computedCents) {
        diffs.push({
          investorId: row.investorId,
          component,
          recordedCents,
          computedCents,
          deltaCents: computedCents - recordedCents,
        });
      }
    }
  }

  return {
    dealId: deal.dealId,
    match: diffs.length === 0,
    comparedRows: records.size,
    comparedValues: records.size * REPLAYED_COMPONENTS.length,
    diffs,
    recordedTotals,
    computedTotals,
    adjustments: result.rows.flatMap((r) => r.adjustments.map((a) => ({ investorId: r.investorId, ...a }))),
    unrecorded: [...unrecorded.values()].map((u) => ({ ...u, computed: rows.get(u.investorId)! })),
    result,
  };
}

function toRecordedCents(amount: string, investorId: string, component: string): bigint {
  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`recorded ${component} '${amount}' for '${investorId}' is not a EUR amount with <= 2 decimals`);
  }
  return toUnitsExact(toStroops(amount), 2);
}
