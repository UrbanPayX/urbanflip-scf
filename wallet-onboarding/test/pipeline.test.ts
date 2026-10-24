import * as SDK from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvestorTxPipeline,
  MemoryIdempotencyLedger,
  SubmissionPendingError,
} from '../src/pipeline/investor-tx-pipeline';
import {
  TransactionRejectedError,
  type AccountSnapshot,
  type LedgerReader,
  type Submittable,
  type TransactionSubmitter,
} from '../src/stellar/submitter';
import { DevKeyWalletProvider } from '../src/wallet/dev-key-provider';
import { SignatureRejectedError } from '../src/wallet/provider';
import { lostResponse, rejected } from './fake-horizon';

class FakeSubmitter implements TransactionSubmitter, LedgerReader {
  submitted: Submittable[] = [];
  /** Thrown by the next submit() calls, in order. */
  failures: unknown[] = [];
  /** On-ledger outcomes by tx hash, for settling unknown submissions. */
  outcomes = new Map<string, boolean>();
  submitCalls = 0;
  onSubmit?: () => void;
  private seq = 100;

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, String(this.seq++));
  }

  async loadAccountSnapshot(): Promise<AccountSnapshot | undefined> {
    return undefined;
  }

  async transactionOutcome(hash: string): Promise<boolean | undefined> {
    return this.outcomes.get(hash);
  }

  async submit(tx: Submittable): Promise<{ hash: string }> {
    this.submitCalls++;
    this.onSubmit?.();
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.submitted.push(tx);
    return { hash: 'hash-' + this.submitted.length };
  }
}

function makePipeline(submitter: FakeSubmitter, ledger = new MemoryIdempotencyLedger()) {
  const channel = SDK.Keypair.random();
  const wallets = new DevKeyWalletProvider();
  const pipeline = new InvestorTxPipeline({
    submitter,
    networkPassphrase: SDK.Networks.TESTNET,
    channelKeypair: channel,
    idempotency: ledger,
  });
  return { pipeline, channel, wallets, submitter, ledger };
}

const INVESTOR = 'inv-001';

async function trustlineCase(
  pipeline: InvestorTxPipeline,
  wallets: DevKeyWalletProvider,
  channel: SDK.Keypair,
  investorId = INVESTOR,
  walletSign = (hash: Uint8Array) => wallets.signRaw(investorId, hash),
) {
  const wallet = await wallets.getOrCreateWallet(investorId, 'inv@example.com');
  const asset = new SDK.Asset('UF42', channel.publicKey());
  return pipeline.submitInvestorTransaction({
    idempotencyKey: `trustline:${investorId}`,
    investorAddress: wallet.stellarAddress,
    build: (acct) =>
      new SDK.TransactionBuilder(acct, { fee: '100', networkPassphrase: SDK.Networks.TESTNET })
        .addOperation(SDK.Operation.changeTrust({ source: wallet.stellarAddress, asset, limit: '100' }))
        .setTimeout(30)
        .build(),
    walletSign,
  });
}

describe('InvestorTxPipeline', () => {
  it('submits every investor transaction as a fee-bump paid by the channel account', async () => {
    const { pipeline, wallets, channel, submitter } = makePipeline(new FakeSubmitter());
    const record = await trustlineCase(pipeline, wallets, channel);

    expect(record.status).toBe('submitted');
    expect(submitter.submitted).toHaveLength(1);
    const tx = submitter.submitted[0]!;
    expect(tx).toBeInstanceOf(SDK.FeeBumpTransaction);
    const feeBump = tx as SDK.FeeBumpTransaction;
    // fee source is the channel, not the investor
    expect(feeBump.feeSource).toBe(channel.publicKey());
  });

  it('absorbs duplicate submissions under the same idempotency key', async () => {
    const { pipeline, wallets, channel, submitter } = makePipeline(new FakeSubmitter());
    const first = await trustlineCase(pipeline, wallets, channel);
    const second = await trustlineCase(pipeline, wallets, channel);

    expect(second).toEqual(first);
    expect(submitter.submitted).toHaveLength(1); // nothing rebuilt, nothing resubmitted
  });

  it('verifies the wallet signature BEFORE submitting; bad signature means no submission', async () => {
    const { pipeline, wallets, channel, submitter } = makePipeline(new FakeSubmitter());
    const wallet = await wallets.getOrCreateWallet(INVESTOR, 'inv@example.com');
    const wrongWallet = SDK.Keypair.random();

    await expect(
      pipeline.submitInvestorTransaction({
        idempotencyKey: 'trustline:bad-sig',
        investorAddress: wallet.stellarAddress,
        build: (acct) =>
          new SDK.TransactionBuilder(acct, { fee: '100', networkPassphrase: SDK.Networks.TESTNET })
            .addOperation(SDK.Operation.changeTrust({ asset: SDK.Asset.native(), limit: '1' }))
            .setTimeout(30)
            .build(),
        walletSign: async (hash) =>
          Buffer.from(wrongWallet.sign(Buffer.from(hash))).toString('base64'),
      }),
    ).rejects.toBeInstanceOf(SignatureRejectedError);
    expect(submitter.submitted).toHaveLength(0);
  });

  it('retries exactly once on timeout-classified failures, under the same key', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(new TransactionRejectedError({
      txResultCode: 'tx_timeout',
      cause: new Error('horizon 504'),
    }));
    const { pipeline, wallets, channel, ledger } = makePipeline(submitter);
    const record = await trustlineCase(pipeline, wallets, channel);

    expect(record.status).toBe('submitted');
    expect(record.attempts).toBe(2);
    expect(submitter.submitted).toHaveLength(1); // first attempt failed, retry succeeded
    expect(ledger.get('trustline:' + INVESTOR)?.txHash).toBe(record.txHash);
  });

  it('records terminal failures without retrying', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(new TransactionRejectedError({
      txResultCode: 'tx_failed',
      opResultCodes: ['op_no_trust'],
      cause: new Error('rejected'),
    }));
    const { pipeline, wallets, channel } = makePipeline(submitter);
    const record = await trustlineCase(pipeline, wallets, channel);

    expect(record.status).toBe('failed');
    expect(record.opResultCodes).toEqual(['op_no_trust']);
    expect(record.attempts).toBe(1);
    expect(submitter.submitted).toHaveLength(0);
  });
});

describe('InvestorTxPipeline retries (definitive vs unknown outcomes)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds after a definitive rejection instead of replaying the cached failure', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(rejected('tx_insufficient_balance'));
    const { pipeline, wallets, channel } = makePipeline(submitter);

    expect((await trustlineCase(pipeline, wallets, channel)).status).toBe('failed');
    const retried = await trustlineCase(pipeline, wallets, channel);
    expect(retried.status).toBe('submitted');
    expect(submitter.submitCalls).toBe(2);
    expect(submitter.submitted).toHaveLength(1);
  });

  it('records the hash BEFORE submitting, so a crash mid-submit is settled by hash', async () => {
    const submitter = new FakeSubmitter();
    const { pipeline, wallets, channel, ledger } = makePipeline(submitter);
    let duringSubmit: unknown;
    submitter.onSubmit = () => (duringSubmit = { ...ledger.get('trustline:' + INVESTOR) });

    await trustlineCase(pipeline, wallets, channel);
    expect(duringSubmit).toMatchObject({ status: 'unknown', txHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((duringSubmit as { maxTime: number }).maxTime).toBeGreaterThan(Date.now() / 1000);
  });

  it('settles an unknown outcome by hash: applied means success, nothing re-signed or resubmitted', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(lostResponse(), lostResponse());
    const { pipeline, wallets, channel, ledger } = makePipeline(submitter);

    const unknown = await trustlineCase(pipeline, wallets, channel);
    expect(unknown).toMatchObject({ status: 'unknown', attempts: 2 });
    expect(unknown.txHash).toMatch(/^[a-f0-9]{64}$/);

    submitter.outcomes.set(unknown.txHash!, true); // it had applied after all
    const walletSign = vi.fn(async () => 'never-called');
    const settled = await trustlineCase(pipeline, wallets, channel, INVESTOR, walletSign);
    expect(settled).toMatchObject({ status: 'submitted', txHash: unknown.txHash });
    expect(walletSign).not.toHaveBeenCalled();
    expect(submitter.submitCalls).toBe(2);
    expect(ledger.get('trustline:' + INVESTOR)?.status).toBe('submitted');
  });

  it('unknown and not on the ledger: retry later until maxTime + 30s, then rebuild', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(lostResponse(), lostResponse());
    const { pipeline, wallets, channel } = makePipeline(submitter);
    const unknown = await trustlineCase(pipeline, wallets, channel);

    const pending = trustlineCase(pipeline, wallets, channel);
    await expect(pending).rejects.toBeInstanceOf(SubmissionPendingError);
    await expect(pending).rejects.toMatchObject({ txHash: unknown.txHash, retryAfter: unknown.maxTime! + 30 });
    expect(submitter.submitCalls).toBe(2);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((unknown.maxTime! + 31) * 1000);
    const rebuilt = await trustlineCase(pipeline, wallets, channel);
    expect(rebuilt.status).toBe('submitted');
    expect(submitter.submitCalls).toBe(3);
  });

  it('unknown but failed on-chain: rebuilds right away', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(lostResponse(), lostResponse());
    const { pipeline, wallets, channel } = makePipeline(submitter);
    const unknown = await trustlineCase(pipeline, wallets, channel);

    submitter.outcomes.set(unknown.txHash!, false);
    expect((await trustlineCase(pipeline, wallets, channel)).status).toBe('submitted');
    expect(submitter.submitCalls).toBe(3);
  });

  it('a rejected resubmission after a lost response stays unknown (the first copy may have applied)', async () => {
    const submitter = new FakeSubmitter();
    submitter.failures.push(lostResponse(), rejected('tx_bad_seq'));
    const { pipeline, wallets, channel } = makePipeline(submitter);

    const record = await trustlineCase(pipeline, wallets, channel);
    expect(record).toMatchObject({ status: 'unknown', txResultCode: 'tx_bad_seq', attempts: 2 });
  });

  it('concurrent calls under one key share a single submission', async () => {
    const { pipeline, wallets, channel, submitter } = makePipeline(new FakeSubmitter());
    const [a, b, c] = await Promise.all([
      trustlineCase(pipeline, wallets, channel),
      trustlineCase(pipeline, wallets, channel),
      trustlineCase(pipeline, wallets, channel),
    ]);

    expect(submitter.submitCalls).toBe(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('refuses transactions without a bounded timeout (an unknown outcome could never settle)', async () => {
    const { pipeline, wallets, submitter } = makePipeline(new FakeSubmitter());
    const wallet = await wallets.getOrCreateWallet(INVESTOR, 'inv@example.com');
    const walletSign = vi.fn((hash: Uint8Array) => wallets.signRaw(INVESTOR, hash));

    await expect(
      pipeline.submitInvestorTransaction({
        idempotencyKey: 'trustline:unbounded',
        investorAddress: wallet.stellarAddress,
        build: (acct) =>
          new SDK.TransactionBuilder(acct, { fee: '100', networkPassphrase: SDK.Networks.TESTNET })
            .addOperation(SDK.Operation.changeTrust({ asset: SDK.Asset.native(), limit: '1' }))
            .setTimeout(SDK.TimeoutInfinite)
            .build(),
        walletSign,
      }),
    ).rejects.toThrow(/bounded timeout/);
    expect(walletSign).not.toHaveBeenCalled();
    expect(submitter.submitCalls).toBe(0);
  });

  it('requires a LedgerReader (explicit, or a submitter that implements one)', () => {
    const submitter = { loadAccount: vi.fn(), submit: vi.fn() } as unknown as TransactionSubmitter;
    const deps = {
      submitter,
      networkPassphrase: SDK.Networks.TESTNET,
      channelKeypair: SDK.Keypair.random(),
      idempotency: new MemoryIdempotencyLedger(),
    };
    expect(() => new InvestorTxPipeline(deps)).toThrow(/LedgerReader/);
    const ledger = new FakeSubmitter();
    expect(new InvestorTxPipeline({ ...deps, ledger }).ledger).toBe(ledger);
  });
});

describe('DevKeyWalletProvider (wallet port liveness)', () => {
  it('produces signatures that verify against the wallet address', async () => {
    const wallets = new DevKeyWalletProvider();
    const wallet = await wallets.getOrCreateWallet('inv-9', 'x@y.z');
    const payload = new Uint8Array(32).fill(7);
    const sigB64 = await wallets.signRaw('inv-9', payload);
    const ok = SDK.Keypair.fromPublicKey(wallet.stellarAddress).verify(
      Buffer.from(payload),
      Uint8Array.from(Buffer.from(sigB64, 'base64')),
    );
    expect(ok).toBe(true);
  });

  it('regenerates the same wallet for the same investor', async () => {
    const wallets = new DevKeyWalletProvider();
    const a = await wallets.getOrCreateWallet('inv-1', 'a@b.c');
    const b = await wallets.getOrCreateWallet('inv-1', 'a@b.c');
    expect(a.stellarAddress).toBe(b.stellarAddress);
  });
});
