import { appendFile, mkdir } from 'node:fs/promises';
import * as SDK from '@stellar/stellar-sdk';
import { runGatedLifecycle } from '../src/testkit/lifecycle';

/**
 * Live D1 demo against Stellar testnet:
 *   npm run demo
 * Prints every step, the protocol-level rejections with their result codes,
 * and explorer links for the evidence trail.
 */
async function main(): Promise<void> {
  console.log('Running gated-issuance lifecycle on Stellar TESTNET...\n');
  const report = await runGatedLifecycle({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: SDK.Networks.TESTNET,
    homeDomain: 'urbanflip.io',
    deal: { dealId: 'UF-0042', displayName: 'Urbanflip Deal #42 (SCF D1 demo)' },
    investorId: 'inv-001',
    allow: [{ investorId: 'inv-001', dealId: 'UF-0042' }],
  });

  const expert = 'https://stellar.expert/explorer/testnet';
  const lines = [
    `deal                    ${report.deal.dealId} (${report.deal.displayName})`,
    `asset                   ${report.asset.code}-${report.asset.issuer}`,
    `                        ${expert}/asset/${report.asset.code}-${report.asset.issuer}`,
    ``,
    `1. issuer provisioned   ${report.provisioningTxHash}`,
    `   flags on-chain       AUTH_REQUIRED=${report.issuerFlagsOnChain.authRequired} AUTH_REVOCABLE=${report.issuerFlagsOnChain.authRevocable} AUTH_CLAWBACK_ENABLED=${report.issuerFlagsOnChain.authClawbackEnabled}`,
    `   tx                   ${expert}/tx/${report.provisioningTxHash}`,
    `2. SEP-1 stellar.toml   ${report.tomlPath}`,
    `3. investor trustline   ${report.trustlineTxHash}`,
    `                        ${expert}/tx/${report.trustlineTxHash}`,
    `4. payment pre-auth     REJECTED by protocol: ${report.preAuthPayment.codes?.join(', ')}`,
    `5. gate decision        approved (static allowlist standing in for Urbanflip KYC)`,
    `   trustline authorized ${report.authorizationTxHash}`,
    `                        ${expert}/tx/${report.authorizationTxHash}`,
    `6. payment post-auth    ${report.postAuthPaymentHash}`,
    `                        ${expert}/tx/${report.postAuthPaymentHash}`,
    `7. clawback             ${report.clawbackTxHash} (investor balance now ${report.investorBalanceAfterClawback})`,
    `                        ${expert}/tx/${report.clawbackTxHash}`,
    `8. freeze               ${report.freezeTxHash}`,
    `                        ${expert}/tx/${report.freezeTxHash}`,
    `   payment post-freeze  REJECTED by protocol: ${report.postFreezePayment.codes?.join(', ')}`,
    ``,
    `audit trail (${report.audit.length} events):`,
    ...report.audit.map((e) => `   ${e.kind}  ${JSON.stringify(e).slice(0, 140)}`),
  ];
  console.log(lines.join('\n'));

  await mkdir('dist', { recursive: true });
  await appendFile('dist/audit-log.jsonl', report.audit.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log('\naudit log appended to dist/audit-log.jsonl');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
