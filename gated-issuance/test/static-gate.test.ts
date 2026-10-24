import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { GateRejectedError } from '../src/gate/compliance-gate';
import { parseStaticGateFile, StaticComplianceGate } from '../src/gate/static-gate';
import { TrustlineAuthorizer } from '../src/issuance/trustline-authorizer';
import type { GateRequest } from '../src/types';
import { FakeLedger } from './fake-ledger';

const ADDRESS = SDK.Keypair.random().publicKey();

function req(investorId: string, dealId: string): GateRequest {
  return { investorId, stellarAddress: ADDRESS, dealId };
}

describe('StaticComplianceGate (decision-only allowlist)', () => {
  it('approves an investor listed for exactly this deal, with evidence naming the entry', async () => {
    const gate = new StaticComplianceGate([{ investorId: 'inv-001', dealId: 'UF-0042' }]);
    const decision = await gate.evaluate(req('inv-001', 'UF-0042'));
    expect(decision).toMatchObject({
      status: 'approved',
      provider: 'static-allowlist',
      evidenceId: 'static:inv-001:UF-0042',
    });
    expect(decision.reason).toBeUndefined();
    expect(Number.isNaN(Date.parse(decision.evaluatedAt))).toBe(false);
  });

  it('an entry without a dealId, or with "*", approves the investor for every deal', async () => {
    const gate = new StaticComplianceGate([{ investorId: 'inv-any' }, { investorId: 'inv-star', dealId: '*' }]);
    for (const investorId of ['inv-any', 'inv-star']) {
      for (const dealId of ['UF-0042', 'UF-0099']) {
        await expect(gate.evaluate(req(investorId, dealId))).resolves.toMatchObject({ status: 'approved' });
      }
    }
  });

  it('rejects (never "pending") an investor listed for another deal, or not listed at all', async () => {
    const gate = new StaticComplianceGate([{ investorId: 'inv-001', dealId: 'UF-0042' }], 'ops-signoff');
    const otherDeal = await gate.evaluate(req('inv-001', 'UF-0099'));
    expect(otherDeal).toMatchObject({
      status: 'rejected',
      provider: 'ops-signoff',
      reason: "no allowlist entry for investor 'inv-001' on deal 'UF-0099'",
    });
    expect(otherDeal.evidenceId).toBeUndefined();
    await expect(gate.evaluate(req('inv-002', 'UF-0042'))).resolves.toMatchObject({ status: 'rejected' });
    // an empty allowlist approves nobody
    await expect(new StaticComplianceGate([]).evaluate(req('inv-001', 'UF-0042'))).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('matches investor ids exactly: no prefix or case-insensitive match', async () => {
    const gate = new StaticComplianceGate([{ investorId: 'inv-001' }]);
    for (const investorId of ['inv-0011', 'INV-001', 'inv-00', '']) {
      await expect(gate.evaluate(req(investorId, 'UF-0042'))).resolves.toMatchObject({ status: 'rejected' });
    }
  });

  it('behind TrustlineAuthorizer: a listed investor is authorized, an unlisted one gets nothing on-chain', async () => {
    const ledger = new FakeLedger();
    const issuer = SDK.Keypair.random();
    ledger.fund(issuer.publicKey());
    const audit = new MemoryAuditLog();
    const authorizer = new TrustlineAuthorizer({
      gate: new StaticComplianceGate([{ investorId: 'inv-001', dealId: 'UF-0042' }]),
      submitter: ledger,
      networkPassphrase: SDK.Networks.TESTNET,
      audit,
    });
    const deal = { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' };

    await expect(
      authorizer.authorize(deal, issuer, { investorId: 'inv-002', stellarAddress: ADDRESS }),
    ).rejects.toBeInstanceOf(GateRejectedError);
    expect(ledger.submitted).toHaveLength(0);

    const record = await authorizer.authorize(deal, issuer, { investorId: 'inv-001', stellarAddress: ADDRESS });
    expect(record.decision).toMatchObject({ status: 'approved', evidenceId: 'static:inv-001:UF-0042' });
    expect(ledger.submitted).toHaveLength(1);
    expect(audit.events.map((e) => e.kind)).toEqual(['GATE_DECISION', 'GATE_DECISION', 'TRUSTLINE_AUTHORIZED']);
  });
});

describe('parseStaticGateFile', () => {
  it('reads the allow list and an optional provider name', () => {
    const parsed = parseStaticGateFile(
      JSON.stringify({ providerName: 'ops-signoff', allow: [{ investorId: 'inv-001', dealId: 'UF-0042' }] }),
    );
    expect(parsed).toEqual({ providerName: 'ops-signoff', allow: [{ investorId: 'inv-001', dealId: 'UF-0042' }] });
    expect(parseStaticGateFile('{"allow": []}')).toEqual({ providerName: undefined, allow: [] });
  });

  it('refuses a file without an "allow" array instead of approving or rejecting everyone silently', () => {
    expect(() => parseStaticGateFile('{}')).toThrow(/"allow" array/);
    expect(() => parseStaticGateFile('{"allow": {"investorId": "inv-001"}}')).toThrow(/"allow" array/);
    expect(() => parseStaticGateFile('null')).toThrow();
    expect(() => parseStaticGateFile('{"allow": [')).toThrow(SyntaxError);
  });
});
