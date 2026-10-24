import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { GateRejectedError, type ComplianceGate } from '../src/gate/compliance-gate';
import {
  SubscriptionSettlementService,
  TrustlineNotReadyError,
  type SettlementRecord,
  type TrustlineLookup,
} from '../src/issuance/subscription-settlement';
import { txHashHex, type LedgerLookup, type TransactionOutcome, type TransactionSubmitter } from '../src/stellar/tx-submitter';
import type { DealInfo, GateDecision, InvestorRef, IssuerFlags } from '../src/types';

class FakeSubmitter implements TransactionSubmitter, LedgerLookup {
  readonly submitted: SDK.Transaction[] = [];

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, '7');
  }

  async submit(tx: SDK.Transaction): Promise<{ hash: string }> {
    this.submitted.push(tx);
    return { hash: txHashHex(tx) };
  }

  async transactionOutcome(): Promise<TransactionOutcome> {
    return 'NOT_FOUND';
  }

  async accountFlags(): Promise<IssuerFlags | undefined> {
    return undefined;
  }
}

function decision(status: GateDecision['status']): GateDecision {
  return { status, provider: 'fake-gate', evaluatedAt: '2026-10-23T00:00:00Z' };
}

function makeService(
  opts: { gateStatus?: GateDecision['status']; trustlineState?: string; settlements?: Map<string, SettlementRecord> } = {},
) {
  const submitter = new FakeSubmitter();
  const audit = new MemoryAuditLog();
  const gate: ComplianceGate = {
    providerName: 'fake-gate',
    evaluate: vi.fn(async () => decision(opts.gateStatus ?? 'approved')),
  };
  const lookup: TrustlineLookup = {
    state: vi.fn(async () => (opts.trustlineState ?? 'READY') as Awaited<ReturnType<TrustlineLookup['state']>>),
  };
  const service = new SubscriptionSettlementService({
    gate,
    submitter,
    networkPassphrase: SDK.Networks.TESTNET,
    trustlineLookup: lookup,
    audit,
    settlements: opts.settlements,
  });
  return { service, submitter, audit, gate, lookup };
}

const DEAL: DealInfo = { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' };
const INVESTOR: InvestorRef = { investorId: 'inv-001', stellarAddress: SDK.Keypair.random().publicKey() };
const ARGS = {
  deal: DEAL,
  issuerKeypair: SDK.Keypair.random(),
  investor: INVESTOR,
  principal: '7500.00',
  settlementId: 'settle-2026-0042-1',
  bankRef: 'TRF-889912',
};

describe('SubscriptionSettlementService (issuance on settled money)', () => {
  it('issues exactly principal units from the issuer after gate approval and trustline pre-flight', async () => {
    const { service, submitter, audit } = makeService();
    const record = await service.settle(ARGS);

    expect(submitter.submitted).toHaveLength(1);
    const op = submitter.submitted[0]!.operations[0] as unknown as {
      type: string;
      destination: string;
      amount: string;
      asset: { code: string };
    };
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(INVESTOR.stellarAddress);
    expect(op.amount).toBe('7500.0000000'); // 1 unit = 1 EUR
    expect(op.asset.code).toBe('UF0042');
    expect(record.txHash).toBe(txHashHex(submitter.submitted[0]!));
    expect(record.bankRef).toBe('TRF-889912');
    expect(audit.events.map((e) => e.kind)).toEqual(['SUBSCRIPTION_SETTLED']);
    expect(audit.events[0]).toMatchObject({ settlementId: 'settle-2026-0042-1', units: '7500.0000000' });
  });

  it('never re-issues for the same settlement id (money arrived once, units minted once)', async () => {
    const { service, submitter } = makeService();
    const first = await service.settle(ARGS);
    const second = await service.settle({ ...ARGS, principal: '7500.00' });
    expect(second).toEqual(first);
    expect(submitter.submitted).toHaveLength(1);
  });

  it('still honours a caller-provided settlements map (legacy dep)', async () => {
    const settlements = new Map<string, SettlementRecord>();
    const first = makeService({ settlements });
    const record = await first.service.settle(ARGS);
    expect(settlements.get(ARGS.settlementId)).toEqual(record);

    const second = makeService({ settlements });
    await expect(second.service.settle(ARGS)).resolves.toEqual(record);
    expect(second.submitter.submitted).toHaveLength(0);
  });

  it('refuses to issue when the gate does not approve (fail closed)', async () => {
    const { service, submitter } = makeService({ gateStatus: 'pending' });
    await expect(service.settle(ARGS)).rejects.toBeInstanceOf(GateRejectedError);
    expect(submitter.submitted).toHaveLength(0);
  });

  it("refuses to issue when the trustline isn't READY", async () => {
    for (const state of ['TRUSTLINE_MISSING', 'TRUSTLINE_UNAUTHORIZED', 'NO_ACCOUNT']) {
      const { service, submitter } = makeService({ trustlineState: state });
      await expect(service.settle(ARGS)).rejects.toBeInstanceOf(TrustlineNotReadyError);
      expect(submitter.submitted).toHaveLength(0);
    }
  });
});
