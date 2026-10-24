import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as SDK from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../src/audit/audit-log';
import { UrbanflipComplianceGate } from '../src/gate/urbanflip-gate';
import { GateUnavailableError } from '../src/gate/compliance-gate';
import { TrustlineAuthorizer } from '../src/issuance/trustline-authorizer';
import { FakeLedger } from './fake-ledger';

const REQ = { investorId: 'inv-001', stellarAddress: 'G'.repeat(56), dealId: 'UF-0042' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeGate(fetchImpl: typeof fetch, opts?: { timeoutMs?: number }) {
  return new UrbanflipComplianceGate({
    baseUrl: 'https://platform.urbanflip.io',
    apiToken: 'token-1',
    fetchImpl,
    ...(opts ?? {}),
  });
}

describe('UrbanflipComplianceGate', () => {
  it('maps an approved response to a GateDecision with evidence', async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        jsonResponse(200, { status: 'approved', evidenceId: 'kyc-rec-9' }),
    );
    const decision = await makeGate(fetchImpl).evaluate(REQ);

    expect(decision).toMatchObject({ status: 'approved', evidenceId: 'kyc-rec-9', provider: 'urbanflip-kyc' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/compliance/decision?investorId=inv-001&dealId=UF-0042');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer token-1' });
  });

  it('passes through rejected and pending statuses unchanged', async () => {
    for (const status of ['rejected', 'pending'] as const) {
      const gate = makeGate(vi.fn(async () => jsonResponse(200, { status, reason: 'sanctions hit' })));
      const decision = await gate.evaluate(REQ);
      expect(decision.status).toBe(status);
      expect(decision.reason).toBe('sanctions hit');
    }
  });

  it('fails closed on unexpected payload shapes', async () => {
    const garbage = makeGate(vi.fn(async () => jsonResponse(200, { status: 'maybe' })));
    await expect(garbage.evaluate(REQ)).rejects.toBeInstanceOf(GateUnavailableError);

    const notJson = makeGate(vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(notJson.evaluate(REQ)).rejects.toBeInstanceOf(GateUnavailableError);
  });

  it('retries 5xx then fails closed; 4xx is fatal without retry', async () => {
    const flaky = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'approved' }));
    await expect(makeGate(flaky).evaluate(REQ)).resolves.toMatchObject({ status: 'approved' });
    expect(flaky).toHaveBeenCalledTimes(2);

    const always500 = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    await expect(makeGate(always500).evaluate(REQ)).rejects.toBeInstanceOf(GateUnavailableError);
    expect(always500).toHaveBeenCalledTimes(3); // initial + 2 retries

    const forbidden = vi.fn(async () => jsonResponse(403, { error: 'bad token' }));
    await expect(makeGate(forbidden).evaluate(REQ)).rejects.toBeInstanceOf(GateUnavailableError);
    expect(forbidden).toHaveBeenCalledTimes(1); // 4xx is not retried
  });

  it('fails closed on timeout', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    await expect(
      makeGate(hanging as typeof fetch, { timeoutMs: 20 }).evaluate(REQ),
    ).rejects.toBeInstanceOf(GateUnavailableError);
  });

  it('rejects a misconfigured base URL at construction', () => {
    expect(() => new UrbanflipComplianceGate({ baseUrl: 'not a url' })).toThrow();
  });

  it('sends no authorization header without a token, and reports a custom provider name', async () => {
    const fetchImpl = vi.fn(
      async (..._args: Parameters<typeof fetch>) => jsonResponse(200, { status: 'approved' }),
    );
    const gate = new UrbanflipComplianceGate({
      baseUrl: 'https://platform.urbanflip.io/',
      providerName: 'urbanflip-kyc-eu',
      fetchImpl,
    });
    const decision = await gate.evaluate(REQ);
    expect(decision.provider).toBe('urbanflip-kyc-eu');
    expect(gate.providerName).toBe('urbanflip-kyc-eu');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://platform.urbanflip.io/api/v1/compliance/decision?investorId=inv-001&dealId=UF-0042',
    );
    expect((init as RequestInit).headers).toEqual({ accept: 'application/json' });
  });

  it("keeps the gate's evaluatedAt and evidence; ignores non-string optional fields", async () => {
    const at = '2026-10-23T10:00:00Z';
    const kept = await makeGate(
      vi.fn(async () => jsonResponse(200, { status: 'approved', evidenceId: 'kyc-1', evaluatedAt: at })),
    ).evaluate(REQ);
    expect(kept).toMatchObject({ evidenceId: 'kyc-1', evaluatedAt: at });

    const odd = await makeGate(
      vi.fn(async () => jsonResponse(200, { status: 'rejected', evidenceId: 42, reason: ['x'], evaluatedAt: 0 })),
    ).evaluate(REQ);
    expect(odd.evidenceId).toBeUndefined();
    expect(odd.reason).toBeUndefined();
    expect(Number.isNaN(Date.parse(odd.evaluatedAt))).toBe(false);
  });

  it('fails closed, without retrying, on a 200 whose JSON is not an object or lacks a valid status', async () => {
    const bodies: unknown[] = [null, 'approved', 7, true, [], {}, { status: 'APPROVED' }, { status: 1 }, { decision: 'approved' }];
    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => jsonResponse(200, body));
      const err = await makeGate(fetchImpl).evaluate(REQ).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(GateUnavailableError);
      expect((err as Error).message).toMatch(/not a JSON object|invalid status/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('a transient 5xx followed by an answer is retried and the answer used', async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'maintenance' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'rejected', reason: 'KYC expired' }));
    await expect(makeGate(fetchImpl).evaluate(REQ)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'KYC expired',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('an unreachable gate error names the host and keeps the cause, never the token', async () => {
    const cause = new TypeError('fetch failed: ECONNREFUSED');
    const fetchImpl = vi.fn(async () => {
      throw cause;
    });
    const err = (await makeGate(fetchImpl).evaluate(REQ).catch((e: unknown) => e)) as GateUnavailableError;
    expect(err).toBeInstanceOf(GateUnavailableError);
    expect(err.name).toBe('GateUnavailableError');
    expect(err.message).toContain('platform.urbanflip.io');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('token-1');
    expect(err.cause).toBe(cause);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('behind TrustlineAuthorizer, an unavailable gate submits nothing and records no authorization', async () => {
    const ledger = new FakeLedger();
    const issuer = SDK.Keypair.random();
    ledger.fund(issuer.publicKey());
    const audit = new MemoryAuditLog();
    const authorizer = new TrustlineAuthorizer({
      gate: makeGate(vi.fn(async () => jsonResponse(502, { error: 'bad gateway' }))),
      submitter: ledger,
      networkPassphrase: SDK.Networks.TESTNET,
      audit,
    });
    const investor = { investorId: 'inv-001', stellarAddress: SDK.Keypair.random().publicKey() };
    await expect(
      authorizer.authorize({ dealId: 'UF-0042', displayName: 'Deal 42' }, issuer, investor),
    ).rejects.toBeInstanceOf(GateUnavailableError);
    expect(ledger.submitted).toHaveLength(0);
    expect(audit.events.filter((e) => e.kind === 'TRUSTLINE_AUTHORIZED')).toHaveLength(0);
  });
});

/**
 * The production transport: no fetchImpl, so the adapter uses the global
 * fetch against a real (local) HTTP server, including its own AbortController
 * timeout on a socket that never answers.
 */
describe('UrbanflipComplianceGate over real HTTP (global fetch)', () => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  let handler: Handler = (_req, res) => res.end();
  const seen: Array<{ url: string; authorization?: string; accept?: string }> = [];
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization, accept: req.headers.accept });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function reply(status: number, body: unknown): Handler {
    return (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }

  it('sends the contract request and maps the decision', async () => {
    seen.length = 0;
    handler = reply(200, { status: 'approved', evidenceId: 'kyc-rec-9', evaluatedAt: '2026-10-23T10:00:00Z' });
    const gate = new UrbanflipComplianceGate({ baseUrl: `${baseUrl}/`, apiToken: 'token-1' });
    await expect(gate.evaluate({ ...REQ, investorId: 'inv 001&x=1' })).resolves.toEqual({
      status: 'approved',
      provider: 'urbanflip-kyc',
      evidenceId: 'kyc-rec-9',
      reason: undefined,
      evaluatedAt: '2026-10-23T10:00:00Z',
    });
    expect(seen).toEqual([
      {
        // query values are encoded: an investor id cannot inject parameters
        url: '/api/v1/compliance/decision?investorId=inv+001%26x%3D1&dealId=UF-0042',
        authorization: 'Bearer token-1',
        accept: 'application/json',
      },
    ]);
  });

  it('a server that accepts but never answers times out and fails closed after the retries', async () => {
    seen.length = 0;
    handler = () => undefined; // hold the socket open, never respond
    const gate = new UrbanflipComplianceGate({ baseUrl, timeoutMs: 50 });
    const err = await gate.evaluate(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateUnavailableError);
    expect((err as Error).message).toMatch(/unreachable \(127\.0\.0\.1:\d+\)/);
    expect(seen).toHaveLength(3);
  });

  it('a 401 (bad token) is not retried and fails closed', async () => {
    seen.length = 0;
    handler = reply(401, { error: 'invalid token' });
    const gate = new UrbanflipComplianceGate({ baseUrl, apiToken: 'stale' });
    await expect(gate.evaluate(REQ)).rejects.toThrow(/gate returned HTTP 401/);
    expect(seen).toHaveLength(1);
  });

  it('an HTML error page with status 200 fails closed', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>maintenance</html>');
    };
    const gate = new UrbanflipComplianceGate({ baseUrl });
    await expect(gate.evaluate(REQ)).rejects.toBeInstanceOf(GateUnavailableError);
  });
});
