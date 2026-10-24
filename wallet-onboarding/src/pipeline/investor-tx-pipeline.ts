import * as SDK from '@stellar/stellar-sdk';
import type { SubmitRecord } from '../types';
import { SignatureRejectedError } from '../wallet/provider';
import {
  isIndeterminate,
  isLedgerReader,
  toFailure,
  type LedgerReader,
  type TransactionSubmitter,
} from '../stellar/submitter';

/** Remembers every idempotency key and its latest outcome (see SubmitStatus). */
export interface IdempotencyLedger {
  get(key: string): Promise<SubmitRecord | undefined> | SubmitRecord | undefined;
  put(key: string, record: SubmitRecord): Promise<void> | void;
}

export class MemoryIdempotencyLedger implements IdempotencyLedger {
  private readonly records = new Map<string, SubmitRecord>();

  get(key: string): SubmitRecord | undefined {
    return this.records.get(key);
  }

  put(key: string, record: SubmitRecord): void {
    this.records.set(key, record);
  }
}

/**
 * Seconds past a tx's maxTime before "not on the ledger" is treated as "never
 * will be" (absorbs clock skew against ledger close times).
 */
const MAX_TIME_GRACE_SECONDS = 30;

/** An earlier submission under this key may still apply; nothing was rebuilt or resubmitted. */
export class SubmissionPendingError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly txHash: string,
    /** Unix seconds after which a retry can settle the outcome. */
    readonly retryAfter: number,
  ) {
    super(
      `transaction ${txHash} for '${idempotencyKey}' may still apply; retry after unix time ${retryAfter}`,
    );
    this.name = 'SubmissionPendingError';
  }
}

export interface InvestorTxPipelineDeps {
  submitter: TransactionSubmitter;
  /** Resolves unknown outcomes by hash; defaults to `submitter` when it implements LedgerReader (TxSubmitter does). */
  ledger?: LedgerReader;
  networkPassphrase: string;
  /** Channel account: transaction source, sponsor, and fee-bump fee source. Investors never pay fees. */
  channelKeypair: SDK.Keypair;
  /** Base fee (stroops) for the fee-bump wrapper. */
  baseFee?: string;
  idempotency: IdempotencyLedger;
}

export interface SubmitInvestorTxArgs {
  /** Stable per logical operation (e.g. `trustline:inv-001:UF42:G...`); duplicates are absorbed. */
  idempotencyKey: string;
  investorAddress: string;
  /** Builds the unsigned inner transaction with the channel account as source; needs a bounded timeout. */
  build: (channelAccount: SDK.Account) => SDK.Transaction;
  /** Acquires the wallet's raw signature over the inner tx hash (base64). */
  walletSign: (hash: Uint8Array) => Promise<string>;
}

/**
 * The ONLY submission path for investor-initiated transactions.
 *
 * Guarantees, in order:
 *   1. a key whose transaction applied is never rebuilt or resubmitted; a
 *      definitive rejection (result codes) is rebuilt on the next call; an
 *      unknown outcome is resolved by hash first (SubmissionPendingError while
 *      it may still apply); concurrent calls with one key share one submission;
 *   2. wallet signatures are verified against the investor's address BEFORE
 *      anything is submitted (bad signature -> SignatureRejectedError, nothing sent);
 *   3. every submission is wrapped in a fee-bump paid by the channel account —
 *      there is no code path that submits a bare investor transaction;
 *   4. the tx hash and maxTime are recorded before the first submission, and an
 *      indeterminate failure is retried exactly once with the identical envelope.
 */
export class InvestorTxPipeline {
  readonly ledger: LedgerReader;
  private readonly inflight = new Map<string, Promise<SubmitRecord>>();

  constructor(private readonly deps: InvestorTxPipelineDeps) {
    const ledger = deps.ledger ?? (isLedgerReader(deps.submitter) ? deps.submitter : undefined);
    if (!ledger) {
      throw new Error('InvestorTxPipeline needs a LedgerReader to resolve unknown outcomes by hash');
    }
    this.ledger = ledger;
  }

  submitInvestorTransaction(args: SubmitInvestorTxArgs): Promise<SubmitRecord> {
    const running = this.inflight.get(args.idempotencyKey);
    if (running) return running;
    const run = this.submitOnce(args).finally(() => this.inflight.delete(args.idempotencyKey));
    this.inflight.set(args.idempotencyKey, run);
    return run;
  }

  private async submitOnce(args: SubmitInvestorTxArgs): Promise<SubmitRecord> {
    const key = args.idempotencyKey;
    const existing = await this.deps.idempotency.get(key);
    if (existing) {
      const settled = await this.settle(existing);
      if (settled) return settled;
    }

    const channelAccount = await this.deps.submitter.loadAccount(this.deps.channelKeypair.publicKey());
    const inner = args.build(channelAccount);
    const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
    if (!maxTime) {
      throw new Error(`'${key}': investor transactions need a bounded timeout so an unknown outcome can be settled`);
    }
    inner.sign(this.deps.channelKeypair);

    const hash = inner.hash();
    const signature = await args.walletSign(new Uint8Array(hash));
    const verified = SDK.Keypair.fromPublicKey(args.investorAddress).verify(
      hash,
      Uint8Array.from(Buffer.from(signature, 'base64')),
    );
    if (!verified) throw new SignatureRejectedError(args.investorAddress);
    inner.addSignature(args.investorAddress, signature);

    // Built once: a retry resubmits the identical envelope, so one hash covers every attempt.
    const feeBump = SDK.TransactionBuilder.buildFeeBumpTransaction(
      this.deps.channelKeypair,
      this.deps.baseFee ?? '200',
      inner,
      this.deps.networkPassphrase,
    );
    feeBump.sign(this.deps.channelKeypair);
    const txHash = Buffer.from(feeBump.hash()).toString('hex');
    // Recorded BEFORE submission: a crash or a lost response is settled by hash, never resubmitted blind.
    await this.deps.idempotency.put(key, { status: 'unknown', idempotencyKey: key, txHash, maxTime, attempts: 0 });

    let record: SubmitRecord | undefined;
    let lostResponse = false;
    for (let attempt = 1; !record; attempt++) {
      try {
        const res = await this.deps.submitter.submit(feeBump);
        record = { status: 'submitted', idempotencyKey: key, txHash: res.hash, maxTime, attempts: attempt };
      } catch (err) {
        const failure = toFailure(err);
        if (isIndeterminate(failure) && attempt === 1) {
          lostResponse = true;
          continue;
        }
        record = {
          // After a lost response, a rejected resubmission (e.g. tx_bad_seq because
          // the first copy applied) proves nothing about the first copy.
          status: lostResponse || isIndeterminate(failure) ? 'unknown' : 'failed',
          idempotencyKey: key,
          txHash,
          maxTime,
          txResultCode: failure.txResultCode,
          opResultCodes: failure.opResultCodes,
          attempts: attempt,
        };
      }
    }
    await this.deps.idempotency.put(key, record);
    return record;
  }

  /** The recorded outcome to return, or undefined when the key may be rebuilt. */
  private async settle(existing: SubmitRecord): Promise<SubmitRecord | undefined> {
    if (existing.status === 'submitted') return existing;
    if (existing.status === 'failed') return undefined;

    const { idempotencyKey, txHash, maxTime } = existing;
    if (!txHash || !maxTime) {
      throw new Error(`'${idempotencyKey}' has an unknown outcome without tx hash/maxTime; settle it manually`);
    }
    const outcome = await this.ledger.transactionOutcome(txHash);
    if (outcome === true) {
      const record: SubmitRecord = { status: 'submitted', idempotencyKey, txHash, maxTime, attempts: existing.attempts };
      await this.deps.idempotency.put(idempotencyKey, record);
      return record;
    }
    const retryAfter = maxTime + MAX_TIME_GRACE_SECONDS;
    if (outcome === undefined && Date.now() / 1000 <= retryAfter) {
      throw new SubmissionPendingError(idempotencyKey, txHash, retryAfter);
    }
    return undefined; // failed on-chain, or expired off-ledger: it can never apply
  }
}
