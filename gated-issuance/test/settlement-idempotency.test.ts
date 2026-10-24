import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import type { ComplianceGate } from '../src/gate/compliance-gate';
import { OperationInProgressError } from '../src/issuance/in-flight';
import {
  SettlementPendingError,
  SubscriptionSettlementService,
  type SettleArgs,
  type TrustlineLookup,
} from '../src/issuance/subscription-settlement';
import { TransactionOutcomeUnknownError, TransactionRejectedError, txHashHex } from '../src/stellar/tx-submitter';
import { JsonFileSettlementStore, MemorySettlementStore, type SettlementStore } from '../src/store/settlement-store';
import { FakeLedger } from './fake-ledger';

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(store: SettlementStore = new MemorySettlementStore()) {
  const ledger = new FakeLedger();
  const issuerKeypair = SDK.Keypair.random();
  ledger.fund(issuerKeypair.publicKey());
  const audit = new MemoryAuditLog();
  const gate: ComplianceGate = {
    providerName: 'fake-gate',
    evaluate: vi.fn(async () => ({ status: 'approved' as const, provider: 'fake-gate', evaluatedAt: 'now' })),
  };
  const trustlineLookup: TrustlineLookup = { state: vi.fn(async () => 'READY' as const) };
  const make = (s: SettlementStore = store) =>
    new SubscriptionSettlementService({
      gate,
      submitter: ledger,
      networkPassphrase: SDK.Networks.TESTNET,
      trustlineLookup,
      audit,
      store: s,
    });
  const args: SettleArgs = {
    deal: { dealId: 'UF-MADRID-1', assetCode: 'UFMADRID1', displayName: 'Urbanflip Madrid 1' },
    issuerKeypair,
    investor: { investorId: 'inv-001', stellarAddress: SDK.Keypair.random().publicKey() },
    principal: '7500.00',
    settlementId: 'settle-2026-0042-1',
    bankRef: 'TRF-889912',
  };
  return { ledger, store, audit, gate, args, service: make(), make };
}

function settledEvents(audit: MemoryAuditLog) {
  return audit.events.filter((e) => e.kind === 'SUBSCRIPTION_SETTLED');
}

describe('SubscriptionSettlementService crash/timeout safety (units minted once)', () => {
  it('records the issuance PENDING with its hash and maxTime before submitting', async () => {
    const { ledger, store, service, args } = setup();
    const release = ledger.pause();
    const running = service.settle(args);
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    const tx = ledger.submitted[0]!;
    const pending = await store.getPending(args.settlementId);
    expect(pending?.record.txHash).toBe(txHashHex(tx));
    expect(pending?.maxTime).toBe(Number(tx.timeBounds!.maxTime));
    expect(pending?.maxTime).toBeGreaterThan(0);

    release();
    const record = await running;
    expect(record.txHash).toBe(txHashHex(tx));
    expect(await store.getPending(args.settlementId)).toBeUndefined();
    expect(await store.getSettled(args.settlementId)).toEqual(record);
    expect(ledger.payments).toEqual([expect.objectContaining({ code: 'UFMADRID1', amount: '7500.0000000' })]);
  });

  it('does not mint twice after a timeout where the tx actually applied', async () => {
    const { ledger, service, args, audit, gate } = setup();
    ledger.next('timeout-applied');
    await expect(service.settle(args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    expect(ledger.payments).toHaveLength(1);

    const record = await service.settle(args);
    expect(record.txHash).toBe(txHashHex(ledger.submitted[0]!));
    expect(ledger.submitted).toHaveLength(1); // resolved by hash, not resubmitted
    expect(ledger.payments).toHaveLength(1);
    expect(gate.evaluate).toHaveBeenCalledTimes(1);
    expect(settledEvents(audit)).toEqual([expect.objectContaining({ resolvedByHash: true, txHash: record.txHash })]);

    await expect(service.settle(args)).resolves.toEqual(record);
    expect(ledger.submitted).toHaveLength(1);
  });

  it('rebuilds a lost issuance only once its maxTime (+30s grace) has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'));
    const { ledger, service, args } = setup();
    ledger.next('timeout-lost');
    await expect(service.settle(args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const lost = ledger.submitted[0]!;
    const maxTime = Number(lost.timeBounds!.maxTime);

    // not on the ledger, but it still could land: refuse to rebuild
    await expect(service.settle(args)).rejects.toBeInstanceOf(SettlementPendingError);
    vi.setSystemTime((maxTime + 30) * 1000);
    await expect(service.settle(args)).rejects.toMatchObject({
      name: 'SettlementPendingError',
      txHash: txHashHex(lost),
      retryAfter: maxTime + 30,
    });
    expect(ledger.submitted).toHaveLength(1);

    vi.setSystemTime((maxTime + 31) * 1000);
    const record = await service.settle(args);
    expect(ledger.submitted).toHaveLength(2);
    expect(record.txHash).toBe(txHashHex(ledger.submitted[1]!));
    // the expired tx can never apply any more
    expect(() => ledger.land(txHashHex(lost))).toThrow(TransactionRejectedError);
    expect(ledger.payments).toHaveLength(1);
  });

  it('clears and rebuilds at once when the earlier tx failed on-chain', async () => {
    const { ledger, service, args } = setup();
    ledger.next('timeout-failed');
    await expect(service.settle(args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);

    const record = await service.settle(args);
    expect(ledger.submitted).toHaveLength(2);
    expect(record.txHash).toBe(txHashHex(ledger.submitted[1]!));
    expect(ledger.payments).toHaveLength(1);
  });

  it('a definitive rejection clears the pending record, so a retry rebuilds immediately', async () => {
    const { ledger, store, service, args } = setup();
    ledger.next('reject');
    await expect(service.settle(args)).rejects.toBeInstanceOf(TransactionRejectedError);
    expect(await store.getPending(args.settlementId)).toBeUndefined();

    await service.settle(args);
    expect(ledger.submitted).toHaveLength(2);
    expect(ledger.payments).toHaveLength(1);
  });

  it('concurrent settle() calls for the same settlement mint once', async () => {
    const { ledger, service, args, make } = setup();
    const release = ledger.pause();
    const first = service.settle(args);
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    await expect(service.settle(args)).rejects.toBeInstanceOf(OperationInProgressError);
    // another service instance over the same store is refused too
    await expect(make().settle(args)).rejects.toBeInstanceOf(OperationInProgressError);

    release();
    const record = await first;
    await expect(service.settle(args)).resolves.toEqual(record);
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.payments).toHaveLength(1);
  });

  it('after a restart, the JSON-file store resolves the pending issuance by hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settlements-'));
    dirs.push(dir);
    const path = join(dir, 'settlements.json');
    const { ledger, args, make, store } = setup(new JsonFileSettlementStore(path));
    ledger.next('timeout-applied');
    await expect(make().settle(args)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    await store.close!(); // "crash": the old instance releases the state directory

    const restarted = new JsonFileSettlementStore(path);
    const record = await make(restarted).settle(args);
    expect(record.txHash).toBe(txHashHex(ledger.submitted[0]!));
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.payments).toHaveLength(1);
    await restarted.close();
    const reloaded = new JsonFileSettlementStore(path);
    expect(await reloaded.getSettled(args.settlementId)).toEqual(record);
    await reloaded.close();
  });
});
