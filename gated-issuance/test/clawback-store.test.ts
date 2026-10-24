import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonFileClawbackStore,
  MemoryClawbackStore,
  type ClawbackRecord,
  type ClawbackStore,
  type PendingClawback,
} from '../src/store/clawback-store';
import { StateLockedError } from '../src/store/state-lock';

/**
 * The clawback journal: what makes "clawed back once per clawbackId" survive
 * timeouts and restarts. Both implementations honour the same port contract.
 */
const dirs: string[] = [];
const opened: ClawbackStore[] = [];

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close?.();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawback-store-'));
  dirs.push(dir);
  return join(dir, 'state', 'clawbacks.json');
}

function pending(clawbackId: string, amount = '40.0000000'): PendingClawback {
  return {
    record: {
      clawbackId,
      dealId: 'UF-MADRID-1',
      assetCode: 'UFMADRID1',
      issuer: SDK.Keypair.random().publicKey(),
      stellarAddress: SDK.Keypair.random().publicKey(),
      requestedAmount: amount,
      amount,
      txHash: 'ab'.repeat(32),
    },
    maxTime: 1_800_000_000,
  };
}

function completed(p: PendingClawback): ClawbackRecord {
  return { ...p.record, clawedBackAt: '2026-10-23T10:00:00.000Z' };
}

const implementations: Array<[string, () => ClawbackStore]> = [
  ['MemoryClawbackStore', () => new MemoryClawbackStore()],
  ['JsonFileClawbackStore', () => new JsonFileClawbackStore(tempPath())],
];

describe.each(implementations)('%s (ClawbackStore contract)', (_name, make) => {
  it('pending -> completed: marking completed drops the pending entry in the same step', async () => {
    const store = make();
    opened.push(store);
    const p = pending('cb-1');
    await store.putPending(p);
    await expect(store.getPending('cb-1')).resolves.toEqual(p);
    await expect(store.getCompleted('cb-1')).resolves.toBeUndefined();

    await store.markCompleted(completed(p));
    await expect(store.getPending('cb-1')).resolves.toBeUndefined();
    await expect(store.getCompleted('cb-1')).resolves.toEqual(completed(p));
  });

  it('clearing a pending entry (definitive rejection) leaves other ids untouched', async () => {
    const store = make();
    opened.push(store);
    const [a, b] = [pending('cb-a'), pending('cb-b', '1.0000000')];
    await store.putPending(a);
    await store.putPending(b);
    await store.clearPending('cb-a');
    await expect(store.getPending('cb-a')).resolves.toBeUndefined();
    await expect(store.getPending('cb-b')).resolves.toEqual(b);
    // clearing an unknown id is a no-op, not an error
    await expect(store.clearPending('cb-none')).resolves.toBeUndefined();
  });

  it('a rebuilt clawback replaces the pending entry for its id (new hash, new maxTime)', async () => {
    const store = make();
    opened.push(store);
    await store.putPending(pending('cb-1'));
    const rebuilt = { ...pending('cb-1'), maxTime: 1_900_000_000 };
    rebuilt.record.txHash = 'cd'.repeat(32);
    await store.putPending(rebuilt);
    await expect(store.getPending('cb-1')).resolves.toEqual(rebuilt);
  });

  it('close() resolves', async () => {
    const store = make();
    await expect(store.close?.()).resolves.toBeUndefined();
  });
});

describe('JsonFileClawbackStore durability', () => {
  it('a pending clawback survives a restart (the next call resolves it by hash), file mode 0600', async () => {
    const path = tempPath();
    const p = pending('cb-1');
    const first = new JsonFileClawbackStore(path);
    await first.putPending(p);
    await first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, pending: { 'cb-1': p } });

    const second = new JsonFileClawbackStore(path);
    opened.push(second);
    await expect(second.getPending('cb-1')).resolves.toEqual(p);
    await second.markCompleted(completed(p));
    await second.close();

    const third = new JsonFileClawbackStore(path);
    opened.push(third);
    await expect(third.getCompleted('cb-1')).resolves.toEqual(completed(p));
    await expect(third.getPending('cb-1')).resolves.toBeUndefined();
  });

  it('refuses a second writer on the same journal until the first is closed', async () => {
    const path = tempPath();
    const first = new JsonFileClawbackStore(path);
    expect(() => new JsonFileClawbackStore(path)).toThrow(StateLockedError);
    await first.close();
    opened.push(new JsonFileClawbackStore(path));
  });

  it('fails closed on a corrupt or unknown-version journal, and does not keep the lock', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, '{"version": 1, "pend');
    expect(() => new JsonFileClawbackStore(path)).toThrow(/not valid JSON/);
    writeFileSync(path, JSON.stringify({ version: 2, completed: {}, pending: {} }));
    expect(() => new JsonFileClawbackStore(path)).toThrow(/unsupported version 2/);
    writeFileSync(path, JSON.stringify({ completed: {}, pending: {} }));
    expect(() => new JsonFileClawbackStore(path)).toThrow(/unsupported version undefined/);

    // the failed opens released the state lock: a repaired journal opens normally
    writeFileSync(path, JSON.stringify({ version: 1, completed: {}, pending: {} }));
    const repaired = new JsonFileClawbackStore(path);
    opened.push(repaired);
    return expect(repaired.getPending('cb-1')).resolves.toBeUndefined();
  });

  it('a missing journal is an empty store; nothing is written until the first update', async () => {
    const path = tempPath();
    const store = new JsonFileClawbackStore(path);
    await expect(store.getCompleted('cb-1')).resolves.toBeUndefined();
    await store.close();
    expect(() => readFileSync(path)).toThrow(/ENOENT/);
  });

  it('refuses writes after close()', async () => {
    const store = new JsonFileClawbackStore(tempPath());
    await store.close();
    await expect(store.putPending(pending('cb-1'))).rejects.toThrow(/closed/);
  });
});
