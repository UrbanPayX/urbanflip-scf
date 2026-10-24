import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { generateStellarToml, LocalSep1Publisher } from '../src/sep1/stellar-toml';

const G = 'G'.repeat(56);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SEP-1 stellar.toml', () => {
  it('emits parseable TOML with one CURRENCIES block per deal asset', () => {
    const toml = generateStellarToml({
      documentation: {
        orgName: 'Urbanflip',
        orgUrl: 'https://urbanflip.io',
        orgSupportEmail: 'compliance@urbanflip.io',
      },
      currencies: [
        { code: 'UF0042XXXXXX', issuer: G, name: 'Urbanflip Deal #42', conditions: 'https://app.urbanflip.io/deals/42' },
        { code: 'UF0043XXXXXX', issuer: 'A'.repeat(56), name: 'Urbanflip Deal #43' },
      ],
    });

    const parsed = parse(toml) as {
      DOCUMENTATION: Record<string, string>;
      CURRENCIES: Array<Record<string, string | number>>;
    };
    expect(parsed.DOCUMENTATION!.ORG_NAME).toBe('Urbanflip');
    expect(parsed.DOCUMENTATION!.ORG_URL).toBe('https://urbanflip.io');
    expect(parsed.CURRENCIES).toHaveLength(2);
    expect(parsed.CURRENCIES![0]).toMatchObject({ code: 'UF0042XXXXXX', issuer: G });
    expect(parsed.CURRENCIES![1]!.issuer).toBe('A'.repeat(56));
  });

  it('escapes TOML-significant characters in strings', () => {
    const toml = generateStellarToml({
      documentation: { orgName: 'Urbanflip "co-invest" SL', orgUrl: 'https://urbanflip.io' },
      currencies: [{ code: 'UF42', issuer: G }],
    });
    expect(() => parse(toml)).not.toThrow();
    const parsed = parse(toml) as { DOCUMENTATION: Record<string, string> };
    expect(parsed.DOCUMENTATION!.ORG_NAME).toBe('Urbanflip "co-invest" SL');
  });

  it('publisher writes the file under the domain directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sep1-'));
    dirs.push(dir);
    const publisher = new LocalSep1Publisher(join(dir, 'sep1'));
    const path = await publisher.publish('urbanflip.io', '# toml\n');

    expect(path.endsWith('urbanflip.io/stellar.toml')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('# toml\n');
  });
});
