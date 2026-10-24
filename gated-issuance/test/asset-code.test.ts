import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { assertValidAssetCode, deriveAssetCode } from '../src/issuance/asset-code';

describe('asset code derivation', () => {
  it('produces 4-char codes for short numeric deal ids', () => {
    expect(deriveAssetCode('42')).toBe('UF42');
    expect(deriveAssetCode('7')).toBe('UF07');
    expect(deriveAssetCode('99')).toBe('UF99');
  });

  it('uses the sanitized deal id for other deals, truncated to 12 and never padded', () => {
    expect(deriveAssetCode('UF-0042')).toBe('UF0042');
    expect(deriveAssetCode('uf-madrid')).toBe('UFMADRID');
    expect(deriveAssetCode('MADRID-CHAMBERI')).toBe('MADRIDCHAMBE');
  });

  it('validates the 1-12 ASCII alphanumeric rule', () => {
    for (const ok of ['U', 'UF4', 'UF42', 'UF0042', 'UF0042X', 'UFMADRID1', 'UF0042XXXXXX', 'uf42']) {
      expect(() => assertValidAssetCode(ok), ok).not.toThrow();
    }
    for (const bad of ['', 'UF0042XXXXXXX', 'UF-42', 'UF 42', 'UFÑ1']) {
      expect(() => assertValidAssetCode(bad), bad).toThrow(/invalid asset code/);
    }
  });

  it('accepts the real testnet asset UFMADRID1, which the SDK encodes as alphanum12', () => {
    expect(() => assertValidAssetCode('UFMADRID1')).not.toThrow();
    const issuer = SDK.Keypair.random().publicKey();
    expect(new SDK.Asset('UFMADRID1', issuer).getAssetType()).toBe('credit_alphanum12');
    expect(new SDK.Asset('UF42', issuer).getAssetType()).toBe('credit_alphanum4');
  });
});
