//! Starting Nova Intelligence's local server, so switching it on is enough.
//!
//! ## Why Atlas has to go and find it
//!
//! Nova Intelligence is a Python program with a trained model beside it, and it
//! lives in its own folder (`NovaIntelligence`). The Atlas installer does not
//! carry it — the interpreter, PyTorch and the checkpoint together are several
//! gigabytes, for a model most people will never turn on. So an installed Atlas
//! finds that folder on the machine, or is told where it is, and starts the
//! server from there. Until it is, Settings says so plainly.
//!
//! ## Not a general "run this" command
//!
//! This is `launch_app`'s shape, not `exec`'s. The program is always
//! `<folder>\.venv\Scripts\python.exe`, the script is always
//! `phase4_nova\server.py`, and the only argument is `--port <number>`. No part
//! of any of those is text the caller composes. The folder itself is accepted
//! only if it *is* a Nova Intelligence checkout — it has to hold that exact
//! script, and the script has to identify itself — so pointing this at some
//! other folder that happens to contain a `python.exe` does nothing.
//!
//! The server binds `127.0.0.1` only and turns text into text; see its own
//! docstring. This module never talks to it beyond checking that its port is
//! open — the conversation goes through `intelligence.rs`.
//!
//! ## It goes when Atlas goes
//!
//! The process is put in a Job Object set to kill on close, so it cannot
//! outlive Atlas however Atlas ends — quit, crash or killed from Task Manager.
//! A model server left running in the background after the app is closed is
//! exactly the surprise this avoids. Output goes to a log file rather than a
//! console window, and its tail is handed back if the server dies, so "it did
//! not start" comes with a reason.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::{SocketAddr, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const DEFAULT_PORT: u16 = 8766;
/// What the script says about itself near the top; the folder check reads it.
const SIGNATURE: &str = "Nova Intelligence";
const LOG_TAIL_BYTES: u64 = 700;

struct Running {
    child: Child,
    /// A Windows Job Object handle as an integer, or 0 when one could not be made.
    job: isize,
}

static STATE: Mutex<Option<Running>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovaFolder {
    path: String,
    /// The trained checkpoint is in place. Without it the server starts and
    /// then has nothing to load.
    has_model: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchState {
    /// `none` — Atlas has not started one; `running` — it has, and it is up as
    /// a process; `exited` — it has stopped, and `detail` says what it printed.
    state: &'static str,
    detail: String,
}

fn python_in(dir: &Path) -> PathBuf {
    dir.join(".venv").join("Scripts").join("python.exe")
}

fn script_in(dir: &Path) -> PathBuf {
    dir.join("phase4_nova").join("server.py")
}

fn model_in(dir: &Path) -> bool {
    dir.join("checkpoints").join("phase4").join("s").is_dir()
}

/// Is this folder a Nova Intelligence checkout Atlas can start?
fn is_nova_folder(dir: &Path) -> bool {
    if dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    if !python_in(dir).is_file() {
        return false;
    }
    let mut head = String::new();
    let Ok(file) = File::open(script_in(dir)) else { return false };
    if file.take(4096).read_to_string(&mut head).is_err() {
        return false;
    }
    head.contains(SIGNATURE)
}

/// Where a Nova Intelligence folder is likely to be, most specific first.
fn candidates(hint: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let hint = hint.trim();
    if !hint.is_empty() {
        out.push(PathBuf::from(hint));
    }
    if let Ok(dir) = std::env::var("NOVA_INTELLIGENCE_DIR") {
        if !dir.trim().is_empty() {
            out.push(PathBuf::from(dir));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(here) = exe.parent() {
            out.push(here.join("NovaIntelligence"));
            if let Some(up) = here.parent() {
                out.push(up.join("NovaIntelligence"));
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        out.push(home.join("NovaIntelligence"));
        out.push(home.join("Documents").join("NovaIntelligence"));
        out.push(home.join("Dev").join("NovaIntelligence"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("NovaIntelligence"));
    }
    for drive in ["D", "C", "E"] {
        out.push(PathBuf::from(format!("{drive}:\\Dev\\NovaIntelligence")));
        out.push(PathBuf::from(format!("{drive}:\\NovaIntelligence")));
    }
    out
}

/// Find a Nova Intelligence folder: the one the person chose if it checks out,
/// otherwise the usual places. A read — it starts nothing.
#[tauri::command]
pub fn nova_intelligence_locate(hint: String) -> Option<NovaFolder> {
    candidates(&hint).into_iter().find(|dir| is_nova_folder(dir)).map(|dir| NovaFolder {
        has_model: model_in(&dir),
        path: dir.to_string_lossy().to_string(),
    })
}

fn port_of(base_url: &str) -> Result<u16, String> {
    let base = crate::intelligence::validate_base_url(base_url, crate::intelligence::NOVA_DEFAULT_URL)?;
    let parsed = reqwest::Url::parse(&base).map_err(|_| "That doesn't look like a URL.".to_string())?;
    Ok(parsed.port().unwrap_or(DEFAULT_PORT))
}

fn port_is_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn log_path() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(base).join("dev.atlas.assistant");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("nova-intelligence.log"))
}

fn log_tail() -> String {
    let Some(path) = log_path() else { return String::new() };
    let Ok(mut file) = File::open(path) else { return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(LOG_TAIL_BYTES)));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

#[cfg(windows)]
fn kill_with_atlas(child: &Child) -> isize {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else { return 0 };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set.is_err()
            || AssignProcessToJobObject(job, HANDLE(child.as_raw_handle() as *mut _)).is_err()
        {
            let _ = CloseHandle(job);
            return 0;
        }
        job.0 as isize
    }
}

#[cfg(not(windows))]
fn kill_with_atlas(_child: &Child) -> isize {
    0
}

/// Start the server from `folder`. Answers at once: `started`, `already-running`
/// (something already answers on that port, or Atlas started one that is still
/// coming up), or an error saying what is missing. The caller then watches
/// `nova_intelligence_reachable` — loading the model takes a while.
#[tauri::command]
pub fn nova_intelligence_start(folder: String, base_url: String) -> Result<String, String> {
    crate::halt::global().check()?;

    let port = port_of(&base_url)?;
    let dir = PathBuf::from(folder.trim());
    if !is_nova_folder(&dir) {
        return Err("That isn't a Nova Intelligence folder — I need one that holds \
                    .venv and phase4_nova\\server.py."
            .into());
    }
    if !model_in(&dir) {
        return Err("Nova Intelligence is there, but its trained model (checkpoints\\phase4\\s) \
                    is missing, so there is nothing for the server to load."
            .into());
    }

    let mut state = STATE.lock().map_err(|_| "Nova Intelligence's launcher is stuck.".to_string())?;
    if let Some(running) = state.as_mut() {
        if matches!(running.child.try_wait(), Ok(None)) {
            return Ok("already-running".into());
        }
        *state = None;
    }
    if port_is_open(port) {
        return Ok("already-running".into());
    }

    let log = log_path()
        .and_then(|p| File::create(p).ok())
        .ok_or_else(|| "I couldn't open a log file to keep the server's output.".to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(python_in(&dir));
    cmd.arg(script_in(&dir))
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn().map_err(|e| format!("Couldn't start Nova Intelligence: {e}"))?;
    let job = kill_with_atlas(&child);
    *state = Some(Running { child, job });
    Ok("started".into())
}

/// Whether the server Atlas started is still up, and if not, what it said.
#[tauri::command]
pub fn nova_intelligence_launch_state() -> LaunchState {
    let Ok(mut state) = STATE.lock() else {
        return LaunchState { state: "none", detail: String::new() };
    };
    let Some(running) = state.as_mut() else {
        return LaunchState { state: "none", detail: String::new() };
    };
    match running.child.try_wait() {
        Ok(None) => LaunchState { state: "running", detail: String::new() },
        Ok(Some(status)) => {
            let detail = log_tail();
            *state = None;
            LaunchState {
                state: "exited",
                detail: if detail.is_empty() {
                    format!("It stopped ({status}).")
                } else {
                    detail
                },
            }
        }
        Err(_) => LaunchState { state: "none", detail: String::new() },
    }
}

/// Stop the server Atlas started. Only ever that one: a Nova Intelligence the
/// person started themselves is not Atlas's to end.
#[tauri::command]
pub fn nova_intelligence_stop() -> bool {
    let Ok(mut state) = STATE.lock() else { return false };
    let Some(mut running) = state.take() else { return false };
    let _ = running.child.kill();
    let _ = running.child.wait();
    #[cfg(windows)]
    if running.job != 0 {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe {
            let _ = CloseHandle(HANDLE(running.job as *mut _));
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-nova-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_checkout(dir: &Path, script: &str) {
        std::fs::create_dir_all(dir.join(".venv").join("Scripts")).unwrap();
        std::fs::write(python_in(dir), b"").unwrap();
        std::fs::create_dir_all(dir.join("phase4_nova")).unwrap();
        std::fs::write(script_in(dir), script).unwrap();
    }

    #[test]
    fn a_real_checkout_is_recognised() {
        let dir = scratch("real");
        fake_checkout(&dir, "\"\"\"Serve a trained Nova Intelligence model.\"\"\"");
        assert!(is_nova_folder(&dir));
        assert!(!model_in(&dir));
        std::fs::create_dir_all(dir.join("checkpoints").join("phase4").join("s")).unwrap();
        assert!(model_in(&dir));
    }

    #[test]
    fn a_folder_with_a_python_but_no_nova_script_is_refused() {
        // The whole point of the signature: a python.exe alone is not enough.
        let dir = scratch("other");
        fake_checkout(&dir, "print('some other server')");
        assert!(!is_nova_folder(&dir));
    }

    #[test]
    fn a_folder_missing_its_interpreter_is_refused() {
        let dir = scratch("nopy");
        std::fs::create_dir_all(dir.join("phase4_nova")).unwrap();
        std::fs::write(script_in(&dir), "Nova Intelligence").unwrap();
        assert!(!is_nova_folder(&dir));
    }

    #[test]
    fn a_path_climbing_out_is_refused() {
        let dir = scratch("dots");
        fake_checkout(&dir, "Nova Intelligence");
        assert!(!is_nova_folder(&dir.join("..").join(dir.file_name().unwrap())));
    }

    #[test]
    fn the_chosen_folder_is_tried_before_the_usual_places() {
        let dir = scratch("hint");
        fake_checkout(&dir, "Nova Intelligence");
        let found = nova_intelligence_locate(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(PathBuf::from(found.path), dir);
    }

    #[test]
    fn an_empty_url_means_the_default_port_and_a_custom_one_is_honoured() {
        assert_eq!(port_of("").unwrap(), DEFAULT_PORT);
        assert_eq!(port_of("http://127.0.0.1:9100").unwrap(), 9100);
        assert!(port_of("http://example.com:8766").is_err(), "loopback only");
    }

    #[test]
    fn starting_from_a_folder_that_is_not_nova_intelligence_starts_nothing() {
        let dir = scratch("nostart");
        let err = nova_intelligence_start(dir.to_string_lossy().to_string(), String::new());
        assert!(err.is_err());
        assert_eq!(nova_intelligence_launch_state().state, "none");
    }

    /// The real thing, on this machine: find the actual NovaIntelligence
    /// folder, start its actual server through the command, wait for it to
    /// answer `/health`, and stop it. `#[ignore]` because it needs the folder
    /// (Python + PyTorch + the checkpoint) and takes a while to load the model.
    #[test]
    #[ignore = "starts the real Nova Intelligence server; run with --ignored"]
    fn a_real_start_answers_health_and_stops_cleanly() {
        use std::io::Write;
        let found = nova_intelligence_locate(String::new())
            .expect("no NovaIntelligence folder on this machine");
        assert!(found.has_model, "checkpoint missing");
        let port = 8766;
        assert!(!port_is_open(port), "something already listens on {port}");

        let first = nova_intelligence_start(found.path.clone(), String::new()).unwrap();
        assert_eq!(first, "started");
        // A second press while it is coming up must not launch a second copy.
        assert_eq!(
            nova_intelligence_start(found.path.clone(), String::new()).unwrap(),
            "already-running"
        );

        let mut answered = false;
        for _ in 0..120 {
            if nova_intelligence_launch_state().state == "exited" {
                panic!("server died: {}", nova_intelligence_launch_state().detail);
            }
            if let Ok(mut s) = TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], port)),
                Duration::from_millis(400),
            ) {
                let _ = s.write_all(b"GET /health HTTP/1.0\r\n\r\n");
                let mut body = String::new();
                let _ = s.read_to_string(&mut body);
                if body.contains("nova-intelligence") {
                    answered = true;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
        assert!(answered, "/health never answered; log: {}", log_tail());
        assert_eq!(nova_intelligence_launch_state().state, "running");

        assert!(nova_intelligence_stop());
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!port_is_open(port), "the server is still listening after stop");
        assert_eq!(nova_intelligence_launch_state().state, "none");
    }

    #[test]
    fn stopping_when_nothing_was_started_is_a_no_op() {
        assert!(!nova_intelligence_stop());
    }
}
