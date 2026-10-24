/**
 * Stellar asset codes are 1-12 ASCII alphanumerics: 1-4 characters encode as
 * credit_alphanum4, 5-12 as credit_alphanum12 (the SDK picks the encoding and
 * NUL-pads on the wire, so codes are never padded here). Derivation policy:
 *   - deals with a short numeric id (1-2 digits) get a 4-char code: PREFIX + zero-padded digits
 *   - everything else gets the sanitized, uppercased deal id, truncated to 12 characters
 */
export function deriveAssetCode(dealId: string, prefix = 'UF'): string {
  const digits = dealId.replace(/\D/g, '');
  if (digits.length > 0 && digits.length <= 2) {
    return (prefix + digits.padStart(4 - prefix.length, '0')).slice(0, 4);
  }
  const slug = dealId.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return slug.slice(0, 12);
}

export function assertValidAssetCode(code: string): void {
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw new Error(`invalid asset code '${code}': must be 1-12 ASCII letters and digits`);
  }
}
