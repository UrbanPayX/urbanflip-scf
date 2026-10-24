import * as SDK from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { createOnboarding } from '../src/index';
import { DevKeyWalletProvider } from '../src/wallet/dev-key-provider';
import { FakeHorizon } from './fake-horizon';

const EMAIL = 'inv@example.com';

/** A fresh pipeline and in-memory idempotency ledger on every call: a process restart. */
function boot(horizon: FakeHorizon, wallets: DevKeyWalletProvider, channel: SDK.Keypair) {
  return createOnboarding({
    horizonUrl: 'http://horizon.invalid',
    networkPassphrase: SDK.Networks.TESTNET,
    channelSecret: channel.secret(),
    walletProvider: wallets,
    submitter: horizon,
  }).sponsor;
}

function setup() {
  const horizon = new FakeHorizon();
  const wallets = new DevKeyWalletProvider();
  const channel = SDK.Keypair.random();
  const issuerA = SDK.Keypair.random().publicKey();
  const issuerB = SDK.Keypair.random().publicKey();
  return { horizon, wallets, channel, issuerA, issuerB, sponsor: boot(horizon, wallets, channel) };
}

describe('SponsorService re-runs (chain state checked before every step)', () => {
  it('skips account creation when the account already exists (second deal, restart)', async () => {
    const { horizon, wallets, channel, sponsor } = setup();
    const first = await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    expect(first).toMatchObject({ alreadyExisted: false, zeroXlm: true });
    expect(horizon.received).toHaveLength(1);

    const afterRestart = await boot(horizon, wallets, channel).provisionInvestorAccount('inv-1', EMAIL);
    expect(afterRestart).toMatchObject({
      stellarAddress: first.stellarAddress,
      alreadyExisted: true,
      zeroXlm: true,
    });
    expect(afterRestart.txHash).toBeUndefined();
    expect(horizon.received).toHaveLength(1); // no createAccount, so no op_already_exists
  });

  it('reports zeroXlm from the chain for an account that was funded elsewhere', async () => {
    const { horizon, wallets, sponsor } = setup();
    const wallet = await wallets.getOrCreateWallet('inv-1', EMAIL);
    horizon.accounts.set(wallet.stellarAddress, { xlmBalance: '1.5000000', trustlines: [] });

    const result = await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    expect(result).toMatchObject({ alreadyExisted: true, zeroXlm: false });
    expect(horizon.received).toHaveLength(0);
  });

  it('skips a trustline that already exists for the exact asset (code AND issuer)', async () => {
    const { horizon, wallets, channel, sponsor, issuerA } = setup();
    await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    const opened = await sponsor.openSponsoredTrustline('inv-1', EMAIL, { code: 'UF42', issuer: issuerA });
    expect(opened.alreadyExisted).toBe(false);
    expect(opened.txHash).toMatch(/^[a-f0-9]{64}$/);

    const restarted = boot(horizon, wallets, channel);
    const again = await restarted.openSponsoredTrustline('inv-1', EMAIL, { code: 'UF42', issuer: issuerA });
    expect(again).toMatchObject({ alreadyExisted: true, asset: `UF42-${issuerA}` });
    expect(again.txHash).toBeUndefined();
    expect(horizon.received).toHaveLength(2);
  });

  it('opens a second trustline for the same code from a different issuer', async () => {
    const { horizon, sponsor, issuerA, issuerB } = setup();
    const account = await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    const a = await sponsor.openSponsoredTrustline('inv-1', EMAIL, { code: 'UF42', issuer: issuerA });
    // Same service, same idempotency ledger: the key must include the issuer.
    const b = await sponsor.openSponsoredTrustline('inv-1', EMAIL, { code: 'UF42', issuer: issuerB });

    expect(b.alreadyExisted).toBe(false);
    expect(b.txHash).toBeDefined();
    expect(b.txHash).not.toBe(a.txHash);
    expect(b.asset).toBe(`UF42-${issuerB}`);
    expect(horizon.changeTrustLines()).toEqual([
      { code: 'UF42', issuer: issuerA },
      { code: 'UF42', issuer: issuerB },
    ]);
    expect(horizon.accounts.get(account.stellarAddress)?.trustlines).toHaveLength(2);
  });

  it('timeout after apply: the retry finds the account on-chain and submits nothing new', async () => {
    const { horizon, sponsor } = setup();
    horizon.script.push('apply-then-timeout', 'timeout');

    await expect(sponsor.provisionInvestorAccount('inv-1', EMAIL)).rejects.toThrow(/unknown/);
    expect(horizon.received).toHaveLength(2); // the identical envelope, retried once
    const [first, retry] = horizon.received;
    expect(Buffer.from(retry!.hash()).toString('hex')).toBe(Buffer.from(first!.hash()).toString('hex'));

    const result = await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    expect(result).toMatchObject({ alreadyExisted: true, zeroXlm: true });
    expect(horizon.received).toHaveLength(2);
  });

  it('a definitively rejected step is rebuilt on the next call', async () => {
    const { horizon, sponsor, issuerA } = setup();
    await sponsor.provisionInvestorAccount('inv-1', EMAIL);
    horizon.script.push({ reject: 'tx_insufficient_fee' });

    const asset = { code: 'UF42', issuer: issuerA };
    await expect(sponsor.openSponsoredTrustline('inv-1', EMAIL, asset)).rejects.toThrow(/failed/);
    const retried = await sponsor.openSponsoredTrustline('inv-1', EMAIL, asset);
    expect(retried.alreadyExisted).toBe(false);
    expect(horizon.changeTrustLines()).toHaveLength(2); // rejected once, then applied
  });
});
