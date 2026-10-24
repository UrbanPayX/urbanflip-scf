// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Stellar Wallets Kit v2 is a static class; the widget only touches these.
const kit = vi.hoisted(() => ({
  init: vi.fn(),
  authModal: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
const kitState = vi.hoisted(() => ({ installText: { value: 'Install' } }));
vi.mock('@creit.tech/stellar-wallets-kit/sdk', () => ({ StellarWalletsKit: kit }));
vi.mock('@creit.tech/stellar-wallets-kit/modules/utils', () => ({ defaultModules: () => ['all-modules'] }));
vi.mock('@creit.tech/stellar-wallets-kit/state', () => kitState);

import { start } from '../src/widget';

const TESTNET = 'Test SDF Network ; September 2015';
const PUBLIC = 'Public Global Stellar Network ; September 2015';
const PARENT = 'https://app.urbanflip.io';
const ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const OTHER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const BASE = '/v1/investors/inv-42/external-wallet';
const HASH = 'a'.repeat(64);

// jsdom replaces the global URL class, so resolve the path with node:url.
const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../connect.html'), 'utf8');

type Route = 'challenge' | 'verify' | 'trustline' | 'submit';
const PATHS: Record<Route, string> = {
  challenge: `${BASE}/challenge`,
  verify: `${BASE}/verify`,
  trustline: `${BASE}/trustline`,
  submit: `${BASE}/trustline/submit`,
};

interface Call {
  route: Route;
  init: RequestInit;
  body: unknown;
}

let calls: Call[];
let queues: Record<Route, Array<() => Response>>;
let postMessage: Mock<(message: unknown, targetOrigin: string) => void>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300;
const challengeOk = (n = 1) => json(200, { challenge_xdr: `CHALLENGE_${n}`, network_passphrase: TESTNET, expires_at: inFiveMinutes() });
const verifyOk = () => json(200, { linked: true, address: ADDRESS });
const trustlineSign = (n = 1) => json(200, { status: 'sign', xdr: `TRUSTLINE_${n}`, network_passphrase: TESTNET, expires_at: inFiveMinutes() });
const submitOk = () => json(200, { status: 'submitted', trustline_tx_hash: HASH });

function backend(routes: Partial<Record<Route, Array<() => Response>>>) {
  queues = { challenge: [], verify: [], trustline: [], submit: [], ...routes };
}

function mount(fragment: string) {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', `/widget/connect.html${fragment}`);
  return start();
}

const fragment = (extra = '') =>
  `#investor=inv-42&deal=UF42&session=sess%2Btoken&network=testnet&parent=${encodeURIComponent(PARENT)}${extra}`;

const $ = (id: string) => document.getElementById(id)!;
const action = () => $('uf-action') as HTMLButtonElement;
const routesCalled = () => calls.map((c) => c.route);
const messages = () => postMessage.mock.calls.map((c) => c[0]);

/** Waits until the main button offers `label` and is enabled, then clicks it. */
async function press(label: string) {
  await vi.waitFor(() => {
    expect(action().hidden).toBe(false);
    expect(action().textContent).toBe(label);
    expect(action().getAttribute('aria-disabled')).toBe('false');
  });
  action().click();
}

async function nextMessage(count: number) {
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(count));
  return messages()[count - 1];
}

beforeEach(() => {
  calls = [];
  backend({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const route = (Object.keys(PATHS) as Route[]).find((r) => PATHS[r] === url);
      if (!route) throw new Error(`unexpected request to ${url}`);
      calls.push({ route, init, body: JSON.parse(String(init.body)) });
      const next = queues[route].shift();
      if (!next) throw new Error(`no response queued for ${route}`);
      return next();
    }),
  );
  postMessage = vi.fn();
  vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessage as unknown as Window['postMessage']);
  kit.init.mockReset();
  kit.authModal.mockReset().mockResolvedValue({ address: ADDRESS });
  kit.getNetwork.mockReset().mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET });
  kit.signTransaction.mockReset().mockImplementation(async (xdr: string) => ({ signedTxXdr: `${xdr}_SIGNED`, signerAddress: ADDRESS }));
  kitState.installText.value = 'Install';
});

afterEach(() => {
  // The result only ever goes to the validated parent origin, never "*".
  for (const [, targetOrigin] of postMessage.mock.calls) expect(targetOrigin).toBe(PARENT);
  for (const c of calls) {
    expect(c.init.method).toBe('POST');
    expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer sess+token');
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Wallets Kit widget', () => {
  it('happy path: connect, prove ownership, sign and submit the trustline, report ready', async () => {
    backend({ challenge: [challengeOk()], verify: [verifyOk()], trustline: [trustlineSign()], submit: [submitOk()] });
    mount(fragment());

    expect(document.documentElement.lang).toBe('es');
    expect($('uf-title').textContent).toBe('Conecta tu wallet de Stellar');
    expect($('uf-network').textContent).toBe('Red: Testnet');
    expect(kit.init).toHaveBeenCalledWith({ modules: ['all-modules'], network: TESTNET });
    expect(kitState.installText.value).toBe('Instalar');

    await press('Conectar wallet');
    await press('Firmar en mi wallet'); // challenge
    await press('Firmar en mi wallet'); // trustline
    const msg = await nextMessage(1);

    expect(msg).toEqual({
      type: 'urbanflip:wallet',
      status: 'ready',
      investorId: 'inv-42',
      dealId: 'UF42',
      address: ADDRESS,
      trustlineTxHash: HASH,
    });
    expect(routesCalled()).toEqual(['challenge', 'verify', 'trustline', 'submit']);
    expect(calls.map((c) => c.body)).toEqual([
      { address: ADDRESS },
      { signed_xdr: 'CHALLENGE_1_SIGNED' },
      { deal_id: 'UF42' },
      { deal_id: 'UF42', signed_xdr: 'TRUSTLINE_1_SIGNED' },
    ]);
    expect(kit.signTransaction.mock.calls).toEqual([
      ['CHALLENGE_1', { networkPassphrase: TESTNET, address: ADDRESS }],
      ['TRUSTLINE_1', { networkPassphrase: TESTNET, address: ADDRESS }],
    ]);
    expect(kit.authModal).toHaveBeenCalledTimes(1);
    expect($('uf-status').textContent).toContain('Listo. Tu wallet GBRP…OX2H está vinculada');
    expect($('uf-status').querySelector('a')!.href).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`);
    expect(action().hidden).toBe(true);
    expect($('uf-steps').querySelectorAll('li[data-state="done"]')).toHaveLength(3);
  });

  it('already-open trustline: reports ready without a second signature (lang=en)', async () => {
    backend({ challenge: [challengeOk()], verify: [verifyOk()], trustline: [json(200, { status: 'ready', address: ADDRESS })] });
    mount(fragment('&lang=en'));
    expect($('uf-title').textContent).toBe('Connect your Stellar wallet');

    await press('Connect wallet');
    await press('Sign in my wallet');
    const msg = await nextMessage(1);

    expect(msg).toEqual({ type: 'urbanflip:wallet', status: 'ready', investorId: 'inv-42', dealId: 'UF42', address: ADDRESS });
    expect(routesCalled()).toEqual(['challenge', 'verify', 'trustline']);
    expect(kit.signTransaction).toHaveBeenCalledTimes(1);
    expect($('uf-status').textContent).toContain('The trustline was already open.');
  });

  it('closing the kit modal reports cancelled; retrying then succeeds', async () => {
    kit.authModal.mockRejectedValueOnce({ code: -1, message: 'The user closed the modal.' });
    backend({ challenge: [challengeOk()], verify: [verifyOk()], trustline: [json(200, { status: 'ready', address: ADDRESS })] });
    mount(fragment());

    await press('Conectar wallet');
    expect(await nextMessage(1)).toEqual({ type: 'urbanflip:wallet', status: 'cancelled', investorId: 'inv-42', dealId: 'UF42' });
    expect(calls).toHaveLength(0);
    expect($('uf-status').textContent).toContain('Has cancelado');
    expect($('uf-error').hidden).toBe(true);

    await press('Reintentar');
    await press('Firmar en mi wallet');
    expect(await nextMessage(2)).toMatchObject({ status: 'ready', address: ADDRESS });
  });

  it('rejecting the signature in the wallet reports cancelled and sends nothing to verify', async () => {
    kit.signTransaction.mockRejectedValueOnce({ code: -4, message: 'The user rejected this request.' });
    backend({ challenge: [challengeOk()] });
    mount(fragment());

    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toEqual({ type: 'urbanflip:wallet', status: 'cancelled', investorId: 'inv-42', dealId: 'UF42' });
    expect(routesCalled()).toEqual(['challenge']);
    expect(action().textContent).toBe('Reintentar');
  });

  it('treats xBull web-wallet rejection ("Request rejected from the wallet") as cancelled', async () => {
    kit.authModal.mockRejectedValueOnce({ code: -1, message: 'Request rejected from the wallet' });
    mount(fragment());
    await press('Conectar wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'cancelled' });
  });

  it('restarts from the challenge once when the server reports it expired', async () => {
    backend({
      challenge: [challengeOk(1), challengeOk(2)],
      verify: [json(410, { error: 'challenge expired' }), verifyOk()],
      trustline: [trustlineSign()],
      submit: [submitOk()],
    });
    mount(fragment());

    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    await vi.waitFor(() => expect($('uf-status').textContent).toContain('La solicitud anterior caducó'));
    await press('Firmar en mi wallet'); // the new challenge
    await press('Firmar en mi wallet'); // trustline
    expect(await nextMessage(1)).toMatchObject({ status: 'ready', trustlineTxHash: HASH });

    expect(routesCalled()).toEqual(['challenge', 'verify', 'challenge', 'verify', 'trustline', 'submit']);
    expect(calls[3]!.body).toEqual({ signed_xdr: 'CHALLENGE_2_SIGNED' });
  });

  it('fetches a new challenge without prompting the wallet when it expired before signing', async () => {
    const expired = json(200, { challenge_xdr: 'STALE', network_passphrase: TESTNET, expires_at: 1_000 });
    backend({ challenge: [expired, challengeOk(2)], verify: [verifyOk()], trustline: [json(200, { status: 'ready', address: ADDRESS })] });
    mount(fragment());

    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'ready' });
    expect(kit.signTransaction.mock.calls.map((c) => c[0])).toEqual(['CHALLENGE_2']);
  });

  it('gives up after a second expiry and reports an error', async () => {
    backend({
      challenge: [challengeOk(1), challengeOk(2)],
      verify: [json(400, { error: 'Challenge expired' }), json(400, { error: 'Challenge expired' })],
    });
    mount(fragment());

    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toEqual({
      type: 'urbanflip:wallet',
      status: 'error',
      investorId: 'inv-42',
      dealId: 'UF42',
      error: 'expired: verify failed (HTTP 400): Challenge expired',
    });
    expect(routesCalled()).toEqual(['challenge', 'verify', 'challenge', 'verify']);
    expect($('uf-error').textContent).toContain('La solicitud ha caducado de nuevo');
  });

  it('shows a backend error, reports it, and a retry resumes at the trustline step', async () => {
    backend({
      challenge: [challengeOk()],
      verify: [verifyOk()],
      trustline: [json(502, { error: 'horizon unavailable' }), trustlineSign(2)],
      submit: [submitOk()],
    });
    mount(fragment());

    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toEqual({
      type: 'urbanflip:wallet',
      status: 'error',
      investorId: 'inv-42',
      dealId: 'UF42',
      address: ADDRESS,
      error: 'backend_error: trustline failed (HTTP 502): horizon unavailable',
    });
    expect($('uf-error').hidden).toBe(false);
    expect($('uf-error').getAttribute('role')).toBe('alert');
    expect($('uf-error').textContent).toBe('No hemos podido completar este paso: horizon unavailable');

    await press('Reintentar');
    await press('Firmar en mi wallet');
    expect(await nextMessage(2)).toMatchObject({ status: 'ready', trustlineTxHash: HASH });
    expect(kit.authModal).toHaveBeenCalledTimes(1);
    expect(routesCalled()).toEqual(['challenge', 'verify', 'trustline', 'trustline', 'submit']);
  });

  it('a 401 tells the investor to reload (expired session)', async () => {
    backend({ challenge: [json(401, { error: 'invalid session' })] });
    mount(fragment());
    await press('Conectar wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'error', error: 'unauthorized: challenge failed (HTTP 401): invalid session' });
    expect($('uf-error').textContent).toBe('Tu sesión ha caducado. Vuelve a cargar la página de Urbanflip.');
  });

  it('a non-JSON error body still yields a readable error', async () => {
    backend({ challenge: [() => new Response('<html>Bad gateway</html>', { status: 502 })] });
    mount(fragment());
    await press('Conectar wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'error', error: 'backend_error: challenge failed (HTTP 502): HTTP 502' });
  });

  it('a wallet on the wrong network is stopped before any API call', async () => {
    kit.getNetwork.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: PUBLIC });
    mount(fragment());
    await press('Conectar wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'error', error: `wrong_network: wallet is on "${PUBLIC}"` });
    expect(calls).toHaveLength(0);
    expect($('uf-error').textContent).toContain('Tu wallet está en la red Mainnet (pública)');
  });

  it('wallets that cannot report their network (Albedo, xBull, LOBSTR) proceed', async () => {
    kit.getNetwork.mockRejectedValue({ code: -3, message: 'Albedo does not support the "getNetwork" function' });
    kit.signTransaction.mockImplementation(async (xdr: string) => ({ signedTxXdr: `${xdr}_SIGNED` }));
    backend({ challenge: [challengeOk()], verify: [verifyOk()], trustline: [json(200, { status: 'ready', address: ADDRESS })] });
    mount(fragment());
    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'ready' });
  });

  it('a verify rejection adds the network hint', async () => {
    backend({ challenge: [challengeOk()], verify: [json(400, { error: 'invalid signature' })] });
    mount(fragment());
    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    await nextMessage(1);
    expect($('uf-error').textContent).toContain('comprueba que está en Testnet');
  });

  it('refuses a signature made with a different account', async () => {
    kit.signTransaction.mockResolvedValueOnce({ signedTxXdr: 'X', signerAddress: OTHER });
    backend({ challenge: [challengeOk()] });
    mount(fragment());
    await press('Conectar wallet');
    await press('Firmar en mi wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'error', error: expect.stringMatching(/^wrong_account: /) });
    expect(routesCalled()).toEqual(['challenge']);
  });

  it('refuses a challenge for a different network than the widget was opened for', async () => {
    backend({ challenge: [json(200, { challenge_xdr: 'C', network_passphrase: PUBLIC, expires_at: inFiveMinutes() })] });
    mount(fragment());
    await press('Conectar wallet');
    expect(await nextMessage(1)).toMatchObject({ status: 'error', error: expect.stringMatching(/^network_mismatch: /) });
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it('ignores clicks while a step is running', async () => {
    let releaseModal!: (v: { address: string }) => void;
    kit.authModal.mockReturnValueOnce(new Promise((r) => (releaseModal = r)));
    backend({ challenge: [challengeOk()] });
    mount(fragment());
    await press('Conectar wallet');
    expect(action().getAttribute('aria-disabled')).toBe('true');
    action().click();
    action().click();
    expect(kit.authModal).toHaveBeenCalledTimes(1);
    releaseModal({ address: ADDRESS });
    await vi.waitFor(() => expect(action().textContent).toBe('Firmar en mi wallet'));
    expect(routesCalled()).toEqual(['challenge']);
  });

  describe('fragment validation', () => {
    it('missing params: visible error, no API or kit calls, error posted to a valid parent', async () => {
      mount(`#investor=inv-42&network=testnet&parent=${encodeURIComponent(PARENT)}`);
      expect($('uf-error').hidden).toBe(false);
      expect($('uf-error').textContent).toContain('faltan datos o no son válidos (inversión, sesión)');
      expect(action().hidden).toBe(true);
      expect(kit.init).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(messages()).toEqual([
        { type: 'urbanflip:wallet', status: 'error', investorId: 'inv-42', dealId: '', error: 'invalid_params: deal, session' },
      ]);
    });

    it('without a valid parent nothing is posted at all', () => {
      for (const parent of ['', '&parent=*', '&parent=https%3A%2F%2Fapp.urbanflip.io%2Fpath', '&parent=http%3A%2F%2Fevil.example']) {
        mount(`#investor=i&deal=d&session=s${parent}&lang=en`);
        expect($('uf-error').textContent).toContain('missing or invalid parameters (parent)');
      }
      expect(postMessage).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects an unknown network', () => {
      mount(fragment().replace('network=testnet', 'network=futurenet'));
      expect($('uf-error').textContent).toContain('(red)');
      expect(kit.init).not.toHaveBeenCalled();
    });
  });
});
