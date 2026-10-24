/** Exact-decimal helpers (same conventions as the D1/D3 engines). */
export function toStroops(decimal: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(decimal)) {
    throw new Error(`invalid decimal amount '${decimal}'`);
  }
  const [int, frac = ''] = decimal.split('.');
  return BigInt(int! + frac.padEnd(7, '0'));
}

/** Exact inverse of toStroops, signed: 123456700000n -> "12345.6700000". */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const digits = (negative ? -stroops : stroops).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -7)}.${digits.slice(-7)}`;
}

/** Trailing-zero-trimmed display keeping at least `minDecimals`: 1234500000n, 2 -> "123.45". */
export function displayAmount(stroops: bigint, minDecimals = 2): string {
  const [int, frac] = fromStroops(stroops).split('.') as [string, string];
  const trimmed = frac.replace(/0+$/, '');
  return `${int}.${frac.slice(0, Math.max(minDecimals, trimmed.length))}`;
}
