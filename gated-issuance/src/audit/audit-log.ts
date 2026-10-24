import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DealInfo, GateDecision, InvestorRef } from '../types';

/**
 * Every state change that matters for compliance — gate decisions, provisioning,
 * authorizations, freezes, clawbacks — lands here with the tx hash, producing a
 * ledger-to-ledger trail: internal KYC record <-> on-chain transaction.
 */
export type AuditEvent =
  | { kind: 'ISSUER_PROVISIONED'; ts: string; dealId: string; assetCode: string; issuer: string; txHash: string; adoptedExisting?: boolean }
  | { kind: 'GATE_DECISION'; ts: string; dealId: string; investor: InvestorRef; decision: GateDecision }
  | { kind: 'TRUSTLINE_AUTHORIZED'; ts: string; deal: DealInfo; investor: InvestorRef; decision: GateDecision; txHash: string }
  | { kind: 'TRUSTLINE_FROZEN'; ts: string; dealId: string; stellarAddress: string; txHash: string }
  | { kind: 'SUBSCRIPTION_SETTLED'; ts: string; dealId: string; settlementId: string; investorId: string; units: string; bankRef?: string; txHash: string; resolvedByHash?: boolean }
  | {
      kind: 'CLAWBACK';
      ts: string;
      dealId: string;
      stellarAddress: string;
      amount: string;
      txHash: string;
      /** The caller's idempotency key (absent for an id-less full-balance clawback). */
      clawbackId?: string;
      /** The amount was the holder's whole balance at build time. */
      fullBalance?: boolean;
      /** Recorded by looking the tx up by hash after an unknown submit outcome. */
      resolvedByHash?: boolean;
    };

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export class JsonlAuditLog implements AuditLog {
  constructor(private readonly path: string) {}

  async append(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + '\n', 'utf8');
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export function ts(): string {
  return new Date().toISOString();
}
