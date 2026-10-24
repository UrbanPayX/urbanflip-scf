import type { GateDecision, GateRequest } from '../types';
import type { ComplianceGate } from './compliance-gate';

/**
 * Decision-only allowlist gate for tests, dry-runs and manual operations
 * (e.g. an internal deal where compliance is signed off out-of-band).
 * Same interface as the Urbanflip adapter; the issuance core cannot tell
 * the difference — which is the point of the port.
 */
export interface StaticGateEntry {
  investorId: string;
  /** Omit or use '*' to approve the investor for every deal. */
  dealId?: string;
}

export interface StaticGateConfig {
  providerName?: string;
  allow: StaticGateEntry[];
}

export class StaticComplianceGate implements ComplianceGate {
  readonly providerName: string;

  constructor(private readonly entries: StaticGateEntry[], providerName?: string) {
    this.providerName = providerName ?? 'static-allowlist';
  }

  evaluate(req: GateRequest): Promise<GateDecision> {
    const hit = this.entries.find(
      (e) =>
        e.investorId === req.investorId &&
        (e.dealId === undefined || e.dealId === '*' || e.dealId === req.dealId),
    );
    const decision: GateDecision = {
      status: hit ? 'approved' : 'rejected',
      provider: this.providerName,
      evidenceId: hit ? `static:${req.investorId}:${req.dealId}` : undefined,
      reason: hit ? undefined : `no allowlist entry for investor '${req.investorId}' on deal '${req.dealId}'`,
      evaluatedAt: new Date().toISOString(),
    };
    return Promise.resolve(decision);
  }
}

/** Parses the JSON shape used by STATIC_GATE_FILE / config.gate.allow. */
export function parseStaticGateFile(content: string): StaticGateConfig {
  const parsed = JSON.parse(content) as Partial<StaticGateConfig>;
  if (!Array.isArray(parsed.allow)) throw new Error('static gate file must contain an "allow" array');
  return { providerName: parsed.providerName, allow: parsed.allow };
}
