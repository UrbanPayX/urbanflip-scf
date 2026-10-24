import { StrKey } from '@stellar/stellar-sdk';
import { allocate, type DistributionSchedule } from '../compute/pro-rata';
import { displayAmount, fromUnits, toStroops } from '../money/stroops';

/**
 * Distributions are owed in EUR; investors paid on-chain receive USDC. The
 * treasury converts the cohort's EUR total, and the USDC it actually bought
 * (`usdcFunded`) is split pro-rata to each investor's EUR payout, exact to the
 * cent (largest remainder, ties by investorId). The batch pays precisely what
 * was funded and every investor gets the same rate.
 */

/** USDC-per-EUR sanity bounds [numerator, denominator]: wide enough for any
 * real market, narrow enough to catch a swapped or mistyped amount. */
export const MIN_USDC_PER_EUR: readonly [bigint, bigint] = [1n, 2n];
export const MAX_USDC_PER_EUR: readonly [bigint, bigint] = [2n, 1n];

const STROOPS_PER_CENT = fromUnits(1n, 2);

/** One on-chain payout: the investor's EUR distribution and the USDC sent for it. */
export interface UsdcPayout {
  investorId: string;
  email: string;
  /** Validated Stellar account (G... StrKey). */
  destination: string;
  /** EUR owed per the schedule. */
  eur: string;
  /** USDC paid for it, exactly 2 decimals. */
  usdc: string;
}

/** A schedule row left to another rail (bank transfer) by `onChainCohort`. */
export interface OtherRailRow {
  investorId: string;
  eur: string;
}

export interface UsdcConversion {
  dealId: string;
  payouts: UsdcPayout[];
  /** Rows outside `onChainCohort`: owed in EUR, paid by bank. Never dropped silently. */
  otherRail: OtherRailRow[];
  otherRailEurTotal: string;
  eurTotal: string;
  /** Equals usdcFunded: the sum of payouts, to the cent. */
  usdcTotal: string;
  /** USDC per EUR actually achieved, 6 decimals, display only. */
  rate: string;
}

export interface ConvertOptions {
  /**
   * The investors paid on-chain (their wallet addresses), for a deal whose
   * other investors are paid by bank. Only these rows are converted; every
   * other row is returned in `otherRail` with its EUR amount, and every
   * cohort address must appear in the schedule. Without it, every row must
   * be payable on-chain.
   */
  onChainCohort?: Set<string>;
  /**
   * READY destinations (result of a trustline pre-check). Every row's wallet
   * must be in the set and every address in the set must be in the schedule.
   */
  onlyAddresses?: Set<string>;
}

export function convertOnChain(
  schedule: DistributionSchedule,
  usdcFunded: string,
  options: ConvertOptions = {},
): UsdcConversion {
  const { onlyAddresses, onChainCohort } = options;
  if (onChainCohort) {
    const destinations = new Set(schedule.rows.map((row) => row.walletAddress));
    const missing = [...onChainCohort].filter((address) => !destinations.has(address));
    if (missing.length > 0) {
      throw new Error(`${missing.length} on-chain cohort addresses are missing from the schedule (first: ${missing[0]})`);
    }
  }
  const inCohort = (row: DistributionSchedule['rows'][number]) =>
    !onChainCohort || (row.walletAddress !== undefined && onChainCohort.has(row.walletAddress));
  const otherRail = schedule.rows.filter((row) => !inCohort(row));
  schedule = { ...schedule, rows: schedule.rows.filter(inCohort) };
  const unpayable = schedule.rows.filter(
    (row) => !row.walletAddress || (onlyAddresses !== undefined && !onlyAddresses.has(row.walletAddress)),
  );
  if (unpayable.length > 0) {
    // Silent exclusions would be an audit nightmare: callers pre-check and decide.
    throw new Error(
      `${unpayable.length} rows lack a wallet address or failed the address filter; ` +
        `resolve addresses or widen the filter explicitly`,
    );
  }
  if (onlyAddresses) {
    // A requested destination absent from the schedule means the filter and the
    // schedule disagree on who is owed — refuse rather than guess.
    const destinations = new Set(schedule.rows.map((row) => row.walletAddress));
    const missing = [...onlyAddresses].filter((address) => !destinations.has(address));
    if (missing.length > 0) {
      throw new Error(`${missing.length} requested addresses are missing from the schedule (first: ${missing[0]})`);
    }
  }
  for (const row of schedule.rows) assertStellarAddress(row.walletAddress!, row.investorId);

  const usdcStroops = toStroops(usdcFunded);
  if (usdcStroops % STROOPS_PER_CENT !== 0n) {
    throw new Error(`usdcFunded '${usdcFunded}' must have at most 2 decimals`);
  }
  const eurTotal = schedule.rows.reduce((a, r) => a + r.totalStroops, 0n);
  if (eurTotal === 0n) throw new Error('schedule pays no EUR; nothing to convert');
  checkRate(usdcStroops, eurTotal);

  const cents = allocate(
    usdcStroops / STROOPS_PER_CENT,
    schedule.rows.map((r) => r.totalStroops),
    'largest-remainder',
    schedule.rows.map((r) => r.investorId),
  );
  const payouts = schedule.rows.map((row, i) => ({
    investorId: row.investorId,
    email: row.email,
    destination: row.walletAddress!,
    eur: displayAmount(row.totalStroops),
    usdc: displayAmount(fromUnits(cents[i]!, 2)),
  }));
  const zero = payouts.find((p) => p.usdc === '0.00');
  if (zero) {
    // The SDP rejects zero payments; a dust payout belongs on the bank rail.
    throw new Error(`investor '${zero.investorId}' would receive 0.00 USDC (EUR ${zero.eur}); pay it by bank`);
  }

  return {
    dealId: schedule.dealId,
    payouts,
    otherRail: otherRail.map((row) => ({ investorId: row.investorId, eur: displayAmount(row.totalStroops) })),
    otherRailEurTotal: displayAmount(otherRail.reduce((a, r) => a + r.totalStroops, 0n)),
    eurTotal: displayAmount(eurTotal),
    usdcTotal: displayAmount(usdcStroops),
    rate: rateDisplay(usdcStroops, eurTotal),
  };
}

/** Refuses a USDC/EUR pair whose implied rate is outside the sanity bounds. */
export function checkRate(usdcStroops: bigint, eurStroops: bigint): void {
  if (usdcStroops <= 0n || eurStroops <= 0n) throw new Error('USDC and EUR amounts must be positive');
  const [minN, minD] = MIN_USDC_PER_EUR;
  const [maxN, maxD] = MAX_USDC_PER_EUR;
  if (usdcStroops * minD < eurStroops * minN || usdcStroops * maxD > eurStroops * maxN) {
    throw new Error(
      `implied rate ${rateDisplay(usdcStroops, eurStroops)} USDC per EUR is outside ` +
        `${rateDisplay(minN, minD)}-${rateDisplay(maxN, maxD)}; check the amounts`,
    );
  }
}

/** USDC per EUR to 6 decimals (floored), for display only. */
export function rateDisplay(usdcStroops: bigint, eurStroops: bigint): string {
  const micro = (usdcStroops * 1_000_000n) / eurStroops;
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`;
}

/**
 * Destinations come from the POSTed ledger and land verbatim in the SDP file:
 * only a Stellar account StrKey (G..., checksum verified) is accepted.
 */
export function assertStellarAddress(address: string, investorId: string): void {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(`investor '${investorId}': wallet address '${address}' is not a valid Stellar account (G... StrKey)`);
  }
}
