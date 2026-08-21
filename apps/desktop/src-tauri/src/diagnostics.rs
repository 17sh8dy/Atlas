//! A place for the app to write down what went wrong.
//!
//! ## Why this exists
//!
//! Twice now a feature has failed in a way that looked like success: speech
//! synthesised audio nobody could hear, and the microphone opened onto
//! nothing. Both times the error existed — it was just somewhere no one could
//! read it, because the only channel from the webview to a person is a UI that
//! renders after the failure has already been swallowed.
//!
//! So there is a second channel that does not depend on anything rendering.
//! An append-only line of text on disk, written by the same code paths that
//! set the on-screen message, readable while the app is still running and
//! after it has closed.
//!
//! ## What it is not
//!
//! Not telemetry: it never leaves the machine, and nothing reads it back. Not
//! a logging framework: one function, one file, no levels, no rotation beyond
//! a size cap. It is a note the app leaves for whoever is looking into a
//! problem, which is usually the person the problem happened to.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Where the note is left. Predictable rather than clever — a path someone can
/// be told over a message and paste into Explorer.
pub fn log_path() -> PathBuf {
    std::env::temp_dir().join("atlas-diagnostics.log")
}

/// Past this, the file is started over rather than grown.
///
/// A diagnostics file that fills a disk is a worse bug than the one it was
/// written to catch, and the interesting lines are always the recent ones.
const MAX_BYTES: u64 = 512 * 1024;

pub fn record(scope: &str, message: &str) {
    let path = log_path();
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = fs::remove_file(&path);
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Newlines are flattened so one event is always one line — a message that
    // wraps turns a grep into a puzzle.
    let flattened = message.replace(['\n', '\r'], " ");

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{stamp}] {scope}: {flattened}");
    }
}

/// Write a line from the renderer.
///
/// Deliberately narrow: a scope and a message, both plain strings, both
/// truncated. The renderer cannot choose the file, cannot clear it, and cannot
/// make an entry big enough to matter.
#[tauri::command]
pub fn log_diagnostic(scope: String, message: String) {
    let scope: String = scope.chars().take(40).collect();
    let message: String = message.chars().take(2000).collect();
    record(&scope, &message);
}

/// Hand the log back, so it can be shown in Settings without a file manager.
#[tauri::command]
pub fn read_diagnostics() -> String {
    fs::read_to_string(log_path()).unwrap_or_default()
}
