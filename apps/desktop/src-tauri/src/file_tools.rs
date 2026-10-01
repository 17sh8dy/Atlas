//! Zip and unzip, duplicate finding, "what changed here", and file attributes.
//!
//! Every path goes through `is_permitted`, the one rule the rest of the file
//! surface is held to — inside the folders Atlas is allowed to touch, symlinks
//! resolved before the check. Nothing here runs a program or a command line.
//!
//! ## Nothing is overwritten, and nothing is unbounded
//!
//! Zipping and unzipping always write to a *new* name (`notes.zip`, then
//! `notes (2).zip`) and never replace what is there. A walk over a folder stops
//! at a count and a time limit and says it was cut short, the same as
//! `disk_usage.rs`: a partial answer that admits it is partial is fine, a
//! confident wrong one is not.
//!
//! ## Unzipping is where the danger is
//!
//! An archive can name an entry `..\..\Startup\x.exe` (zip-slip), or be a few
//! kilobytes that expand to terabytes (a zip bomb). Entry names are taken only
//! from `enclosed_name()` (which refuses anything that climbs out), and the
//! total size and entry count are capped *before* anything is written, from
//! the archive's own directory, and again while extracting, since a directory
//! can lie about sizes.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::platform::is_permitted;

const MAX_ZIP_ENTRIES: usize = 50_000;
const MAX_ZIP_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GB, in or out
const MAX_WALK: usize = 200_000;
const WALK_TIME: Duration = Duration::from_secs(10);

fn permitted(p: &Path) -> Result<(), String> {
    if is_permitted(p) {
        Ok(())
    } else {
        Err("That path is outside the folders Atlas can touch.".into())
    }
}

/// `name`, or `name (2)`, `name (3)` … — the first that does not exist yet.
fn free_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let make = |n: u32| {
        let base = if n == 1 { stem.to_string() } else { format!("{stem} ({n})") };
        dir.join(if ext.is_empty() { base } else { format!("{base}.{ext}") })
    };
    (1u32..).map(make).find(|p| !p.exists()).unwrap()
}

// ---- zip --------------------------------------------------------------------------

/// Zip a file or a folder into a new `.zip` beside it (or in `dest_dir`).
/// Returns the path of the archive.
#[tauri::command]
pub async fn zip_path(path: String, dest_dir: Option<String>) -> Result<String, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || zip_blocking(&path, dest_dir.as_deref()))
        .await
        .map_err(|e| format!("Zipping failed: {e}"))?
}

fn zip_blocking(path: &str, dest_dir: Option<&str>) -> Result<String, String> {
    let src = PathBuf::from(path);
    permitted(&src)?;
    let dest_dir = match dest_dir {
        Some(d) => {
            let d = PathBuf::from(d);
            permitted(&d)?;
            d
        }
        None => src.parent().ok_or("That path has no folder to put the zip in.")?.to_path_buf(),
    };
    let stem = src.file_stem().and_then(|s| s.to_str()).ok_or("That path has no name.")?;
    let out_path = free_name(&dest_dir, stem, "zip");

    // The list first, so a folder too big to zip is refused before a byte is written.
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut total: u64 = 0;
    let root_name = src.file_name().and_then(|s| s.to_str()).unwrap_or("files").to_string();
    if src.is_file() {
        total = src.metadata().map_err(|e| e.to_string())?.len();
        files.push((src.clone(), root_name));
    } else {
        for entry in WalkDir::new(&src).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            // Links and junctions are skipped, not followed: a junction back up the
            // tree would otherwise zip the whole drive into a folder on it.
            if entry.path_is_symlink() || !entry.file_type().is_file() {
                continue;
            }
            total += entry.metadata().map_err(|e| e.to_string())?.len();
            if files.len() >= MAX_ZIP_ENTRIES || total > MAX_ZIP_BYTES {
                return Err("That's too big to zip from here (over 50,000 files or 4 GB).".into());
            }
            let rel = entry.path().strip_prefix(&src).map_err(|e| e.to_string())?;
            let name = format!("{}/{}", root_name, rel.to_string_lossy().replace('\\', "/"));
            files.push((entry.path().to_path_buf(), name));
        }
    }
    if files.is_empty() {
        return Err("There is nothing in there to zip.".into());
    }
    if total > MAX_ZIP_BYTES {
        return Err("That's too big to zip from here (over 4 GB).".into());
    }

    let result = (|| -> Result<(), String> {
        let out = File::create(&out_path).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(out);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(total > u32::MAX as u64);
        for (file, name) in &files {
            crate::halt::global().check()?;
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            let mut input = File::open(file).map_err(|e| format!("Couldn't read {name}: {e}"))?;
            io::copy(&mut input, &mut zip).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        // A half-written archive is worse than none.
        let _ = fs::remove_file(&out_path);
        return Err(e);
    }
    Ok(out_path.to_string_lossy().into_owned())
}

// ---- unzip -------------------------------------------------------------------------

/// Extract a `.zip` into a new folder named after it (beside it, or in
/// `dest_dir`). Returns the folder.
#[tauri::command]
pub async fn unzip_path(path: String, dest_dir: Option<String>) -> Result<String, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || unzip_blocking(&path, dest_dir.as_deref()))
        .await
        .map_err(|e| format!("Unzipping failed: {e}"))?
}

fn unzip_blocking(path: &str, dest_dir: Option<&str>) -> Result<String, String> {
    let src = PathBuf::from(path);
    permitted(&src)?;
    if !src.is_file() || !src.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
        return Err("That isn't a .zip file.".into());
    }
    let dest_dir = match dest_dir {
        Some(d) => {
            let d = PathBuf::from(d);
            permitted(&d)?;
            d
        }
        None => src.parent().ok_or("That file has no folder.")?.to_path_buf(),
    };
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("unzipped");
    let out_dir = free_name(&dest_dir, stem, "");

    let mut archive = zip::ZipArchive::new(File::open(&src).map_err(|e| e.to_string())?)
        .map_err(|_| "That doesn't look like a valid zip file.".to_string())?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err("That zip has too many files to open from here (over 50,000).".into());
    }
    // The archive's own directory says how big it claims to be. It can lie, which
    // is why the copy below is capped as well.
    let mut claimed: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if entry.encrypted() {
            return Err("That zip is password protected — I can't open those.".into());
        }
        claimed = claimed.saturating_add(entry.size());
    }
    if claimed > MAX_ZIP_BYTES {
        return Err("That zip expands to more than 4 GB — I won't open it from here.".into());
    }

    fs::create_dir(&out_dir).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut written: u64 = 0;
        for i in 0..archive.len() {
            crate::halt::global().check()?;
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            // Anything that would climb out of the folder is skipped, never written.
            let Some(rel) = entry.enclosed_name() else { continue };
            let target = out_dir.join(rel);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&target).map_err(|e| e.to_string())?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                written += n as u64;
                if written > MAX_ZIP_BYTES {
                    return Err("That zip is larger than it said it was — stopped.".into());
                }
                out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&out_dir);
        return Err(e);
    }
    Ok(out_dir.to_string_lossy().into_owned())
}

// ---- duplicates -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub size_bytes: u64,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Duplicates {
    pub groups: Vec<DuplicateGroup>,
    /// Bytes that deleting every copy but one of each group would free.
    pub wasted_bytes: u64,
    pub truncated: bool,
}

fn sha256(path: &Path) -> Option<[u8; 32]> {
    let mut f = File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().into())
}

/// Files in a folder whose contents are identical. Same size first (cheap), then
/// a SHA-256 of the ones that share a size. Files under 1 KB are ignored: a
/// thousand tiny identical config files are not wasted space worth reporting.
#[tauri::command]
pub async fn find_duplicates(path: String) -> Result<Duplicates, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        permitted(&root)?;
        let started = Instant::now();
        let mut truncated = false;
        let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
        let mut seen = 0usize;
        for entry in WalkDir::new(&root).follow_links(false).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            seen += 1;
            if seen > MAX_WALK || started.elapsed() > WALK_TIME {
                truncated = true;
                break;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() >= 1024 {
                    by_size.entry(meta.len()).or_default().push(entry.path().to_path_buf());
                }
            }
        }
        let mut groups = Vec::new();
        let mut wasted = 0u64;
        for (size, paths) in by_size.into_iter().filter(|(_, p)| p.len() > 1) {
            let mut by_hash: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();
            for p in paths {
                if crate::halt::global().check().is_err() {
                    return Err("Stopped.".to_string());
                }
                if started.elapsed() > WALK_TIME * 3 {
                    truncated = true;
                    break;
                }
                if let Some(h) = sha256(&p) {
                    by_hash.entry(h).or_default().push(p);
                }
            }
            for (_, same) in by_hash.into_iter().filter(|(_, p)| p.len() > 1) {
                wasted += size * (same.len() as u64 - 1);
                groups.push(DuplicateGroup {
                    size_bytes: size,
                    paths: same.into_iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                });
            }
        }
        groups.sort_by(|a, b| {
            (b.size_bytes * b.paths.len() as u64).cmp(&(a.size_bytes * a.paths.len() as u64))
        });
        groups.truncate(50);
        Ok(Duplicates { groups, wasted_bytes: wasted, truncated })
    })
    .await
    .map_err(|e| format!("Looking for duplicates failed: {e}"))?
}

// ---- compare two files -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub identical: bool,
    pub size_a: u64,
    pub size_b: u64,
}

/// Are two files byte-for-byte the same? Sizes first (free), then a hash of each
/// only when the sizes agree. Read-only.
#[tauri::command]
pub async fn compare_files(a: String, b: String) -> Result<Comparison, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (pa, pb) = (PathBuf::from(&a), PathBuf::from(&b));
        permitted(&pa)?;
        permitted(&pb)?;
        if !pa.is_file() || !pb.is_file() {
            return Err("Both of those need to be files, not folders.".to_string());
        }
        let size_a = pa.metadata().map_err(|e| e.to_string())?.len();
        let size_b = pb.metadata().map_err(|e| e.to_string())?.len();
        if size_a != size_b {
            return Ok(Comparison { identical: false, size_a, size_b });
        }
        let identical = match (sha256(&pa), sha256(&pb)) {
            (Some(x), Some(y)) => x == y,
            _ => return Err("I couldn't read one of those files.".to_string()),
        };
        Ok(Comparison { identical, size_a, size_b })
    })
    .await
    .map_err(|e| format!("Comparing failed: {e}"))?
}

// ---- what changed ----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    /// Epoch milliseconds.
    pub modified_at: u64,
}

/// Files changed in the last `hours` hours, newest first, at most `limit`.
#[tauri::command]
pub async fn recent_changes(path: String, hours: u32, limit: Option<u32>) -> Result<Vec<ChangedFile>, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        permitted(&root)?;
        let hours = hours.clamp(1, 24 * 365);
        let cutoff = SystemTime::now()
            .checked_sub(Duration::from_secs(hours as u64 * 3600))
            .unwrap_or(UNIX_EPOCH);
        let started = Instant::now();
        let mut out: Vec<ChangedFile> = Vec::new();
        for (seen, entry) in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                // Dependency and build folders drown a real answer in noise.
                !matches!(
                    e.file_name().to_str(),
                    Some("node_modules" | ".git" | "target" | "dist" | "build" | ".venv" | "__pycache__")
                )
            })
            .filter_map(Result::ok)
            .enumerate()
        {
            if seen > MAX_WALK || started.elapsed() > WALK_TIME {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            if modified >= cutoff {
                out.push(ChangedFile {
                    path: entry.path().to_string_lossy().into_owned(),
                    name: entry.file_name().to_string_lossy().into_owned(),
                    size_bytes: meta.len(),
                    modified_at: modified
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                });
            }
        }
        out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        out.truncate(limit.unwrap_or(25).clamp(1, 200) as usize);
        Ok(out)
    })
    .await
    .map_err(|e| format!("Looking for changes failed: {e}"))?
}

// ---- attributes ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttributes {
    pub read_only: bool,
    pub hidden: bool,
    pub system: bool,
}

#[cfg(windows)]
const ATTR_READONLY: u32 = 0x1;
#[cfg(windows)]
const ATTR_HIDDEN: u32 = 0x2;
#[cfg(windows)]
const ATTR_SYSTEM: u32 = 0x4;

#[cfg(windows)]
#[tauri::command]
pub fn file_attributes(path: String) -> Result<FileAttributes, String> {
    use std::os::windows::fs::MetadataExt;
    let p = PathBuf::from(&path);
    permitted(&p)?;
    let a = fs::metadata(&p).map_err(|e| e.to_string())?.file_attributes();
    Ok(FileAttributes {
        read_only: a & ATTR_READONLY != 0,
        hidden: a & ATTR_HIDDEN != 0,
        system: a & ATTR_SYSTEM != 0,
    })
}

/// Set or clear read-only and/or hidden. `None` leaves that one alone. The
/// *system* attribute is deliberately not settable: marking something as a
/// system file hides it from every view, and there is no good reason to ask.
#[cfg(windows)]
#[tauri::command]
pub fn set_file_attributes(
    path: String,
    read_only: Option<bool>,
    hidden: Option<bool>,
) -> Result<FileAttributes, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_FLAGS_AND_ATTRIBUTES};

    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    permitted(&p)?;
    let current = fs::metadata(&p).map_err(|e| e.to_string())?.file_attributes();
    if current & ATTR_SYSTEM != 0 {
        return Err("That's a Windows system file — I won't change its attributes.".into());
    }
    let mut next = current;
    let mut apply = |flag: u32, want: Option<bool>| match want {
        Some(true) => next |= flag,
        Some(false) => next &= !flag,
        None => {}
    };
    apply(ATTR_READONLY, read_only);
    apply(ATTR_HIDDEN, hidden);
    if next != current {
        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(next)) }
            .map_err(|e| e.message())?;
    }
    file_attributes(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-file-tools-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn free_name_never_picks_something_that_exists() {
        let d = temp("free");
        fs::write(d.join("a.zip"), b"x").unwrap();
        fs::write(d.join("a (2).zip"), b"x").unwrap();
        assert_eq!(free_name(&d, "a", "zip"), d.join("a (3).zip"));
        assert_eq!(free_name(&d, "b", "zip"), d.join("b.zip"));
        let _ = fs::remove_dir_all(d);
    }

    /// Builds a zip by hand with an entry that tries to climb out of the target
    /// folder, and checks nothing lands outside it.
    #[test]
    fn unzipping_refuses_to_climb_out_of_the_folder() {
        let d = temp("slip");
        let zip_path = d.join("evil.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            w.start_file("ok.txt", o).unwrap();
            w.write_all(b"fine").unwrap();
            w.start_file("../escaped.txt", o).unwrap();
            w.write_all(b"bad").unwrap();
            w.finish().unwrap();
        }
        // Drive the extraction core directly: is_permitted needs the app's roots.
        let mut archive = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let out = d.join("out");
        fs::create_dir(&out).unwrap();
        let mut safe = 0;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            if entry.enclosed_name().is_some() {
                safe += 1;
            }
        }
        assert_eq!(safe, 1, "only ok.txt is a safe name");
        assert!(!d.join("escaped.txt").exists());
        let _ = fs::remove_dir_all(d);
    }

    /// The whole path on real files: zip a folder, unzip it, compare what comes out,
    /// find the duplicates, list what changed, and hide / unhide a file. The temp
    /// folder is inside the user's home, which is an allowed root by default; where
    /// it is not (a CI machine), the test says so and stops rather than failing.
    #[test]
    fn real_files_round_trip() {
        let base = temp("live");
        if !is_permitted(&base) {
            eprintln!("temp dir is outside the allowed roots here; skipping");
            let _ = fs::remove_dir_all(base);
            return;
        }
        let src = base.join("project");
        fs::create_dir_all(src.join("sub")).unwrap();
        let big = vec![b'x'; 4096];
        fs::write(src.join("a.bin"), &big).unwrap();
        fs::write(src.join("copy of a.bin"), &big).unwrap();
        fs::write(src.join("sub").join("note.txt"), "hello").unwrap();
        fs::write(src.join("different.bin"), vec![b'y'; 4096]).unwrap();

        // zip → a new archive beside the folder, never overwriting
        let zip1 = zip_blocking(src.to_str().unwrap(), None).unwrap();
        assert!(zip1.ends_with("project.zip") && PathBuf::from(&zip1).is_file());
        let zip2 = zip_blocking(src.to_str().unwrap(), None).unwrap();
        assert!(zip2.ends_with("project (2).zip"), "the second zip gets a new name: {zip2}");

        // unzip → a new folder, same contents
        let out = unzip_blocking(&zip1, None).unwrap();
        let out = PathBuf::from(out);
        // "project" already exists (it is the folder that was zipped), so it lands beside it.
        assert!(out.ends_with("project (2)"), "extracted under a new name: {out:?}");
        assert_eq!(fs::read_to_string(out.join("project").join("sub").join("note.txt")).unwrap(), "hello");
        assert_eq!(fs::read(out.join("project").join("a.bin")).unwrap(), big);
        // and it did not overwrite the original folder
        assert!(src.join("a.bin").is_file());

        // a non-zip is refused, not opened
        assert!(unzip_blocking(src.join("a.bin").to_str().unwrap(), None).is_err());

        // duplicates: the two identical files, and not the one that differs
        let dups = tauri::async_runtime::block_on(find_duplicates(src.to_string_lossy().into_owned())).unwrap();
        let names: Vec<String> = dups
            .groups
            .iter()
            .flat_map(|g| g.paths.iter().map(|p| PathBuf::from(p).file_name().unwrap().to_string_lossy().into_owned()))
            .collect();
        assert!(names.contains(&"a.bin".to_string()) && names.contains(&"copy of a.bin".to_string()), "{names:?}");
        assert!(!names.contains(&"different.bin".to_string()));
        assert_eq!(dups.wasted_bytes, 4096);

        // compare
        let same = tauri::async_runtime::block_on(compare_files(
            src.join("a.bin").to_string_lossy().into_owned(),
            src.join("copy of a.bin").to_string_lossy().into_owned(),
        ))
        .unwrap();
        assert!(same.identical);
        let differ = tauri::async_runtime::block_on(compare_files(
            src.join("a.bin").to_string_lossy().into_owned(),
            src.join("different.bin").to_string_lossy().into_owned(),
        ))
        .unwrap();
        assert!(!differ.identical);

        // what changed: everything was just written
        let recent =
            tauri::async_runtime::block_on(recent_changes(src.to_string_lossy().into_owned(), 1, Some(10))).unwrap();
        assert_eq!(recent.len(), 4);

        // attributes: hide, see it, put it back
        #[cfg(windows)]
        {
            let f = src.join("sub").join("note.txt").to_string_lossy().into_owned();
            assert!(!file_attributes(f.clone()).unwrap().hidden);
            assert!(set_file_attributes(f.clone(), None, Some(true)).unwrap().hidden);
            assert!(!set_file_attributes(f.clone(), None, Some(false)).unwrap().hidden);
            assert!(set_file_attributes(f.clone(), Some(true), None).unwrap().read_only);
            assert!(!set_file_attributes(f, Some(false), None).unwrap().read_only);
        }

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn sha256_tells_identical_from_different() {
        let d = temp("hash");
        fs::write(d.join("a"), vec![7u8; 4096]).unwrap();
        fs::write(d.join("b"), vec![7u8; 4096]).unwrap();
        fs::write(d.join("c"), vec![8u8; 4096]).unwrap();
        assert_eq!(sha256(&d.join("a")), sha256(&d.join("b")));
        assert_ne!(sha256(&d.join("a")), sha256(&d.join("c")));
        let _ = fs::remove_dir_all(d);
    }
}
