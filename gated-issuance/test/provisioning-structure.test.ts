import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { assertProvisioningInvariant, IssuerProvisioner } from '../src/issuance/issuer-provisioner';
import type { LedgerLookup, TransactionOutcome, TransactionSubmitter } from '../src/stellar/tx-submitter';
import type { DealInfo, IssuerFlags } from '../src/types';

class FakeSubmitter implements TransactionSubmitter, LedgerLookup {
  readonly submitted: SDK.Transaction[] = [];

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, '123');
  }

  async submit(tx: SDK.Transaction): Promise<{ hash: string }> {
    this.submitted.push(tx);
    return { hash: 'fake-hash-' + (this.submitted.length - 1) };
  }

  async transactionOutcome(): Promise<TransactionOutcome> {
    return 'NOT_FOUND';
  }

  async accountFlags(): Promise<IssuerFlags | undefined> {
    return undefined;
  }
}

function makeProvisioner() {
  const submitter = new FakeSubmitter();
  const audit = new MemoryAuditLog();
  const funder = SDK.Keypair.random();
  const provisioner = new IssuerProvisioner({
    submitter,
    networkPassphrase: SDK.Networks.TESTNET,
    funderKeypair: funder,
    homeDomain: 'urbanflip.io',
    audit,
  });
  return { provisioner, submitter, audit, funder };
}

const DEAL: DealInfo = { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42' };

describe('IssuerProvisioner (offline envelope structure)', () => {
  it('creates the issuer and sets all three auth flags in one envelope, flags before any trustline', async () => {
    const { provisioner, submitter } = makeProvisioner();
    const result = await provisioner.provision(DEAL);

    expect(submitter.submitted).toHaveLength(1);
    const tx = submitter.submitted[0]!;

    // op 0: account creation funded by the operations account
    expect(tx.operations[0]!.type).toBe('createAccount');
    // op 1: setOptions SOURCED FROM THE ISSUER, so flags land on the issuer
    const setOptions = tx.operations[1] as SDK.Operation.SetOptions;
    expect(setOptions.type).toBe('setOptions');
    expect(setOptions.source).toBe(result.issuerPublicKey);
    expect(setOptions.setFlags).toBe(
      SDK.AuthRequiredFlag | SDK.AuthRevocableFlag | SDK.AuthClawbackEnabledFlag,
    );
    expect(setOptions.homeDomain).toBe('urbanflip.io');

    // funded by the funder, flags authorized by the issuer: both signatures present
    expect(tx.signatures).toHaveLength(2);

    // the invariant is enforced by the service itself, not just by tests
    expect(() => assertProvisioningInvariant(tx)).not.toThrow();
  });

  it('never emits trustline or payment operations in the provisioning envelope', async () => {
    const { provisioner, submitter } = makeProvisioner();
    await provisioner.provision(DEAL);
    const ops = submitter.submitted[0]!.operations.map((op) => op.type);
    expect(ops.every((op) => !op.includes('Trust') && !op.includes('payment') && op !== 'clawback')).toBe(true);
  });

  it('derives a valid asset code and reports the flags it set', async () => {
    const { provisioner } = makeProvisioner();
    const result = await provisioner.provision(DEAL);
    expect(result.asset.code).toBe('UF0042');
    expect(result.asset.issuer).toBe(result.issuerPublicKey);
    expect(result.flags).toEqual({ authRequired: true, authRevocable: true, authClawbackEnabled: true });
  });

  it('refuses an invalid explicit asset code before anything is submitted', async () => {
    const { provisioner, submitter } = makeProvisioner();
    await expect(
      provisioner.provision({ ...DEAL, assetCode: 'TOOLONGCODE13' }),
    ).rejects.toThrow(/invalid asset code/);
    expect(submitter.submitted).toHaveLength(0);
  });

  it('audits the provisioning event', async () => {
    const { provisioner, audit } = makeProvisioner();
    await provisioner.provision(DEAL);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ kind: 'ISSUER_PROVISIONED', dealId: 'UF-0042' });
  });

  it('invariant check rejects envelopes that forgot the flags or smuggle a payment', () => {
    const funder = SDK.Keypair.random();
    // Whatever the Operation.* factories return is what addOperation accepts.
    const build = (ops: ReturnType<typeof SDK.Operation.clawback>[]) => {
      const builder = new SDK.TransactionBuilder(new SDK.Account(funder.publicKey(), '0'), {
        networkPassphrase: SDK.Networks.TESTNET,
        fee: '100',
      });
      for (const op of ops) builder.addOperation(op);
      return builder.setTimeout(30).build();
    };

    const missingFlags = build([
      SDK.Operation.createAccount({ destination: SDK.Keypair.random().publicKey(), startingBalance: '2.5' }),
    ]);
    expect(() => assertProvisioningInvariant(missingFlags)).toThrow(/AUTH_REQUIRED/);

    const withPayment = build([
      SDK.Operation.createAccount({ destination: SDK.Keypair.random().publicKey(), startingBalance: '2.5' }),
      SDK.Operation.setOptions({
        source: SDK.Keypair.random().publicKey(),
        setFlags: SDK.AuthRequiredFlag | SDK.AuthRevocableFlag | SDK.AuthClawbackEnabledFlag,
      }),
      SDK.Operation.payment({
        destination: SDK.Keypair.random().publicKey(),
        asset: SDK.Asset.native(),
        amount: '1',
      }),
    ]);
    expect(() => assertProvisioningInvariant(withPayment)).toThrow(/must not contain/);
  });
});
