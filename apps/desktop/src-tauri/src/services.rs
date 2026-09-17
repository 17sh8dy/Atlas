//! Windows services — what is installed, what is running, and starting or
//! stopping one.
//!
//! ## The same pattern `net.rs` sets out, one tier further up
//!
//! Networking was all reads. This module is the first Phase 11 group that
//! *changes the machine*, so it is where both halves of the rule have to hold
//! at once:
//!
//! **The verb is a constant.** Every command below is one of five shapes, and
//! all five are written out in the constants at the top of this file. Nothing
//! composes a command line; there is no string a renderer, a model or a user
//! can steer.
//!
//! **The parameter is checked against a closed set.** A service name is not
//! trusted because it looks reasonable — it is accepted only if it is one of
//! the services this machine actually has, re-resolved here rather than taken
//! on the renderer's word. `is_valid_name` is the cheap syntactic gate;
//! `resolve` is the real one.
//!
//! ## Some things are refused rather than confirmed
//!
//! Phase 11 says the tier above "confirm" is "refused outright", and services
//! are the clearest case in the phase. Stopping the RPC endpoint mapper does
//! not produce an error message, it produces a machine that has to be held
//! down by the power button. There is no confirmation card that makes that a
//! good idea, so `NEVER_STOP` is enforced here, in the process with the hands,
//! rather than only in the UI that draws the card.
//!
//! ## Administrator rights
//!
//! Reading services needs nothing. Starting or stopping one needs
//! administrator rights, and **Atlas deliberately does not run elevated** —
//! every capability it has, including the ones added after this comment, would
//! inherit those rights for the sake of two verbs.
//!
//! So elevation is per action and belongs to the action (`send_elevated`):
//! the ordinary call is tried first, and only once Windows has actually
//! refused does the verb go back through `ShellExecuteEx` with the `runas`
//! verb. Windows then shows its own consent dialog, naming `sc.exe`, and the
//! elevated process exits when the verb is done. Atlas cannot draw that
//! dialog, cannot suppress it, and cannot answer it.
//!
//! Decided by Brandon on 2026-08-22, over both alternatives: reporting the
//! failure honestly and doing nothing, and running the whole app elevated.

use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The program, and every verb it can be given. In full.
///
/// The complete set of commands this module can execute is `SC` with one of
/// these five shapes, where `<name>` is always a service this machine reported
/// having:
///
/// ```text
/// sc query state= all
/// sc query <name>
/// sc qc    <name>
/// sc start <name>
/// sc stop  <name>
/// ```
const SC: &str = "sc.exe";
/// The Windows verb that asks the user, not Atlas, for administrator rights.
const RUNAS: &str = "runas";
const QUERY_ALL: &[&str] = &["query", "state=", "all"];
const VERB_QUERY: &str = "query";
const VERB_CONFIG: &str = "qc";
const VERB_START: &str = "start";
const VERB_STOP: &str = "stop";

/// Services Atlas will not stop, whatever is asked and whatever is confirmed.
///
/// The test for membership is not "important" — plenty of important services
/// are fine to restart, which is the whole point of being able to. It is
/// "stopping this takes the session down with it, and the way back is the
/// power button". Compared lowercase; service names are case-insensitive.
const NEVER_STOP: &[&str] = &[
    "rpcss",                // RPC. Everything in Windows sits on top of it.
    "rpceptmapper",         // The endpoint mapper. As above.
    "dcomlaunch",           // Stopping it is an immediate hard reboot.
    "lsm",                  // Local Session Manager — owns your session.
    "samss",                // Security Accounts Manager.
    "profsvc",              // User Profile Service.
    "gpsvc",                // Group Policy Client. Refuses anyway; be explicit.
    "plugplay",             // Device enumeration, input devices included.
    "power",                // Power policy. Takes the display with it.
    "brokerinfrastructure", // Background tasks the shell itself is built on.
    "systemeventsbroker",   // As above.
    "eventlog",             // Half of Windows blocks on writing to it.
];

#[derive(Debug, Clone, Serialize)]
pub struct ServiceEntry {
    /// The short name `sc` takes: "Spooler".
    pub name: String,
    /// The name a person recognises: "Print Spooler".
    pub display: String,
    /// "RUNNING", "STOPPED", "START_PENDING"…
    pub state: String,
    pub running: bool,
    /// True for one of `NEVER_STOP`, so the UI can say so before offering an
    /// action that would then be refused.
    pub protected: bool,
}

/// ⚠️ `camelCase` is not decoration. Every other struct crossing this seam has
/// single-word fields, so nothing until now noticed that serde sends Rust's
/// spelling by default: `start_type` arrived at a renderer reading
/// `startType`, and "Print Spooler is running, and starts automatically"
/// silently became "Print Spooler is running." Tests could not catch it —
/// both sides were internally consistent — and driving the real app did, in
/// the first sentence it produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetail {
    pub name: String,
    pub display: String,
    pub state: String,
    pub running: bool,
    pub protected: bool,
    /// "automatic", "automatic (delayed)", "manual", "disabled"…
    pub start_type: Option<String>,
    /// What actually runs. Read-only, and never used to build a command.
    pub binary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceOutcome {
    pub name: String,
    pub display: String,
    /// The state observed *after* the action settled.
    ///
    /// Not what `sc` claimed: `sc start` returns while the service is still
    /// START_PENDING, and a service that fails to come up returns success from
    /// the command that asked it to. The only honest answer is to look again
    /// afterwards.
    pub state: String,
    pub running: bool,
    /// Set when nothing needed doing — "it was already running".
    pub note: Option<String>,
}

struct Ran {
    ok: bool,
    text: String,
}

/// Run `sc` with a fixed verb and at most one validated name.
fn run(args: &[&str]) -> Result<Ran, String> {
    let mut cmd = Command::new(SC);
    cmd.args(args);

    // Without this every reading flashes a console window — the same bug that
    // made speech feel broken before it was found.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't ask Windows about its services: {e}"))?;

    // `sc` reports failures on stdout, not stderr ("[SC] OpenService FAILED
    // 5:"), so both are read and the exit status is what decides.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(Ran {
        ok: out.status.success(),
        text,
    })
}

/// The value side of a "LABEL   : value" line, if this is one.
fn value_of(line: &str) -> Option<&str> {
    let (_, value) = line.split_once(':')?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn label_is(line: &str, needle: &str) -> bool {
    line.split_once(':')
        .map(|(label, _)| label.trim().eq_ignore_ascii_case(needle))
        .unwrap_or(false)
}

fn protected(name: &str) -> bool {
    NEVER_STOP.contains(&name.to_ascii_lowercase().as_str())
}

/// Could this string be a service name at all?
///
/// The cheap gate, applied before the string is ever handed to a process. It
/// is not the real check — `resolve` is, because the only names accepted are
/// ones this machine reported having — but it means a malformed value never
/// reaches `sc` in the first place. The leading-character rule matters most: a
/// name beginning `-` or `/` would arrive at `sc` looking like a switch.
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.starts_with(' ')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
}

#[tauri::command]
pub async fn list_services() -> Result<Vec<ServiceEntry>, String> {
    let ran = tauri::async_runtime::spawn_blocking(|| run(QUERY_ALL))
        .await
        .map_err(|e| format!("The services task failed: {e}"))??;
    if !ran.ok {
        return Err("Windows wouldn't list its services.".into());
    }
    Ok(parse_services(&ran.text))
}

/// Read `sc query` output — the multi-service form and the single-service form
/// are the same shape, so one parser reads both.
///
/// Split from the command that produces it so it can be tested without a
/// subprocess. The parsing is what breaks when Windows changes a label, and
/// the part worth pinning.
fn parse_services(text: &str) -> Vec<ServiceEntry> {
    let mut out: Vec<ServiceEntry> = Vec::new();
    let mut current: Option<ServiceEntry> = None;

    for line in text.lines() {
        let trimmed = line.trim();

        if label_is(trimmed, "SERVICE_NAME") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            if let Some(name) = value_of(trimmed) {
                current = Some(ServiceEntry {
                    name: name.to_string(),
                    // A service with no DISPLAY_NAME line is shown under its
                    // own name rather than under an empty string.
                    display: name.to_string(),
                    state: "UNKNOWN".into(),
                    running: false,
                    protected: protected(name),
                });
            }
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if label_is(trimmed, "DISPLAY_NAME") {
            if let Some(display) = value_of(trimmed) {
                entry.display = display.to_string();
            }
        } else if label_is(trimmed, "STATE") {
            // "4  RUNNING" — the number is sc's own enum and the word after it
            // is the answer.
            if let Some(value) = value_of(trimmed) {
                if let Some(word) = value.split_whitespace().last() {
                    entry.state = word.to_string();
                    entry.running = word.eq_ignore_ascii_case("RUNNING");
                }
            }
        }
    }
    if let Some(done) = current.take() {
        out.push(done);
    }

    out.sort_by_key(|s| s.display.to_lowercase());
    out
}

/// The one service this name refers to, as the machine itself reports it.
///
/// Everything that acts goes through here, so no verb is ever given a name
/// that did not come back from `sc query` moments earlier. The renderer
/// resolves friendly names against the same list for its own messages; this
/// resolution is the one that counts, because it is the one next to the
/// process.
fn resolve(name: &str) -> Result<ServiceEntry, String> {
    if !is_valid_name(name) {
        return Err(format!("\u{201c}{name}\u{201d} isn't a service name."));
    }
    let ran = run(QUERY_ALL)?;
    if !ran.ok {
        return Err("Windows wouldn't list its services.".into());
    }
    parse_services(&ran.text)
        .into_iter()
        .find(|s| s.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| format!("There's no service called \u{201c}{name}\u{201d} on this machine."))
}

#[tauri::command]
pub async fn service_detail(name: String) -> Result<ServiceDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = resolve(&name)?;
        // Fresh state: the list was a snapshot, and between listing services
        // and asking about one of them it can have stopped.
        let live = run(&[VERB_QUERY, &entry.name])?;
        let (state, running) = parse_services(&live.text)
            .into_iter()
            .next()
            .map(|s| (s.state, s.running))
            .unwrap_or((entry.state.clone(), entry.running));

        // Config is a bonus, not a requirement: `sc qc` is refused for a few
        // services, and "I couldn't tell you the start type" is not a reason
        // to fail the whole question.
        let config = run(&[VERB_CONFIG, &entry.name]).ok().filter(|r| r.ok);
        let (start_type, binary) = config
            .map(|r| parse_config(&r.text))
            .unwrap_or((None, None));

        Ok(ServiceDetail {
            name: entry.name,
            display: entry.display,
            state,
            running,
            protected: entry.protected,
            start_type,
            binary,
        })
    })
    .await
    .map_err(|e| format!("The services task failed: {e}"))?
}

/// Read `sc qc` output: how the service starts, and what it runs.
fn parse_config(text: &str) -> (Option<String>, Option<String>) {
    let mut start_type = None;
    let mut binary = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if label_is(trimmed, "START_TYPE") {
            // "2   AUTO_START" or "2   AUTO_START  (DELAYED)". The leading
            // number is sc's enum; everything after it is the description.
            if let Some(value) = value_of(trimmed) {
                let words: Vec<&str> = value.split_whitespace().skip(1).collect();
                start_type = human_start_type(&words.join(" "));
            }
        } else if label_is(trimmed, "BINARY_PATH_NAME") {
            // Splitting on the *first* colon is what makes this work: the
            // value is a path and contains one of its own.
            binary = value_of(trimmed).map(str::to_string);
        }
    }
    (start_type, binary)
}

/// Turn sc's vocabulary into words a person uses.
///
/// Done here rather than in the renderer so `sc`'s spelling stays inside the
/// module that runs `sc` — nothing above this line should have to know what
/// DEMAND_START means.
fn human_start_type(raw: &str) -> Option<String> {
    let upper = raw.to_ascii_uppercase();
    let base = if upper.contains("AUTO_START") {
        if upper.contains("DELAYED") {
            "automatic (delayed)"
        } else {
            "automatic"
        }
    } else if upper.contains("DEMAND_START") {
        "manual"
    } else if upper.contains("DISABLED") {
        "disabled"
    } else if upper.contains("BOOT_START") || upper.contains("SYSTEM_START") {
        "at boot"
    } else {
        return None;
    };
    Some(base.to_string())
}

/// Start, stop or restart one service.
///
/// `action` is checked against the three verbs here rather than trusted, so a
/// fourth value is a refusal and not an unhandled case.
#[tauri::command]
pub async fn service_control(name: String, action: String) -> Result<ServiceOutcome, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = resolve(&name)?;
        let stopping = matches!(action.as_str(), "stop" | "restart");

        // Refused, not confirmed. This check lives here as well as in the
        // skill because the skill is in a renderer and this is not.
        if stopping && entry.protected {
            return Err(format!(
                "I won't stop {} — Windows doesn't survive it, and the way back is the power button.",
                entry.display
            ));
        }

        match action.as_str() {
            "start" => {
                if entry.running {
                    return Ok(settled(&entry, Some("It was already running.")));
                }
                send(VERB_START, &entry)?;
                Ok(await_state(&entry, true))
            }
            "stop" => {
                if !entry.running {
                    return Ok(settled(&entry, Some("It was already stopped.")));
                }
                send(VERB_STOP, &entry)?;
                Ok(await_state(&entry, false))
            }
            "restart" => {
                if entry.running {
                    send(VERB_STOP, &entry)?;
                    await_state(&entry, false);
                }
                send(VERB_START, &entry)?;
                Ok(await_state(&entry, true))
            }
            other => Err(format!(
                "I don't know how to \u{201c}{other}\u{201d} a service."
            )),
        }
    })
    .await
    .map_err(|e| format!("The services task failed: {e}"))?
}

/// Issue one verb, and translate the ways it fails into sentences.
///
/// `sc`'s own output is a numbered Win32 error and the name of the API that
/// returned it, which tells a person nothing about what to do next. Each of
/// these has a different answer, so each gets its own line.
fn send(verb: &str, entry: &ServiceEntry) -> Result<(), String> {
    let ran = run(&[verb, &entry.name])?;
    if ran.ok {
        return Ok(());
    }
    let text = ran.text.to_ascii_uppercase();

    // Already in the state that was asked for. Not a failure: the state check
    // that follows will report the truth either way.
    if text.contains("1056") || text.contains("1062") {
        return Ok(());
    }
    // Windows refused because Atlas is not elevated — so ask Windows to ask.
    // Tried in this order rather than elevating up front so that no consent
    // dialog appears when none is needed: an Atlas that is already elevated,
    // or a service that did not need it, never reaches this line.
    if text.contains("ACCESS IS DENIED") || text.contains("FAILED 5") {
        return send_elevated(verb, &entry.name);
    }
    if text.contains("1051") {
        return Err(format!(
            "{} can't stop while other services depend on it.",
            entry.display
        ));
    }
    if text.contains("1052") {
        return Err(format!("{} doesn't accept that.", entry.display));
    }
    Err(format!(
        "Windows refused: {}",
        ran.text.trim().lines().next().unwrap_or("no reason given")
    ))
}

/// Run one `sc` verb with administrator rights, by asking Windows to ask.
///
/// ## Why this exists, and why it is not a loophole
///
/// Starting and stopping a service requires elevation. Atlas does not run
/// elevated and should not: every capability it has — including the ones added
/// after this comment — would inherit those rights, for the sake of two verbs.
/// So the elevation is per action and belongs to the action: Windows shows its
/// own consent dialog, naming `sc.exe`, and the elevated process exits the
/// moment the verb is done.
///
/// The rule this project keeps is that a reader can enumerate everything the
/// program will ever execute, and that still holds: the file is the constant
/// `SC`, the verb is one of two constants, and the name is a service this
/// machine reported having, checked by `resolve` before we get here. What
/// changes is the rights the same short list runs with, and who grants them —
/// which is the user, in a dialog Atlas cannot draw, suppress or answer.
///
/// ## The one real difference from `run`
///
/// `ShellExecuteEx` starts a *separate* process, so there is no stdout to read
/// — the `[SC] FAILED 5` line that `send` translates never arrives here. That
/// turns out to be an improvement rather than a loss: the caller checks the
/// service's actual state afterwards, which is what it already does, and which
/// is a better test than believing what the command said about itself.
#[cfg(windows)]
fn send_elevated(verb: &str, name: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    // Quoted so a service name with a space in it ("AMD Crash Defender
    // Service" is one on a real machine) arrives as one argument. Safe to do
    // by hand only because `is_valid_name` has already excluded every
    // character that could end the quote.
    let params = wide(&format!("{verb} \"{name}\""));
    let file = wide(SC);
    let action = wide(RUNAS);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(action.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    // The only failure worth naming: the person said no. Everything else is
    // reported as itself.
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        const CANCELLED: i32 = -2_147_023_673; // HRESULT for ERROR_CANCELLED.
        if e.code().0 == CANCELLED {
            "You dismissed the Windows prompt, so nothing changed.".to_string()
        } else {
            format!("Windows wouldn't run that with administrator rights: {e}")
        }
    })?;

    // Wait for it, so the state check that follows is looking at the machine
    // after the verb rather than during it.
    #[allow(clippy::undocumented_unsafe_blocks)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::WaitForSingleObject;

        if !info.hProcess.is_invalid() {
            // Bounded rather than INFINITE: a hung `sc` must not hang Atlas.
            let _ = WaitForSingleObject(info.hProcess, 30_000);
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

/// Elevation is a Windows idea; nothing else compiles this path.
#[cfg(not(windows))]
fn send_elevated(_verb: &str, _name: &str) -> Result<(), String> {
    Err("Starting and stopping services needs administrator rights.".into())
}

fn settled(entry: &ServiceEntry, note: Option<&str>) -> ServiceOutcome {
    ServiceOutcome {
        name: entry.name.clone(),
        display: entry.display.clone(),
        state: entry.state.clone(),
        running: entry.running,
        note: note.map(str::to_string),
    }
}

/// Watch until the service reaches the state that was asked for, or give up.
///
/// `sc` returns the moment the request is accepted, with the service still
/// START_PENDING — so reporting straight from the command turns "it failed to
/// start" into "started". Ten seconds is past the point where a service that
/// is going to come up has; beyond that the honest answer is the state it is
/// actually in, whatever that is.
fn await_state(entry: &ServiceEntry, want_running: bool) -> ServiceOutcome {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = settled(entry, None);

    loop {
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(ran) = run(&[VERB_QUERY, &entry.name]) {
            if let Some(now) = parse_services(&ran.text).into_iter().next() {
                last = ServiceOutcome {
                    name: entry.name.clone(),
                    display: entry.display.clone(),
                    state: now.state,
                    running: now.running,
                    note: None,
                };
                if last.running == want_running {
                    return last;
                }
            }
        }
        if Instant::now() >= deadline {
            return last;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `sc query state= all` shape, trimmed to three services.
    const QUERY_SAMPLE: &str = "\r
SERVICE_NAME: Appinfo\r
DISPLAY_NAME: Application Information\r
        TYPE               : 30  WIN32\r
        STATE              : 4  RUNNING\r
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r
        WIN32_EXIT_CODE    : 0  (0x0)\r
        SERVICE_EXIT_CODE  : 0  (0x0)\r
        CHECKPOINT         : 0x0\r
        WAIT_HINT          : 0x0\r
\r
SERVICE_NAME: Spooler\r
DISPLAY_NAME: Print Spooler\r
        TYPE               : 110  WIN32_OWN_PROCESS (interactive)\r
        STATE              : 1  STOPPED\r
                                (NOT_STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)\r
        WIN32_EXIT_CODE    : 1077  (0x435)\r
\r
SERVICE_NAME: RpcSs\r
DISPLAY_NAME: Remote Procedure Call (RPC)\r
        TYPE               : 20  WIN32_SHARE_PROCESS\r
        STATE              : 4  RUNNING\r
";

    #[test]
    fn reads_every_service_in_the_listing() {
        let services = parse_services(QUERY_SAMPLE);
        assert_eq!(services.len(), 3, "{services:?}");
        // Sorted by display name: Application Information, Print Spooler, RPC.
        assert_eq!(services[0].name, "Appinfo");
        assert_eq!(services[0].display, "Application Information");
        assert!(services[0].running);
        assert_eq!(services[1].display, "Print Spooler");
        assert!(!services[1].running);
        assert_eq!(services[1].state, "STOPPED");
    }

    #[test]
    fn the_state_word_is_taken_and_not_scs_number() {
        // "STATE : 4  RUNNING" — a parser that took the whole value would
        // report the state as "4  RUNNING", and every comparison against it
        // would then be false.
        let services = parse_services(QUERY_SAMPLE);
        assert_eq!(services[0].state, "RUNNING");
    }

    #[test]
    fn the_parenthesised_flags_line_is_not_a_state() {
        // The line after STATE is "(STOPPABLE, NOT_PAUSABLE…)" and belongs to
        // no label at all. It must not overwrite the state before it.
        let services = parse_services(QUERY_SAMPLE);
        assert_eq!(services[0].state, "RUNNING");
        assert!(services[0].running);
    }

    #[test]
    fn the_services_that_must_never_stop_are_marked() {
        let services = parse_services(QUERY_SAMPLE);
        let rpc = services.iter().find(|s| s.name == "RpcSs").unwrap();
        assert!(rpc.protected, "RPC is the canonical never-stop service");
        let spooler = services.iter().find(|s| s.name == "Spooler").unwrap();
        assert!(!spooler.protected, "the print spooler is ordinary");
    }

    #[test]
    fn protection_ignores_case() {
        // Windows service names are case-insensitive, and `sc query` reports
        // "RpcSs" while a person types "rpcss". Comparing raw would leave the
        // refusal reachable only by exact spelling.
        assert!(protected("RPCSS"));
        assert!(protected("rpcss"));
        assert!(protected("RpcSs"));
    }

    const CONFIG_SAMPLE: &str = "\r
[SC] QueryServiceConfig SUCCESS\r
\r
SERVICE_NAME: Spooler\r
        TYPE               : 110  WIN32_OWN_PROCESS (interactive)\r
        START_TYPE         : 2   AUTO_START\r
        ERROR_CONTROL      : 1   NORMAL\r
        BINARY_PATH_NAME   : C:\\WINDOWS\\System32\\spoolsv.exe\r
        LOAD_ORDER_GROUP   : SpoolerGroup\r
        TAG                : 0\r
        DISPLAY_NAME       : Print Spooler\r
        DEPENDENCIES       : RPCSS\r
        SERVICE_START_NAME : LocalSystem\r
";

    #[test]
    fn reads_how_a_service_starts() {
        let (start_type, binary) = parse_config(CONFIG_SAMPLE);
        assert_eq!(start_type.as_deref(), Some("automatic"));
        // ⚠️ The value is a path and contains its own colon. Splitting on the
        // last colon, or on every colon, loses the drive letter.
        assert_eq!(
            binary.as_deref(),
            Some("C:\\WINDOWS\\System32\\spoolsv.exe")
        );
    }

    #[test]
    fn a_delayed_start_is_not_just_automatic() {
        assert_eq!(
            human_start_type("AUTO_START  (DELAYED)").as_deref(),
            Some("automatic (delayed)")
        );
        assert_eq!(human_start_type("DEMAND_START").as_deref(), Some("manual"));
        assert_eq!(human_start_type("DISABLED").as_deref(), Some("disabled"));
        assert_eq!(human_start_type("SOMETHING_NEW"), None);
    }

    /// The fixtures above are what `sc` printed on a real machine, but a
    /// fixture cannot notice the day Windows changes a label. These do, and
    /// they are ignored by default because they only mean something on a
    /// Windows box: run with `cargo test services:: -- --ignored`.
    #[test]
    #[ignore]
    fn reads_the_services_on_this_machine() {
        let ran = run(QUERY_ALL).expect("sc query state= all");
        let services = parse_services(&ran.text);

        assert!(services.len() > 50, "only {} parsed", services.len());
        assert!(services.iter().any(|s| s.running), "nothing is running?");
        assert!(
            services.iter().all(|s| !s.name.is_empty() && !s.display.is_empty()),
            "a service came back with an empty name"
        );

        // Every Windows machine has RPC, and it must come back marked.
        let rpc = services
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case("RpcSs"))
            .expect("no RPC service on a Windows machine");
        assert!(rpc.protected);
        assert!(rpc.running);

        // ⚠️ Service *names* can contain spaces — "AMD Crash Defender
        // Service" does on the machine this was written on. That is why
        // `is_valid_name` allows them, and this is the check that would catch
        // tightening it back.
        for s in &services {
            assert!(is_valid_name(&s.name), "a real service name was rejected: {}", s.name);
        }
    }

    #[test]
    #[ignore]
    fn reads_a_real_services_configuration() {
        let ran = run(&[VERB_CONFIG, "Spooler"]).expect("sc qc Spooler");
        let (start_type, binary) = parse_config(&ran.text);
        assert!(start_type.is_some(), "no start type came back");
        assert!(
            binary.unwrap_or_default().to_lowercase().contains("spoolsv.exe"),
            "the binary path did not survive its own colon"
        );
    }

    #[test]
    fn a_name_that_could_be_read_as_a_switch_is_refused() {
        // The gate before the gate. `resolve` would reject these anyway by
        // failing to find them, but a value starting with "-" or "/" should
        // never be handed to a process at all — sc would read it as a flag.
        assert!(!is_valid_name("-delete"));
        assert!(!is_valid_name("/x"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("Spooler && shutdown"));
        assert!(is_valid_name("Spooler"));
        assert!(is_valid_name("Windows Update"));
        assert!(is_valid_name("edgeupdate.1"));
    }
}
