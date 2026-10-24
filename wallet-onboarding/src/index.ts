import * as SDK from '@stellar/stellar-sdk';
import { InvestorTxPipeline, MemoryIdempotencyLedger } from './pipeline/investor-tx-pipeline';
import type { IdempotencyLedger } from './pipeline/investor-tx-pipeline';
import { SponsorService } from './sponsorship/sponsor-service';
import { TxSubmitter } from './stellar/submitter';
import type { LedgerReader, TransactionSubmitter } from './stellar/submitter';
import { DevKeyWalletProvider } from './wallet/dev-key-provider';
import type { WalletProvider } from './wallet/provider';

export * from './types';
export type { WalletProvider } from './wallet/provider';
export { SignatureRejectedError } from './wallet/provider';
export { DevKeyWalletProvider } from './wallet/dev-key-provider';
export {
  PrivyWalletProvider,
  PrivyHttpError,
  toStellarAddress,
  defaultExternalId,
  privyAuthorizationSigner,
  canonicalJson,
} from './wallet/privy-provider';
export type { PrivyProviderConfig, PrivyAuthorizationPayload } from './wallet/privy-provider';
export {
  MemoryWalletDirectory,
  JsonFileWalletDirectory,
  WalletDirectoryLockedError,
} from './wallet/wallet-directory';
export type { WalletDirectory, WalletRecord, WalletChainType, LockHolder } from './wallet/wallet-directory';
export {
  InvestorTxPipeline,
  MemoryIdempotencyLedger,
  SubmissionPendingError,
} from './pipeline/investor-tx-pipeline';
export type { IdempotencyLedger } from './pipeline/investor-tx-pipeline';
export { SponsorService } from './sponsorship/sponsor-service';
export type { SponsoredAccountResult, SponsoredTrustlineResult } from './sponsorship/sponsor-service';
export { TxSubmitter, TransactionRejectedError, toFailure, extractFailure } from './stellar/submitter';
export type { AccountSnapshot, AssetRef, LedgerReader, TransactionSubmitter } from './stellar/submitter';

export interface OnboardingService {
  walletProvider: WalletProvider;
  pipeline: InvestorTxPipeline;
  sponsor: SponsorService;
}

export interface OnboardingConfig {
  horizonUrl: string;
  networkPassphrase: string;
  channelSecret: string;
  walletProvider?: WalletProvider;
  idempotency?: IdempotencyLedger;
  submitter?: TransactionSubmitter;
  /** Chain reads; defaults to the submitter when it implements LedgerReader (TxSubmitter does). */
  ledger?: LedgerReader;
}

/** Wires the object graph; the wallet provider is the only pluggable secret-holder. */
export function createOnboarding(config: OnboardingConfig): OnboardingService {
  const submitter =
    config.submitter ?? new TxSubmitter(new SDK.Horizon.Server(config.horizonUrl));
  const walletProvider = config.walletProvider ?? new DevKeyWalletProvider();
  const pipeline = new InvestorTxPipeline({
    submitter,
    ledger: config.ledger,
    networkPassphrase: config.networkPassphrase,
    channelKeypair: SDK.Keypair.fromSecret(config.channelSecret),
    idempotency: config.idempotency ?? new MemoryIdempotencyLedger(),
  });
  return {
    walletProvider,
    pipeline,
    sponsor: new SponsorService({
      pipeline,
      walletProvider,
      networkPassphrase: config.networkPassphrase,
    }),
  };
}
