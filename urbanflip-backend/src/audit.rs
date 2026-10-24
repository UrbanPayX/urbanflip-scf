//! JSONL audit log: every gate decision and state change, with tx hashes.

use std::path::PathBuf;

#[derive(Default)]
pub struct AuditLog {
    path: Option<PathBuf>,
    events: Vec<serde_json::Value>,
}

impl AuditLog {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self { path, events: Vec::new() }
    }

    pub async fn append(&mut self, mut event: serde_json::Value) {
        if !event.is_object() {
            return;
        }
        let obj = event.as_object_mut().unwrap();
        obj.insert("ts".into(), serde_json::Value::String(super::gate_now()));
        self.events.push(event.clone());
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{event}");
            }
        }
    }

    pub fn recent(&self, limit: usize) -> Vec<serde_json::Value> {
        self.events.iter().rev().take(limit).cloned().collect()
    }
}
