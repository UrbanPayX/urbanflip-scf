import * as SDK from '@stellar/stellar-sdk';
import type { AuditLog } from '../audit/audit-log';
import { ts } from '../audit/audit-log';
import type { AuthorizationRecord, DealInfo, InvestorRef, OffboardingRecord } from '../types';
import { GateRejectedError } from '../gate/compliance-gate';
import type { ComplianceGate } from '../gate/compliance-gate';
import { TransactionRejectedError, txHashHex } from '../stellar/tx-submitter';
import type { BalanceLookup, LedgerLookup, TransactionSubmitter } from '../stellar/tx-submitter';
import {
  MemoryClawbackStore,
  type ClawbackRecord,
  type ClawbackStore,
  type PendingClawback,
} from '../store/clawback-store';
import { deriveAssetCode } from './asset-code';
import { inFlightGuardFor } from './in-flight';
import { fromStroops, toStroops } from './money';
import { resolvePendingTx } from './pending-tx';

export interface TrustlineAuthorizerDeps {
  gate: ComplianceGate;
  submitter: TransactionSubmitter;
  networkPassphrase: string;
  fee?: string;
  audit?: AuditLog;
  /**
   * Resolves a pending clawback by hash, and reads balances for full-balance
   * clawbacks. Defaults to `submitter` (TxSubmitter implements both).
   */
  ledger?: Partial<Pick<LedgerLookup, 'transactionOutcome'> & BalanceLookup>;
  /** Completed and pending clawbacks; in-memory by default. JsonFileClawbackStore survives restarts. */
  clawbackStore?: ClawbackStore;
}

export interface ClawbackOptions {
  /** Units to claw back (decimal string, > 0). Omitted: the holder's whole balance. */
  amount?: string;
  /** Idempotency key: required with an explicit amount, optional for a full-balance clawback. */
  clawbackId?: string;
}

/** What clawback() returns, and returns again for a repeated clawbackId. */
export interface ClawbackResult extends OffboardingRecord {
  mode: 'clawback';
  /** Units clawed back (7 decimals). */
  amount: string;
  clawbackId?: string;
  clawedBackAt: string;
  /** Recorded after the fact by looking the tx up by hash (an earlier attempt's outcome was unknown). */
  resolvedByHash?: boolean;
}

/** An explicit-amount clawback without a clawbackId: a retry could not be told from a second clawback. */
export class ClawbackIdRequiredError extends Error {
  constructor() {
    super('a clawback with an explicit amount requires a clawbackId (idempotency key); nothing was submitted');
    this.name = 'ClawbackIdRequiredError';
  }
}

/** A full-balance clawback found nothing to claw back (already clawed back, or no trustline). */
export class NothingToClawBackError extends Error {
  constructor(
    readonly stellarAddress: string,
    readonly assetCode: string,
    readonly noTrustline: boolean,
  ) {
    super(
      `nothing to claw back: ${stellarAddress} ${noTrustline ? `holds no ${assetCode} trustline` : `has a zero ${assetCode} balance`}; nothing was submitted`,
    );
    this.name = 'NothingToClawBackError';
  }
}

/** The clawbackId was already used for a clawback with other parameters. */
export class ClawbackIdConflictError extends Error {
  constructor(
    readonly clawbackId: string,
    readonly differences: string[],
  ) {
    super(`clawbackId '${clawbackId}' was already used with different parameters (${differences.join('; ')}); nothing was submitted`);
    this.name = 'ClawbackIdConflictError';
  }
}

/**
 * An earlier clawback tx for this id is not on the ledger yet but can still
 * apply until its maxTime: nothing is rebuilt until it provably cannot.
 */
export class ClawbackPendingError extends Error {
  constructor(
    readonly clawbackId: string,
    readonly txHash: string,
    /** Unix seconds after which a retry rebuilds the clawback. */
    readonly retryAfter: number,
  ) {
    super(
      `clawback '${clawbackId}': tx ${txHash} may still land; retry after ${new Date(retryAfter * 1000).toISOString()}`,
    );
    this.name = 'ClawbackPendingError';
  }
}

type ClawbackLedger = Partial<Pick<LedgerLookup, 'transactionOutcome'> & BalanceLookup>;

/** A clawback about to be submitted; only one with a clawbackId is recorded in the store. */
interface ClawbackDraft {
  record: Omit<PendingClawback['record'], 'clawbackId'> & { clawbackId?: string };
  maxTime: number;
}

interface ClawbackRequest {
  deal: DealInfo;
  issuerKeypair: SDK.Keypair;
  stellarAddress: string;
  assetCode: string;
  /** Normalized to 7 decimals; undefined = full balance. */
  requestedAmount?: string;
  clawbackId?: string;
}

/**
 * Gate-enforced trustline authorization, plus the two offboarding primitives.
 *
 * authorize() is the ONLY code path in the system that emits a
 * setTrustLineFlags(authorized: true) operation, and it always runs the
 * compliance gate first. 'pending' and unreachable gates are treated exactly
 * like 'rejected' — fail closed — because an on-chain authorization cannot be
 * recalled silently once investors act on it.
 */
export class TrustlineAuthorizer {
  private readonly clawbacks: ClawbackStore;

  constructor(private readonly deps: TrustlineAuthorizerDeps) {
    this.clawbacks = deps.clawbackStore ?? new MemoryClawbackStore();
  }

  async authorize(
    deal: DealInfo,
    issuerKeypair: SDK.Keypair,
    investor: InvestorRef,
  ): Promise<AuthorizationRecord> {
    const decision = await this.deps.gate.evaluate({
      investorId: investor.investorId,
      stellarAddress: investor.stellarAddress,
      dealId: deal.dealId,
    });
    await this.deps.audit?.append({
      kind: 'GATE_DECISION',
      ts: ts(),
      dealId: deal.dealId,
      investor,
      decision,
    });
    if (decision.status !== 'approved') {
      throw new GateRejectedError(decision);
    }

    const asset = new SDK.Asset(deal.assetCode ?? deriveAssetCode(deal.dealId), issuerKeypair.publicKey());
    const tx = await this.buildIssuerTx(issuerKeypair, (builder) =>
      builder.addOperation(
        SDK.Operation.setTrustLineFlags({
          trustor: investor.stellarAddress,
          asset,
          flags: { authorized: true },
        }),
      ),
    );
    const { hash } = await this.deps.submitter.submit(tx);
    await this.deps.audit?.append({
      kind: 'TRUSTLINE_AUTHORIZED',
      ts: ts(),
      deal,
      investor,
      decision,
      txHash: hash,
    });
    return { deal, investor, decision, txHash: hash };
  }

  /**
   * Offboarding step 1: revoke the trustline's authorization, freezing the
   * position (payments and offers in both directions blocked). Requires
   * AUTH_REVOCABLE, which IssuerProvisioner guarantees is set at creation.
   * This is an operator action, taken on a compliance decision outside the
   * gate's subscription scope — hence audited, but not gate-gated.
   */
  async freeze(deal: DealInfo, issuerKeypair: SDK.Keypair, stellarAddress: string): Promise<OffboardingRecord> {
    const asset = new SDK.Asset(deal.assetCode ?? deriveAssetCode(deal.dealId), issuerKeypair.publicKey());
    const tx = await this.buildIssuerTx(issuerKeypair, (builder) =>
      builder.addOperation(
        SDK.Operation.setTrustLineFlags({
          trustor: stellarAddress,
          asset,
          flags: { authorized: false },
        }),
      ),
    );
    const { hash } = await this.deps.submitter.submit(tx);
    await this.deps.audit?.append({
      kind: 'TRUSTLINE_FROZEN',
      ts: ts(),
      dealId: deal.dealId,
      stellarAddress,
      txHash: hash,
    });
    return { deal, stellarAddress, mode: 'freeze', txHash: hash };
  }

  /**
   * Offboarding step 2: claw back the asset from the holder's account.
   * Requires AUTH_CLAWBACK_ENABLED — again guaranteed at issuer creation,
   * since the flag cannot be enabled after balances exist.
   *
   * Exactly once per `clawbackId`, with the same ordering as settlement:
   *   1. a concurrent call with the same id is refused (OperationInProgressError);
   *   2. a completed id returns its recorded result, submitting nothing;
   *   3. a PENDING id (outcome unknown) is resolved by hash first: applied ->
   *      recorded without resubmitting (resolvedByHash); failed, or expired
   *      off-ledger -> rebuilt; not seen but still within maxTime + 30s ->
   *      ClawbackPendingError;
   *   4. the same id with other parameters is refused (ClawbackIdConflictError);
   *   5. the signed clawback's hash and maxTime are recorded PENDING BEFORE it
   *      is submitted; rejection -> pending cleared; unknown -> pending kept.
   *
   * `amount` omitted claws back the holder's whole balance; when nothing is
   * left (a repeat), NothingToClawBackError is thrown and nothing submitted.
   * An explicit amount requires a `clawbackId` (ClawbackIdRequiredError), since
   * only the id can tell a retry from a second clawback.
   */
  clawback(
    deal: DealInfo,
    issuerKeypair: SDK.Keypair,
    stellarAddress: string,
    options?: ClawbackOptions,
  ): Promise<ClawbackResult>;
  /** Positional form: an explicit amount and its idempotency key. */
  clawback(
    deal: DealInfo,
    issuerKeypair: SDK.Keypair,
    stellarAddress: string,
    amount: string,
    clawbackId: string,
  ): Promise<ClawbackResult>;
  async clawback(
    deal: DealInfo,
    issuerKeypair: SDK.Keypair,
    stellarAddress: string,
    optionsOrAmount?: ClawbackOptions | string,
    positionalId?: string,
  ): Promise<ClawbackResult> {
    const options: ClawbackOptions =
      typeof optionsOrAmount === 'string'
        ? { amount: optionsOrAmount, clawbackId: positionalId }
        : { ...optionsOrAmount };
    const req: ClawbackRequest = {
      deal,
      issuerKeypair,
      stellarAddress,
      assetCode: deal.assetCode ?? deriveAssetCode(deal.dealId),
      requestedAmount: options.amount === undefined ? undefined : positiveAmount(options.amount),
      clawbackId: options.clawbackId,
    };
    if (req.clawbackId !== undefined && req.clawbackId.trim() === '') {
      throw new TypeError('clawbackId must be a non-empty string');
    }
    if (req.requestedAmount !== undefined && req.clawbackId === undefined) throw new ClawbackIdRequiredError();
    const ledger = this.ledger({ byHash: req.clawbackId !== undefined, balances: req.requestedAmount === undefined });

    const key =
      req.clawbackId !== undefined
        ? `clawback '${req.clawbackId}'`
        : `full-balance clawback of ${req.assetCode} from ${stellarAddress}`;
    return inFlightGuardFor(this.clawbacks).run(key, () => this.clawbackOnce(req, ledger));
  }

  private async clawbackOnce(req: ClawbackRequest, ledger: ClawbackLedger): Promise<ClawbackResult> {
    const id = req.clawbackId;
    if (id !== undefined) {
      const completed = await this.clawbacks.getCompleted(id);
      if (completed) {
        assertSameClawback(req, completed);
        return toResult(req.deal, completed);
      }
      const pending = await this.clawbacks.getPending(id);
      if (pending) {
        assertSameClawback(req, pending.record);
        const resolution = await resolvePendingTx(
          ledger as Pick<LedgerLookup, 'transactionOutcome'>,
          pending.record.txHash,
          pending.maxTime,
        );
        if (resolution.status === 'APPLIED') return this.finishClawback(req, pending, true);
        if (resolution.status === 'MAY_STILL_APPLY') {
          throw new ClawbackPendingError(id, pending.record.txHash, resolution.retryAfter);
        }
        // Failed on-chain, or expired off-ledger: nothing was clawed back, and never will be.
        await this.clawbacks.clearPending(id);
      }
    }

    const issuer = req.issuerKeypair.publicKey();
    let amount = req.requestedAmount;
    if (amount === undefined) {
      const balance = await ledger.assetBalance!(req.stellarAddress, { code: req.assetCode, issuer });
      if (balance === undefined || toStroops(balance) === 0n) {
        throw new NothingToClawBackError(req.stellarAddress, req.assetCode, balance === undefined);
      }
      amount = fromStroops(toStroops(balance));
    }

    const asset = new SDK.Asset(req.assetCode, issuer);
    const tx = await this.buildIssuerTx(req.issuerKeypair, (builder) =>
      builder.addOperation(SDK.Operation.clawback({ from: req.stellarAddress, asset, amount })),
    );
    const draft: ClawbackDraft = {
      record: {
        ...(id !== undefined && { clawbackId: id }),
        dealId: req.deal.dealId,
        assetCode: req.assetCode,
        issuer,
        stellarAddress: req.stellarAddress,
        ...(req.requestedAmount !== undefined && { requestedAmount: req.requestedAmount }),
        amount,
        txHash: txHashHex(tx),
      },
      maxTime: Number(tx.timeBounds?.maxTime ?? 0),
    };
    // Durable BEFORE submission: from here on, only the hash decides whether it was clawed back.
    if (id !== undefined) {
      await this.clawbacks.putPending({ record: { ...draft.record, clawbackId: id }, maxTime: draft.maxTime });
    }
    try {
      await this.deps.submitter.submit(tx);
    } catch (err) {
      // Rejected: nothing clawed back. Anything else may still apply: keep pending, resolve by hash.
      if (id !== undefined && err instanceof TransactionRejectedError) await this.clawbacks.clearPending(id);
      throw err;
    }
    return this.finishClawback(req, draft, false);
  }

  private async finishClawback(
    req: ClawbackRequest,
    draft: ClawbackDraft,
    resolvedByHash: boolean,
  ): Promise<ClawbackResult> {
    const record: CompletedDraft = {
      ...draft.record,
      clawedBackAt: ts(),
      ...(resolvedByHash && { resolvedByHash: true }),
    };
    if (record.clawbackId !== undefined) {
      await this.clawbacks.markCompleted({ ...record, clawbackId: record.clawbackId });
    }
    await this.deps.audit?.append({
      kind: 'CLAWBACK',
      ts: record.clawedBackAt,
      dealId: record.dealId,
      stellarAddress: record.stellarAddress,
      amount: record.amount,
      txHash: record.txHash,
      clawbackId: record.clawbackId,
      fullBalance: req.requestedAmount === undefined || undefined,
      resolvedByHash: resolvedByHash || undefined,
    });
    return toResult(req.deal, record);
  }

  /**
   * The lookups this clawback needs — checked up front, so a retry after a
   * timeout can never be the first call to discover they are missing.
   */
  private ledger(needs: { byHash: boolean; balances: boolean }): ClawbackLedger {
    const ledger = (this.deps.ledger ?? this.deps.submitter) as ClawbackLedger;
    if (needs.byHash && typeof ledger.transactionOutcome !== 'function') {
      throw new TypeError('a clawback with a clawbackId needs a LedgerLookup (transactionOutcome): pass deps.ledger, or a submitter like TxSubmitter');
    }
    if (needs.balances && typeof ledger.assetBalance !== 'function') {
      throw new TypeError('a full-balance clawback needs a BalanceLookup (assetBalance): pass deps.ledger, or a submitter like TxSubmitter');
    }
    return ledger;
  }

  private async buildIssuerTx(
    issuerKeypair: SDK.Keypair,
    addOps: (builder: SDK.TransactionBuilder) => SDK.TransactionBuilder,
  ): Promise<SDK.Transaction> {
    const issuerAccount = await this.deps.submitter.loadAccount(issuerKeypair.publicKey());
    const builder = new SDK.TransactionBuilder(issuerAccount, {
      networkPassphrase: this.deps.networkPassphrase,
      fee: this.deps.fee ?? '100',
    });
    const tx = addOps(builder).setTimeout(30).build();
    tx.sign(issuerKeypair);
    return tx;
  }
}

function positiveAmount(amount: string): string {
  const stroops = toStroops(amount);
  if (stroops <= 0n) throw new Error(`clawback amount must be positive, got '${amount}'`);
  return fromStroops(stroops);
}

/** A repeated id must name the very same clawback; anything else is a caller bug, refused loudly. */
function assertSameClawback(req: ClawbackRequest, recorded: PendingClawback['record']): void {
  const differences: string[] = [];
  const compare = (field: string, was: string | undefined, now: string | undefined) => {
    if (was !== now) differences.push(`${field}: recorded ${was ?? 'full balance'}, requested ${now ?? 'full balance'}`);
  };
  compare('dealId', recorded.dealId, req.deal.dealId);
  compare('assetCode', recorded.assetCode, req.assetCode);
  compare('issuer', recorded.issuer, req.issuerKeypair.publicKey());
  compare('stellarAddress', recorded.stellarAddress, req.stellarAddress);
  compare('amount', recorded.requestedAmount, req.requestedAmount);
  if (differences.length > 0) throw new ClawbackIdConflictError(recorded.clawbackId, differences);
}

type CompletedDraft = Omit<ClawbackRecord, 'clawbackId'> & { clawbackId?: string };

function toResult(deal: DealInfo, record: CompletedDraft): ClawbackResult {
  return {
    deal,
    stellarAddress: record.stellarAddress,
    mode: 'clawback',
    amount: record.amount,
    txHash: record.txHash,
    ...(record.clawbackId !== undefined && { clawbackId: record.clawbackId }),
    clawedBackAt: record.clawedBackAt,
    ...(record.resolvedByHash && { resolvedByHash: true }),
  };
}
