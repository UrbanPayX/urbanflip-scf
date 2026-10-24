import { describe, expect, it } from 'vitest';
import * as SDK from '@stellar/stellar-sdk';
import { MemoryRailRegistry, splitByRail } from '../src';
import { displayAmount } from '../src/money';
// Cross-package handoff: the on-chain worklist feeds D3's SDP emitter verbatim.
import { computeDistribution } from '../../distribution-engine/src/compute/pro-rata';
import { emitSdpFiles } from '../../distribution-engine/src/emit/sdp-csv';
import { convertOnChain } from '../../distribution-engine/src/emit/usdc-conversion';

const ADDRESS = SDK.Keypair.random().publicKey();

describe('handoff into D3: on-chain worklist -> SDP payment file', () => {
  it('produces an SDP CSV containing exactly the on-chain cohort', async () => {
    const registry = new MemoryRailRegistry();
    registry.register({
      investorId: 'onchain-1',
      email: 'a@x.y',
      subscriptionRail: 'USDC_ONCHAIN',
      payoutRail: 'USDC_ONCHAIN',
      stellarAddress: ADDRESS,
      screeningRef: 'merkle-1',
    });
    registry.register({
      investorId: 'fiat-1',
      email: 'b@x.y',
      subscriptionRail: 'FIAT_WIRE',
      payoutRail: 'FIAT_BANK',
      stellarAddress: SDK.Keypair.random().publicKey(),
      iban: 'ES9121000418450200051332',
      bankAccountName: 'Maria Lopez',
    });

    // D3 computes the full-deal schedule once...
    const schedule = computeDistribution(
      {
        dealId: 'UF-0042',
        positions: [
          { investorId: 'onchain-1', email: 'a@x.y', principal: '30000.00', walletAddress: ADDRESS },
          { investorId: 'fiat-1', email: 'b@x.y', principal: '10000.00', walletAddress: SDK.Keypair.random().publicKey() },
        ],
      },
      { principalRepayment: '40000.00', performanceInterest: '8000.00' },
      { decimals: 2 },
    );

    // ...rails decide who gets paid on-chain...
    const worklists = await splitByRail(
      schedule.rows.map((r) => ({
        investorId: r.investorId,
        amount: displayAmount(r.totalStroops),
        stellarAddress: r.walletAddress!,
      })),
      registry,
    );

    // ...treasury buys USDC for the on-chain cohort's EUR 36,000 (at 1.085)...
    const conversion = convertOnChain(schedule, '39060.00', {
      onChainCohort: new Set(worklists.onChain.map((r) => r.stellarAddress)),
    });
    // ...and only the on-chain cohort enters the SDP file, in USDC.
    const files = emitSdpFiles(conversion);
    const csv = files[0]!.content.trim().split('\n');
    expect(csv).toHaveLength(2); // header + one payment
    expect(csv[1]).toBe(`39060.00,a@x.y,${ADDRESS},,`);
    expect(conversion.otherRail).toEqual([{ investorId: 'fiat-1', eur: '12000.00' }]);
    expect(worklists.bank).toHaveLength(1); // the fiat cohort went the other way
  });
});
