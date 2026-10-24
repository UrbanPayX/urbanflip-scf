import * as SDK from '@stellar/stellar-sdk';
import type { AuditLog } from '../audit/audit-log';
import { ts } from '../audit/audit-log';
import { GateRejectedError } from '../gate/compliance-gate';
import type { ComplianceGate } from '../gate/compliance-gate';
import { fromStroops, toStroops } from './money';
import { TransactionRejectedError, txHashHex } from '../stellar/tx-submitter';
import type { LedgerLookup, TransactionSubmitter } from '../stellar/tx-submitter';
import { MemorySettlementStore, type PendingSettlement, type SettlementStore } from '../store/settlement-store';
import type { DealInfo, InvestorRef } from '../types';
import { deriveAssetCode } from './asset-code';
import { inFlightGuardFor } from './in-flight';
import { resolvePendingTx } from './pending-tx';

/**
 * Pre-flight view of an investor's trustline, so issuance can refuse loudly
 * here instead of failing op-level inside a settlement run.
 */
export interface TrustlineLookup {
  state(
    asset: { code: string; issuer: string },
    address: string,
  ): Promise<'READY' | 'NO_ACCOUNT' | 'TRUSTLINE_MISSING' | 'TRUSTLINE_UNAUTHORIZED'>;
}

export class HorizonTrustlineLookup implements TrustlineLookup {
  constructor(private readonly horizonUrl: string) {}

  async state(
    asset: { code: string; issuer: string },
    address: string,
  ): Promise<'READY' | 'NO_ACCOUNT' | 'TRUSTLINE_MISSING' | 'TRUSTLINE_UNAUTHORIZED'> {
    const server = new SDK.Horizon.Server(this.horizonUrl);
    let balances: Array<Record<string, unknown>>;
    try {
      const account = (await server.accounts().accountId(address).call()) as unknown as {
        balances: Array<Record<string, unknown>>;
      };
      balances = account.balances;
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 404) return 'NO_ACCOUNT';
      throw err;
    }
    const line = balances.find((b) => b['asset_code'] === asset.code && b['asset_issuer'] === asset.issuer);
    if (!line) return 'TRUSTLINE_MISSING';
    if (line['is_authorized'] === false) return 'TRUSTLINE_UNAUTHORIZED';
    return 'READY';
  }
}

export class TrustlineNotReadyError extends Error {
  constructor(readonly state: string, address: string) {
    super(`trustline for ${address} is ${state}; settlement refused — nothing was issued`);
    this.name = 'TrustlineNotReadyError';
  }
}

/**
 * An earlier issuance tx for this settlement is not on the ledger yet but can
 * still apply until its maxTime: nothing is rebuilt until it provably cannot.
 */
export class SettlementPendingError extends Error {
  constructor(
    readonly settlementId: string,
    readonly txHash: string,
    /** Unix seconds after which a retry rebuilds the issuance. */
    readonly retryAfter: number,
  ) {
    super(
      `settlement '${settlementId}': issuance tx ${txHash} may still land; retry after ${new Date(retryAfter * 1000).toISOString()}`,
    );
    this.name = 'SettlementPendingError';
  }
}

export interface SettlementRecord {
  settlementId: string;
  investorId: string;
  stellarAddress: string;
  /** Units issued; 1 unit = 1 EUR of subscribed principal. */
  units: string;
  bankRef?: string;
  txHash: string;
  settledAt: string;
}

export interface SubscriptionSettlementDeps {
  gate: ComplianceGate;
  /** Also resolves a pending issuance by hash after a timeout or restart. */
  submitter: TransactionSubmitter & LedgerLookup;
  networkPassphrase: string;
  trustlineLookup: TrustlineLookup;
  audit?: AuditLog;
  /** Settled and pending issuances; in-memory by default. JsonFileSettlementStore survives restarts. */
  store?: SettlementStore;
  /** @deprecated Use `store`. Settled records for an in-memory store (ignored when `store` is set). */
  settlements?: Map<string, SettlementRecord>;
}

export interface SettleArgs {
  deal: DealInfo;
  issuerKeypair: SDK.Keypair;
  investor: InvestorRef;
  /** Subscribed principal in EUR (decimal string), as recorded by the platform's ledger. */
  principal: string;
  /** Platform settlement id (bank receipt / subscription row). Idempotency key. */
  settlementId: string;
  /** e.g. bank transfer reference, for the audit trail. */
  bankRef?: string;
}

/**
 * THE issuance step: money has arrived at the deal's SPV (bank transfer or
 * off-ramped USDC), and now the participation units are minted to the investor.
 *
 * Convention: 1 asset unit = 1 EUR of subscribed principal, so the on-chain
 * position is independently verifiable against the participative-loan ledger.
 *
 * Ordering guarantees (all tested):
 *   1. a concurrent settle() for the same settlementId is refused while one runs;
 *   2. duplicate settlementId -> return the recorded settlement, issue nothing;
 *   3. a PENDING issuance (outcome unknown) is resolved by hash first: applied ->
 *      recorded without resubmitting; failed, or expired off-ledger -> rebuilt;
 *      not seen but still within maxTime + grace -> SettlementPendingError;
 *   4. compliance gate runs and must APPROVE (fail closed, as everywhere);
 *   5. the investor's trustline must be READY (authorized) — issuance is
 *      refused loudly pre-flight instead of dying op-level on-chain;
 *   6. the signed payment's hash and maxTime are recorded PENDING BEFORE it is
 *      submitted; success -> SETTLED (audited with the bank ref); rejection ->
 *      pending cleared; unknown outcome -> pending kept, error thrown.
 */
export class SubscriptionSettlementService {
  private readonly store: SettlementStore;

  constructor(private readonly deps: SubscriptionSettlementDeps) {
    this.store = deps.store ?? new MemorySettlementStore(deps.settlements);
  }

  async settle(args: SettleArgs): Promise<SettlementRecord> {
    return inFlightGuardFor(this.store).run(`settlement '${args.settlementId}'`, () => this.settleOnce(args));
  }

  private async settleOnce(args: SettleArgs): Promise<SettlementRecord> {
    const recorded = await this.store.getSettled(args.settlementId);
    if (recorded) return recorded;

    const pending = await this.store.getPending(args.settlementId);
    if (pending) {
      const resolved = await this.resolvePending(args, pending);
      if (resolved) return resolved;
    }

    const decision = await this.deps.gate.evaluate({
      investorId: args.investor.investorId,
      stellarAddress: args.investor.stellarAddress,
      dealId: args.deal.dealId,
    });
    if (decision.status !== 'approved') throw new GateRejectedError(decision);

    const code = args.deal.assetCode ?? deriveAssetCode(args.deal.dealId);
    const issuer = args.issuerKeypair.publicKey();
    const asset = new SDK.Asset(code, issuer);
    const state = await this.deps.trustlineLookup.state(
      { code, issuer },
      args.investor.stellarAddress,
    );
    if (state !== 'READY') throw new TrustlineNotReadyError(state, args.investor.stellarAddress);

    const units = fromStroops(toStroops(args.principal));
    const issuerAccount = await this.deps.submitter.loadAccount(args.issuerKeypair.publicKey());
    const tx = new SDK.TransactionBuilder(issuerAccount, {
      networkPassphrase: this.deps.networkPassphrase,
      fee: '100',
    })
      .addOperation(
        SDK.Operation.payment({
          destination: args.investor.stellarAddress,
          asset,
          amount: units,
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(args.issuerKeypair);

    const issuance: PendingSettlement = {
      record: {
        settlementId: args.settlementId,
        investorId: args.investor.investorId,
        stellarAddress: args.investor.stellarAddress,
        units,
        bankRef: args.bankRef,
        txHash: txHashHex(tx),
      },
      maxTime: Number(tx.timeBounds?.maxTime ?? 0),
    };
    // Durable BEFORE submission: from here on, only the hash decides whether units were minted.
    await this.store.putPending(issuance);
    try {
      await this.deps.submitter.submit(tx);
    } catch (err) {
      // Rejected: nothing minted. Anything else may still apply: keep pending, resolve by hash.
      if (err instanceof TransactionRejectedError) await this.store.clearPending(args.settlementId);
      throw err;
    }
    return this.finish(args, issuance, false);
  }

  /** Returns the settlement if the pending tx applied; undefined once it provably never will. */
  private async resolvePending(args: SettleArgs, pending: PendingSettlement): Promise<SettlementRecord | undefined> {
    const resolution = await resolvePendingTx(this.deps.submitter, pending.record.txHash, pending.maxTime);
    if (resolution.status === 'APPLIED') return this.finish(args, pending, true);
    if (resolution.status === 'MAY_STILL_APPLY') {
      throw new SettlementPendingError(args.settlementId, pending.record.txHash, resolution.retryAfter);
    }
    // Failed on-chain, or expired off-ledger: it never minted and never can.
    await this.store.clearPending(args.settlementId);
    return undefined;
  }

  private async finish(args: SettleArgs, issuance: PendingSettlement, resolvedByHash: boolean): Promise<SettlementRecord> {
    const record: SettlementRecord = { ...issuance.record, settledAt: ts() };
    await this.store.markSettled(record);
    await this.deps.audit?.append({
      kind: 'SUBSCRIPTION_SETTLED',
      ts: record.settledAt,
      dealId: args.deal.dealId,
      settlementId: record.settlementId,
      investorId: record.investorId,
      units: record.units,
      bankRef: record.bankRef,
      txHash: record.txHash,
      resolvedByHash: resolvedByHash || undefined,
    });
    return record;
  }
}
