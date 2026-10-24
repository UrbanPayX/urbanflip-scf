import type { InvestorProfile, RailRegistry } from '../profile';
import { displayAmount, fromStroops, toStroops } from '../money';

/** A payout row as produced by the D3 distribution schedule. */
export interface PayoutRow {
  investorId: string;
  /** Total to pay (decimal string). */
  amount: string;
  stellarAddress: string;
}

export interface PayoutWorklists {
  /** On-chain cohort: destination wallets for the SDP batch (USDC). */
  onChain: Array<PayoutRow & { stellarAddress: string }>;
  /** Fiat cohort: SEPA transfers from the SPV account. */
  bank: Array<PayoutRow & { iban: string; bankAccountName: string }>;
  /** Every schedule row accounted for, exactly once. */
  totals: { onChain: string; bank: string; combined: string };
}

/**
 * Distribution-day rail split: one schedule, two worklists, chosen by each
 * investor's payout rail. Unknown investors or missing rail prerequisites are
 * FATAL — a payout may never silently drop or default to the wrong rail.
 */
export async function splitByRail(
  rows: PayoutRow[],
  registry: RailRegistry,
): Promise<PayoutWorklists> {
  const onChain: PayoutWorklists['onChain'] = [];
  const bank: PayoutWorklists['bank'] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.investorId)) throw new Error(`duplicate payout row for ${row.investorId}`);
    seen.add(row.investorId);
    const profile = await registry.get(row.investorId);
    if (!profile) throw new Error(`no rail profile for ${row.investorId}; refusing to route payout`);
    if (profile.payoutRail === 'USDC_ONCHAIN') {
      onChain.push({ ...row, stellarAddress: profile.stellarAddress });
    } else {
      if (!profile.iban || !profile.bankAccountName) {
        throw new Error(`${row.investorId} chose FIAT_BANK but rail prerequisites are missing`);
      }
      bank.push({ ...row, iban: profile.iban, bankAccountName: profile.bankAccountName });
    }
  }

  const onChainTotal = stroopsOf(onChain);
  const bankTotal = stroopsOf(bank);
  return {
    onChain,
    bank,
    totals: {
      onChain: fromStroops(onChainTotal),
      bank: fromStroops(bankTotal),
      combined: fromStroops(onChainTotal + bankTotal),
    },
  };
}

/**
 * Bank file for the fiat cohort: a SEPA credit-transfer worklist for the
 * SPV's bank (or treasury tool) — the file equivalent of today's manual run,
 * but generated, exact, and reconcilable against the schedule.
 */
export function emitBankFile(worklist: PayoutWorklists['bank'], args: { dealId: string; remitterName: string; remitterIban: string }): string {
  const lines = [
    `# SEPA worklist ${args.dealId} — ${worklist.length} payments — ${sumOf(worklist)} EUR total`,
    `# remitter: ${args.remitterName} (${args.remitterIban})`,
    'amount,iban,beneficiary,remittance_information',
  ];
  for (const row of worklist) {
    lines.push(
      [row.amount, row.iban, csv(row.bankAccountName), csv(`UF ${args.dealId} payout ${row.investorId}`)].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function stroopsOf(list: Array<{ amount: string }>): bigint {
  return list.reduce((a, r) => a + toStroops(r.amount), 0n);
}

function sumOf(list: Array<{ amount: string }>): string {
  return displayAmount(stroopsOf(list), 2);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
