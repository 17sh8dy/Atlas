//! Everyday Windows settings, one named operation each: wallpaper, mouse
//! speed, file extensions and hidden files in Explorer, Do Not Disturb,
//! restarting Explorer, the Wi-Fi and Bluetooth radios, and what is playing.
//!
//! As everywhere in this program: a direct Win32/WinRT call with an
//! *enumerated or range-checked* argument, never a command line. The registry
//! writes are to fixed keys under the user's own hive (no elevation), the
//! value names are compile-time constants, and the only thing a caller chooses
//! is on/off or a number in a clamped range.

#![cfg(windows)]

use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_DWORD, REG_OPTION_NON_VOLATILE, RRF_RT_REG_DWORD,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, SystemParametersInfoW, HWND_BROADCAST, SMTO_ABORTIFHUNG,
    SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETMOUSESPEED, SPI_SETDESKWALLPAPER, SPI_SETMOUSESPEED,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_SETTINGCHANGE,
};

use crate::platform::is_permitted;

// ---- a DWORD in the user's registry, by fixed key -------------------------------------

fn read_dword(subkey: PCWSTR, name: PCWSTR) -> Option<u32> {
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey,
            name,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    rc.is_ok().then_some(value)
}

fn write_dword(subkey: PCWSTR, name: PCWSTR, value: u32) -> Result<(), String> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey,
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
        .ok()
        .map_err(|e| e.message())?;
        let r = RegSetValueExW(key, name, 0, REG_DWORD, Some(&value.to_le_bytes()))
            .ok()
            .map_err(|e| e.message());
        let _ = RegCloseKey(key);
        r
    }
}

fn announce_setting(area: PCWSTR) {
    let mut ignored = 0usize;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(area.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            3000,
            Some(&mut ignored),
        );
    }
}

// ---- wallpaper -------------------------------------------------------------------------

/// Set the desktop wallpaper to an image inside the folders Atlas may touch.
#[tauri::command]
pub fn set_wallpaper(path: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That image is outside the folders Atlas can touch.".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
        return Err("A wallpaper has to be a .jpg, .png or .bmp picture.".into());
    }
    if !p.is_file() {
        return Err("That picture isn't there.".into());
    }
    let canonical = p.canonicalize().map_err(|e| e.to_string())?;
    let mut wide: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    // `\\?\C:\…` is fine for the file system and not for the wallpaper API.
    if wide.starts_with(&[92, 92, 63, 92]) {
        wide.drain(..4);
    }
    wide.push(0);
    unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(wide.as_mut_ptr() as *mut _),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    }
    .map_err(|e| e.message())?;
    Ok(true)
}

// ---- mouse speed -------------------------------------------------------------------------

#[tauri::command]
pub fn mouse_speed() -> Result<u32, String> {
    let mut v: u32 = 0;
    unsafe {
        SystemParametersInfoW(
            SPI_GETMOUSESPEED,
            0,
            Some(&mut v as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .map_err(|e| e.message())?;
    Ok(v)
}

/// 1 (slowest) to 20 (fastest); 10 is Windows' default.
#[tauri::command]
pub fn set_mouse_speed(speed: u32) -> Result<u32, String> {
    crate::halt::global().check()?;
    if !(1..=20).contains(&speed) {
        return Err("Mouse speed is between 1 and 20.".into());
    }
    unsafe {
        SystemParametersInfoW(
            SPI_SETMOUSESPEED,
            0,
            Some(speed as usize as *mut _),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    }
    .map_err(|e| e.message())?;
    mouse_speed()
}

// ---- Explorer options ------------------------------------------------------------------------

const EXPLORER_ADVANCED: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced");

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerOptions {
    pub file_extensions: bool,
    pub hidden_files: bool,
}

#[tauri::command]
pub fn explorer_options() -> ExplorerOptions {
    ExplorerOptions {
        // HideFileExt: 0 means the extensions ARE shown.
        file_extensions: read_dword(EXPLORER_ADVANCED, w!("HideFileExt")) == Some(0),
        // Hidden: 1 shows hidden files, 2 does not.
        hidden_files: read_dword(EXPLORER_ADVANCED, w!("Hidden")) == Some(1),
    }
}

/// `which` is "file-extensions" or "hidden-files"; `show` is what the person wants.
#[tauri::command]
pub fn set_explorer_option(which: String, show: bool) -> Result<ExplorerOptions, String> {
    crate::halt::global().check()?;
    match which.as_str() {
        "file-extensions" => write_dword(EXPLORER_ADVANCED, w!("HideFileExt"), if show { 0 } else { 1 })?,
        "hidden-files" => write_dword(EXPLORER_ADVANCED, w!("Hidden"), if show { 1 } else { 2 })?,
        _ => return Err(format!("Explorer has no option called “{which}” that I change.")),
    }
    announce_setting(w!("ShellState"));
    Ok(explorer_options())
}

/// Restart Explorer — the taskbar, Start menu and file windows. Windows brings
/// the shell straight back by itself. Open File Explorer windows close.
#[tauri::command]
pub fn restart_explorer() -> Result<u32, String> {
    crate::halt::global().check()?;
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut ended = 0;
    for p in sys.processes().values() {
        if p.name().to_string_lossy().eq_ignore_ascii_case("explorer.exe") && p.kill() {
            ended += 1;
        }
    }
    if ended == 0 {
        return Err("I couldn't find Explorer to restart.".into());
    }
    Ok(ended)
}

// ---- Do Not Disturb ---------------------------------------------------------------------------

const NOTIFICATION_SETTINGS: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings");

/// True when notification banners are off (Windows' Do Not Disturb).
#[tauri::command]
pub fn do_not_disturb() -> bool {
    read_dword(NOTIFICATION_SETTINGS, w!("NOC_GLOBAL_SETTING_TOASTS_ENABLED")) == Some(0)
}

#[tauri::command]
pub fn set_do_not_disturb(on: bool) -> Result<bool, String> {
    crate::halt::global().check()?;
    write_dword(NOTIFICATION_SETTINGS, w!("NOC_GLOBAL_SETTING_TOASTS_ENABLED"), if on { 0 } else { 1 })?;
    announce_setting(w!("WindowsNotification"));
    Ok(do_not_disturb())
}

// ---- radios (Wi-Fi, Bluetooth) ------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct RadioInfo {
    /// "wifi", "bluetooth", or "other".
    pub kind: String,
    pub name: String,
    pub on: bool,
}

fn kind_word(k: RadioKind) -> &'static str {
    if k == RadioKind::WiFi {
        "wifi"
    } else if k == RadioKind::Bluetooth {
        "bluetooth"
    } else {
        "other"
    }
}

fn access() -> Result<(), String> {
    let status = Radio::RequestAccessAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Windows wouldn't let me look at the radios: {}", e.message()))?;
    if status == RadioAccessStatus::Allowed {
        Ok(())
    } else {
        Err("Windows has denied radio access to apps — it can be allowed in Settings → Privacy.".into())
    }
}

#[tauri::command]
pub async fn radios() -> Result<Vec<RadioInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        access()?;
        let list = Radio::GetRadiosAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.message())?;
        Ok(list
            .into_iter()
            .map(|r| RadioInfo {
                kind: kind_word(r.Kind().unwrap_or(RadioKind::Other)).to_string(),
                name: r.Name().map(|n| n.to_string()).unwrap_or_default(),
                on: r.State().map(|s| s == RadioState::On).unwrap_or(false),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Reading the radios failed: {e}"))?
}

/// Turn every radio of one kind on or off. `kind` is "wifi" or "bluetooth".
#[tauri::command]
pub async fn set_radio(kind: String, on: bool) -> Result<Vec<RadioInfo>, String> {
    crate::halt::global().check()?;
    let want = match kind.as_str() {
        "wifi" => RadioKind::WiFi,
        "bluetooth" => RadioKind::Bluetooth,
        _ => return Err(format!("I only switch Wi-Fi and Bluetooth, not “{kind}”.")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        access()?;
        let list = Radio::GetRadiosAsync().and_then(|op| op.get()).map_err(|e| e.message())?;
        let mut touched = 0;
        for r in list {
            if r.Kind().map(|k| k == want).unwrap_or(false) {
                let state = if on { RadioState::On } else { RadioState::Off };
                let result = r.SetStateAsync(state).and_then(|op| op.get()).map_err(|e| e.message())?;
                if result != RadioAccessStatus::Allowed {
                    return Err("Windows wouldn't let me change that.".to_string());
                }
                touched += 1;
            }
        }
        if touched == 0 {
            return Err(format!("This PC has no {} radio.", if kind == "wifi" { "Wi-Fi" } else { "Bluetooth" }));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Changing the radio failed: {e}"))??;
    radios().await
}

// ---- what is playing ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing", "paused", "stopped" or "other".
    pub status: String,
    /// The app's own identifier, e.g. "Spotify.exe".
    pub app: String,
    pub shuffle: Option<bool>,
}

/// What the system's media session (the one the volume flyout shows) is playing,
/// or `None` when nothing is.
#[tauri::command]
pub async fn now_playing() -> Result<Option<NowPlaying>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.message())?;
        let Ok(session) = mgr.GetCurrentSession() else { return Ok(None) };
        let props = session
            .TryGetMediaPropertiesAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.message())?;
        let info = session.GetPlaybackInfo().map_err(|e| e.message())?;
        let status = match info.PlaybackStatus() {
            Ok(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing) => "playing",
            Ok(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused) => "paused",
            Ok(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped) => "stopped",
            _ => "other",
        };
        let shuffle = info.IsShuffleActive().ok().and_then(|r| r.Value().ok());
        let text = |r: windows::core::Result<windows::core::HSTRING>| r.map(|h| h.to_string()).unwrap_or_default();
        let title = text(props.Title());
        if title.is_empty() && status == "other" {
            return Ok(None);
        }
        Ok(Some(NowPlaying {
            title,
            artist: text(props.Artist()),
            album: text(props.AlbumTitle()),
            status: status.to_string(),
            app: text(session.SourceAppUserModelId()),
            shuffle,
        }))
    })
    .await
    .map_err(|e| format!("Reading what's playing failed: {e}"))?
}

/// Turn shuffle on or off in whatever is playing.
#[tauri::command]
pub async fn set_shuffle(on: bool) -> Result<bool, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
            .map_err(|e| e.message())?;
        let session = mgr.GetCurrentSession().map_err(|_| "Nothing is playing.".to_string())?;
        session
            .TryChangeShuffleActiveAsync(on)
            .and_then(|op| op.get())
            .map_err(|e| e.message())
    })
    .await
    .map_err(|e| format!("Changing shuffle failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_options_read_without_error() {
        let o = explorer_options();
        eprintln!("file extensions shown: {}, hidden files shown: {}", o.file_extensions, o.hidden_files);
    }

    #[test]
    fn mouse_speed_reads_in_range() {
        let s = mouse_speed().unwrap();
        assert!((1..=20).contains(&s), "speed {s}");
    }

    #[test]
    fn out_of_range_and_unknown_are_refused_before_anything_changes() {
        assert!(set_mouse_speed(0).is_err());
        assert!(set_mouse_speed(21).is_err());
        assert!(set_explorer_option("taskbar".into(), true).is_err());
        assert!(set_wallpaper("C:\\definitely\\not\\allowed.png".into()).is_err());
    }

    /// Live round trip, each setting put back as found. Run on purpose:
    /// `cargo test --lib live_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn live_round_trip_restores_everything() {
        let speed = mouse_speed().unwrap();
        assert_eq!(set_mouse_speed(speed).unwrap(), speed);

        let before = explorer_options();
        let after = set_explorer_option("file-extensions".into(), !before.file_extensions).unwrap();
        assert_eq!(after.file_extensions, !before.file_extensions);
        let back = set_explorer_option("file-extensions".into(), before.file_extensions).unwrap();
        assert_eq!(back.file_extensions, before.file_extensions);
        let hid = set_explorer_option("hidden-files".into(), !before.hidden_files).unwrap();
        assert_eq!(hid.hidden_files, !before.hidden_files);
        let back = set_explorer_option("hidden-files".into(), before.hidden_files).unwrap();
        assert_eq!(back.hidden_files, before.hidden_files);

        let dnd = do_not_disturb();
        assert_eq!(set_do_not_disturb(!dnd).unwrap(), !dnd);
        assert_eq!(set_do_not_disturb(dnd).unwrap(), dnd);
        eprintln!("mouse {speed}, explorer {before:?}, dnd {dnd} — all restored");
    }

    #[test]
    fn dnd_reads() {
        eprintln!("do not disturb: {}", do_not_disturb());
    }

    /// Live, read-only: lists the radios and what is playing, if anything.
    #[test]
    fn radios_and_now_playing_read() {
        let rt = tauri::async_runtime::block_on(async {
            (radios().await, now_playing().await)
        });
        eprintln!("radios: {:?}\nnow playing: {:?}", rt.0, rt.1);
    }
}
