/**
 * The connection flow, independent of the DOM:
 *
 *   connect (kit modal) → address → network check
 *   → POST challenge → [user confirms] → wallet signs → POST verify
 *   → POST trustline → "ready" | "sign" → [user confirms] → wallet signs → POST trustline/submit
 *
 * Each wallet prompt waits for a click ("confirm"). Web wallets (Albedo,
 * xBull's web app) open a popup per request, and browsers block popups that
 * are not triggered by a recent click.
 *
 * Expiry: a challenge (or trustline transaction) that expired, locally before
 * signing or as reported by the backend, is fetched again automatically once.
 */
import { isExpiredError, type Signable, type WalletApi } from './api';
import { WalletError, type WalletPort } from './wallet';

export type Phase =
  | 'connecting'
  | 'requesting_challenge'
  | 'confirm_challenge'
  | 'signing_challenge'
  | 'verifying'
  | 'preparing_trustline'
  | 'confirm_trustline'
  | 'signing_trustline'
  | 'submitting';

export type SignStep = 'challenge' | 'trustline';

export interface PhaseInfo {
  address?: string;
  /** True while working on a replacement for an expired challenge/transaction. */
  renewed?: boolean;
}

export type FlowErrorCode = 'wrong_network' | 'network_mismatch' | 'wrong_account' | 'expired';

export class FlowError extends Error {
  constructor(
    readonly code: FlowErrorCode,
    message: string,
    readonly detail: { actual?: string; expected?: string } = {},
  ) {
    super(message);
    this.name = 'FlowError';
  }
}

export interface FlowDeps {
  api: WalletApi;
  wallet: WalletPort;
  dealId: string;
  /** Passphrase of the network the widget was opened for. */
  networkPassphrase: string;
  onPhase(phase: Phase, info: PhaseInfo): void;
  /** Resolves when the user asks to continue to the wallet prompt. */
  confirm(step: SignStep): Promise<void>;
  now?: () => number;
}

export interface FlowOutcome {
  address: string;
  /** Set only when this run submitted the trustline. */
  txHash?: string;
}

export class ConnectFlow {
  /** Address proven in this page session; a retry resumes at the trustline. */
  private linked?: string;

  constructor(private readonly deps: FlowDeps) {}

  get linkedAddress(): string | undefined {
    return this.linked;
  }

  async run(): Promise<FlowOutcome> {
    const address = this.linked ?? (await this.link());
    return this.openTrustline(address);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async link(): Promise<string> {
    const { api, wallet } = this.deps;
    this.deps.onPhase('connecting', {});
    const address = await wallet.connect();
    await this.ensureWalletNetwork();

    let renewed = false;
    for (;;) {
      this.deps.onPhase('requesting_challenge', { address, renewed });
      const challenge = await api.challenge(address);
      const signed = await this.signGated('challenge', challenge, address, renewed);
      if (signed === undefined) {
        renewed = this.renewOrThrow(renewed, 'challenge');
        continue;
      }
      this.deps.onPhase('verifying', { address });
      let linked: string;
      try {
        ({ address: linked } = await api.verify(signed));
      } catch (e) {
        if (isExpiredError(e) && !renewed) {
          renewed = true;
          continue;
        }
        throw e;
      }
      if (linked !== address) {
        throw new FlowError('wrong_account', `server linked ${linked}, wallet is ${address}`, {
          actual: linked,
          expected: address,
        });
      }
      this.linked = address;
      return address;
    }
  }

  private async openTrustline(address: string): Promise<FlowOutcome> {
    const { api, dealId } = this.deps;
    let renewed = false;
    for (;;) {
      this.deps.onPhase('preparing_trustline', { address, renewed });
      const result = await api.trustline(dealId);
      if (result.status === 'ready') {
        if (result.address !== address) {
          throw new FlowError('wrong_account', `trustline is ready for ${result.address}, wallet is ${address}`, {
            actual: result.address,
            expected: address,
          });
        }
        return { address };
      }
      const signed = await this.signGated('trustline', result, address, renewed);
      if (signed === undefined) {
        renewed = this.renewOrThrow(renewed, 'trustline transaction');
        continue;
      }
      this.deps.onPhase('submitting', { address });
      try {
        const { txHash } = await api.submitTrustline(dealId, signed);
        return { address, txHash };
      } catch (e) {
        if (isExpiredError(e) && !renewed) {
          renewed = true;
          continue;
        }
        throw e;
      }
    }
  }

  /** Waits for the user's click, then has the wallet sign. `undefined` = expired before signing. */
  private async signGated(step: SignStep, item: Signable, address: string, renewed: boolean): Promise<string | undefined> {
    if (item.networkPassphrase !== this.deps.networkPassphrase) {
      throw new FlowError('network_mismatch', `server uses "${item.networkPassphrase}"`, {
        actual: item.networkPassphrase,
        expected: this.deps.networkPassphrase,
      });
    }
    this.deps.onPhase(step === 'challenge' ? 'confirm_challenge' : 'confirm_trustline', { address, renewed });
    await this.deps.confirm(step);
    if (this.now() >= item.deadline) return undefined;
    await this.ensureWalletNetwork();

    this.deps.onPhase(step === 'challenge' ? 'signing_challenge' : 'signing_trustline', { address, renewed });
    const { signedXdr, signerAddress } = await this.deps.wallet.sign(item.xdr, {
      networkPassphrase: item.networkPassphrase,
      address,
    });
    if (signerAddress && signerAddress !== address) {
      throw new FlowError('wrong_account', `wallet signed with ${signerAddress}, expected ${address}`, {
        actual: signerAddress,
        expected: address,
      });
    }
    return signedXdr;
  }

  private renewOrThrow(renewed: boolean, what: string): true {
    if (renewed) throw new FlowError('expired', `the ${what} expired again`);
    return true;
  }

  /** Fails when the wallet reports a different network; silent when it cannot tell. */
  private async ensureWalletNetwork(): Promise<void> {
    const current = await this.deps.wallet.currentNetwork();
    if (current !== undefined && current !== this.deps.networkPassphrase) {
      throw new FlowError('wrong_network', `wallet is on "${current}"`, {
        actual: current,
        expected: this.deps.networkPassphrase,
      });
    }
  }
}

export function isCancellation(e: unknown): boolean {
  return e instanceof WalletError && e.cancelled;
}
