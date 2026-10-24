import { describe, expect, it } from 'vitest';
import { displayAmount, fromStroops, fromUnits, toStroops, toUnitsExact } from '../src/money/stroops';

describe('stroop arithmetic (no floats anywhere)', () => {
  it('parses and formats exactly', () => {
    expect(toStroops('12345.67')).toBe(123456700000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('42')).toBe(420000000n);
    expect(fromStroops(123456700000n)).toBe('12345.6700000');
    expect(fromStroops(1n)).toBe('0.0000001');
  });

  it('rejects unusable amounts', () => {
    expect(() => toStroops('-5')).toThrow();
    expect(() => toStroops('1.12345678')).toThrow(); // 8 decimals
    expect(() => toStroops('abc')).toThrow();
    expect(() => toStroops('1,5')).toThrow();
  });

  it('converts between precisions exactly or not at all', () => {
    expect(toUnitsExact(1505000000n, 2)).toBe(15050n); // 150.50 -> 15050 cents
    expect(() => toUnitsExact(1500000001n, 2)).toThrow(); // sub-cent residue
    expect(fromUnits(15050n, 2)).toBe(1505000000n);
  });

  it('displays trailing-zero-trimmed amounts', () => {
    expect(displayAmount(toStroops('150.50'))).toBe('150.50');
    expect(displayAmount(toStroops('150.00'))).toBe('150.00');
    expect(displayAmount(toStroops('150.0000001'))).toBe('150.0000001');
  });
});
