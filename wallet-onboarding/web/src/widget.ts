/**
 * Wires the fragment params, the backend client, the wallet (Stellar Wallets
 * Kit) and the page, and reports the outcome to the host page with
 * `window.parent.postMessage(message, parentOrigin)`. The target origin is
 * always the validated `parent` param, never "*".
 */
import { ApiError, createApi, isExpiredError } from './api';
import { ConnectFlow, FlowError, isCancellation, type Phase } from './flow';
import { networkName, shortAddress, type ErrorKey } from './i18n';
import { parseFragment, parseOrigin, type NetworkName } from './params';
import { createUi, type View } from './ui';
import { createKitWallet, WalletError, type WalletPort } from './wallet';

export const MESSAGE_TYPE = 'urbanflip:wallet';

export interface WalletMessage {
  type: typeof MESSAGE_TYPE;
  status: 'ready' | 'cancelled' | 'error';
  investorId: string;
  dealId: string;
  address?: string;
  trustlineTxHash?: string;
  error?: string;
}

export interface StartOptions {
  win?: Window;
  /** Test seam; defaults to Stellar Wallets Kit. */
  wallet?: WalletPort;
  fetchImpl?: typeof fetch;
}

export interface WidgetHandle {
  /** Starts (or retries) the flow, as the main button does. */
  run(): Promise<void>;
}

function post(win: Window, parentOrigin: string, message: WalletMessage): void {
  // Re-checked here so no code path can ever post with "*".
  if (parseOrigin(parentOrigin) !== parentOrigin) return;
  win.parent.postMessage(message, parentOrigin);
}

function explorerTxUrl(network: NetworkName, hash: string): string {
  return `https://stellar.expert/explorer/${network}/tx/${encodeURIComponent(hash)}`;
}

interface Described {
  key: ErrorKey;
  /** Shown to the investor. */
  detail: string;
  /** Sent to the host in `error`: "<code>: <detail>". */
  wire: string;
  networkHint: boolean;
}

function describe(e: unknown, lang: 'es' | 'en'): Described {
  if (e instanceof FlowError) {
    const actual = e.detail.actual ?? '';
    const detail =
      e.code === 'wrong_network' ? networkName(actual, lang) : e.code === 'wrong_account' ? shortAddress(actual) : e.message;
    return { key: e.code, detail, wire: `${e.code}: ${e.message}`, networkHint: false };
  }
  if (e instanceof ApiError) {
    const wireDetail = `${e.step} failed (HTTP ${e.status}): ${e.message}`;
    if (isExpiredError(e)) return { key: 'expired', detail: e.message, wire: `expired: ${wireDetail}`, networkHint: false };
    if (e.status === 401 || e.status === 403) {
      return { key: 'unauthorized', detail: e.message, wire: `unauthorized: ${wireDetail}`, networkHint: false };
    }
    // A signature made on the wrong network fails verification on the server;
    // wallets that cannot report their network only surface it here.
    const signed = (e.step === 'verify' || e.step === 'submit') && e.status >= 400 && e.status < 500;
    return { key: 'backend_error', detail: e.message, wire: `backend_error: ${wireDetail}`, networkHint: signed };
  }
  if (e instanceof WalletError) {
    return { key: 'wallet_error', detail: e.message, wire: `wallet_error: ${e.message}`, networkHint: false };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { key: 'internal_error', detail: message, wire: `internal_error: ${message}`, networkHint: false };
}

export function start(opts: StartOptions = {}): WidgetHandle | undefined {
  const win = opts.win ?? window;
  const parsed = parseFragment(win.location.hash);

  if (!parsed.ok) {
    createUi(win.document, parsed.lang).render({ kind: 'invalid', fields: parsed.invalid });
    if (parsed.parentOrigin) {
      post(win, parsed.parentOrigin, {
        type: MESSAGE_TYPE,
        status: 'error',
        investorId: parsed.investorId,
        dealId: parsed.dealId,
        error: `invalid_params: ${parsed.invalid.join(', ')}`,
      });
    }
    return undefined;
  }

  const p = parsed.params;
  const ui = createUi(win.document, p.lang, p.networkPassphrase);
  const wallet = opts.wallet ?? createKitWallet(p.networkPassphrase, p.lang);
  const api = createApi({ investorId: p.investorId, session: p.session, fetchImpl: opts.fetchImpl });
  const base = { type: MESSAGE_TYPE, investorId: p.investorId, dealId: p.dealId } as const;

  let pendingConfirm: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let finished = false;

  const flow = new ConnectFlow({
    api,
    wallet,
    dealId: p.dealId,
    networkPassphrase: p.networkPassphrase,
    onPhase(phase: Phase, info) {
      const view: View =
        phase === 'confirm_challenge' || phase === 'confirm_trustline'
          ? { kind: 'confirm', step: phase === 'confirm_challenge' ? 'challenge' : 'trustline', info }
          : { kind: 'busy', phase, info };
      ui.render(view);
    },
    confirm() {
      return new Promise<void>((resolve) => {
        pendingConfirm = resolve;
      });
    },
  });

  async function execute(): Promise<void> {
    try {
      const outcome = await flow.run();
      finished = true;
      ui.render({
        kind: 'done',
        address: outcome.address,
        txUrl: outcome.txHash ? explorerTxUrl(p.network, outcome.txHash) : undefined,
      });
      post(win, p.parentOrigin, {
        ...base,
        status: 'ready',
        address: outcome.address,
        ...(outcome.txHash ? { trustlineTxHash: outcome.txHash } : {}),
      });
    } catch (e) {
      const address = flow.linkedAddress;
      if (isCancellation(e)) {
        ui.render({ kind: 'cancelled' });
        post(win, p.parentOrigin, { ...base, status: 'cancelled', ...(address ? { address } : {}) });
        return;
      }
      const d = describe(e, p.lang);
      ui.render({ kind: 'error', key: d.key, detail: d.detail, networkHint: d.networkHint });
      post(win, p.parentOrigin, { ...base, status: 'error', ...(address ? { address } : {}), error: d.wire });
    }
  }

  function run(): Promise<void> {
    if (finished) return Promise.resolve();
    if (!running) {
      running = execute().finally(() => {
        running = undefined;
      });
    }
    return running;
  }

  ui.onAction(() => {
    if (pendingConfirm) {
      const resolve = pendingConfirm;
      pendingConfirm = undefined;
      ui.render({ kind: 'working' }); // busy at once, so a double click does nothing
      resolve();
      return;
    }
    void run();
  });

  ui.render({ kind: 'idle' });
  return { run };
}
