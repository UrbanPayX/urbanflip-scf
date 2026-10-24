import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { GateRejectedError, type ComplianceGate } from '../src/gate/compliance-gate';
import { TrustlineAuthorizer } from '../src/issuance/trustline-authorizer';
import type { LedgerLookup, TransactionSubmitter } from '../src/stellar/tx-submitter';
import type { DealInfo, GateDecision, InvestorRef } from '../src/types';

class FakeSubmitter implements TransactionSubmitter, Pick<LedgerLookup, 'transactionOutcome'> {
  readonly submitted: SDK.Transaction[] = [];

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, '55');
  }

  async submit(tx: SDK.Transaction): Promise<{ hash: string }> {
    this.submitted.push(tx);
    return { hash: 'fake-hash-' + (this.submitted.length - 1) };
  }

  async transactionOutcome(): Promise<'NOT_FOUND'> {
    return 'NOT_FOUND';
  }
}

const DEAL: DealInfo = { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' };
// StrKey validates the checksum, so test addresses must be real keypairs.
const INVESTOR: InvestorRef = { investorId: 'inv-001', stellarAddress: SDK.Keypair.random().publicKey() };

function decision(status: GateDecision['status'], extra: Partial<GateDecision> = {}): GateDecision {
  return { status, provider: 'fake-gate', evaluatedAt: '2026-10-23T00:00:00Z', ...extra };
}

function makeAuthorizer(gate: ComplianceGate) {
  const submitter = new FakeSubmitter();
  const audit = new MemoryAuditLog();
  const authorizer = new TrustlineAuthorizer({
    gate,
    submitter,
    networkPassphrase: SDK.Networks.TESTNET,
    audit,
  });
  return { authorizer, submitter, audit };
}

describe('TrustlineAuthorizer gate enforcement (fail closed)', () => {
  it('authorizes only after an approved gate decision', async () => {
    const gate: ComplianceGate = {
      providerName: 'fake-gate',
      evaluate: vi.fn(async () => decision('approved', { evidenceId: 'kyc-77' })),
    };
    const { authorizer, submitter, audit } = makeAuthorizer(gate);
    const issuer = SDK.Keypair.random();

    const record = await authorizer.authorize(DEAL, issuer, INVESTOR);

    expect(gate.evaluate).toHaveBeenCalledWith({
      investorId: 'inv-001',
      stellarAddress: INVESTOR.stellarAddress,
      dealId: 'UF-0042',
    });
    expect(submitter.submitted).toHaveLength(1);

    const op = submitter.submitted[0]!.operations[0] as SDK.Operation.SetTrustLineFlags;
    expect(op.type).toBe('setTrustLineFlags');
    expect(op.trustor).toBe(INVESTOR.stellarAddress);
    expect(op.flags).toEqual({ authorized: true });
    expect(op.asset?.code).toBe('UF0042');
    expect(op.asset?.issuer).toBe(issuer.publicKey());

    expect(record.decision.evidenceId).toBe('kyc-77');
    const kinds = audit.events.map((e) => e.kind);
    expect(kinds).toEqual(['GATE_DECISION', 'TRUSTLINE_AUTHORIZED']);
    expect(audit.events[1]).toMatchObject({ txHash: 'fake-hash-0' });
  });

  it('emits NOTHING when the gate rejects', async () => {
    const gate: ComplianceGate = {
      providerName: 'fake-gate',
      evaluate: vi.fn(async () => decision('rejected', { reason: 'KYC expired' })),
    };
    const { authorizer, submitter, audit } = makeAuthorizer(gate);

    await expect(authorizer.authorize(DEAL, SDK.Keypair.random(), INVESTOR)).rejects.toBeInstanceOf(
      GateRejectedError,
    );
    expect(submitter.submitted).toHaveLength(0);
    // the rejection itself is audited
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ kind: 'GATE_DECISION', decision: { status: 'rejected' } });
  });

  it("treats 'pending' exactly like 'rejected'", async () => {
    const gate: ComplianceGate = {
      providerName: 'fake-gate',
      evaluate: vi.fn(async () => decision('pending')),
    };
    const { authorizer, submitter } = makeAuthorizer(gate);

    await expect(authorizer.authorize(DEAL, SDK.Keypair.random(), INVESTOR)).rejects.toBeInstanceOf(
      GateRejectedError,
    );
    expect(submitter.submitted).toHaveLength(0);
  });

  it('does not submit when the gate itself throws (unreachable provider)', async () => {
    const gate: ComplianceGate = {
      providerName: 'fake-gate',
      evaluate: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const { authorizer, submitter } = makeAuthorizer(gate);
    await expect(authorizer.authorize(DEAL, SDK.Keypair.random(), INVESTOR)).rejects.toThrow(
      /connection refused/,
    );
    expect(submitter.submitted).toHaveLength(0);
  });

  it('freeze and clawback are operator actions: no gate call, audited, correct operations', async () => {
    const evaluate = vi.fn(async () => decision('approved'));
    const { authorizer, submitter, audit } = makeAuthorizer({ providerName: 'fake-gate', evaluate });
    const issuer = SDK.Keypair.random();

    await authorizer.freeze(DEAL, issuer, INVESTOR.stellarAddress);
    await authorizer.clawback(DEAL, issuer, INVESTOR.stellarAddress, { amount: '150.5', clawbackId: 'offboard-1' });

    expect(evaluate).not.toHaveBeenCalled();
    expect(submitter.submitted).toHaveLength(2);

    const freezeOp = submitter.submitted[0]!.operations[0] as SDK.Operation.SetTrustLineFlags;
    expect(freezeOp.type).toBe('setTrustLineFlags');
    expect(freezeOp.flags).toEqual({ authorized: false });

    const clawbackOp = submitter.submitted[1]!.operations[0] as SDK.Operation.Clawback;
    expect(clawbackOp.type).toBe('clawback');
    expect(clawbackOp.from).toBe(INVESTOR.stellarAddress);
    expect(clawbackOp.amount).toBe('150.5000000');

    expect(audit.events.map((e) => e.kind)).toEqual(['TRUSTLINE_FROZEN', 'CLAWBACK']);
  });
});
