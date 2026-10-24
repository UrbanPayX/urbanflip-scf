import { readFileSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { claimStateFile, type StateFileClaim } from './state-lock';

/**
 * Reads a JSON state file at startup. A missing file means an empty store;
 * any other failure (unreadable, corrupt) throws — state is never silently
 * replaced by an empty one.
 */
export function readJsonState(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new Error(`cannot read state file ${path}: ${(err as Error).message}`, { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`state file ${path} is not valid JSON`, { cause: err });
  }
}

/**
 * One JSON state file, replaced atomically on every update: temp file
 * (mode 0600), fsync, rename. Updates are serialized, so an older snapshot
 * never overwrites a newer one, and in-memory state is committed only after
 * the new content is durable.
 *
 * Constructing it claims the file exclusively (see claimStateFile): a second
 * process, or a second instance in this process, is refused with
 * StateLockedError until close().
 */
export class AtomicJsonFile {
  private tail: Promise<void> = Promise.resolve();
  private writes = 0;
  private closed = false;
  private closing?: Promise<void>;
  private readonly claim: StateFileClaim;

  constructor(readonly path: string) {
    this.claim = claimStateFile(path);
  }

  /** `step` runs behind earlier updates and returns the new content plus a commit for it. */
  update(step: () => { content: unknown; commit: () => void }): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`state file ${this.path} is closed`));
    this.writes++;
    const run = this.tail.then(async () => {
      try {
        const { content, commit } = step();
        await writeAtomically(this.path, content);
        commit();
      } finally {
        this.writes--;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Refuses further updates, lets queued ones finish, then releases the lock.
   * Idle (no write queued), the lock is released before close() returns.
   */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      if (this.writes === 0) {
        this.claim.release();
        this.closing = Promise.resolve();
      } else {
        this.closing = this.tail.then(() => this.claim.release());
      }
    }
    return this.closing;
  }
}

async function writeAtomically(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    // A stale temp file from a crashed write keeps its old mode otherwise.
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(content, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}
