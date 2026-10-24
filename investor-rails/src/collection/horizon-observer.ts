import type { IncomingPaymentObserver, ObservedPayment } from './crypto-collection';

/** Newest-first pages of 200 payments read per poll. */
export const PAYMENT_PAGES = 10;

/** Operations that credit the destination ('path_payment' is the pre-protocol-12 name). */
const PAYMENT_TYPES = new Set(['payment', 'path_payment', 'path_payment_strict_receive', 'path_payment_strict_send']);

type HorizonRecord = Record<string, unknown>;

interface HorizonPage {
  _embedded?: { records?: HorizonRecord[] };
  _links?: { next?: { href?: string } };
}

/**
 * Horizon adapter for the collection watcher. Payments for the collection
 * address, newest first (order=desc), following `_links.next` up to a page
 * cap, joined to their transactions for the memo (the payment record does
 * not carry it). Only successful payments of the exact asset count: another
 * issuer's "USDC", XLM or a failed tx is ignored, never coerced into the
 * expected asset. Reconcile runs frequently in production, so the cap
 * (PAYMENT_PAGES × 200) only has to cover payments since the last poll, and
 * every RECONCILED record is idempotent.
 */
export class HorizonIncomingPayments implements IncomingPaymentObserver {
  constructor(
    private readonly horizonUrl: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly maxPages: number = PAYMENT_PAGES,
  ) {}

  async incoming(address: string, asset: { code: string; issuer: string }): Promise<ObservedPayment[]> {
    const base = this.horizonUrl.replace(/\/+$/, '');
    let url: string | undefined = `${base}/accounts/${address}/payments?limit=200&order=desc&join=transactions`;
    const out: ObservedPayment[] = [];
    for (let page = 0; url && page < this.maxPages; page++) {
      const res = await this.doFetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`horizon payments HTTP ${res.status}`);
      const body = (await res.json()) as HorizonPage;
      const records = body._embedded?.records ?? [];
      if (records.length === 0) break;
      for (const record of records) {
        const payment = await this.observedPayment(record, address, asset);
        if (payment) out.push(payment);
      }
      url = body._links?.next?.href;
    }
    return out;
  }

  private async observedPayment(
    record: HorizonRecord,
    address: string,
    asset: { code: string; issuer: string },
  ): Promise<ObservedPayment | undefined> {
    if (!PAYMENT_TYPES.has(String(record['type']))) return undefined;
    if (record['to'] !== address) return undefined;
    if (record['asset_code'] !== asset.code || record['asset_issuer'] !== asset.issuer) return undefined;
    if (record['transaction_successful'] === false) return undefined;
    const txHash = record['transaction_hash'];
    const amount = record['amount'];
    if (typeof txHash !== 'string' || typeof amount !== 'string') return undefined;
    // join=transactions embeds the tx; older Horizons without it get a lookup.
    const joined = record['transaction'];
    const tx = isRecord(joined) ? joined : await this.transaction(txHash);
    if (tx?.['successful'] === false) return undefined;
    return {
      txHash,
      from: String(record['from'] ?? ''),
      to: address,
      amount,
      asset: { code: String(record['asset_code']), issuer: String(record['asset_issuer']) },
      memo: tx && typeof tx['memo'] === 'string' && tx['memo_type'] === 'text' ? tx['memo'] : undefined,
      createdAt: String(record['created_at'] ?? ''),
    };
  }

  private async transaction(txHash: string): Promise<HorizonRecord | undefined> {
    const base = this.horizonUrl.replace(/\/+$/, '');
    const res = await this.doFetch(`${base}/transactions/${txHash}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const tx: unknown = await res.json();
    return isRecord(tx) ? tx : undefined;
  }
}

function isRecord(value: unknown): value is HorizonRecord {
  return typeof value === 'object' && value !== null;
}
