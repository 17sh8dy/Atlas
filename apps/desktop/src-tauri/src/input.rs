//! Synthetic mouse and keyboard input — the fallback layer for when nothing
//! more semantic (a Win32 window call, UI Automation) can reach a control.
//!
//! Same rule as the rest of this crate, applied to the input stream itself:
//! every verb is a fixed shape with validated arguments. There is no "send
//! this raw scan code" or "send this VK number" command — a key is named from
//! a closed table (`named_key`) the same way `os.rs`'s media keys are, a
//! button is one of three strings, and a coordinate is clamped to the virtual
//! screen before it ever reaches `SendInput`. Typed text goes through
//! `KEYEVENTF_UNICODE`, which sends a character rather than a key, so it never
//! depends on knowing which of these fixed key codes the active keyboard
//! layout would even produce.
//!
//! ⚠️ Nothing here can reach an elevated window from this unelevated process,
//! or the Secure Attention Sequence (Ctrl+Alt+Delete) — both are refused by
//! Windows itself (UIPI, and the fact that SAS is intercepted before any
//! process ever sees it), not by anything in this file.

#![cfg(windows)]

use serde::Serialize;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8,
    VK_F9, VK_HOME, VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// Clamp to the desktop's actual extent — the only validation an absolute
/// coordinate needs, since there's no such thing as an unsafe *place* to move
/// a cursor, only an unsafe thing to click once it's there.
fn clamp_to_screen(x: i32, y: i32) -> (i32, i32) {
    let (left, top, width, height) = virtual_screen();
    (
        x.clamp(left, left + width.max(1) - 1),
        y.clamp(top, top + height.max(1) - 1),
    )
}

/// `SendInput`'s absolute mode wants 0..=65535 normalized across the *virtual*
/// desktop, and needs `MOUSEEVENTF_VIRTUALDESK` set to mean that rather than
/// the primary monitor alone — otherwise a second monitor to the left of the
/// primary (negative coordinates) is simply unreachable.
fn normalize(x: i32, y: i32) -> (i32, i32) {
    let (left, top, width, height) = virtual_screen();
    let nx = ((x - left) as i64 * 65535) / (width.max(1) as i64 - 1).max(1);
    let ny = ((y - top) as i64 * 65535) / (height.max(1) as i64 - 1).max(1);
    (nx as i32, ny as i32)
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows only delivered part of that input — another app may have blocked it.".into())
    }
}

fn mouse_input(dx: i32, dy: i32, flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn unicode_input(ch: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: ch,
                dwFlags: if up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[tauri::command]
pub fn move_mouse(x: i32, y: i32) -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    let (cx, cy) = clamp_to_screen(x, y);
    let (nx, ny) = normalize(cx, cy);
    send(&[mouse_input(
        nx,
        ny,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        0,
    )])?;
    Ok(true)
}

#[derive(Serialize)]
pub struct CursorPosition {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
pub fn cursor_position() -> Result<CursorPosition, String> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.map_err(|e| e.message())?;
    Ok(CursorPosition { x: p.x, y: p.y })
}

/// down-flag, up-flag for one of the three buttons this program will ever
/// press — never a caller-supplied bit pattern.
fn button_flags(
    button: &str,
) -> Result<
    (
        windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
        windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    ),
    String,
> {
    match button {
        "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
        "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
        "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
        other => Err(format!("No mouse button called “{other}”.")),
    }
}

#[tauri::command]
pub fn mouse_click(x: i32, y: i32, button: String, double: Option<bool>) -> Result<bool, String> {
    crate::halt::global().check()?;
    let (down, up) = button_flags(&button)?;
    let (cx, cy) = clamp_to_screen(x, y);
    let (nx, ny) = normalize(cx, cy);
    let move_to = mouse_input(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0);

    let mut inputs = vec![move_to, mouse_input(0, 0, down, 0), mouse_input(0, 0, up, 0)];
    if double.unwrap_or(false) {
        inputs.push(mouse_input(0, 0, down, 0));
        inputs.push(mouse_input(0, 0, up, 0));
    }
    send(&inputs)?;
    Ok(true)
}

#[tauri::command]
pub fn mouse_scroll(amount: i32) -> Result<bool, String> {
    crate::halt::global().check()?;
    // One notch is 120 units in Win32's own vocabulary; the argument is in
    // notches so a caller never has to know that.
    let delta = amount.clamp(-20, 20) * 120;
    send(&[mouse_input(0, 0, MOUSEEVENTF_WHEEL, delta)])?;
    Ok(true)
}

#[tauri::command]
pub fn mouse_drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32, button: Option<String>) -> Result<bool, String> {
    crate::halt::global().check()?;
    let (down, up) = button_flags(button.as_deref().unwrap_or("left"))?;
    let (fx, fy) = normalize(clamp_to_screen(from_x, from_y).0, clamp_to_screen(from_x, from_y).1);
    let (tx, ty) = normalize(clamp_to_screen(to_x, to_y).0, clamp_to_screen(to_x, to_y).1);

    let abs = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[
        mouse_input(fx, fy, abs, 0),
        mouse_input(0, 0, down, 0),
        // A midpoint stop before the destination — some apps only recognise a
        // drag once they've seen the cursor actually move across them, not
        // teleport in with the button already down.
        mouse_input((fx + tx) / 2, (fy + ty) / 2, abs, 0),
        mouse_input(tx, ty, abs, 0),
        mouse_input(0, 0, up, 0),
    ])?;
    Ok(true)
}

/// Named keys, closed set. Anything not in this table is refused rather than
/// forwarded as a raw code — the same reason `os.rs`'s media keys are an enum.
fn named_key(name: &str) -> Option<VIRTUAL_KEY> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "page up" | "pgup" => VK_PRIOR,
        "pagedown" | "page down" | "pgdn" => VK_NEXT,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "space" | "spacebar" => VK_SPACE,
        "f1" => VK_F1,
        "f2" => VK_F2,
        "f3" => VK_F3,
        "f4" => VK_F4,
        "f5" => VK_F5,
        "f6" => VK_F6,
        "f7" => VK_F7,
        "f8" => VK_F8,
        "f9" => VK_F9,
        "f10" => VK_F10,
        "f11" => VK_F11,
        "f12" => VK_F12,
        _ => return None,
    })
}

/// A single printable character, resolved to whatever key (and shift state)
/// the *active* keyboard layout would need to produce it — used only for
/// hotkeys, where "ctrl+s" has to mean the S key regardless of layout, unlike
/// `type_text`, which sends the character itself and never needs this at all.
fn char_key(ch: char) -> Option<(VIRTUAL_KEY, bool)> {
    let mut buf = [0u16; 2];
    let units = ch.encode_utf16(&mut buf);
    if units.len() != 1 {
        return None;
    }
    let packed = unsafe { VkKeyScanW(units[0]) };
    if packed == -1 {
        return None;
    }
    let vk = VIRTUAL_KEY((packed as u16) & 0xFF);
    let needs_shift = (packed >> 8) & 1 != 0;
    Some((vk, needs_shift))
}

fn modifier_key(name: &str) -> Option<VIRTUAL_KEY> {
    Some(match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => VK_CONTROL,
        "alt" => VK_MENU,
        "shift" => VK_SHIFT,
        "win" | "windows" | "super" | "meta" => VK_LWIN,
        _ => return None,
    })
}

#[tauri::command]
pub fn press_key(key: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let vk = named_key(&key).ok_or_else(|| format!("No key called “{key}”."))?;
    send(&[
        key_input(vk, KEYBD_EVENT_FLAGS(0)),
        key_input(vk, KEYEVENTF_KEYUP),
    ])?;
    Ok(true)
}

#[tauri::command]
pub fn hotkey(modifiers: Vec<String>, key: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    if modifiers.len() > 3 {
        return Err("That's too many modifier keys.".into());
    }
    let mods: Vec<VIRTUAL_KEY> = modifiers
        .iter()
        .map(|m| modifier_key(m).ok_or_else(|| format!("No modifier key called “{m}”.")))
        .collect::<Result<_, _>>()?;

    let (vk, shift_too) = if let Some(vk) = named_key(&key) {
        (vk, false)
    } else {
        let mut chars = key.chars();
        let (Some(ch), None) = (chars.next(), chars.next()) else {
            return Err(format!("No key called “{key}”."));
        };
        char_key(ch).ok_or_else(|| format!("No key called “{key}”."))?
    };

    let mut downs: Vec<INPUT> = mods.iter().map(|&m| key_input(m, KEYBD_EVENT_FLAGS(0))).collect();
    if shift_too && !mods.contains(&VK_SHIFT) {
        downs.push(key_input(VK_SHIFT, KEYBD_EVENT_FLAGS(0)));
    }
    downs.push(key_input(vk, KEYBD_EVENT_FLAGS(0)));

    let mut ups: Vec<INPUT> = vec![key_input(vk, KEYEVENTF_KEYUP)];
    if shift_too && !mods.contains(&VK_SHIFT) {
        ups.push(key_input(VK_SHIFT, KEYEVENTF_KEYUP));
    }
    ups.extend(mods.iter().rev().map(|&m| key_input(m, KEYEVENTF_KEYUP)));

    downs.extend(ups);
    send(&downs)?;
    Ok(true)
}

/// Arbitrary text, one Unicode scalar at a time. Deliberately not routed
/// through `named_key`/VK codes at all — `KEYEVENTF_UNICODE` hands Windows the
/// character directly, so this works for any script the target control can
/// render, independent of whatever keyboard layout is actually active.
#[tauri::command]
pub fn type_text(text: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    const MAX_CHARS: usize = 4000;
    if text.chars().count() > MAX_CHARS {
        return Err("That's too much text to type in one go.".into());
    }

    let mut inputs = Vec::new();
    for unit in text.encode_utf16() {
        inputs.push(unicode_input(unit, false));
        inputs.push(unicode_input(unit, true));
    }
    if inputs.is_empty() {
        return Ok(true);
    }
    send(&inputs)?;
    Ok(true)
}

/// Whether a key is currently held — used only by tests, to confirm a
/// synthesized key-up actually released it rather than leaving it stuck.
#[cfg(test)]
fn is_down(vk: VIRTUAL_KEY) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000 != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinates_clamp_to_the_real_desktop() {
        let (left, top, width, height) = virtual_screen();
        let (x, y) = clamp_to_screen(left - 10_000, top - 10_000);
        assert_eq!(x, left);
        assert_eq!(y, top);
        let (x2, y2) = clamp_to_screen(left + width + 10_000, top + height + 10_000);
        assert_eq!(x2, left + width - 1);
        assert_eq!(y2, top + height - 1);
    }

    #[test]
    fn normalization_stays_inside_the_valid_range() {
        let (left, top, width, height) = virtual_screen();
        let (nx, ny) = normalize(left, top);
        assert_eq!((nx, ny), (0, 0));
        let (nx2, ny2) = normalize(left + width - 1, top + height - 1);
        assert!((0..=65535).contains(&nx2), "{nx2}");
        assert!((0..=65535).contains(&ny2), "{ny2}");
    }

    #[test]
    fn only_the_three_real_buttons_are_accepted() {
        assert!(button_flags("left").is_ok());
        assert!(button_flags("right").is_ok());
        assert!(button_flags("middle").is_ok());
        assert!(button_flags("scroll-lock-and-shutdown").is_err());
    }

    #[test]
    fn unknown_key_names_are_refused_before_anything_is_sent() {
        assert!(named_key("ctrl+alt+delete").is_none());
        assert!(named_key("enter").is_some());
        assert!(named_key("F5".to_string().to_lowercase().as_str()).is_some());
    }

    #[test]
    fn too_many_modifiers_are_refused() {
        let err = hotkey(
            vec!["ctrl".into(), "alt".into(), "shift".into(), "win".into()],
            "a".into(),
        );
        assert!(err.is_err());
    }

    /// Live, ignored by default. Types one character and confirms the key
    /// really came back up — the shape of bug a stuck-modifier key would be.
    #[test]
    #[ignore]
    fn a_synthesized_key_does_not_stay_stuck_down() {
        press_key("a".to_string()).ok(); // not a named key; expected to fail cleanly
        press_key("enter".to_string()).expect("enter is a named key");
        assert!(!is_down(VK_RETURN), "Enter reported as still held after key-up");
    }

    #[test]
    #[ignore]
    fn moving_the_mouse_actually_moves_it() {
        let (left, top, width, height) = virtual_screen();
        let target = (left + width / 2, top + height / 2);
        move_mouse(target.0, target.1).expect("move_mouse");
        let pos = cursor_position().expect("cursor_position");
        // Rounding through the 0..=65535 normalization can land a pixel or two
        // off; within 3px is close enough to prove the move actually happened.
        assert!((pos.x - target.0).abs() <= 3, "x drifted to {}", pos.x);
        assert!((pos.y - target.1).abs() <= 3, "y drifted to {}", pos.y);
    }
}
