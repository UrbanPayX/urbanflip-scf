import * as SDK from '@stellar/stellar-sdk';
import { fromStroops, toStroops } from '../src/issuance/money';
import {
  TransactionOutcomeUnknownError,
  TransactionRejectedError,
  txHashHex,
  type BalanceLookup,
  type LedgerLookup,
  type TransactionOutcome,
  type TransactionSubmitter,
} from '../src/stellar/tx-submitter';
import type { IssuerFlags } from '../src/types';

/**
 * How the next submit() behaves (default 'ok'):
 *   ok               applies the tx, returns its hash
 *   timeout-applied  applies the tx, then throws TransactionOutcomeUnknownError (504 after inclusion)
 *   timeout-lost     does not apply; throws unknown. The tx is parked and may land() later
 *   timeout-failed   included as FAILED (sequence consumed, no effects); throws unknown
 *   reject           throws TransactionRejectedError without applying (Horizon 400 + result codes)
 */
export type SubmitBehaviour = 'ok' | 'timeout-applied' | 'timeout-lost' | 'timeout-failed' | 'reject';

export interface Minted {
  hash: string;
  from: string;
  to: string;
  code: string;
  issuer: string;
  amount: string;
}

export interface ClawedBack {
  hash: string;
  from: string;
  code: string;
  issuer: string;
  amount: string;
}

interface LedgerAccount {
  seq: bigint;
  flags: IssuerFlags;
}

/**
 * In-memory ledger behind the TransactionSubmitter + LedgerLookup +
 * BalanceLookup ports. It really applies what it is sent — sequence numbers,
 * time bounds, createAccount, setOptions flags, payments, clawbacks (which
 * fail op_underfunded beyond the balance) — so a second issuer, mint or
 * clawback shows up in ledger state, not only in call counts.
 */
export class FakeLedger implements TransactionSubmitter, LedgerLookup, BalanceLookup {
  readonly accounts = new Map<string, LedgerAccount>();
  /** hash -> successful, for every tx included in a ledger. */
  readonly included = new Map<string, boolean>();
  readonly submitted: SDK.Transaction[] = [];
  readonly payments: Minted[] = [];
  readonly clawbacks: ClawedBack[] = [];
  /** Credit-asset balances in stroops, keyed by balanceKey(). */
  readonly balances = new Map<string, bigint>();
  readonly parked = new Map<string, SDK.Transaction>();
  readonly lookups: string[] = [];
  /** Runs at the start of each submit(), before the tx is processed. */
  onSubmit?: (tx: SDK.Transaction) => void;
  private readonly script: SubmitBehaviour[] = [];
  private hold?: Promise<void>;

  /** Scripts the next submissions, in order. */
  next(...behaviours: SubmitBehaviour[]): this {
    this.script.push(...behaviours);
    return this;
  }

  fund(address: string): this {
    this.accounts.set(address, { seq: 100n, flags: noFlags() });
    return this;
  }

  /** Gives `address` a trustline holding `amount` of code:issuer (as if paid earlier). */
  credit(address: string, asset: { code: string; issuer: string }, amount: string): this {
    const key = balanceKey(address, asset.code, asset.issuer);
    this.balances.set(key, (this.balances.get(key) ?? 0n) + toStroops(amount));
    return this;
  }

  /** A slow Horizon: every submission waits until release() is called. */
  pause(): () => void {
    let release!: () => void;
    this.hold = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.hold = undefined;
      release();
    };
  }

  /** Lands a parked (lost) tx now — subject to its sequence number and time bounds. */
  land(hash: string): void {
    const tx = this.parked.get(hash);
    if (!tx) throw new Error(`no parked tx ${hash}`);
    this.parked.delete(hash);
    this.apply(tx);
  }

  /** Accounts carrying all three issuer flags. */
  issuers(): string[] {
    return [...this.accounts]
      .filter(([, a]) => a.flags.authRequired && a.flags.authRevocable && a.flags.authClawbackEnabled)
      .map(([address]) => address);
  }

  async loadAccount(address: string): Promise<SDK.Account> {
    const account = this.accounts.get(address);
    if (!account) throw Object.assign(new Error(`account ${address} not found`), { response: { status: 404 } });
    return new SDK.Account(address, account.seq.toString());
  }

  async submit(tx: SDK.Transaction): Promise<{ hash: string }> {
    this.submitted.push(tx);
    const behaviour = this.script.shift() ?? 'ok';
    if (this.hold) await this.hold;
    this.onSubmit?.(tx);
    const hash = txHashHex(tx);
    switch (behaviour) {
      case 'reject':
        throw rejected('tx_failed', ['op_underfunded']);
      case 'timeout-lost':
        this.parked.set(hash, tx);
        throw timeout(hash);
      case 'timeout-failed':
        this.consume(tx, false);
        throw timeout(hash);
      case 'timeout-applied':
        this.apply(tx);
        throw timeout(hash);
      case 'ok':
        this.apply(tx);
        return { hash };
    }
  }

  async transactionOutcome(hash: string): Promise<TransactionOutcome> {
    this.lookups.push(hash);
    const successful = this.included.get(hash);
    if (successful === undefined) return 'NOT_FOUND';
    return successful ? 'SUCCESS' : 'FAILED';
  }

  async accountFlags(address: string): Promise<IssuerFlags | undefined> {
    const account = this.accounts.get(address);
    return account && { ...account.flags };
  }

  async assetBalance(address: string, asset: { code: string; issuer: string }): Promise<string | undefined> {
    const stroops = this.balances.get(balanceKey(address, asset.code, asset.issuer));
    return stroops === undefined ? undefined : fromStroops(stroops);
  }

  private apply(tx: SDK.Transaction): void {
    const source = this.accounts.get(tx.source);
    if (!source) throw rejected('tx_no_source_account');
    if (BigInt(tx.sequence) !== source.seq + 1n) throw rejected('tx_bad_seq');
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (maxTime > 0 && Date.now() / 1000 > maxTime) throw rejected('tx_too_late');

    // Operations are all-or-nothing: validate first, then apply.
    for (const op of tx.operations) {
      if (op.type === 'createAccount' && this.accounts.has(op.destination)) {
        this.consume(tx, false);
        throw rejected('tx_failed', ['op_already_exists']);
      }
      if (op.type === 'clawback') {
        const held = this.balances.get(balanceKey(op.from, op.asset.getCode(), op.asset.getIssuer() ?? '')) ?? 0n;
        if (held < toStroops(op.amount)) {
          this.consume(tx, false);
          throw rejected('tx_failed', ['op_underfunded']);
        }
      }
    }
    for (const op of tx.operations) {
      if (op.type === 'createAccount') {
        this.accounts.set(op.destination, { seq: 4_294_967_296n, flags: noFlags() });
      } else if (op.type === 'setOptions') {
        const target = this.accounts.get(op.source ?? tx.source)!;
        const set = op.setFlags ?? 0;
        target.flags = {
          authRequired: target.flags.authRequired || (set & SDK.AuthRequiredFlag) !== 0,
          authRevocable: target.flags.authRevocable || (set & SDK.AuthRevocableFlag) !== 0,
          authClawbackEnabled: target.flags.authClawbackEnabled || (set & SDK.AuthClawbackEnabledFlag) !== 0,
        };
      } else if (op.type === 'clawback') {
        const key = balanceKey(op.from, op.asset.getCode(), op.asset.getIssuer() ?? '');
        this.balances.set(key, (this.balances.get(key) ?? 0n) - toStroops(op.amount));
        this.clawbacks.push({
          hash: txHashHex(tx),
          from: op.from,
          code: op.asset.getCode(),
          issuer: op.asset.getIssuer() ?? '',
          amount: op.amount,
        });
      } else if (op.type === 'payment' && !op.asset.isNative()) {
        const from = op.source ?? tx.source;
        const [code, issuer] = [op.asset.getCode(), op.asset.getIssuer() ?? ''];
        if (from !== issuer) {
          const key = balanceKey(from, code, issuer);
          this.balances.set(key, (this.balances.get(key) ?? 0n) - toStroops(op.amount));
        }
        if (op.destination !== issuer) {
          const key = balanceKey(op.destination, code, issuer);
          this.balances.set(key, (this.balances.get(key) ?? 0n) + toStroops(op.amount));
        }
        this.payments.push({
          hash: txHashHex(tx),
          from: op.source ?? tx.source,
          to: op.destination,
          code: op.asset.getCode(),
          issuer: op.asset.getIssuer() ?? '',
          amount: op.amount,
        });
      }
    }
    this.consume(tx, true);
  }

  private consume(tx: SDK.Transaction, successful: boolean): void {
    const source = this.accounts.get(tx.source);
    if (source) source.seq = BigInt(tx.sequence);
    this.included.set(txHashHex(tx), successful);
  }
}

function balanceKey(address: string, code: string, issuer: string): string {
  return `${address}|${code}:${issuer}`;
}

function noFlags(): IssuerFlags {
  return { authRequired: false, authRevocable: false, authClawbackEnabled: false };
}

function rejected(txResultCode: string, opResultCodes?: string[]): TransactionRejectedError {
  return new TransactionRejectedError({ txResultCode, opResultCodes, cause: new Error('HTTP 400') });
}

function timeout(hash: string): TransactionOutcomeUnknownError {
  return new TransactionOutcomeUnknownError(hash, new Error('HTTP 504: Timeout'));
}
