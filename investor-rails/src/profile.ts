/**
 * The rail model: how a given investor's money moves, independent of the
 * participation token (every investor gets one, whatever their rails).
 *
 *   subscription rail — money IN
 *     FIAT_WIRE     bank transfer into the deal's SPV (the default, unchanged)
 *     USDC_ONCHAIN  investor pays USDC from THEIR OWN wallet to the company
 *                   collection address; aggregated and off-ramped at raise close
 *
 *   payout rail — money OUT at distribution
 *     FIAT_BANK     SEPA transfer as today
 *     USDC_ONCHAIN  USDC to their wallet via the SDP batch
 */
export type SubscriptionRail = 'FIAT_WIRE' | 'USDC_ONCHAIN';
export type PayoutRail = 'FIAT_BANK' | 'USDC_ONCHAIN';

export interface InvestorProfile {
  investorId: string;
  email: string;
  subscriptionRail: SubscriptionRail;
  payoutRail: PayoutRail;
  /** Wallet holding the participation asset. Every investor has one (D2). */
  stellarAddress: string;
  /** Required when payoutRail is FIAT_BANK. */
  iban?: string;
  /** Account holder name for the bank file. */
  bankAccountName?: string;
  /**
   * Merkle Science screening reference (T2 deliverable). Required before a
   * USDC_ONCHAIN subscription rail may be used — no screening, no trustline.
   */
  screeningRef?: string;
}

export type ProfileProblem = string[];

/** Cross-field rules the backend must not let through. */
export function validateProfile(profile: InvestorProfile): ProfileProblem {
  const problems: ProfileProblem = [];
  if (!/^[A-Z2-7]{56}$/.test(profile.stellarAddress)) {
    problems.push('stellarAddress must be a valid StrKey address');
  }
  if (profile.payoutRail === 'FIAT_BANK') {
    if (!profile.iban) problems.push('FIAT_BANK payout requires an iban');
    if (!profile.bankAccountName) problems.push('FIAT_BANK payout requires a bankAccountName');
  }
  if (profile.subscriptionRail === 'USDC_ONCHAIN' && !profile.screeningRef) {
    problems.push('USDC_ONCHAIN subscription requires wallet screening evidence (screeningRef)');
  }
  return problems;
}

/** Storage port; production backs this with the platform database. */
export interface RailRegistry {
  put(profile: InvestorProfile): Promise<void> | void;
  get(investorId: string): Promise<InvestorProfile | undefined> | InvestorProfile | undefined;
  all(): Promise<InvestorProfile[]> | InvestorProfile[];
}

export class MemoryRailRegistry implements RailRegistry {
  private readonly profiles = new Map<string, InvestorProfile>();

  register(profile: InvestorProfile): void {
    const problems = validateProfile(profile);
    if (problems.length > 0) throw new Error(`invalid profile: ${problems.join('; ')}`);
    this.profiles.set(profile.investorId, profile);
  }

  put(profile: InvestorProfile): void {
    this.register(profile);
  }

  get(investorId: string): InvestorProfile | undefined {
    return this.profiles.get(investorId);
  }

  all(): InvestorProfile[] {
    return [...this.profiles.values()];
  }
}
