//! Launch at Windows startup, start hidden, and what closing the window does.
//!
//! ── Launch at startup ─────────────────────────────────────────────────────────────────────────────────
//! A single value, `Atlas`, under the current user's `Run` key (`HKCU\Software\Microsoft\Windows\
//! CurrentVersion\Run`): no service, no scheduled task, no administrator rights, nothing outside the user's
//! own profile, and removing it is one click in Settings (or Task Manager → Startup apps). The value is
//! `"<this exe>" --background`, and `--background` makes Atlas start with its window hidden, reachable from
//! the tray icon and Ctrl+Space, instead of putting a window in front of someone who has just signed in.
//!
//! It is OFF unless the person switches it on, and `set_startup` verifies by READING THE VALUE BACK: it
//! reports success only if the registry now holds what was asked for, so the switch in Settings is a fact and
//! not a hope. A value that points at some other copy of Atlas (an old install, a dev build) is reported as
//! such rather than as "on".
//!
//! ── Closing the window ────────────────────────────────────────────────────────────────────────────────
//! By default closing the window puts Atlas away and keeps it resident (that is what the tray icon and the
//! summon key are for). `set_quit_on_close(true)` makes the close button quit instead. The setting lives with
//! the person's other preferences; the renderer tells this side whenever it loads or changes, and the value is
//! held in memory only (a stale native copy would be worse than none: it defaults to "stay resident", today's
//! behaviour, until the renderer says otherwise).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Atlas";
/// The argument the startup entry passes, and the one the app looks for to stay out of sight.
pub const BACKGROUND_ARG: &str = "--background";

static QUIT_ON_CLOSE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// The value exists and starts THIS copy of Atlas.
    pub enabled: bool,
    /// The value exists but starts something else (an old install, a dev build).
    pub points_elsewhere: bool,
    /// What the registry holds, for display. None when there is no value.
    pub command: Option<String>,
}

/// What the entry should hold for this copy of Atlas.
fn wanted_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Atlas could not find its own program ({e})."))?;
    Ok(format!("\"{}\" {}", exe.display(), BACKGROUND_ARG))
}

/// Compare what the registry holds with what this copy would write. Case-insensitive on Windows paths.
fn same_command(held: &str, wanted: &str) -> bool {
    held.trim().eq_ignore_ascii_case(wanted.trim())
}

fn read_value() -> Option<String> {
    let run = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ).ok()?;
    run.get_value::<String, _>(VALUE_NAME).ok()
}

fn status_from(held: Option<String>, wanted: &str) -> StartupStatus {
    match held {
        None => StartupStatus { enabled: false, points_elsewhere: false, command: None },
        Some(cmd) => {
            let ours = same_command(&cmd, wanted);
            StartupStatus { enabled: ours, points_elsewhere: !ours, command: Some(cmd) }
        }
    }
}

#[tauri::command]
pub fn startup_status() -> Result<StartupStatus, String> {
    Ok(status_from(read_value(), &wanted_command()?))
}

/// Switch launch-at-startup on or off, then read the registry back and report what is really there.
#[tauri::command]
pub fn set_startup(enabled: bool) -> Result<StartupStatus, String> {
    crate::halt::global().check()?;
    let wanted = wanted_command()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enabled {
        let (run, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| format!("Windows would not let Atlas add itself to startup ({e})."))?;
        run.set_value(VALUE_NAME, &wanted).map_err(|e| format!("Windows would not let Atlas add itself to startup ({e})."))?;
    } else if let Ok(run) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE | KEY_READ) {
        // Absent is the goal, so "not there" is not an error.
        let _ = run.delete_value(VALUE_NAME);
    }
    let after = status_from(read_value(), &wanted);
    if enabled && !after.enabled {
        return Err("Atlas wrote the startup entry but could not read it back, so it can't promise it is on.".into());
    }
    if !enabled && after.command.is_some() {
        return Err("Atlas tried to remove its startup entry but it is still there.".into());
    }
    Ok(after)
}

/// The renderer reports the person's choice: does the close button quit (true) or put Atlas away (false)?
#[tauri::command]
pub fn set_quit_on_close(quit: bool) {
    QUIT_ON_CLOSE.store(quit, Ordering::SeqCst);
}

/// Read by the window's close handler.
pub fn quit_on_close() -> bool {
    QUIT_ON_CLOSE.load(Ordering::SeqCst)
}

/// True when this launch came from the startup entry (or someone passed the flag): stay out of sight.
pub fn started_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_runs_this_program_hidden() {
        let cmd = wanted_command().unwrap();
        assert!(cmd.starts_with('"'), "the path is quoted so a space in it cannot split the command: {cmd}");
        assert!(cmd.ends_with(" --background"), "{cmd}");
    }

    #[test]
    fn nothing_held_means_off() {
        let s = status_from(None, "\"C:\\Atlas\\atlas-desktop.exe\" --background");
        assert!(!s.enabled && !s.points_elsewhere && s.command.is_none());
    }

    #[test]
    fn a_matching_entry_means_on_regardless_of_case() {
        let want = "\"C:\\Program Files\\Atlas\\atlas-desktop.exe\" --background";
        let s = status_from(Some("\"c:\\program files\\atlas\\ATLAS-DESKTOP.exe\" --background".into()), want);
        assert!(s.enabled && !s.points_elsewhere);
    }

    #[test]
    fn an_entry_for_another_copy_is_reported_as_elsewhere_not_as_on() {
        let want = "\"C:\\Atlas\\atlas-desktop.exe\" --background";
        let s = status_from(Some("\"D:\\old\\atlas-desktop.exe\" --background".into()), want);
        assert!(!s.enabled && s.points_elsewhere);
        assert_eq!(s.command.as_deref(), Some("\"D:\\old\\atlas-desktop.exe\" --background"));
    }

    /// Touches the REAL Run key of whoever runs it, so it is ignored by default: `cargo test -- --ignored startup`.
    /// Refuses to run if an "Atlas" entry is already there (it would delete it).
    #[test]
    #[ignore]
    fn real_registry_round_trip() {
        assert!(read_value().is_none(), "an Atlas startup entry already exists; not touching it");
        let on = set_startup(true).expect("write");
        assert!(on.enabled && !on.points_elsewhere, "{on:?}");
        assert_eq!(read_value().as_deref(), Some(wanted_command().unwrap().as_str()));
        let off = set_startup(false).expect("remove");
        assert!(!off.enabled && off.command.is_none(), "{off:?}");
        assert!(read_value().is_none());
    }

    #[test]
    fn closing_stays_resident_until_the_renderer_says_otherwise() {
        assert!(!quit_on_close());
        set_quit_on_close(true);
        assert!(quit_on_close());
        set_quit_on_close(false);
        assert!(!quit_on_close());
    }
}
