/** Minimal exact-decimal helpers (same conventions as the D3 engine). */
export function toStroops(decimal: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(decimal)) {
    throw new Error(`invalid decimal amount '${decimal}'`);
  }
  const [int, frac = ''] = decimal.split('.');
  return BigInt(int! + frac.padEnd(7, '0'));
}

export function fromStroops(stroops: bigint): string {
  const s = stroops.toString().padStart(8, '0');
  return `${s.slice(0, -7)}.${s.slice(-7)}`;
}
