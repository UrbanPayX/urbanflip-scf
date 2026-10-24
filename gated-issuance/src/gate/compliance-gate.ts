import type { GateDecision, GateRequest } from '../types';

/**
 * Port: the ONLY thing the issuance core knows about compliance.
 *
 * A gate answers one question — "may this investor hold this deal's asset?"
 * — and nothing else. Implementations must be decision-only services: they
 * never build or submit Stellar transactions, so swapping KYC providers can
 * never change issuance semantics.
 *
 * Fail-closed policy (enforced by TrustlineAuthorizer, not by adapters):
 *   approved            -> trustline authorization is emitted
 *   rejected | pending  -> nothing is submitted, GateRejectedError raised
 *   adapter unreachable -> nothing is submitted, GateUnavailableError raised
 */
export interface ComplianceGate {
  readonly providerName: string;
  evaluate(request: GateRequest): Promise<GateDecision>;
}

/** Raised for 'rejected' AND 'pending' decisions: no authorization is emitted without a positive answer. */
export class GateRejectedError extends Error {
  constructor(readonly decision: GateDecision) {
    const detail = decision.reason ? `: ${decision.reason}` : '';
    super(
      `compliance gate '${decision.provider}' returned ${decision.status}${detail}; trustline was NOT authorized`,
    );
    this.name = 'GateRejectedError';
  }
}

/** Raised when the gate cannot be reached or returns an unusable payload. Issuance fails closed. */
export class GateUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GateUnavailableError';
  }
}
