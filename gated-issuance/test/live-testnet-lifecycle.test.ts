import * as SDK from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { runGatedLifecycle } from '../src/testkit/lifecycle';

/**
 * Live proof of the D1 acceptance criteria against Stellar testnet.
 * Opt-in because it hits the network: RUN_LIVE=1 npm run test:live
 */
const LIVE = process.env.RUN_LIVE === '1';
const TIMEOUT = 180_000;

describe.skipIf(!LIVE)('D1 lifecycle on testnet (live)', () => {
  let report: Awaited<ReturnType<typeof runGatedLifecycle>>;

  beforeAll(async () => {
    report = await runGatedLifecycle({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: SDK.Networks.TESTNET,
      homeDomain: 'urbanflip.io',
      deal: { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42 (SCF D1 proof)' },
      investorId: 'inv-001',
      allow: [{ investorId: 'inv-001', dealId: 'UF-0042' }],
    });
  }, TIMEOUT);

  it('provisions the issuer with all compliance flags set on-chain', () => {
    expect(report.issuerFlagsOnChain).toEqual({
      authRequired: true,
      authRevocable: true,
      authClawbackEnabled: true,
    });
  });

  it('rejects a non-authorized wallet at protocol level (op_not_authorized)', () => {
    // D1 acceptance criterion 2, left half
    expect(report.preAuthPayment.rejected).toBe(true);
    expect(report.preAuthPayment.codes).toContain('op_not_authorized');
    // recorded on the ledger as a failed tx: a hash a reviewer can open
    expect(report.preAuthPayment.recordedAsFailed).toBe(true);
    expect(report.preAuthPayment.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sets home_domain on the issuer and lists the asset in the stellar.toml', () => {
    expect(report.homeDomainOnChain).toBe('urbanflip.io');
    expect(report.toml).toContain(`issuer = "${report.asset.issuer}"`);
    expect(report.toml).toContain('NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"');
  });

  it('authorizes the KYC-approved wallet, which then receives the asset', () => {
    expect(report.authorizationTxHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.postAuthPaymentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('clawback reduces the investor balance (10 issued, 5 clawed back)', () => {
    expect(Number(report.investorBalanceAfterClawback)).toBe(5);
  });

  it('freeze blocks further payments at protocol level', () => {
    expect(report.postFreezePayment.rejected).toBe(true);
    expect(report.postFreezePayment.codes).toContain('op_not_authorized');
    expect(report.postFreezePayment.recordedAsFailed).toBe(true);
  });

  it('leaves a complete audit trail in causal order', () => {
    expect(report.audit.map((e) => e.kind)).toEqual([
      'ISSUER_PROVISIONED',
      'GATE_DECISION',
      'TRUSTLINE_AUTHORIZED',
      'CLAWBACK',
      'TRUSTLINE_FROZEN',
    ]);
  });

  it('publishes a SEP-1 stellar.toml resolving the asset', () => {
    expect(report.tomlPath).toContain('urbanflip.io');
  });
});
