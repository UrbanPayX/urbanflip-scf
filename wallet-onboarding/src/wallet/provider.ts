import type { WalletHandle } from '../types';

/**
 * Port: where investor key material lives. The pipeline never sees secrets —
 * it hands the provider a payload (a Stellar transaction hash) and receives a
 * raw Ed25519 signature back, exactly the exchange the Privy embedded-wallet
 * API performs server-to-server.
 *
 * Adapters:
 *   - PrivyWalletProvider  (email-first embedded wallets, Ed25519 raw signing)
 *   - DevKeyWalletProvider (local keypairs; tests, dry-runs, live demos)
 *
 * External wallets (Stellar Wallets Kit) never pass through this port: their
 * users sign client-side and arrive as (address, signature) pairs on the
 * pipeline's external path.
 */
export interface WalletProvider {
  readonly providerName: string;
  getOrCreateWallet(investorId: string, email: string): Promise<WalletHandle>;
  /** Signs raw bytes; resolves to the base64-encoded Ed25519 signature. */
  signRaw(investorId: string, payload: Uint8Array): Promise<string>;
}

/** The provider's signature did not verify against the wallet's address. */
export class SignatureRejectedError extends Error {
  constructor(address: string) {
    super(
      `wallet signature failed verification for ${address}; nothing was submitted`,
    );
    this.name = 'SignatureRejectedError';
  }
}
