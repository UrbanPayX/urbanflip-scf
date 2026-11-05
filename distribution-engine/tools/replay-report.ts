import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCents } from '../src/money/stroops';
import { eurJson, type WaterfallAdjustment, type WaterfallDeal } from '../src/compute/waterfall';
import {
  REPLAYED_COMPONENTS,
  replayWaterfall,
  type RecordedSettlement,
  type UnrecordedPosition,
  type WaterfallReplayReport,
} from '../src/compute/waterfall-replay';

/**
 * D3.2 evidence: replays the three real deals in fixtures/real and writes
 * evidence/d3-replay-report.md. Deterministic: the same fixtures always give
 * the same file.
 *
 *   npm run replay:report              full report, per investor (private repo only)
 *   npm run replay:report -- --public  per-deal aggregates + SHA-256 of each
 *                                      private input file (public evidence)
 *
 * fixtures/real holds real payout data (pseudonymized investor ids) and is not
 * part of the public repo; without it this tool has nothing to replay.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEALS = ['velazquez-87', 'orense-9', 'general-peron-26'];
const PUBLIC = process.argv.includes('--public');

interface Fixture {
  source: { deal: string; export: string; pseudonymization: string; terms: string; notes: string[] };
  deal: WaterfallDeal;
  adjustments: WaterfallAdjustment[];
  unrecorded: UnrecordedPosition[];
  recorded: RecordedSettlement[];
}

const eur = (cents: bigint) => {
  const [int, dec] = formatCents(cents).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
};
const LABEL: Record<(typeof REPLAYED_COMPONENTS)[number], string> = {
  principal: 'Principal',
  fixedInterest: 'Fixed interest',
  variableInterest: 'Variable interest',
  fee: 'Success fee',
  interestAfterFee: 'Interest after fee',
  withholding: 'Withholding',
  net: 'Net paid',
};

function main(): void {
  const runs = DEALS.map((name) => {
    const fx = JSON.parse(readFileSync(join(here, '../fixtures/real', `${name}.json`), 'utf8')) as Fixture;
    const report = replayWaterfall(fx.deal, fx.recorded, { adjustments: fx.adjustments, unrecorded: fx.unrecorded });
    if (!report.match) throw new Error(`${name} does not replay: ${report.diffs.length} differences`);
    return { name, fx, report };
  });

  const md: string[] = [];
  const settlements = runs.reduce((a, r) => a + r.report.comparedRows, 0);
  const values = runs.reduce((a, r) => a + r.report.comparedValues, 0);
  md.push(
    '# D3.2 Replay of 3 completed real deals',
    '',
    '> **Criterion (as submitted):** Replay of 3 completed real deals\' actual payout data reproduces historical amounts exactly.',
    '',
    `**Result:** ${settlements} recorded settlements x 7 components = **${values} amounts, every one reproduced to the cent** (difference 0.00 EUR per investor and in total), ` +
      `given ${runs.reduce((a, r) => a + r.report.adjustments.length, 0)} paid amounts that depart from the rule, each declared as an adjustment with its reason, and ` +
      `${runs.reduce((a, r) => a + r.report.unrecorded.length, 0)} declared position with no payout record (see Exceptions).`,
    '',
    PUBLIC
      ? 'The engine and replay logic are public: `src/compute/waterfall.ts`, `src/compute/waterfall-replay.ts`, API `POST /v1/deals/{dealId}/waterfall/replay` (api/openapi.yaml); `npm test` replays synthetic deals everywhere and skips the real-deal suite unless the private `fixtures/real` is present. The input files below are private; their SHA-256 digests pin exactly what this report was computed from.'
      : 'Reproduce: `cd distribution-engine && npm test` (test/waterfall.test.ts) or `npm run replay:report` (writes this file). ' +
        'Data: `fixtures/real/*.json`; engine: `src/compute/waterfall.ts`, `src/compute/waterfall-replay.ts`; API: `POST /v1/deals/{dealId}/waterfall/replay` (api/openapi.yaml).',
    '',
    '| Deal | Payout date | Positions | Settlements compared | Amounts compared | Differences | Net paid (recorded) | Net (computed) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...runs.map(
      ({ fx, report }) =>
        `| ${fx.source.deal} | ${fx.deal.endDate} | ${fx.deal.positions.length} | ${report.comparedRows} | ${report.comparedValues} | ${report.diffs.length} | ${eur(report.recordedTotals.net)} | ${eur(report.computedTotals.net)} |`,
    ),
    '',
    '## How a settlement is computed',
    '',
    'Each position is a fixed tranche plus a variable tranche (Urbanflip participative loans):',
    '',
    '```',
    'fixed interest     = fixed principal x rate x accrual         (act/365, or 2-decimal months)',
    'variable interest  = variable pool x weight / total weight     (weight: capital, or capital x days)',
    'fee                = fee pool x weight x feeShare / total fee-bearing weight',
    'interest after fee = fixed + variable - fee',
    'withholding        = interest after fee x withholding rate',
    'net paid           = principal + interest after fee - withholding',
    '```',
    '',
    '- **Exact arithmetic.** Money is integer cents, rates exact decimals; no float anywhere.',
    '- **Rounding rule (as the platform settled):** every row is rounded half up to the cent on its own. Leftover cents are not redistributed: the difference between a pool and the sum of its rows (the residual below) stays with the SPV when positive and was paid by it when negative.',
    '- **Live payouts** computed by the engine use largest-remainder instead: the rows sum to each pool exactly, the leftover cents going to the largest fractional remainders, ties by investorId. Only those results are converted to USDC and emitted as SDP files.',
    '- **Investor ids** are pseudonyms: HMAC-SHA256 with a salt held only by Urbanflip, per deal (the same investor cannot be linked across deals). Amounts and dates are real.',
    '',
  );

  for (const { fx, report } of runs) {
    const { deal } = fx;
    const accrual =
      deal.fixedAccrual.basis === 'act/365'
        ? 'actual/365'
        : `months = (days${deal.fixedAccrual.inclusiveDays ? ' + 1' : ''}) / ${deal.fixedAccrual.daysPerMonth}, 2 decimals`;
    md.push(
      `## ${fx.source.deal}`,
      '',
      `Payout ${deal.endDate} · fixed tranche ${accrual} · variable and fee by ${deal.variableWeighting === 'capital' ? 'capital' : 'capital x days'} · variable pool ${eur(cents(deal.variablePool))} · fee pool ${eur(cents(deal.feePool))} · residual: variable ${formatCents(report.result.residual.variableCents)}, fee ${formatCents(report.result.residual.feeCents)}`,
      '',
      ...fx.source.notes.map((n) => `- ${n}`),
      `- Terms: ${termSummary(deal)}. ${fx.source.terms}.`,
      '',
      '| Component | Recorded | Computed | Difference |',
      '| --- | ---: | ---: | ---: |',
      ...REPLAYED_COMPONENTS.map(
        (c) =>
          `| ${LABEL[c]} | ${eur(report.recordedTotals[c])} | ${eur(report.computedTotals[c])} | ${formatCents(report.computedTotals[c] - report.recordedTotals[c])} |`,
      ),
      '',
      ...(PUBLIC
        ? []
        : [
            '<details><summary>Per investor (recorded = computed for every component)</summary>',
            '',
            '| Investor | Start | Principal | Fixed | Variable | Fee | Withholding | Net paid | Net computed | Difference |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
            ...fx.recorded.map((rec) => {
              const row = report.result.rows.find((r) => r.investorId === rec.investorId)!;
              const start = deal.positions.find((p) => p.investorId === rec.investorId)!.startDate;
              const mark = row.adjustments.length > 0 ? ' *' : '';
              return `| ${rec.investorId}${mark} | ${start} | ${eur(row.principalCents)} | ${eur(row.fixedInterestCents)} | ${eur(row.variableInterestCents)} | ${eur(row.feeCents)} | ${eur(row.withholdingCents)} | ${eur(cents(rec.net))} | ${eur(row.netCents)} | ${formatCents(row.netCents - cents(rec.net))} |`;
            }),
            '',
            '\\* manual adjustment, see Exceptions.',
            '',
            '</details>',
            '',
          ]),
    );
  }

  md.push('## Exceptions', '');
  for (const { fx, report } of runs) {
    for (const a of report.adjustments) {
      md.push(
        PUBLIC
          ? a.ruleCents === 0n
            ? `- **${fx.source.deal}:** a ${LABEL[a.component].toLowerCase()} set by hand at settlement for a position the rule leaves without one, entered as a declared override; the figures are kept in the private record.`
            : `- **${fx.source.deal}:** a ${LABEL[a.component].toLowerCase()} paid ${formatCents(absCents(a.ruleCents - a.appliedCents))} EUR ${a.appliedCents < a.ruleCents ? 'below' : 'above'} the rule, entered as a declared override; the rule figure is kept beside it in the private record.`
          : `- **${fx.source.deal}, ${a.investorId}: ${a.component}** paid ${eur(a.appliedCents)}, the rule gives ${eur(a.ruleCents)}. ${a.reason}`,
      );
    }
    for (const u of report.unrecorded) {
      md.push(
        PUBLIC
          ? `- **${fx.source.deal}:** a position with no payout record in the export, declared unrecorded and excluded from the comparison.`
          : `- **${fx.source.deal}, ${u.investorId}: no payout record.** ${u.reason} The rule would pay net ${eur(u.computed.netCents)} (fixed interest ${eur(u.computed.fixedInterestCents)}).`,
      );
    }
  }
  md.push(
    '',
    'Confirmed by Urbanflip on 2026-11-01: the deal-level pools (not in the export; each is the cent amount that reproduces every row), the investor terms (read off the payouts within closed sets), the Orense 9 month formula, and the three exceptions above.',
    '',
  );

  if (PUBLIC) {
    md.push(
      '## Provenance and privacy',
      '',
      'Investor-level payout data is personal data and stays out of this repository: it lives in Urbanflip\'s private repo, pseudonymized per deal (HMAC-SHA256 with a salt held only by Urbanflip, so one investor cannot be linked across deals). Pseudonymized per-investor rows are available to reviewers on request.',
      '',
      'Each private input file this replay was computed from is pinned below; a reviewer holding the private data verifies the report by matching these digests and re-running `npm run replay:report`.',
      '',
      '| Private input file (fixtures/real/) | SHA-256 |',
      '| --- | --- |',
      ...['deals.config.json', ...DEALS.map((d) => `${d}.json`)].map(
        (f) => `| ${f} | ${createHash('sha256').update(readFileSync(join(here, '../fixtures/real', f))).digest('hex')} |`,
      ),
      '',
    );
  }

  const out = join(here, '../evidence');
  writeFileSync(join(out, 'd3-replay-report.md'), md.join('\n'));
  if (!PUBLIC) {
    writeFileSync(
      join(out, 'd3-replay-report.json'),
      JSON.stringify(
        runs.map(({ fx, report }) => ({ deal: fx.source.deal, ...(eurJson(summary(report)) as object) })),
        null,
        2,
      ) + '\n',
    );
  }
  console.log(
    `${values} amounts across ${settlements} settlements reproduced to the cent -> ${join(out, PUBLIC ? 'd3-replay-report.md' : 'd3-replay-report.md + .json')}`,
  );
}

function absCents(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function summary(report: WaterfallReplayReport) {
  const { result, ...rest } = report;
  return { ...rest, residual: result.residual, rows: result.rows };
}

function termSummary(deal: WaterfallDeal): string {
  const count = (pick: (p: WaterfallDeal['positions'][number]) => string) => {
    const counts = new Map<string, number>();
    for (const p of deal.positions) counts.set(pick(p), (counts.get(pick(p)) ?? 0) + 1);
    return [...counts].map(([k, n]) => `${k} x${n}`).join(', ');
  };
  return `fixed rate ${count((p) => p.terms.fixedRate)}; fee share ${count((p) => p.terms.feeShare)}; withholding ${count((p) => p.terms.withholdingRate)}`;
}

function cents(amount: string): bigint {
  const [int, frac = ''] = amount.split('.');
  return BigInt(int! + frac.padEnd(2, '0'));
}

main();
