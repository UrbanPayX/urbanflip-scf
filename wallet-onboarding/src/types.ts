/** A wallet provisioned for an investor (embedded via Privy, or external via Wallets Kit). */
export interface WalletHandle {
  investorId: string;
  stellarAddress: string;
  provider: string;
}

/**
 * submitted: the transaction applied; the key is never rebuilt or resubmitted.
 * failed:    rejected with result codes; its operations had no effect, so the
 *            next call under the same key rebuilds and resubmits.
 * unknown:   no definitive answer (timeout, 504, dropped connection); the tx MAY
 *            still apply until its maxTime, so the next call resolves it by hash.
 */
export type SubmitStatus = 'submitted' | 'unknown' | 'failed';

export interface SubmitRecord {
  status: SubmitStatus;
  idempotencyKey: string;
  txHash?: string;
  /** Unix seconds after which the tx can no longer apply (its time bound). */
  maxTime?: number;
  txResultCode?: string;
  opResultCodes?: string[];
  attempts: number;
}

/** Summary of one investor's onboarding state — the zero-XLM proof lives here. */
export interface OnboardedInvestor {
  investorId: string;
  stellarAddress: string;
  /** Undefined when the account already existed and creation was skipped. */
  accountCreationTxHash?: string;
  trustlineTxHash?: string;
  xlmBalance: string;
}
