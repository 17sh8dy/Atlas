//! UI Automation — inspecting and operating *other* applications' actual
//! controls, rather than guessing at screen coordinates.
//!
//! ## Addressing an element without ever holding one
//!
//! A COM pointer to a UI Automation element cannot cross the IPC boundary,
//! and holding one across two separate commands would mean trusting that
//! nothing about the target app changed in between — exactly the kind of
//! stale-handle bug this crate avoids everywhere else (see `window.rs`'s
//! `resolve`, re-checked with `IsWindow` on every call). So an element here
//! is addressed the same way a filesystem path addresses a file: as a
//! sequence of child indices from the window's root element. `uia_tree`
//! reports that path alongside each node; every action command re-walks it
//! from the root, fresh, and fails cleanly ("that part of the window has
//! changed") if the shape underneath no longer matches rather than acting on
//! whatever happens to be there now.
//!
//! ## Why raw `windows`-crate bindings, not a wrapper crate
//!
//! UI Automation is a COM API, and every other native surface in this crate
//! — `kokoro.rs`'s ONNX/espeak loading, `services.rs`'s `ShellExecuteEx` — is
//! hand-written against `windows` directly rather than through a convenience
//! crate. A second, less-audited dependency here would only save boilerplate,
//! not add a capability.
//!
//! ## The risk split
//!
//! Reading the tree, or what's focused, is `safe` — see `uia-skills.ts`.
//! Invoking, toggling, selecting, expanding or setting a value acts on
//! another application on your behalf, so all of those are `confirm`. UIPI
//! already refuses every one of them against an elevated window from this
//! unelevated process — nothing here has to detect or announce that; it just
//! fails the way any blocked COM call fails.

#![cfg(windows)]

use serde::Serialize;
use windows::core::BSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
    IUIAutomationTextPattern, IUIAutomationValuePattern, TreeScope_Children, UIA_TextPatternId, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    IUIAutomationScrollPattern, UIA_ScrollPatternId, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
    ScrollAmount_SmallIncrement,
};

use crate::window::resolve_hwnd;

/// One COM apartment for the lifetime of one command. Initialized and torn
/// down inside the same `spawn_blocking` closure that does everything else —
/// COM apartments are thread-affine, so this must never outlive the thread it
/// was created on, which is exactly what tying it to this guard's scope
/// guarantees.
struct ComGuard(bool);

impl ComGuard {
    fn new() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_ok() {
            // S_OK or S_FALSE (already initialized, compatibly) both need a
            // matching CoUninitialize.
            Ok(ComGuard(true))
        } else if hr == windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            // Already initialized on this thread with a different concurrency
            // model by something else in the process. Not this guard's to
            // tear down, but usable as-is.
            Ok(ComGuard(false))
        } else {
            Err(format!("Windows couldn't start COM for UI Automation: {}", hr.message()))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn automation() -> Result<IUIAutomation, String> {
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| format!("Windows couldn't start UI Automation: {}", e.message()))
}

fn root_element(ui: &IUIAutomation, hwnd: HWND) -> Result<IUIAutomationElement, String> {
    unsafe { ui.ElementFromHandle(hwnd) }
        .map_err(|e| format!("I couldn't inspect that window: {}", e.message()))
}

fn child_at(
    ui: &IUIAutomation,
    parent: &IUIAutomationElement,
    index: i32,
) -> Result<IUIAutomationElement, String> {
    let condition = unsafe { ui.CreateTrueCondition() }.map_err(|e| e.message())?;
    let children = unsafe { parent.FindAll(TreeScope_Children, &condition) }
        .map_err(|e| e.message())?;
    let len = unsafe { children.Length() }.unwrap_or(0);
    if index < 0 || index >= len {
        return Err("That part of the window has changed since I last looked.".into());
    }
    unsafe { children.GetElement(index) }.map_err(|e| e.message())
}

/// Re-walk a path from the window's root, fresh, every time — see the module
/// doc comment for why this is the whole addressing scheme.
fn resolve_path(ui: &IUIAutomation, hwnd: HWND, path: &[i32]) -> Result<IUIAutomationElement, String> {
    let mut current = root_element(ui, hwnd)?;
    for &index in path {
        current = child_at(ui, &current, index)?;
    }
    Ok(current)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiaNode {
    /// Child indices from the window's root — see the module doc comment.
    pub path: Vec<i32>,
    /// A human-readable role: "button", "edit", "menu item"…
    pub role: String,
    pub name: String,
    pub automation_id: String,
    pub enabled: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// What the control currently holds, for the *focused* element only and
    /// never for a password field. It exists so a typed sentence can be checked
    /// against the field it was typed into — "sent" is not "arrived".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The focused element is a password field. Set so that what is typed into
    /// it is never repeated back in a message.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub password: bool,
    pub children: Vec<UiaNode>,
}

fn describe(el: &IUIAutomationElement, path: Vec<i32>) -> UiaNode {
    let rect = unsafe { el.CurrentBoundingRectangle() }.unwrap_or_default();
    UiaNode {
        path,
        role: unsafe { el.CurrentLocalizedControlType() }
            .map(|b| b.to_string())
            .unwrap_or_default(),
        name: unsafe { el.CurrentName() }.map(|b| b.to_string()).unwrap_or_default(),
        automation_id: unsafe { el.CurrentAutomationId() }
            .map(|b| b.to_string())
            .unwrap_or_default(),
        enabled: unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true),
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        value: None,
        password: false,
        children: Vec::new(),
    }
}

/// The text a control holds, if it will say and it is not a password field.
/// Capped: this is for confirming a short typed string, not for reading a book.
fn read_value(el: &IUIAutomationElement) -> Option<String> {
    const CAP: i32 = 8_000;
    // A password field is never read. If Windows cannot even say whether this is
    // one, it is not read either.
    if unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(true) {
        return None;
    }
    if let Ok(p) = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) } {
        if let Ok(v) = unsafe { p.CurrentValue() } {
            return Some(v.to_string().chars().take(CAP as usize).collect());
        }
    }
    if let Ok(p) = unsafe { el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) } {
        if let Ok(range) = unsafe { p.DocumentRange() } {
            if let Ok(t) = unsafe { range.GetText(CAP) } {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Caps that keep a browser's DOM-shaped tree, or a huge spreadsheet, from
/// blowing up an answer — the same reasoning `platform.rs::search_files` caps
/// at 200 results.
const DEFAULT_MAX_DEPTH: usize = 6;
const MAX_CHILDREN_PER_NODE: i32 = 60;
const MAX_TOTAL_NODES: usize = 400;

fn build_tree(
    ui: &IUIAutomation,
    el: &IUIAutomationElement,
    path: Vec<i32>,
    depth: usize,
    max_depth: usize,
    budget: &mut usize,
) -> UiaNode {
    let mut node = describe(el, path.clone());
    if depth >= max_depth || *budget == 0 {
        return node;
    }

    let Ok(condition) = (unsafe { ui.CreateTrueCondition() }) else {
        return node;
    };
    let Ok(children) = (unsafe { el.FindAll(TreeScope_Children, &condition) }) else {
        return node;
    };
    let len = unsafe { children.Length() }.unwrap_or(0).min(MAX_CHILDREN_PER_NODE);

    for i in 0..len {
        if *budget == 0 {
            break;
        }
        let Ok(child) = (unsafe { children.GetElement(i) }) else {
            continue;
        };
        let mut child_path = path.clone();
        child_path.push(i);
        *budget -= 1;
        node.children.push(build_tree(ui, &child, child_path, depth + 1, max_depth, budget));
    }
    node
}

#[tauri::command]
pub async fn uia_tree(window_id: String, max_depth: Option<usize>) -> Result<UiaNode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let root = root_element(&ui, hwnd)?;
        let mut budget = MAX_TOTAL_NODES;
        Ok(build_tree(
            &ui,
            &root,
            Vec::new(),
            0,
            max_depth.unwrap_or(DEFAULT_MAX_DEPTH).min(DEFAULT_MAX_DEPTH),
            &mut budget,
        ))
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

#[tauri::command]
pub async fn uia_focused_element() -> Result<Option<UiaNode>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        match unsafe { ui.GetFocusedElement() } {
            Ok(el) => {
                let mut node = describe(&el, Vec::new());
                node.password = unsafe { el.CurrentIsPassword() }
                    .map(|b| b.as_bool())
                    .unwrap_or(false);
                node.value = read_value(&el);
                Ok(Some(node))
            }
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

#[tauri::command]
pub async fn uia_invoke(window_id: String, path: Vec<i32>) -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    // Never operate a Windows permission screen, or a window running above Atlas.
    crate::input_guard::check_window_id(&window_id)?;
    // Never operate a Windows permission screen, or a window running above Atlas.
    crate::input_guard::check_window_id(&window_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let element = resolve_path(&ui, hwnd, &path)?;

        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }
        {
            unsafe { pattern.Invoke() }.map_err(|e| e.message())?;
            return Ok(true);
        }
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }
        {
            unsafe { pattern.Toggle() }.map_err(|e| e.message())?;
            return Ok(true);
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        } {
            unsafe { pattern.Select() }.map_err(|e| e.message())?;
            return Ok(true);
        }
        Err("That control doesn't support being clicked, toggled or selected.".into())
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

#[tauri::command]
pub async fn uia_set_expanded(window_id: String, path: Vec<i32>, expand: bool) -> Result<bool, String> {
    crate::halt::global().check()?;
    // Never operate a Windows permission screen, or a window running above Atlas.
    crate::input_guard::check_window_id(&window_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let element = resolve_path(&ui, hwnd, &path)?;

        let pattern = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        }
        .map_err(|_| "That control doesn't expand or collapse.".to_string())?;

        if expand {
            unsafe { pattern.Expand() }
        } else {
            unsafe { pattern.Collapse() }
        }
        .map_err(|e| e.message())?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

/// Direct text entry when the control supports `ValuePattern` — the semantic
/// path this whole module exists to prefer. `uia-skills.ts`'s `uia.typeInto`
/// falls back to focus-plus-keystrokes (`input.rs`) only when this fails.
#[tauri::command]
pub async fn uia_set_value(window_id: String, path: Vec<i32>, value: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    // Never operate a Windows permission screen, or a window running above Atlas.
    crate::input_guard::check_window_id(&window_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let element = resolve_path(&ui, hwnd, &path)?;

        let pattern = unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .map_err(|_| "That control doesn't accept text directly.".to_string())?;
        unsafe { pattern.SetValue(&BSTR::from(value)) }.map_err(|e| e.message())?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

/// Bring keyboard focus to an element — used by `uia.typeInto`'s fallback
/// path before it hands off to `input.rs`.
#[tauri::command]
pub async fn uia_focus(window_id: String, path: Vec<i32>) -> Result<bool, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let element = resolve_path(&ui, hwnd, &path)?;
        unsafe { element.SetFocus() }.map_err(|e| e.message())?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}


// ---- background ("virtual") interaction: nothing here moves the cursor or takes focus ------------
//
// 1.0.8. These three are what the keyboard-and-mouse tools try FIRST when a window is named:
// they act on a control through UI Automation patterns, so the person's real mouse stays where it
// is and the window in front stays in front. Anything a control does not support is reported as
// `UNSUPPORTED:<why>` — a sentence the renderer shows — and NEVER worked around here: the choice to
// fall back to the real mouse and keyboard is the person's, asked in words, never made quietly.
//
// The same guard as every other action applies: a permission screen, a protected desktop or a window
// running above Atlas is refused (`BLOCKED:…`), not "supported". Nothing here reads a password.

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UiaCapabilities {
    pub name: String,
    pub role: String,
    pub enabled: bool,
    pub offscreen: bool,
    pub password: bool,
    pub invoke: bool,
    pub toggle: bool,
    pub select: bool,
    pub expand: bool,
    pub value: bool,
    pub value_read_only: bool,
    pub scroll: bool,
}

/// What can be done to this control without the mouse or keyboard. Reads only.
#[tauri::command]
pub async fn uia_capabilities(window_id: String, path: Vec<i32>) -> Result<UiaCapabilities, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let el = resolve_path(&ui, hwnd, &path)?;
        let value_pattern = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok();
        Ok(UiaCapabilities {
            name: unsafe { el.CurrentName() }.map(|b| b.to_string()).unwrap_or_default(),
            role: unsafe { el.CurrentLocalizedControlType() }.map(|b| b.to_string()).unwrap_or_default(),
            enabled: unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true),
            offscreen: unsafe { el.CurrentIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false),
            // Unknown counts as a password: never treat an unreadable control as safe to type into.
            password: unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(true),
            invoke: unsafe { el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) }.is_ok(),
            toggle: unsafe { el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }.is_ok(),
            select: unsafe { el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) }.is_ok(),
            expand: unsafe { el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) }.is_ok(),
            value: value_pattern.is_some(),
            value_read_only: value_pattern
                .as_ref()
                .map(|p| unsafe { p.CurrentIsReadOnly() }.map(|b| b.as_bool()).unwrap_or(true))
                .unwrap_or(false),
            scroll: unsafe { el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }.is_ok(),
        })
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaTyped {
    pub chars_before: usize,
    pub chars_after: usize,
    /// The control now ends with exactly what was added (read back from the control itself).
    pub verified: bool,
}

/// Most that can be added in one background typing call.
const MAX_APPEND_CHARS: usize = 4_000;

/// Add text to the end of a text control, in the background, then read the control back to check.
/// Replaces nothing the person typed: the new value is the old value plus the text.
#[tauri::command]
pub async fn uia_append_value(window_id: String, path: Vec<i32>, text: String) -> Result<UiaTyped, String> {
    crate::halt::global().check()?;
    crate::input_guard::check_window_id(&window_id)?;
    if text.is_empty() {
        return Err("There is nothing to type.".into());
    }
    if text.chars().count() > MAX_APPEND_CHARS {
        return Err(format!("UNSUPPORTED:That is more than I add to a control in the background ({MAX_APPEND_CHARS} characters)."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let el = resolve_path(&ui, hwnd, &path)?;
        if !unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(false) {
            return Err("UNSUPPORTED:That control is greyed out.".to_string());
        }
        if unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(true) {
            return Err("UNSUPPORTED:That is a password field (or one I cannot tell about), and I never type into those in the background.".to_string());
        }
        let pattern = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .map_err(|_| "UNSUPPORTED:That control does not accept text without the keyboard.".to_string())?;
        if unsafe { pattern.CurrentIsReadOnly() }.map(|b| b.as_bool()).unwrap_or(true) {
            return Err("UNSUPPORTED:That control is read-only.".to_string());
        }
        let before = unsafe { pattern.CurrentValue() }.map(|b| b.to_string()).unwrap_or_default();
        let after_text = format!("{before}{text}");
        unsafe { pattern.SetValue(&BSTR::from(after_text.clone())) }
            .map_err(|e| format!("UNSUPPORTED:The control refused the text ({}).", e.message()))?;
        let read_back = unsafe { pattern.CurrentValue() }.map(|b| b.to_string()).unwrap_or_default();
        Ok(UiaTyped {
            chars_before: before.chars().count(),
            chars_after: read_back.chars().count(),
            verified: read_back == after_text,
        })
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

/// Scroll a scrollable control, in the background. `vertical` > 0 scrolls down, < 0 up; the same
/// for `horizontal` (right / left). Up to 30 small steps each way.
#[tauri::command]
pub async fn uia_scroll(window_id: String, path: Vec<i32>, vertical: i32, horizontal: i32) -> Result<bool, String> {
    crate::halt::global().check()?;
    crate::input_guard::check_window_id(&window_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _com = ComGuard::new()?;
        let ui = automation()?;
        let hwnd = resolve_hwnd(&window_id)?;
        let el = resolve_path(&ui, hwnd, &path)?;
        let pattern = unsafe { el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }
            .map_err(|_| "UNSUPPORTED:That area cannot be scrolled without the mouse wheel.".to_string())?;
        let v = vertical.clamp(-30, 30);
        let h = horizontal.clamp(-30, 30);
        if v == 0 && h == 0 {
            return Ok(true);
        }
        let can_v = unsafe { pattern.CurrentVerticallyScrollable() }.map(|b| b.as_bool()).unwrap_or(false);
        let can_h = unsafe { pattern.CurrentHorizontallyScrollable() }.map(|b| b.as_bool()).unwrap_or(false);
        if (v != 0 && !can_v) || (h != 0 && !can_h) {
            return Err("UNSUPPORTED:That area does not scroll in that direction.".to_string());
        }
        let step = |n: i32| {
            if n > 0 {
                ScrollAmount_SmallIncrement
            } else if n < 0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            }
        };
        for _ in 0..v.abs().max(h.abs()) {
            crate::halt::global().check()?;
            unsafe { pattern.Scroll(step(h), step(v)) }
                .map_err(|e| format!("UNSUPPORTED:The area refused to scroll ({}).", e.message()))?;
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("The UI Automation task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_com_guard_can_be_created_and_dropped_without_panicking() {
        let guard = ComGuard::new().expect("CoInitializeEx should succeed on a fresh thread");
        drop(guard);
    }

    /// Live, ignored by default — see `services.rs` for why this pattern is
    /// used throughout this crate for anything that needs a real desktop.
    /// Walks the tree of whatever window is currently in the foreground.
    #[test]
    #[ignore]
    fn the_foreground_windows_tree_has_at_least_a_root_node() {
        let hwnd = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
        let _com = ComGuard::new().unwrap();
        let ui = automation().unwrap();
        let root = root_element(&ui, hwnd).unwrap();
        let mut budget = MAX_TOTAL_NODES;
        let tree = build_tree(&ui, &root, Vec::new(), 0, DEFAULT_MAX_DEPTH, &mut budget);
        assert!(tree.path.is_empty());
    }
}
