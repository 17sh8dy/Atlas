//! Where synthetic input is allowed to land — and, above all, where it is not.
//!
//! ## What this protects
//!
//! Atlas sends keystrokes and clicks (`input.rs`) and operates controls through
//! UI Automation (`uia.rs`). Two kinds of target must never receive them:
//!
//!  * **Windows' own elevation and credential interfaces** — the UAC consent
//!    prompt (`consent.exe`), the credential broker, the logon UI. An assistant
//!    that could press "Yes" on a UAC prompt would make the prompt worthless, so
//!    Atlas does not, and this is enforced *here*, next to `SendInput`, not only
//!    in the renderer that decides what to ask.
//!  * **Anything elevated above Atlas.** Windows' own UI Privilege Isolation
//!    silently discards input sent from a normal process to an elevated window,
//!    and `SendInput` still reports success — which is how "I clicked it" gets
//!    said about a click that went nowhere. Refusing up front, with the reason,
//!    is the honest version.
//!
//! ## Not by title
//!
//! A window's title is text its own program chose. The decision rests on what
//! Windows records instead, strongest first:
//!
//!  1. **the desktop.** The UAC prompt normally runs on the *secure desktop*,
//!     which an ordinary process cannot even open. If the input desktop is not
//!     the user's `Default` desktop, or cannot be opened, nothing is sent.
//!  2. **the process image.** The executable that owns the window, from
//!     `QueryFullProcessImageNameW`. `consent.exe` and the other Windows
//!     interfaces below are refused by file name wherever they live — a copy
//!     elsewhere is not more trustworthy.
//!  3. **the process token.** Elevation and integrity level, from the token.
//!  4. **the window class and title**, as a further signal only.
//!
//! ## Fail closed
//!
//! If Windows will not say which process owns the target, or what it runs as,
//! the answer is "blocked", not "probably fine". A refusal costs a retry; a
//! click sent to an interface Atlas could not identify cannot be taken back.
//!
//! Every refusal is `BLOCKED:<code>:<sentence>`, so the renderer can tell a
//! refusal from a failure and say why.

#![cfg(windows)]

use serde::Serialize;

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    WindowFromPoint, GA_ROOT,
};

use crate::procinfo::{self, ProcFacts};

/// Windows' own elevation and credential interfaces, by executable name.
const PROTECTED_IMAGES: &[&str] = &[
    "consent.exe",             // the UAC prompt
    "credentialuibroker.exe",  // credential prompts
    "logonui.exe",             // sign-in / lock UI
    "winlogon.exe",            // secure attention sequence, lock, sign-in
    "lockapp.exe",             // the lock screen
];

/// Window classes the elevation and credential UI use. A signal, never the
/// only one.
const PROTECTED_CLASSES: &[&str] = &["credential dialog xaml host", "$$$secure uap dummy window class"];

/// What kind of desktop input would land on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Desktop {
    Default,
    Other(String),
    /// Could not be opened — which is what the secure desktop looks like.
    Unreachable,
}

/// Everything the decision needs, gathered before it is made.
#[derive(Debug, Clone)]
pub struct Target {
    pub image_name: Option<String>,
    pub class_name: String,
    pub title: String,
    pub elevated: Option<bool>,
    pub integrity: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Blocked {
    pub code: &'static str,
    pub message: String,
}

impl Blocked {
    /// The wire form the renderer parses.
    pub fn wire(&self) -> String {
        format!("BLOCKED:{}:{}", self.code, self.message)
    }
}

fn blocked(code: &'static str, message: impl Into<String>) -> Blocked {
    Blocked { code, message: message.into() }
}

/// The decision itself, from facts alone — no calls to Windows, so every branch
/// can be tested and none depends on what happens to be on screen.
pub fn judge(desktop: &Desktop, target: &Target, ours: &ProcFacts) -> Result<(), Blocked> {
    match desktop {
        Desktop::Default => {}
        Desktop::Other(name) => {
            return Err(blocked(
                "protected-desktop",
                format!(
                    "Input is going to a protected Windows screen (“{name}”), such as a permission prompt. I don't send keys or clicks there."
                ),
            ));
        }
        Desktop::Unreachable => {
            return Err(blocked(
                "protected-desktop",
                "Windows is showing a protected screen, such as a permission prompt, that I can't reach. I don't send keys or clicks there.",
            ));
        }
    }

    let Some(image) = target.image_name.as_deref() else {
        return Err(blocked(
            "unknown",
            "I can't tell which program that window belongs to, so I didn't send anything to it.",
        ));
    };

    if PROTECTED_IMAGES.contains(&image) {
        return Err(blocked(
            "uac",
            format!(
                "That's a Windows permission or sign-in screen ({image}). Atlas never answers those — that's your decision, made by you."
            ),
        ));
    }
    let class = target.class_name.to_ascii_lowercase();
    if PROTECTED_CLASSES.iter().any(|c| class.contains(c))
        || target.title.trim().eq_ignore_ascii_case("user account control")
    {
        return Err(blocked(
            "uac",
            "That looks like a Windows permission prompt. Atlas never answers those — that's your decision, made by you.",
        ));
    }

    let (Some(target_elevated), Some(target_integrity)) = (target.elevated, target.integrity)
    else {
        return Err(blocked(
            "unknown",
            "Windows won't tell me what rights that window runs with, so I didn't send anything to it.",
        ));
    };
    let (Some(our_elevated), Some(our_integrity)) = (ours.elevated, ours.integrity) else {
        return Err(blocked(
            "unknown",
            "I can't read my own rights, so I didn't send anything.",
        ));
    };

    if (target_elevated && !our_elevated) || target_integrity > our_integrity {
        return Err(blocked(
            "elevated",
            format!(
                "That window ({image}) is running as administrator, and Windows doesn't let a normal program control it — input sent there would be silently dropped. I haven't sent anything."
            ),
        ));
    }
    Ok(())
}

// ---- gathering the facts ---------------------------------------------------

fn input_desktop() -> Desktop {
    unsafe {
        let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else {
            return Desktop::Unreachable;
        };
        let mut buf = [0u16; 256];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut _),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        );
        let _ = CloseDesktop(desk);
        if read.is_err() {
            return Desktop::Unreachable;
        }
        let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        let name = String::from_utf16_lossy(&buf[..len]);
        if name.eq_ignore_ascii_case("default") {
            Desktop::Default
        } else {
            Desktop::Other(name)
        }
    }
}

fn target_of(hwnd: HWND) -> Target {
    if hwnd.0.is_null() {
        return Target { image_name: None, class_name: String::new(), title: String::new(), elevated: None, integrity: None };
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let facts = if pid == 0 { ProcFacts::default() } else { procinfo::facts_for_pid(pid) };

    let mut class = [0u16; 256];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
    let mut title = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;

    Target {
        image_name: facts.image_name(),
        class_name: String::from_utf16_lossy(&class[..class_len.min(class.len())]),
        title: String::from_utf16_lossy(&title[..title_len.min(title.len())]),
        elevated: facts.elevated,
        integrity: facts.integrity,
    }
}

fn check_hwnd(hwnd: HWND) -> Result<(), Blocked> {
    judge(&input_desktop(), &target_of(hwnd), &procinfo::self_facts())
}

/// Keys go to whatever has the keyboard focus.
pub fn check_foreground() -> Result<(), String> {
    check_hwnd(unsafe { GetForegroundWindow() }).map_err(|b| b.wire())
}

/// A click goes to the window under the point, not to the foreground one.
pub fn check_point(x: i32, y: i32) -> Result<(), String> {
    let hwnd = unsafe {
        let under = WindowFromPoint(POINT { x, y });
        if under.0.is_null() { under } else { GetAncestor(under, GA_ROOT) }
    };
    check_hwnd(hwnd).map_err(|b| b.wire())
}

/// A UI Automation action goes to the window it names.
pub fn check_window_id(id: &str) -> Result<(), String> {
    let hwnd = crate::window::resolve_hwnd(id)?;
    check_hwnd(hwnd).map_err(|b| b.wire())
}

// ---- asking without acting ---------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub allowed: bool,
    pub code: Option<&'static str>,
    pub message: Option<String>,
    /// What was found, so the renderer can name it on a card.
    pub image: Option<String>,
    pub title: Option<String>,
}

/// Would input to this target be allowed? A read: nothing is sent. The renderer
/// asks before it puts a question to the person, so a blocked target is refused
/// rather than asked about — the same check the commands make again themselves.
#[tauri::command]
pub fn input_probe(x: Option<i32>, y: Option<i32>, window_id: Option<String>) -> Probe {
    let hwnd = if let Some(id) = window_id.as_deref() {
        match crate::window::resolve_hwnd(id) {
            Ok(h) => h,
            Err(message) => {
                return Probe { allowed: false, code: Some("unknown"), message: Some(message), image: None, title: None }
            }
        }
    } else if let (Some(x), Some(y)) = (x, y) {
        unsafe {
            let under = WindowFromPoint(POINT { x, y });
            if under.0.is_null() { under } else { GetAncestor(under, GA_ROOT) }
        }
    } else {
        unsafe { GetForegroundWindow() }
    };

    let target = target_of(hwnd);
    let verdict = judge(&input_desktop(), &target, &procinfo::self_facts());
    Probe {
        allowed: verdict.is_ok(),
        code: verdict.as_ref().err().map(|b| b.code),
        message: verdict.err().map(|b| b.message),
        image: target.image_name,
        title: Some(target.title).filter(|t| !t.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ours() -> ProcFacts {
        ProcFacts {
            pid: 1,
            image: None,
            elevated: Some(false),
            integrity: Some(procinfo::INTEGRITY_MEDIUM),
        }
    }

    fn app(image: &str) -> Target {
        Target {
            image_name: Some(image.into()),
            class_name: "Notepad".into(),
            title: "Untitled - Notepad".into(),
            elevated: Some(false),
            integrity: Some(procinfo::INTEGRITY_MEDIUM),
        }
    }

    fn code(r: Result<(), Blocked>) -> &'static str {
        r.err().map(|b| b.code).unwrap_or("ok")
    }

    #[test]
    fn an_ordinary_window_on_the_default_desktop_is_allowed() {
        assert_eq!(code(judge(&Desktop::Default, &app("notepad.exe"), &ours())), "ok");
    }

    #[test]
    fn the_secure_desktop_is_never_a_target_however_the_window_looks() {
        // What a UAC prompt on the secure desktop looks like to an ordinary
        // process: the desktop cannot be opened at all.
        assert_eq!(code(judge(&Desktop::Unreachable, &app("notepad.exe"), &ours())), "protected-desktop");
        assert_eq!(
            code(judge(&Desktop::Other("Winlogon".into()), &app("notepad.exe"), &ours())),
            "protected-desktop"
        );
    }

    #[test]
    fn windows_elevation_and_credential_interfaces_are_refused_by_process_not_title() {
        for image in ["consent.exe", "credentialuibroker.exe", "logonui.exe", "winlogon.exe", "lockapp.exe"] {
            // A perfectly innocent title, and a medium-integrity token: only
            // the program that owns the window gives it away.
            let mut t = app(image);
            t.title = "Hello".into();
            t.class_name = "Static".into();
            assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "uac", "{image}");
        }
    }

    #[test]
    fn a_copy_of_consent_exe_elsewhere_is_no_more_trusted() {
        // The decision is on the file name, so where it was launched from does
        // not matter.
        assert_eq!(code(judge(&Desktop::Default, &app("consent.exe"), &ours())), "uac");
    }

    #[test]
    fn the_window_class_and_title_are_further_signals() {
        let mut t = app("someprogram.exe");
        t.class_name = "Credential Dialog Xaml Host".into();
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "uac");
        let mut t = app("someprogram.exe");
        t.title = "User Account Control".into();
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "uac");
    }

    #[test]
    fn a_title_alone_does_not_make_a_window_safe() {
        // The mirror image: calling itself "Notepad" changes nothing about
        // being consent.exe.
        let mut t = app("consent.exe");
        t.title = "Untitled - Notepad".into();
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "uac");
    }

    #[test]
    fn an_unidentifiable_process_fails_closed() {
        let mut t = app("x.exe");
        t.image_name = None;
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "unknown");
    }

    #[test]
    fn unreadable_rights_fail_closed() {
        let mut t = app("notepad.exe");
        t.elevated = None;
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "unknown");
        let mut t = app("notepad.exe");
        t.integrity = None;
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "unknown");
        let mut us = ours();
        us.elevated = None;
        assert_eq!(code(judge(&Desktop::Default, &app("notepad.exe"), &us)), "unknown");
    }

    #[test]
    fn an_elevated_window_is_refused_because_windows_would_drop_the_input() {
        let mut t = app("regedit.exe");
        t.elevated = Some(true);
        t.integrity = Some(procinfo::INTEGRITY_HIGH);
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "elevated");
        // Higher integrity without the elevated flag is refused too.
        let mut t = app("thing.exe");
        t.integrity = Some(procinfo::INTEGRITY_HIGH);
        assert_eq!(code(judge(&Desktop::Default, &t, &ours())), "elevated");
    }

    #[test]
    fn an_elevated_window_is_reachable_only_if_atlas_is_elevated_too() {
        let mut t = app("regedit.exe");
        t.elevated = Some(true);
        t.integrity = Some(procinfo::INTEGRITY_HIGH);
        let mut us = ours();
        us.elevated = Some(true);
        us.integrity = Some(procinfo::INTEGRITY_HIGH);
        assert_eq!(code(judge(&Desktop::Default, &t, &us)), "ok");
        // ...but an elevated Atlas still never answers the permission screen.
        assert_eq!(code(judge(&Desktop::Default, &app("consent.exe"), &us)), "uac");
    }

    #[test]
    fn a_refusal_travels_in_a_form_the_renderer_can_recognise() {
        let b = judge(&Desktop::Unreachable, &app("a.exe"), &ours()).unwrap_err();
        assert!(b.wire().starts_with("BLOCKED:protected-desktop:"));
    }

    // ---- against the real machine ---------------------------------------------

    #[test]
    fn the_real_input_desktop_is_the_default_one_when_a_person_is_signed_in() {
        // Skipped rather than failed where there is no interactive desktop
        // (a service, a locked session): what is asserted is only that the
        // answer is one of the three, never a panic.
        match input_desktop() {
            Desktop::Default | Desktop::Other(_) | Desktop::Unreachable => {}
        }
    }

    #[test]
    fn this_process_reports_its_own_rights_and_is_not_a_protected_interface() {
        let me = procinfo::self_facts();
        assert!(me.elevated.is_some() && me.integrity.is_some(), "own token unreadable: {me:?}");
        let name = me.image_name().unwrap_or_default();
        assert!(!PROTECTED_IMAGES.contains(&name.as_str()), "{name}");
    }

    #[test]
    fn the_real_desktop_shell_is_an_allowed_target_so_the_guard_does_not_over_block() {
        // A guard that refuses ordinary windows would break every input skill.
        // The shell (Explorer's desktop) is a real, ordinary, non-elevated window
        // on any signed-in machine.
        use windows::Win32::UI::WindowsAndMessaging::GetShellWindow;
        if input_desktop() != Desktop::Default {
            return; // no interactive desktop here (a service, a locked session)
        }
        let shell = unsafe { GetShellWindow() };
        if shell.0.is_null() {
            return;
        }
        let verdict = check_hwnd(shell);
        assert!(verdict.is_ok(), "the guard blocked the desktop shell: {verdict:?}");
    }

    #[test]
    fn the_shell_is_identified_by_its_real_process_and_is_not_elevated() {
        // Explorer runs in every interactive session. If this machine has none
        // the test has nothing to say.
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let Some(explorer) = sys
            .processes()
            .values()
            .find(|p| p.name().to_string_lossy().eq_ignore_ascii_case("explorer.exe"))
        else {
            return;
        };
        let facts = procinfo::facts_for_pid(explorer.pid().as_u32());
        assert_eq!(facts.image_name().as_deref(), Some("explorer.exe"));
        assert_eq!(facts.elevated, Some(false));
    }
}
