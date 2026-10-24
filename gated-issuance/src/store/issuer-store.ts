import * as SDK from '@stellar/stellar-sdk';
import { AtomicJsonFile, readJsonState } from './json-file';
import { SecretBox } from './secret-box';

/** PENDING: keypair recorded, the creation tx may or may not have landed. ACTIVE: on-chain. */
export type IssuerStatus = 'PENDING' | 'ACTIVE';

export interface IssuerRecord {
  dealId: string;
  status: IssuerStatus;
  assetCode: string;
  issuerPublicKey: string;
  /** Secret seed of the issuer. Sealed at rest by JsonFileIssuerStore. */
  issuerSecret: string;
  /** Creation tx: the attempt last submitted while PENDING, the one that landed once ACTIVE. */
  provisioningTxHash: string;
}

/**
 * Port: issuer records keyed by dealId. put() must not resolve before the
 * record is durable — provisioning relies on it to persist the issuer key
 * BEFORE the account can exist on-chain, so a lost response can never strand
 * a funded issuer whose secret nobody holds.
 */
export interface IssuerStore {
  get(dealId: string): Promise<IssuerRecord | undefined>;
  put(record: IssuerRecord): Promise<void>;
  /** Releases the store (and its state lock, for file-backed stores). */
  close?(): Promise<void>;
}

/** Process-lifetime store: idempotent within one process, gone on restart. */
export class MemoryIssuerStore implements IssuerStore {
  private readonly records = new Map<string, IssuerRecord>();

  get(dealId: string): Promise<IssuerRecord | undefined> {
    const record = this.records.get(dealId);
    return Promise.resolve(record && { ...record });
  }

  put(record: IssuerRecord): Promise<void> {
    this.records.set(record.dealId, { ...record });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const FILE_VERSION = 1;
const KEY_CHECK_ID = 'store:key-check';

type StoredIssuer = Omit<IssuerRecord, 'issuerSecret'> & { sealedSecret: string };

interface IssuerFile {
  version: number;
  /** Proves the key on load even before any issuer is stored. */
  keyCheck: string;
  issuers: Record<string, StoredIssuer>;
}

/**
 * JSON-file issuer store. Secrets are sealed with AES-256-GCM under a 32-byte
 * key and bound to "issuer:<dealId>"; plaintext secrets never touch disk.
 * Loading fails closed: a wrong key, a tampered record or a corrupt file
 * throws in the constructor instead of starting empty. The file's directory is
 * locked for this instance until close() (see claimStateFile).
 */
export class JsonFileIssuerStore implements IssuerStore {
  private records: Map<string, IssuerRecord>;
  private readonly file: AtomicJsonFile;
  private readonly secrets: SecretBox;

  constructor(path: string, key: SecretBox | Uint8Array) {
    this.secrets = key instanceof SecretBox ? key : new SecretBox(key);
    this.file = new AtomicJsonFile(path);
    try {
      this.records = this.load(path);
    } catch (err) {
      void this.file.close();
      throw err;
    }
  }

  get(dealId: string): Promise<IssuerRecord | undefined> {
    const record = this.records.get(dealId);
    return Promise.resolve(record && { ...record });
  }

  put(record: IssuerRecord): Promise<void> {
    return this.file.update(() => {
      const next = new Map(this.records).set(record.dealId, { ...record });
      return { content: this.serialize(next), commit: () => (this.records = next) };
    });
  }

  /** Waits for queued writes, then releases the state lock. */
  close(): Promise<void> {
    return this.file.close();
  }

  private load(path: string): Map<string, IssuerRecord> {
    const records = new Map<string, IssuerRecord>();
    const raw = readJsonState(path) as Partial<IssuerFile> | undefined;
    if (raw === undefined) return records;
    if (raw?.version !== FILE_VERSION) throw new Error(`issuer store ${path}: unsupported version ${raw?.version}`);
    this.secrets.open(raw.keyCheck as string, KEY_CHECK_ID);
    for (const [dealId, stored] of Object.entries(raw.issuers ?? {})) {
      const { sealedSecret, ...rest } = stored;
      const issuerSecret = this.secrets.open(sealedSecret, issuerRecordId(dealId));
      if (rest.dealId !== dealId || SDK.Keypair.fromSecret(issuerSecret).publicKey() !== rest.issuerPublicKey) {
        throw new Error(`issuer store ${path}: record '${dealId}' does not match its sealed key (tampered state)`);
      }
      records.set(dealId, { ...rest, issuerSecret });
    }
    return records;
  }

  private serialize(records: Map<string, IssuerRecord>): IssuerFile {
    const issuers = Object.fromEntries(
      [...records.values()].map(({ issuerSecret, ...rest }): [string, StoredIssuer] => [
        rest.dealId,
        { ...rest, sealedSecret: this.secrets.seal(issuerSecret, issuerRecordId(rest.dealId)) },
      ]),
    );
    return { version: FILE_VERSION, keyCheck: this.secrets.seal(KEY_CHECK_ID, KEY_CHECK_ID), issuers };
  }
}

function issuerRecordId(dealId: string): string {
  return `issuer:${dealId}`;
}
