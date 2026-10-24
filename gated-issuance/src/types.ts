/**
 * Domain types shared across the issuance core.
 *
 * Nothing in this file (or in src/issuance, src/sep1) references Urbanflip:
 * the core is generic on purpose. Urbanflip enters only as a ComplianceGate
 * adapter (src/gate/urbanflip-gate.ts).
 */

/** A single deal whose investor participations are issued as one Stellar asset. */
export interface DealInfo {
  /** Internal deal identifier, e.g. "UF-0042". */
  dealId: string;
  /** Asset code override; derived from dealId when omitted (1-12 ASCII alphanumerics). */
  assetCode?: string;
  /** Human-readable deal name, published in SEP-1 [[CURRENCIES]]. */
  displayName: string;
  /** URL of the deal terms, published in SEP-1 [[CURRENCIES]]. */
  conditions?: string;
}

/** An investor as known to the platform (internal id + their Stellar account). */
export interface InvestorRef {
  investorId: string;
  stellarAddress: string;
}

export type GateStatus = 'approved' | 'rejected' | 'pending';

export interface GateRequest {
  investorId: string;
  stellarAddress: string;
  dealId: string;
}

export interface GateDecision {
  status: GateStatus;
  /** Who decided, e.g. "urbanflip-kyc" or "static-allowlist". */
  provider: string;
  /** Reference to KYC evidence (record id) for the audit trail. */
  evidenceId?: string;
  reason?: string;
  evaluatedAt: string;
}

export interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authClawbackEnabled: boolean;
}

export interface ProvisionedIssuer {
  deal: DealInfo;
  asset: { code: string; issuer: string };
  issuerPublicKey: string;
  /**
   * Secret seed of the per-deal issuer account, as held by the provisioner's
   * IssuerStore (sealed at rest by JsonFileIssuerStore). In production the
   * store port is backed by a KMS/HSM (key ceremony, T3/D8); it is returned
   * here only so the prototype can operate the account.
   */
  issuerSecret: string;
  provisioningTxHash: string;
  flags: IssuerFlags;
}

export interface AuthorizationRecord {
  deal: DealInfo;
  investor: InvestorRef;
  decision: GateDecision;
  txHash: string;
}

export interface OffboardingRecord {
  deal: DealInfo;
  stellarAddress: string;
  mode: 'freeze' | 'clawback';
  amount?: string;
  txHash: string;
}
