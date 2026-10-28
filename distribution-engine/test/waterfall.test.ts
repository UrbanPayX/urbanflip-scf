import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { emitSdpFiles } from '../src/emit/sdp-csv';
import { convertOnChain } from '../src/emit/usdc-conversion';
import { divHalfUp, formatCents, toRatio } from '../src/money/stroops';
import {
  computeWaterfall,
  daysBetween,
  fixedInterestCents,
  toDistributionSchedule,
  type WaterfallAdjustment,
  type WaterfallDeal,
  type WaterfallPosition,
} from '../src/compute/waterfall';
import {
  replayWaterfall,
  type RecordedSettlement,
  type UnrecordedPosition,
} from '../src/compute/waterfall-replay';

interface RealFixture {
  deal: WaterfallDeal;
  adjustments: WaterfallAdjustment[];
  unrecorded: UnrecordedPosition[];
  recorded: RecordedSettlement[];
}

const REAL_DEALS = ['velazquez-87', 'orense-9', 'general-peron-26'] as const;

function loadReal(name: string): RealFixture {
  return JSON.parse(readFileSync(join(__dirname, '../fixtures/real', `${name}.json`), 'utf8')) as RealFixture;
}

const STANDARD = { fixedRate: '0.08', feeShare: '1', withholdingRate: '0.19' };

function position(id: string, over: Partial<WaterfallPosition> = {}): WaterfallPosition {
  return {
    investorId: id,
    startDate: '2025-03-09',
    fixedPrincipal: '0.00',
    variablePrincipal: '0.00',
    terms: STANDARD,
    ...over,
  };
}

function deal(positions: WaterfallPosition[], over: Partial<WaterfallDeal> = {}): WaterfallDeal {
  return {
    dealId: 'd',
    endDate: '2025-09-17',
    fixedAccrual: { basis: 'act/365' },
    variableWeighting: 'capital-days',
    variablePool: '0.00',
    feePool: '0.00',
    positions,
    ...over,
  };
}

describe('historical replay: 3 completed real deals reproduce every recorded cent (D3.2)', () => {
  const expected = {
    'velazquez-87': { positions: 52, settlements: 51, net: '979398.92' },
    'orense-9': { positions: 51, settlements: 51, net: '1949852.50' },
    'general-peron-26': { positions: 47, settlements: 47, net: '1721056.12' },
  };

  for (const name of REAL_DEALS) {
    it(`${name}: every component of every settlement equals the payout record`, () => {
      const fx = loadReal(name);
      const report = replayWaterfall(fx.deal, fx.recorded, { adjustments: fx.adjustments, unrecorded: fx.unrecorded });
      expect(report.diffs).toEqual([]);
      expect(report.match).toBe(true);
      expect(fx.deal.positions).toHaveLength(expected[name].positions);
      expect(report.comparedRows).toBe(expected[name].settlements);
      expect(report.comparedValues).toBe(expected[name].settlements * 7);
      expect(report.computedTotals).toEqual(report.recordedTotals);
      expect(formatCents(report.recordedTotals.net)).toBe(expected[name].net);
      // Only what the fixture declares is adjusted or left uncompared.
      expect(report.adjustments.map((a) => [a.investorId, a.component])).toEqual(
        fx.adjustments.map((a) => [a.investorId, a.component]),
      );
      expect(report.unrecorded.map((u) => u.investorId)).toEqual(fx.unrecorded.map((u) => u.investorId));
    });
  }

  it('the declared adjustments explain their own positions and nothing else', () => {
    for (const name of REAL_DEALS) {
      const fx = loadReal(name);
      const report = replayWaterfall(fx.deal, fx.recorded, { unrecorded: fx.unrecorded });
      const adjusted = new Set(fx.adjustments.map((a) => a.investorId));
      expect(new Set(report.diffs.map((d) => d.investorId))).toEqual(adjusted);
    }
  });

  it('records the rule figure next to each manual adjustment', () => {
    const orense = loadReal('orense-9');
    const report = replayWaterfall(orense.deal, orense.recorded, {
      adjustments: orense.adjustments,
      unrecorded: orense.unrecorded,
    });
    expect(report.adjustments).toEqual([
      expect.objectContaining({ component: 'fixedInterest', ruleCents: 111733n, appliedCents: 111667n }),
    ]);
  });

  it('detects a one-cent change in any recorded component', () => {
    const fx = loadReal('general-peron-26');
    const target = fx.recorded[10]!;
    const tampered = fx.recorded.map((r) =>
      r === target ? { ...r, withholding: formatCents(BigInt(Math.round(Number(r.withholding) * 100)) + 1n) } : r,
    );
    const report = replayWaterfall(fx.deal, tampered, { adjustments: fx.adjustments, unrecorded: fx.unrecorded });
    expect(report.match).toBe(false);
    expect(report.diffs).toEqual([
      expect.objectContaining({ investorId: target.investorId, component: 'withholding', deltaCents: -1n }),
    ]);
  });

  it('a pool one cent off breaks the replay: the pools are pinned, not fitted loosely', () => {
    for (const name of ['orense-9', 'general-peron-26'] as const) {
      const fx = loadReal(name);
      for (const field of ['variablePool', 'feePool'] as const) {
        for (const step of [-1n, 1n]) {
          const pool = formatCents(BigInt(Math.round(Number(fx.deal[field]) * 100)) + step);
          const report = replayWaterfall({ ...fx.deal, [field]: pool }, fx.recorded, {
            adjustments: fx.adjustments,
            unrecorded: fx.unrecorded,
          });
          expect(report.match, `${name} ${field} ${pool}`).toBe(false);
        }
      }
    }
  });
});

describe('waterfall computation', () => {
  it('fixed tranche on actual/365 and on 2-decimal months', () => {
    // 4,000 x 8% x 192 / 365 = 168.328... -> 168.33
    expect(fixedInterestCents(400000n, '0.08', 192, { basis: 'act/365' })).toBe(16833n);
    // 9% term: 10,400 x 9% x 192 / 365 = 492.36
    expect(fixedInterestCents(1040000n, '0.09', 192, { basis: 'act/365' })).toBe(49236n);
    // 511 + 1 days / 30.4375 = 16.82 months; 5,000 x 8% / 12 x 16.82 = 560.67
    const months = { basis: 'months', daysPerMonth: '30.4375', inclusiveDays: true } as const;
    expect(fixedInterestCents(500000n, '0.08', 511, months)).toBe(56067n);
    // without the payout day: 511 / 30.4375 = 16.79 months -> 559.67
    expect(fixedInterestCents(500000n, '0.08', 511, { ...months, inclusiveDays: false })).toBe(55967n);
    expect(() => fixedInterestCents(1n, '0.08', 1, { ...months, daysPerMonth: '0' })).toThrow(/daysPerMonth/);
  });

  it('shares the variable pool by capital x days or by capital alone', () => {
    const positions = [
      position('a', { variablePrincipal: '1000.00', startDate: '2025-01-01' }),
      position('b', { variablePrincipal: '1000.00', startDate: '2025-07-02' }),
    ];
    const byTime = computeWaterfall(deal(positions, { endDate: '2025-12-31', variablePool: '300.00' }));
    // a: 364 days, b: 182 days -> 2:1
    expect(byTime.rows.map((r) => r.variableInterestCents)).toEqual([20000n, 10000n]);
    const byCapital = computeWaterfall(
      deal(positions, { endDate: '2025-12-31', variablePool: '300.00', variableWeighting: 'capital' }),
    );
    expect(byCapital.rows.map((r) => r.variableInterestCents)).toEqual([15000n, 15000n]);
  });

  it('per-row rounding reports its residual; largest-remainder sums exactly', () => {
    const positions = ['a', 'b', 'c'].map((id) => position(id, { variablePrincipal: '100.00' }));
    const perRow = computeWaterfall(
      deal(positions, { variablePool: '0.02', variableWeighting: 'capital', rounding: 'per-row-half-up' }),
    );
    // 0.00666... each rounds to 0.01: three cents paid from a two-cent pool
    expect(perRow.rows.map((r) => r.variableInterestCents)).toEqual([1n, 1n, 1n]);
    expect(perRow.residual.variableCents).toBe(-1n);
    const exact = computeWaterfall(deal(positions, { variablePool: '0.02', variableWeighting: 'capital' }));
    expect(exact.rounding).toBe('largest-remainder');
    expect(exact.rows.map((r) => r.variableInterestCents)).toEqual([1n, 1n, 0n]);
    expect(exact.residual).toEqual({ variableCents: 0n, feeCents: 0n });
  });

  it('charges the fee pool by fee share, then withholds on interest net of fee', () => {
    const positions = [
      position('full', { variablePrincipal: '1000.00' }),
      position('half', { variablePrincipal: '1000.00', terms: { ...STANDARD, feeShare: '0.5' } }),
      position('exempt', { variablePrincipal: '1000.00', terms: { ...STANDARD, feeShare: '0', withholdingRate: '0' } }),
    ];
    const result = computeWaterfall(
      deal(positions, { variableWeighting: 'capital', variablePool: '300.00', feePool: '30.00' }),
    );
    const [full, half, exempt] = result.rows;
    expect([full!.feeCents, half!.feeCents, exempt!.feeCents]).toEqual([2000n, 1000n, 0n]);
    expect(full!.interestAfterFeeCents).toBe(8000n);
    expect(full!.withholdingCents).toBe(1520n);
    expect(full!.netCents).toBe(100000n + 8000n - 1520n);
    expect(exempt!.withholdingCents).toBe(0n);
    expect(result.totals.feeCents).toBe(3000n);
  });

  it('a zero pool needs no bearer; a non-zero pool without one is refused', () => {
    const fixedOnly = [position('a', { fixedPrincipal: '1000.00' })];
    expect(computeWaterfall(deal(fixedOnly)).rows[0]!.variableInterestCents).toBe(0n);
    expect(() => computeWaterfall(deal(fixedOnly, { variablePool: '1.00' }))).toThrow(/variable pool .* no position/);
    const exempt = [position('a', { variablePrincipal: '10.00', terms: { ...STANDARD, feeShare: '0' } })];
    expect(() => computeWaterfall(deal(exempt, { variablePool: '1.00', feePool: '0.10' }))).toThrow(/fee pool/);
  });

  it('applies adjustments with the rule figure kept beside them', () => {
    const positions = [position('a', { fixedPrincipal: '4000.00' })];
    const result = computeWaterfall(deal(positions), {
      adjustments: [{ investorId: 'a', component: 'fixedInterest', amount: '168.00', reason: 'manual' }],
    });
    expect(result.rows[0]!.fixedInterestCents).toBe(16800n);
    expect(result.rows[0]!.adjustments).toEqual([
      { component: 'fixedInterest', ruleCents: 16833n, appliedCents: 16800n, reason: 'manual' },
    ]);
  });

  it('refuses malformed deals instead of guessing', () => {
    const ok = position('a', { fixedPrincipal: '100.00' });
    expect(() => computeWaterfall(deal([]))).toThrow(/no positions/);
    expect(() => computeWaterfall(deal([ok, ok]))).toThrow(/duplicate investorId 'a'/);
    expect(() => computeWaterfall(deal([position('a')]))).toThrow(/no principal/);
    expect(() =>
      computeWaterfall(deal([{ ...ok, terms: undefined as unknown as WaterfallPosition['terms'] }])),
    ).toThrow(/'a' has no terms/);
    expect(() => computeWaterfall(deal([{ ...ok, startDate: '2025-02-30' }]))).toThrow(/invalid date '2025-02-30'/);
    expect(() => computeWaterfall(deal([{ ...ok, startDate: '9/3/2025' }]))).toThrow(/invalid date/);
    expect(() => computeWaterfall(deal([{ ...ok, startDate: '2025-10-01' }]))).toThrow(/after end date/);
    expect(() => computeWaterfall(deal([{ ...ok, fixedPrincipal: '100.001' }]))).toThrow(/refusing to truncate/);
    expect(() => computeWaterfall(deal([{ ...ok, terms: { ...STANDARD, withholdingRate: '1.5' } }]))).toThrow(
      /withholdingRate 1.5 is above 1/,
    );
    expect(() => computeWaterfall(deal([{ ...ok, terms: { ...STANDARD, fixedRate: '8%' } }]))).toThrow(
      /invalid decimal rate/,
    );
    const variable = position('v', { variablePrincipal: '100.00' });
    expect(() =>
      computeWaterfall(deal([variable], { variableWeighting: 'capital', variablePool: '1.00', feePool: '2.00' })),
    ).toThrow(/fee exceeds its interest/);
  });

  it('refuses adjustments it cannot attribute', () => {
    const d = deal([position('a', { fixedPrincipal: '100.00' })]);
    const adj = (over: Partial<WaterfallAdjustment>): WaterfallAdjustment => ({
      investorId: 'a',
      component: 'fee',
      amount: '0.00',
      reason: 'why',
      ...over,
    });
    expect(() => computeWaterfall(d, { adjustments: [adj({ investorId: 'x' })] })).toThrow(/unknown investor 'x'/);
    expect(() => computeWaterfall(d, { adjustments: [adj({ reason: ' ' })] })).toThrow(/no reason/);
    expect(() => computeWaterfall(d, { adjustments: [adj({}), adj({ amount: '0.01' })] })).toThrow(/two fee/);
    expect(() =>
      computeWaterfall(d, { adjustments: [adj({ component: 'withholding', amount: '99.00' })] }),
    ).toThrow(/withholding exceeds its interest/);
  });

  it('counts calendar days across a leap year', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2025-01-27', '2026-06-22')).toBe(511);
  });
});

describe('waterfall replay guards', () => {
  const d = deal([position('a', { fixedPrincipal: '4000.00' }), position('b', { fixedPrincipal: '4000.00' })]);
  const record = (id: string, over: Partial<RecordedSettlement> = {}): RecordedSettlement => ({
    investorId: id,
    principal: '4000.00',
    fixedInterest: '168.33',
    variableInterest: '0.00',
    fee: '0.00',
    interestAfterFee: '168.33',
    withholding: '31.98',
    net: '4136.35',
    ...over,
  });

  it('matches a correct record', () => {
    expect(replayWaterfall(d, [record('a'), record('b')]).match).toBe(true);
  });

  it('never compares a different investor set silently', () => {
    expect(() => replayWaterfall(d, [record('a')])).toThrow(/missing investor 'b'/);
    expect(() => replayWaterfall(d, [record('a'), record('b'), record('c')])).toThrow(/unknown investor 'c'/);
    expect(() => replayWaterfall(d, [record('a'), record('a'), record('b')])).toThrow(/lists 'a' twice/);
    expect(() => replayWaterfall(d, [record('a')], { unrecorded: [{ investorId: 'x', reason: 'r' }] })).toThrow(
      /'x' is not in the deal/,
    );
    expect(() => replayWaterfall(d, [record('a'), record('b')], { unrecorded: [{ investorId: 'b', reason: 'r' }] })).toThrow(
      /declared unrecorded but has a record/,
    );
    expect(() => replayWaterfall(d, [record('a')], { unrecorded: [{ investorId: 'b', reason: '' }] })).toThrow(
      /has no reason/,
    );
    const declared = replayWaterfall(d, [record('a')], { unrecorded: [{ investorId: 'b', reason: 'not exported' }] });
    expect(declared.match).toBe(true);
    expect(declared.unrecorded[0]!.computed.netCents).toBe(413635n);
  });

  it('refuses recorded amounts that are not cents', () => {
    expect(() => replayWaterfall(d, [record('a', { net: '4136.351' }), record('b')])).toThrow(/<= 2 decimals/);
    expect(() => replayWaterfall(d, [record('a', { net: 4136.35 as unknown as string }), record('b')])).toThrow(
      /not a EUR amount/,
    );
  });
});

describe('waterfall -> USDC payment file', () => {
  const wallet = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));

  it('pays each investor their net, through the same USDC conversion and SDP emission', () => {
    const positions = [
      position('a', { variablePrincipal: '1000.00', email: 'a@x.y', walletAddress: wallet(1) }),
      position('b', { fixedPrincipal: '1000.00', email: 'b@x.y', walletAddress: wallet(2) }),
    ];
    const result = computeWaterfall(deal(positions, { variablePool: '100.00', feePool: '10.00' }));
    const schedule = toDistributionSchedule(result);
    expect(schedule.rows.map((r) => r.totalStroops)).toEqual(result.rows.map((r) => r.netCents * 100000n));
    expect(schedule.totals.totalStroops).toBe(result.totals.netCents * 100000n);
    const eur = formatCents(result.totals.netCents);
    const files = emitSdpFiles(convertOnChain(schedule, eur));
    expect(files[0]!.rowCount).toBe(2);
    expect(files[0]!.content).toContain(`${formatCents(result.rows[0]!.netCents)},a@x.y,${wallet(1)}`);
  });

  it('keeps legacy per-row rounding out of live payouts, and needs an email for every wallet', () => {
    const p = position('a', { variablePrincipal: '1000.00', walletAddress: wallet(1) });
    expect(() =>
      toDistributionSchedule(computeWaterfall(deal([p], { variablePool: '1.00', rounding: 'per-row-half-up' }))),
    ).toThrow(/legacy replay convention/);
    expect(() => toDistributionSchedule(computeWaterfall(deal([p], { variablePool: '1.00' })))).toThrow(
      /wallet but no email/,
    );
    const bankOnly = toDistributionSchedule(computeWaterfall(deal([{ ...p, walletAddress: undefined }])));
    expect(bankOnly.rows[0]!.email).toBe('');
  });
});

describe('exact money helpers', () => {
  it('parses rates, rounds half up, formats cents', () => {
    expect(toRatio('0.19')).toEqual([19n, 100n]);
    expect(toRatio('30.4375')).toEqual([304375n, 10000n]);
    expect(toRatio('1')).toEqual([1n, 1n]);
    expect(() => toRatio('-0.1')).toThrow(/invalid decimal rate/);
    expect(divHalfUp(5n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
    expect(divHalfUp(15n, 10n)).toBe(2n);
    expect(() => divHalfUp(-1n, 10n)).toThrow(/n >= 0 and d > 0/);
    expect(() => divHalfUp(1n, 0n)).toThrow(/n >= 0 and d > 0/);
    expect(formatCents(123456n)).toBe('1234.56');
    expect(formatCents(5n)).toBe('0.05');
    expect(formatCents(-5n)).toBe('-0.05');
    expect(formatCents(0n)).toBe('0.00');
  });
});
