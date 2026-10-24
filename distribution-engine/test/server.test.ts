import { StrKey } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createEngineServer } from '../src/api/server';

const servers: Array<{ close: () => void; url: string }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(): Promise<string> {
  const server = createEngineServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  servers.push({ close: () => server.close(), url });
  return url;
}

const WALLET_1 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const WALLET_2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const LEDGER = {
  positions: [
    { investorId: 'inv-1', email: 'one@example.com', principal: '75000.00', walletAddress: WALLET_1 },
    { investorId: 'inv-2', email: 'two@example.com', principal: '25000.00', walletAddress: WALLET_2 },
  ],
};
const OUTCOME = { outcome: { principalRepayment: '100000.00', performanceInterest: '8000.00' } };

describe('HTTP API (implements api/openapi.yaml)', () => {
  it('registers a ledger, computes a schedule, and emits SDP files', async () => {
    const base = await start();

    const ledgerRes = await fetch(`${base}/v1/deals/UF-0042/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LEDGER),
    });
    expect(ledgerRes.status).toBe(201);

    const distRes = await fetch(`${base}/v1/deals/UF-0042/distributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OUTCOME),
    });
    const schedule = (await distRes.json()) as { rows: Array<{ totalStroops: string }> };
    expect(distRes.status).toBe(200);
    expect(schedule.rows[0]!.totalStroops).toBe('81000.00');
    expect(schedule.rows[1]!.totalStroops).toBe('27000.00');

    const unfunded = await fetch(`${base}/v1/distributions/UF-0042/sdp-files`, { method: 'POST' });
    expect(unfunded.status).toBe(400);
    expect(((await unfunded.json()) as { error: string }).error).toContain('usdcFunded is required');

    // EUR 108,000 owed; the treasury bought USDC 117,180 for it (1.085 USDC/EUR).
    const sdpRes = await fetch(`${base}/v1/distributions/UF-0042/sdp-files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usdcFunded: '117180.00', onlyAddresses: [WALLET_1, WALLET_2] }),
    });
    expect(sdpRes.status).toBe(200);
    const body = (await sdpRes.json()) as {
      usdcConversion: { eurTotal: string; usdcTotal: string; rate: string };
      files: Array<{ name: string; rowCount: number; content: string }>;
    };
    expect(body.usdcConversion).toMatchObject({ eurTotal: '108000.00', usdcTotal: '117180.00', rate: '1.085000' });
    expect(body.files[0]!.content.split('\n').slice(0, 3)).toEqual([
      'amount,id,destination,memo,memo_type',
      `87885.00,one@example.com,${WALLET_1},,`,
      `29295.00,two@example.com,${WALLET_2},,`,
    ]);
    expect(body.files[0]!.rowCount).toBe(2);
  });

  it('refuses SDP emission for invalid wallets or an implausible USDC amount', async () => {
    const base = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await post('/v1/deals/UF-0042/ledger', LEDGER);
    await post('/v1/deals/UF-0042/distributions', OUTCOME);

    const implausible = await post('/v1/distributions/UF-0042/sdp-files', { usdcFunded: '1080.00' });
    expect(implausible.status).toBe(400);
    expect(((await implausible.json()) as { error: string }).error).toContain('implied rate');
    const asNumber = await post('/v1/distributions/UF-0042/sdp-files', { usdcFunded: 117180 });
    expect(asNumber.status).toBe(400);

    const hostile = {
      positions: [{ ...LEDGER.positions[0]!, walletAddress: `${WALLET_1},evil\r\n` }, LEDGER.positions[1]!],
    };
    const res = await post('/v1/deals/UF-0042/ledger', hostile);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("investor 'inv-1'");
    // The stored ledger is untouched: emission still uses the valid one.
    const ok = await post('/v1/distributions/UF-0042/sdp-files', { usdcFunded: '117180.00' });
    expect(ok.status).toBe(200);
  });

  it('replays a completed deal against its historical payout record', async () => {
    const base = await start();
    await fetch(`${base}/v1/deals/UF-0042/ledger`, {
      method: 'POST',
      body: JSON.stringify(LEDGER),
      headers: { 'content-type': 'application/json' },
    });
    const res = await fetch(`${base}/v1/deals/UF-0042/distributions/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...OUTCOME,
        historicalPayouts: [
          { investorId: 'inv-1', amount: '81000.00' },
          { investorId: 'inv-2', amount: '27000.00' },
        ],
      }),
    });
    const report = (await res.json()) as { match: boolean; comparedRows: number };
    expect(report.match).toBe(true);
    expect(report.comparedRows).toBe(2);
  });

  it('validates inputs and unknown deals with structured errors', async () => {
    const base = await start();
    const unknown = await fetch(`${base}/v1/deals/nope/distributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(OUTCOME),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('unknown deal');

    const badRoute = await fetch(`${base}/v1/other`, { method: 'POST' });
    expect(badRoute.status).toBe(404);
  });
});
