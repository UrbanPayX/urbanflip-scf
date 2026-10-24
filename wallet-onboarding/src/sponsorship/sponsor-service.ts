import * as SDK from '@stellar/stellar-sdk';
import type { InvestorTxPipeline } from '../pipeline/investor-tx-pipeline';
import type { AssetRef, LedgerReader } from '../stellar/submitter';
import type { WalletProvider } from '../wallet/provider';
import type { OnboardedInvestor } from '../types';

export interface SponsorServiceDeps {
  pipeline: InvestorTxPipeline;
  walletProvider: WalletProvider;
  networkPassphrase: string;
  /** Chain state checked before each step; defaults to the pipeline's reader. */
  ledger?: LedgerReader;
}

export interface SponsoredAccountResult {
  investorId: string;
  stellarAddress: string;
  /** Undefined when the account was already on-chain and nothing was submitted. */
  txHash?: string;
  alreadyExisted: boolean;
  /**
   * Created here: true by construction (0 XLM, sponsored reserves).
   * Already existed: whether it holds 0 XLM now.
   */
  zeroXlm: boolean;
}

export interface SponsoredTrustlineResult {
  investorId: string;
  stellarAddress: string;
  asset: string;
  /** Undefined when the trustline (same code AND issuer) already existed. */
  txHash?: string;
  alreadyExisted: boolean;
}

/**
 * The onboarding flow an investor actually experiences: they register with an
 * email; a wallet appears; their account and trustline are created — and they
 * hold zero XLM through every step because the channel account sponsors the
 * reserves (CAP-33) and pays the fees (fee-bump).
 *
 * Envelope shapes (both proven on testnet):
 *   creation:  [beginSponsoringFutureReserves(investor),
 *               createAccount(investor, startingBalance 0),
 *               endSponsoringFutureReserves(source: investor)]
 *   trustline: [beginSponsoringFutureReserves(investor),
 *               changeTrust(source: investor, asset),
 *               endSponsoringFutureReserves(source: investor)]
 *
 * The end op must be sourced from the SPONSORED account (CAP-33), so both
 * envelopes carry the investor's raw wallet signature alongside the channel's.
 *
 * Every step reads the chain first and is skipped when already done (an
 * investor's second deal, a retry after an unknown outcome, a restart), so
 * onboarding is safe to re-run.
 */
export class SponsorService {
  private readonly ledger: LedgerReader;

  constructor(private readonly deps: SponsorServiceDeps) {
    this.ledger = deps.ledger ?? deps.pipeline.ledger;
  }

  async provisionInvestorAccount(investorId: string, email: string): Promise<SponsoredAccountResult> {
    const wallet = await this.deps.walletProvider.getOrCreateWallet(investorId, email);
    // Only a 404 means "create": an existing account would fail with op_already_exists.
    const account = await this.ledger.loadAccountSnapshot(wallet.stellarAddress);
    if (account) {
      return {
        investorId,
        stellarAddress: wallet.stellarAddress,
        alreadyExisted: true,
        zeroXlm: Number(account.xlmBalance) === 0,
      };
    }
    const record = await this.deps.pipeline.submitInvestorTransaction({
      idempotencyKey: `account:${investorId}`,
      investorAddress: wallet.stellarAddress,
      build: (channel) =>
        new SDK.TransactionBuilder(channel, {
          fee: '100',
          networkPassphrase: this.deps.networkPassphrase,
        })
          .addOperation(
            SDK.Operation.beginSponsoringFutureReserves({ sponsoredId: wallet.stellarAddress }),
          )
          .addOperation(
            SDK.Operation.createAccount({
              destination: wallet.stellarAddress,
              startingBalance: '0',
            }),
          )
          .addOperation(
            SDK.Operation.endSponsoringFutureReserves({ source: wallet.stellarAddress }),
          )
          .setTimeout(30)
          .build(),
      walletSign: (hash) => this.deps.walletProvider.signRaw(investorId, hash),
    });
    if (record.status !== 'submitted') {
      throw new Error(
        `sponsored account creation ${record.status}: ${record.txResultCode ?? ''} ${(record.opResultCodes ?? []).join(',')}`,
      );
    }
    return {
      investorId,
      stellarAddress: wallet.stellarAddress,
      txHash: record.txHash!,
      alreadyExisted: false,
      zeroXlm: true,
    };
  }

  async openSponsoredTrustline(
    investorId: string,
    email: string,
    asset: AssetRef,
    limit = '10000',
  ): Promise<SponsoredTrustlineResult> {
    const wallet = await this.deps.walletProvider.getOrCreateWallet(investorId, email);
    const label = `${asset.code}-${asset.issuer}`;
    // Same code from another issuer is another asset: only an exact match is skipped.
    // A missing account is not a skip: a lagging Horizon read must not block, the network decides.
    const account = await this.ledger.loadAccountSnapshot(wallet.stellarAddress);
    if (account?.trustlines.some((t) => t.code === asset.code && t.issuer === asset.issuer)) {
      return { investorId, stellarAddress: wallet.stellarAddress, asset: label, alreadyExisted: true };
    }
    const sdkAsset = new SDK.Asset(asset.code, asset.issuer);
    const record = await this.deps.pipeline.submitInvestorTransaction({
      idempotencyKey: `trustline:${investorId}:${asset.code}:${asset.issuer}`,
      investorAddress: wallet.stellarAddress,
      build: (channel) =>
        new SDK.TransactionBuilder(channel, {
          fee: '100',
          networkPassphrase: this.deps.networkPassphrase,
        })
          .addOperation(
            SDK.Operation.beginSponsoringFutureReserves({ sponsoredId: wallet.stellarAddress }),
          )
          .addOperation(
            SDK.Operation.changeTrust({
              source: wallet.stellarAddress,
              asset: sdkAsset,
              limit,
            }),
          )
          .addOperation(
            SDK.Operation.endSponsoringFutureReserves({ source: wallet.stellarAddress }),
          )
          .setTimeout(30)
          .build(),
      walletSign: (hash) => this.deps.walletProvider.signRaw(investorId, hash),
    });
    if (record.status !== 'submitted') {
      throw new Error(
        `sponsored trustline ${record.status}: ${record.txResultCode ?? ''} ${(record.opResultCodes ?? []).join(',')}`,
      );
    }
    return {
      investorId,
      stellarAddress: wallet.stellarAddress,
      asset: label,
      txHash: record.txHash!,
      alreadyExisted: false,
    };
  }

  /** Onboarding summary for one investor; xlmBalance is filled by the caller's view layer. */
  summarize(investorId: string, address: string, accountTx: string | undefined, trustlineTx: string | undefined, xlmBalance: string): OnboardedInvestor {
    return {
      investorId,
      stellarAddress: address,
      accountCreationTxHash: accountTx,
      trustlineTxHash: trustlineTx,
      xlmBalance,
    };
  }
}
