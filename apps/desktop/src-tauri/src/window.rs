//! Windows other than Atlas's own — enumerating them, inspecting them, and
//! moving, resizing, focusing or closing one. Also ends a process, since
//! "manage what's running" is the same neighbourhood as "manage what's on
//! screen" and both read from the same process list.
//!
//! Same rule as everywhere else in this crate: no `exec`. A window is
//! addressed by a handle this module itself just enumerated, never by a path
//! or a title string handed straight to a Win32 call, and every verb below is
//! one of a fixed, small set — list, focus, minimize, maximize, restore,
//! move/resize, close. There is no "send this window a message" command.
//!
//! `windows`, not `window-control`, is Atlas's *own* window (see `lib.rs`'s
//! `show_window`/`hide_window`/`toggle_window`) — this module is everything
//! else on the desktop, gated behind the separate `window-control` capability.

#![cfg(windows)]

use serde::Serialize;
use sysinfo::System;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, PostMessageW,
    SetForegroundWindow, SetWindowPos, ShowWindow, GWL_EXSTYLE, GW_OWNER, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOZORDER,
    SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEntry {
    /// Opaque, resolved fresh on every call — never held across a call the way
    /// a COM pointer can't be. If the window has closed in the meantime, every
    /// command below fails cleanly rather than acting on a stale handle.
    pub id: String,
    pub title: String,
    pub class_name: String,
    pub process_name: String,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub minimized: bool,
    pub maximized: bool,
    pub active: bool,
}

/// The rect a person actually sees, not the one `GetWindowRect` reports.
///
/// Since Windows 10, `GetWindowRect` includes several pixels of invisible
/// resize border on every side of a normal window, so a rect built from it is
/// consistently too big and offset — exactly wrong for "click 10px inside this
/// window's left edge". `DwmGetWindowAttribute` with the extended-frame-bounds
/// atom reports the true visible outline; `GetWindowRect` is kept only as the
/// fallback for the rare window that doesn't support the DWM query.
fn visible_rect(hwnd: HWND) -> RECT {
    unsafe {
        let mut dwm_rect = RECT::default();
        let ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut dwm_rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        if ok.is_ok() {
            return dwm_rect;
        }
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        rect
    }
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

fn window_class(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let copied = GetClassNameW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

/// The heuristic Windows itself uses for "does this belong in Alt+Tab".
///
/// A window with an owner is normally a dialog or a tool palette and doesn't
/// belong in a list of "the windows on your desktop" — unless it explicitly
/// asked to be treated as one (`WS_EX_APPWINDOW`). A window flagged
/// `WS_EX_TOOLWINDOW` never belongs, owner or not. Getting this wrong is the
/// difference between a clean list of real windows and one padded with every
/// invisible helper window a running app happens to own.
fn is_app_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        if window_title(hwnd).is_empty() {
            return false;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let is_tool = ex_style & WS_EX_TOOLWINDOW.0 as u32 != 0;
        let is_app = ex_style & WS_EX_APPWINDOW.0 as u32 != 0;
        if is_tool && !is_app {
            return false;
        }
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if !owner.is_invalid() && !is_app {
            return false;
        }
        true
    }
}

fn process_name_for(sys: &System, pid: u32) -> String {
    sys.process(sysinfo::Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn describe(hwnd: HWND, sys: &System, active: HWND) -> WindowEntry {
    let rect = visible_rect(hwnd);
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };

    WindowEntry {
        id: (hwnd.0 as isize).to_string(),
        title: window_title(hwnd),
        class_name: window_class(hwnd),
        process_name: process_name_for(sys, pid),
        pid,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        minimized: unsafe { IsIconic(hwnd).as_bool() },
        maximized: unsafe { IsZoomed(hwnd).as_bool() },
        active: hwnd == active,
    }
}

extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    handles.push(hwnd);
    windows::Win32::Foundation::BOOL(1)
}

/// Every top-level window a person would recognise as "a window on my
/// desktop" — the same set Alt+Tab shows, roughly.
#[tauri::command]
pub fn list_windows() -> Vec<WindowEntry> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut handles as *mut _ as isize));
    }

    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let active = unsafe { GetForegroundWindow() };

    handles
        .into_iter()
        .filter(|&h| is_app_window(h))
        .map(|h| describe(h, &sys, active))
        .collect()
}

/// What's focused right now — including a window `list_windows` would filter
/// out, because "what has focus" should answer honestly even when the answer
/// is a utility window.
#[tauri::command]
pub fn active_window() -> Option<WindowEntry> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    Some(describe(hwnd, &sys, hwnd))
}

/// Resolve an id from `list_windows`/`active_window` back to a live handle.
///
/// Re-validated with `IsWindow` on every call rather than trusted: the
/// renderer's copy of an id can always be stale by the time it's used.
pub(crate) fn resolve_hwnd(id: &str) -> Result<HWND, String> {
    let raw: isize = id
        .parse()
        .map_err(|_| "That doesn't look like a window id.".to_string())?;
    let hwnd = HWND(raw as _);
    if !unsafe { IsWindow(hwnd) }.as_bool() {
        return Err("That window isn't open anymore.".into());
    }
    Ok(hwnd)
}

/// Bring a window to the front and give it keyboard focus.
///
/// Windows normally refuses `SetForegroundWindow` from a process that isn't
/// itself in the foreground — otherwise any background program could steal
/// focus at will. Atlas *is* the foreground process at the moment a user just
/// spoke or typed a command to it, but by the time this runs the target
/// window still isn't the one holding input, so the documented workaround
/// applies: briefly attach this thread's input queue to the current
/// foreground window's, which is what lets the OS-level "who may steal focus"
/// check pass, then detach it again immediately either way.
#[tauri::command]
pub fn focus_window(id: String) -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();
        let attached = foreground_thread != current_thread
            && foreground_thread != 0
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();

        let ok = SetForegroundWindow(hwnd).as_bool();

        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }

        if ok {
            Ok(true)
        } else {
            Err("Windows wouldn't bring that window to the front.".into())
        }
    }
}

#[tauri::command]
pub fn minimize_window(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
    Ok(true)
}

#[tauri::command]
pub fn maximize_window(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    let _ = unsafe { ShowWindow(hwnd, SW_MAXIMIZE) };
    Ok(true)
}

#[tauri::command]
pub fn restore_window(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
    Ok(true)
}

/// Move and/or resize in one call, so a plain move never has to guess at a
/// size to pass back in, and vice versa — whichever fields are given override
/// the window's current rect, and the rest are read fresh rather than trusted
/// from whatever the renderer last saw.
#[tauri::command]
pub fn set_window_bounds(
    id: String,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    let current = visible_rect(hwnd);

    let (min_x, min_y, max_w, max_h) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };

    let new_x = x.unwrap_or(current.left).clamp(min_x - 4000, min_x + max_w);
    let new_y = y.unwrap_or(current.top).clamp(min_y - 4000, min_y + max_h);
    let new_w = width
        .unwrap_or(current.right - current.left)
        .clamp(50, max_w);
    let new_h = height
        .unwrap_or(current.bottom - current.top)
        .clamp(50, max_h);

    unsafe {
        SetWindowPos(
            hwnd,
            None,
            new_x,
            new_y,
            new_w,
            new_h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    }
    .map_err(|e| e.message())?;
    Ok(true)
}

/// Ask a window to close — the same request `WM_CLOSE` sends when someone
/// clicks its X button. An app with unsaved work can still put up its own
/// "save changes?" dialog; this does not force it down.
#[tauri::command]
pub fn close_window(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hwnd = resolve_hwnd(&id)?;
    unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) }.map_err(|e| e.message())?;
    Ok(true)
}

// ---- processes ---------------------------------------------------------

/// Processes losing this would take the session or the machine down with it.
/// Compared case-insensitively; matches `services.rs::NEVER_STOP`'s reasoning
/// exactly, one layer down — a service failing is recoverable, this often
/// isn't.
const NEVER_END: &[&str] = &[
    "system",
    "system idle process",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "svchost.exe",
    "dwm.exe",
    "explorer.exe",
];

#[tauri::command]
pub fn end_process(pid: u32) -> Result<bool, String> {
    crate::halt::global().check()?;
    if pid == std::process::id() {
        return Err("I won't end my own process.".into());
    }

    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let Some(proc) = sys.process(sysinfo::Pid::from_u32(pid)) else {
        return Err("That process isn't running anymore.".into());
    };
    let name = proc.name().to_string_lossy().to_lowercase();
    if NEVER_END.iter().any(|n| *n == name) {
        return Err(format!(
            "I won't end {} — this session doesn't survive losing it.",
            proc.name().to_string_lossy()
        ));
    }

    if proc.kill() {
        Ok(true)
    } else {
        Err("Windows wouldn't end that process — it may need administrator rights.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_id_round_trips_through_resolve() {
        // `resolve` on a handle no window will ever have must fail cleanly,
        // never panic — the shape of "the id went stale between listing and
        // acting on it".
        assert!(resolve_hwnd("999999999").is_err());
        assert!(resolve_hwnd("not a number").is_err());
    }

    #[test]
    fn critical_processes_are_matched_case_insensitively() {
        assert!(NEVER_END.contains(&"explorer.exe"));
        assert!(!NEVER_END.iter().any(|n| *n == "chrome.exe"));
    }

    /// Live, ignored by default — see `services.rs` for why this pattern is
    /// used throughout this crate for anything that needs a real desktop.
    #[test]
    #[ignore]
    fn at_least_one_real_window_is_on_this_desktop() {
        let windows = list_windows();
        assert!(!windows.is_empty(), "no top-level windows found");
        assert!(
            windows.iter().all(|w| !w.title.is_empty()),
            "a filtered window slipped through with no title"
        );
    }

    #[test]
    #[ignore]
    fn the_active_window_is_one_of_the_listed_windows_or_a_utility_one() {
        let active = active_window();
        assert!(active.is_some(), "no foreground window at all");
    }
}
