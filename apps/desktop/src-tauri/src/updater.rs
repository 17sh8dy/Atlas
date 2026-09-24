//! In-app updates — the native half of `@atlas/updater`.
//!
//! The TypeScript service decides *when* and *whether*. Everything that needs
//! the operating system lives here: fetch the manifest, download the installer,
//! measure it, keep the running version safe, replace the program, and put the
//! old one back if the new one does not come up.
//!
//! ── Nothing arbitrary ever runs ─────────────────────────────────────────────
//! The webview can ask for exactly eight things (the commands at the bottom).
//! None takes a program to run. The installer that eventually executes is a
//! file *this module* downloaded into its own folder, whose SHA-256, product
//! name and version were checked against the manifest twice — once when the
//! person pressed Update, and again, independently, in `updater_install`,
//! immediately before it is handed over. A path that is not inside that folder
//! is refused.
//!
//! ── Why a helper process ────────────────────────────────────────────────────
//! Windows will not overwrite a program that is running, and a program cannot
//! reliably wait for its own replacement. So "Update" arms a **helper**: a copy
//! of the *current, known-good* executable, started with `--atlas-update-apply`.
//! Atlas then quits. The helper waits for it to exit, runs the installer
//! silently, checks that the installed program really is the new version, and
//! starts it. If the installer fails, or installed the wrong thing, the helper
//! puts the backup back and starts the old version instead.
//!
//! ── Rollback ────────────────────────────────────────────────────────────────
//! Before the handoff, everything in the install folder except `vendor` (the
//! 400 MB of voice and speech models, which do not change between releases) is
//! copied to a backup. The new version must call `updater_confirm_launch` once
//! its window is up. Every startup that has *not* been confirmed is counted; at
//! the third, the new version restores the backup from the *backup's own*
//! executable and quits. So a build that installs cleanly but crashes on
//! launch undoes itself, without asking anyone to reinstall anything.
//!
//! Known limit: a build that cannot start *at all* — a missing DLL, a corrupt
//! binary — never reaches the check that counts launches, so it cannot roll
//! itself back. The backup is still on disk, and reinstalling over it works.
//!
//! ── Code signing ────────────────────────────────────────────────────────────
//! `Authenticode` state is measured (`WinVerifyTrust`) and reported. Whether an
//! unsigned installer is acceptable is a *policy* the TypeScript side holds —
//! today it is, because Atlas builds are not signed yet; a signed-but-invalid
//! installer is refused regardless.

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Where updates may come from. The manifest and the installer must both be
/// served by one of these (or a subdomain of one). To host elsewhere, add the
/// domain here — deliberately not something a manifest or the webview can name.
const ALLOWED_HOSTS: &[&str] = &["github.com", "githubusercontent.com"];

const MANIFEST_MAX_BYTES: usize = 256 * 1024;
const PACKAGE_MAX_BYTES: u64 = 1_500_000_000;
/// The install folder's marker: only a copy the installer put there can update itself.
const UNINSTALLER: &str = "uninstall.exe";
/// Unconfirmed launches of a new version tolerated before it is rolled back.
const MAX_UNCONFIRMED_LAUNCHES: u32 = 2;
/// Not backed up: large, and unchanged between releases.
const BACKUP_SKIPS: &[&str] = &["vendor"];

const APPLY_FLAG: &str = "--atlas-update-apply";
const ROLLBACK_FLAG: &str = "--atlas-update-rollback";

static CANCEL: AtomicBool = AtomicBool::new(false);
static STARTUP: OnceLock<Mutex<StartupStatus>> = OnceLock::new();

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedPackage {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub sha256: String,
    pub size_bytes: u64,
    pub product: Option<String>,
    pub version: Option<String>,
    /// `valid`, `unsigned`, `invalid` or `unchecked`.
    pub signature: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// `none`, `updated` or `rolled-back`.
    pub outcome: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub detail: Option<String>,
}

impl StartupStatus {
    fn none() -> Self {
        Self {
            outcome: "none".into(),
            ..Default::default()
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Pending {
    from: String,
    to: String,
    installer: String,
    backup: String,
    install_dir: String,
    /// The installed program's file name — recorded by the *app*, which knows
    /// it, because the helper does not: it runs as a copy called
    /// `atlas-update-helper.exe`, so asking the helper what "this executable"
    /// is called answers with the helper's name. That mistake made every update
    /// look like it had installed nothing, and roll back, whatever the
    /// installer did.
    #[serde(default = "default_exe_name")]
    exe_name: String,
    /// `handoff` (armed), `installed`, `failed` or `rolled-back`.
    phase: String,
    attempts: u32,
    detail: Option<String>,
}

/// For a `pending.json` written before `exe_name` existed. The name the
/// installer has always given the program.
fn default_exe_name() -> String {
    "atlas-desktop.exe".into()
}

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/// `%LOCALAPPDATA%\dev.atlas.assistant\updates` — the same folder Tauri calls
/// `app_local_data_dir`, computed by hand because startup needs it before the
/// app exists.
fn updates_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the local app data folder.".to_string())?;
    let dir = base.join("dev.atlas.assistant").join("updates");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(updates_dir()?.join("pending.json"))
}

fn log(line: &str) {
    // Unit tests run the real apply/rollback code, and would otherwise write
    // "installing 9.9.9" into the person's actual log — the one thing they
    // would open to find out what really happened to their update.
    if cfg!(test) {
        return;
    }
    if let Ok(dir) = updates_dir() {
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("updater.log"))
        {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn read_pending() -> Option<Pending> {
    let text = fs::read_to_string(pending_path().ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_pending(p: &Pending) -> Result<(), String> {
    let text = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    fs::write(pending_path()?, text).map_err(|e| e.to_string())
}

fn delete_pending() {
    if let Ok(p) = pending_path() {
        let _ = fs::remove_file(p);
    }
}

/// A file the webview named, accepted only if it is inside the updates folder.
fn inside_updates(path: &str) -> Result<PathBuf, String> {
    let dir = updates_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let file = Path::new(path)
        .canonicalize()
        .map_err(|_| "That update file is not there.".to_string())?;
    if !file.starts_with(&dir) {
        return Err("That file is not in the updates folder.".into());
    }
    Ok(file)
}

// ---------------------------------------------------------------------------
// hosts
// ---------------------------------------------------------------------------

fn host_allowed(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Atlas-Updater/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        // A redirect may only go somewhere that would itself be allowed.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else if host_allowed(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.error("redirected somewhere that is not an allowed update host")
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// measuring a file
// ---------------------------------------------------------------------------

fn sha256_of(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((hex, total))
}

/// Is this a Windows executable at all? A cheap guard against a download that
/// is really an HTML error page.
fn looks_like_executable(path: &Path) -> bool {
    let mut head = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| &head == b"MZ")
        .unwrap_or(false)
}

fn measure(path: &Path) -> Result<VerifyReport, String> {
    if !looks_like_executable(path) {
        return Err("The download is not a Windows installer.".into());
    }
    let (sha256, size_bytes) = sha256_of(path)?;
    let (product, version) = win::version_info(path);
    Ok(VerifyReport {
        sha256,
        size_bytes,
        product,
        version,
        signature: win::signature_state(path).into(),
    })
}

// ---------------------------------------------------------------------------
// the decision made at every startup — pure, so it can be tested
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Action {
    Nothing,
    Save(Pending),
    Delete,
    Rollback,
}

fn decide_startup(pending: Option<Pending>, current: &str) -> (StartupStatus, Action) {
    let Some(p) = pending else {
        return (StartupStatus::none(), Action::Nothing);
    };

    if current == p.to {
        return match p.phase.as_str() {
            "installed" | "handoff" => {
                let attempts = p.attempts + 1;
                if attempts > MAX_UNCONFIRMED_LAUNCHES {
                    (StartupStatus::none(), Action::Rollback)
                } else {
                    let status = StartupStatus {
                        outcome: "updated".into(),
                        from_version: Some(p.from.clone()),
                        to_version: Some(p.to.clone()),
                        detail: None,
                    };
                    (status, Action::Save(Pending { attempts, ..p }))
                }
            }
            _ => (StartupStatus::none(), Action::Delete),
        };
    }

    if current == p.from {
        return match p.phase.as_str() {
            "failed" | "rolled-back" => {
                let status = StartupStatus {
                    outcome: "rolled-back".into(),
                    from_version: Some(p.from.clone()),
                    to_version: Some(p.to.clone()),
                    detail: p.detail.clone(),
                };
                (status, Action::Delete)
            }
            // Armed, but the installer never ran (the app was killed first).
            _ => (StartupStatus::none(), Action::Delete),
        };
    }

    (StartupStatus::none(), Action::Delete)
}

// ---------------------------------------------------------------------------
// backup and restore
// ---------------------------------------------------------------------------

fn copy_tree(from: &Path, to: &Path, skip_top: &[&str]) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if skip_top.iter().any(|s| name.to_string_lossy().eq_ignore_ascii_case(s)) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_tree(&src, &dst, &[])?;
        } else if kind.is_file() {
            fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
        }
    }
    Ok(())
}

fn install_exe_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "atlas-desktop.exe".into())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn updater_fetch_manifest(url: String) -> Result<String, String> {
    if !host_allowed(&url) {
        return Err("The update address is not an allowed, secure (https) host.".into());
    }
    let response = client()?
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Could not reach the update server: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The update server answered {}.", response.status()));
    }
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        body.extend_from_slice(&chunk);
        if body.len() > MANIFEST_MAX_BYTES {
            return Err("The update information was unexpectedly large.".into());
        }
    }
    String::from_utf8(body).map_err(|_| "The update information was not text.".into())
}

#[tauri::command]
pub async fn updater_download(app: AppHandle, url: String) -> Result<DownloadedPackage, String> {
    if !host_allowed(&url) {
        return Err("The download address is not an allowed, secure (https) host.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);

    let dir = updates_dir()?;
    // Old downloads are never wanted again; keep only a pending install's files.
    if read_pending().is_none() {
        cleanup_downloads(&dir);
    }
    let part = dir.join("Atlas-update.exe.part");
    let done = dir.join("Atlas-update.exe");
    let _ = fs::remove_file(&part);
    let _ = fs::remove_file(&done);

    let result = download_to(&app, &url, &part).await;
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, &done).map_err(|e| e.to_string())?;
    let size = fs::metadata(&done).map(|m| m.len()).unwrap_or(0);
    Ok(DownloadedPackage {
        path: done.to_string_lossy().into_owned(),
        size_bytes: size,
    })
}

async fn download_to(app: &AppHandle, url: &str, part: &Path) -> Result<(), String> {
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not start the download: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The download server answered {}.", response.status()));
    }
    let total = response.content_length();
    if total.map(|t| t > PACKAGE_MAX_BYTES).unwrap_or(false) {
        return Err("The download is larger than an update should be.".into());
    }

    let mut file = fs::File::create(part).map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("Download cancelled.".into());
        }
        let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
        received += chunk.len() as u64;
        if received > PACKAGE_MAX_BYTES {
            return Err("The download is larger than an update should be.".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        // Progress at ~10 a second: enough to look smooth, cheap enough to ignore.
        if last.elapsed() >= Duration::from_millis(100) {
            last = Instant::now();
            let _ = app.emit("atlas://update-progress", Progress { received, total });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    let _ = app.emit("atlas://update-progress", Progress { received, total });
    if let Some(t) = total {
        if received != t {
            return Err("The download ended early.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn updater_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn updater_verify(path: String) -> Result<VerifyReport, String> {
    let file = inside_updates(&path)?;
    tauri::async_runtime::spawn_blocking(move || measure(&file))
        .await
        .map_err(|e| e.to_string())?
}

/// Keep the running version safe and arm the helper. The app is still running
/// when this returns; `updater_restart` is what closes it.
#[tauri::command]
pub async fn updater_install(
    path: String,
    sha256: String,
    product: String,
    version: String,
    from_version: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        install(&path, &sha256, &product, &version, &from_version)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn install(
    path: &str,
    sha256: &str,
    product: &str,
    version: &str,
    from_version: &str,
) -> Result<(), String> {
    let installer = inside_updates(path)?;

    // The check that matters is the one made right before running: whatever
    // happened between "verified" and now, this is what would execute.
    let report = measure(&installer)?;
    if !report.sha256.eq_ignore_ascii_case(sha256) {
        return Err("The downloaded installer changed after it was verified. Not installing.".into());
    }
    if report.signature == "invalid" {
        return Err("The installer's code signature is invalid. Not installing.".into());
    }
    if !report.product.as_deref().unwrap_or("").eq_ignore_ascii_case(product) {
        return Err(format!("The installer is not an {product} installer. Not installing."));
    }
    if report.version.as_deref() != Some(version) {
        return Err(format!("The installer is not version {version}. Not installing."));
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let install_dir = exe
        .parent()
        .ok_or("Could not find where Atlas is installed.")?
        .to_path_buf();
    if !install_dir.join(UNINSTALLER).is_file() {
        return Err(
            "This copy of Atlas was not put here by its installer, so it cannot update itself. \
             Run the installer once and updates will work from then on."
                .into(),
        );
    }

    // 1. keep the working version
    let dir = updates_dir()?;
    let backup = dir.join(format!("backup-{from_version}"));
    let _ = fs::remove_dir_all(&backup);
    copy_tree(&install_dir, &backup, BACKUP_SKIPS)?;
    let backup_exe = backup.join(install_exe_name());
    if !backup_exe.is_file() {
        return Err("The safety copy of Atlas is incomplete. Not installing.".into());
    }

    // 2. arm the helper — a copy of the version that is known to work
    let pending = Pending {
        from: from_version.to_string(),
        to: version.to_string(),
        installer: installer.to_string_lossy().into_owned(),
        backup: backup.to_string_lossy().into_owned(),
        install_dir: install_dir.to_string_lossy().into_owned(),
        exe_name: install_exe_name(),
        phase: "handoff".into(),
        attempts: 0,
        detail: None,
    };
    write_pending(&pending)?;

    let helper_dir = dir.join("helper");
    let _ = fs::remove_dir_all(&helper_dir);
    fs::create_dir_all(&helper_dir).map_err(|e| e.to_string())?;
    let helper = helper_dir.join("atlas-update-helper.exe");
    fs::copy(&backup_exe, &helper).map_err(|e| e.to_string())?;

    win::spawn_detached(
        &helper,
        &[APPLY_FLAG, &pending_path()?.to_string_lossy(), &std::process::id().to_string()],
    )?;
    log(&format!("armed {from_version} -> {version}"));
    Ok(())
}

/// Quit, so the helper can replace the program.
#[tauri::command]
pub fn updater_restart(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn updater_startup_status() -> StartupStatus {
    STARTUP
        .get()
        .and_then(|m| m.lock().ok().map(|s| s.clone()))
        .unwrap_or_else(StartupStatus::none)
}

/// The new version is up and healthy: the safety copy and installer can go.
#[tauri::command]
pub fn updater_confirm_launch() {
    let current = env!("CARGO_PKG_VERSION");
    match read_pending() {
        Some(p) if p.to == current && (p.phase == "installed" || p.phase == "handoff") => {
            let _ = fs::remove_dir_all(&p.backup);
            delete_pending();
            log(&format!("confirmed {current}; safety copy removed"));
        }
        None => {}
        // A rollback report is shown once, then cleared by `startup` already.
        Some(_) => {}
    }
    if read_pending().is_none() {
        if let Ok(dir) = updates_dir() {
            cleanup_downloads(&dir);
        }
    }
}

fn cleanup_downloads(dir: &Path) {
    let _ = fs::remove_file(dir.join("Atlas-update.exe"));
    let _ = fs::remove_file(dir.join("Atlas-update.exe.part"));
    let _ = fs::remove_dir_all(dir.join("helper"));
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("backup-") {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// startup — before the window exists
// ---------------------------------------------------------------------------

/// Call first thing in `run()`. Decides what the last update amounted to,
/// counts this launch, and — if a new version has failed to confirm itself
/// three times running — rolls back and quits before showing anything.
pub fn startup() {
    let current = env!("CARGO_PKG_VERSION");
    let pending = read_pending();
    let backup_of = pending.clone();
    let (status, action) = decide_startup(pending, current);

    match action {
        Action::Nothing => {}
        Action::Save(p) => {
            let _ = write_pending(&p);
        }
        Action::Delete => {
            if let Some(p) = &backup_of {
                let _ = fs::remove_dir_all(&p.backup);
            }
            delete_pending();
        }
        Action::Rollback => {
            if let Some(p) = backup_of {
                log(&format!("{current} never confirmed its launch; rolling back"));
                let backup_exe = Path::new(&p.backup).join(install_exe_name());
                if let Ok(path) = pending_path() {
                    if win::spawn_detached(
                        &backup_exe,
                        &[ROLLBACK_FLAG, &path.to_string_lossy(), &std::process::id().to_string()],
                    )
                    .is_ok()
                    {
                        std::process::exit(0);
                    }
                }
                log("could not start the rollback; carrying on with the new version");
            }
        }
    }
    let _ = STARTUP.set(Mutex::new(status));
}

// ---------------------------------------------------------------------------
// helper mode — a second life for this same executable
// ---------------------------------------------------------------------------

/// Called first thing in `main()`. If this process was started as the update
/// helper, does that job and returns `true`; the caller must then exit.
pub fn maybe_run_helper() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(flag) = args.get(1) else {
        return false;
    };
    if flag != APPLY_FLAG && flag != ROLLBACK_FLAG {
        return false;
    }
    let (Some(pending_file), Some(pid)) = (args.get(2), args.get(3)) else {
        return true;
    };
    let pid: u32 = pid.parse().unwrap_or(0);

    win::wait_for_exit(pid, Duration::from_secs(60));
    let Ok(text) = fs::read_to_string(pending_file) else {
        return true;
    };
    let Ok(mut pending) = serde_json::from_str::<Pending>(&text) else {
        return true;
    };

    if flag == ROLLBACK_FLAG {
        rollback(&mut pending, pending_file, "The new version did not start properly.");
    } else {
        apply(&mut pending, pending_file);
    }
    true
}

fn save_at(pending_file: &str, p: &Pending) {
    if let Ok(text) = serde_json::to_string_pretty(p) {
        let _ = fs::write(pending_file, text);
    }
}

fn relaunch(p: &Pending) {
    // Tests exercise the real apply/rollback logic; starting a program from
    // inside one would leave it running.
    if cfg!(test) {
        return;
    }
    let exe = Path::new(&p.install_dir).join(&p.exe_name);
    let _ = win::spawn_detached(&exe, &[]);
}

fn apply(p: &mut Pending, pending_file: &str) {
    log(&format!("helper: installing {}", p.to));
    let status = win::run_installer(Path::new(&p.installer), &p.install_dir);
    let installer_ok = matches!(&status, Ok(s) if s.success());

    // Trust what is on disk, not what the installer said.
    let installed = Path::new(&p.install_dir).join(&p.exe_name);
    let (_, found) = win::version_info(&installed);
    let right_version = found.as_deref() == Some(p.to.as_str());

    if installer_ok && right_version {
        p.phase = "installed".into();
        save_at(pending_file, p);
        log("helper: installed; starting the new version");
        relaunch(p);
        return;
    }

    // Say which half failed. "The installer finished with an error (exit code:
    // 0)" — one message for both — sent this investigation the wrong way for
    // a long while: a success code reported as an error is a contradiction,
    // and the contradiction was the bug.
    let why = match status {
        Err(e) => format!("The installer could not be started ({e})."),
        Ok(s) if !s.success() => format!("The installer finished with an error ({s})."),
        Ok(_) => match found {
            Some(v) => format!(
                "The installer finished, but {} is version {v}, not {}.",
                p.exe_name, p.to
            ),
            None => format!(
                "The installer finished, but {} could not be found or read in {}.",
                p.exe_name, p.install_dir
            ),
        },
    };
    log(&format!("helper: {why} — restoring"));
    rollback(p, pending_file, &why);
}

fn rollback(p: &mut Pending, pending_file: &str, why: &str) {
    let restored = copy_tree(Path::new(&p.backup), Path::new(&p.install_dir), &[]);
    p.phase = if restored.is_ok() { "rolled-back" } else { "failed" }.into();
    p.detail = Some(match restored {
        Ok(()) => format!(
            "{why} Atlas went back to version {}, so nothing is lost.",
            p.from
        ),
        Err(e) => format!("{why} Restoring version {} also hit a problem: {e}", p.from),
    });
    save_at(pending_file, p);
    log(&format!("helper: {}", p.detail.clone().unwrap_or_default()));
    relaunch(p);
}

// ---------------------------------------------------------------------------
// Windows specifics
// ---------------------------------------------------------------------------

mod win {
    use std::{os::windows::process::CommandExt, path::Path, process::Command, time::Duration};

    use windows::{
        core::{w, HSTRING, PCWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND},
            Security::WinTrust::{
                WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA,
                WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
                WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
            },
            Storage::FileSystem::{
                GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
            },
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        },
    };

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    /// Run the installer silently, into exactly the folder that was backed up.
    /// `/D=` must be the last argument and must not be quoted — NSIS reads the
    /// raw command line — so it is passed raw.
    pub fn run_installer(installer: &Path, install_dir: &str) -> std::io::Result<std::process::ExitStatus> {
        Command::new(installer)
            .args(["/S", "/UPDATE"])
            .raw_arg(format!("/D={install_dir}"))
            .status()
    }

    pub fn spawn_detached(exe: &Path, args: &[&str]) -> Result<(), String> {
        Command::new(exe)
            .args(args)
            .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not start {}: {e}", exe.display()))
    }

    /// Block until a process is gone (or `limit` passes).
    pub fn wait_for_exit(pid: u32, limit: Duration) {
        if pid == 0 {
            return;
        }
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                let _ = WaitForSingleObject(handle, limit.as_millis() as u32);
                let _ = CloseHandle(handle);
            }
        }
        // The exit is visible a moment before its files are released.
        std::thread::sleep(Duration::from_millis(600));
    }

    /// `(ProductName, ProductVersion)` from the file's own version resource.
    pub fn version_info(path: &Path) -> (Option<String>, Option<String>) {
        let name = HSTRING::from(path.as_os_str());
        unsafe {
            let size = GetFileVersionInfoSizeW(&name, None);
            if size == 0 {
                return (None, None);
            }
            let mut block = vec![0u8; size as usize];
            if GetFileVersionInfoW(&name, 0, size, block.as_mut_ptr() as *mut _).is_err() {
                return (None, None);
            }

            // Which language block: the first (lang, codepage) pair it lists.
            let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            let translation = VerQueryValueW(
                block.as_ptr() as *const _,
                w!("\\VarFileInfo\\Translation"),
                &mut ptr,
                &mut len,
            );
            let key = if translation.as_bool() && len >= 4 && !ptr.is_null() {
                let pair = std::slice::from_raw_parts(ptr as *const u16, 2);
                format!("{:04x}{:04x}", pair[0], pair[1])
            } else {
                "040904b0".to_string()
            };

            let read = |field: &str| -> Option<String> {
                let query = HSTRING::from(format!("\\StringFileInfo\\{key}\\{field}"));
                let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
                let mut n = 0u32;
                let found = VerQueryValueW(block.as_ptr() as *const _, &query, &mut p, &mut n);
                if !found.as_bool() || p.is_null() || n == 0 {
                    return None;
                }
                let chars = std::slice::from_raw_parts(p as *const u16, n as usize);
                let end = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
                let text = String::from_utf16_lossy(&chars[..end]).trim().to_string();
                (!text.is_empty()).then_some(text)
            };
            (read("ProductName"), read("ProductVersion"))
        }
    }

    /// `valid`, `unsigned` or `invalid`, from WinVerifyTrust — no UI, no network
    /// revocation lookup (an update check must not depend on a CA being reachable).
    pub fn signature_state(path: &Path) -> &'static str {
        let file = HSTRING::from(path.as_os_str());
        let mut info = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(file.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            dwStateAction: WTD_STATEACTION_VERIFY,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let result = unsafe {
            let r = WinVerifyTrust(
                HWND(std::ptr::null_mut()),
                &mut action,
                &mut data as *mut _ as *mut _,
            );
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            let _ = WinVerifyTrust(
                HWND(std::ptr::null_mut()),
                &mut action,
                &mut data as *mut _ as *mut _,
            );
            r
        };
        match result as u32 {
            0 => "valid",
            // TRUST_E_NOSIGNATURE, TRUST_E_PROVIDER_UNKNOWN, TRUST_E_SUBJECT_FORM_UNKNOWN
            0x800B_0100 | 0x800B_0001 | 0x800B_0003 => "unsigned",
            _ => "invalid",
        }
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(phase: &str, attempts: u32) -> Pending {
        Pending {
            from: "0.85.0".into(),
            to: "0.86.0".into(),
            installer: "x".into(),
            backup: "y".into(),
            install_dir: "z".into(),
            exe_name: "atlas-desktop.exe".into(),
            phase: phase.into(),
            attempts,
            detail: Some("because".into()),
        }
    }

    #[test]
    fn only_secure_known_hosts_are_allowed() {
        assert!(host_allowed("https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json"));
        assert!(host_allowed("https://objects.githubusercontent.com/x"));
        assert!(!host_allowed("http://github.com/x"));
        assert!(!host_allowed("https://evil.example.com/github.com"));
        assert!(!host_allowed("https://github.com.evil.example.com/x"));
        assert!(!host_allowed("https://notgithub.com/x"));
        assert!(!host_allowed("file:///C:/a.exe"));
        assert!(!host_allowed("not a url"));
    }

    #[test]
    fn nothing_pending_is_a_normal_start() {
        let (status, action) = decide_startup(None, "0.85.0");
        assert_eq!(status.outcome, "none");
        assert_eq!(action, Action::Nothing);
    }

    #[test]
    fn the_new_version_reports_updated_and_counts_the_launch() {
        let (status, action) = decide_startup(Some(pending("installed", 0)), "0.86.0");
        assert_eq!(status.outcome, "updated");
        assert_eq!(status.to_version.as_deref(), Some("0.86.0"));
        assert_eq!(action, Action::Save(pending("installed", 1)));
    }

    #[test]
    fn a_new_version_that_never_confirms_is_rolled_back_on_the_third_start() {
        let (_, a) = decide_startup(Some(pending("installed", 0)), "0.86.0");
        assert!(matches!(a, Action::Save(_)));
        let (_, a) = decide_startup(Some(pending("installed", 1)), "0.86.0");
        assert!(matches!(a, Action::Save(_)));
        let (_, a) = decide_startup(Some(pending("installed", 2)), "0.86.0");
        assert_eq!(a, Action::Rollback);
    }

    #[test]
    fn after_a_rollback_the_old_version_reports_it_once() {
        for phase in ["rolled-back", "failed"] {
            let (status, action) = decide_startup(Some(pending(phase, 3)), "0.85.0");
            assert_eq!(status.outcome, "rolled-back");
            assert_eq!(status.detail.as_deref(), Some("because"));
            assert_eq!(action, Action::Delete);
        }
    }

    #[test]
    fn an_armed_update_that_never_ran_is_forgotten_quietly() {
        let (status, action) = decide_startup(Some(pending("handoff", 0)), "0.85.0");
        assert_eq!(status.outcome, "none");
        assert_eq!(action, Action::Delete);
    }

    #[test]
    fn a_stale_record_for_some_other_version_is_cleared() {
        let (status, action) = decide_startup(Some(pending("installed", 0)), "0.90.0");
        assert_eq!(status.outcome, "none");
        assert_eq!(action, Action::Delete);
    }

    #[test]
    fn backup_skips_vendor_and_restores_the_rest() {
        let root = std::env::temp_dir().join(format!("atlas-updater-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let install = root.join("install");
        fs::create_dir_all(install.join("vendor")).unwrap();
        fs::create_dir_all(install.join("sub")).unwrap();
        fs::write(install.join("atlas-desktop.exe"), b"old").unwrap();
        fs::write(install.join("sub").join("a.txt"), b"a").unwrap();
        fs::write(install.join("vendor").join("big.bin"), b"big").unwrap();

        let backup = root.join("backup");
        copy_tree(&install, &backup, BACKUP_SKIPS).unwrap();
        assert!(backup.join("atlas-desktop.exe").is_file());
        assert!(backup.join("sub").join("a.txt").is_file());
        assert!(!backup.join("vendor").exists(), "vendor must not be backed up");

        // the "new version" replaces things; restore puts the old back
        fs::write(install.join("atlas-desktop.exe"), b"new and broken").unwrap();
        copy_tree(&backup, &install, &[]).unwrap();
        assert_eq!(fs::read(install.join("atlas-desktop.exe")).unwrap(), b"old");
        assert!(install.join("vendor").join("big.bin").is_file(), "vendor untouched");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_that_is_not_an_executable_is_refused() {
        let path = std::env::temp_dir().join(format!("atlas-updater-html-{}.exe", std::process::id()));
        fs::write(&path, b"<html>404</html>").unwrap();
        assert!(measure(&path).is_err());
        let _ = fs::remove_file(&path);
    }

    /// A sandbox that looks like an installed Atlas: a program with a real
    /// version resource (a system exe stands in), a data file, and a backup of both.
    struct Sandbox {
        root: PathBuf,
        pending_file: String,
        pending: Pending,
        installed_exe: PathBuf,
        version: String,
    }

    fn sandbox(tag: &str, installer_body: &str, claim_version: Option<&str>) -> Option<Sandbox> {
        let stand_in = Path::new(r"C:\Windows\System32\where.exe");
        let (_, version) = win::version_info(stand_in);
        let version = version?;

        let root = std::env::temp_dir().join(format!("atlas-helper-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let install = root.join("install");
        let backup = root.join("backup");
        fs::create_dir_all(&install).unwrap();
        let installed_exe = install.join(install_exe_name());
        fs::copy(stand_in, &installed_exe).unwrap();
        fs::write(install.join("data.txt"), "good").unwrap();
        copy_tree(&install, &backup, &[]).unwrap();

        let installer = root.join("installer.bat");
        fs::write(&installer, format!("@echo off\r\n{installer_body}\r\n")).unwrap();

        let pending = Pending {
            from: "1.0.0".into(),
            to: claim_version.unwrap_or(&version).to_string(),
            installer: installer.to_string_lossy().into_owned(),
            backup: backup.to_string_lossy().into_owned(),
            install_dir: install.to_string_lossy().into_owned(),
            exe_name: install_exe_name(),
            phase: "handoff".into(),
            attempts: 0,
            detail: None,
        };
        let pending_file = root.join("pending.json").to_string_lossy().into_owned();
        Some(Sandbox { root, pending_file, pending, installed_exe, version })
    }

    fn data(sb: &Sandbox) -> String {
        fs::read_to_string(Path::new(&sb.pending.install_dir).join("data.txt")).unwrap()
    }

    #[test]
    fn helper_success_path_installs_and_records_it() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-ok-{}", std::process::id()));
        let body = format!(
            "echo new> \"{}\\data.txt\"\r\nexit /b 0",
            dir.join("install").display()
        );
        let Some(mut sb) = sandbox("ok", &body, None) else { return };
        // the installer body targets the sandbox created under the same name
        assert_eq!(sb.root, dir);
        apply(&mut sb.pending, &sb.pending_file);
        assert_eq!(sb.pending.phase, "installed", "{:?}", sb.pending.detail);
        assert!(data(&sb).starts_with("new"), "the installer's changes stay");
        let _ = sb.version;
        let _ = fs::remove_dir_all(&sb.root);
    }

    #[test]
    fn helper_rolls_back_when_the_installer_fails() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-fail-{}", std::process::id()));
        let body = format!(
            "echo broken> \"{}\\data.txt\"\r\nexit /b 1",
            dir.join("install").display()
        );
        let Some(mut sb) = sandbox("fail", &body, None) else { return };
        apply(&mut sb.pending, &sb.pending_file);
        assert_eq!(sb.pending.phase, "rolled-back");
        assert_eq!(data(&sb), "good", "the backup was put back");
        assert!(sb.pending.detail.as_deref().unwrap_or("").contains("went back to version 1.0.0"));
        // and the next start of the old version reports it, once
        let (status, action) = decide_startup(Some(sb.pending.clone()), "1.0.0");
        assert_eq!(status.outcome, "rolled-back");
        assert_eq!(action, Action::Delete);
        let _ = fs::remove_dir_all(&sb.root);
    }

    #[test]
    fn helper_rolls_back_when_the_installed_program_is_the_wrong_version() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-ver-{}", std::process::id()));
        let body = format!(
            "echo broken> \"{}\\data.txt\"\r\nexit /b 0",
            dir.join("install").display()
        );
        // the installer "succeeds" but the program on disk is not the version promised
        let Some(mut sb) = sandbox("ver", &body, Some("9.9.9")) else { return };
        apply(&mut sb.pending, &sb.pending_file);
        assert_eq!(sb.pending.phase, "rolled-back");
        assert_eq!(data(&sb), "good");
        assert!(sb.installed_exe.is_file());
        let _ = fs::remove_dir_all(&sb.root);
    }

    /// The regression. The helper is a *copy* of Atlas called
    /// `atlas-update-helper.exe`, so the installed program is never called what
    /// the running process is called. Every earlier test put the installed exe
    /// at `install_exe_name()` — the test binary's own name — which is exactly
    /// what the buggy code also computed, so they passed by construction while
    /// every real update rolled back.
    #[test]
    fn helper_finds_the_installed_program_by_its_recorded_name_not_its_own() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-name-{}", std::process::id()));
        let body = format!(
            "echo new> \"{}\\data.txt\"\r\nexit /b 0",
            dir.join("install").display()
        );
        let Some(mut sb) = sandbox("name", &body, None) else { return };
        let real_name = "Atlas-Installed-Name.exe";
        assert_ne!(real_name, install_exe_name(), "the point is that the names differ");
        let renamed = Path::new(&sb.pending.install_dir).join(real_name);
        fs::rename(&sb.installed_exe, &renamed).unwrap();
        sb.pending.exe_name = real_name.into();

        apply(&mut sb.pending, &sb.pending_file);

        assert_eq!(sb.pending.phase, "installed", "{:?}", sb.pending.detail);
        assert!(data(&sb).starts_with("new"), "the installer's changes stay");
        let _ = fs::remove_dir_all(&sb.root);
    }

    /// An exit code of 0 with the wrong program on disk must not be described
    /// as the installer "finishing with an error" — the two failures need two
    /// different sentences, or the second one is impossible to diagnose.
    #[test]
    fn a_wrong_version_is_reported_as_a_wrong_version_not_as_an_installer_error() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-msg-{}", std::process::id()));
        let body = format!(
            "echo x> \"{}\\data.txt\"\r\nexit /b 0",
            dir.join("install").display()
        );
        let Some(mut sb) = sandbox("msg", &body, Some("9.9.9")) else { return };
        apply(&mut sb.pending, &sb.pending_file);
        let detail = sb.pending.detail.clone().unwrap_or_default();
        assert!(detail.contains("is version"), "{detail}");
        assert!(detail.contains("not 9.9.9"), "{detail}");
        assert!(!detail.contains("finished with an error"), "{detail}");
        let _ = fs::remove_dir_all(&sb.root);
    }

    #[test]
    fn a_missing_installed_program_is_reported_as_missing() {
        let dir = std::env::temp_dir().join(format!("atlas-helper-gone-{}", std::process::id()));
        let body = format!(
            "echo x> \"{}\\data.txt\"\r\nexit /b 0",
            dir.join("install").display()
        );
        let Some(mut sb) = sandbox("gone", &body, None) else { return };
        sb.pending.exe_name = "does-not-exist.exe".into();
        apply(&mut sb.pending, &sb.pending_file);
        let detail = sb.pending.detail.clone().unwrap_or_default();
        assert!(detail.contains("could not be found or read"), "{detail}");
        let _ = fs::remove_dir_all(&sb.root);
    }

    #[test]
    fn a_pending_file_from_before_exe_name_existed_still_reads() {
        let old = r#"{"from":"1.0.0","to":"1.0.1","installer":"i","backup":"b","install_dir":"d","phase":"handoff","attempts":0,"detail":null}"#;
        let p: Pending = serde_json::from_str(old).expect("an older pending.json must still load");
        assert_eq!(p.exe_name, "atlas-desktop.exe");
    }

    #[test]
    fn a_real_installer_is_measured_including_its_version_resource() {
        // Only meaningful where an installer has been built; skipped otherwise.
        let p = Path::new(r"D:\Dev\Atlas\apps\desktop\src-tauri\target\release\bundle\nsis\Atlas_0.85.0_x64-setup.exe");
        if !p.is_file() {
            return;
        }
        let report = measure(p).unwrap();
        assert_eq!(report.product.as_deref(), Some("Atlas"));
        assert_eq!(report.version.as_deref(), Some("0.85.0"));
        assert_eq!(report.sha256.len(), 64);
        assert!(["unsigned", "valid"].contains(&report.signature.as_str()), "{}", report.signature);
    }
}
