import * as SDK from '@stellar/stellar-sdk';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  defaultExternalId,
  PrivyWalletProvider,
  privyAuthorizationSigner,
  toStellarAddress,
  type PrivyProviderConfig,
} from '../src/wallet/privy-provider';
import { JsonFileWalletDirectory, MemoryWalletDirectory } from '../src/wallet/wallet-directory';

const API = 'https://api.privy.io';
const APP = { appId: 'app-id', appSecret: 'app-secret' };
const BASIC = `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`;
const EMAIL = 'inv@example.com';

/** Documented POST /v1/wallets body fields (additional properties are rejected by Privy). */
const CREATE_FIELDS = new Set([
  'chain_type', 'display_name', 'external_id', 'policy_ids', 'entity', 'owner', 'owner_id', 'derivation', 'additional_signers',
]);
const CHAIN_TYPES = new Set([
  'ethereum', 'solana', 'cosmos', 'stellar', 'sui', 'aptos', 'movement', 'tron', 'bitcoin-segwit', 'bitcoin-taproot',
  'pearl', 'near', 'ton', 'starknet', 'xrpl', 'spark',
]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Solana-style address: the raw 32-byte Ed25519 public key in base58. */
function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  for (; value > 0n; value /= 58n) out = alphabet[Number(value % 58n)] + out;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
  return out;
}

interface FakeWallet {
  id: string;
  kp: SDK.Keypair;
  chain_type: string;
  external_id?: string;
  entity?: unknown;
  owner_id: string | null;
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * 'drop-response':     wallet created, response lost (fetch rejects).
 * 'http-500':          create refused with 500; cached under the idempotency key.
 * 'created-elsewhere': another process creates the same external_id first.
 */
type Fault = 'drop-response' | 'http-500' | 'created-elsewhere';

/**
 * Fake Privy wallet API backed by real Ed25519 keys. Rejects anything that
 * is not the documented request shape, and implements the documented
 * idempotency semantics (same key + same body replays, including errors;
 * same key + different body is a 400) and external_id uniqueness.
 */
function fakePrivy(opts: { ownerKeys?: Map<string, ReturnType<typeof createPublicKey>> } = {}) {
  const wallets: FakeWallet[] = [];
  const idempotency = new Map<string, { body: string; status: number; response: unknown }>();
  const faults: Fault[] = [];
  const calls: Call[] = [];

  const view = (w: FakeWallet) => ({
    id: w.id,
    address: w.chain_type === 'stellar' ? w.kp.publicKey() : base58(w.kp.rawPublicKey()),
    chain_type: w.chain_type,
    ...(w.external_id ? { external_id: w.external_id } : {}),
    entity: w.entity ?? null,
    owner_id: w.owner_id,
    policy_ids: [],
    additional_signers: [],
    created_at: 1_741_834_854_578,
    exported_at: null,
    imported_at: null,
  });

  const newWallet = (body: Record<string, unknown>): FakeWallet => {
    const w: FakeWallet = {
      id: `wlt${wallets.length + 1}`,
      kp: SDK.Keypair.random(),
      chain_type: body.chain_type as string,
      external_id: body.external_id as string | undefined,
      entity: body.entity,
      owner_id: (body.owner_id as string | undefined) ?? null,
    };
    wallets.push(w);
    return w;
  };

  const invalidCreate = (body: Record<string, unknown>): string | undefined => {
    const extra = Object.keys(body).filter((k) => !CREATE_FIELDS.has(k));
    if (extra.length) return `unknown fields ${extra.join(',')}`;
    if (!CHAIN_TYPES.has(body.chain_type as string)) return 'invalid chain_type';
    if (body.external_id !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(String(body.external_id))) return 'bad external_id';
    const entity = body.entity as { id?: unknown; type?: unknown } | undefined;
    if (entity && (typeof entity.id !== 'string' || (entity.type !== 'user' && entity.type !== 'organization'))) {
      return 'bad entity';
    }
    if (body.owner !== undefined && body.owner_id !== undefined) return 'owner and owner_id are exclusive';
    return undefined;
  };

  const create = (headers: Record<string, string>, body: Record<string, unknown>): Response => {
    if (headers['content-type'] !== 'application/json') return json(400, { error: 'content-type' });
    const key = headers['privy-idempotency-key'];
    const raw = JSON.stringify(body);
    if (key !== undefined) {
      if (key.length > 256) return json(400, { error: 'idempotency key too long' });
      const prior = idempotency.get(key);
      if (prior) {
        return prior.body === raw ? json(prior.status, prior.response) : json(400, { error: 'key reused, body differs' });
      }
    }
    const fault = faults.shift();
    let status = 200;
    let response: unknown;
    const invalid = invalidCreate(body);
    if (invalid) {
      status = 400;
      response = { error: invalid };
    } else if (fault === 'http-500') {
      status = 500;
      response = { error: 'internal error' };
    } else {
      if (fault === 'created-elsewhere') newWallet(body);
      if (body.external_id !== undefined && wallets.some((w) => w.external_id === body.external_id)) {
        status = 400;
        response = { error: 'external_id already exists' };
      } else {
        response = view(newWallet(body));
      }
    }
    if (key !== undefined) idempotency.set(key, { body: raw, status, response });
    if (fault === 'drop-response') throw new TypeError('fetch failed');
    return json(status, response);
  };

  const authorized = (w: FakeWallet, call: Call): boolean => {
    if (w.owner_id === null) return true;
    const owner = opts.ownerKeys?.get(w.owner_id);
    const sig = call.headers['privy-authorization-signature'];
    if (!owner || !sig) return false;
    const payload = { version: 1, method: 'POST', url: call.url, body: call.body, headers: { 'privy-app-id': 'app-id' } };
    return cryptoVerify('sha256', Buffer.from(canonicalJson(payload)), owner, Buffer.from(sig, 'base64'));
  };

  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    if (call.headers.authorization !== BASIC || call.headers['privy-app-id'] !== 'app-id') {
      return json(401, { error: 'invalid app credentials' });
    }
    const url = new URL(call.url);
    if (url.origin !== API) return json(404, { error: 'not found' });
    if (call.method === 'GET' && url.pathname === '/v1/wallets') {
      if (call.body !== undefined) return json(400, { error: 'GET has no body' });
      const ext = url.searchParams.get('external_id');
      return json(200, { data: wallets.filter((w) => ext === null || w.external_id === ext).map(view) });
    }
    if (call.method === 'POST' && url.pathname === '/v1/wallets') {
      return create(call.headers, call.body as Record<string, unknown>);
    }
    const action = /^\/v1\/wallets\/([^/]+)\/(raw_sign|rpc)$/.exec(url.pathname);
    const wallet = action && wallets.find((w) => w.id === action[1]);
    if (call.method !== 'POST' || !action || !wallet) return json(404, { error: 'not found' });
    if (!authorized(wallet, call)) return json(401, { error: 'missing or invalid authorization signature' });
    const body = call.body as Record<string, any>;
    if (action[2] === 'raw_sign') {
      const hash = body?.params?.hash;
      const exact = Object.keys(body).join() === 'params' && Object.keys(body.params).join() === 'hash';
      if (wallet.chain_type !== 'stellar' || !exact || !/^0x[0-9a-f]+$/.test(hash)) {
        return json(400, { error: 'bad raw_sign request' });
      }
      const sig = wallet.kp.sign(Buffer.from(hash.slice(2), 'hex'));
      return json(200, { method: 'raw_sign', data: { signature: `0x${Buffer.from(sig).toString('hex')}`, encoding: 'hex' } });
    }
    const exact =
      Object.keys(body).sort().join() === 'method,params' &&
      body.method === 'signMessage' &&
      Object.keys(body.params).sort().join() === 'encoding,message' &&
      body.params.encoding === 'base64';
    if (wallet.chain_type !== 'solana' || !exact) return json(400, { error: 'bad rpc request' });
    const sig = wallet.kp.sign(Buffer.from(body.params.message, 'base64'));
    return json(200, { method: 'signMessage', data: { signature: Buffer.from(sig).toString('base64'), encoding: 'base64' } });
  });

  const creates = () => calls.filter((c) => c.method === 'POST' && c.url === `${API}/v1/wallets`);
  const keyOf = (w: FakeWallet) => SDK.Keypair.fromPublicKey(w.kp.publicKey());
  return { fetchImpl, wallets, calls, faults, creates, keyOf, newWallet };
}

type Privy = ReturnType<typeof fakePrivy>;

function provider(privy: Privy, extra: Partial<PrivyProviderConfig> = {}): PrivyWalletProvider {
  return new PrivyWalletProvider({ ...APP, fetchImpl: privy.fetchImpl, ...extra });
}

function verifies(address: string, payload: Uint8Array, sigB64: string): boolean {
  return SDK.Keypair.fromPublicKey(address).verify(Buffer.from(payload), Buffer.from(sigB64, 'base64'));
}

const TX_HASH = new Uint8Array(32).map((_, i) => i * 7);

describe('PrivyWalletProvider: documented request shapes', () => {
  it('looks up by external_id, then creates a native stellar wallet with Basic auth and an idempotency key', async () => {
    const privy = fakePrivy();
    const wallet = await provider(privy).getOrCreateWallet('inv-1', EMAIL);

    expect(privy.calls).toHaveLength(2);
    const [lookup, create] = privy.calls as [Call, Call];
    expect(lookup).toEqual({
      method: 'GET',
      url: `${API}/v1/wallets?external_id=inv-inv-1`,
      headers: { authorization: BASIC, 'privy-app-id': 'app-id' },
      body: undefined,
    });
    expect(create).toEqual({
      method: 'POST',
      url: `${API}/v1/wallets`,
      headers: {
        authorization: BASIC,
        'privy-app-id': 'app-id',
        'content-type': 'application/json',
        'privy-idempotency-key': 'wallet-create:inv-inv-1',
      },
      body: { chain_type: 'stellar', external_id: 'inv-inv-1' },
    });
    // Native G-address, no conversion: exactly the key Privy holds.
    expect(wallet).toEqual({
      investorId: 'inv-1',
      stellarAddress: privy.wallets[0]!.kp.publicKey(),
      provider: 'privy-embedded',
    });
  });

  it('signs a Stellar tx hash via raw_sign (0x-hex in, 0x-hex out) and returns a verifiable base64 signature', async () => {
    const privy = fakePrivy();
    const p = provider(privy);
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);
    const sig = await p.signRaw('inv-1', TX_HASH);

    const call = privy.calls.at(-1)!;
    expect(call).toEqual({
      method: 'POST',
      url: `${API}/v1/wallets/wlt1/raw_sign`,
      headers: { authorization: BASIC, 'privy-app-id': 'app-id', 'content-type': 'application/json' },
      body: { params: { hash: `0x${Buffer.from(TX_HASH).toString('hex')}` } },
    });
    expect(Buffer.from(sig, 'base64')).toHaveLength(64);
    expect(verifies(wallet.stellarAddress, TX_HASH, sig)).toBe(true);
  });

  it('a second call is served from the directory: no Privy traffic', async () => {
    const privy = fakePrivy();
    const p = provider(privy);
    const first = await p.getOrCreateWallet('inv-1', EMAIL);
    const calls = privy.calls.length;
    expect(await p.getOrCreateWallet('inv-1', EMAIL)).toEqual(first);
    expect(privy.calls).toHaveLength(calls);
  });

  it('legacy solana wallets sign via rpc signMessage (base64 in/out) against the converted G-address', async () => {
    const privy = fakePrivy();
    const p = provider(privy, { chainType: 'solana' });
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);
    expect(privy.creates()[0]!.body).toEqual({ chain_type: 'solana', external_id: 'inv-inv-1' });
    expect(wallet.stellarAddress).toBe(privy.wallets[0]!.kp.publicKey()); // base58 -> G, same key

    const sig = await p.signRaw('inv-1', TX_HASH);
    expect(privy.calls.at(-1)).toEqual({
      method: 'POST',
      url: `${API}/v1/wallets/wlt1/rpc`,
      headers: { authorization: BASIC, 'privy-app-id': 'app-id', 'content-type': 'application/json' },
      body: { method: 'signMessage', params: { message: Buffer.from(TX_HASH).toString('base64'), encoding: 'base64' } },
    });
    expect(verifies(wallet.stellarAddress, TX_HASH, sig)).toBe(true);
  });

  it('directory records written before chain types were stored are treated as solana', async () => {
    const privy = fakePrivy();
    const legacy = privy.newWallet({ chain_type: 'solana' });
    const directory = new MemoryWalletDirectory();
    directory.put('inv-old', { walletId: legacy.id, address: legacy.kp.publicKey() }); // no chainType
    const sig = await provider(privy, { directory }).signRaw('inv-old', TX_HASH);

    expect(privy.calls.map((c) => c.url)).toEqual([`${API}/v1/wallets/${legacy.id}/rpc`]);
    expect(verifies(legacy.kp.publicKey(), TX_HASH, sig)).toBe(true);
  });

  it('surfaces unusable payloads as errors (verification still happens downstream)', async () => {
    const noShape = vi.fn(async () => json(200, { unexpected: true, data: [] }));
    await expect(new PrivyWalletProvider({ ...APP, fetchImpl: noShape }).getOrCreateWallet('inv-2', EMAIL))
      .rejects.toThrow(/unusable wallet payload/);

    const notAKey = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes('?') ? json(200, { data: [] }) : json(200, { id: 'w', address: '0xNotBase58', chain_type: 'stellar' }));
    await expect(new PrivyWalletProvider({ ...APP, fetchImpl: notAKey }).getOrCreateWallet('inv-3', EMAIL))
      .rejects.toThrow(/unusable wallet payload/);

    const kp = SDK.Keypair.random();
    const evm = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes('?') ? json(200, { data: [] }) : json(200, { id: 'w', address: kp.publicKey(), chain_type: 'ethereum' }));
    await expect(new PrivyWalletProvider({ ...APP, fetchImpl: evm }).getOrCreateWallet('inv-4', EMAIL))
      .rejects.toThrow(/unusable wallet payload/);

    const directory = new MemoryWalletDirectory();
    directory.put('inv-5', { walletId: 'w', address: kp.publicKey(), chainType: 'stellar' });
    for (const data of [
      { signature: '0x1234', encoding: 'hex' }, // wrong length
      { signature: `0x${'ab'.repeat(64)}`, encoding: 'base64' }, // wrong encoding
      {},
    ]) {
      const bad = vi.fn(async () => json(200, { method: 'raw_sign', data }));
      await expect(new PrivyWalletProvider({ ...APP, fetchImpl: bad, directory }).signRaw('inv-5', TX_HASH))
        .rejects.toThrow(/unusable signature payload/);
    }
  });

  it('HTTP errors name the endpoint and status, never the app secret', async () => {
    const down = vi.fn(async () => json(503, { error: 'maintenance' }));
    const err = (await new PrivyWalletProvider({ ...APP, fetchImpl: down })
      .getOrCreateWallet('inv-1', EMAIL)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Privy \/v1\/wallets failed: HTTP 503/);
    expect(err.message).not.toContain('app-secret');
  });

  it('refuses incomplete configuration', () => {
    expect(() => new PrivyWalletProvider({ appId: 'a', appSecret: '' })).toThrow(/appSecret/);
    expect(() => new PrivyWalletProvider({ ...APP, ownerId: 'quorum' })).toThrow(/authorizationSignature/);
  });
});

describe('PrivyWalletProvider: one wallet per investor', () => {
  it('survives a restart: the JSON file directory returns the same wallet, no second create', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'wallet-dir-')), 'nested', 'wallets.json');
    const privy = fakePrivy();
    const beforeDir = new JsonFileWalletDirectory(path);
    const original = await provider(privy, { directory: beforeDir }).getOrCreateWallet('inv-1', EMAIL);
    await beforeDir.close();

    // New process: fresh provider and directory over the same file.
    const afterDir = new JsonFileWalletDirectory(path);
    const after = provider(privy, { directory: afterDir });
    const sig = await after.signRaw('inv-1', TX_HASH); // no getOrCreate needed
    expect(verifies(original.stellarAddress, TX_HASH, sig)).toBe(true);
    expect(await after.getOrCreateWallet('inv-1', EMAIL)).toEqual(original);
    expect(privy.creates()).toHaveLength(1);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      wallets: { 'inv-1': { walletId: 'wlt1', address: original.stellarAddress, chainType: 'stellar' } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, '..'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await afterDir.close();
  });

  it('a lost directory is recovered from Privy by external_id: same wallet, no create', async () => {
    const privy = fakePrivy();
    const original = await provider(privy).getOrCreateWallet('inv-1', EMAIL);

    const recovered = provider(privy); // empty directory
    expect(await recovered.getOrCreateWallet('inv-1', EMAIL)).toEqual(original);
    expect(privy.creates()).toHaveLength(1);
    expect(verifies(original.stellarAddress, TX_HASH, await recovered.signRaw('inv-1', TX_HASH))).toBe(true);
  });

  it('concurrent first calls for one investor create exactly one wallet', async () => {
    const privy = fakePrivy();
    const p = provider(privy);
    const handles = await Promise.all([1, 2, 3].map(() => p.getOrCreateWallet('inv-1', EMAIL)));

    expect(privy.creates()).toHaveLength(1);
    expect(new Set(handles.map((h) => h.stellarAddress)).size).toBe(1);
  });

  it('binds before returning: a failed write is an error, and the retry recovers the same wallet', async () => {
    const privy = fakePrivy();
    const directory = new MemoryWalletDirectory();
    vi.spyOn(directory, 'put').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const p = provider(privy, { directory });

    await expect(p.getOrCreateWallet('inv-1', EMAIL)).rejects.toThrow(/disk full/);
    await expect(p.signRaw('inv-1', TX_HASH)).rejects.toThrow(/no Privy wallet/);
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);
    expect(wallet.stellarAddress).toBe(privy.wallets[0]!.kp.publicKey());
    expect(privy.wallets).toHaveLength(1);
  });

  it('lost create response: the retry finds the wallet Privy did create', async () => {
    const privy = fakePrivy();
    privy.faults.push('drop-response');
    const p = provider(privy);

    await expect(p.getOrCreateWallet('inv-1', EMAIL)).rejects.toThrow(/fetch failed/);
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);
    expect(wallet.stellarAddress).toBe(privy.wallets[0]!.kp.publicKey());
    expect(privy.wallets).toHaveLength(1);
  });

  it('lost create response without external_id: the same idempotency key makes Privy replay, not repeat', async () => {
    const privy = fakePrivy();
    privy.faults.push('drop-response');
    const p = provider(privy, { externalId: false });

    await expect(p.getOrCreateWallet('inv-1', EMAIL)).rejects.toThrow(/fetch failed/);
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);

    const [first, retry] = privy.creates() as [Call, Call];
    expect(first.body).toEqual({ chain_type: 'stellar' });
    expect(first.headers['privy-idempotency-key']).toMatch(/^wallet-create:sha256-[A-Za-z0-9_-]{43}$/);
    expect(retry.headers['privy-idempotency-key']).toBe(first.headers['privy-idempotency-key']);
    expect(privy.calls.some((c) => c.method === 'GET')).toBe(false); // nothing to look up by
    expect(privy.wallets).toHaveLength(1);
    expect(wallet.stellarAddress).toBe(privy.wallets[0]!.kp.publicKey());
  });

  it('after Privy answers with an error (cached under the key) the next attempt uses a fresh key', async () => {
    const privy = fakePrivy();
    privy.faults.push('http-500');
    const p = provider(privy);

    await expect(p.getOrCreateWallet('inv-1', EMAIL)).rejects.toThrow(/HTTP 500/);
    await p.getOrCreateWallet('inv-1', EMAIL);

    expect(privy.creates().map((c) => c.headers['privy-idempotency-key'])).toEqual([
      'wallet-create:inv-inv-1',
      'wallet-create:inv-inv-1:retry-1',
    ]);
    expect(privy.wallets).toHaveLength(1);
  });

  it('a create refused because the external_id exists binds the existing wallet', async () => {
    const privy = fakePrivy();
    privy.faults.push('created-elsewhere'); // another process wins between lookup and create
    const wallet = await provider(privy).getOrCreateWallet('inv-1', EMAIL);

    expect(privy.wallets).toHaveLength(1);
    expect(wallet.stellarAddress).toBe(privy.wallets[0]!.kp.publicKey());
  });

  it('never binds a wallet whose external_id does not match, even if the server ignores the filter', async () => {
    const privy = fakePrivy();
    privy.newWallet({ chain_type: 'stellar', external_id: 'inv-someone-else' });
    const unfiltered = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      privy.fetchImpl(String(input).replace(/\?external_id=.*$/, ''), init));
    const wallet = await new PrivyWalletProvider({ ...APP, fetchImpl: unfiltered }).getOrCreateWallet('inv-1', EMAIL);

    expect(privy.wallets).toHaveLength(2);
    expect(wallet.stellarAddress).toBe(privy.wallets[1]!.kp.publicKey());
  });
});

describe('PrivyWalletProvider: optional linking and ownership', () => {
  it('links the Privy user as the wallet entity (attribution only, not owner)', async () => {
    const privy = fakePrivy();
    const p = provider(privy, { privyUserId: (investorId, email) => (email === EMAIL ? `did:privy:${investorId}` : undefined) });
    await p.getOrCreateWallet('inv-1', EMAIL);

    expect(privy.creates()[0]!.body).toEqual({
      chain_type: 'stellar',
      external_id: 'inv-inv-1',
      entity: { id: 'did:privy:inv-1', type: 'user' },
    });
    // Ownerless, so the app secret alone still signs.
    expect(verifies(privy.wallets[0]!.kp.publicKey(), TX_HASH, await p.signRaw('inv-1', TX_HASH))).toBe(true);
  });

  it('owned wallets: owner_id on create, P-256 authorization signature on every signing request', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const authKey = `wallet-auth:${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`;
    const privy = fakePrivy({ ownerKeys: new Map([['quorum-1', publicKey]]) });
    const p = provider(privy, { ownerId: 'quorum-1', authorizationSignature: privyAuthorizationSigner(authKey) });
    const wallet = await p.getOrCreateWallet('inv-1', EMAIL);
    expect(privy.creates()[0]!.body).toEqual({ chain_type: 'stellar', external_id: 'inv-inv-1', owner_id: 'quorum-1' });
    expect(privy.creates()[0]!.headers).not.toHaveProperty('privy-authorization-signature');

    const sig = await p.signRaw('inv-1', TX_HASH);
    expect(privy.calls.at(-1)!.headers['privy-authorization-signature']).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(verifies(wallet.stellarAddress, TX_HASH, sig)).toBe(true);

    // Without the signature the fake (like Privy) refuses the owned wallet.
    const unsigned = new PrivyWalletProvider({ ...APP, fetchImpl: privy.fetchImpl, directory: new MemoryWalletDirectory() });
    await unsigned.getOrCreateWallet('inv-1', EMAIL); // recovered by external_id
    await expect(unsigned.signRaw('inv-1', TX_HASH)).rejects.toThrow(/HTTP 401/);
  });

  it('custom or disabled idempotency keys and external ids', async () => {
    const privy = fakePrivy();
    await provider(privy, {
      externalId: (id) => `uf_${id}`,
      createIdempotencyKey: (id) => `onboarding/${id}`,
    }).getOrCreateWallet('inv-7', EMAIL);
    expect(privy.creates()[0]!.headers['privy-idempotency-key']).toBe('onboarding/inv-7');
    expect(privy.creates()[0]!.body).toEqual({ chain_type: 'stellar', external_id: 'uf_inv-7' });

    await provider(privy, { createIdempotencyKey: false }).getOrCreateWallet('inv-8', EMAIL);
    expect(privy.creates()[1]!.headers).not.toHaveProperty('privy-idempotency-key');

    await expect(provider(privy, { externalId: () => 'has space' }).getOrCreateWallet('inv-9', EMAIL))
      .rejects.toThrow(/external_id/);
  });
});

describe('defaultExternalId / canonicalJson', () => {
  it('readable for safe ids, hashed otherwise, always a valid external_id, never colliding', () => {
    expect(defaultExternalId('3f2a-uuid_1')).toBe('inv-3f2a-uuid_1');
    const hashed = defaultExternalId('investor@urbanflip.es');
    expect(hashed).toMatch(/^invh-[A-Za-z0-9_-]{43}$/);
    expect(defaultExternalId('x'.repeat(61))).toMatch(/^invh-/);
    for (const id of ['a', 'x'.repeat(60), 'x'.repeat(61), 'ñandú', 'a/b']) {
      expect(defaultExternalId(id)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
    // 'inv-' + id and 'invh-' + hash cannot meet: the 4th character differs.
    expect(defaultExternalId(`h-${hashed.slice(5)}`)).not.toBe(hashed);
  });

  it('canonicalJson sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
  });
});

describe('toStellarAddress (Solana base58 -> Stellar G-address, same Ed25519 key)', () => {
  it('converts known Solana addresses and passes G-addresses through', () => {
    // System Program: 32 zero bytes.
    expect(toStellarAddress('11111111111111111111111111111111')).toBe(
      SDK.StrKey.encodeEd25519PublicKey(Buffer.alloc(32)),
    );
    // SPL Token program id.
    expect(toStellarAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(
      SDK.StrKey.encodeEd25519PublicKey(
        Buffer.from('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9', 'hex'),
      ),
    );
    const kp = SDK.Keypair.random();
    expect(toStellarAddress(base58(kp.rawPublicKey()))).toBe(kp.publicKey());
    expect(toStellarAddress(kp.publicKey())).toBe(kp.publicKey());
  });

  it('rejects anything that is not a 32-byte key', () => {
    expect(toStellarAddress('')).toBeUndefined();
    expect(toStellarAddress('0OIl')).toBeUndefined(); // not base58
    expect(toStellarAddress(base58(new Uint8Array(31).fill(5)))).toBeUndefined();
    expect(toStellarAddress('G' + 'A'.repeat(55))).toBeUndefined(); // bad checksum, not base58 of 32 bytes
  });
});
