import * as SDK from '@stellar/stellar-sdk';
import { createOnboarding, PrivyWalletProvider } from '../src/index';

/**
 * Live D2 demo on testnet: npm run demo
 * Email → embedded wallet → sponsored account → sponsored trustline → zero XLM
 * held at every step, all fees paid by the channel.
 *
 * With PRIVY_APP_ID and PRIVY_APP_SECRET set, the embedded wallet is a real
 * Privy `stellar` wallet signed through raw_sign (the D2.1 recording). Without
 * them it falls back to a dev-key stand-in, which keeps keys in this process.
 */
async function main(): Promise<void> {
  const privy =
    process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
      ? new PrivyWalletProvider({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET })
      : undefined;
  console.log(`embedded wallet provider: ${privy ? 'Privy (live API)' : 'dev-key stand-in (no PRIVY_APP_ID)'}`);
  const channel = SDK.Keypair.random();
  console.log('channel account:', channel.publicKey());
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${channel.publicKey()}`);
  if (!fb.ok) throw new Error('friendbot failed');

  const onboarding = createOnboarding({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: SDK.Networks.TESTNET,
    channelSecret: channel.secret(),
    walletProvider: privy,
  });

  // A fresh investor per run: Privy external_ids are write-once per app.
  const runId = Date.now().toString(36);
  const investorId = `inv-demo-${runId}`;
  const email = process.env.DEMO_EMAIL ?? `demo+${runId}@example.com`;
  const server = new SDK.Horizon.Server('https://horizon-testnet.stellar.org');
  const xlmHeld = async (address: string): Promise<string> => {
    const acc = await server.accounts().accountId(address).call();
    const native = (acc.balances as unknown as Array<Record<string, unknown>>).find((b) => b['asset_type'] === 'native');
    return String(native?.['balance'] ?? '0');
  };

  const account = await onboarding.sponsor.provisionInvestorAccount(investorId, email);
  const expert = 'https://stellar.expert/explorer/testnet';
  console.log(`\n1. email '${email}' -> wallet ${account.stellarAddress}`);
  console.log(
    account.alreadyExisted
      ? '   account already on-chain: creation skipped'
      : `   sponsored account created: ${expert}/tx/${account.txHash}`,
  );
  console.log(`   investor XLM balance: ${await xlmHeld(account.stellarAddress)}`);

  const trustline = await onboarding.sponsor.openSponsoredTrustline(investorId, email, {
    code: 'UF42',
    issuer: channel.publicKey(),
  });
  console.log(
    trustline.alreadyExisted
      ? '2. sponsored trustline UF42 already open: skipped'
      : `2. sponsored trustline UF42 opened:      ${expert}/tx/${trustline.txHash}`,
  );
  console.log(`   investor XLM balance: ${await xlmHeld(account.stellarAddress)}`);
  console.log(`   account: ${expert}/account/${account.stellarAddress}`);

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
