//! Wallet provider (D2 port): where investor key material lives.
//! DevWallet provisions local Ed25519 keypairs (tests/live demo). The Privy
//! adapter in the TS packages covers production; the exchange over this port
//! is identical — raw signature over a tx hash.

use crate::stellar::keys::Keypair;
use std::collections::HashMap;

#[derive(Debug, thiserror::Error)]
#[error("wallet signature failed verification for {0}; nothing was submitted")]
pub struct SignatureRejected(pub String);

#[derive(Default)]
pub struct DevWalletProvider {
    wallets: HashMap<String, Keypair>,
}

impl DevWalletProvider {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_or_create(&mut self, investor_id: &str) -> Keypair {
        self.wallets
            .entry(investor_id.to_string())
            .or_insert_with(Keypair::random)
            .clone()
    }

    /// Raw-signs a payload (a Stellar tx hash); base64 out, like Privy's API.
    pub fn sign_raw(&self, investor_id: &str, payload: &[u8]) -> Result<String, String> {
        let kp = self.wallets.get(investor_id).ok_or_else(|| format!("no wallet for '{investor_id}'"))?;
        Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, kp.sign(payload)))
    }

    /// A raw-signing handle for one wallet, usable without holding the
    /// provider lock across network calls.
    pub fn raw_signer(&self, investor_id: &str) -> Result<impl Fn(&[u8]) -> Result<String, String>, String> {
        let kp = self.wallets.get(investor_id).cloned().ok_or_else(|| format!("no wallet for '{investor_id}'"))?;
        Ok(move |payload: &[u8]| Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, kp.sign(payload))))
    }

    pub fn address_of(&self, investor_id: &str) -> Option<String> {
        self.wallets.get(investor_id).map(|k| k.public_str())
    }

    /// (investor_id, secret) pairs for sealing into the state snapshot.
    pub fn export_secrets(&self) -> Vec<(String, String)> {
        self.wallets.iter().map(|(id, kp)| (id.clone(), kp.secret_str())).collect()
    }

    pub fn import(&mut self, investor_id: &str, secret: &str) -> Result<(), String> {
        self.wallets.insert(investor_id.to_string(), Keypair::from_secret_str(secret)?);
        Ok(())
    }
}

/// Verifies a base64 raw signature against an address — run BEFORE submitting.
pub fn verify_wallet_signature(address: &str, payload: &[u8], signature_b64: &str) -> Result<(), SignatureRejected> {
    use base64::Engine;
    let public = crate::stellar::keys::decode_public(address).map_err(|_| SignatureRejected(address.to_string()))?;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|_| SignatureRejected(address.to_string()))?;
    let sig: [u8; 64] = sig_bytes.try_into().map_err(|_| SignatureRejected(address.to_string()))?;
    if Keypair::verify(&public, payload, &sig) {
        Ok(())
    } else {
        Err(SignatureRejected(address.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_roundtrip_and_rejection() {
        let mut provider = DevWalletProvider::new();
        let kp = provider.get_or_create("inv-1");
        let payload = [7u8; 32];
        let sig = provider.sign_raw("inv-1", &payload).unwrap();
        assert!(verify_wallet_signature(&kp.public_str(), &payload, &sig).is_ok());
        assert!(verify_wallet_signature(&kp.public_str(), &[8u8; 32], &sig).is_err());

        let other = Keypair::random();
        let bad = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, other.sign(&payload));
        assert!(verify_wallet_signature(&kp.public_str(), &payload, &bad).is_err());
    }
}
