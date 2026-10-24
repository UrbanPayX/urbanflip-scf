//! Stellar transaction construction on raw XDR: builds, signs (network-hash
//! Ed25519), fee-bumps, and encodes envelopes for Horizon submission.
//!
//! Auth flags: REQUIRED=1, REVOCABLE=2, CLAWBACK_ENABLED=8. Trustline flag:
//! AUTHORIZED=1.

use sha2::{Digest, Sha256};
use stellar_xdr::{
    AccountId, AlphaNum12, AlphaNum4, Asset, AssetCode12, AssetCode4,
    BeginSponsoringFutureReservesOp, ChangeTrustAsset, ChangeTrustOp, ClawbackOp,
    CreateAccountOp, DecoratedSignature, EnvelopeType, FeeBumpTransaction,
    FeeBumpTransactionEnvelope, FeeBumpTransactionExt, FeeBumpTransactionInnerTx, Limits, Memo,
    MuxedAccount, Operation, OperationBody, Preconditions, PublicKey, SequenceNumber,
    SetOptionsOp, SetTrustLineFlagsOp, Signature, SignatureHint, String32, TimeBounds, TimePoint,
    Transaction, TransactionExt, TransactionV1Envelope, TransactionEnvelope, Uint256, WriteXdr,
    PaymentOp,
};

pub const AUTH_REQUIRED_FLAG: u32 = 0x1;
pub const AUTH_REVOCABLE_FLAG: u32 = 0x2;
pub const AUTH_CLAWBACK_ENABLED_FLAG: u32 = 0x8;
pub const TRUSTLINE_AUTHORIZED_FLAG: u32 = 0x1;

pub fn muxed(public: &[u8; 32]) -> MuxedAccount {
    MuxedAccount::Ed25519(Uint256(*public))
}

pub fn account_id(public: &[u8; 32]) -> AccountId {
    AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(*public)))
}

/// Asset codes are 1-12 ASCII alphanumerics: 1-4 encode as alphanum4,
/// 5-12 as alphanum12, NUL-padded on the right.
pub fn validate_asset_code(code: &str) -> Result<(), String> {
    if code.is_empty() || code.len() > 12 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!("asset code '{code}' must be 1-12 ASCII alphanumerics"));
    }
    Ok(())
}

pub fn asset(code: &str, issuer: &[u8; 32]) -> Result<Asset, String> {
    validate_asset_code(code)?;
    let bytes = code.as_bytes();
    if bytes.len() <= 4 {
        let mut buf = [0u8; 4];
        buf[..bytes.len()].copy_from_slice(bytes);
        Ok(Asset::CreditAlphanum4(AlphaNum4 {
            asset_code: AssetCode4(buf),
            issuer: account_id(issuer),
        }))
    } else {
        let mut buf = [0u8; 12];
        buf[..bytes.len()].copy_from_slice(bytes);
        Ok(Asset::CreditAlphanum12(AlphaNum12 {
            asset_code: AssetCode12(buf),
            issuer: account_id(issuer),
        }))
    }
}

fn change_trust_asset(code: &str, issuer: &[u8; 32]) -> Result<ChangeTrustAsset, String> {
    match asset(code, issuer)? {
        Asset::Native => Err("native asset not supported here".into()),
        Asset::CreditAlphanum4(a4) => Ok(ChangeTrustAsset::CreditAlphanum4(a4)),
        Asset::CreditAlphanum12(a12) => Ok(ChangeTrustAsset::CreditAlphanum12(a12)),
    }
}

fn op(source: Option<&[u8; 32]>, body: OperationBody) -> Operation {
    Operation { source_account: source.map(|s| muxed(s)), body }
}

pub fn op_begin_sponsoring(sponsored: &[u8; 32]) -> Operation {
    op(
        None,
        OperationBody::BeginSponsoringFutureReserves(BeginSponsoringFutureReservesOp {
            sponsored_id: account_id(sponsored),
        }),
    )
}

pub fn op_end_sponsoring(source_investor: &[u8; 32]) -> Operation {
    op(Some(source_investor), OperationBody::EndSponsoringFutureReserves)
}

pub fn op_create_account(destination: &[u8; 32], starting_balance_stroops: i64) -> Operation {
    op(
        None,
        OperationBody::CreateAccount(CreateAccountOp {
            destination: account_id(destination),
            starting_balance: starting_balance_stroops,
        }),
    )
}

pub fn op_set_flags(flags: u32, source: Option<&[u8; 32]>, home_domain: Option<&str>) -> Result<Operation, String> {
    let home_domain = match home_domain {
        Some(d) => {
            let inner: stellar_xdr::StringM<32> = d.as_bytes().to_vec().try_into().map_err(|_| "home domain <= 32 bytes")?;
            Some(String32(inner))
        }
        None => None,
    };
    Ok(op(
        source,
        OperationBody::SetOptions(SetOptionsOp {
            inflation_dest: None,
            clear_flags: None,
            set_flags: Some(flags),
            master_weight: None,
            low_threshold: None,
            med_threshold: None,
            high_threshold: None,
            home_domain,
            signer: None,
        }),
    ))
}

pub fn op_change_trust(code: &str, issuer: &[u8; 32], limit_stroops: i64, source: Option<&[u8; 32]>) -> Result<Operation, String> {
    Ok(op(
        source,
        OperationBody::ChangeTrust(ChangeTrustOp {
            line: change_trust_asset(code, issuer)?,
            limit: limit_stroops,
        }),
    ))
}

pub fn op_set_trustline_flags(trustor: &[u8; 32], code: &str, issuer: &[u8; 32], set: u32, clear: u32) -> Result<Operation, String> {
    Ok(op(
        None,
        OperationBody::SetTrustLineFlags(SetTrustLineFlagsOp {
            trustor: account_id(trustor),
            asset: asset(code, issuer)?,
            clear_flags: clear,
            set_flags: set,
        }),
    ))
}

pub fn op_payment(destination: &[u8; 32], code: &str, issuer: &[u8; 32], amount_stroops: i64) -> Result<Operation, String> {
    Ok(op(
        None,
        OperationBody::Payment(PaymentOp {
            destination: muxed(destination),
            asset: asset(code, issuer)?,
            amount: amount_stroops,
        }),
    ))
}

pub fn op_clawback(from: &[u8; 32], code: &str, issuer: &[u8; 32], amount_stroops: i64) -> Result<Operation, String> {
    Ok(op(
        None,
        OperationBody::Clawback(ClawbackOp {
            from: muxed(from),
            asset: asset(code, issuer)?,
            amount: amount_stroops,
        }),
    ))
}

/// Builds a v1 transaction with a 5-minute time bound.
pub fn build_tx(source: &[u8; 32], seq: u64, fee_per_op: u32, ops: Vec<Operation>) -> Transaction {
    let max_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 300;
    Transaction {
        source_account: muxed(source),
        fee: fee_per_op * ops.len().max(1) as u32,
        seq_num: SequenceNumber(seq as i64),
        cond: Preconditions::Time(TimeBounds { min_time: TimePoint(0), max_time: TimePoint(max_time) }),
        memo: Memo::None,
        operations: ops.try_into().expect("ops fit"),
        ext: TransactionExt::V0,
    }
}

/// sha256(network_id || envelope_type || payload), where network_id is
/// sha256(passphrase), as stellar-core computes the signature payload.
fn network_hash(envelope_type: EnvelopeType, passphrase: &str, payload: &[u8]) -> [u8; 32] {
    let network_id: [u8; 32] = Sha256::digest(passphrase.as_bytes()).into();
    let mut hasher = Sha256::new();
    hasher.update(network_id);
    hasher.update((envelope_type as i32).to_be_bytes());
    hasher.update(payload);
    hasher.finalize().into()
}

fn xdr_bytes<T: WriteXdr>(value: &T) -> Vec<u8> {
    value.to_xdr(Limits::none()).expect("xdr encode")
}

/// Hash a v1 transaction signs over (ENVELOPE_TYPE_TX = 2).
pub fn tx_hash(passphrase: &str, tx: &Transaction) -> [u8; 32] {
    network_hash(EnvelopeType::Tx, passphrase, &xdr_bytes(tx))
}

/// Hash a fee-bump transaction signs over (ENVELOPE_TYPE_TX_FEE_BUMP = 5).
pub fn fee_bump_hash(passphrase: &str, fb: &FeeBumpTransaction) -> [u8; 32] {
    network_hash(EnvelopeType::TxFeeBump, passphrase, &xdr_bytes(fb))
}

use super::keys::Keypair;

pub fn decorated(public: &[u8; 32], signature: [u8; 64]) -> DecoratedSignature {
    let mut hint = [0u8; 4];
    hint.copy_from_slice(&public[28..32]);
    DecoratedSignature { hint: SignatureHint(hint), signature: Signature(signature.to_vec().try_into().expect("64-byte signature")) }
}

pub fn sign_inner(passphrase: &str, tx: &Transaction, signers: &[&Keypair]) -> Vec<DecoratedSignature> {
    let hash = tx_hash(passphrase, tx);
    signers
        .iter()
        .map(|kp| decorated(&kp.public_bytes(), kp.sign(&hash)))
        .collect()
}

/// Signs the inner transaction with every signer; returns the base64 envelope.
pub fn sign_and_encode(passphrase: &str, tx: &Transaction, signers: &[&Keypair]) -> String {
    encode_envelope(tx, sign_inner(passphrase, tx, signers))
}

/// Base64 v1 envelope from a tx and signatures gathered elsewhere (e.g. a
/// wallet's raw signature).
pub fn encode_envelope(tx: &Transaction, signatures: Vec<DecoratedSignature>) -> String {
    TransactionEnvelope::Tx(TransactionV1Envelope { tx: tx.clone(), signatures: signatures.try_into().expect("signatures fit") })
        .to_xdr_base64(Limits::none())
        .expect("envelope encode")
}

/// The unix time after which the tx can no longer be included in a ledger.
pub fn max_time(tx: &Transaction) -> u64 {
    match &tx.cond {
        Preconditions::Time(tb) => tb.max_time.0,
        Preconditions::V2(v2) => v2.time_bounds.as_ref().map(|tb| tb.max_time.0).unwrap_or(u64::MAX),
        Preconditions::None => u64::MAX,
    }
}

/// Wraps a signed inner tx in a fee-bump whose fee source is the channel.
pub fn fee_bump_wrap(
    passphrase: &str,
    channel: &Keypair,
    base_fee_per_op: u32,
    inner: &Transaction,
    inner_signatures: Vec<DecoratedSignature>,
) -> String {
    let inner_ops = inner.operations.len().max(1) as i64;
    let fee_bump = FeeBumpTransaction {
        fee_source: muxed(&channel.public_bytes()),
        fee: base_fee_per_op as i64 * (inner_ops + 1),
        inner_tx: FeeBumpTransactionInnerTx::Tx(TransactionV1Envelope {
            tx: inner.clone(),
            signatures: inner_signatures.try_into().expect("signatures fit"),
        }),
        ext: FeeBumpTransactionExt::V0,
    };
    let hash = fee_bump_hash(passphrase, &fee_bump);
    let signatures: Vec<DecoratedSignature> = vec![decorated(&channel.public_bytes(), channel.sign(&hash))];
    TransactionEnvelope::TxFeeBump(FeeBumpTransactionEnvelope { tx: fee_bump, signatures: signatures.try_into().expect("sigs fit") })
        .to_xdr_base64(Limits::none())
        .expect("fee-bump encode")
}


#[cfg(test)]
mod tests {
    use super::*;
    use stellar_xdr::ReadXdr;

    const TESTNET: &str = "Test SDF Network ; September 2015";
    // Vectors from @stellar/stellar-sdk 17: setOptions(setFlags=11,
    // homeDomain=urbanflip.io), source seed [7; 32], seq 124, maxTime
    // 1800000000, fee-bumped by seed [9; 32] at base fee 100.
    const TX_XDR: &str = "AAAAAOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIsAAAAZAAAAAAAAAB8AAAAAQAAAAAAAAAAAAAAAGtJ0gAAAAAAAAAAAQAAAAAAAAAFAAAAAAAAAAAAAAABAAAACwAAAAAAAAAAAAAAAAAAAAAAAAABAAAADHVyYmFuZmxpcC5pbwAAAAAAAAAA";
    const TX_HASH: &str = "c75405c7f5f68813081ecc280a38204560da1c3b7b4d773f702946baa23088d8";
    const FB_XDR: &str = "AAAAAP0XJDhaoMdbZPt4zWAvodmR/ev3axPFjtcC6sg16fYYAAAAAAAAAMgAAAACAAAAAOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIsAAAAZAAAAAAAAAB8AAAAAQAAAAAAAAAAAAAAAGtJ0gAAAAAAAAAAAQAAAAAAAAAFAAAAAAAAAAAAAAABAAAACwAAAAAAAAAAAAAAAAAAAAAAAAABAAAADHVyYmFuZmxpcC5pbwAAAAAAAAAAAAAAARRG0iwAAABAyKB4rrpc31bQiMbDHxeTDsEnjKDA/J0vq/85oRI6Eo1smqbnVh/Rc9AlCuXp51B5t5YbejCVASuylv11SIfGCgAAAAA=";
    const FB_HASH: &str = "458ce2a8d0071b9e4ff45571774747135fb6ee88bf52b830b5f56eaef3570e82";

    fn seeded(byte: u8) -> Keypair {
        Keypair::from_secret_str(&stellar_strkey::ed25519::PrivateKey([byte; 32]).to_string()).unwrap()
    }

    #[test]
    fn asset_codes_pad_like_sdk() {
        let issuer = seeded(7).public_bytes();
        for (code, expected) in [
            ("UFX", "AAAAAVVGWAAAAAAA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw="),
            ("UF42", "AAAAAVVGNDIAAAAA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw="),
            ("UFMADRID1", "AAAAAlVGTUFEUklEMQAAAAAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLA=="),
        ] {
            assert_eq!(asset(code, &issuer).unwrap().to_xdr_base64(Limits::none()).unwrap(), expected, "{code}");
        }
        for bad in ["", "UFMADRID00042", "UF-42"] {
            assert!(asset(bad, &issuer).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn tx_hash_matches_sdk() {
        let tx = Transaction::from_xdr_base64(TX_XDR, Limits::none()).unwrap();
        assert_eq!(hex::encode(tx_hash(TESTNET, &tx)), TX_HASH);
    }

    #[test]
    fn fee_bump_hash_matches_sdk() {
        let fb = FeeBumpTransaction::from_xdr_base64(FB_XDR, Limits::none()).unwrap();
        assert_eq!(hex::encode(fee_bump_hash(TESTNET, &fb)), FB_HASH);
    }

    #[test]
    fn signed_fee_bump_envelope_matches_sdk() {
        let tx = Transaction::from_xdr_base64(TX_XDR, Limits::none()).unwrap();
        let source = seeded(7);
        let channel = seeded(9);
        let signatures = sign_inner(TESTNET, &tx, &[&source]);
        let envelope = fee_bump_wrap(TESTNET, &channel, 100, &tx, signatures);
        let TransactionEnvelope::TxFeeBump(fb) = TransactionEnvelope::from_xdr_base64(&envelope, Limits::none()).unwrap() else {
            panic!("expected a fee-bump envelope");
        };
        assert_eq!(fb.tx.to_xdr_base64(Limits::none()).unwrap(), FB_XDR);
        let outer = &fb.signatures[0];
        assert!(Keypair::verify(&channel.public_bytes(), &fee_bump_hash(TESTNET, &fb.tx), &outer.signature.0.to_vec().try_into().unwrap()));
    }
}
