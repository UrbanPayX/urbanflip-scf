import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { SettlementRecord } from '../src/issuance/subscription-settlement';
import { JsonFileIssuerStore, type IssuerRecord } from '../src/store/issuer-store';
import { SecretBox } from '../src/store/secret-box';
import { JsonFileSettlementStore } from '../src/store/settlement-store';

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const dirs: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stores lock their directory until close(); a "restart" closes the old instance first. */
function track<T extends { close(): Promise<void> }>(store: T): T {
  opened.push(store);
  return store;
}

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  dirs.push(dir);
  return join(dir, 'state', name);
}

function writeRaw(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function issuerRecord(dealId: string): IssuerRecord {
  const kp = SDK.Keypair.random();
  return {
    dealId,
    status: 'PENDING',
    assetCode: 'UFMADRID1',
    issuerPublicKey: kp.publicKey(),
    issuerSecret: kp.secret(),
    provisioningTxHash: 'ab'.repeat(32),
  };
}

describe('SecretBox (AES-256-GCM, bound to the record id)', () => {
  it('round-trips, and refuses another record id, another key or a bad key', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('SECRET-SEED', 'issuer:UF-1');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('SECRET-SEED');
    expect(box.open(sealed, 'issuer:UF-1')).toBe('SECRET-SEED');
    expect(() => box.open(sealed, 'issuer:UF-2')).toThrow(/cannot unseal/);
    expect(() => new SecretBox(OTHER_KEY).open(sealed, 'issuer:UF-1')).toThrow(/cannot unseal/);
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => SecretBox.fromHex('abcd')).toThrow(/64 hex/);
    expect(SecretBox.fromHex(KEY.toString('hex')).open(sealed, 'issuer:UF-1')).toBe('SECRET-SEED');
  });
});

describe('JsonFileIssuerStore', () => {
  it('persists sealed secrets only, atomically, with mode 0600', async () => {
    const path = tempPath('issuers.json');
    const record = issuerRecord('UF-1');
    const store = new JsonFileIssuerStore(path, KEY);
    await store.put(record);
    await store.close();

    const content = readFileSync(path, 'utf8');
    expect(content).toContain(record.issuerPublicKey);
    expect(content).not.toContain(record.issuerSecret);
    expect(content).not.toMatch(/S[A-Z2-7]{55}/); // no Stellar secret seed in any form
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    await expect(track(new JsonFileIssuerStore(path, KEY)).get('UF-1')).resolves.toEqual(record);
  });

  it('a wrong key fails on load instead of starting empty — even before any issuer exists', async () => {
    const path = tempPath('issuers.json');
    const store = new JsonFileIssuerStore(path, KEY);
    await store.put(issuerRecord('UF-1'));
    await store.close();
    expect(() => new JsonFileIssuerStore(path, OTHER_KEY)).toThrow(/cannot unseal/);

    const emptyPath = tempPath('empty.json');
    writeRaw(emptyPath, JSON.stringify({ version: 1, keyCheck: new SecretBox(KEY).seal('store:key-check', 'store:key-check'), issuers: {} }));
    expect(() => new JsonFileIssuerStore(emptyPath, OTHER_KEY)).toThrow(/cannot unseal/);
  });

  it('fails closed on tampered or corrupt state; a missing file is an empty store', async () => {
    const path = tempPath('issuers.json');
    const store = new JsonFileIssuerStore(path, KEY);
    await store.put(issuerRecord('UF-1'));
    await store.put(issuerRecord('UF-2'));
    await store.close();

    const file = JSON.parse(readFileSync(path, 'utf8'));
    const swapped = structuredClone(file);
    swapped.issuers['UF-1'].sealedSecret = file.issuers['UF-2'].sealedSecret;
    writeFileSync(path, JSON.stringify(swapped));
    expect(() => new JsonFileIssuerStore(path, KEY)).toThrow(/cannot unseal/);

    const repointed = structuredClone(file);
    repointed.issuers['UF-1'].issuerPublicKey = SDK.Keypair.random().publicKey();
    writeFileSync(path, JSON.stringify(repointed));
    expect(() => new JsonFileIssuerStore(path, KEY)).toThrow(/tampered/);

    writeFileSync(path, '{"version": 1, "issu');
    expect(() => new JsonFileIssuerStore(path, KEY)).toThrow(/not valid JSON/);

    await expect(track(new JsonFileIssuerStore(tempPath('none.json'), KEY)).get('UF-1')).resolves.toBeUndefined();
  });

  it('serializes concurrent writes so no update is lost', async () => {
    const path = tempPath('issuers.json');
    const store = new JsonFileIssuerStore(path, KEY);
    const records = ['UF-1', 'UF-2', 'UF-3', 'UF-4'].map(issuerRecord);
    await Promise.all(records.map((r) => store.put(r)));
    await store.close();

    const reloaded = track(new JsonFileIssuerStore(path, KEY));
    for (const r of records) await expect(reloaded.get(r.dealId)).resolves.toEqual(r);
  });
});

describe('JsonFileSettlementStore', () => {
  it('survives a reload through pending -> settled, mode 0600', async () => {
    const path = tempPath('settlements.json');
    const pending = {
      record: {
        settlementId: 's-1',
        investorId: 'inv-001',
        stellarAddress: SDK.Keypair.random().publicKey(),
        units: '10.0000000',
        txHash: 'cd'.repeat(32),
      },
      maxTime: 1_800_000_000,
    };
    const first = new JsonFileSettlementStore(path);
    await first.putPending(pending);
    await first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = new JsonFileSettlementStore(path);
    await expect(second.getPending('s-1')).resolves.toEqual(pending);

    const settled: SettlementRecord = { ...pending.record, settledAt: '2026-10-23T10:00:00.000Z' };
    await second.markSettled(settled);
    await second.close();
    const reloaded = track(new JsonFileSettlementStore(path));
    await expect(reloaded.getSettled('s-1')).resolves.toEqual(settled);
    await expect(reloaded.getPending('s-1')).resolves.toBeUndefined();
  });

  it('fails closed on a corrupt file', async () => {
    const path = tempPath('settlements.json');
    await new JsonFileSettlementStore(path).close(); // missing: empty, nothing written yet
    writeRaw(path, 'not json');
    expect(() => new JsonFileSettlementStore(path)).toThrow(/not valid JSON/);
    writeFileSync(path, JSON.stringify({ version: 99 }));
    expect(() => new JsonFileSettlementStore(path)).toThrow(/unsupported version/);
  });
});
