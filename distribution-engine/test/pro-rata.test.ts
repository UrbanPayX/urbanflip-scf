import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDistribution } from '../src/compute/pro-rata';
import type { DealLedger, DealOutcome } from '../src/compute/pro-rata';
import { replayDeal } from '../src/compute/replay';
import { toStroops } from '../src/money/stroops';

interface Fixture {
  ledger: DealLedger;
  outcome: DealOutcome;
  policy: 'largest-remainder' | 'last-absorbs';
  historicalPayouts: Array<{ investorId: string; amount: string }>;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(__dirname, '../fixtures', `${name}.json`), 'utf8')) as Fixture;
}

const THREE_DEALS = ['deal-madrid-001', 'deal-chamartin-002', 'deal-salamanca-003'];

describe('pro-rata computation', () => {
  it('sums of rows always equal outcome totals, to the stroop', () => {
    const fx = loadFixture('deal-salamanca-003');
    const schedule = computeDistribution(fx.ledger, fx.outcome, { decimals: 7 });
    expect(schedule.totals.principalStroops).toBe(toStroops(fx.outcome.principalRepayment));
    expect(schedule.totals.interestStroops).toBe(toStroops(fx.outcome.performanceInterest));
    expect(schedule.totals.totalStroops).toBe(
      toStroops(fx.outcome.principalRepayment) + toStroops(fx.outcome.performanceInterest),
    );
  });

  it('repays principal exactly and allocates interest pro-rata by principal', () => {
    const ledger: DealLedger = {
      dealId: 'd',
      positions: [
        { investorId: 'i1', email: 'a@x.y', principal: '30000.00' },
        { investorId: 'i2', email: 'b@x.y', principal: '10000.00' },
      ],
    };
    const schedule = computeDistribution(
      ledger,
      { principalRepayment: '40000.00', performanceInterest: '8000.00' },
      { decimals: 7 },
    );
    expect(schedule.rows[0]!.principalStroops).toBe(toStroops('30000.00'));
    expect(schedule.rows[1]!.principalStroops).toBe(toStroops('10000.00'));
    // 3:1 principal split => 3:1 interest split
    expect(schedule.rows[0]!.interestStroops).toBe(toStroops('6000.00'));
    expect(schedule.rows[1]!.interestStroops).toBe(toStroops('2000.00'));
  });

  it('rejects an outcome whose principal does not match the ledger', () => {
    const ledger: DealLedger = {
      dealId: 'd',
      positions: [{ investorId: 'i1', email: 'a@x.y', principal: '100.00' }],
    };
    expect(() =>
      computeDistribution(ledger, { principalRepayment: '200.00', performanceInterest: '10.00' }),
    ).toThrow(/principal/);
  });

  it('refuses amounts finer than the computation precision instead of truncating them', () => {
    const ledger: DealLedger = {
      dealId: 'd',
      positions: [
        { investorId: 'i1', email: 'a@x.y', principal: '100.00' },
        { investorId: 'i2', email: 'b@x.y', principal: '50.00' },
      ],
    };
    const opts = { decimals: 2 };
    // Truncating 8.005 to 8.00 would leave the rows half a cent short of the outcome.
    expect(() =>
      computeDistribution(ledger, { principalRepayment: '150.00', performanceInterest: '8.005' }, opts),
    ).toThrow(/amount 8.005 cannot be represented exactly at 2 decimals; refusing to truncate/);
    const finePrincipal: DealLedger = {
      ...ledger,
      positions: [{ ...ledger.positions[0]!, principal: '100.004' }, ledger.positions[1]!],
    };
    expect(() =>
      computeDistribution(finePrincipal, { principalRepayment: '150.00', performanceInterest: '8.00' }, opts),
    ).toThrow(/100.004 cannot be represented exactly/);
    const ok = computeDistribution(ledger, { principalRepayment: '150.00', performanceInterest: '8.01' }, opts);
    expect(ok.totals.totalStroops).toBe(toStroops('158.01'));
  });

  it('distributes sub-unit dust deterministically per policy', () => {
    // 3 investors, equal weights, 1 cent of interest: exactly one cent exists to give.
    const ledger: DealLedger = {
      dealId: 'd',
      positions: [
        { investorId: 'a', email: 'a@x.y', principal: '100.00' },
        { investorId: 'b', email: 'b@x.y', principal: '100.00' },
        { investorId: 'c', email: 'c@x.y', principal: '100.00' },
      ],
    };
    const outcome = { principalRepayment: '300.00', performanceInterest: '0.01' };
    const lr = computeDistribution(ledger, outcome, { decimals: 2, remainderPolicy: 'largest-remainder' });
    // perfect tie on fractional remainder -> broken deterministically by investorId: 'a' wins
    expect(lr.rows.map((r) => r.interestStroops)).toEqual([100000n, 0n, 0n]);
    const sums = lr.rows.reduce((a, r) => a + r.interestStroops, 0n);
    expect(sums).toBe(toStroops('0.01'));

    const la = computeDistribution(ledger, outcome, { decimals: 2, remainderPolicy: 'last-absorbs' });
    expect(la.rows[2]!.interestStroops).toBe(toStroops('0.01'));
    expect(la.rows.slice(0, 2).every((r) => r.interestStroops === 0n)).toBe(true);
  });
});

describe('historical replay — 3 completed deals, exact reproduction (acceptance criterion)', () => {
  for (const deal of THREE_DEALS) {
    it(`${deal}: recomputed rows equal the recorded bank payouts to the cent`, () => {
      const fx = loadFixture(deal);
      const report = replayDeal(fx.ledger, fx.outcome, fx.historicalPayouts, {
        decimals: 2,
        remainderPolicy: fx.policy,
      });
      expect(report.match, JSON.stringify(report.diffs)).toBe(true);
      expect(report.comparedRows).toBe(fx.ledger.positions.length);
      expect(report.computedTotalStroops).toBe(report.recordedTotalStroops);
    });
  }

  it('detects a one-cent tampering of the historical record', () => {
    const fx = loadFixture('deal-madrid-001');
    const tampered = fx.historicalPayouts.map((h, i) =>
      i === 0 ? { ...h, amount: (Number(h.amount) + 0.01).toFixed(2) } : h,
    );
    const report = replayDeal(fx.ledger, fx.outcome, tampered, {
      decimals: 2,
      remainderPolicy: fx.policy,
    });
    expect(report.match).toBe(false);
    expect(report.diffs).toHaveLength(1);
    expect(Math.abs(Number(report.diffs[0]!.deltaStroops))).toBe(100000); // one cent in stroops
  });
});
