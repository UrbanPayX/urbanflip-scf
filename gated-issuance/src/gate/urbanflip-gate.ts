import type { GateDecision, GateRequest, GateStatus } from '../types';
import { GateUnavailableError } from './compliance-gate';
import type { ComplianceGate } from './compliance-gate';

/**
 * Adapter: Urbanflip's existing KYC pipeline.
 *
 * Expected contract (to be exposed by the Urbanflip platform):
 *   GET {baseUrl}/api/v1/compliance/decision?investorId=...&dealId=...
 *   Authorization: Bearer <apiToken>
 *   200 OK
 *   {
 *     "status": "approved" | "rejected" | "pending",
 *     "evidenceId": "kyc-rec-123",          // optional, lands in the audit trail
 *     "reason": "...",                       // optional
 *     "evaluatedAt": "2026-10-23T10:00:00Z"  // optional, defaults to now
 *   }
 *
 * Every transport failure (5xx, timeout, malformed body) becomes
 * GateUnavailableError, and the issuance core then fails closed: no
 * trustline-authorization transaction is ever built from a missing answer.
 */
export interface UrbanflipGateConfig {
  baseUrl: string;
  apiToken?: string;
  providerName?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const VALID_STATUSES: readonly GateStatus[] = ['approved', 'rejected', 'pending'];
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRIES = 2;

export class UrbanflipComplianceGate implements ComplianceGate {
  readonly providerName: string;
  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(cfg: UrbanflipGateConfig) {
    // Throw early on a misconfigured base URL instead of at first evaluation.
    new URL('/api/v1/compliance/decision', cfg.baseUrl);
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiToken = cfg.apiToken;
    this.providerName = cfg.providerName ?? 'urbanflip-kyc';
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  async evaluate(req: GateRequest): Promise<GateDecision> {
    const url = new URL('/api/v1/compliance/decision', this.baseUrl);
    url.searchParams.set('investorId', req.investorId);
    url.searchParams.set('dealId', req.dealId);

    let body: unknown;
    try {
      body = await this.getJson(url);
    } catch (err) {
      throw new GateUnavailableError(
        `Urbanflip compliance gate unreachable (${url.host}): ${(err as Error).message}`,
        { cause: err },
      );
    }
    return this.toDecision(body);
  }

  private async getJson(url: URL): Promise<unknown> {
    let lastError: unknown = new Error('not attempted');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await sleep(150 * attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`;
        const res = await this.doFetch(url.toString(), {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        if (res.ok) return await res.json();
        // 4xx is a contract/permission problem, not transient — do not retry.
        if (res.status < 500) throw new FatalHttpError(`gate returned HTTP ${res.status}`);
        lastError = new Error(`gate returned HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof FatalHttpError) throw err;
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private toDecision(body: unknown): GateDecision {
    if (typeof body !== 'object' || body === null) {
      throw new GateUnavailableError('gate response was not a JSON object');
    }
    const raw = body as Record<string, unknown>;
    const status = raw['status'];
    if (typeof status !== 'string' || !VALID_STATUSES.includes(status as GateStatus)) {
      throw new GateUnavailableError(`gate response had invalid status: ${JSON.stringify(status)}`);
    }
    return {
      status: status as GateStatus,
      provider: this.providerName,
      evidenceId: typeof raw['evidenceId'] === 'string' ? raw['evidenceId'] : undefined,
      reason: typeof raw['reason'] === 'string' ? raw['reason'] : undefined,
      evaluatedAt: typeof raw['evaluatedAt'] === 'string' ? raw['evaluatedAt'] : new Date().toISOString(),
    };
  }
}

class FatalHttpError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
