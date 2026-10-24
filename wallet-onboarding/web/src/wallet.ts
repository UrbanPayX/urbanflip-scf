/**
 * Adapter over Stellar Wallets Kit v2 (`@creit.tech/stellar-wallets-kit@2.7.1`).
 * v2 is a static class: `StellarWalletsKit.init()` once, then static calls.
 * Kit and module errors are plain objects `{ code, message, ext? }`, not
 * `Error`s; SEP-43 code -4 means the user rejected the request.
 */
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { installText } from '@creit.tech/stellar-wallets-kit/state';
import type { Networks } from '@creit.tech/stellar-wallets-kit/types';

export interface SignResult {
  signedXdr: string;
  /** Only some wallets report it (Freighter does; LOBSTR does not). */
  signerAddress?: string;
}

/** What the flow needs from a wallet. The kit implements it in the browser. */
export interface WalletPort {
  /** Opens the wallet picker; resolves to the chosen account's G-address. */
  connect(): Promise<string>;
  /**
   * The wallet's current network passphrase, or `undefined` when the wallet
   * cannot tell (Albedo, xBull and LOBSTR do not implement getNetwork).
   */
  currentNetwork(): Promise<string | undefined>;
  sign(xdr: string, opts: { networkPassphrase: string; address: string }): Promise<SignResult>;
}

export class WalletError extends Error {
  constructor(
    readonly cancelled: boolean,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

// The kit has no single "user said no" code: Freighter and Albedo use -4
// (SEP-43), xBull's web wallet throws "Request rejected from the wallet",
// closing the kit modal gives "The user closed the modal.", and closing the
// xBull popup ends its observable with "no elements in sequence".
const CANCEL_RE = /reject|declin|cancel|closed the modal|no elements in sequence/i;

export function toWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const obj = (e ?? {}) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
  const codeRaw = obj.error?.code ?? obj.code;
  const code = typeof codeRaw === 'number' ? codeRaw : undefined;
  const messageRaw = obj.error?.message ?? obj.message ?? (typeof e === 'string' ? e : undefined);
  const message = typeof messageRaw === 'string' && messageRaw ? messageRaw : 'wallet error';
  return new WalletError(code === -4 || CANCEL_RE.test(message), code, message);
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;

export function isGAddress(value: unknown): value is string {
  return typeof value === 'string' && G_ADDRESS.test(value);
}

export function createKitWallet(networkPassphrase: string, lang: 'es' | 'en'): WalletPort {
  StellarWalletsKit.init({
    modules: defaultModules(),
    // The kit's Networks enum values are the passphrases themselves.
    network: networkPassphrase as Networks,
  });
  // The rest of the kit modal is English-only in 2.7.1 (its title is
  // hard-coded on every render), but the install label is configurable.
  if (lang === 'es') installText.value = 'Instalar';

  return {
    async connect() {
      let address: unknown;
      try {
        ({ address } = await StellarWalletsKit.authModal());
      } catch (e) {
        throw toWalletError(e);
      }
      if (!isGAddress(address)) throw new WalletError(false, undefined, 'the wallet returned an invalid address');
      return address;
    },

    async currentNetwork() {
      try {
        const { networkPassphrase: current } = await StellarWalletsKit.getNetwork();
        return typeof current === 'string' && current ? current : undefined;
      } catch {
        return undefined; // not supported by this wallet: nothing to compare
      }
    },

    async sign(xdr, opts) {
      try {
        const { signedTxXdr, signerAddress } = await StellarWalletsKit.signTransaction(xdr, {
          networkPassphrase: opts.networkPassphrase,
          address: opts.address,
        });
        if (typeof signedTxXdr !== 'string' || !signedTxXdr) {
          throw new WalletError(false, undefined, 'the wallet returned no signed transaction');
        }
        return { signedXdr: signedTxXdr, signerAddress };
      } catch (e) {
        throw toWalletError(e);
      }
    },
  };
}
