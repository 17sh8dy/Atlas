//! Native OS controls — the machine itself, not its files.
//!
//! Everything here is a direct Win32 call rather than a shelled-out command,
//! for the same reason the rest of `platform.rs` is: there is no `exec` in this
//! program, so every capability has to be a named, argument-validated command
//! that can be read and reasoned about. `powershell -c "..."` would have been
//! shorter and would have handed the renderer a general-purpose shell.
//!
//! Each command takes an *enumerated* argument, never a raw code or flag — a
//! caller can ask for "restart", not for an arbitrary `ExitWindowsEx` bitmask.
//! The destructive ones are gated a second time on the TypeScript side, where
//! they are declared `risk: 'confirm'` and have to be approved in the UI.

#![cfg(windows)]

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Shutdown::{
    ExitWindowsEx, LockWorkStation, EWX_LOGOFF, EWX_REBOOT, EWX_SHUTDOWN, SHUTDOWN_REASON,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE,
    VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
};
use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND,
};

/// Tap a virtual key. Used for the media and volume keys, which Windows routes
/// to whatever currently owns playback — the same path the keys on a keyboard
/// take, so it works with whatever app is playing without Atlas knowing about
/// any of them.
fn tap(key: u16) {
    unsafe {
        keybd_event(key as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(key as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

#[tauri::command]
pub fn lock_workstation() -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    unsafe { LockWorkStation() }.map_err(|e| e.message())?;
    Ok(true)
}

/// Shutdown and restart need SeShutdownPrivilege, which a process has but does
/// not have *enabled* by default. Enabling it for our own token is the
/// documented path; it grants nothing a user couldn't do from the Start menu.
fn enable_shutdown_privilege() -> Result<(), String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .map_err(|e| e.message())?;

        let mut luid = Default::default();
        LookupPrivilegeValueW(
            PCWSTR::null(),
            windows::core::w!("SeShutdownPrivilege"),
            &mut luid,
        )
        .map_err(|e| e.message())?;

        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None)
            .map_err(|e| e.message())?;
        Ok(())
    }
}

#[tauri::command]
pub fn power_action(action: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    // An enum, not a flag: the caller cannot compose an ExitWindowsEx bitmask.
    let flags = match action.as_str() {
        "shutdown" => EWX_SHUTDOWN,
        "restart" => EWX_REBOOT,
        "sign-out" => EWX_LOGOFF,
        _ => return Err(format!("No power action called “{action}”.")),
    };

    if action != "sign-out" {
        enable_shutdown_privilege()?;
    }
    // SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | PLANNED.
    unsafe { ExitWindowsEx(flags, SHUTDOWN_REASON(0x8000_0000 | 0x0000_0000)) }
        .map_err(|e| e.message())?;
    Ok(true)
}

#[tauri::command]
pub fn media_key(key: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let vk = match key.as_str() {
        "play-pause" => VK_MEDIA_PLAY_PAUSE,
        "next" => VK_MEDIA_NEXT_TRACK,
        "previous" => VK_MEDIA_PREV_TRACK,
        "stop" => VK_MEDIA_STOP,
        _ => return Err(format!("No media key called “{key}”.")),
    };
    tap(vk.0);
    Ok(true)
}

#[tauri::command]
pub fn set_volume(direction: String, steps: Option<u8>) -> Result<bool, String> {
    crate::halt::global().check()?;
    let vk = match direction.as_str() {
        "up" => VK_VOLUME_UP,
        "down" => VK_VOLUME_DOWN,
        _ => return Err(format!("Volume can go up or down, not “{direction}”.")),
    };
    // Each tap is one notch (2% on a default Windows install), and the count is
    // clamped so a bad argument can't hold the key down forever.
    for _ in 0..steps.unwrap_or(5).clamp(1, 50) {
        tap(vk.0);
    }
    Ok(true)
}

#[tauri::command]
pub fn toggle_mute() -> Result<bool, String> {
    crate::halt::global().check()?;
    tap(VK_VOLUME_MUTE.0);
    Ok(true)
}

#[tauri::command]
pub fn display_off() -> Result<bool, String> {
    crate::halt::global().check()?;
    // 2 = power off. Broadcast, because the message goes to the display driver
    // rather than to any particular window.
    unsafe {
        SendMessageW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            WPARAM(SC_MONITORPOWER as usize),
            LPARAM(2),
        );
    }
    Ok(true)
}

#[tauri::command]
pub fn empty_recycle_bin() -> Result<bool, String> {
    crate::halt::global().check()?;
    // No confirmation dialog from the shell: Atlas has already asked, in its
    // own words, through the `risk: 'confirm'` path. Two prompts for one
    // action is how people learn to click through prompts.
    unsafe {
        SHEmptyRecycleBinW(
            HWND::default(),
            PCWSTR::null(),
            SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI,
        )
    }
    .map_err(|e| e.message())?;
    Ok(true)
}
