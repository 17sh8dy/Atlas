//! The Rust half of the `Storage` port.
//!
//! One JSON document — `storage.json` in Atlas's own app-data directory — holds
//! every key Atlas has ever set. That's deliberately primitive: this backs
//! settings and small preferences, not a database, so a single file that's
//! trivial to read, back up, or delete by hand is the right amount of
//! machinery. `Manager::path().app_data_dir()` is core Tauri, not a plugin —
//! consistent with `platform.rs` preferring narrow custom commands over
//! pulling in a store plugin for something this small.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Manager};

type Store = HashMap<String, serde_json::Value>;

/// Serialises writes so two settings saved in quick succession can't race and
/// clobber each other in the read-modify-write cycle below.
pub struct StorageState(pub Mutex<()>);

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("storage.json"))
}

/// Keys are our own dot-namespaced convention (`atlas.theme`), not user
/// content — validated the same way any input crossing from the renderer is,
/// and it keeps the file human-diffable if anyone ever opens it.
pub(crate) fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn load(app: &AppHandle) -> Result<Store, String> {
    load_from(&store_path(app)?)
}

fn load_from(path: &Path) -> Result<Store, String> {
    if !path.is_file() {
        return Ok(Store::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Store::new());
    }
    match serde_json::from_str(&raw) {
        Ok(store) => Ok(store),
        Err(_) => {
            // A file that no longer parses (a write cut short by a crash or a
            // power cut) must not lock every read and write out forever. Keep
            // it beside the store for anyone who wants to recover by hand, and
            // start clean.
            let _ = fs::rename(path, path.with_extension("json.corrupt"));
            Ok(Store::new())
        }
    }
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    save_to(&store_path(app)?, store)
}

fn save_to(path: &Path, store: &Store) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // Written beside the real file and renamed over it: a rename replaces the
    // old contents whole or not at all, so being killed mid-save (an update
    // installing, a crash) leaves the previous settings intact rather than a
    // truncated file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn storage_get(
    app: AppHandle,
    state: tauri::State<StorageState>,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let _guard = state.0.lock().unwrap();
    if !is_valid_key(&key) {
        return Err("Invalid storage key.".into());
    }
    Ok(load(&app)?.get(&key).cloned())
}

#[tauri::command]
pub fn storage_set(
    app: AppHandle,
    state: tauri::State<StorageState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let _guard = state.0.lock().unwrap();
    if !is_valid_key(&key) {
        return Err("Invalid storage key.".into());
    }
    let mut store = load(&app)?;
    store.insert(key, value);
    save(&app, &store)
}

#[tauri::command]
pub fn storage_remove(
    app: AppHandle,
    state: tauri::State<StorageState>,
    key: String,
) -> Result<(), String> {
    let _guard = state.0.lock().unwrap();
    if !is_valid_key(&key) {
        return Err("Invalid storage key.".into());
    }
    let mut store = load(&app)?;
    store.remove(&key);
    save(&app, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-storage-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("storage.json")
    }

    #[test]
    fn a_saved_store_reads_back_and_leaves_no_temp_file() {
        let path = scratch("roundtrip");
        let mut store = Store::new();
        store.insert("atlas.theme".into(), serde_json::json!("dark"));
        save_to(&path, &store).unwrap();
        save_to(&path, &store).unwrap(); // replacing an existing file works too
        assert_eq!(load_from(&path).unwrap().get("atlas.theme"), Some(&serde_json::json!("dark")));
        assert!(!path.with_extension("json.tmp").exists());
    }

    /// The bug this closed: a store cut off mid-write made every later read
    /// and write fail, so settings could never be saved again.
    #[test]
    fn a_truncated_store_recovers_instead_of_locking_everything_out() {
        let path = scratch("corrupt");
        fs::write(&path, r#"{"atlas.theme": "da"#).unwrap();
        let store = load_from(&path).expect("a corrupt file must not be an error");
        assert!(store.is_empty());
        assert!(path.with_extension("json.corrupt").exists(), "the damaged file is kept");
        // and saving works again straight away
        let mut fresh = Store::new();
        fresh.insert("atlas.theme".into(), serde_json::json!("light"));
        save_to(&path, &fresh).unwrap();
        assert_eq!(load_from(&path).unwrap().len(), 1);
    }

    #[test]
    fn the_rule_is_lowercase_dot_namespaced_names() {
        assert!(is_valid_key("atlas.theme"));
        assert!(is_valid_key("atlas.halt-shortcut"));
        assert!(is_valid_key("atlas.settings.notifications-enabled"));
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("atlas/theme"));
        assert!(!is_valid_key(&"a".repeat(129)));
    }

    /// Capital letters are the trap, and this test exists because they do not
    /// fail loudly. `storage_set` returns an `Err` callers log at best, and the
    /// paired `storage_get` is usually `.ok().flatten()` — so a key with a
    /// capital letter reads back as "never saved", forever, in silence. It has
    /// bitten twice now: `atlas.haltShortcut` (a rebind Windows had already
    /// accepted, reported to the user as a failure) and `atlas.allowedFolders`
    /// (the folder list quietly reverting to the default on every launch).
    ///
    /// So this sweeps every `atlas.*` key literal in the repo — Rust and
    /// TypeScript alike, since both halves call the same commands — rather
    /// than naming keys one at a time, which is what let the second one
    /// through. A new key with a capital letter now fails in `cargo test`.
    #[test]
    fn every_storage_key_literal_in_the_repo_is_one_storage_accepts() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..");
        let mut checked = 0usize;
        let mut bad: Vec<(String, String)> = Vec::new();

        for file in source_files(&root) {
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            for key in key_literals(&text) {
                checked += 1;
                if !is_valid_key(&key) {
                    bad.push((file.display().to_string(), key));
                }
            }
        }

        assert!(
            checked > 5,
            "the sweep found almost nothing, so it has stopped looking (checked {checked})"
        );
        assert!(
            bad.is_empty(),
            "storage keys that `storage_get`/`storage_set` refuse \
             (lowercase `[a-z0-9._-]` only):\n{}",
            bad.iter()
                .map(|(f, k)| format!("  {k}  in {f}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    /// The one legitimate reason to write a key storage would refuse: reading
    /// a value the *browser* build saved under an older spelling, where
    /// `localStorage` accepted it. A line carrying this marker is exempt — it
    /// has to be written deliberately, and it reads as what it is.
    const LEGACY_MARKER: &str = "storage-key-legacy";

    /// Quoted `atlas.…` literals, single- or double-quoted, containing no path
    /// separator — which is what keeps a file path that merely mentions the
    /// word from being read as a storage key.
    fn key_literals(text: &str) -> Vec<String> {
        let not_a_key = ['/', '\\', ' ', '{', '$'];
        let mut found = Vec::new();
        for line in text.lines() {
            if line.contains(LEGACY_MARKER) {
                continue;
            }
            for quote in ['"', '\''] {
                let mut rest = line;
                while let Some(start) = rest.find(quote) {
                    rest = &rest[start + 1..];
                    let Some(end) = rest.find(quote) else { break };
                    let literal = &rest[..end];
                    rest = &rest[end + 1..];
                    if literal.starts_with("atlas.")
                        && literal.len() > "atlas.".len()
                        && !literal.contains(not_a_key)
                    {
                        found.push(literal.to_string());
                    }
                }
            }
        }
        found
    }

    fn source_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        const SKIP: [&str; 5] = ["node_modules", "target", "dist", ".git", "gen"];
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(dir) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP.contains(&name.as_str()) {
                    out.extend(source_files(&path));
                }
            } else if matches!(path.extension().and_then(|e| e.to_str()), Some("rs" | "ts" | "tsx")) {
                out.push(path);
            }
        }
        out
    }
}
