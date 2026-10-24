import * as SDK from '@stellar/stellar-sdk';
import { toFailure, TransactionOutcomeUnknownError, type SubmitFailure } from '../stellar/tx-submitter';
import type { TransactionSubmitter } from '../stellar/tx-submitter';

/**
 * Investor-side helpers for demos, tests and dry-runs. In production these
 * operations live in the investor's wallet (Stellar Wallets Kit / Privy —
 * D2's scope), never in this service.
 */
export interface InvestorAccount {
  keypair: SDK.Keypair;
}

export function newInvestor(): InvestorAccount {
  return { keypair: SDK.Keypair.random() };
}

export async function fundFromFriendbot(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!res.ok) {
    throw new Error(`friendbot failed for ${address}: HTTP ${res.status}`);
  }
}

export async function establishTrustline(
  submitter: TransactionSubmitter,
  networkPassphrase: string,
  investor: InvestorAccount,
  asset: SDK.Asset,
  limit = '10000',
): Promise<string> {
  const account = await submitter.loadAccount(investor.keypair.publicKey());
  const tx = new SDK.TransactionBuilder(account, { networkPassphrase, fee: '100' })
    .addOperation(SDK.Operation.changeTrust({ asset, limit }))
    .setTimeout(30)
    .build();
  tx.sign(investor.keypair);
  const { hash } = await submitter.submit(tx);
  return hash;
}

export interface PaymentAttempt {
  ok: boolean;
  hash?: string;
  failure?: SubmitFailure;
}

/**
 * Submits a payment: a rejection is a *result* for the caller, not an error.
 * An unknown outcome is NOT a rejection (the payment may still apply), so it throws.
 */
export async function attemptPayment(
  submitter: TransactionSubmitter,
  networkPassphrase: string,
  from: SDK.Keypair,
  to: string,
  asset: SDK.Asset,
  amount: string,
): Promise<PaymentAttempt> {
  const account = await submitter.loadAccount(from.publicKey());
  const tx = new SDK.TransactionBuilder(account, { networkPassphrase, fee: '100' })
    .addOperation(SDK.Operation.payment({ destination: to, asset, amount }))
    .setTimeout(30)
    .build();
  tx.sign(from);
  try {
    const { hash } = await submitter.submit(tx);
    return { ok: true, hash };
  } catch (err) {
    if (err instanceof TransactionOutcomeUnknownError) throw err;
    const failure = toFailure(err);
    if (!failure.opResultCodes && !failure.txResultCode) {
      const e = err as { message?: string };
      console.error('[attemptPayment] rejected without result codes:', e?.message ?? err);
    }
    return { ok: false, failure };
  }
}
