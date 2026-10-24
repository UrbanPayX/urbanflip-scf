import * as SDK from '@stellar/stellar-sdk';
import type { AuditLog } from '../audit/audit-log';
import { ts } from '../audit/audit-log';
import type { DealInfo, ProvisionedIssuer } from '../types';
import { TransactionRejectedError, txHashHex } from '../stellar/tx-submitter';
import type { LedgerLookup, TransactionSubmitter } from '../stellar/tx-submitter';
import { MemoryIssuerStore, type IssuerRecord, type IssuerStore } from '../store/issuer-store';
import { assertValidAssetCode, deriveAssetCode } from './asset-code';
import { inFlightGuardFor } from './in-flight';

export interface IssuerProvisionerDeps {
  /** Also looks issuers up on-chain, so a lost response is adopted instead of re-provisioned. */
  submitter: TransactionSubmitter & LedgerLookup;
  networkPassphrase: string;
  /** Operational/funder account that pays for issuer creation. */
  funderKeypair: SDK.Keypair;
  /** Domain serving SEP-1 stellar.toml (e.g. "urbanflip.io"). */
  homeDomain?: string;
  startingBalance?: string;
  fee?: string;
  audit?: AuditLog;
  /** Issuer records by dealId; in-memory by default. JsonFileIssuerStore keeps keys across restarts. */
  store?: IssuerStore;
}

/**
 * Provisions a dedicated issuer account per deal.
 *
 * Invariant (SCF D1 acceptance criterion): AUTH_REQUIRED, AUTH_REVOCABLE and
 * AUTH_CLAWBACK_ENABLED are set in the SAME transaction that creates the issuer
 * account — so the flags are in place strictly before any trustline can exist.
 * This matters because clawback cannot be enabled retroactively once balances
 * are outstanding (CAP-35), and revocation/freeze semantics depend on
 * AUTH_REVOCABLE being set at issuance time.
 *
 * Idempotent per dealId, and the issuer key is never lost:
 *   ACTIVE record  -> returned as recorded, nothing submitted;
 *   PENDING record -> an earlier attempt's outcome is unknown, so the issuer is
 *                     looked up on-chain: present with all three flags ->
 *                     adopted; absent -> resubmitted with the SAME keypair
 *                     (createAccount to one address can only succeed once);
 *   no record      -> a keypair is generated and recorded PENDING BEFORE the
 *                     creation tx is submitted.
 * Concurrent calls for the same deal are refused while one is in flight.
 */
export class IssuerProvisioner {
  private readonly store: IssuerStore;

  constructor(private readonly deps: IssuerProvisionerDeps) {
    this.store = deps.store ?? new MemoryIssuerStore();
  }

  async provision(deal: DealInfo): Promise<ProvisionedIssuer> {
    return inFlightGuardFor(this.store).run(`provisioning deal '${deal.dealId}'`, () => this.provisionOnce(deal));
  }

  private async provisionOnce(deal: DealInfo): Promise<ProvisionedIssuer> {
    const existing = await this.store.get(deal.dealId);
    if (existing && deal.assetCode !== undefined && deal.assetCode !== existing.assetCode) {
      throw new Error(
        `deal '${deal.dealId}' already has an issuer for asset code '${existing.assetCode}', not '${deal.assetCode}'`,
      );
    }
    if (existing?.status === 'ACTIVE') return toProvisioned(deal, existing);

    if (existing) {
      // The earlier attempt may have landed (lost response, crash): adopt it.
      const flags = await this.deps.submitter.accountFlags(existing.issuerPublicKey);
      if (flags) {
        if (!flags.authRequired || !flags.authRevocable || !flags.authClawbackEnabled) {
          throw new Error(
            `issuer ${existing.issuerPublicKey} for deal '${deal.dealId}' exists without all auth flags; manual review required`,
          );
        }
        return this.activate(deal, existing, true);
      }
    }

    const assetCode = existing?.assetCode ?? deal.assetCode ?? deriveAssetCode(deal.dealId);
    assertValidAssetCode(assetCode);

    const issuerKeypair = existing ? SDK.Keypair.fromSecret(existing.issuerSecret) : SDK.Keypair.random();
    const tx = await this.buildProvisioningTx(issuerKeypair);
    const pending: IssuerRecord = {
      dealId: deal.dealId,
      status: 'PENDING',
      assetCode,
      issuerPublicKey: issuerKeypair.publicKey(),
      issuerSecret: issuerKeypair.secret(),
      provisioningTxHash: txHashHex(tx),
    };
    // The key is durable BEFORE the account can exist on-chain.
    await this.store.put(pending);
    try {
      await this.deps.submitter.submit(tx);
    } catch (err) {
      // This attempt never applied; if the earlier one is what lands, its hash stays on record.
      if (err instanceof TransactionRejectedError && existing) await this.store.put(existing);
      throw err;
    }
    return this.activate(deal, pending, false);
  }

  private async activate(deal: DealInfo, record: IssuerRecord, adoptedExisting: boolean): Promise<ProvisionedIssuer> {
    const active: IssuerRecord = { ...record, status: 'ACTIVE' };
    await this.store.put(active);
    await this.deps.audit?.append({
      kind: 'ISSUER_PROVISIONED',
      ts: ts(),
      dealId: deal.dealId,
      assetCode: active.assetCode,
      issuer: active.issuerPublicKey,
      txHash: active.provisioningTxHash,
      adoptedExisting: adoptedExisting || undefined,
    });
    return toProvisioned(deal, active);
  }

  private async buildProvisioningTx(issuerKeypair: SDK.Keypair): Promise<SDK.Transaction> {
    const flags =
      SDK.AuthRequiredFlag | SDK.AuthRevocableFlag | SDK.AuthClawbackEnabledFlag;

    const funderAccount = await this.deps.submitter.loadAccount(this.deps.funderKeypair.publicKey());
    const tx = new SDK.TransactionBuilder(funderAccount, {
      networkPassphrase: this.deps.networkPassphrase,
      fee: this.deps.fee ?? '100',
    })
      .addOperation(
        SDK.Operation.createAccount({
          destination: issuerKeypair.publicKey(),
          startingBalance: this.deps.startingBalance ?? '2.5',
        }),
      )
      .addOperation(
        SDK.Operation.setOptions({
          // setOptions targets its source account; source it from the new issuer
          // so the flags land on the issuer, not on the funder.
          source: issuerKeypair.publicKey(),
          setFlags: flags,
          homeDomain: this.deps.homeDomain,
        }),
      )
      .setTimeout(30)
      .build();
    tx.sign(this.deps.funderKeypair, issuerKeypair);

    assertProvisioningInvariant(tx);
    return tx;
  }
}

function toProvisioned(deal: DealInfo, record: IssuerRecord): ProvisionedIssuer {
  return {
    // Pin the recorded code, so authorize/settle address exactly this asset.
    deal: { ...deal, assetCode: record.assetCode },
    asset: { code: record.assetCode, issuer: record.issuerPublicKey },
    issuerPublicKey: record.issuerPublicKey,
    issuerSecret: record.issuerSecret,
    provisioningTxHash: record.provisioningTxHash,
    flags: { authRequired: true, authRevocable: true, authClawbackEnabled: true },
  };
}

/**
 * Defensive self-check on the built envelope: it must configure flags and must
 * NOT contain any trustline or payment operation. Exported so tests assert the
 * same invariant the service enforces on itself.
 */
export function assertProvisioningInvariant(tx: SDK.Transaction): void {
  const forbidden = new Set([
    'changeTrust',
    'allowTrust',
    'setTrustLineFlags',
    'payment',
    'pathPaymentStrictReceive',
    'pathPaymentStrictSend',
    'manageOffer',
    'manageBuyOffer',
    'createPassiveOffer',
    'clawback',
  ]);
  for (const op of tx.operations) {
    if (forbidden.has(op.type)) {
      throw new Error(`provisioning envelope must not contain a '${op.type}' operation`);
    }
  }
  const flagOps = tx.operations.filter(
    (op): op is SDK.Operation.SetOptions =>
      op.type === 'setOptions' &&
      ((op.setFlags ?? 0) & (SDK.AuthRequiredFlag | SDK.AuthRevocableFlag | SDK.AuthClawbackEnabledFlag)) ===
        (SDK.AuthRequiredFlag | SDK.AuthRevocableFlag | SDK.AuthClawbackEnabledFlag),
  );
  if (flagOps.length === 0) {
    throw new Error('provisioning envelope must set AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED');
  }
  const createdBeforeFlags = tx.operations.findIndex((op) => op.type === 'createAccount');
  if (createdBeforeFlags !== -1 && createdBeforeFlags > tx.operations.indexOf(flagOps[0]!)) {
    throw new Error('issuer account creation must precede flag configuration');
  }
}
