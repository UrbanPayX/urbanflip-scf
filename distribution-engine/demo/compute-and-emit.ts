import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';

const here = dirname(fileURLToPath(import.meta.url));
import { computeDistribution } from '../src/compute/pro-rata';
import { replayDeal } from '../src/compute/replay';
import { emitSdpFiles } from '../src/emit/sdp-csv';
import { convertOnChain } from '../src/emit/usdc-conversion';
import { displayAmount, fromUnits, toStroops } from '../src/money/stroops';

/**
 * D3 demo: replay a completed deal exactly, compute a live EUR distribution at
 * on-chain precision, convert it at the USDC the treasury actually bought, and
 * emit the SDP payment file. Run: npm run demo
 */
function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(here, '../fixtures', `${name}.json`), 'utf8')) as {
    ledger: Parameters<typeof computeDistribution>[0];
    outcome: Parameters<typeof computeDistribution>[1];
    policy: 'largest-remainder' | 'last-absorbs';
    historicalPayouts: Array<{ investorId: string; amount: string }>;
  };
}

function main(): void {
  const fx = loadFixture('deal-salamanca-003');

  console.log('=== 1. Replay of completed deal', fx.ledger.dealId, '===');
  const report = replayDeal(fx.ledger, fx.outcome, fx.historicalPayouts, {
    decimals: 2,
    remainderPolicy: fx.policy,
  });
  console.log(`   ${report.comparedRows} investors | match: ${report.match}`);
  console.log(
    `   recorded total EUR ${(Number(report.recordedTotalStroops) / 1e7).toFixed(2)} == computed ${(Number(report.computedTotalStroops) / 1e7).toFixed(2)}`,
  );

  console.log('\n=== 2. Fresh distribution at on-chain (stroop) precision ===');
  const walletified = {
    ...fx.ledger,
    positions: fx.ledger.positions.map((p, i) => ({
      ...p,
      walletAddress: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, i + 1)),
    })),
  };
  const schedule = computeDistribution(walletified, fx.outcome, { decimals: 7 });
  for (const row of schedule.rows.slice(0, 5)) {
    console.log(
      `   ${row.investorId.padEnd(9)} principal ${displayAmount(row.principalStroops).padStart(12)}  interest ${displayAmount(row.interestStroops).padStart(12)}  total ${displayAmount(row.totalStroops).padStart(12)}`,
    );
  }
  console.log(`   ... ${schedule.rows.length} rows; totals exact:`, {
    principal: displayAmount(schedule.totals.principalStroops),
    interest: displayAmount(schedule.totals.interestStroops),
  });

  console.log('\n=== 3. EUR -> USDC: split the USDC the treasury bought, exact to the cent ===');
  // Treasury bought at ~1.0850 USDC/EUR; the fill is what it is, to the cent.
  const usdcFunded = displayAmount(fromUnits((schedule.totals.totalStroops * 10850n) / 10n ** 9n, 2));
  const conversion = convertOnChain(schedule, usdcFunded);
  for (const p of conversion.payouts.slice(0, 5)) {
    console.log(`   ${p.investorId.padEnd(9)} EUR ${p.eur.padStart(14)}  ->  USDC ${p.usdc.padStart(12)}`);
  }
  console.log(`   EUR ${conversion.eurTotal} -> USDC ${conversion.usdcTotal} at ${conversion.rate} USDC/EUR`);

  console.log('\n=== 4. SDP payment file, USDC amounts (first 4 lines) ===');
  const files = emitSdpFiles(conversion);
  console.log('   file:', files[0]!.name, '| rows:', files[0]!.rowCount);
  console.log(files[0]!.content.split('\n').slice(0, 4).map((l) => '   ' + l).join('\n'));
  console.log('\nall row sums equal outcome totals:', schedule.totals.totalStroops === toStroops(fx.outcome.principalRepayment) + toStroops(fx.outcome.performanceInterest));
  console.log(
    'USDC rows sum to usdcFunded:',
    conversion.payouts.reduce((a, p) => a + toStroops(p.usdc), 0n) === toStroops(usdcFunded),
  );
}

main();
