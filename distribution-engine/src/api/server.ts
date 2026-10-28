import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { computeDistribution } from '../compute/pro-rata';
import { replayDeal, type HistoricalPayout } from '../compute/replay';
import { computeWaterfall, eurJson, toDistributionSchedule, type WaterfallAdjustment, type WaterfallDeal } from '../compute/waterfall';
import { replayWaterfall, type RecordedSettlement, type UnrecordedPosition } from '../compute/waterfall-replay';
import { emitSdpFiles } from '../emit/sdp-csv';
import { assertStellarAddress, convertOnChain } from '../emit/usdc-conversion';
import { TrustlineChecker } from '../trustline/checker';
import { displayAmount } from '../money/stroops';
import type { DealLedger, DealOutcome, DistributionSchedule } from '../compute/pro-rata';

/**
 * Dependency-free HTTP facade over the engine, implementing api/openapi.yaml.
 * In production this is the API the Urbanflip platform (and later the SDP
 * scheduler) calls; the in-memory stores make the prototype self-contained.
 */
export interface EngineServerOptions {
  horizonUrl?: string;
}

export function createEngineServer(options: EngineServerOptions = {}): Server {
  const ledgers = new Map<string, DealLedger>();
  const schedules = new Map<string, DistributionSchedule>();
  const checker = new TrustlineChecker({ horizonUrl: options.horizonUrl ?? 'https://horizon-testnet.stellar.org' });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean); // v1/deals/{id}/distributions...
      const body = await readBody(req);
      const route = `${req.method} ${url.pathname.replace(/\/[A-Za-z0-9._-]+/g, '/{}')}`;

      if (req.method === 'POST' && parts[1] === 'deals' && parts[3] === 'ledger') {
        const ledger = body as unknown as DealLedger;
        if (!Array.isArray(ledger?.positions)) return json(res, 400, { error: 'positions must be an array' });
        // Wallets land verbatim in SDP files later: refuse a bad one at the door.
        for (const p of ledger.positions) {
          if (p.walletAddress !== undefined) assertStellarAddress(p.walletAddress, p.investorId);
        }
        ledger.dealId = parts[2]!;
        ledgers.set(ledger.dealId, ledger);
        return json(res, 201, { stored: ledger.positions.length, dealId: ledger.dealId });
      }

      if (req.method === 'POST' && parts[1] === 'deals' && parts[3] === 'waterfall' && parts[4] === 'replay') {
        const { deal, recorded, adjustments, unrecorded } = (body ?? {}) as {
          deal: Omit<WaterfallDeal, 'dealId'>;
          recorded: RecordedSettlement[];
          adjustments?: WaterfallAdjustment[];
          unrecorded?: UnrecordedPosition[];
        };
        if (!Array.isArray(recorded)) return json(res, 400, { error: 'recorded must be an array of settlements' });
        const report = replayWaterfall(waterfallDeal(deal, parts[2]!), recorded, { adjustments, unrecorded });
        return json(res, 200, eurJson(report));
      }

      if (req.method === 'POST' && parts[1] === 'deals' && parts[3] === 'waterfall' && parts.length === 4) {
        const { deal, adjustments } = (body ?? {}) as {
          deal: Omit<WaterfallDeal, 'dealId'>;
          adjustments?: WaterfallAdjustment[];
        };
        const result = computeWaterfall(waterfallDeal(deal, parts[2]!), { adjustments });
        // Only an exact (largest-remainder) result can be paid: it becomes the
        // schedule sdp-files converts; a legacy per-row result is returned only.
        const payable = result.rounding === 'largest-remainder';
        if (payable) schedules.set(`${parts[2]}:latest`, toDistributionSchedule(result));
        return json(res, 200, { ...(eurJson(result) as object), payable });
      }

      if (req.method === 'POST' && parts[1] === 'deals' && parts[3] === 'distributions' && parts[4] === 'replay') {
        const { outcome, historicalPayouts } = (body ?? {}) as {
          outcome: DealOutcome;
          historicalPayouts: HistoricalPayout[];
        };
        const report = replayDeal(requireLedger(ledgers, parts[2]!), outcome, historicalPayouts, {
          decimals: 2,
          remainderPolicy: 'largest-remainder',
        });
        return json(res, 200, serialize(report));
      }

      if (req.method === 'POST' && parts[1] === 'deals' && parts[3] === 'distributions') {
        const { outcome } = (body ?? {}) as { outcome: DealOutcome };
        const schedule = computeDistribution(requireLedger(ledgers, parts[2]!), outcome, { decimals: 7 });
        schedules.set(`${parts[2]}:latest`, schedule);
        return json(res, 200, serialize(schedule));
      }

      if (req.method === 'POST' && parts[1] === 'distributions' && parts[3] === 'sdp-files') {
        const schedule = schedules.get(`${parts[2]}:latest`);
        if (!schedule) return json(res, 404, { error: 'no distribution computed for deal' });
        const { usdcFunded, onlyAddresses, onChainCohort } = (body ?? {}) as {
          usdcFunded?: unknown;
          onlyAddresses?: unknown;
          onChainCohort?: unknown;
        };
        // The schedule is EUR: without the USDC actually bought there is nothing to pay on-chain.
        if (typeof usdcFunded !== 'string') {
          return json(res, 400, {
            error: 'usdcFunded is required (USDC bought for this payout, decimal string, <= 2 decimals)',
          });
        }
        for (const [name, value] of [['onlyAddresses', onlyAddresses], ['onChainCohort', onChainCohort]] as const) {
          if (value !== undefined && !Array.isArray(value)) {
            return json(res, 400, { error: `${name} must be an array of Stellar addresses` });
          }
        }
        const conversion = convertOnChain(schedule, usdcFunded, {
          onlyAddresses: onlyAddresses ? new Set(onlyAddresses as string[]) : undefined,
          onChainCohort: onChainCohort ? new Set(onChainCohort as string[]) : undefined,
        });
        const files = emitSdpFiles(conversion);
        return json(res, 200, {
          usdcConversion: conversion,
          files: files.map((f) => ({ name: f.name, rowCount: f.rowCount, content: f.content })),
        });
      }

      if (req.method === 'POST' && url.pathname === '/v1/trustline-check') {
        const { asset, addresses } = (body ?? {}) as {
          asset: { code: string; issuer: string };
          addresses: string[];
        };
        const statuses = await checker.check(asset, addresses);
        return json(res, 200, { statuses });
      }

      return json(res, 404, { error: `no route for ${route}` });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  });

  function waterfallDeal(deal: Omit<WaterfallDeal, 'dealId'> | undefined, dealId: string): WaterfallDeal {
    if (!Array.isArray(deal?.positions)) throw new Error('deal.positions must be an array');
    for (const p of deal.positions) {
      if (p.walletAddress !== undefined) assertStellarAddress(p.walletAddress, p.investorId);
    }
    return { ...deal, dealId };
  }

  function requireLedger(map: Map<string, DealLedger>, dealId: string): DealLedger {
    const ledger = map.get(dealId);
    if (!ledger) throw new Error(`unknown deal '${dealId}'; POST /v1/deals/{dealId}/ledger first`);
    return ledger;
  }

  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    });
    req.on('error', reject);
  });
}

/** BigInt -> string so results serialize as JSON. */
type Serialized<T> = T extends bigint ? string : T;

function serialize<T>(value: T): Serialized<T> | unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => serialize(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'totalStroops' && typeof v === 'bigint' ? displayAmount(v) : serialize(v);
    }
    return out;
  }
  return value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
