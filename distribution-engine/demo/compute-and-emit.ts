import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';

const here = dirname(fileURLToPath(import.meta.url));
import { computeWaterfall, toDistributionSchedule, type WaterfallDeal } from '../src/compute/waterfall';
import { replayWaterfall } from '../src/compute/waterfall-replay';
import { emitSdpFiles } from '../src/emit/sdp-csv';
import { convertOnChain } from '../src/emit/usdc-conversion';
import { displayAmount, formatCents, fromUnits, toStroops } from '../src/money/stroops';

/**
 * D3 demo: replay the three completed real deals to the cent, recompute one of
 * them as a live payout (exact pools, on-chain wallets), convert it at the USDC
 * the treasury actually bought, and emit the SDP payment file. Run: npm run demo
 */
function loadReal(name: string) {
  return JSON.parse(readFileSync(join(here, '../fixtures/real', `${name}.json`), 'utf8')) as Parameters<
    typeof replayWaterfall
  >[2] & { deal: WaterfallDeal; recorded: Parameters<typeof replayWaterfall>[1] };
}

function main(): void {
  console.log('=== 1. Replay of the three completed real deals ===');
  for (const name of ['velazquez-87', 'orense-9', 'general-peron-26']) {
    const fx = loadReal(name);
    const report = replayWaterfall(fx.deal, fx.recorded, fx);
    console.log(
      `   ${name.padEnd(17)} ${report.comparedRows} settlements, ${report.comparedValues} amounts | match: ${report.match} | net paid EUR ${formatCents(report.recordedTotals.net)}`,
    );
  }

  console.log('\n=== 2. The same waterfall as a live payout: exact pools, wallets attached ===');
  const fx = loadReal('general-peron-26');
  const live: WaterfallDeal = {
    ...fx.deal,
    rounding: 'largest-remainder',
    positions: fx.deal.positions.map((p, i) => ({
      ...p,
      email: `${p.investorId}@example.com`,
      walletAddress: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, i + 1)),
    })),
  };
  const result = computeWaterfall(live);
  for (const row of result.rows.slice(0, 5)) {
    console.log(
      `   ${row.investorId}  fixed ${formatCents(row.fixedInterestCents).padStart(9)}  variable ${formatCents(row.variableInterestCents).padStart(10)}  fee ${formatCents(row.feeCents).padStart(9)}  withholding ${formatCents(row.withholdingCents).padStart(9)}  net ${formatCents(row.netCents).padStart(11)}`,
    );
  }
  console.log(`   ... ${result.rows.length} rows; residual (pool - rows):`, {
    variable: formatCents(result.residual.variableCents),
    fee: formatCents(result.residual.feeCents),
  });

  console.log('\n=== 3. EUR -> USDC: split the USDC the treasury bought, exact to the cent ===');
  const schedule = toDistributionSchedule(result);
  // Treasury bought at ~1.0850 USDC/EUR; the fill is what it is, to the cent.
  const usdcFunded = displayAmount(fromUnits((schedule.totals.totalStroops * 10850n) / 10n ** 9n, 2));
  const conversion = convertOnChain(schedule, usdcFunded);
  for (const p of conversion.payouts.slice(0, 5)) {
    console.log(`   ${p.investorId}  EUR ${p.eur.padStart(14)}  ->  USDC ${p.usdc.padStart(12)}`);
  }
  console.log(`   EUR ${conversion.eurTotal} -> USDC ${conversion.usdcTotal} at ${conversion.rate} USDC/EUR`);

  console.log('\n=== 4. SDP payment file, USDC amounts (first 4 lines) ===');
  const files = emitSdpFiles(conversion);
  console.log('   file:', files[0]!.name, '| rows:', files[0]!.rowCount);
  console.log(files[0]!.content.split('\n').slice(0, 4).map((l) => '   ' + l).join('\n'));
  console.log('\nresiduals are zero (rows sum to the pools):', result.residual.variableCents === 0n && result.residual.feeCents === 0n);
  console.log(
    'USDC rows sum to usdcFunded:',
    conversion.payouts.reduce((a, p) => a + toStroops(p.usdc), 0n) === toStroops(usdcFunded),
  );
}

main();
