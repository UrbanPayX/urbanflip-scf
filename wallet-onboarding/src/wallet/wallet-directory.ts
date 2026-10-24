import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * Chains whose wallets this package can sign Stellar transactions with: both
 * are Ed25519. Absent on records written before chain types were stored —
 * those wallets were all created as `solana`.
 */
export type WalletChainType = 'stellar' | 'solana';

/** One investor's embedded wallet: the provider's wallet id and its Stellar address. */
export interface WalletRecord {
  walletId: string;
  address: string;
  /** How the provider signs for this wallet; absent means 'solana' (legacy records). */
  chainType?: WalletChainType;
}

/**
 * Port: the durable investorId -> wallet binding. Losing it orphans the
 * investor's wallet and every position it holds, so production adapters must
 * survive restarts. An investor is bound once; a different binding is refused.
 *
 * Adapters:
 *   - MemoryWalletDirectory   (tests; lost on restart)
 *   - JsonFileWalletDirectory (single-process deployments, demos; file-locked)
 */
export interface WalletDirectory {
  get(investorId: string): Promise<WalletRecord | undefined> | WalletRecord | undefined;
  put(investorId: string, record: WalletRecord): Promise<void> | void;
  close?(): Promise<void> | void;
}

export class MemoryWalletDirectory implements WalletDirectory {
  private readonly records = new Map<string, WalletRecord>();

  get(investorId: string): WalletRecord | undefined {
    return this.records.get(investorId);
  }

  put(investorId: string, record: WalletRecord): void {
    refuseRebind(investorId, this.records.get(investorId), record);
    this.records.set(investorId, { ...record });
  }
}

const FILE_VERSION = 1;
const CHAIN_TYPES: ReadonlySet<unknown> = new Set<WalletChainType>(['stellar', 'solana']);

/**
 * Whole map in one JSON file, rewritten atomically on every put (temp file,
 * fsync, rename): a crash leaves the old file or the new one, never a torn
 * one. An unreadable file fails closed instead of reading as empty, since
 * "empty" would hand every investor a new wallet.
 *
 * One process per file, enforced: the constructor takes `<file>.lock`
 * exclusively (see FileLock) and throws if another live instance holds it.
 * close() releases it; so does a normal process exit. A holder killed
 * without exiting leaves a stale lock, taken over on the next start.
 */
export class JsonFileWalletDirectory implements WalletDirectory {
  private loaded?: Promise<Map<string, WalletRecord>>;
  private writes: Promise<void> = Promise.resolve();
  private readonly lock: FileLock;
  private closed = false;

  constructor(private readonly path: string) {
    this.lock = FileLock.acquire(`${path}.lock`);
  }

  async get(investorId: string): Promise<WalletRecord | undefined> {
    this.assertOpen();
    return (await this.load()).get(investorId);
  }

  put(investorId: string, record: WalletRecord): Promise<void> {
    this.assertOpen();
    // Serialized so a newer map is never overwritten by an older one.
    const write = this.writes.then(async () => {
      const current = await this.load();
      refuseRebind(investorId, current.get(investorId), record);
      const next = new Map(current).set(investorId, { ...record });
      await this.save(next);
      this.loaded = Promise.resolve(next); // memory reflects disk only after the rename
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** Waits for queued writes, then releases the lock. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    this.lock.release();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`wallet directory ${this.path} is closed`);
  }

  private load(): Promise<Map<string, WalletRecord>> {
    this.loaded ??= this.read().catch((err: unknown) => {
      this.loaded = undefined;
      throw err;
    });
    return this.loaded;
  }

  private async read(): Promise<Map<string, WalletRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; wallets?: Record<string, Partial<WalletRecord>> };
    const entries = Object.entries(parsed.wallets ?? {});
    const valid = entries.every(
      ([, r]) =>
        typeof r?.walletId === 'string' &&
        typeof r?.address === 'string' &&
        (r.chainType === undefined || CHAIN_TYPES.has(r.chainType)),
    );
    if (parsed.version !== FILE_VERSION || !valid) {
      throw new Error(`wallet directory ${this.path} is not a version ${FILE_VERSION} directory; refusing to start empty`);
    }
    return new Map(entries as Array<[string, WalletRecord]>);
  }

  private async save(records: Map<string, WalletRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const body = JSON.stringify({ version: FILE_VERSION, wallets: Object.fromEntries(records) }, null, 2);
    try {
      const file = await open(tmp, 'w', 0o600);
      try {
        await file.writeFile(body, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

/** Contents of a lock file. */
export interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Another live process (or another instance in this one) holds the lock. */
export class WalletDirectoryLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: LockHolder | undefined,
    reason: string,
  ) {
    const who = holder
      ? `pid ${holder.pid} on ${holder.hostname} (since ${holder.startedAt})`
      : 'an unidentifiable holder';
    super(`wallet directory lock ${lockPath} is held by ${who}: ${reason}`);
    this.name = 'WalletDirectoryLockedError';
  }
}

const heldLocks = new Set<FileLock>();
let exitHookInstalled = false;

/**
 * Exclusive lock file created with O_EXCL ('wx') and holding {pid, hostname,
 * startedAt}. An existing lock is taken over only when it is provably stale:
 * recorded on this host and its pid is gone (process.kill(pid, 0) -> ESRCH).
 * A lock from another host, an unreadable lock, or a live pid is refused —
 * when in doubt, a second writer is worse than a refused start.
 */
class FileLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly content: string,
  ) {}

  static acquire(path: string): FileLock {
    mkdirSync(dirname(path), { recursive: true });
    // Two passes: a stale lock is cleared once, then creation is retried; a
    // racer that wins the retry is a live holder and is refused below.
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      } satisfies LockHolder);
      if (tryCreate(path, content)) {
        const lock = new FileLock(path, content);
        lock.register();
        return lock;
      }
      const seen = readLock(path);
      if (seen === undefined) continue; // vanished between create and read: retry
      const holder = parseHolder(seen);
      if (!holder) {
        throw new WalletDirectoryLockedError(path, undefined, 'lock file is unreadable; remove it only after confirming no other process uses the directory');
      }
      const reason = staleReason(holder);
      if (reason) throw new WalletDirectoryLockedError(path, holder, reason);
      clearStale(path, seen, holder);
    }
    throw new WalletDirectoryLockedError(path, parseHolder(readLock(path) ?? ''), 'lost a race taking over a stale lock');
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    heldLocks.delete(this);
    // Only our own lock is removed: never one a later holder took over.
    if (readLock(this.path) === this.content) {
      try {
        unlinkSync(this.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  private register(): void {
    heldLocks.add(this);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once('exit', () => {
        for (const lock of [...heldLocks]) {
          try {
            lock.release();
          } catch {
            // best effort on exit; a leftover lock is detected as stale next start
          }
        }
      });
    }
  }
}

function tryCreate(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseHolder(raw: string): LockHolder | undefined {
  try {
    const h = JSON.parse(raw) as Partial<LockHolder>;
    return Number.isInteger(h.pid) && typeof h.hostname === 'string' && typeof h.startedAt === 'string'
      ? (h as LockHolder)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Undefined when the holder is provably gone; otherwise why it must be respected. */
function staleReason(holder: LockHolder): string | undefined {
  if (holder.hostname !== hostname()) return 'held from another host; its liveness cannot be checked from here';
  if (holder.pid === process.pid) return 'already open in this process; close() it first';
  try {
    process.kill(holder.pid, 0);
    return 'that process is still running';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    return 'that process is still running'; // EPERM: alive, owned by another user
  }
}

/**
 * Moves the stale lock aside atomically, then confirms what was moved is the
 * lock judged stale. If a racer replaced it in between, its live lock is put
 * back (link fails rather than overwrite) and the takeover is abandoned.
 */
function clearStale(path: string, judged: string, holder: LockHolder): void {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already cleared by a racer
    throw err;
  }
  const moved = readLock(aside);
  if (moved !== judged) {
    try {
      linkSync(aside, path);
    } catch {
      // someone else already holds the path; theirs stands
    }
    unlinkSync(aside);
    throw new WalletDirectoryLockedError(path, parseHolder(moved ?? '') ?? holder, 'lock changed hands during stale takeover');
  }
  unlinkSync(aside);
}

function refuseRebind(investorId: string, existing: WalletRecord | undefined, next: WalletRecord): void {
  if (existing && (existing.walletId !== next.walletId || existing.address !== next.address)) {
    throw new Error(
      `investor '${investorId}' is already bound to wallet ${existing.walletId}; refusing to rebind`,
    );
  }
}
