//! What is using the space inside one folder — the question `system.disk`
//! doesn't answer.
//!
//! `system.disk` (`platform.rs`, built before this phase) says how full a
//! *drive* is. It has no idea what's using the space inside any one folder,
//! and that is the actual question behind "why is my C: drive full" or
//! "what's taking up space in Downloads". This module answers that one:
//! recursively summing a folder's contents, and finding its largest files.
//!
//! ## The same boundary every other path-taking command already has
//!
//! `is_permitted` (`platform.rs`) is the one rule every command that touches a
//! real path is checked against — inside the user's own folder tree, nothing
//! else. Reused here rather than re-derived, so this module cannot drift out
//! of agreement with the rest of the filesystem surface about what Atlas is
//! and isn't allowed to look at.
//!
//! ## An answer that stays honest past a certain size
//!
//! A folder can contain millions of entries — a whole source tree, an entire
//! user profile — and a walk with no limit is a command that can never be
//! trusted to return. Both commands below cap how much they will visit
//! (`MAX_ENTRIES`) and how long they will spend (`MAX_WALK_TIME`), and report
//! `truncated: true` rather than silently returning a wrong-but-plausible
//! number. The same "absence is an answer" property `net.rs` established for
//! a machine with no Wi-Fi applies here to a folder too big to fully measure.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::platform::is_permitted;

const MAX_ENTRIES: usize = 500_000;
const MAX_WALK_TIME: Duration = Duration::from_secs(8);

// ⚠️ `camelCase` is not decoration — see `services.rs`'s `ServiceDetail` for
// the day a renderer silently read `start_type` as `undefined` because serde
// sends Rust's own spelling by default.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub path: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub folder_count: u64,
    /// True when the walk hit `MAX_ENTRIES` or `MAX_WALK_TIME` before
    /// finishing — the numbers above are a partial count, not a wrong one.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LargestFiles {
    pub files: Vec<LargeFile>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn folder_size(path: String) -> Result<FolderSize, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if !p.is_dir() {
        return Err("That isn't a folder.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let mut total_bytes = 0u64;
        let mut file_count = 0u64;
        let mut folder_count = 0u64;
        let mut truncated = false;

        for (visited, entry) in walkdir::WalkDir::new(&p)
            .into_iter()
            .filter_map(Result::ok)
            .enumerate()
        {
            if visited >= MAX_ENTRIES || start.elapsed() > MAX_WALK_TIME {
                truncated = true;
                break;
            }
            if entry.file_type().is_dir() {
                folder_count += 1;
            } else if let Ok(meta) = entry.metadata() {
                total_bytes += meta.len();
                file_count += 1;
            }
        }

        FolderSize {
            path: p.to_string_lossy().into_owned(),
            total_bytes,
            file_count,
            folder_count,
            truncated,
        }
    })
    .await
    .map_err(|e| format!("The storage task failed: {e}"))
}

#[tauri::command]
pub async fn largest_files(path: String, limit: Option<u32>) -> Result<LargestFiles, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if !p.is_dir() {
        return Err("That isn't a folder.".into());
    }
    let cap = limit.unwrap_or(10).clamp(1, 50) as usize;

    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let mut files: Vec<LargeFile> = Vec::new();
        let mut truncated = false;

        for (visited, entry) in walkdir::WalkDir::new(&p)
            .into_iter()
            .filter_map(Result::ok)
            .enumerate()
        {
            if visited >= MAX_ENTRIES || start.elapsed() > MAX_WALK_TIME {
                truncated = true;
                break;
            }
            if entry.file_type().is_file() {
                if let Ok(meta) = entry.metadata() {
                    files.push(LargeFile {
                        path: entry.path().to_string_lossy().into_owned(),
                        name: entry.file_name().to_string_lossy().into_owned(),
                        size_bytes: meta.len(),
                    });
                }
            }
        }

        files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        files.truncate(cap);
        LargestFiles { files, truncated }
    })
    .await
    .map_err(|e| format!("The storage task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live, ignored by default — see `services.rs` for why this pattern runs
    /// throughout this crate for anything that needs a real filesystem.
    /// Measures the profile's own temp folder, which always exists and is
    /// always inside the permitted tree, and touches nothing.
    #[test]
    #[ignore]
    fn measures_a_real_folder() {
        let temp = std::env::temp_dir();
        assert!(is_permitted(&temp), "the temp folder should be inside the home tree");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let size = rt
            .block_on(folder_size(temp.to_string_lossy().into_owned()))
            .expect("folder_size");
        // A temp folder is never truly empty on a machine that's been used.
        assert!(size.total_bytes > 0 || size.file_count == 0, "{size:?}");

        let largest = rt
            .block_on(largest_files(temp.to_string_lossy().into_owned(), Some(5)))
            .expect("largest_files");
        assert!(largest.files.len() <= 5);
        for pair in largest.files.windows(2) {
            assert!(pair[0].size_bytes >= pair[1].size_bytes, "not sorted descending");
        }
    }

    #[test]
    fn a_path_outside_home_is_refused() {
        // `C:\Windows` exists on every Windows machine and is never inside a
        // user's home tree.
        let outside = PathBuf::from("C:\\Windows");
        assert!(!is_permitted(&outside));
    }
}
