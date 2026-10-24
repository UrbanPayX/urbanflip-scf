import { describe, expect, it } from 'vitest';
import * as SDK from '@stellar/stellar-sdk';
import {
  CryptoCollectionService,
  OffRampQueue,
  eligibility,
  emitBankFile,
  shortfallEur,
  MemoryRailRegistry,
  splitByRail,
  type IncomingPaymentObserver,
  type ObservedPayment,
  type PaymentRequest,
} from '../src';

const ADDRESS = SDK.Keypair.random().publicKey();
const USDC = { code: 'USDC', issuer: 'G' + 'A'.repeat(55) };
const COLLECTION = SDK.Keypair.random().publicKey();

function profile(overrides: Partial<Parameters<MemoryRailRegistry['register']>[0]> = {}) {
  return {
    investorId: 'inv-1',
    email: 'inv@example.com',
    subscriptionRail: 'USDC_ONCHAIN' as const,
    payoutRail: 'USDC_ONCHAIN' as const,
    stellarAddress: ADDRESS,
    screeningRef: 'merkle-123',
    ...overrides,
  };
}

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    subscriptionRef: 's1',
    investorId: 'inv-1',
    dealId: 'UF-0042',
    eurAmount: '25000.00',
    usdcAmount: '25000.00',
    collectionAddress: COLLECTION,
    asset: USDC,
    ...overrides,
  };
}

/** An on-chain payment into the collection address carrying `memo`. */
function paid(memo: string, amount: string, overrides: Partial<ObservedPayment> = {}): ObservedPayment {
  return {
    txHash: Buffer.from(memo).toString('hex').padEnd(64, '0').slice(0, 64),
    from: ADDRESS,
    to: COLLECTION,
    amount,
    asset: USDC,
    memo,
    createdAt: '2026-10-23T10:00:00Z',
    ...overrides,
  };
}

/** A collection service over a fake chain the test appends payments to. */
function collectionBook() {
  const chain: ObservedPayment[] = [];
  const svc = new CryptoCollectionService({ observer: { incoming: async () => chain } });
  return { svc, chain };
}

/** Expects a subscription for deal UF-0042 and reconciles its exact payment. */
async function collect(
  book: ReturnType<typeof collectionBook>,
  subscriptionRef: string,
  investorId: string,
  eurAmount: string,
  usdcAmount: string,
): Promise<void> {
  const expected = book.svc.expectPayment(request({ subscriptionRef, investorId, eurAmount, usdcAmount }));
  book.chain.push(paid(expected.memo, usdcAmount));
  await book.svc.reconcile();
  expect(book.svc.record(subscriptionRef)!.state).toBe('RECONCILED');
}

describe('rail profiles', () => {
  it('accepts a complete profile and enforces cross-field rules', () => {
    const registry = new MemoryRailRegistry();
    expect(() => registry.register(profile())).not.toThrow();

    expect(() => registry.register(profile({ iban: undefined, bankAccountName: undefined }))).not.toThrow();
    expect(() =>
      // crypto subscription without screening evidence is rejected
      registry.register(profile({ investorId: 'inv-2', screeningRef: undefined })),
    ).toThrow(/screening/);
    expect(() =>
      // fiat payout without bank details is rejected
      registry.register(profile({ investorId: 'inv-3', payoutRail: 'FIAT_BANK' as const, iban: undefined })),
    ).toThrow(/iban/);
    expect(() =>
      registry.register(profile({ investorId: 'inv-4', stellarAddress: 'not-an-address' })),
    ).toThrow(/stellarAddress/);
  });
});

describe('crypto-native collection (own wallet -> company wallet)', () => {
  function observerWith(payments: ObservedPayment[]): IncomingPaymentObserver {
    return { incoming: async () => payments };
  }

  function serviceWith(payments: ObservedPayment[]): CryptoCollectionService {
    return new CryptoCollectionService({ observer: observerWith(payments) });
  }

  const expected = request({
    subscriptionRef: 'sub-2026-0042-1',
    eurAmount: '23041.47',
    usdcAmount: '25000.0000000',
    quoteRef: 'ramp-q-77',
  });

  it('settles on an exact memo + amount + asset match, with the tx hash as evidence', async () => {
    const svc = serviceWith([
      {
        txHash: 'a'.repeat(64),
        from: ADDRESS,
        to: COLLECTION,
        amount: '25000.0000000',
        asset: USDC,
        memo: 'UF-UF-0042-sub-2026-0042-1',
        createdAt: '2026-10-23T10:00:00Z',
      },
    ]);
    expect(svc.expectPayment(expected)).toMatchObject({ memo: 'UF-UF-0042-sub-2026-0042-1', quoteRef: 'ramp-q-77' });
    await svc.reconcile();
    const record = svc.record('sub-2026-0042-1')!;
    expect(record.state).toBe('RECONCILED');
    expect(record.settledBy?.txHash).toBe('a'.repeat(64));
    expect(svc.reconciledTotal('UF-0042')).toEqual({ count: 1, totalUsdc: '25000.0000000', totalEur: '23041.4700000' });
  });

  it('hands out copies, so a caller cannot change a collection by accident', async () => {
    const svc = serviceWith([]);
    svc.expectPayment(expected);
    svc.record('sub-2026-0042-1')!.state = 'RECONCILED';
    expect(svc.record('sub-2026-0042-1')!.state).toBe('PENDING');
    expect(svc.reconciledFor('UF-0042')).toEqual([]);
  });

  it('flags a memo-matched payment with the wrong amount as MISMATCH — never auto-credited', async () => {
    const svc = serviceWith([
      { txHash: 'b'.repeat(64), from: ADDRESS, to: COLLECTION, amount: '24000.0000000', asset: USDC, memo: 'UF-UF-0042-sub-2026-0042-1', createdAt: 'x' },
    ]);
    svc.expectPayment(expected);
    await svc.reconcile();
    expect(svc.record('sub-2026-0042-1')!.state).toBe('MISMATCH');
  });

  it('leaves unmatched expectations PENDING', async () => {
    const svc = serviceWith([]);
    svc.expectPayment(expected);
    await svc.reconcile();
    expect(svc.record('sub-2026-0042-1')!.state).toBe('PENDING');
  });

  it('matches the quoted USDC amount, not the EUR commitment', async () => {
    const book = collectionBook();
    const s1 = book.svc.expectPayment(request({ subscriptionRef: 's1', eurAmount: '10000.00', usdcAmount: '10850.00' }));
    const s2 = book.svc.expectPayment(request({ subscriptionRef: 's2', eurAmount: '10000.00', usdcAmount: '10850.00' }));
    book.chain.push(paid(s1.memo, '10000.0000000'), paid(s2.memo, '10850.0000000'));
    await book.svc.reconcile();
    expect(book.svc.record('s1')).toMatchObject({ state: 'MISMATCH', mismatchReason: expect.stringContaining('expected 10850.00 USDC') });
    expect(book.svc.record('s2')!.state).toBe('RECONCILED');
  });

  it('refuses a duplicate subscription instead of resetting the settled record', async () => {
    const book = collectionBook();
    await collect(book, 's1', 'inv-1', '10.00', '10.00');
    expect(() => book.svc.expectPayment(request({ subscriptionRef: 's1', investorId: 'inv-9' }))).toThrow(/already expected/);
    expect(book.svc.record('s1')).toMatchObject({ state: 'RECONCILED', expected: { investorId: 'inv-1' } });
    expect(book.svc.record('s1')!.settledBy).toBeDefined();
  });

  it('refuses a memo that exceeds MEMO_TEXT (28 bytes) or collides with another subscription', () => {
    const { svc } = collectionBook();
    // UF-UF-0042-<17 chars> is exactly 28 bytes; one more is refused.
    expect(svc.expectPayment(request({ subscriptionRef: 'sub-2026-0042-001' })).memo).toHaveLength(28);
    expect(() => svc.expectPayment(request({ subscriptionRef: 'subscription-000001' }))).toThrow(/28 bytes/);
    // bytes, not characters: 27 characters, 29 bytes
    expect(() => svc.expectPayment(request({ subscriptionRef: 'sub-2026-0042-éé' }))).toThrow(/28 bytes/);
    // Deal "A-B" ref "C" and deal "A" ref "B-C" would share memo UF-A-B-C.
    svc.expectPayment(request({ subscriptionRef: 'C', dealId: 'A-B' }));
    expect(() => svc.expectPayment(request({ subscriptionRef: 'B-C', dealId: 'A', investorId: 'inv-2' }))).toThrow(/already used/);
    expect(svc.record('B-C')).toBeUndefined();
  });

  it('validates amounts and refuses quotes outside sane USDC/EUR rates', () => {
    const { svc } = collectionBook();
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a1', usdcAmount: 'ten' }))).toThrow(/invalid decimal/);
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a2', eurAmount: '-5' }))).toThrow(/invalid decimal/);
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a3', eurAmount: '10000', usdcAmount: '0' }))).toThrow(/positive/);
    // a mistyped or swapped quote implies an absurd rate
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a4', eurAmount: '10000', usdcAmount: '100' }))).toThrow(/implied rate 0.010000/);
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a5', eurAmount: '100', usdcAmount: '10850' }))).toThrow(/implied rate 108.500000/);
    expect(() => svc.expectPayment(request({ subscriptionRef: 'a6', eurAmount: '10000', usdcAmount: '10850' }))).not.toThrow();
  });

  it("ignores another issuer's USDC: the record stays PENDING until the real asset arrives", async () => {
    const book = collectionBook();
    const s1 = book.svc.expectPayment(request({ subscriptionRef: 's1' }));
    book.chain.push(paid(s1.memo, '25000.00', { txHash: 'f'.repeat(64), asset: { code: 'USDC', issuer: 'G' + 'B'.repeat(55) } }));
    await book.svc.reconcile();
    expect(book.svc.record('s1')!.state).toBe('PENDING');

    book.chain.push(paid(s1.memo, '25000.00'));
    await book.svc.reconcile();
    expect(book.svc.record('s1')!.settledBy?.asset).toEqual(USDC);
  });

  it('lets one payment (tx hash) settle at most one subscription', async () => {
    const book = collectionBook();
    const s1 = book.svc.expectPayment(request({ subscriptionRef: 's1' }));
    const s2 = book.svc.expectPayment(request({ subscriptionRef: 's2' }));
    // A misbehaving observer reports the same tx under two memos.
    const tx = 'c'.repeat(64);
    book.chain.push(paid(s1.memo, '25000.00', { txHash: tx }), paid(s2.memo, '25000.00', { txHash: tx }));
    await book.svc.reconcile();
    expect(book.svc.record('s1')!.state).toBe('RECONCILED');
    expect(book.svc.record('s2')!.state).toBe('PENDING');

    // ...nor in a later round.
    const s3 = book.svc.expectPayment(request({ subscriptionRef: 's3' }));
    book.chain.push(paid(s3.memo, '25000.00', { txHash: tx }));
    await book.svc.reconcile();
    expect(book.svc.record('s3')!.state).toBe('PENDING');
    expect(book.svc.reconciledFor('UF-0042').map((r) => r.expected.subscriptionRef)).toEqual(['s1']);
  });
});

describe('raise-close off-ramp and issuance eligibility', () => {
  const IBAN = 'ES9121000418450200051332';

  it('slices the aggregate, and EUR-at-SPV (bankRef) unlocks crypto settlements at their EUR amount', async () => {
    const book = collectionBook();
    await collect(book, 'c1', 'inv-1', '30000.00', '32550.00');
    await collect(book, 'c2', 'inv-2', '45000.00', '48825.00');

    const queue = new OffRampQueue();
    const instruction = queue.build({
      dealId: 'UF-0042',
      reconciled: book.svc.reconciledFor('UF-0042'),
      targetIban: IBAN,
      maxSliceUsdc: '50000',
    });
    expect(instruction).toMatchObject({
      batch: 1,
      totalUsdc: '81375.0000000',
      eurCommitted: '75000.0000000',
      paymentCount: 2,
      subscriptionRefs: ['c1', 'c2'],
      status: 'PENDING',
    });
    expect(instruction.slices).toEqual(['50000.0000000', '31375.0000000']);

    const fiat = [{ subscriptionRef: 'f1', investorId: 'inv-fiat', amount: '10000.00', bankRef: 'TRF-1' }];
    // before completion: crypto settlements are NOT eligible — EUR not at SPV
    const before = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: fiat });
    expect(before.filter((e) => !e.eligible)).toHaveLength(2);
    expect(before.every((e) => e.eligible || e.reason.includes('off-ramp'))).toBe(true);

    const done = queue.complete('UF-0042', 'TRF-OFFRAMP-9', '75000.00');
    expect(done).toMatchObject({ status: 'EXECUTED', eurReceived: '75000.0000000', fxResultEur: '0.0000000' });
    const after = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: fiat });
    expect(after.filter((e) => e.eligible).map((e) => e.investorId).sort()).toEqual(['inv-1', 'inv-2', 'inv-fiat']);
    // every eligible crypto settlement mints its EUR commitment and carries the off-ramp bankRef
    expect(after.find((e) => e.investorId === 'inv-1')).toMatchObject({ eligible: true, amount: '30000.00', bankRef: 'TRF-OFFRAMP-9' });
  });

  it('rebuilds a pending batch in place; an executed batch is immutable', async () => {
    const book = collectionBook();
    await collect(book, 's1', 'inv-1', '1000.00', '1085.00');
    const queue = new OffRampQueue();
    queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN });
    await collect(book, 's2', 'inv-2', '2000.00', '2170.00');
    const rebuilt = queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN });
    expect(rebuilt).toMatchObject({ batch: 1, subscriptionRefs: ['s1', 's2'], totalUsdc: '3255.0000000' });
    expect(queue.batches('UF-0042')).toHaveLength(1);

    const done = queue.complete('UF-0042', 'TRF-1', '3000.00');
    // callers get copies: mutating one cannot reopen the batch
    done.status = 'PENDING';
    done.subscriptionRefs.push('s9');
    // repeating returns the executed batch unchanged
    expect(queue.complete('UF-0042', 'TRF-OTHER', '2999.00')).toMatchObject({ status: 'EXECUTED', bankRef: 'TRF-1', subscriptionRefs: ['s1', 's2'] });
    expect(() => queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN })).toThrow(/no reconciled collections/);
    expect(queue.instruction('UF-0042')).toMatchObject({ batch: 1, status: 'EXECUTED', bankRef: 'TRF-1' });
    expect(() => queue.complete('UF-0099', 'TRF-1', '1.00')).toThrow(/no off-ramp instruction/);
  });

  it('a collection reconciled after a batch executed needs its own batch', async () => {
    const book = collectionBook();
    await collect(book, 's1', 'inv-1', '30000.00', '30000.00');
    const queue = new OffRampQueue();
    queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN, maxSliceUsdc: '50000' });
    queue.complete('UF-0042', 'TRF-1', '30000.00');

    // Reconciled after batch 1 executed: its USDC was never converted.
    await collect(book, 's2', 'inv-2', '5000.00', '5000.00');
    const view = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: [] });
    expect(view.find((e) => e.subscriptionRef === 's1')).toMatchObject({ eligible: true, bankRef: 'TRF-1' });
    expect(view.find((e) => e.subscriptionRef === 's2')).toMatchObject({ eligible: false }); // must not ride on batch 1

    // Batch 2 covers only the late collection; batch 1 is untouched.
    const second = queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN, maxSliceUsdc: '50000' });
    expect(second).toMatchObject({ batch: 2, totalUsdc: '5000.0000000', subscriptionRefs: ['s2'] });
    expect(queue.batches('UF-0042')[0]).toMatchObject({ status: 'EXECUTED', bankRef: 'TRF-1', subscriptionRefs: ['s1'] });
    queue.complete('UF-0042', 'TRF-2', '5000.00');
    expect(queue.executedBatchFor('UF-0042', 's2')?.bankRef).toBe('TRF-2');

    // Nothing left to convert.
    expect(() => queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN })).toThrow(/no reconciled collections/);
  });

  it('units follow the EUR commitment, and a shortfall needs a top-up before anything mints', async () => {
    const book = collectionBook();
    await collect(book, 's1', 'inv-1', '10000.00', '10850.00');
    const queue = new OffRampQueue();
    const batch = queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN });
    expect([batch.totalUsdc, batch.eurCommitted]).toEqual(['10850.0000000', '10000.0000000']);

    // A swapped amount is caught, not booked.
    expect(() => queue.complete('UF-0042', 'TRF-X', '1085000')).toThrow(/implied rate/);
    expect(queue.instruction('UF-0042')!.status).toBe('PENDING');

    // The conversion lands EUR 10 short: nothing mints until Urbanflip covers it.
    const short = queue.complete('UF-0042', 'TRF-1', '9990.00');
    expect(short).toMatchObject({ status: 'AWAITING_TOP_UP', fxResultEur: '-10.0000000' });
    expect(shortfallEur(short)).toBe('10.0000000');
    const view = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: [] });
    expect(view[0]).toMatchObject({ eligible: false });
    expect(() => queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN })).toThrow(/top-up/);
    expect(() => queue.complete('UF-0042', 'TRF-1', '9990.00')).toThrow(/record the top-up instead/);
    expect(() => queue.topUp('UF-0042', 'TRF-1', '10.00')).toThrow(/conversion itself/);

    // A partial top-up is not enough; a retried one is not counted twice.
    expect(queue.topUp('UF-0042', 'TOPUP-1', '4.00').status).toBe('AWAITING_TOP_UP');
    expect(queue.topUp('UF-0042', 'TOPUP-1', '4.00').topUps).toHaveLength(1);
    expect(() => queue.topUp('UF-0042', 'TOPUP-1', '6.00')).toThrow(/already recorded/);
    const done = queue.topUp('UF-0042', 'TOPUP-2', '6.00');
    expect(done).toMatchObject({ status: 'EXECUTED', fxResultEur: '-10.0000000' });
    expect(shortfallEur(done)).toBe('0.0000000');
    // idempotent per bank reference, even once executed; a new top-up is refused
    expect(queue.topUp('UF-0042', 'TOPUP-2', '6.00').topUps).toHaveLength(2);
    expect(() => queue.topUp('UF-0042', 'TOPUP-3', '1.00')).toThrow('batch 1 is EXECUTED; no top-up needed');

    const minted = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: [] });
    // units = EUR, not USDC
    expect(minted).toEqual([{ investorId: 'inv-1', subscriptionRef: 's1', eligible: true, amount: '10000.00', bankRef: 'TRF-1' }]);
  });

  it('records an FX gain and the units do not move', async () => {
    const book = collectionBook();
    await collect(book, 's1', 'inv-1', '10000.00', '10850.00');
    const queue = new OffRampQueue();
    queue.build({ dealId: 'UF-0042', reconciled: book.svc.reconciledFor('UF-0042'), targetIban: IBAN });
    const done = queue.complete('UF-0042', 'TRF-1', '10004.50');
    expect(done).toMatchObject({ status: 'EXECUTED', fxResultEur: '4.5000000', topUps: [] });
    const view = eligibility({ dealId: 'UF-0042', collections: book.svc.reconciledFor('UF-0042'), offRamp: queue, bankSettlements: [] });
    expect(view[0]).toMatchObject({ eligible: true, amount: '10000.00' });
  });
});

describe('payout rail split (distribution day)', () => {
  it('routes every row to exactly one worklist; unknown or incomplete rails are fatal', async () => {
    const registry = new MemoryRailRegistry();
    registry.register(profile({ investorId: 'onchain-1', payoutRail: 'USDC_ONCHAIN' }));
    registry.register(
      profile({
        investorId: 'fiat-1',
        subscriptionRail: 'FIAT_WIRE' as const,
        payoutRail: 'FIAT_BANK' as const,
        screeningRef: undefined,
        iban: 'ES9121000418450200051332',
        bankAccountName: 'Maria Lopez',
      }),
    );

    const rows = [
      { investorId: 'onchain-1', amount: '1166.67', stellarAddress: ADDRESS },
      { investorId: 'fiat-1', amount: '833.33', stellarAddress: ADDRESS },
    ];
    const worklists = await splitByRail(rows, registry);
    expect(worklists.onChain.map((r) => r.investorId)).toEqual(['onchain-1']);
    expect(worklists.bank.map((r) => r.investorId)).toEqual(['fiat-1']);
    expect(worklists.totals).toEqual({ onChain: '1166.6700000', bank: '833.3300000', combined: '2000.0000000' });

    await expect(
      splitByRail([{ investorId: 'ghost', amount: '1.00', stellarAddress: ADDRESS }], registry),
    ).rejects.toThrow(/no rail profile/);
  });

  it('emits a SEPA worklist file for the fiat cohort', async () => {
    const registry = new MemoryRailRegistry();
    registry.register(
      profile({
        investorId: 'fiat-1',
        subscriptionRail: 'FIAT_WIRE' as const,
        payoutRail: 'FIAT_BANK' as const,
        screeningRef: undefined,
        iban: 'ES9121000418450200051332',
        bankAccountName: 'Maria Lopez',
      }),
    );
    const worklists = await splitByRail([{ investorId: 'fiat-1', amount: '833.33', stellarAddress: ADDRESS }], registry);
    const file = emitBankFile(worklists.bank, { dealId: 'UF-0042', remitterName: 'UF42 SPV SL', remitterIban: 'ES0200491500051234567892' });
    expect(file.split('\n')[3]).toBe('833.33,ES9121000418450200051332,Maria Lopez,UF UF-0042 payout fiat-1');
  });

  it('keeps totals exact beyond float precision', async () => {
    const registry = new MemoryRailRegistry();
    registry.register(profile({ investorId: 'onchain-1', payoutRail: 'USDC_ONCHAIN' }));
    // 2^53 stroops is ~EUR 900M: a float sum would round this.
    const worklists = await splitByRail([{ investorId: 'onchain-1', amount: '900719925.4740993', stellarAddress: ADDRESS }], registry);
    expect(worklists.totals.onChain).toBe('900719925.4740993');
  });
});
