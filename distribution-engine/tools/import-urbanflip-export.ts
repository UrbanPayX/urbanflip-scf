import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { divHalfUp, formatCents, toRatio, toStroops, toUnitsExact } from '../src/money/stroops';
import {
  fixedInterestCents,
  daysBetween,
  type FixedAccrual,
  type WaterfallAdjustment,
  type WaterfallDeal,
  type WaterfallPosition,
  type WaterfallTerms,
} from '../src/compute/waterfall';
import type { RecordedSettlement, UnrecordedPosition } from '../src/compute/waterfall-replay';

/**
 * Turns Urbanflip's platform export (one investments_<deal> and one
 * returns_<deal> sheet per completed deal) into the public replay fixtures in
 * fixtures/real/. Run at Urbanflip, never in CI: the export and the salt stay
 * private, only the pseudonymized fixtures are published.
 *
 *   PSEUDONYM_SALT=<hex> npx tsx tools/import-urbanflip-export.ts <export.xlsx>
 *
 * - Investor ids become HMAC-SHA256(salt, "<dealId>:<profile id>"), per deal,
 *   so the same investor cannot be linked across deals without the salt.
 * - The export is checked for internal consistency (totals = fixed + variable,
 *   principal = what was invested, one payout date per deal...) and refused
 *   otherwise.
 * - The export carries no investor terms. Each position's fixed rate, fee
 *   share and withholding rate are read off its payout within closed sets
 *   ({8%, 9%}, {1, 0.5, 0}, {0, 19%, 10%}); anything outside them must be
 *   stated in the deal config, as a term or a manual adjustment with a reason.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '../fixtures/real/deals.config.json');
const OUT_DIR = join(here, '../fixtures/real');

const FIXED_RATES = ['0.08', '0.09'];
const WITHHOLDING_RATES = ['0', '0.19', '0.10'];
const FEE_SHARES = [1, 0.5];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface DealConfig {
  sheet: string;
  dealId: string;
  name: string;
  fixedAccrual: FixedAccrual;
  variableWeighting: WaterfallDeal['variableWeighting'];
  variablePool: string;
  feePool: string;
  rounding: NonNullable<WaterfallDeal['rounding']>;
  terms?: Record<string, Partial<WaterfallTerms>>;
  adjustments?: WaterfallAdjustment[];
  unrecorded?: UnrecordedPosition[];
  notes?: string[];
}

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const [exportPath] = process.argv.slice(2);
  const salt = process.env.PSEUDONYM_SALT ?? '';
  if (!exportPath) throw new Error('usage: PSEUDONYM_SALT=<hex> tsx tools/import-urbanflip-export.ts <export.xlsx>');
  if (!/^[0-9a-f]{64,}$/i.test(salt)) throw new Error('PSEUDONYM_SALT must be at least 32 bytes of hex');

  const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { deals: DealConfig[] };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(exportPath);

  const problems: string[] = [];
  const fixtures = config.deals.map((deal) => {
    const pseudonym = (profile: string) =>
      'inv-' + createHmac('sha256', Buffer.from(salt, 'hex')).update(`${deal.dealId}:${profile}`).digest('hex').slice(0, 12);
    const fixture = importDeal(deal, sheet(workbook, `investments_${deal.sheet}`), sheet(workbook, `returns_${deal.sheet}`), pseudonym, problems);
    return { deal, fixture };
  });
  // All or nothing: a refused export leaves the published fixtures untouched.
  if (problems.length > 0) {
    throw new Error(`export refused:\n  - ${problems.join('\n  - ')}`);
  }
  for (const { deal, fixture } of fixtures) {
    const file = join(OUT_DIR, `${deal.dealId}.json`);
    writeFileSync(file, JSON.stringify({ source: source(exportPath, deal), ...fixture! }, null, 2) + '\n');
    console.log(`${deal.name}: ${fixture!.deal.positions.length} positions, ${fixture!.recorded.length} settlements -> ${file}`);
  }
}

function importDeal(
  deal: DealConfig,
  investments: Row[],
  returns: Row[],
  pseudonym: (profile: string) => string,
  problems: string[],
) {
  const fail = (msg: string) => problems.push(`${deal.name}: ${msg}`);
  const returnsByProfile = new Map<string, Row>();
  for (const r of returns) {
    const profile = text(r.z_profile);
    if (returnsByProfile.has(profile)) fail(`two payouts for one profile (${pseudonym(profile)})`);
    returnsByProfile.set(profile, r);
  }

  const endDates = new Set(investments.map((i) => date(i.dateEndInvestment)));
  if (endDates.size !== 1) return void fail(`expected one payout date, found ${[...endDates].join(', ')}`);
  const [endDate] = [...endDates] as [string];

  const parsed = investments.map((inv) => {
    const profile = text(inv.z_profile);
    const id = pseudonym(profile);
    const check = (ok: boolean, what: string) => ok || fail(`${id}: ${what}`);
    check(text(inv.z_project) === deal.name, `project '${text(inv.z_project)}'`);
    check(text(inv.os_status) === 'Retornada', `investment status '${text(inv.os_status)}'`);
    const fixed = cents(inv.amountInvestedFixed);
    const variable = cents(inv.amountInvestedVariable);
    check(cents(inv.amountInvestedTotal) === fixed + variable, 'invested total != fixed + variable');
    const position = { id, startDate: date(inv.dateStartInvestment), fixed, variable };
    const ret = returnsByProfile.get(profile);
    returnsByProfile.delete(profile);
    if (!ret) return { position, record: undefined };

    check(text(ret.z_project) === deal.name, `payout project '${text(ret.z_project)}'`);
    check(text(ret.status) === 'Abonado', `payout status '${text(ret.status)}'`);
    check(date(ret.dateReturn) === endDate, `paid ${date(ret.dateReturn)}, not on the payout date ${endDate}`);
    check(cents(ret.amountPrincipalFixed) === fixed && cents(ret.amountPrincipalVariable) === variable, 'principal repaid != invested');
    check(cents(ret.amountPrincipalTotal) === fixed + variable, 'principal total != fixed + variable');
    check(cents(ret.amountFeeFixed) === 0n && cents(ret.amountFeeTotal) === cents(ret.amountFeeVariable), 'fee outside the variable tranche');
    const gf = cents(ret.amountInterestGrossFixed);
    const gv = cents(ret.amountInterestGrossVariable);
    check(cents(ret.amountInterestGrossTotal) === gf + gv, 'gross interest != fixed + variable');
    const record: RecordedSettlement = {
      investorId: id,
      principal: formatCents(cents(ret.amountPrincipalTotal)),
      fixedInterest: formatCents(gf),
      variableInterest: formatCents(gv),
      fee: formatCents(cents(ret.amountFeeTotal)),
      interestAfterFee: formatCents(cents(ret.cAmountInterestAfterFee)),
      withholding: formatCents(cents(ret.cAmountTax)),
      net: formatCents(cents(ret.cAmountNetPaymentAfterTax)),
    };
    return { position, record };
  });
  for (const profile of returnsByProfile.keys()) fail(`payout without an investment (${pseudonym(profile)})`);

  // Fee shares are classified against the deal's standard fee per euro of
  // variable interest: the median, since most positions pay the full fee.
  const ratios = parsed
    .map(({ record }) => record && Number(record.fee) > 0 && Number(record.fee) / Number(record.variableInterest))
    .filter((r): r is number => typeof r === 'number')
    .sort((a, b) => a - b);
  const standardFee = ratios[Math.floor(ratios.length / 2)] ?? 0;

  const positions: WaterfallPosition[] = parsed.map(({ position, record }) => {
    const override = deal.terms?.[position.id] ?? {};
    const days = daysBetween(position.startDate, endDate);
    const infer = (field: keyof WaterfallTerms, found: string | undefined): string => {
      const value = override[field] ?? found;
      if (value === undefined) {
        fail(
          record
            ? `${position.id}: no ${field} in {${candidates(field)}} reproduces its payout; state it in the config`
            : `${position.id}: no payout to read ${field} from; state it in the config`,
        );
        return '0';
      }
      return value;
    };
    const terms: WaterfallTerms = {
      fixedRate: infer(
        'fixedRate',
        position.fixed === 0n
          ? FIXED_RATES[0]
          : FIXED_RATES.find((r) => record && fixedInterestCents(position.fixed, r, days, deal.fixedAccrual) === cents(record.fixedInterest)),
      ),
      feeShare: infer('feeShare', record && feeShare(record, standardFee)),
      withholdingRate: infer(
        'withholdingRate',
        record &&
          WITHHOLDING_RATES.find((r) => {
            const [num, den] = toRatio(r);
            return divHalfUp(cents(record.interestAfterFee) * num, den) === cents(record.withholding);
          }),
      ),
    };
    return {
      investorId: position.id,
      startDate: position.startDate,
      fixedPrincipal: formatCents(position.fixed),
      variablePrincipal: formatCents(position.variable),
      terms,
    };
  });

  const order = (a: WaterfallPosition, b: WaterfallPosition) =>
    a.startDate === b.startDate ? (a.investorId < b.investorId ? -1 : 1) : a.startDate < b.startDate ? -1 : 1;
  positions.sort(order);
  const rank = new Map(positions.map((p, i) => [p.investorId, i]));
  const recorded = parsed
    .flatMap(({ record }) => (record ? [record] : []))
    .sort((a, b) => rank.get(a.investorId)! - rank.get(b.investorId)!);

  const waterfall: WaterfallDeal = {
    dealId: deal.dealId,
    endDate,
    fixedAccrual: deal.fixedAccrual,
    variableWeighting: deal.variableWeighting,
    variablePool: deal.variablePool,
    feePool: deal.feePool,
    rounding: deal.rounding,
    positions,
  };
  return { deal: waterfall, adjustments: deal.adjustments ?? [], unrecorded: deal.unrecorded ?? [], recorded };
}

function feeShare(record: RecordedSettlement, standardFee: number): string | undefined {
  if (Number(record.fee) === 0) return '0';
  const relative = Number(record.fee) / Number(record.variableInterest) / standardFee;
  // Classification only: the replay then checks every cent in exact arithmetic.
  const share = FEE_SHARES.find((s) => Math.abs(relative - s) < 0.005);
  return share === undefined ? undefined : String(share);
}

function candidates(field: keyof WaterfallTerms): string {
  if (field === 'fixedRate') return FIXED_RATES.join(', ');
  if (field === 'withholdingRate') return WITHHOLDING_RATES.join(', ');
  return [...FEE_SHARES, 0].join(', ');
}

function source(exportPath: string, deal: DealConfig) {
  return {
    deal: deal.name,
    export: `${basename(exportPath)}, sheets investments_${deal.sheet} + returns_${deal.sheet} (Urbanflip platform export)`,
    pseudonymization: 'investorId = "inv-" + first 12 hex of HMAC-SHA256(salt, "<dealId>:<platform profile id>"); the salt is held by Urbanflip only',
    terms:
      'fixedRate, feeShare and withholdingRate are not in the export: read off each payout within closed sets ({0.08, 0.09}, {1, 0.5, 0}, {0, 0.19, 0.10}) unless stated in fixtures/real/deals.config.json',
    notes: deal.notes ?? [],
  };
}

function sheet(workbook: ExcelJS.Workbook, name: string): Row[] {
  const ws = workbook.getWorksheet(name);
  if (!ws) throw new Error(`export has no sheet '${name}'`);
  const header = (ws.getRow(1).values as unknown[]).map((v) => (v == null ? '' : String(v)));
  const rows: Row[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values = row.values as unknown[];
    rows.push(Object.fromEntries(header.map((h, i) => [h, values[i]]).filter(([h]) => h !== '')));
  });
  return rows;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`expected text, got '${String(value)}'`);
  return value.trim();
}

/** A EUR cell (number or text) as exact cents; refuses anything finer than a cent. */
function cents(value: unknown): bigint {
  if (typeof value === 'string') return toUnitsExact(toStroops(value), 2);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`expected an amount, got '${String(value)}'`);
  const scaled = value * 100;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) throw new Error(`amount ${value} has more than 2 decimals`);
  return BigInt(Math.round(scaled));
}

/** 'Sep 17, 2025 12:00 am' -> '2025-09-17'. A time other than midnight is refused: settlement is by calendar day. */
function date(value: unknown): string {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) 12:00 am$/.exec(text(value));
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month < 0) throw new Error(`unexpected date '${String(value)}'`);
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
