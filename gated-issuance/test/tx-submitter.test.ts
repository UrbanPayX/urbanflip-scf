import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as SDK from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
let server: Server;
let submitter: TxSubmitter;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (reply === 'drop') return req.socket.destroy();
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
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
});
