import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createIssuance } from '../src/index';
import { JsonFileClawbackStore } from '../src/store/clawback-store';
import { JsonFileIssuerStore } from '../src/store/issuer-store';
import { JsonFileSettlementStore } from '../src/store/settlement-store';
import { StateLockedError } from '../src/store/state-lock';

const KEY = Buffer.alloc(32, 3);
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];
const opened: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const store of opened.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  dirs.push(dir);
  return join(dir, 'state');
}

function track<T extends { close(): Promise<void> }>(store: T): T {
  opened.push(store);
  return store;
}

function lockOf(dir: string): { pid: number; hostname: string; startedAt: string } {
  return JSON.parse(readFileSync(join(dir, '.lock'), 'utf8'));
}

/** Another OS process holding `path` open through the real store code. */
async function holderProcess(path: string, mode: 'hold' | 'exit' = 'hold'): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(TEST_DIR, 'lock-holder.ts'), path, mode], {
    cwd: join(TEST_DIR, '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve(out.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => (out.includes('\n') ? undefined : reject(new Error(`holder exited ${code}: ${out}`))));
  });
  expect(line).toBe(`ready ${child.pid}`);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await exited(child);
  return child.pid!;
}

describe('state lock (one process per state location)', () => {
  it('stores in one directory share one lock; a second instance of a file is refused until close()', async () => {
    const dir = stateDir();
    const issuers = new JsonFileIssuerStore(join(dir, 'issuers.json'), KEY);
    const settlements = new JsonFileSettlementStore(join(dir, 'settlements.json'));
    const clawbacks = new JsonFileClawbackStore(join(dir, 'clawbacks.json'));
    expect(lockOf(dir)).toMatchObject({ pid: process.pid, hostname: hostname() });

    let refusal: unknown;
    try {
      new JsonFileSettlementStore(join(dir, 'settlements.json'));
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(StateLockedError);
    expect((refusal as Error).message).toMatch(/already open in this process.*close\(\)/);

    await issuers.close();
    await settlements.close();
    expect(existsSync(join(dir, '.lock'))).toBe(true); // still held by the clawback store
    await clawbacks.close();
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    await expect(clawbacks.markCompleted({} as never)).rejects.toThrow(/closed/);

    track(new JsonFileSettlementStore(join(dir, 'settlements.json')));
    expect(lockOf(dir).pid).toBe(process.pid);
  });

  it('close() waits for queued writes before releasing the lock', async () => {
    const dir = stateDir();
    const store = new JsonFileClawbackStore(join(dir, 'clawbacks.json'));
    const write = store.clearPending('cb-1');
    const closing = store.close();
    expect(existsSync(join(dir, '.lock'))).toBe(true);
    await Promise.all([write, closing]);
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    expect(existsSync(join(dir, 'clawbacks.json'))).toBe(true);
  });

  it('createIssuance with STATE_DIR: a second instance is refused until the first is closed', async () => {
    const dir = stateDir();
    const config = {
      horizonUrl: 'https://horizon-testnet.stellar.org', // never contacted: nothing is submitted
      networkPassphrase: SDK.Networks.TESTNET,
      homeDomain: 'urbanflip.io',
      funderSecret: SDK.Keypair.random().secret(),
      gate: { kind: 'static' as const, allow: [] },
      stateDir: dir,
      stateKey: KEY.toString('hex'),
    };
    const first = createIssuance(config);
    expect(() => createIssuance(config)).toThrow(StateLockedError);
    // the failed instance released what it had opened: the first one still owns the lock
    expect(lockOf(dir).pid).toBe(process.pid);
    await first.close();
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    track(createIssuance(config));

    // a store failing to load releases the stores opened before it, and the lock with them
    const broken = stateDir();
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'settlements.json'), 'not json');
    expect(() => createIssuance({ ...config, stateDir: broken })).toThrow(/not valid JSON/);
    expect(existsSync(join(broken, '.lock'))).toBe(false);
  });

  it('refuses a second process while the first one runs, then takes over once it is killed', async () => {
    const dir = stateDir();
    const path = join(dir, 'clawbacks.json');
    const child = await holderProcess(path);

    let refusal: unknown;
    try {
      new JsonFileClawbackStore(path);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(StateLockedError);
    expect((refusal as StateLockedError).holder).toMatchObject({ pid: child.pid, hostname: hostname() });
    expect((refusal as Error).message).toContain(`locked by pid ${child.pid} on this host`);
    // a different store in the same directory is the same state location
    expect(() => new JsonFileSettlementStore(join(dir, 'settlements.json'))).toThrow(StateLockedError);

    child.kill('SIGKILL'); // no exit handler runs: the lock file stays behind
    await exited(child);
    expect(lockOf(dir).pid).toBe(child.pid);

    track(new JsonFileClawbackStore(path));
    expect(lockOf(dir)).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(existsSync(join(dir, '.lock.takeover'))).toBe(false);
  }, 30_000);

  it('a process that exits normally releases its lock', async () => {
    const dir = stateDir();
    const child = await holderProcess(join(dir, 'clawbacks.json'), 'exit');
    expect(await exited(child)).toBe(0);
    expect(existsSync(join(dir, '.lock'))).toBe(false);
  }, 30_000);

  it('takes over a stale lock: dead pid on this host, or this pid from before this process started', async () => {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const dead = await deadPid();
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: dead, hostname: hostname(), startedAt: '2026-01-01T00:00:00.000Z' }));
    const store = new JsonFileClawbackStore(join(dir, 'clawbacks.json'));
    expect(lockOf(dir).pid).toBe(process.pid);
    await store.close();

    // pid reuse across restarts (pid 1 in a container): our pid, but locked before we started
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: '2000-01-01T00:00:00.000Z' }));
    track(new JsonFileClawbackStore(join(dir, 'clawbacks.json')));
    expect(lockOf(dir).startedAt).not.toBe('2000-01-01T00:00:00.000Z');
  }, 30_000);

  it('never takes over a lock from another host, or one it cannot read', async () => {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const dead = await deadPid();
    const foreign = { pid: dead, hostname: `not-${hostname()}`, startedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(join(dir, '.lock'), JSON.stringify(foreign));
    expect(() => new JsonFileClawbackStore(join(dir, 'clawbacks.json'))).toThrow(
      new RegExp(`locked by pid ${dead} on host 'not-${hostname()}'.*delete`),
    );
    expect(lockOf(dir)).toEqual(foreign);

    writeFileSync(join(dir, '.lock'), '');
    expect(() => new JsonFileClawbackStore(join(dir, 'clawbacks.json'))).toThrow(/unreadable/);
    writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: 0, hostname: hostname(), startedAt: 'x' }));
    expect(() => new JsonFileClawbackStore(join(dir, 'clawbacks.json'))).toThrow(/unreadable/);
    expect(existsSync(join(dir, 'clawbacks.json'))).toBe(false);
  }, 30_000);
});
