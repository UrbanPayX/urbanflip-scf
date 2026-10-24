import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { GateRejectedError, GateUnavailableError, type ComplianceGate } from '../src/gate/compliance-gate';
import {
  ClawbackIdConflictError,
  ClawbackIdRequiredError,
  NothingToClawBackError,
  TrustlineAuthorizer,
  type TrustlineAuthorizerDeps,
} from '../src/issuance/trustline-authorizer';
import { TransactionOutcomeUnknownError, TransactionRejectedError, type TransactionSubmitter } from '../src/stellar/tx-submitter';
import { MemoryClawbackStore } from '../src/store/clawback-store';
import type { DealInfo, GateDecision } from '../src/types';
import { FakeLedger } from './fake-ledger';

/**
 * Every way TrustlineAuthorizer refuses or fails, and what it leaves behind:
 * nothing submitted on a refusal, nothing recorded as done on a failure.
 */
const DEAL: DealInfo = { dealId: 'UF-MADRID-1', assetCode: 'UFMADRID1', displayName: 'Urbanflip Madrid 1' };

function approvedGate(): ComplianceGate {
  const decision: GateDecision = { status: 'approved', provider: 'fake', evaluatedAt: '2026-10-23T00:00:00Z' };
  return { providerName: 'fake', evaluate: vi.fn(async () => decision) };
}

function setup(overrides: Partial<TrustlineAuthorizerDeps> = {}) {
  const ledger = new FakeLedger();
  const issuer = SDK.Keypair.random();
  ledger.fund(issuer.publicKey());
  const holder = SDK.Keypair.random().publicKey();
  ledger.credit(holder, { code: 'UFMADRID1', issuer: issuer.publicKey() }, '100');
  const audit = new MemoryAuditLog();
  const store = new MemoryClawbackStore();
  const authorizer = new TrustlineAuthorizer({
    gate: approvedGate(),
    submitter: ledger,
    networkPassphrase: SDK.Networks.TESTNET,
    audit,
    clawbackStore: store,
    ...overrides,
  });
  return { ledger, issuer, holder, audit, store, authorizer };
}

/** A submitter with no read side: what a minimal TransactionSubmitter port offers. */
function writeOnly(ledger: FakeLedger): TransactionSubmitter {
  return { loadAccount: (a) => ledger.loadAccount(a), submit: (tx) => ledger.submit(tx) };
}

describe('TrustlineAuthorizer.authorize failures', () => {
  it('a gate that is unavailable fails closed: GateUnavailableError, nothing submitted or audited', async () => {
    const gate: ComplianceGate = {
      providerName: 'urbanflip-kyc',
      evaluate: vi.fn(async () => {
        throw new GateUnavailableError('gate returned HTTP 503');
      }),
    };
    const { ledger, issuer, holder, audit, authorizer } = setup({ gate });
    await expect(
      authorizer.authorize(DEAL, issuer, { investorId: 'inv-001', stellarAddress: holder }),
    ).rejects.toBeInstanceOf(GateUnavailableError);
    expect(ledger.submitted).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it('a rejection carries the decision and says the trustline was NOT authorized', async () => {
    const decision: GateDecision = {
      status: 'pending',
      provider: 'urbanflip-kyc',
      reason: 'documents under review',
      evaluatedAt: '2026-10-23T00:00:00Z',
    };
    const { ledger, issuer, holder, authorizer } = setup({
      gate: { providerName: 'urbanflip-kyc', evaluate: vi.fn(async () => decision) },
    });
    const err = (await authorizer
      .authorize(DEAL, issuer, { investorId: 'inv-001', stellarAddress: holder })
      .catch((e: unknown) => e)) as GateRejectedError;
    expect(err).toBeInstanceOf(GateRejectedError);
    expect(err.decision).toEqual(decision);
    expect(err.message).toBe(
      "compliance gate 'urbanflip-kyc' returned pending: documents under review; trustline was NOT authorized",
    );
    expect(ledger.submitted).toHaveLength(0);
  });

  it('an approved investor whose authorization tx is rejected on-chain is not recorded as authorized', async () => {
    const { ledger, issuer, holder, audit, authorizer } = setup();
    ledger.next('reject');
    await expect(
      authorizer.authorize(DEAL, issuer, { investorId: 'inv-001', stellarAddress: holder }),
    ).rejects.toBeInstanceOf(TransactionRejectedError);
    expect(audit.events.map((e) => e.kind)).toEqual(['GATE_DECISION']);
  });

  it('an unknown outcome surfaces as such (resolve by hash), with no TRUSTLINE_AUTHORIZED record', async () => {
    const { ledger, issuer, holder, audit, authorizer } = setup();
    ledger.next('timeout-lost');
    await expect(
      authorizer.authorize(DEAL, issuer, { investorId: 'inv-001', stellarAddress: holder }),
    ).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    expect(audit.events.map((e) => e.kind)).toEqual(['GATE_DECISION']);
  });

  it('authorizes the pinned asset code of the deal, issued by the given issuer', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    await authorizer.authorize(DEAL, issuer, { investorId: 'inv-001', stellarAddress: holder });
    const op = ledger.submitted[0]!.operations[0] as SDK.Operation.SetTrustLineFlags;
    expect(op.asset).toMatchObject({ code: 'UFMADRID1', issuer: issuer.publicKey() });
    expect(ledger.submitted[0]!.source).toBe(issuer.publicKey());
  });

  it('cannot authorize for an issuer account that does not exist: nothing submitted', async () => {
    const { ledger, holder, authorizer } = setup();
    await expect(
      authorizer.authorize(DEAL, SDK.Keypair.random(), { investorId: 'inv-001', stellarAddress: holder }),
    ).rejects.toThrow(/not found/);
    expect(ledger.submitted).toHaveLength(0);
  });
});

describe('TrustlineAuthorizer.freeze failures', () => {
  it('a rejected freeze is not audited as frozen', async () => {
    const { ledger, issuer, holder, audit, authorizer } = setup();
    ledger.next('reject');
    await expect(authorizer.freeze(DEAL, issuer, holder)).rejects.toBeInstanceOf(TransactionRejectedError);
    expect(audit.events).toHaveLength(0);

    const frozen = await authorizer.freeze(DEAL, issuer, holder);
    expect(frozen).toMatchObject({ mode: 'freeze', stellarAddress: holder });
    expect(audit.events.map((e) => e.kind)).toEqual(['TRUSTLINE_FROZEN']);
  });
});

describe('TrustlineAuthorizer.clawback refusals (nothing submitted, nothing recorded)', () => {
  it('refuses an empty or blank clawbackId', async () => {
    const { ledger, issuer, holder, store, authorizer } = setup();
    for (const clawbackId of ['', '   ', '\t']) {
      await expect(authorizer.clawback(DEAL, issuer, holder, { amount: '1', clawbackId })).rejects.toThrow(
        /clawbackId must be a non-empty string/,
      );
    }
    expect(ledger.submitted).toHaveLength(0);
    expect(await store.getPending('')).toBeUndefined();
  });

  it('refuses malformed and non-positive amounts', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    for (const amount of ['abc', '-5', '1.12345678', '1e3', '', '0.0000000']) {
      await expect(
        authorizer.clawback(DEAL, issuer, holder, { amount, clawbackId: `cb-${amount}` }),
      ).rejects.toThrow(/invalid decimal amount|must be positive/);
    }
    expect(ledger.submitted).toHaveLength(0);
  });

  it('an explicit amount needs an id: the error says nothing was submitted', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    const err = await authorizer.clawback(DEAL, issuer, holder, { amount: '5' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClawbackIdRequiredError);
    expect((err as Error).message).toMatch(/nothing was submitted/);
    expect(ledger.submitted).toHaveLength(0);
  });

  it('a clawbackId without a by-hash ledger lookup is refused up front, before anything is recorded', async () => {
    const ledger = new FakeLedger();
    const issuer = SDK.Keypair.random();
    ledger.fund(issuer.publicKey());
    const holder = SDK.Keypair.random().publicKey();
    const store = new MemoryClawbackStore();
    const authorizer = new TrustlineAuthorizer({
      gate: approvedGate(),
      submitter: writeOnly(ledger),
      networkPassphrase: SDK.Networks.TESTNET,
      clawbackStore: store,
    });
    await expect(
      authorizer.clawback(DEAL, issuer, holder, { amount: '5', clawbackId: 'cb-1' }),
    ).rejects.toThrow(/needs a LedgerLookup \(transactionOutcome\)/);
    expect(ledger.submitted).toHaveLength(0);
    expect(await store.getPending('cb-1')).toBeUndefined();
  });

  it('a full-balance clawback without a balance lookup is refused up front', async () => {
    const ledger = new FakeLedger();
    const issuer = SDK.Keypair.random();
    ledger.fund(issuer.publicKey());
    const authorizer = new TrustlineAuthorizer({
      gate: approvedGate(),
      submitter: writeOnly(ledger),
      networkPassphrase: SDK.Networks.TESTNET,
      // by-hash lookups only: still not enough for a full-balance clawback
      ledger: { transactionOutcome: (h) => ledger.transactionOutcome(h) },
    });
    await expect(
      authorizer.clawback(DEAL, issuer, SDK.Keypair.random().publicKey(), { clawbackId: 'cb-full' }),
    ).rejects.toThrow(/needs a BalanceLookup \(assetBalance\)/);
    expect(ledger.submitted).toHaveLength(0);
  });

  it('a separate deps.ledger serves the lookups when the submitter is write-only', async () => {
    const ledger = new FakeLedger();
    const issuer = SDK.Keypair.random();
    ledger.fund(issuer.publicKey());
    const holder = SDK.Keypair.random().publicKey();
    ledger.credit(holder, { code: 'UFMADRID1', issuer: issuer.publicKey() }, '25');
    const authorizer = new TrustlineAuthorizer({
      gate: approvedGate(),
      submitter: writeOnly(ledger),
      networkPassphrase: SDK.Networks.TESTNET,
      ledger,
    });
    ledger.next('timeout-applied');
    await expect(authorizer.clawback(DEAL, issuer, holder, { clawbackId: 'cb-full' })).rejects.toBeInstanceOf(
      TransactionOutcomeUnknownError,
    );
    await expect(authorizer.clawback(DEAL, issuer, holder, { clawbackId: 'cb-full' })).resolves.toMatchObject({
      amount: '25.0000000',
      resolvedByHash: true,
    });
    expect(ledger.submitted).toHaveLength(1);
  });

  it('a full-balance id reused with an explicit amount is a conflict, naming both sides', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    await authorizer.clawback(DEAL, issuer, holder, { clawbackId: 'cb-full' });
    const err = await authorizer
      .clawback(DEAL, issuer, holder, { amount: '40', clawbackId: 'cb-full' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClawbackIdConflictError);
    expect((err as ClawbackIdConflictError).differences).toEqual([
      'amount: recorded full balance, requested 40.0000000',
    ]);
    expect(ledger.submitted).toHaveLength(1);
  });

  it('a reused id for another deal, asset or issuer is a conflict listing every difference', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    await authorizer.clawback(DEAL, issuer, holder, { amount: '10', clawbackId: 'cb-1' });
    const otherIssuer = SDK.Keypair.random();
    ledger.fund(otherIssuer.publicKey());
    const err = (await authorizer
      .clawback({ dealId: 'UF-OTHER', assetCode: 'UFOTHER', displayName: 'x' }, otherIssuer, holder, {
        amount: '10',
        clawbackId: 'cb-1',
      })
      .catch((e: unknown) => e)) as ClawbackIdConflictError;
    expect(err).toBeInstanceOf(ClawbackIdConflictError);
    expect(err.differences.map((d) => d.split(':')[0])).toEqual(['dealId', 'assetCode', 'issuer']);
    expect(err.message).toMatch(/nothing was submitted/);
    expect(ledger.submitted).toHaveLength(1);
  });

  it('a full-balance clawback names the missing trustline vs the zero balance', async () => {
    const { issuer, authorizer } = setup();
    const stranger = SDK.Keypair.random().publicKey();
    const err = (await authorizer.clawback(DEAL, issuer, stranger).catch((e: unknown) => e)) as NothingToClawBackError;
    expect(err).toBeInstanceOf(NothingToClawBackError);
    expect(err).toMatchObject({ stellarAddress: stranger, assetCode: 'UFMADRID1', noTrustline: true });
    expect(err.message).toMatch(/holds no UFMADRID1 trustline/);
  });

  it('an unknown outcome on a full-balance clawback WITHOUT an id is surfaced, and a repeat reads the new balance', async () => {
    const { ledger, issuer, holder, authorizer } = setup();
    ledger.next('timeout-applied');
    await expect(authorizer.clawback(DEAL, issuer, holder)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    // the tx applied: the balance is now zero, so the repeat refuses instead of clawing twice
    await expect(authorizer.clawback(DEAL, issuer, holder)).rejects.toMatchObject({
      name: 'NothingToClawBackError',
      noTrustline: false,
    });
    expect(ledger.clawbacks).toHaveLength(1);
  });
});
