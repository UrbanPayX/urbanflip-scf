import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { InvestorTxPipeline, MemoryIdempotencyLedger } from '../src/pipeline/investor-tx-pipeline';
import { SponsorService } from '../src/sponsorship/sponsor-service';
import type {
  AccountSnapshot,
  LedgerReader,
  Submittable,
  TransactionSubmitter,
} from '../src/stellar/submitter';
import { DevKeyWalletProvider } from '../src/wallet/dev-key-provider';

class CapturingSubmitter implements TransactionSubmitter, LedgerReader {
  readonly submitted: { tx: Submittable; inner: SDK.Transaction }[] = [];

  async loadAccount(address: string): Promise<SDK.Account> {
    return new SDK.Account(address, '42');
  }

  // Envelope shapes only: the chain never shows an account, so every step is built.
  async loadAccountSnapshot(): Promise<AccountSnapshot | undefined> {
    return undefined;
  }

  async transactionOutcome(): Promise<boolean | undefined> {
    return undefined;
  }

  async submit(tx: Submittable): Promise<{ hash: string }> {
    const inner =
      tx instanceof SDK.FeeBumpTransaction
        ? (tx.innerTransaction as unknown as SDK.Transaction)
        : (tx as SDK.Transaction);
    this.submitted.push({ tx, inner });
    return { hash: 'h-' + this.submitted.length };
  }
}

function makeService() {
  const submitter = new CapturingSubmitter();
  const channel = SDK.Keypair.random();
  const wallets = new DevKeyWalletProvider();
  const sponsor = new SponsorService({
    pipeline: new InvestorTxPipeline({
      submitter,
      networkPassphrase: SDK.Networks.TESTNET,
      channelKeypair: channel,
      idempotency: new MemoryIdempotencyLedger(),
    }),
    walletProvider: wallets,
    networkPassphrase: SDK.Networks.TESTNET,
  });
  return { sponsor, submitter, channel, wallets };
}

describe('SponsorService envelope structure (CAP-33 invariants)', () => {
  it('creates accounts with 0 XLM inside a full begin/create/end sponsorship sandwich', async () => {
    const { sponsor, submitter, channel } = makeService();
    await sponsor.provisionInvestorAccount('inv-1', 'inv@example.com');

    const { tx, inner } = submitter.submitted[0]!;
    expect(tx).toBeInstanceOf(SDK.FeeBumpTransaction);
    expect(inner.signatures).toHaveLength(2); // channel + investor raw signature

    const ops = inner.operations;
    expect(ops[0]!.type).toBe('beginSponsoringFutureReserves');
    expect(ops[1]!.type).toBe('createAccount');
    expect((ops[1] as SDK.Operation.CreateAccount).startingBalance).toBe('0.0000000');
    expect(ops[2]!.type).toBe('endSponsoringFutureReserves');
    // end op sourced from the SPONSORED account (CAP-33 requirement, proven on testnet)
    expect(ops[2]!.source).toBe((ops[0] as SDK.Operation.BeginSponsoringFutureReserves).sponsoredId);
    expect(inner.source).toBe(channel.publicKey());
  });

  it('opens trustlines with the changeTrust sourced from the investor', async () => {
    const { sponsor, submitter, channel } = makeService();
    const account = await sponsor.provisionInvestorAccount('inv-2', 'inv@example.com');
    await sponsor.openSponsoredTrustline('inv-2', 'inv@example.com', {
      code: 'UF42',
      issuer: channel.publicKey(),
    });

    const { inner } = submitter.submitted[1]!;
    const ops = inner.operations;
    expect(ops.map((op) => op.type)).toEqual([
      'beginSponsoringFutureReserves',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect(ops[1]!.source).toBe(account.stellarAddress);
    const changeTrust = ops[1] as unknown as { line: { code: string }; limit?: string };
    expect(changeTrust.line.code).toBe('UF42');
    expect(inner.signatures).toHaveLength(2);
  });
});
