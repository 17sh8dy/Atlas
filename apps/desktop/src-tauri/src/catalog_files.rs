//! Read-only file questions from the tool-catalog pass: a file's SHA-256, what is in
//! a zip, files found by extension / size / age or because they are empty, and how
//! two folders differ.
//!
//! Nothing here writes, and every path goes through `is_permitted`, the same gate
//! `file_tools.rs` uses. Walks stop at an entry count and a time limit and say they
//! were cut short.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::platform::is_permitted;

const MAX_WALK: usize = 300_000;
const WALK_TIME: Duration = Duration::from_secs(12);

fn permitted(p: &Path) -> Result<(), String> {
    if is_permitted(p) {
        Ok(())
    } else {
        Err("That path is outside the folders Atlas can touch.".into())
    }
}

// ---- hash ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHash {
    pub sha256: String,
    pub size_bytes: u64,
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("I couldn't read that file: {e}"))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        if crate::halt::global().check().is_err() {
            return Err("Stopped.".into());
        }
        let n = f.read(&mut buf).map_err(|e| format!("I couldn't read that file: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let digest: [u8; 32] = h.finalize().into();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// The SHA-256 of one file.
#[tauri::command]
pub async fn file_hash(path: String) -> Result<FileHash, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        permitted(&p)?;
        if !p.is_file() {
            return Err("That isn't a file.".to_string());
        }
        let size_bytes = p.metadata().map_err(|e| e.to_string())?.len();
        Ok(FileHash { sha256: hash_file(&p)?, size_bytes })
    })
    .await
    .map_err(|e| format!("Hashing failed: {e}"))?
}

// ---- what is in a zip -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub size_bytes: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntry>,
    pub total_entries: usize,
    pub total_bytes: u64,
}

/// What is inside a `.zip`, without extracting any of it. Names are shown as the
/// archive gives them; nothing is written anywhere.
#[tauri::command]
pub async fn list_archive(path: String, limit: Option<u32>) -> Result<ArchiveListing, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        permitted(&p)?;
        let file = File::open(&p).map_err(|e| format!("I couldn't open that: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|_| "That isn't a zip archive I can read.".to_string())?;
        let cap = limit.unwrap_or(40).clamp(1, 500) as usize;
        let total_entries = zip.len();
        let mut entries = Vec::new();
        let mut total_bytes = 0u64;
        for i in 0..total_entries {
            let Ok(f) = zip.by_index_raw(i) else { continue };
            total_bytes = total_bytes.saturating_add(f.size());
            if entries.len() < cap {
                entries.push(ArchiveEntry { name: f.name().to_string(), size_bytes: f.size(), is_dir: f.is_dir() });
            }
        }
        Ok(ArchiveListing { entries, total_entries, total_bytes })
    })
    .await
    .map_err(|e| format!("Listing the archive failed: {e}"))?
}

// ---- find files by extension / size / age, or empty ones -----------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub is_dir: bool,
    /// Epoch milliseconds.
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFiles {
    pub items: Vec<FoundFile>,
    /// How many matched in all (the list is capped).
    pub total: usize,
    pub truncated: bool,
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Files matching every filter given: `ext` (no dot), `min_bytes`, `max_bytes`,
/// `modified_within_days`, `older_than_days`. Or, with `empty` set to `files`,
/// `folders` or `any`, the empty ones. Newest first, at most `limit` listed.
#[tauri::command]
pub async fn find_files(
    path: String,
    ext: Option<String>,
    min_bytes: Option<u64>,
    max_bytes: Option<u64>,
    modified_within_days: Option<u32>,
    older_than_days: Option<u32>,
    empty: Option<String>,
    limit: Option<u32>,
) -> Result<FoundFiles, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        permitted(&root)?;
        if !root.is_dir() {
            return Err("That isn't a folder.".to_string());
        }
        let ext = ext.map(|e| e.trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty());
        let empty = match empty.as_deref() {
            None | Some("") => None,
            Some("files") => Some("files"),
            Some("folders") => Some("folders"),
            Some("any") => Some("any"),
            Some(other) => return Err(format!("“{other}” isn't something I can look for.")),
        };
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        let cap = limit.unwrap_or(50).clamp(1, 200) as usize;
        let started = Instant::now();
        let mut seen = 0usize;
        let mut truncated = false;
        let mut total = 0usize;
        let mut items: Vec<FoundFile> = Vec::new();

        // A repository's own `.git` folder is full of empty folders that are meant to be there.
        let walker = WalkDir::new(&root).follow_links(false).min_depth(1).into_iter().filter_entry(|e| e.file_name() != ".git");
        for entry in walker.filter_map(Result::ok) {
            seen += 1;
            if seen > MAX_WALK || started.elapsed() > WALK_TIME {
                truncated = true;
                break;
            }
            if seen % 2000 == 0 && crate::halt::global().check().is_err() {
                return Err("Stopped.".to_string());
            }
            let is_dir = entry.file_type().is_dir();
            let Ok(meta) = entry.metadata() else { continue };
            let size = if is_dir { 0 } else { meta.len() };

            let keep = match empty {
                Some("files") => !is_dir && size == 0,
                Some("folders") => is_dir && std::fs::read_dir(entry.path()).map(|mut d| d.next().is_none()).unwrap_or(false),
                Some(_) => (!is_dir && size == 0) || (is_dir && std::fs::read_dir(entry.path()).map(|mut d| d.next().is_none()).unwrap_or(false)),
                None => {
                    if is_dir {
                        false
                    } else {
                        let ext_ok = ext.as_ref().map_or(true, |want| {
                            entry.path().extension().map(|e| e.to_string_lossy().to_lowercase() == *want).unwrap_or(false)
                        });
                        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
                        ext_ok
                            && min_bytes.map_or(true, |m| size >= m)
                            && max_bytes.map_or(true, |m| size <= m)
                            && modified_within_days.map_or(true, |d| age.map_or(false, |a| a <= day * d))
                            && older_than_days.map_or(true, |d| age.map_or(false, |a| a >= day * d))
                    }
                }
            };
            if !keep {
                continue;
            }
            total += 1;
            items.push(FoundFile {
                path: entry.path().to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size_bytes: size,
                is_dir,
                modified_at: meta.modified().map(millis).unwrap_or(0),
            });
            // Keep memory flat on a huge match: only the newest `cap` are kept.
            if items.len() > cap * 4 {
                items.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
                items.truncate(cap);
            }
        }
        items.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        items.truncate(cap);
        Ok(FoundFiles { items, total, truncated })
    })
    .await
    .map_err(|e| format!("The search failed: {e}"))?
}

// ---- how two folders differ ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderComparison {
    pub only_in_a: Vec<String>,
    pub only_in_b: Vec<String>,
    pub different: Vec<String>,
    pub same: usize,
    pub truncated: bool,
}

fn relative_files(root: &Path, started: Instant, truncated: &mut bool) -> BTreeMap<String, (u64, PathBuf)> {
    let mut out = BTreeMap::new();
    for (i, entry) in WalkDir::new(root).follow_links(false).into_iter().filter_map(Result::ok).enumerate() {
        if i > MAX_WALK || started.elapsed() > WALK_TIME {
            *truncated = true;
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.insert(rel.to_string_lossy().replace('\\', "/"), (len, entry.path().to_path_buf()));
    }
    out
}

/// Which files are in one folder and not the other, and which exist in both with
/// different contents (size first, then SHA-256).
#[tauri::command]
pub async fn compare_folders(a: String, b: String) -> Result<FolderComparison, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (pa, pb) = (PathBuf::from(&a), PathBuf::from(&b));
        permitted(&pa)?;
        permitted(&pb)?;
        if !pa.is_dir() || !pb.is_dir() {
            return Err("Both of those need to be folders.".to_string());
        }
        let started = Instant::now();
        let mut truncated = false;
        let fa = relative_files(&pa, started, &mut truncated);
        let fb = relative_files(&pb, started, &mut truncated);
        let names: BTreeSet<&String> = fa.keys().chain(fb.keys()).collect();
        let (mut only_a, mut only_b, mut different, mut same) = (Vec::new(), Vec::new(), Vec::new(), 0usize);
        for name in names {
            match (fa.get(name), fb.get(name)) {
                (Some(_), None) => only_a.push(name.clone()),
                (None, Some(_)) => only_b.push(name.clone()),
                (Some((sa, pa)), Some((sb, pb))) => {
                    if sa != sb {
                        different.push(name.clone());
                    } else if started.elapsed() > WALK_TIME * 3 {
                        truncated = true;
                    } else if hash_file(pa)? == hash_file(pb)? {
                        same += 1;
                    } else {
                        different.push(name.clone());
                    }
                }
                (None, None) => {}
            }
        }
        for v in [&mut only_a, &mut only_b, &mut different] {
            v.truncate(200);
        }
        Ok(FolderComparison { only_in_a: only_a, only_in_b: only_b, different, same, truncated })
    })
    .await
    .map_err(|e| format!("Comparing failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("atlas-catalog-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn hashes_a_known_value() {
        let d = temp("hash");
        let f = d.join("a.txt");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(hash_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn lists_a_zip_without_extracting() {
        use std::io::Write;
        let d = temp("zip");
        let z = d.join("t.zip");
        let mut w = zip::ZipWriter::new(File::create(&z).unwrap());
        w.start_file("one.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"hello").unwrap();
        w.finish().unwrap();
        let file = File::open(&z).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 1);
        assert_eq!(archive.by_index_raw(0).unwrap().name(), "one.txt");
        // nothing was extracted
        assert!(!d.join("one.txt").exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn compares_two_folders() {
        let (a, b) = (temp("cmp-a"), temp("cmp-b"));
        std::fs::write(a.join("same.txt"), b"x").unwrap();
        std::fs::write(b.join("same.txt"), b"x").unwrap();
        std::fs::write(a.join("diff.txt"), b"one").unwrap();
        std::fs::write(b.join("diff.txt"), b"two").unwrap();
        std::fs::write(a.join("left.txt"), b"l").unwrap();
        std::fs::write(b.join("right.txt"), b"r").unwrap();
        let started = Instant::now();
        let mut t = false;
        let (fa, fb) = (relative_files(&a, started, &mut t), relative_files(&b, started, &mut t));
        assert_eq!(fa.len(), 3);
        assert!(fa.contains_key("left.txt") && !fb.contains_key("left.txt"));
        assert_ne!(hash_file(&fa["diff.txt"].1).unwrap(), hash_file(&fb["diff.txt"].1).unwrap());
        assert_eq!(hash_file(&fa["same.txt"].1).unwrap(), hash_file(&fb["same.txt"].1).unwrap());
        let _ = (std::fs::remove_dir_all(a), std::fs::remove_dir_all(b));
    }
}
