import type { Phase, PhaseInfo, SignStep } from './flow';
import { networkName, shortAddress, STRINGS, type ErrorKey } from './i18n';
import type { Lang, ParamName } from './params';

export type View =
  | { kind: 'invalid'; fields: ParamName[] }
  | { kind: 'idle' }
  | { kind: 'busy'; phase: Phase; info: PhaseInfo }
  /** Between a click and the flow's next phase. */
  | { kind: 'working' }
  | { kind: 'confirm'; step: SignStep; info: PhaseInfo }
  | { kind: 'done'; address: string; txUrl?: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; key: ErrorKey; detail: string; networkHint: boolean };

export interface Ui {
  render(view: View): void;
  onAction(handler: () => void): void;
}

const STEP_OF_PHASE: Record<Phase, number> = {
  connecting: 0,
  requesting_challenge: 1,
  confirm_challenge: 1,
  signing_challenge: 1,
  verifying: 1,
  preparing_trustline: 2,
  confirm_trustline: 2,
  signing_trustline: 2,
  submitting: 2,
};

function el<T extends HTMLElement>(doc: Document, id: string): T {
  const found = doc.getElementById(id);
  if (!found) throw new Error(`connect.html is missing #${id}`);
  return found as T;
}

export function createUi(doc: Document, lang: Lang, networkPassphrase?: string): Ui {
  const t = STRINGS[lang];
  doc.documentElement.lang = lang;
  doc.title = t.title;

  const root = el(doc, 'uf-root');
  const status = el(doc, 'uf-status');
  const error = el(doc, 'uf-error');
  const action = el<HTMLButtonElement>(doc, 'uf-action');
  const network = el(doc, 'uf-network');
  const steps = Array.from(el(doc, 'uf-steps').querySelectorAll<HTMLLIElement>('li'));

  el(doc, 'uf-title').textContent = t.title;
  el(doc, 'uf-lead').textContent = t.lead;
  el(doc, 'uf-footer').textContent = t.footer;
  steps.forEach((li, i) => {
    li.textContent = t.steps[i] ?? '';
  });
  if (networkPassphrase) {
    network.textContent = `${t.networkLabel}: ${networkName(networkPassphrase, lang)}`;
    network.hidden = false;
  } else {
    network.hidden = true;
  }

  let currentStep = 0;

  function markSteps(current: number, allDone = false) {
    steps.forEach((li, i) => {
      const state = allDone || i < current ? 'done' : i === current ? 'current' : 'todo';
      li.dataset.state = state;
      if (state === 'current') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  function setAction(label: string | undefined, busy = false) {
    if (label === undefined) {
      action.hidden = true;
      return;
    }
    action.hidden = false;
    action.textContent = label;
    // aria-disabled (not disabled) keeps keyboard focus on the button between steps.
    action.setAttribute('aria-disabled', String(busy));
  }

  function setStatus(text: string, busy: boolean, link?: { href: string; label: string }) {
    status.textContent = text;
    if (link) {
      const a = doc.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      status.append(' ', a);
    }
    status.classList.toggle('is-busy', busy);
    root.setAttribute('aria-busy', String(busy));
  }

  function setError(text: string | undefined) {
    error.textContent = text ?? '';
    error.hidden = !text;
  }

  return {
    onAction(handler) {
      action.addEventListener('click', () => {
        if (action.getAttribute('aria-disabled') === 'true') return;
        handler();
      });
    },

    render(view) {
      switch (view.kind) {
        case 'invalid': {
          const fields = view.fields.map((f) => t.paramNames[f]).join(', ');
          steps.forEach((li) => li.removeAttribute('aria-current'));
          setStatus('', false);
          setError(t.invalidParams(fields));
          setAction(undefined);
          return;
        }
        case 'idle':
          currentStep = 0;
          markSteps(0);
          setStatus('', false);
          setError(undefined);
          setAction(t.connect);
          return;
        case 'busy': {
          currentStep = STEP_OF_PHASE[view.phase];
          markSteps(currentStep);
          const text = t.phase[view.phase];
          setStatus(view.info.renewed ? `${t.renewed} ${text}` : text, true);
          setError(undefined);
          setAction(t.working, true);
          return;
        }
        case 'working':
          setStatus(t.working, true);
          setError(undefined);
          setAction(t.working, true);
          return;
        case 'confirm': {
          currentStep = view.step === 'challenge' ? 1 : 2;
          markSteps(currentStep);
          const text = view.step === 'challenge' ? t.confirmChallenge : t.confirmTrustline;
          setStatus(view.info.renewed ? `${t.renewed} ${text}` : text, false);
          setError(undefined);
          setAction(t.signInWallet);
          action.focus();
          return;
        }
        case 'done':
          markSteps(steps.length, true);
          setStatus(
            view.txUrl ? t.done(shortAddress(view.address)) : `${t.done(shortAddress(view.address))} ${t.doneAlready}`,
            false,
            view.txUrl ? { href: view.txUrl, label: t.viewTx } : undefined,
          );
          setError(undefined);
          setAction(undefined);
          return;
        case 'cancelled':
          markSteps(currentStep);
          setStatus(t.cancelled, false);
          setError(undefined);
          setAction(t.retry);
          return;
        case 'error': {
          markSteps(currentStep);
          setStatus('', false);
          const hint = view.networkHint && networkPassphrase ? ` ${t.networkHint(networkName(networkPassphrase, lang))}` : '';
          setError(`${t.errors[view.key](view.detail)}${hint}`);
          setAction(t.retry);
          return;
        }
      }
    },
  };
}
