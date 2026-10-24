import { join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { MemoryAuditLog, JsonlAuditLog, type AuditLog } from './audit/audit-log';
import { configFromEnv, type AppConfig } from './config';
import { UrbanflipComplianceGate } from './gate/urbanflip-gate';
import { StaticComplianceGate } from './gate/static-gate';
import { IssuerProvisioner } from './issuance/issuer-provisioner';
import { HorizonTrustlineLookup, SubscriptionSettlementService } from './issuance/subscription-settlement';
import { TrustlineAuthorizer } from './issuance/trustline-authorizer';
import { LocalSep1Publisher, type Sep1Publisher } from './sep1/stellar-toml';
import { TxSubmitter } from './stellar/tx-submitter';
import { JsonFileIssuerStore, MemoryIssuerStore, type IssuerStore } from './store/issuer-store';
import { SecretBox } from './store/secret-box';
import { JsonFileSettlementStore, MemorySettlementStore, type SettlementStore } from './store/settlement-store';
import { JsonFileClawbackStore, MemoryClawbackStore, type ClawbackStore } from './store/clawback-store';
import type { ComplianceGate } from './gate/compliance-gate';

export * from './types';
export * from './gate/compliance-gate';
export { UrbanflipComplianceGate } from './gate/urbanflip-gate';
export { StaticComplianceGate, parseStaticGateFile } from './gate/static-gate';
export { IssuerProvisioner, assertProvisioningInvariant } from './issuance/issuer-provisioner';
export {
  TrustlineAuthorizer,
  ClawbackIdRequiredError,
  ClawbackIdConflictError,
  ClawbackPendingError,
  NothingToClawBackError,
} from './issuance/trustline-authorizer';
export type { TrustlineAuthorizerDeps, ClawbackOptions, ClawbackResult } from './issuance/trustline-authorizer';
export {
  SubscriptionSettlementService,
  HorizonTrustlineLookup,
  TrustlineNotReadyError,
  SettlementPendingError,
} from './issuance/subscription-settlement';
export type { TrustlineLookup, SettlementRecord, SettleArgs } from './issuance/subscription-settlement';
export { OperationInProgressError } from './issuance/in-flight';
export { deriveAssetCode, assertValidAssetCode } from './issuance/asset-code';
export { generateStellarToml, LocalSep1Publisher } from './sep1/stellar-toml';
export {
  TxSubmitter,
  TransactionRejectedError,
  TransactionOutcomeUnknownError,
  extractFailure,
  txHashHex,
} from './stellar/tx-submitter';
export type { TransactionSubmitter, LedgerLookup, BalanceLookup, TransactionOutcome } from './stellar/tx-submitter';
export { SecretBox } from './store/secret-box';
export { MemoryIssuerStore, JsonFileIssuerStore } from './store/issuer-store';
export type { IssuerStore, IssuerRecord, IssuerStatus } from './store/issuer-store';
export { MemorySettlementStore, JsonFileSettlementStore } from './store/settlement-store';
export type { SettlementStore, PendingSettlement } from './store/settlement-store';
export { MemoryClawbackStore, JsonFileClawbackStore } from './store/clawback-store';
export type { ClawbackStore, ClawbackRecord, PendingClawback } from './store/clawback-store';
export { StateLockedError, claimStateFile } from './store/state-lock';
export type { LockHolder, StateFileClaim } from './store/state-lock';
export { configFromEnv } from './config';
export type { AppConfig } from './config';

export interface IssuanceService {
  gate: ComplianceGate;
  audit: AuditLog;
  provisioner: IssuerProvisioner;
  authorizer: TrustlineAuthorizer;
  settlement: SubscriptionSettlementService;
  sep1: Sep1Publisher;
  /** Waits for queued state writes, then releases the state directory's lock. */
  close(): Promise<void>;
}

/**
 * Wires the object graph. The gate binding is the only place a concrete KYC provider is named.
 * With config.stateDir, issuer keys (sealed), settlements and clawbacks survive restarts; loading
 * fails closed, so a wrong STATE_KEY stops startup instead of starting empty. The state
 * directory is locked (<stateDir>/.lock) until close(): a second instance — in this process or
 * another — is refused with StateLockedError; a lock left by a dead process on this host is taken over.
 */
export function createIssuance(config: AppConfig): IssuanceService {
  const server = new SDK.Horizon.Server(config.horizonUrl);
  const submitter = new TxSubmitter(server);
  const gate: ComplianceGate =
    config.gate.kind === 'urbanflip'
      ? new UrbanflipComplianceGate({
          baseUrl: config.gate.baseUrl,
          apiToken: config.gate.apiToken,
        })
      : new StaticComplianceGate(config.gate.allow);
  const audit: AuditLog = config.auditLogPath
    ? new JsonlAuditLog(config.auditLogPath)
    : new MemoryAuditLog();
  let issuers: IssuerStore = new MemoryIssuerStore();
  let settlements: SettlementStore = new MemorySettlementStore();
  let clawbacks: ClawbackStore = new MemoryClawbackStore();
  if (config.stateDir) {
    if (!config.stateKey) throw new Error('stateDir requires stateKey (32 bytes as 64 hex chars)');
    const key = SecretBox.fromHex(config.stateKey);
    const dir = config.stateDir;
    // All three share <stateDir>/.lock; if one fails to load, the others release it again.
    const opened: Array<{ close?(): Promise<void> }> = [];
    try {
      opened.push((issuers = new JsonFileIssuerStore(join(dir, 'issuers.json'), key)));
      opened.push((settlements = new JsonFileSettlementStore(join(dir, 'settlements.json'))));
      opened.push((clawbacks = new JsonFileClawbackStore(join(dir, 'clawbacks.json'))));
    } catch (err) {
      for (const store of opened) void store.close?.();
      throw err;
    }
  }
  return {
    gate,
    audit,
    provisioner: new IssuerProvisioner({
      submitter,
      networkPassphrase: config.networkPassphrase,
      funderKeypair: SDK.Keypair.fromSecret(config.funderSecret),
      homeDomain: config.homeDomain,
      audit,
      store: issuers,
    }),
    authorizer: new TrustlineAuthorizer({
      gate,
      submitter,
      networkPassphrase: config.networkPassphrase,
      audit,
      clawbackStore: clawbacks,
    }),
    settlement: new SubscriptionSettlementService({
      gate,
      submitter,
      networkPassphrase: config.networkPassphrase,
      trustlineLookup: new HorizonTrustlineLookup(config.horizonUrl),
      audit,
      store: settlements,
    }),
    sep1: new LocalSep1Publisher(),
    async close() {
      await Promise.all([issuers.close?.(), settlements.close?.(), clawbacks.close?.()]);
    },
  };
}
