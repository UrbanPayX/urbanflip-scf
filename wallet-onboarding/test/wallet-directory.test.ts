import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonFileWalletDirectory, WalletDirectoryLockedError } from '../src/wallet/wallet-directory';

const MODULE = new URL('../src/wallet/wallet-directory.ts', import.meta.url).href;

async function freshPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'wallet-dir-')), 'wallets.json');
}

/** Runs a separate Node process that opens the directory, then ends as `ending` says. */
function childHolding(path: string, ending: 'exit' | 'process.exit' | 'SIGKILL') {
  const end = {
    exit: '',
    'process.exit': 'process.exit(3);',
    SIGKILL: "process.kill(process.pid, 'SIGKILL');",
  }[ending];
  const script = `
    const { JsonFileWalletDirectory } = await import(${JSON.stringify(MODULE)});
    const dir = new JsonFileWalletDirectory(${JSON.stringify(path)});
    await dir.put('inv-child', { walletId: 'w-child', address: 'GCHILD', chainType: 'stellar' });
    console.log(process.pid);
    ${end}`;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { pid: Number(run.stdout.trim()), status: run.status, signal: run.signal, stderr: run.stderr };
}

describe('JsonFileWalletDirectory', () => {
  it('refuses to rebind an investor and fails closed on an unreadable file', async () => {
    const path = await freshPath();
    const directory = new JsonFileWalletDirectory(path);
    await directory.put('inv-1', { walletId: 'w1', address: 'GA' });
    await directory.put('inv-1', { walletId: 'w1', address: 'GA' }); // same binding: fine
    await expect(directory.put('inv-1', { walletId: 'w2', address: 'GB' })).rejects.toThrow(/rebind/);
    await directory.close();
    const reopened = new JsonFileWalletDirectory(path);
    expect(await reopened.get('inv-1')).toEqual({ walletId: 'w1', address: 'GA' });
    await reopened.close();

    const corrupt = join(path, '..', 'corrupt.json');
    await writeFile(corrupt, '{"wallets": {"inv-1": 42}}');
    const bad = new JsonFileWalletDirectory(corrupt);
    await expect(bad.get('inv-1')).rejects.toThrow(/refusing to start empty/);
    await bad.close();

    const badChain = join(path, '..', 'bad-chain.json');
    await writeFile(badChain, JSON.stringify({ version: 1, wallets: { a: { walletId: 'w', address: 'G', chainType: 'evm' } } }));
    const unknownChain = new JsonFileWalletDirectory(badChain);
    await expect(unknownChain.get('a')).rejects.toThrow(/refusing to start empty/);
    await unknownChain.close();
  });
});

describe('JsonFileWalletDirectory lock (one process per file)', () => {
  it('a second instance is refused while the first holds the lock, naming the holder', async () => {
    const path = await freshPath();
    const first = new JsonFileWalletDirectory(path);
    const lock = JSON.parse(await readFile(`${path}.lock`, 'utf8')) as Record<string, unknown>;
    expect(lock).toEqual({ pid: process.pid, hostname: hostname(), startedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(lock.startedAt as string))).toBe(false);

    let refused: unknown;
    try {
      new JsonFileWalletDirectory(path);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(WalletDirectoryLockedError);
    expect((refused as Error).message).toContain(`pid ${process.pid} on ${hostname()}`);

    await first.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
    await expect(first.get('inv-1')).rejects.toThrow(/closed/);
    const second = new JsonFileWalletDirectory(path); // released: now allowed
    await second.close();
  });

  it('a live holder in another process is refused', async () => {
    const path = await freshPath();
    // The parent stands in for "another live process": write its pid as holder.
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.ppid, hostname: hostname(), startedAt: new Date().toISOString() }));
    expect(() => new JsonFileWalletDirectory(path)).toThrow(/still running/);
  });

  it('a stale lock (holder killed, same host) is taken over', async () => {
    const path = await freshPath();
    const child = childHolding(path, 'SIGKILL');
    expect(child.signal).toBe('SIGKILL');
    const stale = JSON.parse(await readFile(`${path}.lock`, 'utf8')) as { pid: number };
    expect(stale.pid).toBe(child.pid);

    const directory = new JsonFileWalletDirectory(path);
    const lock = JSON.parse(await readFile(`${path}.lock`, 'utf8')) as { pid: number };
    expect(lock.pid).toBe(process.pid);
    expect(await directory.get('inv-child')).toEqual({ walletId: 'w-child', address: 'GCHILD', chainType: 'stellar' });
    await directory.close();
  });

  it('a lock from another host, or an unreadable lock, is refused (liveness cannot be proven)', async () => {
    const path = await freshPath();
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 999_999_999, hostname: 'other-host', startedAt: '2026-01-01T00:00:00Z' }));
    expect(() => new JsonFileWalletDirectory(path)).toThrow(/pid 999999999 on other-host .*another host/);

    await writeFile(`${path}.lock`, 'not json');
    expect(() => new JsonFileWalletDirectory(path)).toThrow(/unreadable/);
  });

  it('the lock is released on normal exit and on process.exit()', async () => {
    for (const ending of ['exit', 'process.exit'] as const) {
      const path = await freshPath();
      const child = childHolding(path, ending);
      expect(child.stderr).toBe('');
      expect(child.status).toBe(ending === 'exit' ? 0 : 3);
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
  });
});
