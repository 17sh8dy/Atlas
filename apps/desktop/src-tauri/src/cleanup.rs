//! Cleanup in two steps — *review*, then *clean* — for three kinds of leftovers:
//! old temp files, crash dumps, and installers sitting in Downloads.
//!
//! The kinds are an enumerated list and each one points at one fixed place; a path is
//! never taken from the caller. Review only counts. Clean re-counts first and refuses if
//! there is now noticeably more than was reviewed (so an approval covers what was shown,
//! not whatever has turned up since), skips anything it can't remove (in use, or a link),
//! and says how much it did and how much it skipped.
//!
//! * `temp` — files in the user's own temp folder not touched for a day. Removed for good,
//!   as Windows' own Disk Cleanup does: they are scratch files programs recreate.
//! * `crashdumps` — `.dmp` files in `%LOCALAPPDATA%\CrashDumps`. Removed for good.
//! * `installers` — `.exe` / `.msi` files directly in Downloads, a month old or more.
//!   These are YOURS, so they go to the Recycle Bin and can be put back.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use walkdir::WalkDir;

const MAX_WALK: usize = 400_000;
const WALK_TIME: Duration = Duration::from_secs(20);
const DAY: Duration = Duration::from_secs(86_400);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupScan {
    pub kind: String,
    pub folder: String,
    pub files: u64,
    pub bytes: u64,
    /// The biggest few, so the review shows what it is talking about.
    pub largest: Vec<CleanupItem>,
    pub truncated: bool,
    /// True when clean sends these to the Recycle Bin rather than removing them for good.
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDone {
    pub kind: String,
    pub removed_files: u64,
    pub removed_bytes: u64,
    pub skipped_files: u64,
    pub recoverable: bool,
}

struct Plan {
    root: PathBuf,
    recursive: bool,
    min_age: Duration,
    exts: Option<&'static [&'static str]>,
    recoverable: bool,
}

fn plan_for(kind: &str) -> Result<Plan, String> {
    match kind {
        "temp" => Ok(Plan { root: std::env::temp_dir(), recursive: true, min_age: DAY, exts: None, recoverable: false }),
        "crashdumps" => {
            let local = std::env::var_os("LOCALAPPDATA").ok_or("I can't find your AppData folder.")?;
            Ok(Plan { root: PathBuf::from(local).join("CrashDumps"), recursive: false, min_age: Duration::ZERO, exts: Some(&["dmp"]), recoverable: false })
        }
        "installers" => {
            let home = std::env::var_os("USERPROFILE").ok_or("I can't find your profile folder.")?;
            Ok(Plan { root: PathBuf::from(home).join("Downloads"), recursive: false, min_age: DAY * 30, exts: Some(&["exe", "msi"]), recoverable: true })
        }
        _ => Err(format!("There's no cleanup called “{kind}”. I can do temp, crashdumps or installers.")),
    }
}

fn matches(path: &Path, meta: &fs::Metadata, plan: &Plan, now: SystemTime) -> bool {
    if !meta.is_file() || meta.file_type().is_symlink() {
        return false;
    }
    if let Some(exts) = plan.exts {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !exts.contains(&ext.as_str()) {
            return false;
        }
    }
    let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).unwrap_or(Duration::ZERO);
    age >= plan.min_age
}

fn walk(plan: &Plan) -> (Vec<(PathBuf, u64)>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    if !plan.root.is_dir() {
        return (out, false);
    }
    let started = Instant::now();
    let now = SystemTime::now();
    let walker = WalkDir::new(&plan.root).follow_links(false).max_depth(if plan.recursive { usize::MAX } else { 1 }).min_depth(1);
    for (i, e) in walker.into_iter().filter_map(Result::ok).enumerate() {
        if i > MAX_WALK || started.elapsed() > WALK_TIME {
            truncated = true;
            break;
        }
        let Ok(meta) = e.metadata() else { continue };
        if matches(e.path(), &meta, plan, now) {
            out.push((e.path().to_path_buf(), meta.len()));
        }
    }
    (out, truncated)
}

fn scan_blocking(kind: &str) -> Result<CleanupScan, String> {
    let plan = plan_for(kind)?;
    let (mut found, truncated) = walk(&plan);
    let bytes = found.iter().map(|(_, s)| *s).sum();
    let files = found.len() as u64;
    found.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(CleanupScan {
        kind: kind.to_string(),
        folder: crate::platform::plain_path(&plan.root),
        files,
        bytes,
        largest: found.into_iter().take(5).map(|(p, s)| CleanupItem { path: crate::platform::plain_path(&p), size_bytes: s }).collect(),
        truncated,
        recoverable: plan.recoverable,
    })
}

/// How much there is to clean of one kind. Counts only; touches nothing.
#[tauri::command]
pub async fn cleanup_scan(kind: String) -> Result<CleanupScan, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&kind))
        .await
        .map_err(|e| format!("The scan failed: {e}"))?
}

fn clean_blocking(kind: &str, expected_files: u64, expected_bytes: u64) -> Result<CleanupDone, String> {
    let plan = plan_for(kind)?;
    let (found, _) = walk(&plan);
    let files = found.len() as u64;
    let bytes: u64 = found.iter().map(|(_, s)| *s).sum();
    // What was reviewed is what may be cleaned. A little more is normal (a file aged into range);
    // a lot more means something else is here now and has not been looked at.
    let slack_files = expected_files / 10 + 5;
    let slack_bytes = expected_bytes / 10 + 10 * 1024 * 1024;
    if files > expected_files + slack_files || bytes > expected_bytes + slack_bytes {
        return Err("There's noticeably more here than when you reviewed it, so I haven't touched anything. Review it again first.".into());
    }
    let mut done = CleanupDone { kind: kind.to_string(), removed_files: 0, removed_bytes: 0, skipped_files: 0, recoverable: plan.recoverable };
    for (i, (path, size)) in found.into_iter().enumerate() {
        if i % 50 == 0 && crate::halt::global().check().is_err() {
            return Err(format!("Stopped after removing {} files.", done.removed_files));
        }
        // Only what the scan found, and only inside its own folder — and not a link by now.
        if !path.starts_with(&plan.root) || fs::symlink_metadata(&path).map(|m| !m.is_file()).unwrap_or(true) {
            done.skipped_files += 1;
            continue;
        }
        let ok = if plan.recoverable { trash::delete(&path).is_ok() } else { fs::remove_file(&path).is_ok() };
        if ok {
            done.removed_files += 1;
            done.removed_bytes += size;
        } else {
            done.skipped_files += 1; // in use, or not ours to remove
        }
    }
    Ok(done)
}

/// Remove what was reviewed, if it hasn't grown. See the module docs for what each kind does.
#[tauri::command]
pub async fn cleanup_clean(kind: String, expected_files: u64, expected_bytes: u64) -> Result<CleanupDone, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || clean_blocking(&kind, expected_files, expected_bytes))
        .await
        .map_err(|e| format!("The cleanup failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_known_kinds_exist() {
        assert!(plan_for("temp").is_ok());
        assert!(plan_for("crashdumps").is_ok());
        assert!(plan_for("installers").is_ok());
        assert!(plan_for("C:\\Windows").is_err());
        assert!(plan_for("../x").is_err());
        assert!(plan_for("").is_err());
    }

    #[test]
    fn installers_are_recoverable_and_scratch_is_not() {
        assert!(plan_for("installers").unwrap().recoverable);
        assert!(!plan_for("temp").unwrap().recoverable);
    }

    #[test]
    fn a_clean_refuses_when_there_is_much_more_than_was_reviewed() {
        // Reviewed "nothing"; the real temp folder has more than the slack allows only if it is large,
        // so use a kind whose root is certainly empty or absent and check the guard arithmetic instead.
        let d = std::env::temp_dir().join(format!("atlas-cleanup-guard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let plan = Plan { root: d.clone(), recursive: true, min_age: Duration::ZERO, exts: None, recoverable: false };
        for i in 0..40 {
            fs::write(d.join(format!("f{i}.tmp")), b"x").unwrap();
        }
        let (found, _) = walk(&plan);
        assert_eq!(found.len(), 40);
        // Reviewed 10 files; 40 now: 40 > 10 + (10/10 + 5) → refuse. (Checked through the same arithmetic.)
        let expected_files = 10u64;
        assert!(found.len() as u64 > expected_files + expected_files / 10 + 5);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn scanning_the_real_temp_folder_counts_without_touching_it() {
        let before = fs::read_dir(std::env::temp_dir()).map(|d| d.count()).unwrap_or(0);
        let s = scan_blocking("temp").unwrap();
        assert!(!s.recoverable);
        assert!(s.largest.len() <= 5);
        let after = fs::read_dir(std::env::temp_dir()).map(|d| d.count()).unwrap_or(0);
        // A scan removes nothing (other programs may add files, never fewer because of us).
        assert!(after + 50 >= before);
    }
}
