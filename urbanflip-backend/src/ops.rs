//! On-chain operations: the Rust equivalents of the D1/D2 TS services.
//! Every money-affecting path runs its gate/pre-flight checks BEFORE building.

use crate::domain::money::to_stroops;
use crate::gate::{ComplianceGate, GateDecision, GateRejected, GateStatus};
use crate::stellar::horizon::{HorizonClient, HorizonError, TrustlineState};
use crate::stellar::keys::{decode_public, Keypair};
use crate::stellar::xdr as x;
use crate::wallet::{verify_wallet_signature, SignatureRejected};

pub const DEFAULT_FEE: u32 = 200;
pub const ISSUER_STARTING_BALANCE_STROOPS: i64 = 25_000_000; // 2.5 XLM

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error("gate: {0}")]
    Gate(#[from] GateRejected),
    #[error("gate unavailable (failing closed): {0}")]
    GateUnavailable(String),
    #[error("trustline for {1} is {0:?}; refusing")]
    TrustlineNotReady(TrustlineState, String),
    #[error(transparent)]
    Signature(#[from] SignatureRejected),
    #[error(transparent)]
    Horizon(#[from] HorizonError),
    #[error("{0}")]
    Build(String),
    #[error("{0}")]
    Money(#[from] crate::domain::money::InvalidAmount),
    #[error("wallet refused to sign: {0}")]
    Wallet(String),
    #[error("{0}")]
    NothingToClawBack(String),
}

pub struct Ops {
    pub horizon: HorizonClient,
    pub passphrase: String,
}

impl Ops {
    /// D1: creates `issuer` with auth flags set in the SAME tx as creation, so
    /// flags exist strictly before any trustline can. The caller generates and
    /// stores the issuer key first; a lost response never orphans an issuer.
    pub async fn provision_issuer(
        &self,
        funder: &Keypair,
        issuer: &Keypair,
        home_domain: Option<&str>,
    ) -> Result<String, OpsError> {
        let seq = self.horizon.next_sequence(&funder.public_str()).await?;
        let ops = vec![
            x::op_create_account(&issuer.public_bytes(), ISSUER_STARTING_BALANCE_STROOPS),
            x::op_set_flags(
                x::AUTH_REQUIRED_FLAG | x::AUTH_REVOCABLE_FLAG | x::AUTH_CLAWBACK_ENABLED_FLAG,
                Some(&issuer.public_bytes()),
                home_domain,
            )
            .map_err(OpsError::Build)?,
        ];
        let tx = x::build_tx(&funder.public_bytes(), seq, DEFAULT_FEE, ops);
        let envelope = x::sign_and_encode(&self.passphrase, &tx, &[funder, issuer]);
        Ok(self.horizon.submit(&envelope).await?)
    }

    /// D1: the ONLY grant path; runs the gate first and fails closed.
    /// Returns the gate's decision (None if the gate was unreachable) with the
    /// outcome, so every request's decision can be logged, refusals included.
    pub async fn authorize_trustline(
        &self,
        gate: &ComplianceGate,
        deal_id: &str,
        asset_code: &str,
        issuer: &Keypair,
        investor_id: &str,
        investor_address: &str,
    ) -> (Option<GateDecision>, Result<String, OpsError>) {
        let decision = match gate.evaluate(investor_id, investor_address, deal_id).await {
            Ok(d) => d,
            Err(e) => return (None, Err(OpsError::GateUnavailable(e))),
        };
        if decision.status != GateStatus::Approved {
            let rejected = GateRejected {
                provider: decision.provider.clone(),
                status: decision.status,
                reason: decision.reason.clone(),
            };
            return (Some(decision), Err(OpsError::Gate(rejected)));
        }
        let result = self.grant_trustline(asset_code, issuer, investor_address).await;
        (Some(decision), result)
    }

    async fn grant_trustline(&self, asset_code: &str, issuer: &Keypair, investor_address: &str) -> Result<String, OpsError> {
        let trustor = decode_public(investor_address).map_err(OpsError::Build)?;
        let seq = self.horizon.next_sequence(&issuer.public_str()).await?;
        let op = x::op_set_trustline_flags(&trustor, asset_code, &issuer.public_bytes(), x::TRUSTLINE_AUTHORIZED_FLAG, 0)
            .map_err(OpsError::Build)?;
        let tx = x::build_tx(&issuer.public_bytes(), seq, DEFAULT_FEE, vec![op]);
        let envelope = x::sign_and_encode(&self.passphrase, &tx, &[issuer]);
        Ok(self.horizon.submit(&envelope).await?)
    }

    pub async fn freeze_trustline(
        &self,
        asset_code: &str,
        issuer: &Keypair,
        investor_address: &str,
    ) -> Result<String, OpsError> {
        let trustor = decode_public(investor_address).map_err(OpsError::Build)?;
        let seq = self.horizon.next_sequence(&issuer.public_str()).await?;
        let op = x::op_set_trustline_flags(&trustor, asset_code, &issuer.public_bytes(), 0, x::TRUSTLINE_AUTHORIZED_FLAG)
            .map_err(OpsError::Build)?;
        let tx = x::build_tx(&issuer.public_bytes(), seq, DEFAULT_FEE, vec![op]);
        let envelope = x::sign_and_encode(&self.passphrase, &tx, &[issuer]);
        Ok(self.horizon.submit(&envelope).await?)
    }

    /// Builds and signs (does NOT submit) a clawback of `amount`, or of the
    /// investor's whole balance when None (offboarding). The caller records
    /// the hash before submitting, as for issuance.
    pub async fn prepare_clawback(
        &self,
        asset_code: &str,
        issuer: &Keypair,
        investor_address: &str,
        amount: Option<&str>,
    ) -> Result<PreparedTx, OpsError> {
        let from = decode_public(investor_address).map_err(OpsError::Build)?;
        let stroops = match amount {
            Some(a) => to_stroops(a)?,
            None => {
                let account = self.horizon.account(investor_address).await?;
                let balance = account
                    .balances
                    .iter()
                    .find(|b| b.asset_code.as_deref() == Some(asset_code) && b.asset_issuer.as_deref() == Some(&issuer.public_str()))
                    .map(|b| b.balance.clone())
                    .unwrap_or_else(|| "0".into());
                to_stroops(&balance)?
            }
        };
        if stroops == 0 {
            return Err(OpsError::NothingToClawBack(format!("{investor_address} holds no {asset_code}")));
        }
        let seq = self.horizon.next_sequence(&issuer.public_str()).await?;
        let op = x::op_clawback(&from, asset_code, &issuer.public_bytes(), stroops as i64).map_err(OpsError::Build)?;
        let tx = x::build_tx(&issuer.public_bytes(), seq, DEFAULT_FEE, vec![op]);
        Ok(PreparedTx {
            envelope: x::sign_and_encode(&self.passphrase, &tx, &[issuer]),
            hash: hex::encode(x::tx_hash(&self.passphrase, &tx)),
            max_time: x::max_time(&tx),
            amount: crate::domain::money::from_stroops(stroops),
        })
    }

    /// D1: builds and signs (does NOT submit) the issuance of `principal`
    /// units, after a trustline pre-flight. The caller records the returned
    /// hash before submitting, so an unknown outcome is resolved by hash
    /// instead of minting twice.
    pub async fn prepare_issuance(
        &self,
        asset_code: &str,
        issuer: &Keypair,
        investor_address: &str,
        principal: &str,
    ) -> Result<PreparedTx, OpsError> {
        let state = self
            .horizon
            .trustline_state(investor_address, asset_code, &issuer.public_str())
            .await?;
        if state != TrustlineState::Ready {
            return Err(OpsError::TrustlineNotReady(state, investor_address.to_string()));
        }
        let destination = decode_public(investor_address).map_err(OpsError::Build)?;
        let stroops = to_stroops(principal)?;
        let seq = self.horizon.next_sequence(&issuer.public_str()).await?;
        let op = x::op_payment(&destination, asset_code, &issuer.public_bytes(), stroops as i64).map_err(OpsError::Build)?;
        let tx = x::build_tx(&issuer.public_bytes(), seq, DEFAULT_FEE, vec![op]);
        Ok(PreparedTx {
            envelope: x::sign_and_encode(&self.passphrase, &tx, &[issuer]),
            hash: hex::encode(x::tx_hash(&self.passphrase, &tx)),
            max_time: x::max_time(&tx),
            amount: crate::domain::money::from_stroops(stroops),
        })
    }

    /// D2: sponsored account (0 XLM) and sponsored trustline, the trustline
    /// fee-bumped by the channel. The wallet never hands over a key:
    /// `sign_raw` returns a base64 Ed25519 signature over a tx hash (Privy's
    /// raw-sign contract), verified locally BEFORE anything is submitted.
    /// Steps already on-chain (an investor's second deal, a repeated call
    /// after a timeout) are skipped, so onboarding is safe to retry.
    pub async fn onboard_sponsored<F>(
        &self,
        channel: &Keypair,
        investor_address: &str,
        asset_code: &str,
        asset_issuer: &str,
        sign_raw: F,
    ) -> Result<Onboarded, OpsError>
    where
        F: Fn(&[u8; 32]) -> Result<String, String>,
    {
        let investor_pub = decode_public(investor_address).map_err(OpsError::Build)?;
        let issuer_pub = decode_public(asset_issuer).map_err(OpsError::Build)?;
        let investor_signature = |hash: &[u8; 32]| -> Result<stellar_xdr::DecoratedSignature, OpsError> {
            let signature_b64 = sign_raw(hash).map_err(OpsError::Wallet)?;
            verify_wallet_signature(investor_address, hash, &signature_b64)?;
            Ok(x::decorated(&investor_pub, base64_decode64(&signature_b64)?))
        };
        let state = self.horizon.trustline_state(investor_address, asset_code, asset_issuer).await?;

        let creation_tx_hash = if state == TrustlineState::NoAccount {
            let seq = self.horizon.next_sequence(&channel.public_str()).await?;
            let ops = vec![
                x::op_begin_sponsoring(&investor_pub),
                x::op_create_account(&investor_pub, 0),
                x::op_end_sponsoring(&investor_pub),
            ];
            let tx = x::build_tx(&channel.public_bytes(), seq, DEFAULT_FEE, ops);
            let mut signatures = x::sign_inner(&self.passphrase, &tx, &[channel]);
            signatures.push(investor_signature(&x::tx_hash(&self.passphrase, &tx))?);
            Some(self.horizon.submit(&x::encode_envelope(&tx, signatures)).await?)
        } else {
            None
        };

        let trustline_tx_hash = if matches!(state, TrustlineState::NoAccount | TrustlineState::Missing) {
            let seq = self.horizon.next_sequence(&channel.public_str()).await?;
            let trust_op = x::op_change_trust(asset_code, &issuer_pub, i64::MAX, Some(&investor_pub)).map_err(OpsError::Build)?;
            let ops = vec![x::op_begin_sponsoring(&investor_pub), trust_op, x::op_end_sponsoring(&investor_pub)];
            let tx = x::build_tx(&channel.public_bytes(), seq, DEFAULT_FEE, ops);
            let mut signatures = x::sign_inner(&self.passphrase, &tx, &[channel]);
            signatures.push(investor_signature(&x::tx_hash(&self.passphrase, &tx))?);
            let envelope = x::fee_bump_wrap(&self.passphrase, channel, DEFAULT_FEE, &tx, signatures);
            Some(self.horizon.submit(&envelope).await?)
        } else {
            None
        };

        Ok(Onboarded { address: investor_address.to_string(), creation_tx_hash, trustline_tx_hash })
    }
}

pub struct PreparedTx {
    pub envelope: String,
    pub hash: String,
    pub max_time: u64,
    /// The amount the tx moves, normalized to 7 decimals.
    pub amount: String,
}

#[derive(Debug, serde::Serialize)]
pub struct Onboarded {
    pub address: String,
    /// None when the account already existed.
    pub creation_tx_hash: Option<String>,
    /// None when the trustline already existed.
    pub trustline_tx_hash: Option<String>,
}

fn base64_decode64(b64: &str) -> Result<[u8; 64], OpsError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| OpsError::Build("invalid base64 signature".into()))?
        .try_into()
        .map_err(|_| OpsError::Build("signature must be 64 bytes".into()))
}
