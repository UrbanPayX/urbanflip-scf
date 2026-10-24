import * as SDK from '@stellar/stellar-sdk';

export interface SubmitFailure {
  hash?: string;
  txResultCode?: string;
  opResultCodes?: string[];
  httpStatus?: number;
  cause: unknown;
}

export class TransactionRejectedError extends Error {
  constructor(readonly failure: SubmitFailure) {
    super(
      `transaction rejected` +
        (failure.txResultCode ? ` (tx: ${failure.txResultCode})` : '') +
        (failure.opResultCodes?.length ? ` (ops: ${failure.opResultCodes.join(', ')})` : ''),
      { cause: failure.cause },
    );
    this.name = 'TransactionRejectedError';
  }
}

export type Submittable = SDK.Transaction | SDK.FeeBumpTransaction;

/** What the pipeline needs from Horizon — fakes implement this in tests. */
export interface TransactionSubmitter {
  loadAccount(address: string): Promise<SDK.Account>;
  submit(tx: Submittable): Promise<{ hash: string }>;
}

/** An asset by its full identity: the same code from another issuer is another asset. */
export interface AssetRef {
  code: string;
  issuer: string;
}

/** An existing account as onboarding needs to see it. */
export interface AccountSnapshot {
  /** Native balance as Horizon reports it, e.g. "0.0000000". */
  xlmBalance: string;
  trustlines: AssetRef[];
}

/**
 * Read side of Horizon: lets onboarding skip steps already on-chain, and lets
 * the pipeline resolve an unknown submission by hash instead of resubmitting.
 */
export interface LedgerReader {
  /** Undefined when the account does not exist (Horizon 404). */
  loadAccountSnapshot(address: string): Promise<AccountSnapshot | undefined>;
  /** Undefined while `hash` is not on the ledger; otherwise whether it succeeded. */
  transactionOutcome(hash: string): Promise<boolean | undefined>;
}

export function isLedgerReader(value: unknown): value is LedgerReader {
  const reader = value as Partial<LedgerReader> | undefined;
  return (
    typeof reader?.loadAccountSnapshot === 'function' &&
    typeof reader?.transactionOutcome === 'function'
  );
}

export class TxSubmitter implements TransactionSubmitter, LedgerReader {
  constructor(private readonly server: SDK.Horizon.Server) {}

  async loadAccount(address: string): Promise<SDK.Account> {
    return (await this.server.loadAccount(address)) as unknown as SDK.Account;
  }

  async submit(tx: Submittable): Promise<{ hash: string }> {
    try {
      const res = await this.server.submitTransaction(
        tx as Parameters<SDK.Horizon.Server['submitTransaction']>[0],
      );
      return { hash: res.hash };
    } catch (err) {
      throw new TransactionRejectedError(extractFailure(err));
    }
  }

  async loadAccountSnapshot(address: string): Promise<AccountSnapshot | undefined> {
    let balances: Array<Record<string, unknown>>;
    try {
      const account = await this.server.accounts().accountId(address).call();
      balances = account.balances as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const native = balances.find((b) => b['asset_type'] === 'native');
    return {
      xlmBalance: String(native?.['balance'] ?? '0'),
      trustlines: balances.flatMap((b) => {
        const code = b['asset_code'];
        const issuer = b['asset_issuer'];
        return typeof code === 'string' && typeof issuer === 'string' ? [{ code, issuer }] : [];
      }),
    };
  }

  async transactionOutcome(hash: string): Promise<boolean | undefined> {
    try {
      const tx = await this.server.transactions().transaction(hash).call();
      return tx.successful;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof SDK.NotFoundError ||
    (err as { response?: { status?: number } })?.response?.status === 404
  );
}

export function toFailure(err: unknown): SubmitFailure {
  if (err instanceof TransactionRejectedError) return err.failure;
  return extractFailure(err);
}

export function extractFailure(err: unknown): SubmitFailure {
  const any = err as { response?: { status?: number; data?: unknown } };
  const data = any?.response?.data as
    | { hash?: string; extras?: { result_codes?: { transaction?: string; operations?: string[] } } }
    | undefined;
  const codes = data?.extras?.result_codes;
  return {
    hash: data?.hash,
    txResultCode: codes?.transaction,
    opResultCodes: Array.isArray(codes?.operations) ? codes.operations : undefined,
    httpStatus: any?.response?.status,
    cause: err,
  };
}

/** Timeout-classified failures are retried once with the same idempotency key. */
export function isTimeoutish(failure: SubmitFailure): boolean {
  if (failure.txResultCode === 'tx_timeout' || failure.txResultCode === 'tx_too_late') return true;
  if (failure.httpStatus === 504 || failure.httpStatus === 503) return true;
  const cause = failure.cause as { name?: string; code?: string };
  return cause?.name === 'AbortError' || cause?.code === 'ETIMEDOUT';
}

/**
 * No result codes (504, dropped connection, client timeout) or a timeout code:
 * the network may still apply the tx until its maxTime, so its outcome must be
 * resolved by hash, never by building a new transaction.
 */
export function isIndeterminate(failure: SubmitFailure): boolean {
  return !failure.txResultCode || isTimeoutish(failure);
}
