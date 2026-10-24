import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as SDK from '@stellar/stellar-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  extractFailure,
  toFailure,
  TransactionOutcomeUnknownError,
  TransactionRejectedError,
  TxSubmitter,
  txHashHex,
} from '../src/stellar/tx-submitter';

/**
 * The real SDK HTTP path against a local stand-in for Horizon, so the
 * classification is checked on the error shapes the SDK actually produces.
 */
type Reply = { status: number; body: unknown } | 'drop';
let reply: Reply = { status: 200, body: {} };
/** Per-request override by method and path; falls back to `reply`. */
let route: ((method: string, path: string) => Reply | undefined) | undefined;
/** Every request received, as "METHOD /path". */
const requests: string[] = [];
let server: Server;
let submitter: TxSubmitter;

beforeEach(() => {
  route = undefined;
  requests.length = 0;
});

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      requests.push(`${req.method} ${path}`);
      const r = route?.(req.method ?? '', path) ?? reply;
      if (r === 'drop') return req.socket.destroy();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  submitter = new TxSubmitter(new SDK.Horizon.Server(`http://127.0.0.1:${port}`, { allowHttp: true }));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function signedTx(): SDK.Transaction {
  const kp = SDK.Keypair.random();
  const tx = new SDK.TransactionBuilder(new SDK.Account(kp.publicKey(), '1'), {
    networkPassphrase: SDK.Networks.TESTNET,
    fee: '100',
  })
    .addOperation(SDK.Operation.manageData({ name: 'probe', value: 'x' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx;
}

describe('TxSubmitter: definitive rejection vs unknown outcome', () => {
  it('Horizon 400 with a transaction result code is a definitive rejection', async () => {
    reply = {
      status: 400,
      body: { title: 'Transaction Failed', extras: { result_codes: { transaction: 'tx_failed', operations: ['op_not_authorized'] } } },
    };
    const err = await submitter.submit(signedTx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionRejectedError);
    expect((err as TransactionRejectedError).failure).toMatchObject({
      txResultCode: 'tx_failed',
      opResultCodes: ['op_not_authorized'],
    });
  });

  it('Horizon 504 (accepted, not seen closing) is an unknown outcome carrying the tx hash', async () => {
    reply = { status: 504, body: { title: 'Timeout', status: 504 } };
    const tx = signedTx();
    const err = await submitter.submit(tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionOutcomeUnknownError);
    expect((err as TransactionOutcomeUnknownError).hash).toBe(txHashHex(tx));
  });

  it('a dropped connection or a 400 without result codes is unknown too', async () => {
    reply = 'drop';
    await expect(submitter.submit(signedTx())).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    reply = { status: 400, body: { title: 'Transaction Malformed', extras: { envelope_xdr: '...' } } };
    await expect(submitter.submit(signedTx())).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
  });

  it('looks a transaction up by hash: success, failure, or not found', async () => {
    reply = { status: 200, body: { hash: 'ab', successful: true } };
    await expect(submitter.transactionOutcome('ab')).resolves.toBe('SUCCESS');
    reply = { status: 200, body: { hash: 'ab', successful: false } };
    await expect(submitter.transactionOutcome('ab')).resolves.toBe('FAILED');
    reply = { status: 404, body: { title: 'Resource Missing', status: 404 } };
    await expect(submitter.transactionOutcome('ab')).resolves.toBe('NOT_FOUND');
    reply = { status: 503, body: { title: 'Service Unavailable', status: 503 } };
    await expect(submitter.transactionOutcome('ab')).rejects.toThrow();
  });

  it('reads account auth flags, undefined for a missing account', async () => {
    const id = SDK.Keypair.random().publicKey();
    reply = {
      status: 200,
      body: {
        id,
        account_id: id,
        sequence: '1',
        balances: [],
        flags: { auth_required: true, auth_revocable: true, auth_immutable: false, auth_clawback_enabled: true },
      },
    };
    await expect(submitter.accountFlags(id)).resolves.toEqual({
      authRequired: true,
      authRevocable: true,
      authClawbackEnabled: true,
    });
    reply = { status: 404, body: { title: 'Resource Missing', status: 404 } };
    await expect(submitter.accountFlags(id)).resolves.toBeUndefined();
  });

  it('reads an asset balance, undefined without the trustline or the account', async () => {
    const id = SDK.Keypair.random().publicKey();
    const issuer = SDK.Keypair.random().publicKey();
    reply = {
      status: 200,
      body: {
        id,
        account_id: id,
        sequence: '1',
        balances: [
          { asset_type: 'native', balance: '9.9999900' },
          { asset_type: 'credit_alphanum12', asset_code: 'UFMADRID1', asset_issuer: issuer, balance: '5.0000000' },
        ],
        flags: {},
      },
    };
    await expect(submitter.assetBalance(id, { code: 'UFMADRID1', issuer })).resolves.toBe('5.0000000');
    await expect(submitter.assetBalance(id, { code: 'UFMADRID1', issuer: id })).resolves.toBeUndefined();
    reply = { status: 404, body: { title: 'Resource Missing', status: 404 } };
    await expect(submitter.assetBalance(id, { code: 'UFMADRID1', issuer })).resolves.toBeUndefined();
  });

  it('a successful submission returns the hash Horizon reports, after one POST', async () => {
    const tx = signedTx();
    reply = { status: 200, body: { hash: txHashHex(tx), successful: true, ledger: 123 } };
    await expect(submitter.submit(tx)).resolves.toEqual({ hash: txHashHex(tx) });
    expect(requests).toEqual(['POST /transactions']);
  });

  it('a 400 with only a transaction code (e.g. tx_bad_seq) is rejected, with no op codes', async () => {
    reply = { status: 400, body: { title: 'Transaction Failed', extras: { result_codes: { transaction: 'tx_bad_seq' } } } };
    const err = (await submitter.submit(signedTx()).catch((e: unknown) => e)) as TransactionRejectedError;
    expect(err).toBeInstanceOf(TransactionRejectedError);
    expect(err.failure.txResultCode).toBe('tx_bad_seq');
    expect(err.failure.opResultCodes).toBeUndefined();
    expect(err.message).toBe('transaction rejected (tx: tx_bad_seq)');
    expect(err.name).toBe('TransactionRejectedError');
  });

  it('a 400 whose transaction code is not a string, or a 5xx carrying codes, is NOT proof of rejection', async () => {
    reply = { status: 400, body: { extras: { result_codes: { transaction: ['tx_failed'] } } } };
    await expect(submitter.submit(signedTx())).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    reply = { status: 500, body: { extras: { result_codes: { transaction: 'tx_failed' } } } };
    await expect(submitter.submit(signedTx())).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    reply = { status: 429, body: { title: 'Rate Limit Exceeded', status: 429 } };
    await expect(submitter.submit(signedTx())).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
  });

  it('the unknown-outcome error tells the caller to resolve by hash and keeps the cause', async () => {
    reply = { status: 504, body: { title: 'Timeout', status: 504 } };
    const tx = signedTx();
    const err = (await submitter.submit(tx).catch((e: unknown) => e)) as TransactionOutcomeUnknownError;
    expect(err.name).toBe('TransactionOutcomeUnknownError');
    expect(err.message).toContain(`transaction ${txHashHex(tx)} outcome unknown`);
    expect(err.message).toMatch(/resolve it by hash before retrying$/);
    expect((err.cause as { response?: { status?: number } }).response?.status).toBe(504);
    // a non-Error cause is still rendered
    expect(new TransactionOutcomeUnknownError('ab', 'socket hang up').message).toBe(
      'transaction ab outcome unknown (socket hang up); resolve it by hash before retrying',
    );
  });

  it("SEP-29: a payment to a memo-required account without a memo is refused before it is sent", async () => {
    const source = SDK.Keypair.random();
    const destination = SDK.Keypair.random().publicKey();
    route = (method, path) =>
      method === 'GET' && path === `/accounts/${destination}`
        ? { status: 200, body: accountBody(destination, { data: { 'config.memo_required': 'MQ==' } }) }
        : { status: 500, body: { title: 'unexpected' } };
    const tx = new SDK.TransactionBuilder(new SDK.Account(source.publicKey(), '1'), {
      networkPassphrase: SDK.Networks.TESTNET,
      fee: '100',
    })
      .addOperation(SDK.Operation.payment({ destination, asset: SDK.Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    tx.sign(source);

    const err = (await submitter.submit(tx).catch((e: unknown) => e)) as TransactionRejectedError;
    expect(err).toBeInstanceOf(TransactionRejectedError);
    expect(err.failure.txResultCode).toBeUndefined();
    expect(err.message).toBe('transaction rejected');
    expect(err.cause).toBeInstanceOf(SDK.AccountRequiresMemoError);
    expect(requests).toEqual([`GET /accounts/${destination}`]); // never POSTed
  });

  it('loads an account with its sequence number for building the next tx', async () => {
    const id = SDK.Keypair.random().publicKey();
    reply = { status: 200, body: accountBody(id, { sequence: '4294967296' }) };
    const account = await submitter.loadAccount(id);
    expect(account.accountId()).toBe(id);
    expect(account.sequenceNumber()).toBe('4294967296');
  });

  it('a Horizon outage is never read as "account missing" or "no trustline"', async () => {
    const id = SDK.Keypair.random().publicKey();
    const issuer = SDK.Keypair.random().publicKey();
    reply = { status: 503, body: { title: 'Service Unavailable', status: 503 } };
    // undefined would make the provisioner resubmit and a full-balance clawback refuse
    await expect(submitter.accountFlags(id)).rejects.toThrow();
    await expect(submitter.assetBalance(id, { code: 'UFMADRID1', issuer })).rejects.toThrow();
    reply = 'drop';
    await expect(submitter.accountFlags(id)).rejects.toThrow();
    await expect(submitter.assetBalance(id, { code: 'UFMADRID1', issuer })).rejects.toThrow();
  });

  it('flags that are absent or not literally true read as unset', async () => {
    const id = SDK.Keypair.random().publicKey();
    reply = { status: 200, body: accountBody(id, { flags: { auth_required: 'true', auth_revocable: 1 } }) };
    await expect(submitter.accountFlags(id)).resolves.toEqual({
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
    });
  });

  it('an account response without balances has no trustline', async () => {
    const id = SDK.Keypair.random().publicKey();
    const body = accountBody(id) as Record<string, unknown>;
    delete body['balances'];
    reply = { status: 200, body };
    await expect(
      submitter.assetBalance(id, { code: 'UFMADRID1', issuer: SDK.Keypair.random().publicKey() }),
    ).resolves.toBeUndefined();
  });
});

describe('toFailure / extractFailure', () => {
  it('unwraps a TransactionRejectedError to the failure it carries', () => {
    const failure = { txResultCode: 'tx_failed', opResultCodes: ['op_underfunded'], cause: new Error('400') };
    expect(toFailure(new TransactionRejectedError(failure))).toBe(failure);
  });

  it("extracts hash and codes from a raw Horizon error, and nothing from anything else", () => {
    const raw = {
      response: {
        status: 400,
        data: { hash: 'ab', extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] } } },
      },
    };
    expect(toFailure(raw)).toEqual({ hash: 'ab', txResultCode: 'tx_failed', opResultCodes: ['op_no_trust'], cause: raw });
    const noOps = { response: { data: { extras: { result_codes: { transaction: 'tx_failed', operations: 'op_x' } } } } };
    expect(extractFailure(noOps).opResultCodes).toBeUndefined();
    for (const other of [new Error('boom'), undefined, null, 'string']) {
      expect(extractFailure(other)).toEqual({
        hash: undefined,
        txResultCode: undefined,
        opResultCodes: undefined,
        cause: other,
      });
    }
  });
});

function accountBody(
  id: string,
  extra: { sequence?: string; data?: Record<string, string>; flags?: Record<string, unknown> } = {},
): unknown {
  return {
    id,
    account_id: id,
    sequence: extra.sequence ?? '1',
    subentry_count: 0,
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: extra.flags ?? {},
    balances: [{ asset_type: 'native', balance: '10.0000000' }],
    signers: [{ key: id, weight: 1, type: 'ed25519_public_key' }],
    data: extra.data ?? {},
    // as Horizon sends it: the SDK moves `data` to `data_attr` because of this link
    _links: { data: { href: `/accounts/${id}/data/{key}`, templated: true } },
  };
}
