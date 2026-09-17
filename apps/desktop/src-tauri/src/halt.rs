//! Emergency stop — the one control that has to work when nothing else does.
//!
//! ── Why this lives here, and not in the engine ──────────────────────────────
//! Every other decision Atlas makes goes through `@atlas/engine`: the grammar,
//! the planner, the model, the executor. A stop that went through any of them
//! would be a *request* to stop, handled by the very machinery that is
//! currently busy doing the thing you want stopped. So this module sits below
//! all of it, in the process that owns the hands (`input.rs`, `window.rs`,
//! `uia.rs`, `devtools.rs`), and needs nothing from the webview to take effect.
//!
//! ── What a halt actually does, in order ─────────────────────────────────────
//!  1. **Latches.** `check()` starts refusing, so every hand command below
//!     refuses before it sends a single event — including one the webview had
//!     already dispatched before it heard about the halt. Sub-millisecond: it
//!     is an atomic store.
//!  2. **Bumps the epoch** and wakes every `race()`, which is what cuts off an
//!     in-flight model request or stream mid-body rather than when it ends.
//!  3. **Tells the surface** (the caller's `on_latched`), before the slow part,
//!     so "⏹ Atlas halted" is on screen while processes are still going down.
//!  4. **Stops running processes.** Asks first — Ctrl+C on the process's own
//!     console, which is how `cargo`, `node` and `pytest` expect to be
//!     interrupted — then terminates the whole Job Object once
//!     `GRACEFUL_WINDOW` runs out, so a build that ignores the request is gone
//!     well inside the one-second budget, grandchildren included.
//!
//! The latch stays set until the surface clears it with `reset(epoch)`, which
//! only succeeds for the epoch it names — a surface that has not yet *seen* a
//! halt cannot clear it by accident.
//!
//! ── Why a dedicated hotkey thread, not the global-shortcut plugin ───────────
//! The plugin's handler runs on Tauri's event loop, which is the main thread —
//! and synchronous Tauri commands also run on the main thread. A stop key that
//! shares a thread with a blocking command is dead for exactly as long as that
//! command runs. `spawn_hotkey_thread` owns its own `RegisterHotKey` and its
//! own message loop, so it fires whatever the rest of the app is doing.
//!
//! ── What is deliberately *not* interrupted mid-way ──────────────────────────
//! A single synthetic input (`input.rs`) is one `SendInput` batch: Windows
//! queues the whole batch atomically, in well under a millisecond, and nothing
//! can recall events already queued. The stop point for input is therefore
//! *between* actions, which is exactly where the latch sits.

use std::os::windows::io::AsRawHandle;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WPARAM};
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleWindow, SetConsoleCtrlHandler,
    CTRL_C_EVENT,
};
use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};
use windows::Win32::System::Threading::{GetCurrentThreadId, WaitForSingleObject};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT,
    MOD_WIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY, WM_QUIT,
};

/// What every refused hand command says. Matched on the TypeScript side by
/// prefix (`HALTED_PREFIX` in `@atlas/core`), so keep the opening words stable.
pub const HALTED: &str = "Atlas is halted — nothing else runs until you send something new.";

/// How long a running process gets to act on Ctrl+C before its whole job is
/// terminated. Short on purpose: the budget for the entire halt is one second,
/// and a process that has not started exiting in this long is not going to.
const GRACEFUL_WINDOW: Duration = Duration::from_millis(400);

/// The exit code a force-terminated process reports. Distinct from anything a
/// build tool returns on its own, so the diagnostics log can tell which path
/// actually stopped it.
const TERMINATED_EXIT_CODE: u32 = 0xA71A5;

pub const DEFAULT_SHORTCUT: &str = "F8";

// ── The latch ────────────────────────────────────────────────────────────────

struct Supervised {
    id: u64,
    pid: u32,
    /// Raw handle values rather than `HANDLE`, which is a pointer and so not
    /// `Send`. The process handle is borrowed from the `Child` the waiting
    /// thread owns; it stays valid because unregistering takes this same lock.
    process: isize,
    /// Owned — closed on unregister. `None` if the job could not be created or
    /// assigned, in which case halting falls back to `taskkill /T`.
    job: Option<isize>,
}

pub struct Halt {
    latched: AtomicBool,
    epoch: AtomicU64,
    watch: tokio::sync::watch::Sender<u64>,
    processes: Mutex<Vec<Supervised>>,
    next_id: AtomicU64,
}

/// How a halt ended the processes it found — reported to diagnostics, because
/// "did Ctrl+C work or did we have to force it" is only ever answerable from a
/// real run.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct StopReport {
    pub found: usize,
    pub exited_on_request: usize,
    pub terminated: usize,
}

impl Default for Halt {
    fn default() -> Self {
        Self::new()
    }
}

impl Halt {
    pub fn new() -> Self {
        let (watch, _) = tokio::sync::watch::channel(0);
        Self {
            latched: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            watch,
            processes: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn is_halted(&self) -> bool {
        self.latched.load(Ordering::SeqCst)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The gate every hand command calls first.
    pub fn check(&self) -> Result<(), String> {
        if self.is_halted() {
            Err(HALTED.to_string())
        } else {
            Ok(())
        }
    }

    /// Latch, wake every racer, tell the surface, then stop processes.
    ///
    /// Blocks for up to `GRACEFUL_WINDOW` while processes shut down — call it
    /// from the hotkey thread or a blocking task, never from the main thread.
    pub fn trigger(&self, on_latched: impl FnOnce(u64)) -> (u64, StopReport) {
        self.latched.store(true, Ordering::SeqCst);
        let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.watch.send_replace(epoch);
        on_latched(epoch);
        (epoch, self.stop_processes())
    }

    /// Clear the latch — only for the halt the caller actually saw. A stale
    /// epoch means a newer halt happened since, and that one stays in force.
    pub fn reset(&self, epoch: u64) -> bool {
        if self.epoch() != epoch {
            return false;
        }
        self.latched.store(false, Ordering::SeqCst);
        true
    }

    /// Run `fut`, or give up the moment a halt happens — whichever is first.
    ///
    /// Dropping the losing future is the cancellation: for a `reqwest` call
    /// that closes the connection, so a model stops generating for us rather
    /// than finishing an answer nobody will read.
    pub async fn race<T>(
        &self,
        fut: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.check()?;
        let mut rx = self.watch.subscribe();
        let started = *rx.borrow_and_update();
        let halted = async move {
            loop {
                if *rx.borrow_and_update() != started {
                    return;
                }
                if rx.changed().await.is_err() {
                    // Sender gone means the process is shutting down; never
                    // resolve, and let `fut` finish or be dropped with it.
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            result = fut => result,
            _ = halted => Err(HALTED.to_string()),
        }
    }

    /// Run a process to completion under supervision, so a halt can stop it.
    ///
    /// The drop-in replacement for `Command::output()` everywhere Atlas runs a
    /// tool — same `io::Result`, so a caller's `ErrorKind::NotFound` fallback
    /// keeps working. A halt surfaces as `ErrorKind::Interrupted` carrying
    /// `HALTED`; `describe` turns either into the message to show. Stdin is
    /// closed (nothing here is interactive), and both pipes are drained by
    /// `wait_with_output`, which cannot deadlock on a full pipe.
    pub fn run(&self, mut cmd: Command) -> std::io::Result<Output> {
        let halted = || std::io::Error::new(std::io::ErrorKind::Interrupted, HALTED);
        if self.is_halted() {
            return Err(halted());
        }
        let started = self.epoch();

        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = cmd.spawn()?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let process = child.as_raw_handle() as isize;
        let job = assign_job(process);
        self.processes
            .lock()
            .unwrap()
            .push(Supervised { id, pid: child.id(), process, job });

        // A halt that landed between `check()` and the push above found
        // nothing to stop. Catch it here rather than leave a build running
        // under a latch that says nothing is.
        if self.epoch() != started {
            self.stop_processes();
        }

        let output = child.wait_with_output();
        self.unregister(id);

        if self.epoch() != started {
            return Err(halted());
        }
        output
    }

    fn unregister(&self, id: u64) {
        let mut list = self.processes.lock().unwrap();
        if let Some(pos) = list.iter().position(|p| p.id == id) {
            let entry = list.remove(pos);
            if let Some(job) = entry.job {
                unsafe {
                    let _ = CloseHandle(HANDLE(job as *mut _));
                }
            }
        }
    }

    /// Ask every supervised process to stop, wait out the grace window, then
    /// terminate whatever is left. Holds the list lock throughout, so a
    /// finishing process cannot close its handle while it is being used here.
    fn stop_processes(&self) -> StopReport {
        let list = self.processes.lock().unwrap();
        let mut report = StopReport { found: list.len(), ..Default::default() };
        if list.is_empty() {
            return report;
        }

        let asked = request_interrupt(list.iter().map(|p| p.pid));
        let deadline = Instant::now() + GRACEFUL_WINDOW;

        for entry in list.iter() {
            let exited = asked && {
                let remaining = deadline.saturating_duration_since(Instant::now());
                unsafe {
                    WaitForSingleObject(HANDLE(entry.process as *mut _), remaining.as_millis() as u32)
                        == WAIT_OBJECT_0
                }
            };
            if exited {
                report.exited_on_request += 1;
            } else {
                report.terminated += 1;
            }
            // Always, even for a root that exited on request: anything it
            // spawned and left behind belongs to the same job and goes too.
            match entry.job {
                Some(job) => unsafe {
                    let _ = TerminateJobObject(HANDLE(job as *mut _), TERMINATED_EXIT_CODE);
                },
                None => force_kill_tree(entry.pid),
            }
        }
        report
    }
}

/// Put a freshly spawned process in its own Job Object, so terminating the job
/// takes every descendant with it — `pnpm test` is `cmd` → `pnpm` → `node` →
/// workers, and killing only the first of those orphans the rest.
fn assign_job(process: isize) -> Option<isize> {
    unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        if AssignProcessToJobObject(job, HANDLE(process as *mut _)).is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(job.0 as isize)
    }
}

/// The message for a failed `Halt::run`: `HALTED` when a halt caused it, so the
/// renderer recognises it, and the caller's own wording for anything else.
pub fn describe(error: &std::io::Error, otherwise: impl FnOnce() -> String) -> String {
    if error.kind() == std::io::ErrorKind::Interrupted && error.to_string() == HALTED {
        HALTED.to_string()
    } else {
        otherwise()
    }
}

fn force_kill_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd.status();
}

/// Send Ctrl+C to each process's console — the polite request.
///
/// Tools run with `CREATE_NO_WINDOW` still own a (hidden) console, and Ctrl+C
/// on it is exactly what they would get from a terminal. Getting it there
/// means briefly attaching to that console, which is process-wide state, so it
/// is skipped entirely when Atlas already has a console of its own (a debug
/// build launched from a terminal) — detaching from that would lose its logs,
/// and the force path below is still inside the budget.
///
/// Returns whether a request was actually sent to at least one process.
fn request_interrupt(pids: impl Iterator<Item = u32>) -> bool {
    unsafe {
        if !GetConsoleWindow().0.is_null() {
            return false;
        }
        // Ignore the Ctrl+C we are about to raise, while attached to a console
        // that will deliver it to us too.
        if SetConsoleCtrlHandler(None, BOOL::from(true)).is_err() {
            return false;
        }
        let mut sent = false;
        for pid in pids {
            if AttachConsole(pid).is_ok() {
                sent |= GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0).is_ok();
                let _ = FreeConsole();
            }
        }
        // The event is delivered asynchronously; restoring the handler before
        // it lands is how a process ends up interrupting itself. Atlas holds
        // no console after `FreeConsole`, so waiting costs nothing.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = SetConsoleCtrlHandler(None, BOOL::from(false));
        });
        sent
    }
}

/// The one app-wide instance every hand command checks.
pub fn global() -> &'static Halt {
    static GLOBAL: OnceLock<Halt> = OnceLock::new();
    GLOBAL.get_or_init(Halt::new)
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

/// A parsed, validated stop key. `label` is the canonical spelling
/// (`Ctrl+Alt+Shift+Win+Key`), which is what is stored and shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shortcut {
    pub modifiers: u32,
    pub vk: u32,
    pub label: String,
}

/// Keys a stop may use *on its own*: nothing types them, and no application
/// depends on them the way it depends on Escape or a letter.
fn standalone_key(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    if let Some(n) = upper.strip_prefix('F').and_then(|d| d.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x70 + n - 1);
        }
    }
    match upper.as_str() {
        "PAUSE" => Some(0x13),
        "SCROLLLOCK" => Some(0x91),
        _ => None,
    }
}

/// Keys that need a Ctrl, Alt or Win alongside them, because on their own (or
/// with only Shift) they are typing or navigation someone is doing right now.
fn modified_key(name: &str) -> Option<u32> {
    let upper = name.to_ascii_uppercase();
    if upper.len() == 1 {
        let c = upper.as_bytes()[0];
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(c as u32);
        }
    }
    Some(match upper.as_str() {
        "SPACE" => 0x20,
        "ESCAPE" => 0x1B,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        _ => return None,
    })
}

fn canonical_key(name: &str) -> String {
    let upper = name.to_ascii_uppercase();
    match upper.as_str() {
        "PAUSE" => "Pause".into(),
        "SCROLLLOCK" => "ScrollLock".into(),
        "SPACE" => "Space".into(),
        "ESCAPE" => "Escape".into(),
        "INSERT" => "Insert".into(),
        "DELETE" => "Delete".into(),
        "HOME" => "Home".into(),
        "END" => "End".into(),
        "PAGEUP" => "PageUp".into(),
        "PAGEDOWN" => "PageDown".into(),
        _ => upper,
    }
}

/// Mirrors `parseHaltShortcut` in `@atlas/core` rule for rule — the renderer
/// checks first so Settings can explain a refusal as it is typed, and this
/// checks again because the renderer is not the security boundary.
pub fn parse_shortcut(text: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = text.split('+').map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Err("That isn't a complete shortcut.".into());
    }
    let (key, mods) = parts.split_last().ok_or("That isn't a complete shortcut.")?;

    let (mut ctrl, mut alt, mut shift, mut win) = (false, false, false, false);
    for m in mods {
        let slot = match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => &mut ctrl,
            "alt" => &mut alt,
            "shift" => &mut shift,
            "win" | "windows" | "meta" | "super" => &mut win,
            _ => return Err(format!("“{m}” isn't a modifier key.")),
        };
        if *slot {
            return Err("A modifier is listed twice.".into());
        }
        *slot = true;
    }

    let vk = if let Some(vk) = standalone_key(key) {
        vk
    } else if let Some(vk) = modified_key(key) {
        if !(ctrl || alt || win) {
            return Err(format!(
                "{} on its own is something you type. Add Ctrl, Alt or Win.",
                canonical_key(key)
            ));
        }
        let letter_or_digit = key.len() == 1;
        let modifier_count = [ctrl, alt, shift, win].iter().filter(|m| **m).count();
        if letter_or_digit && modifier_count < 2 && !win {
            return Err(format!(
                "Ctrl+{0} or Alt+{0} is already a shortcut in most apps. Use two modifiers, like Ctrl+Alt+{0}.",
                canonical_key(key)
            ));
        }
        vk
    } else {
        return Err(format!("“{key}” can't be used as a stop key."));
    };

    let label_key = canonical_key(key);
    if ctrl && !alt && !shift && !win && label_key == "Space" {
        return Err("Ctrl+Space already summons Atlas.".into());
    }
    if alt && !ctrl && !shift && !win && label_key == "F4" {
        return Err("Alt+F4 closes windows — pick something that doesn't.".into());
    }
    if ctrl && alt && label_key == "Delete" {
        return Err("Ctrl+Alt+Delete belongs to Windows.".into());
    }

    let mut modifiers = 0u32;
    let mut label = String::new();
    for (on, flag, name) in [
        (ctrl, MOD_CONTROL, "Ctrl"),
        (alt, MOD_ALT, "Alt"),
        (shift, MOD_SHIFT, "Shift"),
        (win, MOD_WIN, "Win"),
    ] {
        if on {
            modifiers |= flag.0;
            label.push_str(name);
            label.push('+');
        }
    }
    label.push_str(&label_key);
    Ok(Shortcut { modifiers, vk, label })
}

// ── The hotkey thread ────────────────────────────────────────────────────────

const HOTKEY_ID: i32 = 0xA71A;
const WM_REBIND: u32 = WM_APP + 0x4A;

/// What Settings shows: which key is live right now, and why not if none is.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ShortcutStatus {
    /// The key actually registered with Windows, if any.
    pub active: Option<String>,
    /// Why the requested key isn't the active one (in use elsewhere, refused).
    pub error: Option<String>,
}

pub struct HotkeyThread {
    thread_id: u32,
    request: Mutex<Option<(Shortcut, mpsc::Sender<Result<(), String>>)>>,
    status: Mutex<ShortcutStatus>,
}

fn register(shortcut: &Shortcut) -> Result<(), String> {
    unsafe {
        RegisterHotKey(
            HWND::default(),
            HOTKEY_ID,
            HOT_KEY_MODIFIERS(shortcut.modifiers) | MOD_NOREPEAT,
            shortcut.vk,
        )
    }
    .map_err(|_| format!("{} is already in use by another app.", shortcut.label))
}

impl HotkeyThread {
    /// Start the thread and register `preferred`, falling back to `fallback`
    /// if Windows refuses it. A stop key that silently isn't registered is the
    /// worst outcome here, so a refused preference still leaves *a* key live.
    pub fn spawn(
        preferred: Shortcut,
        fallback: Shortcut,
        on_press: impl Fn() + Send + 'static,
    ) -> Result<&'static HotkeyThread, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<(u32, ShortcutStatus)>();
        // Leaked on purpose: the thread lives as long as the process, and a
        // `'static` reference is what lets both it and every command share one.
        let slot: &'static OnceLock<HotkeyThread> = Box::leak(Box::new(OnceLock::new()));

        std::thread::Builder::new()
            .name("atlas-halt-hotkey".into())
            .spawn(move || unsafe {
                let mut msg = MSG::default();
                // Creates this thread's message queue before anyone posts to it.
                let _ = PeekMessageW(&mut msg, HWND::default(), WM_APP, WM_APP, PM_NOREMOVE);

                let mut current: Option<Shortcut> = None;
                let status = match register(&preferred) {
                    Ok(()) => {
                        current = Some(preferred.clone());
                        ShortcutStatus { active: Some(preferred.label.clone()), error: None }
                    }
                    Err(first) if preferred != fallback => match register(&fallback) {
                        Ok(()) => {
                            current = Some(fallback.clone());
                            ShortcutStatus {
                                active: Some(fallback.label.clone()),
                                error: Some(format!("{first} Using {} instead.", fallback.label)),
                            }
                        }
                        Err(second) => ShortcutStatus { active: None, error: Some(format!("{first} {second}")) },
                    },
                    Err(first) => ShortcutStatus { active: None, error: Some(first) },
                };
                let _ = ready_tx.send((GetCurrentThreadId(), status));

                while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                    match msg.message {
                        WM_HOTKEY if msg.wParam.0 as i32 == HOTKEY_ID => on_press(),
                        WM_REBIND => {
                            let Some(me) = slot.get() else { continue };
                            let Some((next, reply)) = me.request.lock().unwrap().take() else { continue };
                            let _ = UnregisterHotKey(HWND::default(), HOTKEY_ID);
                            let result = register(&next);
                            let mut status = me.status.lock().unwrap();
                            match &result {
                                Ok(()) => {
                                    current = Some(next.clone());
                                    *status = ShortcutStatus { active: Some(next.label.clone()), error: None };
                                }
                                Err(e) => {
                                    // Put the old key back: failing to rebind
                                    // must never leave Atlas with no stop key.
                                    let restored = current.as_ref().map(|c| register(c).is_ok()).unwrap_or(false);
                                    if !restored {
                                        current = None;
                                    }
                                    *status = ShortcutStatus {
                                        active: current.as_ref().map(|c| c.label.clone()),
                                        error: Some(e.clone()),
                                    };
                                }
                            }
                            let _ = reply.send(result);
                        }
                        WM_QUIT => break,
                        _ => {}
                    }
                }
                let _ = UnregisterHotKey(HWND::default(), HOTKEY_ID);
            })
            .map_err(|e| e.to_string())?;

        let (thread_id, status) = ready_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "The stop-key thread didn't start.".to_string())?;
        let _ = slot.set(HotkeyThread { thread_id, request: Mutex::new(None), status: Mutex::new(status) });
        Ok(slot.get().expect("just set"))
    }

    pub fn status(&self) -> ShortcutStatus {
        self.status.lock().unwrap().clone()
    }

    /// Swap the registered key. On failure the previous key stays registered
    /// and the error says why.
    pub fn rebind(&self, next: Shortcut) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        *self.request.lock().unwrap() = Some((next, tx));
        unsafe { PostThreadMessageW(self.thread_id, WM_REBIND, WPARAM(0), LPARAM(0)) }
            .map_err(|e| e.message())?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "The stop-key thread didn't answer.".to_string())?
    }

    #[cfg(test)]
    fn quit(&self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

static HOTKEYS: OnceLock<&'static HotkeyThread> = OnceLock::new();

/// Called once from `setup`. `saved` is whatever Settings stored last time.
pub fn start(app: tauri::AppHandle, saved: Option<String>) {
    use tauri::{Emitter, Manager};

    let fallback = parse_shortcut(DEFAULT_SHORTCUT).expect("the default stop key is valid");
    let preferred = saved.and_then(|s| parse_shortcut(&s).ok()).unwrap_or_else(|| fallback.clone());

    let handle = app.clone();
    let spawned = HotkeyThread::spawn(preferred, fallback, move || {
        let app = handle.clone();
        let (epoch, report) = global().trigger(|epoch| {
            let _ = app.emit("atlas://halt", HaltEvent { epoch, source: "shortcut" });
            // Show the state, not just set it: when Atlas is driving another
            // window, its own is usually hidden or behind.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
        log_report(epoch, "shortcut", &report);
    });

    match spawned {
        Ok(thread) => {
            if let Some(error) = thread.status().error {
                crate::diagnostics::log_diagnostic("halt".into(), error);
            }
            let _ = HOTKEYS.set(thread);
        }
        Err(e) => crate::diagnostics::log_diagnostic("halt".into(), format!("stop key unavailable: {e}")),
    }
}

fn log_report(epoch: u64, source: &str, report: &StopReport) {
    if report.found == 0 {
        return;
    }
    crate::diagnostics::log_diagnostic(
        "halt".into(),
        format!(
            "halt #{epoch} ({source}): {} process(es) — {} exited on Ctrl+C, {} terminated",
            report.found, report.exited_on_request, report.terminated
        ),
    );
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct HaltEvent {
    pub epoch: u64,
    pub source: &'static str,
}

#[derive(Serialize)]
pub struct HaltStatus {
    pub halted: bool,
    pub epoch: u64,
    pub shortcut: ShortcutStatus,
    #[serde(rename = "defaultShortcut")]
    pub default_shortcut: &'static str,
}

fn status_now() -> HaltStatus {
    HaltStatus {
        halted: global().is_halted(),
        epoch: global().epoch(),
        shortcut: HOTKEYS.get().map(|h| h.status()).unwrap_or_default(),
        default_shortcut: DEFAULT_SHORTCUT,
    }
}

/// The on-screen stop button. Same path as the key, so the two can never
/// disagree about what stopping means.
#[tauri::command]
pub async fn halt_now(app: tauri::AppHandle) -> Result<u64, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let (epoch, report) = global().trigger(|epoch| {
            let _ = app.emit("atlas://halt", HaltEvent { epoch, source: "button" });
        });
        log_report(epoch, "button", &report);
        epoch
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn halt_status() -> HaltStatus {
    status_now()
}

#[tauri::command]
pub fn halt_reset(epoch: u64) -> bool {
    global().reset(epoch)
}

/// Rebind the stop key, and remember it only once Windows has accepted it.
#[tauri::command]
pub async fn set_halt_shortcut(
    app: tauri::AppHandle,
    shortcut: String,
) -> Result<HaltStatus, String> {
    use tauri::Manager;
    let parsed = parse_shortcut(&shortcut)?;
    let label = parsed.label.clone();
    let hotkeys = *HOTKEYS.get().ok_or("The stop key isn't available in this session.")?;
    tauri::async_runtime::spawn_blocking(move || hotkeys.rebind(parsed))
        .await
        .map_err(|e| e.to_string())??;
    let saved = crate::storage::storage_set(
        app.clone(),
        app.state::<crate::storage::StorageState>(),
        SHORTCUT_STORAGE_KEY.into(),
        serde_json::Value::String(label),
    );
    let mut status = status_now();
    // The key is live either way — Windows has it — so report that truthfully
    // rather than failing a rebind that already happened.
    if let Err(e) = saved {
        status.shortcut.error = Some(format!("Active now, but not saved for next launch: {e}"));
    }
    Ok(status)
}

/// Lowercase on purpose: `storage.rs` only accepts `[a-z0-9._-]` keys.
pub const SHORTCUT_STORAGE_KEY: &str = "atlas.halt-shortcut";

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn no_window(cmd: &mut Command) {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    /// Caught in the real app: the first name for this key had a capital
    /// letter, storage refused it, and a rebind that Windows had already
    /// accepted was reported as a failure.
    #[test]
    fn the_shortcut_storage_key_is_one_storage_accepts() {
        assert!(crate::storage::is_valid_key(SHORTCUT_STORAGE_KEY));
    }

    #[test]
    fn the_latch_refuses_until_reset_with_the_epoch_it_names() {
        let halt = Halt::new();
        assert!(halt.check().is_ok());
        let (epoch, _) = halt.trigger(|_| {});
        assert_eq!(halt.check().unwrap_err(), HALTED);
        assert!(!halt.reset(epoch - 1), "a stale epoch must not clear a newer halt");
        assert!(halt.check().is_err());
        assert!(halt.reset(epoch));
        assert!(halt.check().is_ok());
    }

    #[test]
    fn the_surface_hears_about_a_halt_before_processes_are_stopped() {
        let halt = Halt::new();
        let seen = std::cell::Cell::new(0);
        let (epoch, _) = halt.trigger(|e| seen.set(e));
        assert_eq!(seen.get(), epoch);
    }

    #[test]
    fn a_long_running_process_is_stopped_well_inside_one_second() {
        let halt = Arc::new(Halt::new());
        let runner = Arc::clone(&halt);
        let worker = std::thread::spawn(move || {
            // ~30 seconds if nothing stops it.
            let mut cmd = Command::new("ping");
            cmd.args(["-n", "30", "127.0.0.1"]);
            no_window(&mut cmd);
            runner.run(cmd)
        });

        // Let it actually start before pulling the plug.
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(halt.processes.lock().unwrap().len(), 1, "the process should be supervised");

        let pressed = Instant::now();
        let (_, report) = halt.trigger(|_| {});
        let result = worker.join().unwrap();
        let elapsed = pressed.elapsed();

        assert_eq!(describe(&result.unwrap_err(), String::new), HALTED);
        assert_eq!(report.found, 1);
        assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
        assert!(halt.processes.lock().unwrap().is_empty(), "finished processes are unregistered");
    }

    #[test]
    fn grandchildren_go_down_with_the_job() {
        let halt = Arc::new(Halt::new());
        let runner = Arc::clone(&halt);
        let worker = std::thread::spawn(move || {
            // cmd → ping: the same parent/child shape as cmd → pnpm → node.
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "ping -n 30 127.0.0.1"]);
            no_window(&mut cmd);
            runner.run(cmd)
        });
        std::thread::sleep(Duration::from_millis(500));

        let pressed = Instant::now();
        halt.trigger(|_| {});
        // `wait_with_output` only returns once every holder of the pipes has
        // exited — an orphaned ping would keep this blocked for 30 seconds.
        let result = worker.join().unwrap();
        assert!(result.is_err());
        assert!(pressed.elapsed() < Duration::from_secs(1), "took {:?}", pressed.elapsed());
    }

    #[test]
    fn nothing_starts_while_halted() {
        let halt = Halt::new();
        halt.trigger(|_| {});
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "echo should-not-run"]);
        assert_eq!(describe(&halt.run(cmd).unwrap_err(), String::new), HALTED);
    }

    #[test]
    fn an_unhalted_process_returns_its_output_as_before() {
        let halt = Halt::new();
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "echo supervised"]);
        no_window(&mut cmd);
        let out = halt.run(cmd).unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("supervised"));
    }

    #[test]
    fn a_stalled_request_is_abandoned_the_moment_a_halt_lands() {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let halt = Arc::new(Halt::new());
        let racer = Arc::clone(&halt);
        let pressed = rt.block_on(async move {
            let task = tokio::spawn(async move {
                racer
                    .race(async {
                        // A model that never answers.
                        std::future::pending::<Result<(), String>>().await
                    })
                    .await
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            let pressed = Instant::now();
            halt.trigger(|_| {});
            assert_eq!(task.await.unwrap().unwrap_err(), HALTED);
            pressed.elapsed()
        });
        assert!(pressed < Duration::from_millis(100), "took {pressed:?}");
    }

    #[test]
    fn a_race_that_finishes_first_is_unaffected() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let halt = Halt::new();
        let value = rt.block_on(halt.race(async { Ok::<_, String>(7) }));
        assert_eq!(value.unwrap(), 7);
    }

    #[test]
    fn shortcuts_parse_to_a_canonical_label() {
        assert_eq!(parse_shortcut("F8").unwrap().label, "F8");
        assert_eq!(parse_shortcut("f8").unwrap().vk, 0x77);
        assert_eq!(parse_shortcut("shift+ctrl+f12").unwrap().label, "Ctrl+Shift+F12");
        assert_eq!(parse_shortcut("Pause").unwrap().vk, 0x13);
        assert_eq!(parse_shortcut("Ctrl+Alt+H").unwrap().label, "Ctrl+Alt+H");
        assert_eq!(parse_shortcut("Win+Escape").unwrap().label, "Win+Escape");
        assert_eq!(parse_shortcut("Ctrl+Alt+PageDown").unwrap().label, "Ctrl+Alt+PageDown");
    }

    #[test]
    fn shortcuts_that_would_steal_typing_or_system_keys_are_refused() {
        for bad in [
            "H", "Shift+H", "Ctrl+C", "Alt+X", "Escape", "Shift+Delete", "Space", "Ctrl+Space",
            "Alt+F4", "Ctrl+Alt+Delete", "Ctrl+Ctrl+F8", "Hyper+F8", "Ctrl+", "", "Tab", "Ctrl+Alt+Tab",
        ] {
            assert!(parse_shortcut(bad).is_err(), "{bad} should be refused");
        }
    }

    /// Real registration, real key press, real message loop. F24 because no
    /// keyboard has one and no app listens for it, and `RegisterHotKey`
    /// swallows the press, so nothing reaches whatever window has focus.
    #[test]
    fn the_hotkey_thread_fires_on_a_real_key_press_and_rebinds() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
            VIRTUAL_KEY,
        };
        fn tap(vk: u16) {
            let key = |flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                },
            };
            let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
            unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        }

        let (tx, rx) = mpsc::channel();
        let f24 = parse_shortcut("F24").unwrap();
        let thread = HotkeyThread::spawn(f24.clone(), f24, move || {
            let _ = tx.send(Instant::now());
        })
        .unwrap();
        assert_eq!(thread.status().active.as_deref(), Some("F24"));

        let pressed = Instant::now();
        tap(0x87); // VK_F24
        let fired = rx.recv_timeout(Duration::from_secs(1)).expect("the stop key never fired");
        assert!(fired.duration_since(pressed) < Duration::from_millis(250));

        thread.rebind(parse_shortcut("Ctrl+Alt+Shift+F23").unwrap()).unwrap();
        assert_eq!(thread.status().active.as_deref(), Some("Ctrl+Alt+Shift+F23"));
        tap(0x87);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "the old key must be released");

        thread.quit();
    }
}
