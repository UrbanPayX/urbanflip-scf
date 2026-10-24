import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { OperationInProgressError } from '../src/issuance/in-flight';
import { IssuerProvisioner } from '../src/issuance/issuer-provisioner';
import { TransactionOutcomeUnknownError, TransactionRejectedError, txHashHex } from '../src/stellar/tx-submitter';
import { JsonFileIssuerStore, MemoryIssuerStore, type IssuerStore } from '../src/store/issuer-store';
import type { DealInfo } from '../src/types';
import { FakeLedger } from './fake-ledger';

const DEAL: DealInfo = { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' };
const KEY = Buffer.alloc(32, 7);
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(store: IssuerStore = new MemoryIssuerStore(), ledger = new FakeLedger()) {
  const funder = SDK.Keypair.random();
  ledger.fund(funder.publicKey());
  const audit = new MemoryAuditLog();
  const make = (s: IssuerStore = store) =>
    new IssuerProvisioner({
      submitter: ledger,
      networkPassphrase: SDK.Networks.TESTNET,
      funderKeypair: funder,
      homeDomain: 'urbanflip.io',
      audit,
      store: s,
    });
  return { ledger, store, audit, provisioner: make(), make };
}

function createdIssuer(tx: SDK.Transaction): string {
  return (tx.operations[0] as SDK.Operation.CreateAccount).destination;
}

describe('IssuerProvisioner idempotency (one issuer per deal, key never lost)', () => {
  it('a second run for the same deal returns the same issuer and submits nothing', async () => {
    const { ledger, provisioner, audit } = setup();
    const first = await provisioner.provision(DEAL);
    const second = await provisioner.provision(DEAL);

    expect(second).toEqual(first);
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.issuers()).toEqual([first.issuerPublicKey]);
    expect(audit.events.map((e) => e.kind)).toEqual(['ISSUER_PROVISIONED']);
    expect(first.provisioningTxHash).toBe(txHashHex(ledger.submitted[0]!));
    // the recorded code is pinned, so authorize/settle address exactly this asset
    expect(first.deal.assetCode).toBe('UF0042');
  });

  it('records the issuer key PENDING before the creation tx is submitted', async () => {
    const { ledger, store, provisioner } = setup();
    const release = ledger.pause();
    const running = provisioner.provision(DEAL);
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    const pending = await store.get(DEAL.dealId);
    expect(pending?.status).toBe('PENDING');
    expect(pending?.issuerPublicKey).toBe(createdIssuer(ledger.submitted[0]!));
    expect(SDK.Keypair.fromSecret(pending!.issuerSecret).publicKey()).toBe(pending!.issuerPublicKey);
    expect(pending?.provisioningTxHash).toBe(txHashHex(ledger.submitted[0]!));

    release();
    await running;
    expect((await store.get(DEAL.dealId))?.status).toBe('ACTIVE');
  });

  it('adopts the issuer after a lost response (timeout after the tx applied)', async () => {
    const { ledger, store, provisioner, audit } = setup();
    ledger.next('timeout-applied');
    await expect(provisioner.provision(DEAL)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const pending = await store.get(DEAL.dealId);
    expect(pending?.status).toBe('PENDING');

    const adopted = await provisioner.provision(DEAL);
    expect(ledger.submitted).toHaveLength(1); // nothing resubmitted
    expect(ledger.issuers()).toEqual([pending!.issuerPublicKey]);
    expect(adopted.issuerPublicKey).toBe(pending!.issuerPublicKey);
    expect(adopted.issuerSecret).toBe(pending!.issuerSecret);
    expect(adopted.provisioningTxHash).toBe(txHashHex(ledger.submitted[0]!));
    expect((await store.get(DEAL.dealId))?.status).toBe('ACTIVE');
    expect(audit.events).toEqual([expect.objectContaining({ kind: 'ISSUER_PROVISIONED', adoptedExisting: true })]);
  });

  it('resubmits with the SAME keypair when the first attempt never applied', async () => {
    const { ledger, provisioner } = setup();
    ledger.next('timeout-lost');
    await expect(provisioner.provision(DEAL)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    expect(ledger.issuers()).toHaveLength(0);

    const result = await provisioner.provision(DEAL);
    expect(ledger.submitted).toHaveLength(2);
    expect(createdIssuer(ledger.submitted[1]!)).toBe(createdIssuer(ledger.submitted[0]!));
    expect(ledger.issuers()).toEqual([result.issuerPublicKey]);
  });

  it('keeps the key after a definitive rejection and retries with it', async () => {
    const { ledger, store, provisioner } = setup();
    ledger.next('reject');
    await expect(provisioner.provision(DEAL)).rejects.toBeInstanceOf(TransactionRejectedError);
    expect((await store.get(DEAL.dealId))?.status).toBe('PENDING');

    const result = await provisioner.provision(DEAL);
    expect(createdIssuer(ledger.submitted[1]!)).toBe(createdIssuer(ledger.submitted[0]!));
    expect(ledger.issuers()).toEqual([result.issuerPublicKey]);
  });

  it('keeps the hash of a lost attempt that lands late while its retry is rejected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'));
    const { ledger, provisioner } = setup();
    ledger.next('timeout-lost');
    await expect(provisioner.provision(DEAL)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const lostHash = txHashHex(ledger.submitted[0]!);

    // A few seconds later the retry is a different tx (new time bounds, same funder
    // sequence), and the lost one lands just before the retry reaches the ledger.
    vi.setSystemTime(new Date('2026-10-23T10:00:05Z'));
    ledger.onSubmit = () => {
      ledger.onSubmit = undefined;
      ledger.land(lostHash);
    };
    await expect(provisioner.provision(DEAL)).rejects.toMatchObject({ failure: { txResultCode: 'tx_bad_seq' } });

    expect(txHashHex(ledger.submitted[1]!)).not.toBe(lostHash);

    const adopted = await provisioner.provision(DEAL);
    expect(adopted.provisioningTxHash).toBe(lostHash);
    expect(ledger.submitted).toHaveLength(2);
    expect(ledger.issuers()).toEqual([adopted.issuerPublicKey]);
  });

  it('after a restart, the JSON-file store adopts the issuer instead of creating a second one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'issuers-'));
    dirs.push(dir);
    const path = join(dir, 'issuers.json');
    const { ledger, make, store } = setup(new JsonFileIssuerStore(path, KEY));
    ledger.next('timeout-applied');
    await expect(make().provision(DEAL)).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    const createdBeforeCrash = createdIssuer(ledger.submitted[0]!);
    await store.close!(); // the old instance releases the state directory

    // "restart": a fresh store loaded from disk, a fresh provisioner
    const reopened = new JsonFileIssuerStore(path, KEY);
    const restarted = await make(reopened).provision(DEAL);
    await reopened.close();
    expect(restarted.issuerPublicKey).toBe(createdBeforeCrash);
    expect(SDK.Keypair.fromSecret(restarted.issuerSecret).publicKey()).toBe(createdBeforeCrash);
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.issuers()).toEqual([createdBeforeCrash]);
  });

  it('refuses a concurrent provisioning of the same deal while one is in flight', async () => {
    const { ledger, provisioner, make } = setup();
    const release = ledger.pause();
    const running = provisioner.provision(DEAL);
    await vi.waitFor(() => expect(ledger.submitted).toHaveLength(1));

    await expect(provisioner.provision(DEAL)).rejects.toBeInstanceOf(OperationInProgressError);
    // a second provisioner over the same store shares the guard
    await expect(make().provision(DEAL)).rejects.toBeInstanceOf(OperationInProgressError);

    release();
    const result = await running;
    expect(ledger.submitted).toHaveLength(1);
    expect(ledger.issuers()).toEqual([result.issuerPublicKey]);
  });

  it('refuses to adopt an account that exists without the auth flags', async () => {
    const issuer = SDK.Keypair.random();
    const store = new MemoryIssuerStore();
    await store.put({
      dealId: DEAL.dealId,
      status: 'PENDING',
      assetCode: 'UF0042',
      issuerPublicKey: issuer.publicKey(),
      issuerSecret: issuer.secret(),
      provisioningTxHash: 'ab'.repeat(32),
    });
    const { ledger, provisioner } = setup(store);
    ledger.fund(issuer.publicKey()); // exists, no flags

    await expect(provisioner.provision(DEAL)).rejects.toThrow(/manual review/);
    expect(ledger.submitted).toHaveLength(0);
  });

  it('refuses an explicit asset code that differs from the recorded one', async () => {
    const { ledger, provisioner } = setup();
    await provisioner.provision(DEAL);
    await expect(provisioner.provision({ ...DEAL, assetCode: 'UFOTHER' })).rejects.toThrow(/already has an issuer/);
    expect(ledger.submitted).toHaveLength(1);
  });
});
