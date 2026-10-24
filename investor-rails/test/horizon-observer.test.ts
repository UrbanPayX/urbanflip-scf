import { describe, expect, it } from 'vitest';
import * as SDK from '@stellar/stellar-sdk';
import { CryptoCollectionService, HorizonIncomingPayments } from '../src';

const HORIZON = 'https://horizon.example';
const COLLECTION = SDK.Keypair.random().publicKey();
const FROM = SDK.Keypair.random().publicKey();
const USDC = { code: 'USDC', issuer: 'G' + 'A'.repeat(55) };
const FIRST_PAGE = `${HORIZON}/accounts/${COLLECTION}/payments?limit=200&order=desc&join=transactions`;

/** A Horizon payment record, joined to its transaction (text memo or none). */
function record(txHash: string, memo?: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'payment',
    to: COLLECTION,
    from: FROM,
    amount: '25000.0000000',
    asset_type: 'credit_alphanum4',
    asset_code: USDC.code,
    asset_issuer: USDC.issuer,
    transaction_hash: txHash.padEnd(64, '0'),
    transaction_successful: true,
    created_at: '2026-10-23T10:00:00Z',
    transaction: memo ? { memo_type: 'text', memo, successful: true } : { memo_type: 'none', successful: true },
    ...overrides,
  };
}

/** A fake fetch serving canned Horizon pages by URL; records every URL asked for. */
function horizon(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    return body === undefined
      ? new Response('{"status":404}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, doFetch };
}

function page(records: Array<Record<string, unknown>>, next?: string) {
  return { _embedded: { records }, _links: next ? { next: { href: next } } : {} };
}

describe('Horizon collection watcher', () => {
  it('keeps only successful credits of the exact asset, with the joined text memo', async () => {
    const native = record('06', 'UF-1-s1', { asset_type: 'native' });
    delete native['asset_code'];
    delete native['asset_issuer'];
    const { doFetch } = horizon({
      [FIRST_PAGE]: page([
        record('01', 'UF-1-s1'),
        record('02', 'UF-1-s1', { asset_issuer: 'G' + 'B'.repeat(55) }), // counterfeit issuer
        record('03', 'UF-1-s1', { asset_code: 'USDX' }),
        record('04', 'UF-1-s1', { type: 'path_payment_strict_send' }),
        record('05', 'UF-1-s1', { type: 'path_payment_strict_receive' }),
        native,
        record('07', undefined, { type: 'create_account' }),
        record('08', 'UF-1-s1', { transaction_successful: false }), // failed tx
        record('09', 'UF-1-s1', { to: FROM, from: COLLECTION }), // outgoing
        record('10', undefined, { transaction: { memo_type: 'hash', memo: 'q83v', successful: true } }),
      ]),
    });
    const payments = await new HorizonIncomingPayments(HORIZON, doFetch).incoming(COLLECTION, USDC);
    expect(payments.map((p) => p.txHash.slice(0, 2))).toEqual(['01', '04', '05', '10']);
    expect(payments[0]).toMatchObject({ from: FROM, to: COLLECTION, amount: '25000.0000000', asset: USDC, memo: 'UF-1-s1' });
    expect(payments[3]!.memo).toBeUndefined(); // only MEMO_TEXT is a matching key
  });

  it('reads newest first and follows _links.next until an empty page or the page cap', async () => {
    const next = (cursor: number) => `${HORIZON}/accounts/${COLLECTION}/payments?cursor=${cursor}&limit=200&order=desc&join=transactions`;
    const routes = {
      [FIRST_PAGE]: page([record('03', 'UF-1-s3')], next(3)),
      [next(3)]: page([record('02', 'UF-1-s2')], next(2)),
      [next(2)]: page([record('01', 'UF-1-s1')], next(1)),
      [next(1)]: page([], next(0)),
    };

    const all = horizon(routes);
    const payments = await new HorizonIncomingPayments(`${HORIZON}/`, all.doFetch).incoming(COLLECTION, USDC);
    expect(payments.map((p) => p.memo)).toEqual(['UF-1-s3', 'UF-1-s2', 'UF-1-s1']);
    expect(all.calls).toEqual([FIRST_PAGE, next(3), next(2), next(1)]);

    const capped = horizon(routes);
    const recent = await new HorizonIncomingPayments(HORIZON, capped.doFetch, 2).incoming(COLLECTION, USDC);
    expect(recent.map((p) => p.memo)).toEqual(['UF-1-s3', 'UF-1-s2']);
    expect(capped.calls).toHaveLength(2);
  });

  it('sees a payment beyond the newest 200, and reconcile settles it', async () => {
    const busy = Array.from({ length: 200 }, (_, i) => record(`b${i}`, `UF-9-x${i}`, { amount: '1.0000000' }));
    const second = `${HORIZON}/accounts/${COLLECTION}/payments?cursor=200&limit=200&order=desc&join=transactions`;
    const { doFetch } = horizon({ [FIRST_PAGE]: page(busy, second), [second]: page([record('aa', 'UF-UF-0042-s1')]) });
    const watched = new CryptoCollectionService({ observer: new HorizonIncomingPayments(HORIZON, doFetch) });
    watched.expectPayment({
      subscriptionRef: 's1',
      investorId: 'inv-1',
      dealId: 'UF-0042',
      eurAmount: '23041.47',
      usdcAmount: '25000.00',
      collectionAddress: COLLECTION,
      asset: USDC,
    });
    await watched.reconcile();
    expect(watched.record('s1')).toMatchObject({ state: 'RECONCILED', settledBy: { txHash: 'aa'.padEnd(64, '0') } });
  });

  it('falls back to a transaction lookup when Horizon did not join the transaction', async () => {
    const plain = record('01');
    delete plain['transaction'];
    const failed = record('02');
    delete failed['transaction'];
    const { doFetch, calls } = horizon({
      [FIRST_PAGE]: page([plain, failed]),
      [`${HORIZON}/transactions/${'01'.padEnd(64, '0')}`]: { memo_type: 'text', memo: 'UF-1-s1', successful: true },
      [`${HORIZON}/transactions/${'02'.padEnd(64, '0')}`]: { memo_type: 'text', memo: 'UF-1-s2', successful: false },
    });
    const payments = await new HorizonIncomingPayments(HORIZON, doFetch).incoming(COLLECTION, USDC);
    expect(payments.map((p) => p.memo)).toEqual(['UF-1-s1']);
    expect(calls).toHaveLength(3);
  });

  it('fails loudly on a Horizon error instead of reporting no payments', async () => {
    const { doFetch } = horizon({});
    await expect(new HorizonIncomingPayments(HORIZON, doFetch).incoming(COLLECTION, USDC)).rejects.toThrow(/HTTP 404/);
  });
});
