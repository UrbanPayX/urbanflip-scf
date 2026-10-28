/**
 * Exact decimal money math on BigInt stroops (1 unit = 10^-7), the same
 * precision Stellar amounts use. No floats anywhere in the computation path —
 * "replays historical amounts exactly" is only believable in integer math.
 */
export const MAX_DECIMALS = 7;

/** '12345.67' -> 123456700000n (validation: non-negative, <= 7 decimals) */
export function toStroops(decimal: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(decimal)) {
    throw new Error(`invalid decimal amount '${decimal}' (expected non-negative, <= 7 decimals)`);
  }
  const [int, frac = ''] = decimal.split('.');
  return BigInt(int! + frac.padEnd(7, '0'));
}

/** 123456700000n -> '12345.6700000' */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const s = abs.toString().padStart(8, '0');
  const out = `${s.slice(0, -7)}.${s.slice(-7)}`;
  return negative ? '-' + out : out;
}

/** Scales a stroop amount to a coarser precision unit count. 1505000000n @2dp -> 15050n cents, exact or throws. */
export function toUnitsExact(stroops: bigint, decimals: number): bigint {
  const factor = 10n ** BigInt(MAX_DECIMALS - decimals);
  if (stroops % factor !== 0n) {
    throw new Error(
      `amount ${displayAmount(stroops)} cannot be represented exactly at ${decimals} decimals; refusing to truncate`,
    );
  }
  return stroops / factor;
}

/** Units at `decimals` precision -> stroops. 150500n @2dp -> 1505000000n */
export function fromUnits(units: bigint, decimals: number): bigint {
  return units * 10n ** BigInt(MAX_DECIMALS - decimals);
}

/** Trailing-zero-trimmed display, keeping at least `minDecimals`. */
export function displayAmount(stroops: bigint, minDecimals = 2): string {
  const [int, frac] = fromStroops(stroops).split('.');
  const trimmed = frac!.replace(/0+$/, '');
  const keep = Math.max(minDecimals, Math.min(trimmed.length, MAX_DECIMALS));
  return `${int}.${frac!.slice(0, keep).padEnd(keep, '0')}`;
}

/** '0.19' -> [19n, 100n]: an exact decimal rate as numerator/denominator (non-negative, <= 12 decimals). */
export function toRatio(decimal: string): readonly [bigint, bigint] {
  if (!/^\d+(\.\d{1,12})?$/.test(decimal)) {
    throw new Error(`invalid decimal rate '${decimal}' (expected non-negative, <= 12 decimals)`);
  }
  const [int, frac = ''] = decimal.split('.');
  return [BigInt(int! + frac), 10n ** BigInt(frac.length)];
}

/** n / d rounded half up, for n >= 0 and d > 0: the rounding a bank ledger applies to each computed row. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error(`divHalfUp expects n >= 0 and d > 0 (got ${n}/${d})`);
  return (2n * n + d) / (2n * d);
}

/** 123456n cents -> '1234.56' (negative amounts keep their sign: -5n -> '-0.05'). */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const s = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
}
