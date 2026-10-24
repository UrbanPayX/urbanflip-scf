import * as SDK from '@stellar/stellar-sdk';
import type { WalletHandle } from '../types';
import type { WalletProvider } from './provider';

/**
 * Local-key stand-in for Privy: deterministic per-investor Ed25519 keypairs,
 * same port, same raw-signature exchange. Used by tests and the live testnet
 * demo — the pipeline cannot tell it apart from the real adapter, which is
 * the point of the port.
 */
export class DevKeyWalletProvider implements WalletProvider {
  readonly providerName = 'dev-key';
  private readonly wallets = new Map<string, SDK.Keypair>();

  getOrCreateWallet(investorId: string, _email?: string): Promise<WalletHandle> {
    let kp = this.wallets.get(investorId);
    if (!kp) {
      kp = SDK.Keypair.random();
      this.wallets.set(investorId, kp);
    }
    return Promise.resolve({
      investorId,
      stellarAddress: kp.publicKey(),
      provider: this.providerName,
    });
  }

  signRaw(investorId: string, payload: Uint8Array): Promise<string> {
    const kp = this.wallets.get(investorId);
    if (!kp) throw new Error(`no wallet provisioned for investor '${investorId}'`);
    // SDK Keypair signs the payload exactly as an Ed25519 raw signer would.
    const signature = kp.sign(Buffer.from(payload));
    return Promise.resolve(Buffer.from(signature).toString('base64'));
  }

  /** Test/demo hook: expose the keypair so a fake "external" signer can be simulated. */
  keypairOf(investorId: string): SDK.Keypair {
    const kp = this.wallets.get(investorId);
    if (!kp) throw new Error(`no wallet for '${investorId}'`);
    return kp;
  }
}
