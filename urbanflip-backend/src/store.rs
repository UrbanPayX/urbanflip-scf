//! Durable state: one JSON snapshot, rewritten atomically (temp file, fsync,
//! rename) after every mutation. Secret keys are sealed with ChaCha20-Poly1305
//! under STATE_KEY, bound to their record id; plaintext secrets never touch disk.

use crate::api::state::{BankSettlement, ClawbackRecord, IssuerStatus, PendingSettlement, SettlementRecord};
use crate::domain::prorata::{DealLedger, DistributionSchedule};
use crate::domain::rails::{CollectionBook, OffRampQueue, RailRegistry};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

pub const SNAPSHOT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct StoredIssuer {
    pub deal_id: String,
    pub asset_code: String,
    pub issuer_public: String,
    pub sealed_secret: String,
    pub provisioning_tx_hash: Option<String>,
    pub status: IssuerStatus,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Snapshot {
    pub version: u32,
    pub ledgers: HashMap<String, DealLedger>,
    pub issuers: HashMap<String, StoredIssuer>,
    pub profiles: RailRegistry,
    pub collections: CollectionBook,
    pub offramp: OffRampQueue,
    pub schedules: HashMap<String, DistributionSchedule>,
    pub bank_settlements: Vec<BankSettlement>,
    pub settled: HashMap<String, SettlementRecord>,
    pub pending_settlements: HashMap<String, PendingSettlement>,
    /// clawback_ref -> clawback, pending or done.
    #[serde(default)]
    pub clawbacks: HashMap<String, ClawbackRecord>,
    /// investor_id -> external wallet address proven by challenge.
    #[serde(default)]
    pub external_wallets: HashMap<String, String>,
    /// investor_id -> sealed wallet secret (dev wallet provider only).
    pub wallets: HashMap<String, String>,
    /// deal_id -> SDP disbursements created so far.
    pub disbursements: HashMap<String, Vec<serde_json::Value>>,
}

/// Seals secrets as "v1:" + base64(nonce || ciphertext).
pub struct SecretBox {
    cipher: ChaCha20Poly1305,
}

impl SecretBox {
    pub fn from_hex(key_hex: &str) -> Result<Self, String> {
        let key = hex::decode(key_hex.trim()).map_err(|_| "STATE_KEY must be hex")?;
        if key.len() != 32 {
            return Err("STATE_KEY must be 32 bytes (64 hex chars)".into());
        }
        Ok(Self { cipher: ChaCha20Poly1305::new(Key::from_slice(&key)) })
    }

    pub fn seal(&self, plaintext: &str, record_id: &str) -> String {
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: record_id.as_bytes() })
            .expect("chacha20poly1305 encrypt");
        let mut out = nonce.to_vec();
        out.extend(ciphertext);
        format!("v1:{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, out))
    }

    pub fn open(&self, sealed: &str, record_id: &str) -> Result<String, String> {
        let body = sealed.strip_prefix("v1:").ok_or("unknown sealed-secret version")?;
        let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body).map_err(|_| "sealed secret is not base64")?;
        if raw.len() < 12 {
            return Err("sealed secret too short".into());
        }
        let (nonce, ciphertext) = raw.split_at(12);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad: record_id.as_bytes() })
            .map_err(|_| format!("cannot unseal secret for '{record_id}' (wrong STATE_KEY or tampered state)"))?;
        String::from_utf8(plaintext).map_err(|_| "sealed secret is not UTF-8".into())
    }
}

pub struct Store {
    path: PathBuf,
    pub secrets: SecretBox,
    /// Serializes snapshot+write so a newer state is never overwritten by an older one.
    pub write_lock: tokio::sync::Mutex<()>,
    /// Exclusive OS lock on `<state>.lock`, held for the process lifetime: a
    /// second instance on the same state is refused. The OS drops it when the
    /// process exits, crash included, so it can never go stale.
    _instance_lock: std::fs::File,
}

impl Store {
    pub fn new(path: PathBuf, secrets: SecretBox) -> Result<Self, String> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let lock_path = path.with_extension("lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("open {}: {e}", lock_path.display()))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(format!("{} is locked by another running instance; refusing to share state", path.display()))
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(format!("lock {}: {e}", lock_path.display())),
        }
        Ok(Self { path, secrets, write_lock: tokio::sync::Mutex::new(()), _instance_lock: lock })
    }

    pub fn load(&self) -> Result<Option<Snapshot>, String> {
        let raw = match std::fs::read(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("read {}: {e}", self.path.display())),
        };
        let snapshot: Snapshot = serde_json::from_slice(&raw).map_err(|e| format!("parse {}: {e}", self.path.display()))?;
        if snapshot.version != SNAPSHOT_VERSION {
            return Err(format!("state version {} unsupported (expected {SNAPSHOT_VERSION})", snapshot.version));
        }
        Ok(Some(snapshot))
    }

    pub fn save(&self, snapshot: &Snapshot) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(snapshot).map_err(|e| format!("encode state: {e}"))?;
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let tmp = self.path.with_extension("tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp).map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(&json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all().map_err(|e| format!("fsync {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("rename to {}: {e}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn seals_and_binds_to_record() {
        let secrets = SecretBox::from_hex(KEY).unwrap();
        let sealed = secrets.seal("SECRET", "issuer:UF-1");
        assert!(sealed.starts_with("v1:") && !sealed.contains("SECRET"));
        assert_eq!(secrets.open(&sealed, "issuer:UF-1").unwrap(), "SECRET");
        assert!(secrets.open(&sealed, "issuer:UF-2").is_err(), "swapped record must not unseal");
        let other = SecretBox::from_hex(&KEY.replace("00", "ff")).unwrap();
        assert!(other.open(&sealed, "issuer:UF-1").is_err(), "wrong key must not unseal");
        assert!(SecretBox::from_hex("abcd").is_err());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = std::env::temp_dir().join(format!("uf-store-{}", rand::random::<u64>()));
        let store = Store::new(dir.join("state.json"), SecretBox::from_hex(KEY).unwrap()).unwrap();
        assert!(store.load().unwrap().is_none());
        let mut snapshot = Snapshot { version: SNAPSHOT_VERSION, ..Default::default() };
        snapshot.wallets.insert("inv-1".into(), store.secrets.seal("S...", "wallet:inv-1"));
        store.save(&snapshot).unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(store.secrets.open(&loaded.wallets["inv-1"], "wallet:inv-1").unwrap(), "S...");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("state.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn one_instance_per_state_file() {
        let dir = std::env::temp_dir().join(format!("uf-lock-{}", rand::random::<u64>()));
        let path = dir.join("state.json");
        let first = Store::new(path.clone(), SecretBox::from_hex(KEY).unwrap()).unwrap();
        let second = Store::new(path.clone(), SecretBox::from_hex(KEY).unwrap()).err().expect("second instance refused");
        assert!(second.contains("locked by another running instance"), "{second}");
        drop(first);
        assert!(Store::new(path, SecretBox::from_hex(KEY).unwrap()).is_ok(), "released with its holder");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
