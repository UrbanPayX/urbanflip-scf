import type { Lang, ParamName } from './params';
import type { Phase } from './flow';

export type ErrorKey =
  | 'wrong_network'
  | 'network_mismatch'
  | 'wrong_account'
  | 'expired'
  | 'unauthorized'
  | 'backend_error'
  | 'wallet_error'
  | 'internal_error';

export interface Strings {
  title: string;
  lead: string;
  networkLabel: string;
  steps: [string, string, string];
  connect: string;
  retry: string;
  signInWallet: string;
  working: string;
  phase: Record<Phase, string>;
  renewed: string;
  confirmChallenge: string;
  confirmTrustline: string;
  done: (address: string) => string;
  doneAlready: string;
  viewTx: string;
  cancelled: string;
  invalidParams: (fields: string) => string;
  paramNames: Record<ParamName, string>;
  errors: Record<ErrorKey, (detail: string) => string>;
  networkHint: (network: string) => string;
  footer: string;
}

const es: Strings = {
  title: 'Conecta tu wallet de Stellar',
  lead: 'Vincula tu wallet a tu cuenta de Urbanflip y abre la línea de confianza del activo de esta inversión. No necesitas XLM: Urbanflip cubre la reserva y las comisiones.',
  networkLabel: 'Red',
  steps: ['Elige tu wallet', 'Demuestra que es tuya', 'Abre la línea de confianza'],
  connect: 'Conectar wallet',
  retry: 'Reintentar',
  signInWallet: 'Firmar en mi wallet',
  working: 'Un momento…',
  phase: {
    connecting: 'Elige tu wallet en la ventana que se ha abierto.',
    requesting_challenge: 'Preparando la verificación…',
    confirm_challenge: '',
    signing_challenge: 'Confirma la firma en tu wallet. Esta firma solo demuestra que la wallet es tuya: no se envía a la red ni mueve fondos.',
    verifying: 'Verificando la firma…',
    preparing_trustline: 'Preparando la línea de confianza…',
    confirm_trustline: '',
    signing_trustline: 'Confirma la transacción en tu wallet. Urbanflip paga la reserva y la comisión.',
    submitting: 'Enviando a la red Stellar…',
  },
  renewed: 'La solicitud anterior caducó y hemos generado una nueva.',
  confirmChallenge: 'Paso 2: firma un mensaje de verificación en tu wallet. No se envía a la red ni mueve fondos.',
  confirmTrustline: 'Paso 3: firma la transacción que abre la línea de confianza. Urbanflip paga la reserva y la comisión.',
  done: (address) => `Listo. Tu wallet ${address} está vinculada y la línea de confianza está abierta.`,
  doneAlready: 'La línea de confianza ya estaba abierta.',
  viewTx: 'Ver la transacción',
  cancelled: 'Has cancelado la operación. Puedes reintentarlo cuando quieras.',
  invalidParams: (fields) => `No se puede iniciar la conexión: faltan datos o no son válidos (${fields}). Vuelve a cargar la página de Urbanflip.`,
  paramNames: { investor: 'inversor', deal: 'inversión', session: 'sesión', network: 'red', parent: 'origen' },
  errors: {
    wrong_network: (d) => `Tu wallet está en la red ${d}. Cámbiala a la red indicada arriba y reinténtalo.`,
    network_mismatch: () => 'El servidor trabaja en otra red distinta a la de esta página. Contacta con soporte.',
    wrong_account: (d) => `La wallet ha usado otra cuenta (${d}). Selecciona la cuenta conectada en tu wallet y reinténtalo.`,
    expired: () => 'La solicitud ha caducado de nuevo. Reinténtalo.',
    unauthorized: () => 'Tu sesión ha caducado. Vuelve a cargar la página de Urbanflip.',
    backend_error: (d) => `No hemos podido completar este paso: ${d}`,
    wallet_error: (d) => `Tu wallet ha devuelto un error: ${d}`,
    internal_error: (d) => `Error inesperado: ${d}`,
  },
  networkHint: (network) => `Si tu wallet no permite elegir la red, comprueba que está en ${network}.`,
  footer: 'Wallets compatibles: Freighter, xBull, Albedo, LOBSTR, Rabet, Hana y otras.',
};

const en: Strings = {
  title: 'Connect your Stellar wallet',
  lead: "Link your wallet to your Urbanflip account and open the trustline for this deal's asset. You don't need XLM: Urbanflip covers the reserve and the fees.",
  networkLabel: 'Network',
  steps: ['Choose your wallet', "Prove it's yours", 'Open the trustline'],
  connect: 'Connect wallet',
  retry: 'Try again',
  signInWallet: 'Sign in my wallet',
  working: 'One moment…',
  phase: {
    connecting: 'Choose your wallet in the window that opened.',
    requesting_challenge: 'Preparing verification…',
    confirm_challenge: '',
    signing_challenge: "Confirm the signature in your wallet. It only proves the wallet is yours: it is never submitted and moves no funds.",
    verifying: 'Verifying your signature…',
    preparing_trustline: 'Preparing the trustline…',
    confirm_trustline: '',
    signing_trustline: 'Confirm the transaction in your wallet. Urbanflip pays the reserve and the fee.',
    submitting: 'Submitting to the Stellar network…',
  },
  renewed: 'The previous request expired, so we created a new one.',
  confirmChallenge: 'Step 2: sign a verification message in your wallet. It is never submitted and moves no funds.',
  confirmTrustline: 'Step 3: sign the transaction that opens the trustline. Urbanflip pays the reserve and the fee.',
  done: (address) => `Done. Your wallet ${address} is linked and the trustline is open.`,
  doneAlready: 'The trustline was already open.',
  viewTx: 'View the transaction',
  cancelled: 'You cancelled. You can try again whenever you are ready.',
  invalidParams: (fields) => `This page can't start: missing or invalid parameters (${fields}). Reload the Urbanflip page.`,
  paramNames: { investor: 'investor', deal: 'deal', session: 'session', network: 'network', parent: 'parent' },
  errors: {
    wrong_network: (d) => `Your wallet is on ${d}. Switch it to the network shown above and try again.`,
    network_mismatch: () => 'The server runs on a different network than this page. Please contact support.',
    wrong_account: (d) => `The wallet used a different account (${d}). Select the connected account in your wallet and try again.`,
    expired: () => 'The request expired again. Please try again.',
    unauthorized: () => 'Your session has expired. Reload the Urbanflip page.',
    backend_error: (d) => `We could not complete this step: ${d}`,
    wallet_error: (d) => `Your wallet returned an error: ${d}`,
    internal_error: (d) => `Unexpected error: ${d}`,
  },
  networkHint: (network) => `If your wallet doesn't let you pick the network, make sure it is on ${network}.`,
  footer: 'Supported wallets: Freighter, xBull, Albedo, LOBSTR, Rabet, Hana and more.',
};

export const STRINGS: Record<Lang, Strings> = { es, en };

/** Human name for a network passphrase. */
export function networkName(passphrase: string, lang: Lang): string {
  switch (passphrase) {
    case 'Test SDF Network ; September 2015':
      return 'Testnet';
    case 'Public Global Stellar Network ; September 2015':
      return lang === 'es' ? 'Mainnet (pública)' : 'Mainnet (public)';
    case 'Test SDF Future Network ; October 2022':
      return 'Futurenet';
    default:
      return passphrase;
  }
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
