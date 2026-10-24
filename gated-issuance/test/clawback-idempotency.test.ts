import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import type { ComplianceGate } from '../src/gate/compliance-gate';
import { OperationInProgressError } from '../src/issuance/in-flight';
import {
  ClawbackIdConflictError,
  ClawbackIdRequiredError,
  ClawbackPendingError,
  NothingToClawBackError,
  TrustlineAuthorizer,
} from '../src/issuance/trustline-authorizer';
import { TransactionOutcomeUnknownError, TransactionRejectedError, txHashHex } from '../src/stellar/tx-submitter';
import { JsonFileClawbackStore, MemoryClawbackStore, type ClawbackStore } from '../src/store/clawback-store';
import type { DealInfo } from '../src/types';
import { FakeLedger } from './fake-ledger';

const DEAL: DealInfo = { dealId: 'UF-MADRID-1', assetCode: 'UFMADRID1', displayName: 'Urbanflip Madrid 1' };
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(store: ClawbackStore = new MemoryClawbackStore()) {
  const ledger = new FakeLedger();
  const issuerKeypair = SDK.Keypair.random();
  ledger.fund(issuerKeypair.publicKey());
  const holder = SDK.Keypair.random().publicKey();
  const asset = { code: 'UFMADRID1', issuer: issuerKeypair.publicKey() };
  ledger.credit(holder, asset, '100');
  const audit = new MemoryAuditLog();
  const gate: ComplianceGate = { providerName: 'unused', evaluate: vi.fn() };
  const make = (s: ClawbackStore = store) =>
    new TrustlineAuthorizer({ gate, submitter: ledger, networkPassphrase: SDK.Networks.TESTNET, audit, clawbackStore: s });
  const balance = () => ledger.assetBalance(holder, asset);
  return { ledger, store, audit, issuerKeypair, holder, asset, balance, authorizer: make(), make };
}

function clawbackEvents(audit: MemoryAuditLog) {
  return audit.events.filter((e) => e.kind === 'CLAWBACK');
}

describe('TrustlineAuthorizer.clawback idempotency (clawed back once per clawbackId)', () => {
  it('records the clawback PENDING with its hash and maxTime before submitting', async () => {
    const { ledger, store, authorizer, issuerKeypair, holder, balance } = setup();
    const release = ledger.pause();
    const running = authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' });
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    const tx = ledger.submitted[0]!;
    const pending = await store.getPending('cb-1');
    expect(pending).toEqual({
      record: {
        clawbackId: 'cb-1',
        dealId: DEAL.dealId,
        assetCode: 'UFMADRID1',
        issuer: issuerKeypair.publicKey(),
        stellarAddress: holder,
        requestedAmount: '40.0000000',
        amount: '40.0000000',
        txHash: txHashHex(tx),
      },
      maxTime: Number(tx.timeBounds!.maxTime),
    });

    release();
    const result = await running;
    expect(result).toMatchObject({ mode: 'clawback', clawbackId: 'cb-1', amount: '40.0000000', txHash: txHashHex(tx) });
    expect(result.resolvedByHash).toBeUndefined();
    expect(await store.getPending('cb-1')).toBeUndefined();
    expect(await store.getCompleted('cb-1')).toMatchObject({ txHash: txHashHex(tx) });
    expect(await balance()).toBe('60.0000000');
  });

  it('a retry after a timeout where the tx applied claws back once and returns the recorded result', async () => {
    const { ledger, authorizer, issuerKeypair, holder, audit, balance } = setup();
    const args = [DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }] as const;
    ledger.next('timeout-applied');
    await expect(authorizer.clawback(...args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    expect(ledger.clawbacks).toHaveLength(1);

    const result = await authorizer.clawback(...args);
    expect(result).toMatchObject({ txHash: txHashHex(ledger.submitted[0]!), amount: '40.0000000', resolvedByHash: true });
    expect(ledger.submitted).toHaveLength(1); // resolved by hash, not resubmitted
    expect(ledger.lookups).toEqual([result.txHash]);
    expect(ledger.clawbacks).toHaveLength(1);
    expect(await balance()).toBe('60.0000000');
    expect(clawbackEvents(audit)).toEqual([
      expect.objectContaining({ clawbackId: 'cb-1', txHash: result.txHash, amount: '40.0000000', resolvedByHash: true }),
    ]);

    // the recorded result, again: no lookup, no submission, no second audit event
    await expect(authorizer.clawback(...args)).resolves.toEqual(result);
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.lookups).toHaveLength(1);
    expect(clawbackEvents(audit)).toHaveLength(1);
  });

  it('a lost clawback is rebuilt only once its maxTime (+30s grace) has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'));
    const { ledger, authorizer, issuerKeypair, holder, balance } = setup();
    const args = [DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }] as const;
    ledger.next('timeout-lost');
    await expect(authorizer.clawback(...args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const lost = ledger.submitted[0]!;
    const maxTime = Number(lost.timeBounds!.maxTime);

    // not on the ledger, but it still could land: refuse to rebuild
    await expect(authorizer.clawback(...args)).rejects.toBeInstanceOf(ClawbackPendingError);
    vi.setSystemTime((maxTime + 30) * 1000);
    await expect(authorizer.clawback(...args)).rejects.toMatchObject({
      name: 'ClawbackPendingError',
      clawbackId: 'cb-1',
      txHash: txHashHex(lost),
      retryAfter: maxTime + 30,
    });
    expect(ledger.submitted).toHaveLength(1);

    vi.setSystemTime((maxTime + 31) * 1000);
    const result = await authorizer.clawback(...args);
    expect(ledger.submitted).toHaveLength(2);
    expect(result.txHash).toBe(txHashHex(ledger.submitted[1]!));
    expect(result.resolvedByHash).toBeUndefined();
    // the expired tx can never apply any more
    expect(() => ledger.land(txHashHex(lost))).toThrow(TransactionRejectedError);
    expect(ledger.clawbacks).toHaveLength(1);
    expect(await balance()).toBe('60.0000000');
  });

  it('rebuilds at once when the earlier tx failed on-chain; a definitive rejection clears pending', async () => {
    const { ledger, store, authorizer, issuerKeypair, holder, balance } = setup();
    ledger.next('timeout-failed');
    const args = [DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }] as const;
    await expect(authorizer.clawback(...args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const result = await authorizer.clawback(...args);
    expect(ledger.submitted).toHaveLength(2);
    expect(result.txHash).toBe(txHashHex(ledger.submitted[1]!));

    ledger.next('reject');
    const other = [DEAL, issuerKeypair, holder, { amount: '10', clawbackId: 'cb-2' }] as const;
    await expect(authorizer.clawback(...other)).rejects.toBeInstanceOf(TransactionRejectedError);
    expect(await store.getPending('cb-2')).toBeUndefined();
    await authorizer.clawback(...other);
    expect(ledger.clawbacks.map((c) => c.amount)).toEqual(['40.0000000', '10.0000000']);
    expect(await balance()).toBe('50.0000000');
  });

  it('refuses the same clawbackId with different parameters, before and after completion', async () => {
    const { ledger, authorizer, issuerKeypair, holder } = setup();
    ledger.next('timeout-lost');
    await expect(
      authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }),
    ).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);

    // pending
    await expect(
      authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '41', clawbackId: 'cb-1' }),
    ).rejects.toMatchObject({ name: 'ClawbackIdConflictError', differences: [expect.stringMatching(/^amount/)] });
    ledger.land(txHashHex(ledger.submitted[0]!));

    // completed (same amount, written differently, is the same clawback)
    const done = await authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '40.00', clawbackId: 'cb-1' });
    expect(done.resolvedByHash).toBe(true);
    const otherHolder = SDK.Keypair.random().publicKey();
    await expect(
      authorizer.clawback(DEAL, issuerKeypair, otherHolder, { amount: '40', clawbackId: 'cb-1' }),
    ).rejects.toBeInstanceOf(ClawbackIdConflictError);
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, { clawbackId: 'cb-1' })).rejects.toThrow(
      /amount: recorded 40.0000000, requested full balance/,
    );
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.clawbacks).toHaveLength(1);
  });

  it('refuses a concurrent clawback with the same id, also from another authorizer over the same store', async () => {
    const { ledger, authorizer, make, issuerKeypair, holder, balance } = setup();
    const args = [DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }] as const;
    const release = ledger.pause();
    const first = authorizer.clawback(...args);
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    await expect(authorizer.clawback(...args)).rejects.toBeInstanceOf(OperationInProgressError);
    await expect(make().clawback(...args)).rejects.toBeInstanceOf(OperationInProgressError);

    release();
    const result = await first;
    await expect(authorizer.clawback(...args)).resolves.toEqual(result);
    expect(ledger.submitted).toHaveLength(1);
    expect(await balance()).toBe('60.0000000');
  });

  it('refuses an explicit amount without a clawbackId, submitting nothing', async () => {
    const { ledger, authorizer, issuerKeypair, holder, audit } = setup();
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '40' })).rejects.toBeInstanceOf(
      ClawbackIdRequiredError,
    );
    // the pre-idempotency call shape, from untyped callers
    const legacy = authorizer.clawback as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(legacy.call(authorizer, DEAL, issuerKeypair, holder, '40')).rejects.toBeInstanceOf(
      ClawbackIdRequiredError,
    );
    // the positional form with an id is supported
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, '40', 'cb-1')).resolves.toMatchObject({
      clawbackId: 'cb-1',
    });
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, { amount: '0', clawbackId: 'cb-0' })).rejects.toThrow(
      /must be positive/,
    );
    expect(ledger.submitted).toHaveLength(1);
    expect(clawbackEvents(audit)).toHaveLength(1);
  });

  it('full-balance mode claws back everything; a repeat finds nothing left and refuses cleanly', async () => {
    const { ledger, authorizer, issuerKeypair, holder, audit, balance } = setup();
    const result = await authorizer.clawback(DEAL, issuerKeypair, holder);
    expect(result).toMatchObject({ amount: '100.0000000', txHash: txHashHex(ledger.submitted[0]!) });
    expect(result.clawbackId).toBeUndefined();
    expect(await balance()).toBe('0.0000000');
    expect(clawbackEvents(audit)).toEqual([expect.objectContaining({ amount: '100.0000000', fullBalance: true })]);

    // no id: the repeat reads a zero balance and never submits a zero clawback
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder)).rejects.toMatchObject({
      name: 'NothingToClawBackError',
      noTrustline: false,
    });
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, { clawbackId: 'cb-full' })).rejects.toBeInstanceOf(
      NothingToClawBackError,
    );
    const stranger = SDK.Keypair.random().publicKey();
    await expect(authorizer.clawback(DEAL, issuerKeypair, stranger)).rejects.toMatchObject({ noTrustline: true });
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.clawbacks).toHaveLength(1);
  });

  it('full-balance mode with an id resolves a timed-out clawback by hash like any other', async () => {
    const { ledger, authorizer, issuerKeypair, holder, balance } = setup();
    ledger.next('timeout-applied');
    await expect(authorizer.clawback(DEAL, issuerKeypair, holder, { clawbackId: 'cb-full' })).rejects.toBeInstanceOf(
      TransactionOutcomeUnknownError,
    );
    const result = await authorizer.clawback(DEAL, issuerKeypair, holder, { clawbackId: 'cb-full' });
    expect(result).toMatchObject({ amount: '100.0000000', resolvedByHash: true, clawbackId: 'cb-full' });
    expect(ledger.submitted).toHaveLength(1);
    expect(await balance()).toBe('0.0000000');
  });

  it('after a restart, the JSON-file store resolves the pending clawback by hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawbacks-'));
    dirs.push(dir);
    const path = join(dir, 'clawbacks.json');
    const { ledger, make, store, issuerKeypair, holder, balance } = setup(new JsonFileClawbackStore(path));
    const args = [DEAL, issuerKeypair, holder, { amount: '40', clawbackId: 'cb-1' }] as const;
    ledger.next('timeout-applied');
    await expect(make().clawback(...args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    await store.close!();

    const restarted = new JsonFileClawbackStore(path);
    const result = await make(restarted).clawback(...args);
    expect(result).toMatchObject({ txHash: txHashHex(ledger.submitted[0]!), resolvedByHash: true });
    expect(ledger.submitted).toHaveLength(1);
    expect(await balance()).toBe('60.0000000');
    await restarted.close();

    const reloaded = new JsonFileClawbackStore(path);
    await expect(make(reloaded).clawback(...args)).resolves.toEqual(result);
    await reloaded.close();
  });
});
