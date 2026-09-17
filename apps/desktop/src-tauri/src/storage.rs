//! The Rust half of the `Storage` port.
//!
//! One JSON document — `storage.json` in Atlas's own app-data directory — holds
//! every key Atlas has ever set. That's deliberately primitive: this backs
//! settings and small preferences, not a database, so a single file that's
//! trivial to read, back up, or delete by hand is the right amount of
//! machinery. `Manager::path().app_data_dir()` is core Tauri, not a plugin —
//! consistent with `platform.rs` preferring narrow custom commands over
//! pulling in a store plugin for something this small.

use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};

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
    let path = store_path(app)?;
    if !path.is_file() {
        return Ok(Store::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(Store::new());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
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
