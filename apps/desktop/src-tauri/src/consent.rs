//! Native consent for durable trust changes.
//!
//! The engine, the executor and every confirmation card live in the webview, so none of them can
//! stop script running *in* the webview from calling a native command directly. What can is a
//! question the renderer cannot answer for the person. This module asks it: a Windows message box,
//! raised and read entirely by Rust.
//!
//! ## What it guarantees
//!
//! * **The renderer does not write the question.** Each `Request` carries typed, already
//!   validated values (a canonical path, a resolved address); the wording is fixed here and the
//!   values are stripped of control and bidirectional-override characters and truncated, so a
//!   hostile name cannot add a line, fake a second paragraph or read right-to-left.
//! * **The renderer does not get the answer.** The outcome is consumed inside the command that
//!   asked; the change either happens there or it does not. There is nothing to "approve" from
//!   script.
//! * **Declining is the default.** The default button is *No*, so a stray Enter or Space (and a
//!   synthesized one) denies. While a question is open, Atlas's own input commands refuse to run
//!   (`input_guard`), so it cannot click its own *Yes*.
//! * **F8 and silence deny.** A halt closes the box with *No*; so does two minutes without an
//!   answer. Nothing changes.
//! * **One question at a time, and a pause after refusals.** A second request while one is open is
//!   refused rather than queued; three declined requests within two minutes pause new ones for a
//!   minute (a temporary pause, never a lockout, and a *Yes* clears the count).
//!
//! ## What it does not claim
//!
//! It does not stop a program running as the same Windows user from clicking *Yes* (that program
//! can already do whatever Atlas can), and it does not cover the commands that execute programs or
//! change system settings directly. See `docs/NATIVE-AUTHORIZATION-INVENTORY.md`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a question waits for an answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(120);
/// Declined requests that trigger the pause, and the window they are counted in.
const DENIALS_BEFORE_PAUSE: usize = 3;
const DENIAL_WINDOW: Duration = Duration::from_secs(120);
const PAUSE: Duration = Duration::from_secs(60);
const MAX_VALUE_CHARS: usize = 160;

static OPEN: AtomicBool = AtomicBool::new(false);

/// Is a consent question on screen right now? Checked by the input commands.
pub fn is_open() -> bool {
    OPEN.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    AddFolder { path: String },
    RemoveFolder { path: String },
    SaveKey { what: String },
    DeleteKey { what: String },
    SearxngSet { url: String, reach: String },
    SearxngClear,
    ProviderAdd { kind: String, host: String },
    ProviderBind { kind: String, host: String, was: Option<String> },
    StopKey { label: String },
}

/// Strip what could be used to forge or hide text in a dialog, and bound the length.
pub(crate) fn clean(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        let bad = c.is_control()
            // bidirectional embeddings, overrides, isolates and marks
            || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
            // zero-width characters that make two different strings look the same
            || matches!(c, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}');
        out.push(if bad { ' ' } else { c });
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > MAX_VALUE_CHARS {
        let kept: String = out.chars().take(MAX_VALUE_CHARS).collect();
        format!("{kept}…")
    } else {
        out
    }
}

impl Request {
    pub fn title(&self) -> String {
        "Atlas needs your permission".to_string()
    }

    pub fn body(&self) -> String {
        const SOURCE: &str = "Choose Yes only if you just did this in Atlas's Settings.";
        match self {
            Request::AddFolder { path } => format!(
                "Atlas is asking to be allowed to use this folder:\n\n{}\n\nAtlas, and anything it runs, will be able to read, create, change and delete files there.\n\n{SOURCE}",
                clean(path)
            ),
            Request::RemoveFolder { path } => format!(
                "Atlas is asking to stop using this folder:\n\n{}\n\nFile actions there will not work until it is added again.",
                clean(path)
            ),
            Request::SaveKey { what } => format!(
                "Atlas is asking to save an API key for {}.\n\nIt is stored in Windows Credential Manager. {SOURCE}",
                clean(what)
            ),
            Request::DeleteKey { what } => format!(
                "Atlas is asking to delete the saved API key for {}.",
                clean(what)
            ),
            Request::SearxngSet { url, reach } => format!(
                "Atlas is asking to send its web searches to this server:\n\n{}\n\n{}\n\nEvery search you make will be sent there. {SOURCE}",
                clean(url),
                clean(reach)
            ),
            Request::SearxngClear => {
                "Atlas is asking to stop using its saved search server.".to_string()
            }
            Request::ProviderAdd { kind, host } => format!(
                "Atlas is asking to add a {} model provider and save its API key.\n\nThe key will be sent to:\n\n{}\n\n{SOURCE}",
                clean(kind),
                clean(host)
            ),
            Request::ProviderBind { kind, host, was } => {
                let before = match was {
                    Some(w) => format!("\n\nIt used to go to:\n\n{}", clean(w)),
                    None => String::new(),
                };
                format!(
                    "Atlas is asking to change where a saved {} API key is sent.\n\nNew address:\n\n{}{before}\n\n{SOURCE}",
                    clean(kind),
                    clean(host)
                )
            }
            Request::StopKey { label } => format!(
                "Atlas is asking to change the emergency-stop key to:\n\n{}\n\nThis is the key that stops everything Atlas is doing.\n\n{SOURCE}",
                clean(label)
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Approved,
    Declined,
    Halted,
    TimedOut,
}

// ---- the pause after refusals ------------------------------------------------------------

#[derive(Default)]
struct Limiter {
    denials: VecDeque<Instant>,
    paused_until: Option<Instant>,
}

impl Limiter {
    fn paused(&mut self, now: Instant) -> Option<Duration> {
        match self.paused_until {
            Some(until) if until > now => Some(until - now),
            Some(_) => {
                self.paused_until = None;
                self.denials.clear();
                None
            }
            None => None,
        }
    }

    fn denied(&mut self, now: Instant) {
        self.denials.push_back(now);
        while let Some(&first) = self.denials.front() {
            if now.duration_since(first) > DENIAL_WINDOW {
                self.denials.pop_front();
            } else {
                break;
            }
        }
        if self.denials.len() >= DENIAL_WINDOW_LIMIT {
            self.paused_until = Some(now + PAUSE);
        }
    }

    fn approved(&mut self) {
        self.denials.clear();
        self.paused_until = None;
    }
}

const DENIAL_WINDOW_LIMIT: usize = DENIALS_BEFORE_PAUSE;

fn limiter() -> &'static Mutex<Limiter> {
    static L: std::sync::OnceLock<Mutex<Limiter>> = std::sync::OnceLock::new();
    L.get_or_init(|| Mutex::new(Limiter::default()))
}

// ---- asking ------------------------------------------------------------------------------

/// Ask the person. `Ok(())` only when they chose Yes; every other path is an error string that
/// says nothing was changed. Call it **last**, after the request is validated, so the question
/// shows exactly what will happen.
pub async fn ask(request: Request) -> Result<(), String> {
    let title = request.title();
    let body = request.body();
    begin(Instant::now())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || present(&title, &body))
        .await
        .unwrap_or(Outcome::Declined);
    finish(outcome, Instant::now())
}

fn begin(now: Instant) -> Result<(), String> {
    let mut l = limiter().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(left) = l.paused(now) {
        return Err(format!(
            "Several requests were declined just now, so Atlas is not asking again for {} seconds. Nothing was changed.",
            left.as_secs() + 1
        ));
    }
    if crate::halt::global().is_halted() {
        return Err("Stopped before the change was confirmed. Nothing was changed.".into());
    }
    if OPEN.swap(true, Ordering::SeqCst) {
        return Err("Another confirmation is already open. Nothing was changed.".into());
    }
    Ok(())
}

fn finish(outcome: Outcome, now: Instant) -> Result<(), String> {
    OPEN.store(false, Ordering::SeqCst);
    let mut l = limiter().lock().unwrap_or_else(|e| e.into_inner());
    match outcome {
        Outcome::Approved => {
            l.approved();
            Ok(())
        }
        Outcome::Declined => {
            l.denied(now);
            Err("You declined that change, so nothing was changed.".into())
        }
        Outcome::Halted => Err("Stopped before the change was confirmed. Nothing was changed.".into()),
        Outcome::TimedOut => {
            l.denied(now);
            Err("That request wasn't answered in time, so nothing was changed.".into())
        }
    }
}

#[cfg(test)]
static STUB: Mutex<Option<fn(&str, &str) -> Outcome>> = Mutex::new(None);

fn present(title: &str, body: &str) -> Outcome {
    #[cfg(test)]
    if let Some(f) = *STUB.lock().unwrap_or_else(|e| e.into_inner()) {
        return f(title, body);
    }
    show_message_box(title, body)
}

#[cfg(windows)]
fn show_message_box(title: &str, body: &str) -> Outcome {
    show_with(title, body, ANSWER_WITHIN, || crate::halt::global().is_halted())
}

/// The box runs on its own thread; this thread watches the clock and the halt latch and, if
/// either fires, presses *No* on the box by id (a `WM_COMMAND`, which a message box honours
/// whether or not it has a close button).
#[cfg(windows)]
pub(crate) fn show_with(
    title: &str,
    body: &str,
    within: Duration,
    halted: impl Fn() -> bool,
) -> Outcome {
    use std::sync::mpsc;
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let title_w = wide(title);
    let body_w = wide(body);
    let (tx, rx) = mpsc::channel::<u32>();
    let worker = std::thread::spawn(move || {
        let _ = tx.send(unsafe { GetCurrentThreadId() });
        // MB_DEFBUTTON2 is "No": Enter and Space deny.
        let r = unsafe {
            MessageBoxW(
                None,
                PCWSTR(body_w.as_ptr()),
                PCWSTR(title_w.as_ptr()),
                MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
            )
        };
        r == IDYES
    });
    let Ok(tid) = rx.recv() else { return Outcome::Declined };

    let started = Instant::now();
    let mut why: Option<Outcome> = None;
    while !worker.is_finished() {
        if halted() {
            why = Some(Outcome::Halted);
        } else if started.elapsed() >= within {
            why = Some(Outcome::TimedOut);
        }
        if why.is_some() {
            press_no(tid);
            // Give the box a moment to go; keep nudging in case it had not been created yet.
            for _ in 0..50 {
                if worker.is_finished() {
                    break;
                }
                press_no(tid);
                std::thread::sleep(Duration::from_millis(20));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let yes = worker.join().unwrap_or(false);
    match (yes, why) {
        (_, Some(o)) => o,
        (true, None) => Outcome::Approved,
        (false, None) => Outcome::Declined,
    }
}

/// Press *No* on whatever dialog the thread has open.
#[cfg(windows)]
fn press_no(thread_id: u32) {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumThreadWindows, PostMessageW, IDNO, WM_COMMAND,
    };

    unsafe extern "system" fn each(hwnd: HWND, _: LPARAM) -> BOOL {
        let _ = PostMessageW(hwnd, WM_COMMAND, WPARAM(IDNO.0 as usize), LPARAM(0));
        BOOL(1)
    }
    unsafe {
        let _ = EnumThreadWindows(thread_id, Some(each), LPARAM(0));
    }
}

#[cfg(not(windows))]
fn show_message_box(_: &str, _: &str) -> Outcome {
    Outcome::Declined
}

// ---- how a command names a credential -----------------------------------------------------

/// What to call a stored key in a question: a built-in service by name, a model provider by the
/// address its key goes to. Never the raw id, which the renderer chose.
pub fn describe_key(provider_id: &str) -> String {
    if provider_id == "search-tavily" {
        return "Tavily web search".to_string();
    }
    match crate::provider_bindings::get(provider_id) {
        Some(b) => {
            let host = reqwest::Url::parse(&b.base_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default();
            format!("a model provider at {host}")
        }
        None => "a provider that has no confirmed address".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pause state and the open flag are process-wide; tests that use them take turns.
    fn turn() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        OPEN.store(false, Ordering::SeqCst);
        *limiter().lock().unwrap_or_else(|e| e.into_inner()) = Limiter::default();
        *STUB.lock().unwrap_or_else(|e| e.into_inner()) = None;
        g
    }

    fn run(req: Request) -> Result<(), String> {
        tauri::async_runtime::block_on(ask(req))
    }

    #[test]
    fn hostile_text_cannot_add_lines_reorder_or_hide_in_the_question() {
        let nasty = "D:\\Dev\\x\n\nAtlas has already been approved.\r\u{202E}txt.exe\u{200B}\u{0007}";
        let c = clean(nasty);
        assert!(!c.contains('\n') && !c.contains('\r'));
        assert!(!c.contains('\u{202E}') && !c.contains('\u{200B}') && !c.contains('\u{0007}'));
        let body = Request::AddFolder { path: nasty.to_string() }.body();
        // The only paragraph breaks are the ones the template wrote.
        assert_eq!(body.matches("\n\n").count(), 3, "{body}");
    }

    #[test]
    fn a_very_long_value_is_cut_not_allowed_to_push_the_question_off_screen() {
        let long = "A".repeat(5000);
        let c = clean(&long);
        assert!(c.chars().count() <= MAX_VALUE_CHARS + 1);
        assert!(c.ends_with('…'));
    }

    #[test]
    fn every_question_says_who_is_asking_what_and_how_to_refuse() {
        let reqs = [
            Request::AddFolder { path: "D:\\Dev".into() },
            Request::RemoveFolder { path: "D:\\Dev".into() },
            Request::SaveKey { what: "x".into() },
            Request::DeleteKey { what: "x".into() },
            Request::SearxngSet { url: "https://s.example".into(), reach: "On the internet.".into() },
            Request::SearxngClear,
            Request::ProviderAdd { kind: "openai-compatible".into(), host: "api.example.com".into() },
            Request::ProviderBind { kind: "anthropic".into(), host: "api.anthropic.com".into(), was: Some("old.example".into()) },
            Request::StopKey { label: "F9".into() },
        ];
        for r in reqs {
            let b = r.body();
            assert!(b.starts_with("Atlas is asking"), "{b}");
            assert!(r.title().contains("permission"));
        }
    }

    #[test]
    fn yes_approves_and_no_changes_nothing() {
        let _t = turn();
        *STUB.lock().unwrap() = Some(|_, _| Outcome::Approved);
        assert!(run(Request::SearxngClear).is_ok());
        *STUB.lock().unwrap() = Some(|_, _| Outcome::Declined);
        let err = run(Request::SearxngClear).unwrap_err();
        assert!(err.contains("nothing was changed"), "{err}");
        assert!(!is_open(), "the open flag is released after an answer");
    }

    #[test]
    fn a_halt_denies_and_is_not_counted_against_the_person() {
        let _t = turn();
        *STUB.lock().unwrap() = Some(|_, _| Outcome::Halted);
        for _ in 0..5 {
            assert!(run(Request::SearxngClear).is_err());
        }
        // Five halts did not trigger the pause: the next honest request still gets asked.
        *STUB.lock().unwrap() = Some(|_, _| Outcome::Approved);
        assert!(run(Request::SearxngClear).is_ok());
    }

    #[test]
    fn three_refusals_pause_new_requests_for_a_while_and_a_yes_after_that_clears_it() {
        let mut l = Limiter::default();
        let t0 = Instant::now();
        l.denied(t0);
        l.denied(t0 + Duration::from_secs(1));
        assert!(l.paused(t0 + Duration::from_secs(2)).is_none(), "two are fine");
        l.denied(t0 + Duration::from_secs(3));
        assert!(l.paused(t0 + Duration::from_secs(4)).is_some(), "the third pauses");
        assert!(l.paused(t0 + Duration::from_secs(3 + 61)).is_none(), "and it ends: not a lockout");
        // Refusals spread past the window do not accumulate.
        let mut l = Limiter::default();
        l.denied(t0);
        l.denied(t0 + Duration::from_secs(130));
        l.denied(t0 + Duration::from_secs(260));
        assert!(l.paused(t0 + Duration::from_secs(261)).is_none());
    }

    #[test]
    fn the_pause_stops_the_question_from_being_shown_at_all() {
        let _t = turn();
        *STUB.lock().unwrap() = Some(|_, _| Outcome::Declined);
        for _ in 0..3 {
            assert!(run(Request::SearxngClear).is_err());
        }
        *STUB.lock().unwrap() = Some(|_, _| panic!("a paused request must not reach the dialog"));
        let err = run(Request::SearxngClear).unwrap_err();
        assert!(err.contains("not asking again"), "{err}");
    }

    #[test]
    fn a_second_request_while_one_is_open_is_refused_not_queued() {
        let _t = turn();
        OPEN.store(true, Ordering::SeqCst);
        let err = run(Request::SearxngClear).unwrap_err();
        assert!(err.contains("already open"), "{err}");
        // The refusal must not have cleared the first request's flag.
        assert!(is_open());
    }

    #[test]
    fn the_stop_key_counts_an_open_question_as_something_to_stop() {
        let _t = turn();
        let halt = crate::halt::Halt::new();
        assert!(!halt.is_working(), "idle: nothing to stop");
        OPEN.store(true, Ordering::SeqCst);
        assert!(halt.is_working(), "a question is open: the stop key must act on it");
        OPEN.store(false, Ordering::SeqCst);
    }

    /// Needs a desktop: raises a real message box and closes it the way a halt does. Run on
    /// purpose with `cargo test -- --ignored consent`.
    #[test]
    #[ignore = "raises a real dialog"]
    fn a_real_box_is_closed_by_a_halt_and_by_the_clock() {
        let o = show_with("Atlas consent self-test", "Closing this by itself.", Duration::from_secs(30), || true);
        assert_eq!(o, Outcome::Halted);
        let o = show_with("Atlas consent self-test", "Closing this by itself.", Duration::from_millis(300), || false);
        assert_eq!(o, Outcome::TimedOut);
    }

    /// Every command that changes trust asks first. A new `TrustChange` command that is not on
    /// this list fails `authz_inventory`'s own check; one that is on it but never calls
    /// `consent::ask` fails here.
    const ASKS_FIRST: &[(&str, &str)] = &[
        ("allowed_folders.rs", "add_allowed_folder"),
        ("allowed_folders.rs", "remove_allowed_folder"),
        ("secrets.rs", "save_secret"),
        ("secrets.rs", "delete_secret"),
        ("searxng.rs", "searxng_configure"),
        ("provider_bindings.rs", "provider_bind"),
        ("provider_bindings.rs", "provider_add"),
        ("halt.rs", "set_halt_shortcut"),
    ];

    /// Trust-changing commands that deliberately do not ask, and why. Each only *withdraws* reach.
    const NARROWING_ONLY: &[(&str, &str)] = &[
        // Withdrawing a destination can only make a saved key less usable.
        ("provider_bindings.rs", "provider_unbind"),
        // Gated separately: the generic store refuses trust-bearing keys (stage 4).
        ("storage.rs", "storage_set"),
        ("storage.rs", "storage_remove"),
    ];

    fn body_of(text: &str, name: &str) -> String {
        let needle = format!("fn {name}(");
        let start = text.find(&needle).unwrap_or_else(|| panic!("{name} not found"));
        let rest = &text[start..];
        let end = rest[needle.len()..]
            .find("\n#[tauri::command")
            .map(|i| i + needle.len())
            .unwrap_or(rest.len());
        rest[..end].to_string()
    }

    #[test]
    fn every_trust_changing_command_asks_before_it_changes_anything() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for (file, name) in ASKS_FIRST {
            let text = std::fs::read_to_string(src.join(file)).unwrap();
            let body = body_of(&text, name);
            assert!(body.contains("consent::ask("), "{name} in {file} must call consent::ask");
            // And asks before the write: the question comes before any persistence call.
            let ask_at = body.find("consent::ask(").unwrap();
            for write in ["storage_set(", "storage_remove(", "persist(", "save_secret_now(", "CredDeleteW", "rebind(", "guard.push(", "guard.insert("] {
                if let Some(w) = body.find(write) {
                    assert!(ask_at < w, "{name}: `{write}` happens before the question");
                }
            }
        }
        // Everything classified as a trust change is accounted for, one way or the other.
        for (file, name, class) in crate::authz_inventory::COMMANDS {
            if *class == crate::authz_inventory::Class::TrustChange {
                let listed = ASKS_FIRST.iter().chain(NARROWING_ONLY).any(|(f, n)| f == file && n == name);
                assert!(listed, "{name} ({file}) changes trust but is on neither list");
            }
        }
    }
}
