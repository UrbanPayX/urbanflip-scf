import { describe, expect, it, vi } from 'vitest';
import { UrbanflipComplianceGate } from '../src/gate/urbanflip-gate';
import { GateUnavailableError } from '../src/gate/compliance-gate';

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
});
