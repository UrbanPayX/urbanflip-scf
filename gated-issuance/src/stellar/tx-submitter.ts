import * as SDK from '@stellar/stellar-sdk';
import type { IssuerFlags } from '../types';

export interface SubmitFailure {
  hash?: string;
  /** Transaction-level result code, e.g. "tx_failed". */
  txResultCode?: string;
  /** Operation-level result codes, e.g. ["op_not_authorized"]. */
  opResultCodes?: string[];
  /** The original error for logging. */
  cause: unknown;
}

/** The network refused the tx (result codes present): it did NOT apply and never will. */
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

/**
 * Submission timed out or the connection dropped (Horizon 504, network error,
 * any response without result codes): the tx MAY still apply until its
 * maxTime. Resolve it by hash before acting again — never by resubmitting a
 * rebuilt transaction.
 */
export class TransactionOutcomeUnknownError extends Error {
  constructor(
    readonly hash: string,
    cause: unknown,
  ) {
    super(
      `transaction ${hash} outcome unknown (${(cause as { message?: string })?.message ?? String(cause)}); resolve it by hash before retrying`,
      { cause },
    );
    this.name = 'TransactionOutcomeUnknownError';
  }
}

/** Where a tx stands on the ledger: closed (either way) or not seen (yet). */
export type TransactionOutcome = 'SUCCESS' | 'FAILED' | 'NOT_FOUND';

/** What the issuance services need from a Horizon connection — fakes implement this in tests. */
export interface TransactionSubmitter {
  loadAccount(address: string): Promise<SDK.Account>;
  /** Throws TransactionRejectedError (did not apply) or TransactionOutcomeUnknownError (may apply). */
  submit(tx: SDK.Transaction): Promise<{ hash: string }>;
}

/** Read-side lookups that resolve an unknown submission outcome after the fact. */
export interface LedgerLookup {
  transactionOutcome(hash: string): Promise<TransactionOutcome>;
  /** The account's auth flags, or undefined when the account does not exist. */
  accountFlags(address: string): Promise<IssuerFlags | undefined>;
}

/** A holder's balance of one asset, for full-balance clawbacks. */
export interface BalanceLookup {
  /** Decimal balance (e.g. "5.0000000"); undefined when the account or the trustline does not exist. */
  assetBalance(address: string, asset: { code: string; issuer: string }): Promise<string | undefined>;
}

/** Thin, typed wrapper around Horizon so services never touch the SDK's error shapes directly. */
export class TxSubmitter implements TransactionSubmitter, LedgerLookup, BalanceLookup {
  constructor(private readonly server: SDK.Horizon.Server) {}

  async loadAccount(address: string): Promise<SDK.Account> {
    // AccountResponse is structurally an Account; the private field mismatch is SDK typing noise.
    return (await this.server.loadAccount(address)) as unknown as SDK.Account;
  }

  async submit(tx: SDK.Transaction): Promise<{ hash: string }> {
    try {
      const res = await this.server.submitTransaction(tx);
      return { hash: res.hash };
    } catch (err) {
      if (isDefinitiveRejection(err)) throw new TransactionRejectedError(extractFailure(err));
      throw new TransactionOutcomeUnknownError(txHashHex(tx), err);
    }
  }

  async transactionOutcome(hash: string): Promise<TransactionOutcome> {
    try {
      const record = await this.server.transactions().transaction(hash).call();
      return record.successful ? 'SUCCESS' : 'FAILED';
    } catch (err) {
      if (httpStatus(err) === 404) return 'NOT_FOUND';
      throw err;
    }
  }

  async accountFlags(address: string): Promise<IssuerFlags | undefined> {
    try {
      const account = await this.server.accounts().accountId(address).call();
      return {
        authRequired: account.flags.auth_required === true,
        authRevocable: account.flags.auth_revocable === true,
        authClawbackEnabled: account.flags.auth_clawback_enabled === true,
      };
    } catch (err) {
      if (httpStatus(err) === 404) return undefined;
      throw err;
    }
  }

  async assetBalance(address: string, asset: { code: string; issuer: string }): Promise<string | undefined> {
    let balances: Array<Record<string, unknown>>;
    try {
      const account = (await this.server.accounts().accountId(address).call()) as unknown as {
        balances: Array<Record<string, unknown>>;
      };
      balances = account.balances ?? [];
    } catch (err) {
      if (httpStatus(err) === 404) return undefined;
      throw err;
    }
    const line = balances.find((b) => b['asset_code'] === asset.code && b['asset_issuer'] === asset.issuer);
    return line === undefined ? undefined : String(line['balance']);
  }
}

/**
 * Only a Horizon 400 carrying a transaction result code proves the tx did not
 * apply; SEP-29's memo check refuses client-side before anything is sent.
 * Everything else (504, timeouts, resets, bodies without codes) is unknown.
 */
function isDefinitiveRejection(err: unknown): boolean {
  if (err instanceof SDK.AccountRequiresMemoError) return true;
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | { extras?: { result_codes?: { transaction?: unknown } } }
    | undefined;
  return httpStatus(err) === 400 && typeof data?.extras?.result_codes?.transaction === 'string';
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

/** The hash Horizon will know the tx by — computable before submission. */
export function txHashHex(tx: SDK.Transaction): string {
  return Buffer.from(tx.hash()).toString('hex');
}

/** Unwraps a TransactionRejectedError, or extracts codes from a raw Horizon error. */
export function toFailure(err: unknown): SubmitFailure {
  if (err instanceof TransactionRejectedError) return err.failure;
  return extractFailure(err);
}

/** Pulls result codes out of the SDK's TransactionFailedError (response.data.extras.result_codes). */
export function extractFailure(err: unknown): SubmitFailure {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | {
        hash?: string;
        extras?: { result_codes?: { transaction?: string; operations?: string[] } };
      }
    | undefined;
  const codes = data?.extras?.result_codes;
  return {
    hash: data?.hash,
    txResultCode: codes?.transaction,
    opResultCodes: Array.isArray(codes?.operations) ? codes.operations : undefined,
    cause: err,
  };
}
