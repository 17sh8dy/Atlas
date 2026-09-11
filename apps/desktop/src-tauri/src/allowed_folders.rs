//! The allowed-folders list — the one setting that decides what every file
//! command in this crate is even allowed to look at.
//!
//! ## Why this exists
//!
//! `is_permitted` used to be a hard rule with no way to change it: anywhere
//! under `%USERPROFILE%`, and nowhere else. That refuses `D:\Dev` — or any
//! project living outside the user's home directory — for every file command
//! Atlas has, deliberately (see the roadmap's "this is the security model
//! working as designed" note). This module turns that hard rule into the
//! user's decision instead of an assumption baked into the binary: a short,
//! visible list of folders Atlas may read or change anything inside,
//! editable in Settings, **defaulting to exactly what `is_permitted` already
//! allowed** — `%USERPROFILE%` alone — so nobody's behaviour changes until
//! they explicitly add to it.
//!
//! ## What is still true no matter what's on the list
//!
//! A folder on this list grants Atlas exactly the operations it already had
//! inside `%USERPROFILE%` — open, read, create, rename, move, delete (always
//! to the recycle bin), list, measure. Adding a folder widens *where* those
//! already-narrow, already-confirmed operations may act; it unlocks no new
//! one. `exec(command)` is still refused everywhere, on every folder.
//!
//! ## A global, not an `AppHandle` argument threaded through everything
//!
//! Roughly twenty call sites across `platform.rs` and `disk_usage.rs` check
//! `is_permitted` today, and none of them take an `AppHandle`. Adding one to
//! every signature to thread a per-app setting through would touch every
//! file command in the crate for the sake of one flag. A process-wide
//! `RwLock`, loaded once at startup from the same `Storage` port
//! (`storage.rs`) everything else in this app persists through, keeps
//! `is_permitted`'s signature exactly as narrow as it always was — a read
//! never blocks a writer for longer than cloning a short `Vec` takes.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

fn lock() -> &'static RwLock<Vec<PathBuf>> {
    static ALLOWED: OnceLock<RwLock<Vec<PathBuf>>> = OnceLock::new();
    ALLOWED.get_or_init(|| RwLock::new(default_roots()))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn default_roots() -> Vec<PathBuf> {
    dirs_home()
        .and_then(|h| h.canonicalize().ok())
        .into_iter()
        .collect()
}

/// Called once, from `setup()`, before any command can run.
///
/// Seeds the in-memory list from whatever was saved last time. A folder that
/// no longer exists — a USB drive unplugged since the last run, a deleted
/// project — is dropped rather than kept as an entry that would fail every
/// check against it anyway; the roots that fail come with a real reason, so
/// the return value says which were dropped for the caller to log.
pub fn init(saved: Option<Vec<String>>) -> Vec<String> {
    let Some(saved) = saved else { return Vec::new() };
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for raw in saved {
        match PathBuf::from(&raw).canonicalize() {
            Ok(p) if p.is_dir() => kept.push(p),
            _ => dropped.push(raw),
        }
    }
    if let Ok(mut guard) = lock().write() {
        if !kept.is_empty() {
            *guard = kept;
        }
        // An empty saved list, or one where every entry failed to resolve,
        // leaves the built-in default in place rather than locking Atlas out
        // of its own home folder.
    }
    dropped
}

/// Is this path inside one of the allowed roots?
///
/// The one check every path-taking command in this crate makes before
/// touching disk. Canonicalizing the incoming path is what stops `..` or a
/// symlink from resolving to somewhere outside every allowed root while
/// still spelling a prefix that looks like it's inside one.
pub fn is_permitted(path: &Path) -> bool {
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    let Ok(roots) = lock().read() else { return false };
    roots.iter().any(|root| canonical.starts_with(root))
}

/// The raw roots, for `indexed_roots()` — internal use only. The frontend
/// reads `allowed_folders()` below, which is a plain string list: nothing
/// about this setting needs more than a path to render in Settings.
pub(crate) fn roots() -> Vec<PathBuf> {
    lock().read().map(|r| r.clone()).unwrap_or_default()
}

fn as_strings() -> Vec<String> {
    roots().into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
pub fn allowed_folders() -> Vec<String> {
    as_strings()
}

/// Add a folder to the list, and persist it.
///
/// Canonicalized and confirmed to actually be a folder before it's accepted
/// — the same "a path is a claim, not a fact" rule `platform.rs` applies to
/// every path arriving from the renderer.
#[tauri::command]
pub fn add_allowed_folder(
    app: tauri::AppHandle,
    state: tauri::State<crate::storage::StorageState>,
    path: String,
) -> Result<Vec<String>, String> {
    let canonical = PathBuf::from(path.trim())
        .canonicalize()
        .map_err(|_| "That folder doesn't exist.".to_string())?;
    if !canonical.is_dir() {
        return Err("That isn't a folder.".into());
    }

    {
        let mut guard = lock().write().map_err(|_| "Couldn't update the list.".to_string())?;
        if !guard.contains(&canonical) {
            guard.push(canonical);
        }
    }
    persist(app, state)?;
    Ok(as_strings())
}

/// Remove a folder from the list, and persist it.
///
/// Refuses to empty the list entirely: a zero-folder Atlas can't even offer
/// a "pick a folder" flow that would land anywhere, since every file command
/// — including the one behind that flow — checks this same list.
#[tauri::command]
pub fn remove_allowed_folder(
    app: tauri::AppHandle,
    state: tauri::State<crate::storage::StorageState>,
    path: String,
) -> Result<Vec<String>, String> {
    let target_canonical = PathBuf::from(path.trim()).canonicalize().ok();

    {
        let mut guard = lock().write().map_err(|_| "Couldn't update the list.".to_string())?;
        if guard.len() <= 1 {
            return Err("At least one folder has to stay on the list.".into());
        }
        let before = guard.len();
        guard.retain(|r| Some(r) != target_canonical.as_ref() && r.to_string_lossy() != path);
        if guard.len() == before {
            return Err("That folder isn't on the list.".into());
        }
    }
    persist(app, state)?;
    Ok(as_strings())
}

const STORAGE_KEY: &str = "atlas.allowedFolders";

fn persist(
    app: tauri::AppHandle,
    state: tauri::State<crate::storage::StorageState>,
) -> Result<(), String> {
    crate::storage::storage_set(
        app,
        state,
        STORAGE_KEY.to_string(),
        serde_json::to_value(as_strings()).map_err(|e| e.to_string())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_saved_value_keeps_the_default() {
        // `init(None)` is what a fresh install sees — the key was never set.
        let dropped = init(None);
        assert!(dropped.is_empty());
    }

    #[test]
    fn a_folder_that_no_longer_exists_is_reported_dropped() {
        let dropped = init(Some(vec!["Z:\\this\\does\\not\\exist\\anywhere".to_string()]));
        assert_eq!(dropped, vec!["Z:\\this\\does\\not\\exist\\anywhere".to_string()]);
    }
}
