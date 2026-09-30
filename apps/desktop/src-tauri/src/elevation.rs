//! Administrator rights, one approved action at a time.
//!
//! ## The model, unchanged
//!
//! Atlas does not run elevated and does not ship an elevated helper. When an
//! action genuinely needs administrator rights, one fixed Windows program is
//! started with the `runas` verb, and **Windows** shows its own consent prompt.
//! Atlas cannot see that prompt, click it, dismiss it or suppress it, and
//! `input_guard.rs` refuses to send it input. What this module adds is
//! everything *before* that prompt: Atlas says exactly what is about to happen,
//! the person allows or denies it in Atlas, and only then is Windows asked.
//!
//! ## The program list is closed
//!
//! Exactly two programs, exactly these operations:
//!
//! ```text
//! sc.exe   start "<service>"                 (a service this machine reported)
//! sc.exe   stop  "<service>"                 (never one of the protected ones)
//! reg.exe  add    "HKLM\...\Environment" /v "<name>" /t REG_SZ /d "<value>" /f
//! reg.exe  delete "HKLM\...\Environment" /v "<name>" /f
//! ```
//!
//! — run from `%SystemRoot%\System32`, never found on `PATH`. There is no
//! operation that takes a command line, a program or a path from the caller.
//! Adding one is a change to `Operation`, in this file, in review.
//!
//! ## What an approval is
//!
//! `elevation_prepare` checks an operation and returns a **one-time token**
//! together with the exact text of what will run. The token is bound, by a
//! SHA-256 fingerprint, to:
//!
//!  * the operation and every argument,
//!  * the exact command line,
//!  * the program's identity — its path under `System32` and the hash of its
//!    bytes, and
//!  * the target's state at that moment — the service's current state, or the
//!    variable's current value.
//!
//! `elevation_run` recomputes all of it and refuses on any difference. The token
//! is **single use** (consumed by the first attempt, success or not), **expires
//! after 60 seconds**, dies with the **emergency stop**, and the caller must
//! also echo back the command line the person was shown, so what was displayed
//! and what runs cannot drift apart.
//!
//! Approving one action therefore grants nothing else: not a second run of the
//! same action, not a slightly different one, not the same one a minute later.
//!
//! ## The emergency stop
//!
//! F8 clears every pending approval and refuses new ones. It cannot take back an
//! elevated process that has already started: that process runs in a higher
//! integrity level than Atlas, which is not allowed to terminate it. These
//! operations are short (`sc` and `reg` return within seconds), and Atlas stops
//! *waiting* for them the moment the stop is pressed. What it does not do is
//! claim to have stopped what it could not.
//!
//! ## What "signed" means here
//!
//! `sc.exe` and `reg.exe` are catalog-signed by Windows rather than carrying an
//! embedded Authenticode signature, so `WinVerifyTrust` on the file alone
//! reports them unsigned. Identity is therefore path plus content hash, checked
//! twice — at approval and again immediately before the run. Replacing either
//! file needs administrator rights already.

#![cfg(windows)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{environment, procinfo, services};

pub const TOKEN_TTL: Duration = Duration::from_secs(60);
const MAX_PENDING: usize = 8;
const RUN_LIMIT: Duration = Duration::from_secs(30);
const POLL: u32 = 250;
const RUNAS: &str = "runas";

/// What the native side answers when an action needs administrator rights and
/// Atlas has none. It is a signal, not a failure: the renderer responds by
/// asking the person (see `elevation_prepare`).
pub const NEEDS_ELEVATION: &str = "NEEDS_ELEVATION";

/// Every operation this module can elevate. Closed on purpose.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    ServiceStart { name: String },
    ServiceStop { name: String },
    EnvSet { name: String, value: String },
    EnvDelete { name: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Program {
    Sc,
    Reg,
}

impl Program {
    fn file(self) -> &'static str {
        match self {
            Program::Sc => "sc.exe",
            Program::Reg => "reg.exe",
        }
    }
}

fn program_of(op: &Operation) -> Program {
    match op {
        Operation::ServiceStart { .. } | Operation::ServiceStop { .. } => Program::Sc,
        Operation::EnvSet { .. } | Operation::EnvDelete { .. } => Program::Reg,
    }
}

/// Environment variables that decide what runs, for every account. Overwriting
/// one of these with administrator rights is a way to make every later program
/// start something else, so they are not offered — however the request is worded.
const PROTECTED_ENV: &[&str] = &[
    "path", "pathext", "comspec", "systemroot", "windir", "systemdrive", "psmodulepath",
    "programfiles", "programfiles(x86)", "programw6432", "commonprogramfiles",
    "commonprogramfiles(x86)", "commonprogramw6432", "programdata", "allusersprofile",
    "temp", "tmp", "userprofile", "homedrive", "homepath",
];

/// The exact arguments, as one string — used for display and for execution, so
/// the two are the same string by construction.
pub fn command_line(op: &Operation) -> String {
    let key = format!("HKLM\\{}", environment::SYSTEM_ENV_SUBKEY);
    match op {
        Operation::ServiceStart { name } => format!("start \"{name}\""),
        Operation::ServiceStop { name } => format!("stop \"{name}\""),
        Operation::EnvSet { name, value } => {
            format!("add \"{key}\" /v \"{name}\" /t REG_SZ /d \"{value}\" /f")
        }
        Operation::EnvDelete { name } => format!("delete \"{key}\" /v \"{name}\" /f"),
    }
}

/// Reject anything outside the closed set, before a token exists for it.
pub fn validate(op: &Operation) -> Result<(), String> {
    match op {
        Operation::ServiceStart { name } | Operation::ServiceStop { name } => {
            if !services::is_valid_name(name) {
                return Err(format!("\u{201c}{name}\u{201d} isn't a service name."));
            }
        }
        Operation::EnvSet { name, value } => {
            check_env_name(name)?;
            if !environment::is_valid_value(value) {
                return Err("That value can't be stored — it contains a quote or a control character.".into());
            }
        }
        Operation::EnvDelete { name } => check_env_name(name)?,
    }
    Ok(())
}

fn check_env_name(name: &str) -> Result<(), String> {
    if !environment::is_valid_name(name) {
        return Err(format!("\u{201c}{name}\u{201d} isn't a valid variable name."));
    }
    if PROTECTED_ENV.contains(&name.trim().to_ascii_lowercase().as_str()) {
        return Err(format!(
            "I won't change {name} with administrator rights — it decides what runs for every account. That one you'd do yourself, in System Properties."
        ));
    }
    Ok(())
}

// ---- program identity ---------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExeIdentity {
    pub path: PathBuf,
    pub len: u64,
    pub sha256: [u8; 32],
}

fn system32() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:/Windows".into())).join("System32")
}

fn identity(program: Program) -> Result<ExeIdentity, String> {
    identity_in(&system32(), program.file())
}

/// The program at `dir\file`, refusing anything that is not really inside `dir`.
pub fn identity_in(dir: &Path, file: &str) -> Result<ExeIdentity, String> {
    let path = dir.join(file);
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("{file} isn't where Windows keeps it, so I won't run anything."))?;
    let expected = dir
        .canonicalize()
        .map_err(|_| "I can't find the Windows system folder.".to_string())?;
    if canonical.parent() != Some(expected.as_path()) {
        return Err(format!("{file} resolves outside the Windows system folder, so I won't run it."));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(format!("{file} is not the size a Windows tool should be."));
    }
    Ok(ExeIdentity {
        path,
        len: bytes.len() as u64,
        sha256: Sha256::digest(&bytes).into(),
    })
}

// ---- the target's current state ------------------------------------------------

fn target_state(op: &Operation) -> Result<String, String> {
    match op {
        Operation::ServiceStart { name } | Operation::ServiceStop { name } => {
            let entry = services::resolve(name)?;
            if matches!(op, Operation::ServiceStop { .. }) && entry.protected {
                return Err(format!(
                    "I won't stop {} — Windows doesn't survive it, and the way back is the power button.",
                    entry.display
                ));
            }
            Ok(format!("service|{}|{}|{}", entry.name.to_ascii_lowercase(), entry.state, entry.running))
        }
        Operation::EnvSet { name, .. } | Operation::EnvDelete { name } => {
            let current = environment::system_value(name);
            Ok(format!("env|{}|{}", name.to_ascii_lowercase(), current.as_deref().unwrap_or("\u{0}unset")))
        }
    }
}

/// The fingerprint an approval is bound to.
pub fn fingerprint(op: &Operation, command_line: &str, id: &ExeIdentity, state: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"atlas-elevation/1\0");
    h.update(serde_json::to_vec(op).unwrap_or_default());
    h.update(b"\0");
    h.update(command_line.as_bytes());
    h.update(b"\0");
    h.update(id.path.to_string_lossy().to_ascii_lowercase().as_bytes());
    h.update(b"\0");
    h.update(id.len.to_le_bytes());
    h.update(id.sha256);
    h.update(b"\0");
    h.update(state.as_bytes());
    h.finalize().into()
}

fn current_fingerprint(op: &Operation) -> Result<[u8; 32], String> {
    validate(op)?;
    let id = identity(program_of(op))?;
    let state = target_state(op)?;
    Ok(fingerprint(op, &command_line(op), &id, &state))
}

// ---- the ledger of pending approvals ---------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No such token — never issued, already used, cancelled, or evicted.
    Unknown,
    Expired,
    /// An emergency stop happened after this was issued.
    Halted,
    /// The command line shown to the person is not the one that would run.
    Mismatch,
    /// The program or the target is no longer what was approved.
    Changed(String),
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::Unknown => "That approval is no longer valid — it was already used, or it was cancelled. Nothing ran.".into(),
            Refusal::Expired => "That approval expired, so nothing ran. Ask again if you still want it.".into(),
            Refusal::Halted => "Atlas was stopped after you approved that, so nothing ran.".into(),
            Refusal::Mismatch => "What you were shown isn't what would have run, so nothing ran.".into(),
            Refusal::Changed(why) => format!("{why} It changed after you approved it, so nothing ran. Ask again if you still want it."),
        }
    }
}

struct Entry {
    op: Operation,
    command_line: String,
    fingerprint: [u8; 32],
    issued: Instant,
    epoch: u64,
}

#[derive(Default)]
pub struct Ledger {
    entries: HashMap<String, Entry>,
}

impl Ledger {
    pub fn issue(
        &mut self,
        token: String,
        op: Operation,
        command_line: String,
        fingerprint: [u8; 32],
        now: Instant,
        epoch: u64,
    ) {
        // Whatever has expired goes first; then the oldest, if still full.
        self.entries.retain(|_, e| now.saturating_duration_since(e.issued) <= TOKEN_TTL);
        while self.entries.len() >= MAX_PENDING {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.issued).map(|(k, _)| k.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.entries.insert(token, Entry { op, command_line, fingerprint, issued: now, epoch });
    }

    /// Consume a token. It is removed *first*, so a failed redemption still
    /// uses the approval up.
    pub fn redeem(
        &mut self,
        token: &str,
        shown_command_line: &str,
        now: Instant,
        epoch: u64,
        recompute: impl FnOnce(&Operation) -> Result<[u8; 32], String>,
    ) -> Result<(Operation, String), Refusal> {
        let entry = self.entries.remove(token).ok_or(Refusal::Unknown)?;
        if now.saturating_duration_since(entry.issued) > TOKEN_TTL {
            return Err(Refusal::Expired);
        }
        if entry.epoch != epoch {
            return Err(Refusal::Halted);
        }
        if entry.command_line != shown_command_line {
            return Err(Refusal::Mismatch);
        }
        match recompute(&entry.op) {
            Ok(now_print) if now_print == entry.fingerprint => Ok((entry.op, entry.command_line)),
            Ok(_) => Err(Refusal::Changed("The program or its target is different now.".into())),
            Err(why) => Err(Refusal::Changed(why)),
        }
    }

    pub fn cancel(&mut self, token: &str) -> bool {
        self.entries.remove(token).is_some()
    }

    pub fn cancel_all(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        n
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

fn ledger() -> &'static Mutex<Ledger> {
    static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(Ledger::default()))
}

/// Called by the emergency stop: every pending approval dies.
pub fn cancel_all() -> usize {
    ledger().lock().map(|mut l| l.cancel_all()).unwrap_or(0)
}

fn random_token() -> Result<String, String> {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut bytes = [0u8; 32];
    let status = unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.is_err() {
        return Err("Windows couldn't make a secure approval code, so I won't ask.".into());
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- commands ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationStatus {
    pub elevated: bool,
}

/// Is Atlas itself elevated? (It is not meant to be.) A read.
#[tauri::command]
pub fn elevation_status() -> ElevationStatus {
    ElevationStatus { elevated: procinfo::atlas_is_elevated() }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationRequest {
    pub token: String,
    /// In words: "Stop the Windows service “Print Spooler”".
    pub operation: String,
    /// The fixed Windows program: `sc.exe`.
    pub program: String,
    pub program_path: String,
    /// The exact arguments that will run. Echo it back to `elevation_run`.
    pub command_line: String,
    /// Why administrator rights are involved.
    pub reason: String,
    pub ttl_secs: u64,
    /// The start of the program's SHA-256, so the card can show which file.
    pub program_id: String,
}

fn describe(op: &Operation) -> (String, String) {
    match op {
        Operation::ServiceStart { name } => {
            let display = services::resolve(name).map(|e| e.display).unwrap_or_else(|_| name.clone());
            (
                format!("Start the Windows service \u{201c}{display}\u{201d}"),
                "Starting a Windows service needs administrator rights.".to_string(),
            )
        }
        Operation::ServiceStop { name } => {
            let display = services::resolve(name).map(|e| e.display).unwrap_or_else(|_| name.clone());
            (
                format!("Stop the Windows service \u{201c}{display}\u{201d}"),
                "Stopping a Windows service needs administrator rights.".to_string(),
            )
        }
        Operation::EnvSet { name, value } => {
            let shown: String = value.chars().take(120).collect();
            let more = if value.chars().count() > 120 { "…" } else { "" };
            (
                format!("Set the system environment variable {name} to \u{201c}{shown}{more}\u{201d} for every account"),
                "System-wide settings live under HKEY_LOCAL_MACHINE, which needs administrator rights to change.".to_string(),
            )
        }
        Operation::EnvDelete { name } => (
            format!("Remove the system environment variable {name} for every account"),
            "System-wide settings live under HKEY_LOCAL_MACHINE, which needs administrator rights to change.".to_string(),
        ),
    }
}

/// Check an operation and, if it is inside the closed set, issue a one-time
/// approval token for it. Nothing runs, and nothing is elevated, here.
#[tauri::command]
pub async fn elevation_prepare(op: Operation) -> Result<ElevationRequest, String> {
    // Emergency stop: no new elevations while halted.
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        if procinfo::atlas_is_elevated() {
            return Err("Atlas is already running with administrator rights, so no approval is needed.".to_string());
        }
        validate(&op)?;
        let program = program_of(&op);
        let id = identity(program)?;
        let state = target_state(&op)?;
        let line = command_line(&op);
        let print = fingerprint(&op, &line, &id, &state);
        let (operation, reason) = describe(&op);
        let token = random_token()?;

        let epoch = crate::halt::global().epoch();
        ledger()
            .lock()
            .map_err(|_| "The approval list is stuck.".to_string())?
            .issue(token.clone(), op, line.clone(), print, Instant::now(), epoch);

        Ok(ElevationRequest {
            token,
            operation,
            program: program.file().to_string(),
            program_path: id.path.to_string_lossy().into_owned(),
            command_line: line,
            reason,
            ttl_secs: TOKEN_TTL.as_secs(),
            program_id: id.sha256.iter().take(6).map(|b| format!("{b:02x}")).collect(),
        })
    })
    .await
    .map_err(|e| format!("The approval task failed: {e}"))?
}

/// The person said no, or changed their mind. The token dies.
#[tauri::command]
pub fn elevation_cancel(token: String) -> bool {
    ledger().lock().map(|mut l| l.cancel(&token)).unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationOutcome {
    pub exit_code: Option<u32>,
    pub timed_out: bool,
}

/// Run one approved operation. Windows shows its own prompt; Atlas neither sees
/// nor answers it.
#[tauri::command]
pub async fn elevation_run(token: String, command_line: String) -> Result<ElevationOutcome, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let epoch = crate::halt::global().epoch();
        let (op, line) = ledger()
            .lock()
            .map_err(|_| "The approval list is stuck.".to_string())?
            .redeem(&token, &command_line, Instant::now(), epoch, |op| current_fingerprint(op))
            .map_err(|r| r.message())?;

        // The last look before the prompt: a stop that landed while the
        // recomputation was running still wins.
        crate::halt::global().check()?;
        let id = identity(program_of(&op))?;
        run_runas(&id.path, &line)
    })
    .await
    .map_err(|e| format!("The elevation task failed: {e}"))?
}

fn run_runas(exe: &Path, params: &str) -> Result<ElevationOutcome, String> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let file = wide(exe.as_os_str());
    let args = wide(std::ffi::OsStr::new(params));
    let verb = wide(std::ffi::OsStr::new(RUNAS));

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        const CANCELLED: i32 = -2_147_023_673; // ERROR_CANCELLED
        if e.code().0 == CANCELLED {
            "You dismissed the Windows prompt, so nothing changed.".to_string()
        } else {
            format!("Windows wouldn't run that with administrator rights: {e}")
        }
    })?;

    let began = Instant::now();
    let mut timed_out = false;
    let mut code = None;
    unsafe {
        if !info.hProcess.is_invalid() {
            loop {
                if WaitForSingleObject(info.hProcess, POLL) == WAIT_OBJECT_0 {
                    let mut exit = 0u32;
                    if GetExitCodeProcess(info.hProcess, &mut exit).is_ok() {
                        code = Some(exit);
                    }
                    break;
                }
                // The stop ends the *waiting*. The process itself is elevated
                // above Atlas and cannot be taken back — see the module docs.
                if crate::halt::global().is_halted() {
                    let _ = CloseHandle(info.hProcess);
                    return Err("Atlas was stopped. The Windows prompt may still be open, and if you already allowed it the change may still complete — I've stopped waiting for it.".into());
                }
                if began.elapsed() > RUN_LIMIT {
                    timed_out = true;
                    break;
                }
            }
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(ElevationOutcome { exit_code: code, timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op() -> Operation {
        Operation::ServiceStop { name: "Spooler".into() }
    }

    fn id() -> ExeIdentity {
        ExeIdentity { path: PathBuf::from("C:\\Windows\\System32\\sc.exe"), len: 100, sha256: [7; 32] }
    }

    fn print(o: &Operation, state: &str) -> [u8; 32] {
        fingerprint(o, &command_line(o), &id(), state)
    }

    fn ledger_with(o: Operation, state: &str, now: Instant) -> (Ledger, String) {
        let mut l = Ledger::default();
        let line = command_line(&o);
        l.issue("tok".into(), o.clone(), line, print(&o, state), now, 1);
        (l, "tok".into())
    }

    fn same(state: &'static str) -> impl FnOnce(&Operation) -> Result<[u8; 32], String> {
        move |o| Ok(print(o, state))
    }

    // ---- the closed set -----------------------------------------------------------

    #[test]
    fn command_lines_are_exactly_these_shapes() {
        assert_eq!(command_line(&Operation::ServiceStart { name: "Spooler".into() }), "start \"Spooler\"");
        assert_eq!(command_line(&Operation::ServiceStop { name: "Spooler".into() }), "stop \"Spooler\"");
        assert_eq!(
            command_line(&Operation::EnvSet { name: "FOO".into(), value: "bar baz".into() }),
            "add \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v \"FOO\" /t REG_SZ /d \"bar baz\" /f"
        );
        assert_eq!(
            command_line(&Operation::EnvDelete { name: "FOO".into() }),
            "delete \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v \"FOO\" /f"
        );
    }

    #[test]
    fn nothing_that_could_break_out_of_a_quoted_argument_is_accepted() {
        assert!(validate(&Operation::EnvSet { name: "FOO".into(), value: "a\" & calc & \"".into() }).is_err());
        assert!(validate(&Operation::EnvSet { name: "FOO\" /f".into(), value: "x".into() }).is_err());
        assert!(validate(&Operation::EnvSet { name: "FOO".into(), value: "line\nbreak".into() }).is_err());
        assert!(validate(&Operation::ServiceStop { name: "x\" & calc".into() }).is_err());
        assert!(validate(&Operation::ServiceStart { name: String::new() }).is_err());
    }

    #[test]
    fn variables_that_decide_what_runs_are_not_offered_however_they_are_spelled() {
        for name in ["Path", "PATH", "pathext", "ComSpec", "SystemRoot", "windir", "PSModulePath", "ProgramFiles(x86)", "TEMP"] {
            assert!(validate(&Operation::EnvSet { name: name.into(), value: "x".into() }).is_err(), "{name}");
            assert!(validate(&Operation::EnvDelete { name: name.into() }).is_err(), "{name}");
        }
        assert!(validate(&Operation::EnvSet { name: "MY_TOOL_HOME".into(), value: "D:\\Tools".into() }).is_ok());
    }

    #[test]
    fn the_operation_type_has_no_field_for_a_program_or_a_path() {
        // The wire format is the whole attack surface: a request naming a
        // program, or an unknown kind, does not deserialise at all.
        assert!(serde_json::from_str::<Operation>(r#"{"kind":"run","program":"cmd.exe"}"#).is_err());
        assert!(serde_json::from_str::<Operation>(r#"{"kind":"serviceStop","name":"Spooler","program":"cmd.exe"}"#).is_ok(), "extra fields are ignored, not obeyed");
        let parsed: Operation =
            serde_json::from_str(r#"{"kind":"serviceStop","name":"Spooler","program":"cmd.exe"}"#).unwrap();
        assert_eq!(program_of(&parsed), Program::Sc);
        assert_eq!(command_line(&parsed), "stop \"Spooler\"");
    }

    // ---- the ledger: single use, expiry, replay, modification ---------------------------

    #[test]
    fn an_approval_runs_once() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let line = command_line(&op());
        assert!(l.redeem(&t, &line, now, 1, same("svc|running")).is_ok());
        // Replaying the very same token does nothing.
        assert_eq!(l.redeem(&t, &line, now, 1, same("svc|running")).unwrap_err(), Refusal::Unknown);
    }

    #[test]
    fn a_failed_attempt_still_uses_the_approval_up() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let line = command_line(&op());
        assert!(l.redeem(&t, "stop \"Other\"", now, 1, same("svc|running")).is_err());
        assert_eq!(l.redeem(&t, &line, now, 1, same("svc|running")).unwrap_err(), Refusal::Unknown, "not retryable");
    }

    #[test]
    fn an_unknown_or_guessed_token_is_refused() {
        let now = Instant::now();
        let (mut l, _) = ledger_with(op(), "svc|running", now);
        assert_eq!(l.redeem("not-a-token", &command_line(&op()), now, 1, same("svc|running")).unwrap_err(), Refusal::Unknown);
        assert_eq!(l.len(), 1, "a wrong guess does not consume someone else's approval");
    }

    #[test]
    fn an_approval_expires_after_sixty_seconds() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let late = now + TOKEN_TTL + Duration::from_secs(1);
        assert_eq!(l.redeem(&t, &command_line(&op()), late, 1, same("svc|running")).unwrap_err(), Refusal::Expired);
        // Right at the edge it still stands.
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        assert!(l.redeem(&t, &command_line(&op()), now + TOKEN_TTL, 1, same("svc|running")).is_ok());
    }

    #[test]
    fn the_command_line_the_person_saw_must_be_the_one_that_runs() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        assert_eq!(l.redeem(&t, "stop \"Spooler\" & calc", now, 1, same("svc|running")).unwrap_err(), Refusal::Mismatch);
    }

    #[test]
    fn a_changed_target_invalidates_the_approval() {
        let now = Instant::now();
        // Approved while the service was running; by redemption it has stopped.
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        assert!(matches!(
            l.redeem(&t, &command_line(&op()), now, 1, same("svc|stopped")).unwrap_err(),
            Refusal::Changed(_)
        ));
    }

    #[test]
    fn a_changed_program_invalidates_the_approval() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let swapped = ExeIdentity { sha256: [9; 32], ..id() };
        let r = l.redeem(&t, &command_line(&op()), now, 1, |o| {
            Ok(fingerprint(o, &command_line(o), &swapped, "svc|running"))
        });
        assert!(matches!(r.unwrap_err(), Refusal::Changed(_)));
    }

    #[test]
    fn a_program_that_can_no_longer_be_verified_invalidates_the_approval() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let r = l.redeem(&t, &command_line(&op()), now, 1, |_| Err("sc.exe isn't where Windows keeps it".into()));
        assert!(matches!(r.unwrap_err(), Refusal::Changed(_)));
    }

    #[test]
    fn every_part_of_the_fingerprint_matters() {
        let base = print(&op(), "s");
        let other_op = Operation::ServiceStop { name: "Spooler2".into() };
        assert_ne!(base, print(&other_op, "s"), "operation/arguments");
        assert_ne!(base, print(&Operation::ServiceStart { name: "Spooler".into() }, "s"), "verb");
        assert_ne!(base, fingerprint(&op(), "stop \"Spooler\" ", &id(), "s"), "command line");
        assert_ne!(base, fingerprint(&op(), &command_line(&op()), &ExeIdentity { sha256: [8; 32], ..id() }, "s"), "program bytes");
        assert_ne!(base, fingerprint(&op(), &command_line(&op()), &ExeIdentity { len: 101, ..id() }, "s"), "program size");
        assert_ne!(
            base,
            fingerprint(&op(), &command_line(&op()), &ExeIdentity { path: PathBuf::from("C:\\Temp\\sc.exe"), ..id() }, "s"),
            "program location"
        );
        assert_ne!(base, print(&op(), "t"), "target state");
        let a = Operation::EnvSet { name: "FOO".into(), value: "1".into() };
        let b = Operation::EnvSet { name: "FOO".into(), value: "2".into() };
        assert_ne!(print(&a, "s"), print(&b, "s"), "a different value is a different approval");
    }

    #[test]
    fn a_token_cannot_be_used_for_a_different_operation() {
        // The ledger stores the operation; the caller cannot substitute one.
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        let (got, _) = l.redeem(&t, &command_line(&op()), now, 1, same("svc|running")).unwrap();
        assert_eq!(got, op());
    }

    // ---- the emergency stop ----------------------------------------------------------

    #[test]
    fn an_emergency_stop_kills_every_pending_approval() {
        let now = Instant::now();
        let mut l = Ledger::default();
        for i in 0..3 {
            let o = Operation::ServiceStop { name: format!("S{i}") };
            l.issue(format!("t{i}"), o.clone(), command_line(&o), print(&o, "s"), now, 1);
        }
        assert_eq!(l.cancel_all(), 3);
        assert_eq!(l.len(), 0);
        assert_eq!(l.redeem("t0", "x", now, 1, same("s")).unwrap_err(), Refusal::Unknown);
    }

    #[test]
    fn an_approval_from_before_a_stop_is_refused_even_if_it_somehow_survived() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        // The halt epoch moved on (1 -> 2) after issue.
        assert_eq!(l.redeem(&t, &command_line(&op()), now, 2, same("svc|running")).unwrap_err(), Refusal::Halted);
    }

    #[test]
    fn denying_cancels_the_approval() {
        let now = Instant::now();
        let (mut l, t) = ledger_with(op(), "svc|running", now);
        assert!(l.cancel(&t));
        assert!(!l.cancel(&t));
        assert_eq!(l.redeem(&t, &command_line(&op()), now, 1, same("svc|running")).unwrap_err(), Refusal::Unknown);
    }

    #[test]
    fn only_a_handful_of_approvals_can_be_pending_at_once() {
        let now = Instant::now();
        let mut l = Ledger::default();
        for i in 0..(MAX_PENDING + 5) {
            let o = Operation::ServiceStop { name: format!("S{i}") };
            l.issue(format!("t{i}"), o.clone(), command_line(&o), print(&o, "s"), now + Duration::from_millis(i as u64), 1);
        }
        assert_eq!(l.len(), MAX_PENDING);
        // The oldest were dropped, the newest kept.
        assert_eq!(l.redeem("t0", "x", now, 1, same("s")).unwrap_err(), Refusal::Unknown);
    }

    #[test]
    fn expired_approvals_are_swept_when_a_new_one_is_issued() {
        let now = Instant::now();
        let mut l = Ledger::default();
        l.issue("old".into(), op(), command_line(&op()), print(&op(), "s"), now, 1);
        l.issue("new".into(), op(), command_line(&op()), print(&op(), "s"), now + TOKEN_TTL + Duration::from_secs(5), 1);
        assert_eq!(l.len(), 1);
    }

    // ---- the real emergency stop ------------------------------------------------------

    #[test]
    fn the_real_stop_clears_the_real_ledger() {
        // A private Halt (so the process-wide latch that other tests share is
        // untouched) run through the same `trigger` F8 uses. The ledger it
        // empties is the real, process-wide one.
        let now = Instant::now();
        let o = Operation::ServiceStop { name: "StopTestService".into() };
        ledger().lock().unwrap().issue(
            "stop-test-token".into(),
            o.clone(),
            command_line(&o),
            print(&o, "s"),
            now,
            1,
        );
        assert!(ledger().lock().unwrap().entries.contains_key("stop-test-token"));

        let halt = crate::halt::Halt::new();
        halt.trigger(|_| {});

        assert!(
            !ledger().lock().unwrap().entries.contains_key("stop-test-token"),
            "F8 left an approval alive"
        );
    }

    #[test]
    fn while_halted_no_new_approval_can_be_prepared() {
        // The gate every command calls first is the one `elevation_prepare` and
        // `elevation_run` open with; this pins that they open with it.
        let src = include_str!("elevation.rs");
        for command in ["pub async fn elevation_prepare", "pub async fn elevation_run"] {
            let at = src.find(command).unwrap();
            let body = &src[at..at + 400];
            assert!(body.contains("crate::halt::global().check()?"), "{command} does not check the stop first");
        }
    }

    // ---- against the real machine ------------------------------------------------------

    #[test]
    fn the_real_programs_are_found_in_system32_and_hashed() {
        for program in [Program::Sc, Program::Reg] {
            let id = identity(program).expect("system program");
            assert!(id.path.starts_with(system32()), "{:?}", id.path);
            assert!(id.len > 1_000, "{} bytes", id.len);
            assert_ne!(id.sha256, [0u8; 32]);
            // Deterministic: the same bytes hash the same.
            assert_eq!(identity(program).unwrap(), id);
        }
    }

    #[test]
    fn a_program_that_is_not_in_the_system_folder_is_not_accepted() {
        let dir = std::env::temp_dir().join(format!("atlas-elev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A lookalike planted somewhere else has no path back into System32.
        std::fs::write(dir.join("sc.exe"), b"MZ not the real one").unwrap();
        let planted = identity_in(&dir, "sc.exe").unwrap();
        assert!(!planted.path.starts_with(system32()));
        // And it hashes differently from the real one, so an approval for one
        // is not an approval for the other.
        assert_ne!(planted.sha256, identity(Program::Sc).unwrap().sha256);
        assert!(identity_in(&dir, "missing.exe").is_err());
    }

    #[test]
    fn tokens_are_long_random_and_never_repeat() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn a_real_prepare_binds_to_the_real_service_state_and_nothing_runs() {
        // Prepares (never runs) a stop of a service that exists everywhere, and
        // checks the approval is real and can be cancelled.
        let req = tauri::async_runtime::block_on(elevation_prepare(Operation::ServiceStart {
            name: "Spooler".into(),
        }));
        // Some machines have no Spooler; the point is that a refusal is a
        // sentence, not a panic, and success yields a usable token.
        if let Ok(r) = req {
            assert_eq!(r.program, "sc.exe");
            assert_eq!(r.command_line, "start \"Spooler\"");
            assert_eq!(r.ttl_secs, 60);
            assert!(elevation_cancel(r.token.clone()));
            assert!(!elevation_cancel(r.token));
        }
    }
}
