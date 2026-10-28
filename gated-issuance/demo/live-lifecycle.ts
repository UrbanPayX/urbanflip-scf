import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import * as SDK from '@stellar/stellar-sdk';
import { runGatedLifecycle } from '../src/testkit/lifecycle';

/**
 * Live D1 demo against Stellar testnet:
 *   npm run demo
 * Prints every step, the protocol-level rejections with their result codes,
 * and explorer links for the evidence trail. Writes the evidence record to
 * evidence/d1-lifecycle-testnet.json and the stellar.toml that lists this
 * issuer to evidence/stellar.toml (serve it at
 * https://urbanflip.io/.well-known/stellar.toml for SEP-1 verification).
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
  const tx = (hash: string) => `${expert}/tx/${hash}`;
  const lines = [
    `deal                    ${report.deal.dealId} (${report.deal.displayName})`,
    `asset                   ${report.asset.code}-${report.asset.issuer}`,
    `                        ${expert}/asset/${report.asset.code}-${report.asset.issuer}`,
    ``,
    `1. issuer provisioned   ${report.provisioningTxHash}`,
    `   flags on-chain       AUTH_REQUIRED=${report.issuerFlagsOnChain.authRequired} AUTH_REVOCABLE=${report.issuerFlagsOnChain.authRevocable} AUTH_CLAWBACK_ENABLED=${report.issuerFlagsOnChain.authClawbackEnabled}`,
    `   home_domain          ${report.homeDomainOnChain}`,
    `   tx                   ${tx(report.provisioningTxHash)}`,
    `2. SEP-1 stellar.toml   ${report.tomlPath}`,
    `3. investor trustline   ${report.trustlineTxHash}`,
    `                        ${tx(report.trustlineTxHash)}`,
    `4. payment pre-auth     REJECTED by protocol: ${report.preAuthPayment.codes?.join(', ')}`,
    `                        ${tx(report.preAuthPayment.hash)} (recorded as failed: ${report.preAuthPayment.recordedAsFailed})`,
    `5. gate decision        approved (static allowlist standing in for Urbanflip KYC)`,
    `   trustline authorized ${report.authorizationTxHash}`,
    `                        ${tx(report.authorizationTxHash)}`,
    `6. payment post-auth    ${report.postAuthPaymentHash}`,
    `                        ${tx(report.postAuthPaymentHash)}`,
    `7. clawback             ${report.clawbackTxHash} (investor balance now ${report.investorBalanceAfterClawback})`,
    `                        ${tx(report.clawbackTxHash)}`,
    `8. freeze               ${report.freezeTxHash}`,
    `                        ${tx(report.freezeTxHash)}`,
    `   payment post-freeze  REJECTED by protocol: ${report.postFreezePayment.codes?.join(', ')}`,
    `                        ${tx(report.postFreezePayment.hash)} (recorded as failed: ${report.postFreezePayment.recordedAsFailed})`,
    ``,
    `audit trail (${report.audit.length} events):`,
    ...report.audit.map((e) => `   ${e.kind}  ${JSON.stringify(e).slice(0, 140)}`),
  ];
  console.log(lines.join('\n'));

  await mkdir('dist', { recursive: true });
  await appendFile('dist/audit-log.jsonl', report.audit.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log('\naudit log appended to dist/audit-log.jsonl');

  const evidence = {
    criterion: 'SCF D1: compliance-gated issuance lifecycle on testnet (D1.1 issuer/asset/SEP-1, D1.2 protocol-level rejection and authorized receipt, D1.4 clawback and freeze)',
    network: 'testnet',
    generatedAt: new Date().toISOString(),
    asset: `${report.asset.code}-${report.asset.issuer}`,
    assetPage: `${expert}/asset/${report.asset.code}-${report.asset.issuer}`,
    issuer: `${expert}/account/${report.asset.issuer}`,
    issuerFlags: report.issuerFlagsOnChain,
    homeDomain: report.homeDomainOnChain,
    issuerProvisioningTx: tx(report.provisioningTxHash),
    investor: `${expert}/account/${report.investorAddress}`,
    trustlineTx: tx(report.trustlineTxHash),
    rejectedBeforeAuthorization: { tx: tx(report.preAuthPayment.hash), resultCodes: report.preAuthPayment.codes, recordedAsFailed: report.preAuthPayment.recordedAsFailed },
    gateDecision: report.audit.find((e) => e.kind === 'GATE_DECISION') ?? null,
    authorizationTx: tx(report.authorizationTxHash),
    paymentReceivedTx: tx(report.postAuthPaymentHash),
    clawbackTx: tx(report.clawbackTxHash),
    investorBalanceAfterClawback: report.investorBalanceAfterClawback,
    freezeTx: tx(report.freezeTxHash),
    rejectedAfterFreeze: { tx: tx(report.postFreezePayment.hash), resultCodes: report.postFreezePayment.codes, recordedAsFailed: report.postFreezePayment.recordedAsFailed },
    auditTrail: report.audit,
  };
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/d1-lifecycle-testnet.json', JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  await writeFile('evidence/stellar.toml', report.toml, 'utf8');
  console.log('evidence written to evidence/d1-lifecycle-testnet.json and evidence/stellar.toml');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
