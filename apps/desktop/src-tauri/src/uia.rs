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
    IUIAutomationValuePattern, TreeScope_Children, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
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
        children: Vec::new(),
    }
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
            Ok(el) => Ok(Some(describe(&el, Vec::new()))),
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
