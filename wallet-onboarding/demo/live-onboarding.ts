import * as SDK from '@stellar/stellar-sdk';
import { createOnboarding } from '../src/index';

/**
 * Live D2 demo on testnet: npm run demo
 * Email → embedded wallet (dev-key stand-in for Privy) → sponsored account →
 * sponsored trustline → zero XLM held at every step, all fees paid by the channel.
 */
async function main(): Promise<void> {
  const channel = SDK.Keypair.random();
  console.log('channel account:', channel.publicKey());
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${channel.publicKey()}`);
  if (!fb.ok) throw new Error('friendbot failed');

  const onboarding = createOnboarding({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: SDK.Networks.TESTNET,
    channelSecret: channel.secret(),
  });

  const investorId = 'inv-demo-1';
  const email = 'demo@example.com';

  const account = await onboarding.sponsor.provisionInvestorAccount(investorId, email);
  const expert = 'https://stellar.expert/explorer/testnet';
  console.log(`\n1. email '${email}' -> wallet ${account.stellarAddress}`);
  console.log(
    account.alreadyExisted
      ? '   account already on-chain: creation skipped'
      : `   sponsored account created (0 XLM): ${expert}/tx/${account.txHash}`,
  );

  const trustline = await onboarding.sponsor.openSponsoredTrustline(investorId, email, {
    code: 'UF42',
    issuer: channel.publicKey(),
  });
  console.log(
    trustline.alreadyExisted
      ? '2. sponsored trustline UF42 already open: skipped'
      : `2. sponsored trustline UF42 opened:      ${expert}/tx/${trustline.txHash}`,
  );

  const server = new SDK.Horizon.Server('https://horizon-testnet.stellar.org');
  const state = await server.accounts().accountId(account.stellarAddress).call();
  console.log(
    '\nfinal balances:',
    (state.balances as unknown as Array<Record<string, unknown>>)
      .map((b) => `${b['balance']} ${b['asset_type'] === 'native' ? 'XLM' : b['asset_code']}`)
      .join(' | '),
  );
  console.log('channel num_sponsoring (reserves it pays for):', state.num_sponsored ?? 'n/a');
  console.log('\ninvestor never bought, held or saw XLM.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
