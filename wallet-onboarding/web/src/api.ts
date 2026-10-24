/**
 * Client for the backend's external-wallet endpoints. Same origin as the
 * widget (the backend serves both /widget/ and /v1/), so no CORS. Every call
 * sends `Authorization: Bearer <session>`; errors are non-2xx with
 * `{"error": string}`.
 */

export type ApiStep = 'challenge' | 'verify' | 'trustline' | 'submit';

export class ApiError extends Error {
  constructor(
    readonly step: ApiStep,
    /** HTTP status; 0 when the request never got a response. */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A challenge or transaction the wallet must sign before `deadline`. */
export interface Signable {
  xdr: string;
  networkPassphrase: string;
  /** `expires_at` mapped onto the local clock (ms), corrected for clock skew. */
  deadline: number;
}

export type TrustlineResult = { status: 'ready'; address: string } | ({ status: 'sign' } & Signable);

export interface WalletApi {
  challenge(address: string): Promise<Signable>;
  verify(signedXdr: string): Promise<{ address: string }>;
  trustline(dealId: string): Promise<TrustlineResult>;
  submitTrustline(dealId: string, signedXdr: string): Promise<{ txHash: string }>;
}

export interface ApiOptions {
  investorId: string;
  session: string;
  /** Defaults to '' (same origin). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

type Json = Record<string, unknown>;

/**
 * True when the backend says a challenge or transaction expired: HTTP 410, or
 * an `error` string that mentions "expired".
 */
export function isExpiredError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 410 || /expired/i.test(e.message));
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function createApi(opts: ApiOptions): WalletApi {
  const base = `${opts.baseUrl ?? ''}/v1/investors/${encodeURIComponent(opts.investorId)}/external-wallet`;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const now = opts.now ?? Date.now;

  async function post(step: ApiStep, path: string, body: Json): Promise<{ json: Json; serverNow?: number }> {
    const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${opts.session}`,
        },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (e) {
      const reason = controller.signal.aborted ? 'request timed out' : (e as Error)?.message || 'network error';
      throw new ApiError(step, 0, reason);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const message = json && typeof json === 'object' && typeof (json as Json).error === 'string'
        ? (json as { error: string }).error
        : `HTTP ${res.status}`;
      throw new ApiError(step, res.status, message);
    }
    if (!json || typeof json !== 'object') {
      throw new ApiError(step, res.status, 'unexpected response from server');
    }
    const date = Date.parse(res.headers.get('date') ?? '');
    return { json: json as Json, serverNow: Number.isFinite(date) ? date : undefined };
  }

  function signable(step: ApiStep, json: Json, xdrKey: string, serverNow: number | undefined): Signable {
    const xdr = json[xdrKey];
    const passphrase = json.network_passphrase;
    const expiresAt = json.expires_at;
    if (!nonEmptyString(xdr) || !nonEmptyString(passphrase) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      throw new ApiError(step, 200, 'unexpected response from server');
    }
    // expires_at is unix seconds. Measure the remaining lifetime against the
    // server's clock (Date header) so a skewed device clock does not matter.
    const local = now();
    const remaining = expiresAt * 1000 - (serverNow ?? local);
    return { xdr, networkPassphrase: passphrase, deadline: local + remaining };
  }

  return {
    async challenge(address) {
      const { json, serverNow } = await post('challenge', '/challenge', { address });
      return signable('challenge', json, 'challenge_xdr', serverNow);
    },

    async verify(signedXdr) {
      const { json } = await post('verify', '/verify', { signed_xdr: signedXdr });
      if (json.linked !== true || !nonEmptyString(json.address)) {
        throw new ApiError('verify', 200, 'unexpected response from server');
      }
      return { address: json.address };
    },

    async trustline(dealId) {
      const { json, serverNow } = await post('trustline', '/trustline', { deal_id: dealId });
      if (json.status === 'ready' && nonEmptyString(json.address)) {
        return { status: 'ready', address: json.address };
      }
      if (json.status === 'sign') {
        return { status: 'sign', ...signable('trustline', json, 'xdr', serverNow) };
      }
      throw new ApiError('trustline', 200, 'unexpected response from server');
    },

    async submitTrustline(dealId, signedXdr) {
      const { json } = await post('submit', '/trustline/submit', { deal_id: dealId, signed_xdr: signedXdr });
      if (json.status !== 'submitted' || !nonEmptyString(json.trustline_tx_hash)) {
        throw new ApiError('submit', 200, 'unexpected response from server');
      }
      return { txHash: json.trustline_tx_hash };
    },
  };
}
