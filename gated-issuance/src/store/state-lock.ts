import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Who holds a state directory: the content of its `.lock` file. */
export interface LockHolder {
  pid: number;
  hostname: string;
  /** ISO timestamp at which the lock was taken. */
  startedAt: string;
}

/** The state location is in use by another process (or another store instance in this one). */
export class StateLockedError extends Error {
  constructor(
    readonly lockPath: string,
    /** The recorded holder, when the lock file could be read. */
    readonly holder: LockHolder | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'StateLockedError';
  }
}

/** One store's claim on its state file; release() is idempotent. */
export interface StateFileClaim {
  readonly lockPath: string;
  release(): void;
}

interface HeldLock {
  dir: string;
  lockPath: string;
  /** Exactly what was written, so release never deletes a lock it no longer owns. */
  content: string;
  holder: LockHolder;
  /** State files in this directory claimed by live store instances of this process. */
  files: Set<string>;
}

const held = new Map<string, HeldLock>();
let exitHookInstalled = false;

/**
 * Claims a JSON state file for one store instance, exclusively.
 *
 * The lock is per state LOCATION — the file's directory — as `<dir>/.lock`,
 * created with 'wx' and holding {pid, hostname, startedAt}:
 *   - another process holds it -> StateLockedError naming the holder;
 *   - its holder is on this host and dead (kill(pid, 0) -> ESRCH) -> stale, taken over;
 *   - several stores of this process in one directory share the one lock
 *     (reference-counted, released when the last of them closes);
 *   - a second instance of the same file in this process is refused too, so
 *     no two writers ever hold diverging snapshots of one file.
 * Every lock still held is removed on process exit; a crashed or killed
 * process leaves a lock that the next start on this host takes over.
 */
export function claimStateFile(path: string): StateFileClaim {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  const dir = realpathSync(dirname(abs));
  const name = basename(abs);

  let lock = held.get(dir);
  if (lock?.files.has(name)) {
    throw new StateLockedError(
      lock.lockPath,
      lock.holder,
      `state file ${join(dir, name)} is already open in this process (pid ${process.pid}); close() the other store instance first`,
    );
  }
  if (!lock) {
    lock = acquire(dir);
    held.set(dir, lock);
    installExitHook();
  }
  lock.files.add(name);

  const owned = lock;
  let released = false;
  return {
    lockPath: owned.lockPath,
    release() {
      if (released) return;
      released = true;
      owned.files.delete(name);
      if (owned.files.size === 0 && held.get(owned.dir) === owned) {
        held.delete(owned.dir);
        removeIfOurs(owned);
      }
    },
  };
}

function acquire(dir: string): HeldLock {
  const lockPath = join(dir, '.lock');
  const holder: LockHolder = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
  const content = JSON.stringify(holder) + '\n';
  const lock: HeldLock = { dir, lockPath, content, holder, files: new Set() };

  // A holder that releases between our 'wx' and our read is simply retried.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(lockPath, content)) return lock;
    const existing = readLock(lockPath);
    if (existing === undefined) continue;
    const current = parseHolder(existing);
    if (!current) {
      throw new StateLockedError(
        lockPath,
        undefined,
        `lock file ${lockPath} is unreadable; if no process uses ${dir}, delete it`,
      );
    }
    if (!isStale(current)) {
      const where = current.hostname === hostname() ? 'this host' : `host '${current.hostname}'`;
      const hint =
        current.hostname === hostname()
          ? 'stop that process first'
          : `its liveness cannot be checked from '${hostname()}'; if it is gone, delete ${lockPath}`;
      throw new StateLockedError(
        lockPath,
        current,
        `state directory ${dir} is locked by pid ${current.pid} on ${where} (since ${current.startedAt}); ${hint}`,
      );
    }
    takeOver(lockPath, existing, current, content);
    return lock;
  }
  throw new StateLockedError(lockPath, undefined, `state directory ${dir}: lock ${lockPath} keeps changing hands; retry`);
}

/**
 * Replaces a stale lock. A second exclusive file serializes concurrent
 * takeovers, and the stale content is re-checked under it, so two starting
 * processes can never both delete-and-recreate the lock.
 */
function takeOver(lockPath: string, staleContent: string, stale: LockHolder, content: string): void {
  const mutex = `${lockPath}.takeover`;
  if (!createExclusive(mutex, content)) {
    throw new StateLockedError(
      lockPath,
      stale,
      `stale lock ${lockPath} (pid ${stale.pid}) is being taken over by another process; retry. If this persists, delete ${mutex}`,
    );
  }
  try {
    const now = readLock(lockPath);
    if (now !== undefined && now !== staleContent) {
      const next = parseHolder(now);
      throw new StateLockedError(
        lockPath,
        next,
        `state directory ${dirname(lockPath)} was just locked by pid ${next?.pid ?? 'unknown'} on '${next?.hostname ?? 'unknown'}'`,
      );
    }
    if (now !== undefined) unlinkSync(lockPath);
    if (!createExclusive(lockPath, content)) {
      const next = parseHolder(readLock(lockPath) ?? '');
      throw new StateLockedError(
        lockPath,
        next,
        `state directory ${dirname(lockPath)} was just locked by pid ${next?.pid ?? 'unknown'} on '${next?.hostname ?? 'unknown'}'`,
      );
    }
  } finally {
    unlinkQuietly(mutex);
  }
}

/** True when the holder provably no longer runs: same host, and its pid is gone. */
function isStale(holder: LockHolder): boolean {
  if (holder.hostname !== hostname()) return false;
  if (holder.pid === process.pid) {
    // Our own pid but not in our registry: an earlier process that had this pid
    // (pid 1 in a container) if, and only if, it locked before we started.
    const startedAt = Date.parse(holder.startedAt);
    return Number.isFinite(startedAt) && startedAt < performance.timeOrigin;
  }
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    // EPERM: the process exists under another user. Only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkQuietly(path);
    throw err;
  }
  closeSync(fd);
  return true;
}

function readLock(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseHolder(raw: string): LockHolder | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockHolder>;
    // pid must be a real process id: kill(0 | -1, 0) would address process groups.
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.hostname !== 'string' || typeof value.startedAt !== 'string') return undefined;
    return { pid: value.pid as number, hostname: value.hostname, startedAt: value.startedAt };
  } catch {
    return undefined;
  }
}

function removeIfOurs(lock: HeldLock): void {
  try {
    if (readLock(lock.lockPath) === lock.content) unlinkSync(lock.lockPath);
  } catch {
    // Best effort: a lock we cannot remove is stale once we exit, and is taken over.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const lock of held.values()) removeIfOurs(lock);
    held.clear();
  });
}
