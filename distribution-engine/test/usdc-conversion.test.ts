import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { computeDistribution } from '../src/compute/pro-rata';
import { convertOnChain, rateDisplay } from '../src/emit/usdc-conversion';
import { displayAmount, toStroops } from '../src/money/stroops';

/** Deterministic, checksum-valid Stellar account for test investor n. */
function wallet(n: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(n);
  return StrKey.encodeEd25519PublicKey(raw);
}

/** EUR schedule with zero interest: each investor is owed exactly their principal. */
function schedule(principals: Array<[id: string, principal: string, walletAddress?: string]>) {
  const total = principals.reduce((a, [, p]) => a + toStroops(p), 0n);
  return computeDistribution(
    {
      dealId: 'UF-0042',
      positions: principals.map(([investorId, principal, walletAddress]) => ({
        investorId,
        email: `${investorId}@x.y`,
        principal,
        walletAddress,
      })),
    },
    { principalRepayment: displayAmount(total), performanceInterest: '0' },
  );
}

const sumUsdc = (payouts: Array<{ usdc: string }>) => payouts.reduce((a, p) => a + toStroops(p.usdc), 0n);

describe('EUR -> USDC conversion of the on-chain cohort', () => {
  it('converts only the on-chain cohort of a mixed deal and reports the bank-paid rest', () => {
    // b is paid by bank: it has no wallet at all, or a wallet outside the cohort.
    const mixed = schedule([['a', '300', wallet(1)], ['b', '100'], ['c', '100', wallet(3)]]);
    const conversion = convertOnChain(mixed, '434.00', { onChainCohort: new Set([wallet(1), wallet(3)]) });
    expect(conversion.payouts.map((p) => [p.investorId, p.usdc])).toEqual([['a', '325.50'], ['c', '108.50']]);
    expect(conversion).toMatchObject({ eurTotal: '400.00', otherRail: [{ investorId: 'b', eur: '100.00' }], otherRailEurTotal: '100.00' });
    expect(() => convertOnChain(mixed, '434.00')).toThrow(/lack a wallet/);
    expect(() => convertOnChain(mixed, '434.00', { onChainCohort: new Set([wallet(1), wallet(9)]) })).toThrow(/missing from the schedule/);
  });

  it('refuses a payout that would round to 0.00 USDC', () => {
    const dust = schedule([['a', '1000', wallet(1)], ['b', '0.001', wallet(2)]]);
    expect(() => convertOnChain(dust, '1085.00')).toThrow(/0\.00 USDC/);
  });

  it('splits usdcFunded exactly to the cent at one rate, odd cents by largest remainder then id', () => {
    const equal = schedule([['a', '100', wallet(1)], ['b', '100', wallet(2)], ['c', '100', wallet(3)]]);
    const conversion = convertOnChain(equal, '325.01');
    // 325.01 / 3 = 108.3366..: two odd cents, equal remainders -> ties broken by id
    expect(conversion.payouts.map((p) => p.usdc)).toEqual(['108.34', '108.34', '108.33']);
    expect(sumUsdc(conversion.payouts)).toBe(toStroops('325.01'));
    expect(conversion).toMatchObject({ eurTotal: '300.00', usdcTotal: '325.01', rate: '1.083366' });

    // 'b' owns the larger remainder (.666 vs .333) and wins the odd cent despite sorting after 'a'
    const uneven = convertOnChain(schedule([['a', '200', wallet(1)], ['b', '100', wallet(2)]]), '300.02');
    expect(uneven.payouts.map((p) => [p.investorId, p.eur, p.usdc])).toEqual([
      ['a', '200.00', '200.01'],
      ['b', '100.00', '100.01'],
    ]);
    expect(sumUsdc(uneven.payouts)).toBe(toStroops('300.02'));
  });

  it('refuses an implied rate outside 0.5-2 USDC per EUR (bounds inclusive)', () => {
    const s = schedule([['a', '100', wallet(1)], ['b', '200', wallet(2)]]);
    expect(() => convertOnChain(s, '3.00')).toThrow(/implied rate 0.010000 USDC per EUR/); // EUR typed as cents
    expect(() => convertOnChain(s, '149.99')).toThrow(/implied rate/);
    expect(() => convertOnChain(s, '600.01')).toThrow(/implied rate/);
    expect(() => convertOnChain(s, '0')).toThrow(/must be positive/);
    expect(convertOnChain(s, '150.00').rate).toBe('0.500000');
    expect(convertOnChain(s, '600.00').rate).toBe('2.000000');
  });

  it('refuses usdcFunded with more than 2 decimals', () => {
    const s = schedule([['a', '100', wallet(1)]]);
    expect(() => convertOnChain(s, '108.505')).toThrow(/at most 2 decimals/);
    expect(() => convertOnChain(s, '108,50')).toThrow(/invalid decimal amount/);
  });

  it('refuses rows without a wallet and filters that disagree with the schedule (no silent exclusions)', () => {
    expect(() => convertOnChain(schedule([['a', '100', wallet(1)], ['b', '100']]), '200.00')).toThrow(
      /lack a wallet address/,
    );
    const s = schedule([['a', '100', wallet(1)], ['b', '100', wallet(2)]]);
    expect(() => convertOnChain(s, '200.00', { onlyAddresses: new Set([wallet(1)]) })).toThrow(/address filter/);
    expect(() => convertOnChain(s, '200.00', { onlyAddresses: new Set([wallet(1), wallet(2), wallet(9)]) })).toThrow(
      new RegExp(`missing from the schedule \\(first: ${wallet(9)}\\)`),
    );
    expect(convertOnChain(s, '200.00', { onlyAddresses: new Set([wallet(1), wallet(2)]) }).payouts).toHaveLength(2);
  });

  it('refuses wallet addresses that are not a valid Stellar account StrKey', () => {
    const valid = wallet(1);
    const bad = [
      'G'.padEnd(56, 'X'), // right shape, wrong checksum
      `${valid},injected`, // would add CSV fields
      `${valid}\r`,
      valid.toLowerCase(),
      StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1)), // muxed M... account
    ];
    for (const address of bad) {
      expect(() => convertOnChain(schedule([['a', '100', address]]), '100.00'), address).toThrow(
        /investor 'a': wallet address .* is not a valid Stellar account/s,
      );
    }
  });

  it('displays the achieved rate to 6 decimals without floats', () => {
    expect(rateDisplay(toStroops('39060.00'), toStroops('36000.00'))).toBe('1.085000');
    expect(rateDisplay(1n, 3n)).toBe('0.333333');
  });
});
