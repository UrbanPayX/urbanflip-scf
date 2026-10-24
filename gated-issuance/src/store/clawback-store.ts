import { AtomicJsonFile, readJsonState } from './json-file';

/** A clawback whose transaction is known to have applied. */
export interface ClawbackRecord {
  /** Caller-supplied idempotency key. */
  clawbackId: string;
  dealId: string;
  assetCode: string;
  issuer: string;
  /** The holder clawed back from. */
  stellarAddress: string;
  /** What the caller asked for (7 decimals); absent for a full-balance clawback. */
  requestedAmount?: string;
  /** Units actually clawed back (7 decimals). */
  amount: string;
  txHash: string;
  clawedBackAt: string;
  /** Recorded by looking the tx up by hash after an unknown outcome, not from the submit response. */
  resolvedByHash?: boolean;
}

/**
 * A clawback recorded BEFORE submission, so a crash or timeout can never lead
 * to a second clawback: the next call with the same id resolves it by hash.
 */
export interface PendingClawback {
  record: Omit<ClawbackRecord, 'clawedBackAt' | 'resolvedByHash'>;
  /** Unix seconds: the tx's timebounds maxTime — it can never apply after this. */
  maxTime: number;
}

/** Port: completed and in-flight clawbacks keyed by clawbackId. Writes must be durable before they resolve. */
export interface ClawbackStore {
  getCompleted(clawbackId: string): Promise<ClawbackRecord | undefined>;
  getPending(clawbackId: string): Promise<PendingClawback | undefined>;
  putPending(pending: PendingClawback): Promise<void>;
  clearPending(clawbackId: string): Promise<void>;
  /** Records the clawback and drops its pending entry in one write. */
  markCompleted(record: ClawbackRecord): Promise<void>;
  /** Releases the store (and its state lock, for file-backed stores). */
  close?(): Promise<void>;
}

/** Process-lifetime store: idempotent within one process, gone on restart. */
export class MemoryClawbackStore implements ClawbackStore {
  private readonly completed = new Map<string, ClawbackRecord>();
  private readonly pending = new Map<string, PendingClawback>();

  getCompleted(clawbackId: string): Promise<ClawbackRecord | undefined> {
    return Promise.resolve(this.completed.get(clawbackId));
  }

  getPending(clawbackId: string): Promise<PendingClawback | undefined> {
    return Promise.resolve(this.pending.get(clawbackId));
  }

  putPending(pending: PendingClawback): Promise<void> {
    this.pending.set(pending.record.clawbackId, pending);
    return Promise.resolve();
  }

  clearPending(clawbackId: string): Promise<void> {
    this.pending.delete(clawbackId);
    return Promise.resolve();
  }

  markCompleted(record: ClawbackRecord): Promise<void> {
    this.completed.set(record.clawbackId, record);
    this.pending.delete(record.clawbackId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const FILE_VERSION = 1;

interface ClawbackFile {
  version: number;
  completed: Record<string, ClawbackRecord>;
  pending: Record<string, PendingClawback>;
}

interface ClawbackState {
  completed: Map<string, ClawbackRecord>;
  pending: Map<string, PendingClawback>;
}

/**
 * JSON-file clawback store (atomic replace, mode 0600 — it names holders).
 * Loading fails closed: an unreadable or corrupt file throws in the
 * constructor, because starting empty would forget a clawback in flight.
 * The file's directory is locked for this instance until close().
 */
export class JsonFileClawbackStore implements ClawbackStore {
  private state: ClawbackState;
  private readonly file: AtomicJsonFile;

  constructor(path: string) {
    this.file = new AtomicJsonFile(path);
    try {
      const raw = readJsonState(path) as Partial<ClawbackFile> | undefined;
      if (raw !== undefined && raw?.version !== FILE_VERSION) {
        throw new Error(`clawback store ${path}: unsupported version ${raw?.version}`);
      }
      this.state = {
        completed: new Map(Object.entries(raw?.completed ?? {})),
        pending: new Map(Object.entries(raw?.pending ?? {})),
      };
    } catch (err) {
      void this.file.close();
      throw err;
    }
  }

  getCompleted(clawbackId: string): Promise<ClawbackRecord | undefined> {
    return Promise.resolve(this.state.completed.get(clawbackId));
  }

  getPending(clawbackId: string): Promise<PendingClawback | undefined> {
    return Promise.resolve(this.state.pending.get(clawbackId));
  }

  putPending(pending: PendingClawback): Promise<void> {
    return this.update((next) => next.pending.set(pending.record.clawbackId, pending));
  }

  clearPending(clawbackId: string): Promise<void> {
    return this.update((next) => next.pending.delete(clawbackId));
  }

  markCompleted(record: ClawbackRecord): Promise<void> {
    return this.update((next) => {
      next.completed.set(record.clawbackId, record);
      next.pending.delete(record.clawbackId);
    });
  }

  /** Waits for queued writes, then releases the state lock. */
  close(): Promise<void> {
    return this.file.close();
  }

  private update(mutate: (next: ClawbackState) => void): Promise<void> {
    return this.file.update(() => {
      const next: ClawbackState = { completed: new Map(this.state.completed), pending: new Map(this.state.pending) };
      mutate(next);
      const content: ClawbackFile = {
        version: FILE_VERSION,
        completed: Object.fromEntries(next.completed),
        pending: Object.fromEntries(next.pending),
      };
      return { content, commit: () => (this.state = next) };
    });
  }
}
