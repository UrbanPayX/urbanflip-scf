import * as SDK from '@stellar/stellar-sdk';
import { MemoryAuditLog, type AuditEvent } from '../audit/audit-log';
import { StaticComplianceGate, type StaticGateEntry } from '../gate/static-gate';
import { IssuerProvisioner } from '../issuance/issuer-provisioner';
import { TrustlineAuthorizer } from '../issuance/trustline-authorizer';
import { generateStellarToml, LocalSep1Publisher } from '../sep1/stellar-toml';
import { TxSubmitter } from '../stellar/tx-submitter';
import type { DealInfo } from '../types';
import { attemptPayment, establishTrustline, fundFromFriendbot, newInvestor } from './investor';

export interface LifecycleReport {
  networkPassphrase: string;
  deal: DealInfo;
  asset: { code: string; issuer: string };
  funderAddress: string;
  provisioningTxHash: string;
  issuerFlagsOnChain: { authRequired: boolean; authRevocable: boolean; authClawbackEnabled: boolean };
  tomlPath: string;
  investorAddress: string;
  trustlineTxHash: string;
  /** Payment attempted BEFORE gate approval — must be rejected with op_not_authorized. */
  preAuthPayment: { rejected: boolean; codes?: string[] };
  authorizationTxHash: string;
  postAuthPaymentHash: string;
  clawbackTxHash: string;
  investorBalanceAfterClawback: string;
  freezeTxHash: string;
  /** Payment attempted AFTER freeze — must be rejected again. */
  postFreezePayment: { rejected: boolean; codes?: string[] };
  audit: AuditEvent[];
}

export interface LifecycleOptions {
  horizonUrl: string;
  networkPassphrase: string;
  homeDomain: string;
  deal: DealInfo;
  investorId: string;
  allow: StaticGateEntry[];
  paymentAmount?: string;
  clawbackAmount?: string;
  sep1BaseDir?: string;
}

/**
 * End-to-end D1 lifecycle, run entirely against a real network (testnet by default):
 *
 *   fund -> provision flagged issuer -> publish SEP-1 -> investor trustline
 *   -> payment REJECTED (op_not_authorized) -> gate approves -> authorize trustline
 *   -> payment succeeds -> clawback -> freeze -> payment REJECTED again
 *
 * Every rejection is asserted against the protocol's own result codes, which is
 * exactly the evidence the SCF D1 acceptance criteria ask for.
 */
export async function runGatedLifecycle(opts: LifecycleOptions): Promise<LifecycleReport> {
  const submitter = new TxSubmitter(new SDK.Horizon.Server(opts.horizonUrl));
  const audit = new MemoryAuditLog();

  // 1. Operational funder for the demo (testnet: ephemeral, friendbot-funded).
  const funder = SDK.Keypair.random();
  await fundFromFriendbot(funder.publicKey());

  // 2. Per-deal issuer with AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED
  //    set in the same transaction that creates the account.
  const provisioner = new IssuerProvisioner({
    submitter,
    networkPassphrase: opts.networkPassphrase,
    funderKeypair: funder,
    homeDomain: opts.homeDomain,
    audit,
  });
  const provisioned = await provisioner.provision(opts.deal);
  const asset = new SDK.Asset(provisioned.asset.code, provisioned.asset.issuer);

  // 3. Confirm the flags actually landed on-chain (Horizon account flags).
  const issuerAccount = await new SDK.Horizon.Server(opts.horizonUrl)
    .accounts()
    .accountId(provisioned.issuerPublicKey)
    .call();
  const flags = (issuerAccount as unknown as { flags: Record<string, boolean> }).flags;
  if (!flags?.auth_required || !flags?.auth_revocable || !flags?.auth_clawback_enabled) {
    throw new Error(`issuer flags not set on-chain: ${JSON.stringify(flags)}`);
  }

  // 4. SEP-1 stellar.toml with this asset.
  const toml = generateStellarToml({
    documentation: { orgName: 'Urbanflip', orgUrl: `https://${opts.homeDomain}` },
    currencies: [
      {
        code: provisioned.asset.code,
        issuer: provisioned.asset.issuer,
        name: opts.deal.displayName,
        conditions: opts.deal.conditions,
        status: 'test',
      },
    ],
  });
  const tomlPath = await new LocalSep1Publisher(opts.sep1BaseDir).publish(opts.homeDomain, toml);

  // 5. Investor opens a trustline (allowed while unauthorized; holding is what's gated).
  const investor = newInvestor();
  await fundFromFriendbot(investor.keypair.publicKey());
  const trustlineTxHash = await establishTrustline(
    submitter,
    opts.networkPassphrase,
    investor,
    asset,
  );

  // 6. Payment BEFORE authorization -> must fail with op_not_authorized.
  const amount = opts.paymentAmount ?? '10';
  const preAuthPayment = await attemptPayment(
    submitter,
    opts.networkPassphrase,
    SDK.Keypair.fromSecret(provisioned.issuerSecret),
    investor.keypair.publicKey(),
    asset,
    amount,
  );
  if (preAuthPayment.ok) throw new Error('pre-authorization payment unexpectedly succeeded');
  const preCodes = preAuthPayment.failure?.opResultCodes ?? [preAuthPayment.failure?.txResultCode ?? 'unknown'];
  if (!preCodes.includes('op_not_authorized')) {
    throw new Error(`expected op_not_authorized before authorization, got ${preCodes.join(',')}`);
  }

  // 7. Gate approves -> trustline authorized.
  const authorizer = new TrustlineAuthorizer({
    gate: new StaticComplianceGate(opts.allow),
    submitter,
    networkPassphrase: opts.networkPassphrase,
    audit,
  });
  const authorization = await authorizer.authorize(opts.deal, SDK.Keypair.fromSecret(provisioned.issuerSecret), {
    investorId: opts.investorId,
    stellarAddress: investor.keypair.publicKey(),
  });

  // 8. Same payment now succeeds.
  const postAuth = await attemptPayment(
    submitter,
    opts.networkPassphrase,
    SDK.Keypair.fromSecret(provisioned.issuerSecret),
    investor.keypair.publicKey(),
    asset,
    amount,
  );
  if (!postAuth.ok) {
    throw new Error(`post-authorization payment failed: ${JSON.stringify(postAuth.failure?.opResultCodes)}`);
  }

  // 9. Clawback part of the position (issuer holds the account open, balance returns to issuer).
  //    Keyed by a clawbackId: repeating the call returns the recorded clawback, submitting nothing.
  const clawbackAmount = opts.clawbackAmount ?? '5';
  const clawbackArgs = [
    opts.deal,
    SDK.Keypair.fromSecret(provisioned.issuerSecret),
    investor.keypair.publicKey(),
    { amount: clawbackAmount, clawbackId: `offboard-${opts.investorId}-${opts.deal.dealId}` },
  ] as const;
  const clawback = await authorizer.clawback(...clawbackArgs);
  const repeated = await authorizer.clawback(...clawbackArgs);
  if (repeated.txHash !== clawback.txHash) {
    throw new Error(`repeated clawback submitted again (${repeated.txHash} != ${clawback.txHash})`);
  }
  const balanceAfterClawback = await assetBalanceOf(opts.horizonUrl, investor.keypair.publicKey(), asset);

  // 10. Freeze (deauthorize) -> payment is blocked again.
  const freeze = await authorizer.freeze(
    opts.deal,
    SDK.Keypair.fromSecret(provisioned.issuerSecret),
    investor.keypair.publicKey(),
  );
  const postFreezePayment = await attemptPayment(
    submitter,
    opts.networkPassphrase,
    SDK.Keypair.fromSecret(provisioned.issuerSecret),
    investor.keypair.publicKey(),
    asset,
    amount,
  );
  if (postFreezePayment.ok) throw new Error('post-freeze payment unexpectedly succeeded');
  const postCodes =
    postFreezePayment.failure?.opResultCodes ?? [postFreezePayment.failure?.txResultCode ?? 'unknown'];
  if (!postCodes.includes('op_not_authorized')) {
    throw new Error(`expected op_not_authorized after freeze, got ${postCodes.join(',')}`);
  }

  return {
    networkPassphrase: opts.networkPassphrase,
    deal: opts.deal,
    asset: provisioned.asset,
    funderAddress: funder.publicKey(),
    provisioningTxHash: provisioned.provisioningTxHash,
    issuerFlagsOnChain: {
      authRequired: flags.auth_required,
      authRevocable: flags.auth_revocable,
      authClawbackEnabled: flags.auth_clawback_enabled,
    },
    tomlPath,
    investorAddress: investor.keypair.publicKey(),
    trustlineTxHash,
    preAuthPayment: { rejected: true, codes: preCodes },
    authorizationTxHash: authorization.txHash,
    postAuthPaymentHash: postAuth.hash!,
    clawbackTxHash: clawback.txHash,
    investorBalanceAfterClawback: balanceAfterClawback,
    freezeTxHash: freeze.txHash,
    postFreezePayment: { rejected: true, codes: postCodes },
    audit: audit.events,
  };
}

async function assetBalanceOf(horizonUrl: string, address: string, asset: SDK.Asset): Promise<string> {
  const account = await new SDK.Horizon.Server(horizonUrl).accounts().accountId(address).call();
  const balances = (account as unknown as { balances: Array<Record<string, unknown>> }).balances;
  const entry = balances.find(
    (b) => b['asset_code'] === asset.code && b['asset_issuer'] === asset.issuer,
  );
  if (!entry) throw new Error(`no balance found for ${asset.code}`);
  return String(entry['balance']);
}
