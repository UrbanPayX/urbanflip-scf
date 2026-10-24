import * as SDK from '@stellar/stellar-sdk';
import {
  TransactionRejectedError,
  type AccountSnapshot,
  type AssetRef,
  type LedgerReader,
  type Submittable,
  type TransactionSubmitter,
} from '../src/stellar/submitter';

/** What the next submit() does; 'apply' when the script is empty. */
export type SubmitStep =
  | 'apply'
  /** Never reaches the ledger; the response is lost (Horizon 504, no result codes). */
  | 'timeout'
  /** Applies, but the response is lost. */
  | 'apply-then-timeout'
  /** Definitive rejection with result codes; nothing applies. */
  | { reject: string; ops?: string[] };

interface FakeAccount {
  xlmBalance: string;
  trustlines: AssetRef[];
}

/**
 * Horizon plus a tiny ledger: applies createAccount/changeTrust from each
 * submitted envelope (atomically, consuming the channel sequence), so tests
 * read back real chain state instead of asserting on call counts alone.
 */
export class FakeHorizon implements TransactionSubmitter, LedgerReader {
  readonly accounts = new Map<string, FakeAccount>();
  readonly outcomes = new Map<string, boolean>();
  /** Inner transaction of every envelope that reached submit(), in order. */
  readonly received: SDK.Transaction[] = [];
  readonly script: SubmitStep[] = [];
  private channelSeq = 1000n;

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, String(this.channelSeq));
  }

  async loadAccountSnapshot(address: string): Promise<AccountSnapshot | undefined> {
    const account = this.accounts.get(address);
    return account && { xlmBalance: account.xlmBalance, trustlines: account.trustlines.map((t) => ({ ...t })) };
  }

  async transactionOutcome(hash: string): Promise<boolean | undefined> {
    return this.outcomes.get(hash);
  }

  async submit(tx: Submittable): Promise<{ hash: string }> {
    const hash = Buffer.from(tx.hash()).toString('hex');
    const inner = tx instanceof SDK.FeeBumpTransaction ? tx.innerTransaction : tx;
    this.received.push(inner);
    const step = this.script.shift() ?? 'apply';
    if (step === 'timeout') throw lostResponse();
    if (typeof step === 'object') throw rejected(step.reject, step.ops);
    // Already in history: Horizon answers a resubmission from its database.
    if (this.outcomes.get(hash) === true) return { hash };
    if (BigInt(inner.sequence) !== this.channelSeq + 1n) throw rejected('tx_bad_seq');
    this.channelSeq += 1n;

    const { next, opCodes } = this.apply(inner);
    const ok = opCodes.every((code) => code === 'op_success');
    this.outcomes.set(hash, ok);
    if (!ok) throw rejected('tx_failed', opCodes);
    for (const [address, account] of next) this.accounts.set(address, account);
    if (step === 'apply-then-timeout') throw lostResponse();
    return { hash };
  }

  /** Every changeTrust line opened so far, in submission order. */
  changeTrustLines(): AssetRef[] {
    return this.received.flatMap((tx) =>
      tx.operations
        .filter((op): op is SDK.Operation.ChangeTrust => op.type === 'changeTrust')
        .map((op) => assetOf(op)),
    );
  }

  private apply(tx: SDK.Transaction): { next: Map<string, FakeAccount>; opCodes: string[] } {
    const next = new Map<string, FakeAccount>();
    const read = (address: string) => next.get(address) ?? this.accounts.get(address);
    const opCodes = tx.operations.map((op) => {
      if (op.type === 'createAccount') {
        if (read(op.destination)) return 'op_already_exists';
        next.set(op.destination, { xlmBalance: op.startingBalance, trustlines: [] });
      } else if (op.type === 'changeTrust') {
        const source = op.source ?? tx.source;
        const account = read(source);
        if (!account) return 'op_no_source_account';
        const asset = assetOf(op);
        const exists = account.trustlines.some((t) => t.code === asset.code && t.issuer === asset.issuer);
        next.set(source, exists ? account : { ...account, trustlines: [...account.trustlines, asset] });
      }
      return 'op_success';
    });
    return { next, opCodes };
  }
}

function assetOf(op: SDK.Operation.ChangeTrust): AssetRef {
  const line = op.line as SDK.Asset;
  return { code: line.getCode(), issuer: line.getIssuer() ?? '' };
}

export function lostResponse(): TransactionRejectedError {
  return new TransactionRejectedError({ httpStatus: 504, cause: new Error('Horizon 504 Timeout') });
}

export function rejected(tx: string, ops?: string[]): TransactionRejectedError {
  return new TransactionRejectedError({
    txResultCode: tx,
    opResultCodes: ops,
    httpStatus: 400,
    cause: new Error('transaction failed'),
  });
}
