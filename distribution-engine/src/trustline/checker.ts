import * as SDK from '@stellar/stellar-sdk';

/**
 * Trustline pre-check for the distribution asset (USDC in production).
 * The D1 authorization service guarantees the trustline exists at onboarding
 * time; this re-verifies it immediately before a batch so a revoked or closed
 * line fails loudly here instead of op_by_op inside a 10,000-payment SDP run.
 */
export type TrustlineState = 'READY' | 'NO_ACCOUNT' | 'TRUSTLINE_MISSING' | 'TRUSTLINE_UNAUTHORIZED';

export interface TrustlineStatus {
  address: string;
  state: TrustlineState;
}

export interface TrustlineCheckerDeps {
  horizonUrl: string;
  concurrency?: number;
}

export class TrustlineChecker {
  constructor(private readonly deps: TrustlineCheckerDeps) {}

  async check(asset: { code: string; issuer: string }, addresses: string[]): Promise<TrustlineStatus[]> {
    const concurrency = this.deps.concurrency ?? 25;
    const out: TrustlineStatus[] = [];
    for (let start = 0; start < addresses.length; start += concurrency) {
      const chunk = addresses.slice(start, start + concurrency);
      const results = await Promise.all(chunk.map((address) => this.checkOne(asset, address)));
      out.push(...results);
    }
    return out;
  }

  private async checkOne(asset: { code: string; issuer: string }, address: string): Promise<TrustlineStatus> {
    const server = new SDK.Horizon.Server(this.deps.horizonUrl);
    let balances: Array<Record<string, unknown>>;
    try {
      const account = (await server.accounts().accountId(address).call()) as unknown as {
        balances: Array<Record<string, unknown>>;
      };
      balances = account.balances;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) return { address, state: 'NO_ACCOUNT' };
      throw err;
    }
    const line = balances.find(
      (b) => b['asset_code'] === asset.code && b['asset_issuer'] === asset.issuer,
    );
    if (!line) return { address, state: 'TRUSTLINE_MISSING' };
    // Horizon exposes is_authorized on credit balance lines.
    if (line['is_authorized'] === false) return { address, state: 'TRUSTLINE_UNAUTHORIZED' };
    return { address, state: 'READY' };
  }
}
