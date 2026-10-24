//! Keypairs: Ed25519 keys with Stellar StrKey encoding (S.../G...).

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::RngCore;

#[derive(Clone)]
pub struct Keypair {
    signing: SigningKey,
}

impl Keypair {
    pub fn random() -> Self {
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        Self { signing: SigningKey::from_bytes(&seed) }
    }

    pub fn from_secret_str(secret: &str) -> Result<Self, String> {
        let pk = stellar_strkey::ed25519::PrivateKey::from_string(secret).map_err(|e| e.to_string())?;
        Ok(Self { signing: SigningKey::from_bytes(&pk.0) })
    }

    pub fn public_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn public_str(&self) -> String {
        stellar_strkey::ed25519::PublicKey(self.public_bytes()).to_string()
    }

    pub fn secret_str(&self) -> String {
        stellar_strkey::ed25519::PrivateKey(self.signing.to_bytes()).to_string()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }

    pub fn verify(public: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
        VerifyingKey::from_bytes(public)
            .map(|vk| vk.verify_strict(message, &ed25519_dalek::Signature::from_bytes(signature)).is_ok())
            .unwrap_or(false)
    }
}

/// Decodes a G... address to its 32 raw bytes.
pub fn decode_public(address: &str) -> Result<[u8; 32], String> {
    stellar_strkey::ed25519::PublicKey::from_string(address)
        .map(|p| p.0)
        .map_err(|e| format!("invalid address '{address}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_strkeys() {
        let kp = Keypair::random();
        let secret = kp.secret_str();
        let restored = Keypair::from_secret_str(&secret).unwrap();
        assert_eq!(restored.public_str(), kp.public_str());
        assert!(kp.public_str().starts_with('G'));
        assert!(secret.starts_with('S'));
        assert_eq!(decode_public(&kp.public_str()).unwrap(), kp.public_bytes());
    }

    #[test]
    fn signs_and_verifies() {
        let kp = Keypair::random();
        let sig = kp.sign(b"payload");
        assert!(Keypair::verify(&kp.public_bytes(), b"payload", &sig));
        assert!(!Keypair::verify(&kp.public_bytes(), b"other", &sig));
    }
}
