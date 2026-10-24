import type { SettlementRecord } from '../issuance/subscription-settlement';
import { AtomicJsonFile, readJsonState } from './json-file';

/**
 * An issuance recorded BEFORE submission, so a crash or timeout can never
 * lead to a second mint: the next settle() resolves it by hash.
 */
export interface PendingSettlement {
  /** The settlement as it will be recorded once its tx is known to have applied. */
  record: Omit<SettlementRecord, 'settledAt'>;
  /** Unix seconds: the tx's timebounds maxTime — it can never apply after this. */
  maxTime: number;
}

/**
 * Port: settled and in-flight issuances keyed by settlementId. Writes must be
 * durable before they resolve.
 */
export interface SettlementStore {
  getSettled(settlementId: string): Promise<SettlementRecord | undefined>;
  getPending(settlementId: string): Promise<PendingSettlement | undefined>;
  putPending(pending: PendingSettlement): Promise<void>;
  clearPending(settlementId: string): Promise<void>;
  /** Records the settlement and drops its pending entry in one write. */
  markSettled(record: SettlementRecord): Promise<void>;
  /** Releases the store (and its state lock, for file-backed stores). */
  close?(): Promise<void>;
}

/** Process-lifetime store. `settled` may be a caller-owned map (the legacy `settlements` dep). */
export class MemorySettlementStore implements SettlementStore {
  private readonly pending = new Map<string, PendingSettlement>();

  constructor(private readonly settled: Map<string, SettlementRecord> = new Map()) {}

  getSettled(settlementId: string): Promise<SettlementRecord | undefined> {
    return Promise.resolve(this.settled.get(settlementId));
  }

  getPending(settlementId: string): Promise<PendingSettlement | undefined> {
    return Promise.resolve(this.pending.get(settlementId));
  }

  putPending(pending: PendingSettlement): Promise<void> {
    this.pending.set(pending.record.settlementId, pending);
    return Promise.resolve();
  }

  clearPending(settlementId: string): Promise<void> {
    this.pending.delete(settlementId);
    return Promise.resolve();
  }

  markSettled(record: SettlementRecord): Promise<void> {
    this.settled.set(record.settlementId, record);
    this.pending.delete(record.settlementId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const FILE_VERSION = 1;

interface SettlementFile {
  version: number;
  settled: Record<string, SettlementRecord>;
  pending: Record<string, PendingSettlement>;
}

interface SettlementState {
  settled: Map<string, SettlementRecord>;
  pending: Map<string, PendingSettlement>;
}

/**
 * JSON-file settlement store (atomic replace, mode 0600 — it names investors).
 * Loading fails closed: an unreadable or corrupt file throws in the
 * constructor, because starting empty would forget what was already minted.
 * The file's directory is locked for this instance until close().
 */
export class JsonFileSettlementStore implements SettlementStore {
  private state: SettlementState;
  private readonly file: AtomicJsonFile;

  constructor(path: string) {
    this.file = new AtomicJsonFile(path);
    try {
      const raw = readJsonState(path) as Partial<SettlementFile> | undefined;
      if (raw !== undefined && raw?.version !== FILE_VERSION) {
        throw new Error(`settlement store ${path}: unsupported version ${raw?.version}`);
      }
      this.state = {
        settled: new Map(Object.entries(raw?.settled ?? {})),
        pending: new Map(Object.entries(raw?.pending ?? {})),
      };
    } catch (err) {
      void this.file.close();
      throw err;
    }
  }

  /** Waits for queued writes, then releases the state lock. */
  close(): Promise<void> {
    return this.file.close();
  }

  getSettled(settlementId: string): Promise<SettlementRecord | undefined> {
    return Promise.resolve(this.state.settled.get(settlementId));
  }

  getPending(settlementId: string): Promise<PendingSettlement | undefined> {
    return Promise.resolve(this.state.pending.get(settlementId));
  }

  putPending(pending: PendingSettlement): Promise<void> {
    return this.update((next) => next.pending.set(pending.record.settlementId, pending));
  }

  clearPending(settlementId: string): Promise<void> {
    return this.update((next) => next.pending.delete(settlementId));
  }

  markSettled(record: SettlementRecord): Promise<void> {
    return this.update((next) => {
      next.settled.set(record.settlementId, record);
      next.pending.delete(record.settlementId);
    });
  }

  private update(mutate: (next: SettlementState) => void): Promise<void> {
    return this.file.update(() => {
      const next: SettlementState = { settled: new Map(this.state.settled), pending: new Map(this.state.pending) };
      mutate(next);
      const content: SettlementFile = {
        version: FILE_VERSION,
        settled: Object.fromEntries(next.settled),
        pending: Object.fromEntries(next.pending),
      };
      return { content, commit: () => (this.state = next) };
    });
  }
}
