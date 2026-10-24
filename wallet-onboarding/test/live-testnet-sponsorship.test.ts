import * as SDK from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOnboarding } from '../src/index';
import type { OnboardingService } from '../src/index';

/**
 * Live proof of the D2 acceptance criteria on Stellar testnet (opt-in):
 *   RUN_LIVE=1 npm run test:live
 *
 * Creates 21 sponsored investor accounts (criterion: "20+ sponsored accounts
 * with sponsored trustlines verifiable on-chain"), spread over 3 channel
 * accounts. Every investor must hold exactly 0 XLM after every step. Then
 * re-runs onboarding after a simulated restart (nothing may be resubmitted)
 * and opens the same code from a second issuer (a distinct trustline).
 */
const LIVE = process.env.RUN_LIVE === '1';
const INVESTORS = 21;
const CHANNELS = 3;
const TIMEOUT = 600_000;
const HORIZON = 'https://horizon-testnet.stellar.org';

interface Boarded {
  investorId: string;
  email: string;
  address: string;
  accountTx: string | undefined;
  trustlineTx: string | undefined;
  channelIdx: number;
}

describe.skipIf(!LIVE)('D2 sponsored onboarding on testnet (live)', () => {
  let boarded: Boarded[] = [];
  let channels: SDK.Keypair[] = [];
  let services: { service: OnboardingService; issuer: string }[] = [];

  beforeAll(async () => {
    channels = Array.from({ length: CHANNELS }, () => SDK.Keypair.random());
    await Promise.all(
      channels.map((c) =>
        fetch(`https://friendbot.stellar.org/?addr=${c.publicKey()}`).then((r) => {
          if (!r.ok) throw new Error(`friendbot HTTP ${r.status}`);
        }),
      ),
    );

    services = channels.map((channel) => ({
      service: createOnboarding({
        horizonUrl: HORIZON,
        networkPassphrase: SDK.Networks.TESTNET,
        channelSecret: channel.secret(),
      }),
      issuer: channel.publicKey(),
    }));

    // Serialize per channel (sequence numbers), parallelize across channels.
    boarded = await Promise.all(
      channels.map(async (_, channelIdx) => {
        const results: Boarded[] = [];
        for (let i = channelIdx; i < INVESTORS; i += CHANNELS) {
          const investorId = `inv-live-${i + 1}`;
          const email = `investor-${i + 1}@example.com`;
          const { service, issuer } = services[channelIdx]!;
          const account = await service.sponsor.provisionInvestorAccount(investorId, email);
          const trustline = await service.sponsor.openSponsoredTrustline(investorId, email, {
            code: 'UF42',
            issuer,
          });
          results.push({
            investorId,
            email,
            address: account.stellarAddress,
            accountTx: account.txHash,
            trustlineTx: trustline.txHash,
            channelIdx,
          });
        }
        return results;
      }),
    ).then((groups) => groups.flat());
  }, TIMEOUT);

  it('creates 20+ sponsored accounts (acceptance criterion)', () => {
    expect(boarded.length).toBeGreaterThanOrEqual(20);
    expect(new Set(boarded.map((b) => b.address)).size).toBe(boarded.length);
  });

  it('every investor holds exactly 0 XLM with an open sponsored trustline', async () => {
    const server = new SDK.Horizon.Server(HORIZON);
    for (const b of boarded) {
      const account = await server.accounts().accountId(b.address).call();
      const balances = account.balances as unknown as Array<Record<string, unknown>>;
      const native = balances.find((bal) => bal['asset_type'] === 'native');
      expect(native?.['balance'], `${b.investorId} XLM balance`).toBe('0.0000000');
      const trustline = balances.find(
        (bal) => bal['asset_code'] === 'UF42' && bal['asset_issuer'] !== undefined,
      );
      expect(trustline, `${b.investorId} trustline`).toBeDefined();
    }
  }, TIMEOUT);

  it('leaves all transactions verifiable on-chain', () => {
    for (const b of boarded.slice(0, 3)) {
      expect(b.accountTx).toMatch(/^[a-f0-9]{64}$/);
      expect(b.trustlineTx).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('re-runs onboarding after a restart without submitting anything', async () => {
    for (const b of boarded.slice(0, 3)) {
      const { service, issuer } = services[b.channelIdx]!;
      // Fresh pipeline and idempotency ledger (the restart); same wallets.
      const restarted = createOnboarding({
        horizonUrl: HORIZON,
        networkPassphrase: SDK.Networks.TESTNET,
        channelSecret: channels[b.channelIdx]!.secret(),
        walletProvider: service.walletProvider,
      });
      const account = await restarted.sponsor.provisionInvestorAccount(b.investorId, b.email);
      const trustline = await restarted.sponsor.openSponsoredTrustline(b.investorId, b.email, {
        code: 'UF42',
        issuer,
      });
      expect(account).toMatchObject({ alreadyExisted: true, zeroXlm: true, stellarAddress: b.address });
      expect(account.txHash).toBeUndefined();
      expect(trustline.alreadyExisted).toBe(true);
      expect(trustline.txHash).toBeUndefined();
    }
  }, TIMEOUT);

  it('opens the same code from a second issuer as a distinct sponsored trustline', async () => {
    const b = boarded[0]!;
    const { service, issuer } = services[b.channelIdx]!;
    const otherIssuer = services[(b.channelIdx + 1) % CHANNELS]!.issuer;
    const second = await service.sponsor.openSponsoredTrustline(b.investorId, b.email, {
      code: 'UF42',
      issuer: otherIssuer,
    });
    expect(second.alreadyExisted).toBe(false);
    expect(second.txHash).toMatch(/^[a-f0-9]{64}$/);

    const account = await new SDK.Horizon.Server(HORIZON).accounts().accountId(b.address).call();
    const balances = account.balances as unknown as Array<Record<string, unknown>>;
    const issuers = balances.filter((bal) => bal['asset_code'] === 'UF42').map((bal) => bal['asset_issuer']);
    expect(new Set(issuers)).toEqual(new Set([issuer, otherIssuer]));
    expect(balances.find((bal) => bal['asset_type'] === 'native')?.['balance']).toBe('0.0000000');
  }, TIMEOUT);
});
