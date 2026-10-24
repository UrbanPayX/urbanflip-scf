import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import * as SDK from '@stellar/stellar-sdk';
import type { WalletHandle } from '../types';
import type { WalletProvider } from './provider';
import {
  MemoryWalletDirectory,
  type WalletChainType,
  type WalletDirectory,
  type WalletRecord,
} from './wallet-directory';

/**
 * Adapter: Privy server-side wallet API (https://docs.privy.io), checked
 * against the API reference. Every request carries
 *   Authorization: Basic base64(appId:appSecret)  and  privy-app-id: <appId>
 * (https://docs.privy.io/basics/rest-api/setup).
 *
 *   GET  /v1/wallets?external_id=<id>     find the investor's wallet (recovery)
 *        -> { data: Wallet[], next_cursor? }
 *   POST /v1/wallets                      create
 *        { chain_type: 'stellar', external_id, entity?, owner_id? }
 *        header privy-idempotency-key (24h; errors are cached under the key)
 *        -> Wallet { id, address, chain_type, ... }
 *   POST /v1/wallets/{id}/raw_sign        Stellar (tier 2) wallets
 *        { params: { hash: '0x<hex>' } } -> { data: { signature: '0x<hex>', encoding: 'hex' } }
 *   POST /v1/wallets/{id}/rpc             Solana wallets (legacy records)
 *        { method: 'signMessage', params: { message: <base64>, encoding: 'base64' } }
 *        -> { method: 'signMessage', data: { signature: <base64>, encoding: 'base64' } }
 *
 * Stellar signs a transaction by Ed25519-signing its 32-byte hash, which is
 * exactly what raw_sign does with `hash`. Solana wallets are also Ed25519, so
 * signMessage over the same 32 bytes yields the same signature; wallets
 * created as `solana` by earlier versions keep working, their base58 address
 * re-encoded as a G-address by toStellarAddress.
 *
 * Wallets are created without an owner, so the app secret alone authorizes
 * signing. With `ownerId` (a key quorum), signing requests also need a
 * privy-authorization-signature: supply `authorizationSignature`.
 *
 * The investor -> wallet binding lives in a WalletDirectory, consulted first;
 * Privy is searched by external_id before any create, and the record is
 * written before a handle is returned. Signatures are verified downstream by
 * the pipeline against the wallet's address, before anything is submitted.
 */
export interface PrivyProviderConfig {
  appId: string;
  appSecret: string;
  /** Default https://api.privy.io. */
  baseUrl?: string;
  /** Chain for new wallets. Default 'stellar' (native G-address, raw_sign). */
  chainType?: WalletChainType;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Durable investorId -> wallet binding. Defaults to in-memory, which is lost on restart. */
  directory?: WalletDirectory;
  /**
   * external_id stored on the Privy wallet (unique per app, write-once,
   * [A-Za-z0-9_-]{1,64}). Lets a lost directory entry be recovered from
   * Privy and makes a second wallet for the investor impossible. Must stay
   * stable for the life of the Privy app. Default: defaultExternalId. `false`
   * disables lookup and the uniqueness guard.
   */
  externalId?: ((investorId: string) => string) | false;
  /**
   * privy-idempotency-key for wallet creation (max 256 chars). Default:
   * stable per investor, so a create whose response was lost is replayed by
   * Privy rather than repeated. After Privy answers with an error (cached
   * under the key for 24h) the next attempt in this process uses a fresh
   * derived key, as Privy's docs require. `false` sends no key.
   */
  createIdempotencyKey?: ((investorId: string) => string) | false;
  /**
   * Optional link to the investor's Privy user (e.g. 'did:privy:...'), sent
   * as the wallet's `entity` (attribution, immutable; grants no control).
   * Deliberately not `owner`: a user-owned wallet needs the user's JWT for
   * every signature, which a backend signing while the investor is offline
   * does not have.
   */
  privyUserId?: (investorId: string, email: string) => string | undefined | Promise<string | undefined>;
  /** Optional key quorum id set as owner of new wallets; requires authorizationSignature. */
  ownerId?: string;
  /**
   * Produces privy-authorization-signature for signing requests (see
   * privyAuthorizationSigner). Needed only for wallets that have an owner.
   */
  authorizationSignature?: (payload: PrivyAuthorizationPayload) => string | Promise<string>;
}

/** The documented signature payload for privy-authorization-signature. */
export interface PrivyAuthorizationPayload {
  version: 1;
  method: 'POST';
  url: string;
  body: unknown;
  /** Only privy-* headers: privy-app-id always, privy-idempotency-key when sent. */
  headers: Record<string, string>;
}

/** Privy answered with a non-2xx status. */
export class PrivyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`Privy ${path} failed: HTTP ${status}${detail ? ` ${detail}` : ''}`);
    this.name = 'PrivyHttpError';
  }
}

const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IDEMPOTENCY_KEY = 256;

export class PrivyWalletProvider implements WalletProvider {
  readonly providerName = 'privy-embedded';
  private readonly baseUrl: string;
  private readonly chainType: WalletChainType;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly directory: WalletDirectory;
  private readonly basicAuth: string;
  private readonly creating = new Map<string, Promise<WalletRecord>>();
  /** Bumped when Privy answers a create with an error: that key now replays it. */
  private readonly keyGeneration = new Map<string, number>();

  constructor(private readonly cfg: PrivyProviderConfig) {
    if (!cfg.appId || !cfg.appSecret) throw new Error('Privy appId and appSecret are required');
    this.chainType = cfg.chainType ?? 'stellar';
    if (this.chainType !== 'stellar' && this.chainType !== 'solana') {
      throw new Error(`unsupported Privy chain type '${String(this.chainType)}'`);
    }
    if (cfg.ownerId && !cfg.authorizationSignature) {
      throw new Error('ownerId requires authorizationSignature: owned wallets cannot sign without it');
    }
    this.baseUrl = (cfg.baseUrl ?? 'https://api.privy.io').replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? 8_000;
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.directory = cfg.directory ?? new MemoryWalletDirectory();
    this.basicAuth = `Basic ${Buffer.from(`${cfg.appId}:${cfg.appSecret}`).toString('base64')}`;
  }

  async getOrCreateWallet(investorId: string, email: string): Promise<WalletHandle> {
    const known = await this.directory.get(investorId);
    if (known) return this.toHandle(investorId, known);
    // Concurrent first calls for one investor share a single lookup/create.
    let pending = this.creating.get(investorId);
    if (!pending) {
      pending = this.provision(investorId, email).finally(() => this.creating.delete(investorId));
      this.creating.set(investorId, pending);
    }
    return this.toHandle(investorId, await pending);
  }

  async signRaw(investorId: string, payload: Uint8Array): Promise<string> {
    const wallet = await this.directory.get(investorId);
    if (!wallet) throw new Error(`no Privy wallet provisioned for '${investorId}'`);
    return (wallet.chainType ?? 'solana') === 'stellar'
      ? this.rawSign(wallet.walletId, payload)
      : this.solanaSignMessage(wallet.walletId, payload);
  }

  private async provision(investorId: string, email: string): Promise<WalletRecord> {
    // Re-checked inside the guard: a bind may have landed since the caller's lookup.
    const known = await this.directory.get(investorId);
    if (known) return known;
    const externalId = this.externalIdFor(investorId);
    const record =
      (externalId ? await this.findByExternalId(externalId) : undefined) ??
      (await this.createWallet(investorId, email, externalId));
    // Bound BEFORE a handle is returned: an unrecorded wallet is an unreachable one.
    await this.directory.put(investorId, record);
    return record;
  }

  private async createWallet(investorId: string, email: string, externalId?: string): Promise<WalletRecord> {
    const body: Record<string, unknown> = { chain_type: this.chainType };
    if (externalId) body.external_id = externalId;
    const userId = await this.cfg.privyUserId?.(investorId, email);
    if (userId) body.entity = { id: userId, type: 'user' };
    if (this.cfg.ownerId) body.owner_id = this.cfg.ownerId;
    const key = this.idempotencyKeyFor(investorId, externalId);
    try {
      const created = await this.request('POST', '/v1/wallets', body, key ? { 'privy-idempotency-key': key } : {});
      return parseWallet(created);
    } catch (err) {
      // No response (timeout, dropped connection): keep the key, so the retry
      // is replayed by Privy. An error response is cached under the key for
      // 24h, so the next attempt must use a new one.
      if (!(err instanceof PrivyHttpError)) throw err;
      this.keyGeneration.set(investorId, (this.keyGeneration.get(investorId) ?? 0) + 1);
      // A refused create can mean the external_id is already taken: by this
      // investor's wallet from an earlier attempt whose response was lost.
      const existing = externalId ? await this.findByExternalId(externalId).catch(() => undefined) : undefined;
      if (existing) return existing;
      throw err;
    }
  }

  private async findByExternalId(externalId: string): Promise<WalletRecord | undefined> {
    const body = await this.request('GET', `/v1/wallets?external_id=${encodeURIComponent(externalId)}`);
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Privy returned an unusable wallet list: ${JSON.stringify(body)}`);
    }
    // Filtered locally too: a server that ignored the filter must not hand us a stranger's wallet.
    const matches = data.filter((w) => (w as { external_id?: unknown } | null)?.external_id === externalId);
    if (matches.length > 1) throw new Error(`Privy lists ${matches.length} wallets with external_id '${externalId}'`);
    return matches.length === 1 ? parseWallet(matches[0]) : undefined;
  }

  private async rawSign(walletId: string, payload: Uint8Array): Promise<string> {
    const body = await this.signRequest(`/v1/wallets/${encodeURIComponent(walletId)}/raw_sign`, {
      params: { hash: `0x${Buffer.from(payload).toString('hex')}` },
    });
    const data = (body as { data?: { signature?: unknown; encoding?: unknown } } | null)?.data;
    const hex = typeof data?.signature === 'string' ? data.signature.replace(/^0x/i, '') : '';
    if ((data?.encoding !== undefined && data.encoding !== 'hex') || !/^[0-9a-fA-F]{128}$/.test(hex)) {
      throw new Error(`Privy returned an unusable signature payload: ${JSON.stringify(body)}`);
    }
    return Buffer.from(hex, 'hex').toString('base64');
  }

  private async solanaSignMessage(walletId: string, payload: Uint8Array): Promise<string> {
    const body = await this.signRequest(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, {
      method: 'signMessage',
      params: { message: Buffer.from(payload).toString('base64'), encoding: 'base64' },
    });
    const data = (body as { data?: { signature?: unknown; encoding?: unknown } } | null)?.data;
    const sig = typeof data?.signature === 'string' ? Buffer.from(data.signature, 'base64') : undefined;
    if ((data?.encoding !== undefined && data.encoding !== 'base64') || sig?.length !== 64) {
      throw new Error(`Privy returned an unusable signature payload: ${JSON.stringify(body)}`);
    }
    return sig.toString('base64');
  }

  /** Wallet-action request: carries an authorization signature when configured. */
  private async signRequest(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.cfg.authorizationSignature) {
      headers['privy-authorization-signature'] = await this.cfg.authorizationSignature({
        version: 1,
        method: 'POST',
        url: this.baseUrl + path,
        body,
        headers: { 'privy-app-id': this.cfg.appId },
      });
    }
    return this.request('POST', path, body, headers);
  }

  private externalIdFor(investorId: string): string | undefined {
    if (this.cfg.externalId === false) return undefined;
    const id = (this.cfg.externalId ?? defaultExternalId)(investorId);
    if (!EXTERNAL_ID.test(id)) throw new Error(`external_id '${id}' must match ${EXTERNAL_ID}`);
    return id;
  }

  private idempotencyKeyFor(investorId: string, externalId?: string): string | undefined {
    if (this.cfg.createIdempotencyKey === false) return undefined;
    const base = this.cfg.createIdempotencyKey
      ? this.cfg.createIdempotencyKey(investorId)
      : `wallet-create:${externalId ?? `sha256-${sha256(investorId)}`}`;
    const generation = this.keyGeneration.get(investorId) ?? 0;
    const key = generation === 0 ? base : `${base}:retry-${generation}`;
    if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY) {
      throw new Error(`privy-idempotency-key must be 1-${MAX_IDEMPOTENCY_KEY} characters`);
    }
    return key;
  }

  private toHandle(investorId: string, wallet: WalletRecord): WalletHandle {
    return { investorId, stellarAddress: wallet.address, provider: this.providerName };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: this.basicAuth,
        'privy-app-id': this.cfg.appId,
        ...extraHeaders,
      };
      if (payload !== undefined) headers['content-type'] = 'application/json';
      const res = await this.doFetch(this.baseUrl + path, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new PrivyHttpError(res.status, path.split('?')[0]!, detail.slice(0, 300));
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Default external_id: `inv-<investorId>` when that is a valid external_id,
 * else `invh-<base64url sha256(investorId)>`. The prefixes differ, so the
 * mapping is injective and one investor can never claim another's wallet.
 */
export function defaultExternalId(investorId: string): string {
  return /^[A-Za-z0-9_-]{1,60}$/.test(investorId)
    ? `inv-${investorId}`
    : `invh-${sha256(investorId)}`;
}

/**
 * Builds privy-authorization-signature values with an authorization private
 * key ('wallet-auth:<base64 PKCS#8 P-256>'), per Privy's direct
 * implementation: RFC 8785-canonical JSON of the payload, ECDSA P-256 over
 * SHA-256, DER signature, base64.
 */
export function privyAuthorizationSigner(authorizationKey: string): (payload: PrivyAuthorizationPayload) => string {
  const der = authorizationKey.replace(/^wallet-auth:/, '');
  const key = createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
  return (payload) => cryptoSign('sha256', Buffer.from(canonicalJson(payload), 'utf8'), key).toString('base64');
}

/** RFC 8785 for JSON values: keys sorted by UTF-16 code units, ECMAScript number/string serialization. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** A Privy Wallet object -> directory record; only Ed25519 chains qualify. */
function parseWallet(body: unknown): WalletRecord {
  const wallet = body as { id?: unknown; address?: unknown; chain_type?: unknown } | null;
  const chainType = wallet?.chain_type;
  const address = typeof wallet?.address === 'string' ? toStellarAddress(wallet.address) : undefined;
  if (typeof wallet?.id !== 'string' || !wallet.id || !address || (chainType !== 'stellar' && chainType !== 'solana')) {
    throw new Error(`Privy returned an unusable wallet payload: ${JSON.stringify(body)}`);
  }
  return { walletId: wallet.id, address, chainType };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url');
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Privy reports a Solana wallet's address as its 32-byte Ed25519 public key
 * in base58; Stellar needs the same key as a StrKey G-address. A G-address
 * (what Privy returns for chain_type 'stellar') passes through. Undefined for
 * anything else.
 */
export function toStellarAddress(address: string): string | undefined {
  if (SDK.StrKey.isValidEd25519PublicKey(address)) return address;
  const raw = decodeBase58(address);
  return raw?.length === 32 ? SDK.StrKey.encodeEd25519PublicKey(Buffer.from(raw)) : undefined;
}

function decodeBase58(text: string): Uint8Array | undefined {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value /= 256n) bytes.unshift(Number(value % 256n));
  // Each leading '1' encodes a leading zero byte.
  for (let i = 0; i < text.length && text[i] === '1'; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}
