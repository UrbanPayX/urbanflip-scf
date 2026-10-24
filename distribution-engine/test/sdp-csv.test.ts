import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { computeDistribution } from '../src/compute/pro-rata';
import { emitSdpFiles } from '../src/emit/sdp-csv';
import { convertOnChain, type UsdcConversion } from '../src/emit/usdc-conversion';

/** Deterministic, checksum-valid Stellar account for test investor n. */
function wallet(n: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(n);
  return StrKey.encodeEd25519PublicKey(raw);
}

function scheduleFor(count: number) {
  const positions = Array.from({ length: count }, (_, i) => ({
    investorId: `i${i}`,
    email: `inv${i}@example.com`,
    principal: '1000.00',
    walletAddress: wallet(i),
  }));
  return computeDistribution(
    { dealId: 'UF-0042', positions },
    { principalRepayment: `${count * 1000}.00`, performanceInterest: '500.00' },
    { decimals: 2 },
  );
}

function oneInvestor(email: string): UsdcConversion {
  const schedule = computeDistribution(
    { dealId: 'd', positions: [{ investorId: 'i0', email, principal: '100.00', walletAddress: wallet(0) }] },
    { principalRepayment: '100.00', performanceInterest: '10.00' },
    { decimals: 2 },
  );
  return convertOnChain(schedule, '110.00');
}

describe('SDP CSV emission', () => {
  it('emits USDC (not EUR) amounts in the 5-field SDP disbursement format', () => {
    // EUR 3,500 owed in total; the treasury bought USDC 3,797.50 (1.085 USDC/EUR).
    const conversion = convertOnChain(scheduleFor(3), '3797.50');
    const files = emitSdpFiles(conversion);
    expect(files).toHaveLength(1);
    const lines = files[0]!.content.trim().split('\n');
    expect(lines[0]).toBe('amount,id,destination,memo,memo_type');
    expect(lines.every((l) => l.split(',').length === 5), lines.join('\n')).toBe(true);
    const cols = lines[1]!.split(',');
    expect(conversion.payouts[0]!.eur).toBe('1166.67'); // 1000 principal + 166.67 interest share
    expect(cols[0]).toBe('1265.84'); // ... paid as USDC at the batch rate, not as EUR 1166.67
    expect(cols[1]).toBe('inv0@example.com');
    expect(cols[2]).toBe(wallet(0));
    expect(cols[3]).toBe('');
    expect(cols[4]).toBe('');
    expect(lines).toHaveLength(4);
    expect(files[0]!.name).toBe('sdp-UF-0042-001.csv');
  });

  it('splits batches at the 10,000-row SDP cap', () => {
    const files = emitSdpFiles(convertOnChain(scheduleFor(10_001), '10001500.00'), { maxRowsPerFile: 10_000 });
    expect(files.map((f) => f.rowCount)).toEqual([10_000, 1]);
    expect(files[1]!.name).toBe('sdp-UF-0042-002.csv');
  });

  it('escapes CSV-hostile identifiers (comma, quote, CR, LF) instead of corrupting rows', () => {
    const line = emitSdpFiles(oneInvestor('weird,"comma"@example.com'))[0]!.content.split('\n')[1]!;
    expect(line).toContain('"weird,""comma""@example.com"');

    const cr = emitSdpFiles(oneInvestor('a\rb@example.com'))[0]!.content;
    expect(cr).toContain(`110.00,"a\rb@example.com",${wallet(0)},,`);
  });

  it('refuses an EUR schedule handed over on the old signature', () => {
    const schedule = scheduleFor(2) as unknown as UsdcConversion;
    expect(() => emitSdpFiles(schedule)).toThrow(/not an EUR distribution schedule/);
  });

  it('re-validates destinations and amounts at the sink', () => {
    const good = oneInvestor('a@x.y');
    const tamperedDestination = { ...good, payouts: [{ ...good.payouts[0]!, destination: 'G'.padEnd(56, 'X') }] };
    expect(() => emitSdpFiles(tamperedDestination)).toThrow(/not a valid Stellar account/);
    const tamperedAmount = { ...good, payouts: [{ ...good.payouts[0]!, usdc: '1,10' }] };
    expect(() => emitSdpFiles(tamperedAmount)).toThrow(/2-decimal/);
  });
});
