import * as SDK from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { TrustlineChecker } from '../src/trustline/checker';

/**
 * Live trustline pre-check against real Horizon (testnet). Opt-in:
 *   RUN_LIVE=1 npm run test:live
 */
const LIVE = process.env.RUN_LIVE === '1';

describe.skipIf(!LIVE)('TrustlineChecker against Horizon testnet (live)', () => {
  let funded: string;
  const checker = new TrustlineChecker({ horizonUrl: 'https://horizon-testnet.stellar.org' });

  beforeAll(async () => {
    const kp = SDK.Keypair.random();
    await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    funded = kp.publicKey();
  }, 60_000);

  it('classifies a funded account without the asset trustline as TRUSTLINE_MISSING', async () => {
    const bogusAsset = { code: 'NOPE' + 'X'.repeat(0), issuer: SDK.Keypair.random().publicKey() };
    const [status] = await checker.check(bogusAsset, [funded]);
    expect(status!.state).toBe('TRUSTLINE_MISSING');
  }, 60_000);

  it('classifies an account that does not exist as NO_ACCOUNT', async () => {
    const ghost = SDK.Keypair.random().publicKey();
    const [status] = await checker.check({ code: 'USDC', issuer: 'G'.padEnd(56, '9') }, [ghost]);
    expect(status!.state).toBe('NO_ACCOUNT');
  }, 60_000);
});
