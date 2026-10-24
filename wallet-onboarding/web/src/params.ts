/**
 * Widget input. Everything arrives in the URL fragment, which browsers never
 * send to a server, so the session token stays out of access logs:
 *
 *   #investor=<id>&deal=<dealId>&session=<token>&network=testnet|public&parent=<origin>&lang=es|en
 *
 * Values are percent-decoded; a literal `+` stays a `+` (a base64 token
 * survives even when the host forgets to encode it).
 */

export type Lang = 'es' | 'en';
export type NetworkName = 'testnet' | 'public';

export const PASSPHRASES: Record<NetworkName, string> = {
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
};

export interface WidgetParams {
  investorId: string;
  dealId: string;
  session: string;
  network: NetworkName;
  networkPassphrase: string;
  /** Exact origin of the host page; the only postMessage target. */
  parentOrigin: string;
  lang: Lang;
}

export type ParamName = 'investor' | 'deal' | 'session' | 'network' | 'parent';

export type ParseResult =
  | { ok: true; params: WidgetParams }
  | {
      ok: false;
      lang: Lang;
      invalid: ParamName[];
      /** Set when `parent` itself is valid, so the host can still be told. */
      parentOrigin?: string;
      investorId: string;
      dealId: string;
    };

const ID_RE = /^[A-Za-z0-9._~:-]{1,128}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function readFragment(hash: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      continue; // malformed escape: treat as absent
    }
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/**
 * Returns the origin when `value` is exactly an origin (scheme://host[:port],
 * no path, no trailing slash): https anywhere, http only on localhost.
 */
export function parseOrigin(value: string | undefined): string | undefined {
  if (!value || value === '*' || value === 'null') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.origin !== value) return undefined;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  return undefined;
}

export function parseFragment(hash: string): ParseResult {
  const raw = readFragment(hash);
  const lang: Lang = raw.get('lang') === 'en' ? 'en' : 'es';
  const invalid: ParamName[] = [];

  const investorId = raw.get('investor') ?? '';
  if (!ID_RE.test(investorId)) invalid.push('investor');

  const dealId = raw.get('deal') ?? '';
  if (!ID_RE.test(dealId)) invalid.push('deal');

  const session = raw.get('session') ?? '';
  if (!TOKEN_RE.test(session)) invalid.push('session');

  const networkRaw = raw.get('network') || 'testnet';
  const network = networkRaw === 'testnet' || networkRaw === 'public' ? networkRaw : undefined;
  if (!network) invalid.push('network');

  const parentOrigin = parseOrigin(raw.get('parent'));
  if (!parentOrigin) invalid.push('parent');

  if (invalid.length > 0 || !network || !parentOrigin) {
    return { ok: false, lang, invalid, parentOrigin, investorId, dealId };
  }
  return {
    ok: true,
    params: {
      investorId,
      dealId,
      session,
      network,
      networkPassphrase: PASSPHRASES[network],
      parentOrigin,
      lang,
    },
  };
}
