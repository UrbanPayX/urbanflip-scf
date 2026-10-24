import * as SDK from '@stellar/stellar-sdk';
import type { StaticGateEntry } from './gate/static-gate';

export interface AppConfig {
  horizonUrl: string;
  networkPassphrase: string;
  homeDomain: string;
  /** Secret of the operational funder account (testnet demo: generated + friendbot-funded). */
  funderSecret: string;
  gate: UrbanflipGateSettings | StaticGateSettings;
  auditLogPath?: string;
  /**
   * Directory for the issuer, settlement and clawback stores (issuers.json,
   * settlements.json, clawbacks.json), locked by one process at a time (.lock).
   * Without it, state lives in process memory only and is lost on restart.
   */
  stateDir?: string;
  /** 32-byte key as 64 hex chars sealing issuer secrets at rest; required with stateDir. */
  stateKey?: string;
}

export interface UrbanflipGateSettings {
  kind: 'urbanflip';
  baseUrl: string;
  apiToken?: string;
}

export interface StaticGateSettings {
  kind: 'static';
  allow: StaticGateEntry[];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = (env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet' | 'custom';
  const preset =
    network === 'mainnet'
      ? { horizonUrl: 'https://horizon.stellar.org', networkPassphrase: SDK.Networks.PUBLIC }
      : { horizonUrl: 'https://horizon-testnet.stellar.org', networkPassphrase: SDK.Networks.TESTNET };

  if (env['STATE_DIR'] && !env['STATE_KEY']) {
    throw new Error('STATE_DIR requires STATE_KEY (32 bytes as 64 hex chars)');
  }
  const gate = env['GATE_PROVIDER'] ?? 'static';
  if (gate === 'urbanflip') {
    if (!env['URBANFLIP_GATE_BASE_URL']) {
      throw new Error('GATE_PROVIDER=urbanflip requires URBANFLIP_GATE_BASE_URL');
    }
    return {
      horizonUrl: env['HORIZON_URL'] ?? preset.horizonUrl,
      networkPassphrase: env['NETWORK_PASSPHRASE'] ?? preset.networkPassphrase,
      homeDomain: env['HOME_DOMAIN'] ?? 'urbanflip.io',
      funderSecret: requireEnv(env, 'FUNDER_SECRET'),
      gate: {
        kind: 'urbanflip',
        baseUrl: env['URBANFLIP_GATE_BASE_URL'],
        apiToken: env['URBANFLIP_GATE_TOKEN'],
      },
      auditLogPath: env['AUDIT_LOG_PATH'],
      stateDir: env['STATE_DIR'],
      stateKey: env['STATE_KEY'],
    };
  }
  return {
    horizonUrl: env['HORIZON_URL'] ?? preset.horizonUrl,
    networkPassphrase: env['NETWORK_PASSPHRASE'] ?? preset.networkPassphrase,
    homeDomain: env['HOME_DOMAIN'] ?? 'urbanflip.io',
    funderSecret: requireEnv(env, 'FUNDER_SECRET'),
    gate: {
      kind: 'static',
      allow: env['STATIC_GATE_ALLOW']
        ? (JSON.parse(env['STATIC_GATE_ALLOW']) as StaticGateEntry[])
        : [],
    },
    auditLogPath: env['AUDIT_LOG_PATH'],
    stateDir: env['STATE_DIR'],
    stateKey: env['STATE_KEY'],
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing required environment variable ${key}`);
  return value;
}
