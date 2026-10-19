//! A visible terminal that runs something, and a log Atlas can read afterwards.
//!
//! `powershell.run` runs a short script in a hidden window and hands back what it printed. That is the
//! wrong shape for what people actually ask of a terminal: "open Claude Code", "start my dev server",
//! "run the tests and let me watch". Those need a REAL window the person can see and type into, which
//! stays open, plus a way for Atlas to find out how it went. This module is that, and nothing more.
//!
//! It is NOT a second way to run arbitrary commands. Everything that gates `run_powershell` gates this:
//!
//!   · the script goes through the same refusal table (`powershell::refusal`) and the same
//!     Allowed-Folders check on every path it spells out, here in Rust next to the machine;
//!   · the person has read the whole script on a confirmation card that no execution mode softens
//!     (`terminal.open`'s `preview` in TypeScript), and the script that runs is byte-for-byte the one
//!     that was shown: it is written verbatim into a launcher file in Atlas's own protected folder;
//!   · the emergency stop is checked first, and the number of kept logs is bounded.
//!
//! What the window reports back: a log file with `[atlas-started]` when the launcher began, the
//! script's output (when `watch` is on), and `[atlas-exit:N]` when it finished. Atlas reads those; it
//! never assumes a window opened or a command succeeded because it asked Windows to.
//!
//! The limit, stated plainly: a full-screen program (a terminal UI such as an AI coding assistant) draws
//! straight to the console, not through PowerShell's output, so its screen cannot be logged. Run those
//! with `watch` off: Atlas then knows the window started and when it ended, not what was on screen.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DIR: &str = "terminals";
const KEEP: usize = 20;
const READ_CAP: u64 = 256 * 1024;
const DEFAULT_TAIL: usize = 6_000;
const MAX_TAIL: usize = 20_000;
const MARK_STARTED: &str = "[atlas-started]";
const MARK_EXIT: &str = "[atlas-exit:";
const MARK_PID: &str = "[atlas-pid:";

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRead {
    pub id: String,
    /// The window's own launcher ran (it wrote `[atlas-started]`).
    pub started: bool,
    /// Started and not yet finished.
    pub running: bool,
    pub exit_code: Option<i32>,
    /// The end of the log, markers removed.
    pub text: String,
    /// More was logged than `text` shows.
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub id: String,
    /// Milliseconds since the epoch the log was created.
    pub at: u64,
    pub started: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `term-` + hex and dashes only, so an id can never be a path.
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() <= 40 && id.starts_with("term-") && id[5..].chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("I couldn't make a folder for terminal logs: {e}"))?;
    Ok(dir)
}

/// A string as a PowerShell single-quoted literal: nothing inside it is ever interpreted.
pub(crate) fn psq(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The one line shown in the window as "what Atlas started": the script's first line, tidied.
fn preview_line(script: &str) -> String {
    let first = script.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let one: String = first.chars().filter(|c| !c.is_control()).take(90).collect();
    if script.lines().filter(|l| !l.trim().is_empty()).count() > 1 || first.chars().count() > 90 {
        format!("{one} …")
    } else {
        one
    }
}

/// The launcher file's text. The person's script appears exactly once, verbatim, inside a script block.
pub(crate) fn launcher(script: &str, cwd: &Path, log: &Path, title: &str, watch: bool) -> String {
    let run = if watch {
        // Everything the script writes (all streams) is mirrored to the log AND still shown in the window.
        format!(
            "  & {{\n{script}\n  }} *>&1 | ForEach-Object {{ $__s = ($_ | Out-String).TrimEnd(\"`r\",\"`n\"); __atlas_log $__s; $_ }}"
        )
    } else {
        format!("  & {{\n{script}\n  }}")
    };
    format!(
        "$ErrorActionPreference = 'Continue'\n\
         $__log = {log}\n\
         function __atlas_log([string]$line) {{ try {{ [IO.File]::AppendAllText($__log, $line + \"`r`n\", (New-Object Text.UTF8Encoding($false))) }} catch {{}} }}\n\
         $Host.UI.RawUI.WindowTitle = {title}\n\
         Set-Location -LiteralPath {cwd}\n\
         __atlas_log '{started}'\n\
         __atlas_log \"{pid_open}$PID]\"\n\
         Write-Host {shown} -ForegroundColor Cyan\n\
         $global:LASTEXITCODE = $null\n\
         $__failed = $false\n\
         try {{\n{run}\n}} catch {{ $__failed = $true; $__m = $_.ToString(); __atlas_log $__m; Write-Host $__m -ForegroundColor Red }}\n\
         $__code = if ($__failed) {{ 1 }} elseif ($null -ne $global:LASTEXITCODE) {{ [int]$global:LASTEXITCODE }} else {{ 0 }}\n\
         __atlas_log \"{exit_open}$__code]\"\n\
         Write-Host \"[Atlas] Finished with exit code $__code. This window stays open.\" -ForegroundColor Cyan\n",
        log = psq(&log.to_string_lossy()),
        title = psq(title),
        cwd = psq(&cwd.to_string_lossy()),
        started = MARK_STARTED,
        pid_open = MARK_PID,
        shown = psq(&format!("[Atlas] Running: {}", preview_line(script))),
        exit_open = MARK_EXIT,
    )
}

/// Written WITH a byte-order mark: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page, which
/// garbles any non-ASCII character in a path, a title or the script itself.
pub(crate) fn write_launcher(path: &Path, text: &str) -> std::io::Result<()> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(path, bytes)
}

/// The exit code in a log: the LAST `[atlas-exit:N]` marker, if any.
pub(crate) fn exit_code_of(log: &str) -> Option<i32> {
    let at = log.rfind(MARK_EXIT)?;
    let rest = &log[at + MARK_EXIT.len()..];
    let end = rest.find(']')?;
    rest[..end].trim().parse::<i32>().ok()
}

/// The process id the launcher wrote about itself, if any.
pub(crate) fn pid_of(log: &str) -> Option<u32> {
    let at = log.find(MARK_PID)?;
    let rest = &log[at + MARK_PID.len()..];
    rest[..rest.find(']')?].trim().parse::<u32>().ok()
}

/// The log without Atlas's own marker lines.
pub(crate) fn visible_text(log: &str) -> String {
    log.lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.starts_with(MARK_STARTED) && !t.starts_with(MARK_EXIT) && !t.starts_with(MARK_PID)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last `max` characters, cut at a line start when possible. `(text, was it cut)`.
pub(crate) fn tail(text: &str, max: usize) -> (String, bool) {
    let n = text.chars().count();
    if n <= max {
        return (text.to_string(), false);
    }
    let skip = n - max;
    let cut: String = text.chars().skip(skip).collect();
    let trimmed = match cut.find('\n') {
        Some(i) if i < cut.len() / 4 => cut[i + 1..].to_string(),
        _ => cut,
    };
    (trimmed, true)
}

fn read_log(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len > READ_CAP {
        f.seek(SeekFrom::Start(len - READ_CAP)).ok()?;
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn prune(dir: &Path) {
    let mut entries: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "log"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if entries.len() <= KEEP {
        return;
    }
    entries.sort_by_key(|(t, _)| *t);
    for (_, log) in entries.iter().take(entries.len() - KEEP) {
        let _ = std::fs::remove_file(log);
        let _ = std::fs::remove_file(log.with_extension("ps1"));
    }
}

#[tauri::command(async)]
pub fn terminal_open(
    app: AppHandle,
    script: String,
    cwd: Option<String>,
    watch: Option<bool>,
    title: Option<String>,
) -> Result<TerminalInfo, String> {
    crate::halt::global().check()?;
    if let Some(why) = crate::powershell::refusal(&script) {
        return Err(why);
    }
    crate::powershell::check_paths(&script)?;

    // Where it starts: a folder the person named (which must be allowed), or their own folder.
    let start: PathBuf = match cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(dir) => {
            let p = PathBuf::from(dir);
            if !crate::allowed_folders::is_permitted(&p) {
                return Err("That folder is outside the folders Atlas can touch.".into());
            }
            if !p.is_dir() {
                return Err("That isn't a folder.".into());
            }
            p
        }
        None => std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")),
    };

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let dir = folder(&app)?;
    prune(&dir);
    let id = format!("term-{:x}-{:04x}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff);
    let log = dir.join(format!("{id}.log"));
    let ps1 = dir.join(format!("{id}.ps1"));
    let name: String = title
        .as_deref()
        .map(|t| t.chars().filter(|c| !c.is_control()).take(60).collect::<String>())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| preview_line(&script).chars().take(50).collect());
    let window_title = format!("Atlas: {name}");

    write_launcher(&ps1, &launcher(&script, &start, &log, &window_title, watch.unwrap_or(true)))
        .map_err(|e| format!("I couldn't prepare the terminal: {e}"))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A new console WINDOW the person can see and type into; this process does not wait for it.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        Command::new("powershell.exe")
            .current_dir(&start)
            .args(["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&ps1)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("I couldn't open a terminal: {e}"))?;
        Ok(TerminalInfo { id, title: window_title })
    }
    #[cfg(not(windows))]
    {
        let _ = (ps1, log, window_title);
        Err("Opening a terminal isn't supported here.".into())
    }
}

#[tauri::command]
pub fn terminal_read(app: AppHandle, id: String, tail_chars: Option<u32>) -> Result<TerminalRead, String> {
    if !valid_id(&id) {
        return Err("That isn't a terminal Atlas opened.".into());
    }
    let path = folder(&app)?.join(format!("{id}.log"));
    // No log yet is a real state: the window has been asked for and has not started.
    let log = read_log(&path).unwrap_or_default();
    let started = log.contains(MARK_STARTED);
    let exit_code = exit_code_of(&log);
    let max = (tail_chars.unwrap_or(DEFAULT_TAIL as u32) as usize).clamp(200, MAX_TAIL);
    let (text, truncated) = tail(&visible_text(&log), max);
    Ok(TerminalRead { id, started, running: started && exit_code.is_none(), exit_code, text, truncated })
}

#[tauri::command]
pub fn terminal_list(app: AppHandle) -> Result<Vec<TerminalSummary>, String> {
    let dir = folder(&app)?;
    let mut rows: Vec<TerminalSummary> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()? != "log" {
                return None;
            }
            let id = p.file_stem()?.to_string_lossy().into_owned();
            if !valid_id(&id) {
                return None;
            }
            let log = read_log(&p).unwrap_or_default();
            let exit_code = exit_code_of(&log);
            let started = log.contains(MARK_STARTED);
            let at = e
                .metadata()
                .ok()
                .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(TerminalSummary { id, at, started, running: started && exit_code.is_none(), exit_code })
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.at));
    Ok(rows)
}

// ---- reading a terminal's SCREEN ------------------------------------------------------------

/// Text of the console screen buffer that belongs to `pid`, top to bottom, trailing blanks trimmed.
///
/// A full-screen program (a terminal UI) draws straight to the console and never prints through PowerShell,
/// so the log cannot hold it. The console's own screen buffer can: this attaches to the console of a window
/// Atlas opened, reads the visible rows as text, and lets go. Only the pid Atlas's own launcher wrote about
/// itself is ever used, and only text is read: nothing is typed, clicked or changed.
#[cfg(windows)]
pub(crate) fn read_screen(pid: u32) -> Result<String, String> {
    use std::sync::Mutex;
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows::Win32::System::Console::{AttachConsole, FreeConsole, GetConsoleScreenBufferInfo, ReadConsoleOutputCharacterW, CONSOLE_SCREEN_BUFFER_INFO, COORD};

    // A process has one console at a time: one reader at a time.
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().map_err(|_| "The screen reader is busy.".to_string())?;

    unsafe {
        // Whatever console this process had, if any, is put back by simply not needing it: Atlas is a GUI app.
        let _ = FreeConsole();
        AttachConsole(pid).map_err(|_| "That terminal has no screen I can read (it may have closed).".to_string())?;
        let result = (|| -> Result<String, String> {
            let handle = CreateFileW(w!("CONOUT$"), (GENERIC_READ | GENERIC_WRITE).0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None)
                .map_err(|_| "I couldn't open that terminal's screen.".to_string())?;
            let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
            let got = GetConsoleScreenBufferInfo(handle, &mut info);
            let mut lines = Vec::new();
            if got.is_ok() {
                let width = info.dwSize.X.max(1) as usize;
                let top = info.srWindow.Top.max(0);
                let bottom = info.srWindow.Bottom.max(top);
                for row in top..=bottom.min(top + 199) {
                    let mut buf = vec![0u16; width];
                    let mut read = 0u32;
                    if ReadConsoleOutputCharacterW(handle, &mut buf, COORD { X: 0, Y: row }, &mut read).is_err() {
                        break;
                    }
                    buf.truncate(read as usize);
                    lines.push(String::from_utf16_lossy(&buf).trim_end().to_string());
                }
            }
            let _ = CloseHandle(handle);
            if !got.is_ok() {
                return Err("I couldn't read that terminal's screen.".into());
            }
            while lines.last().is_some_and(|l| l.is_empty()) {
                lines.pop();
            }
            Ok(lines.join("\n"))
        })();
        let _ = FreeConsole();
        result
    }
}

#[cfg(not(windows))]
pub(crate) fn read_screen(_pid: u32) -> Result<String, String> {
    Err("Reading a terminal's screen isn't supported here.".into())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreen {
    pub id: String,
    pub text: String,
}

#[tauri::command(async)]
pub fn terminal_screen(app: AppHandle, id: String) -> Result<TerminalScreen, String> {
    crate::halt::global().check()?;
    if !valid_id(&id) {
        return Err("That isn't a terminal Atlas opened.".into());
    }
    let log = read_log(&folder(&app)?.join(format!("{id}.log"))).unwrap_or_default();
    let Some(pid) = pid_of(&log) else {
        return Err("That terminal hasn't started yet, or has no screen I can read.".into());
    };
    let text = read_screen(pid)?;
    let (text, _) = tail(&text, MAX_TAIL);
    Ok(TerminalScreen { id, text })
}

// ---- which developer tools are installed -------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub name: String,
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// (name, the argument that prints a version). The ONLY programs this will ever run, and only with
/// that one fixed argument: a request cannot widen the list or change the arguments.
const KNOWN_TOOLS: &[(&str, &str)] = &[
    ("git", "--version"),
    ("node", "--version"),
    ("npm", "--version"),
    ("pnpm", "--version"),
    ("yarn", "--version"),
    ("bun", "--version"),
    ("deno", "--version"),
    ("python", "--version"),
    ("py", "--version"),
    ("pip", "--version"),
    ("uv", "--version"),
    ("cargo", "--version"),
    ("rustc", "--version"),
    ("rustup", "--version"),
    ("dotnet", "--version"),
    ("go", "version"),
    ("java", "-version"),
    ("javac", "-version"),
    ("cmake", "--version"),
    ("make", "--version"),
    ("docker", "--version"),
    ("gh", "--version"),
    ("winget", "--version"),
    ("ffmpeg", "-version"),
    ("code", "--version"),
    ("claude", "--version"),
    ("opencode", "--version"),
    ("codex", "--version"),
    ("ollama", "--version"),
];

pub(crate) fn known_tool(name: &str) -> Option<(&'static str, &'static str)> {
    let lower = name.trim().to_ascii_lowercase();
    KNOWN_TOOLS.iter().copied().find(|(n, _)| *n == lower)
}

/// The first non-empty line, cut short.
pub(crate) fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(120).collect())
}

#[tauri::command(async)]
pub fn dev_tools_probe(names: Vec<String>) -> Result<Vec<ToolProbe>, String> {
    crate::halt::global().check()?;
    let wanted: Vec<(&str, &str)> = if names.is_empty() {
        KNOWN_TOOLS.to_vec()
    } else {
        let mut out = Vec::new();
        for n in names.iter().take(40) {
            match known_tool(n) {
                Some(t) if !out.contains(&t) => out.push(t),
                Some(_) => {}
                None => return Err(format!("I only check these tools: {}.", KNOWN_TOOLS.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", "))),
            }
        }
        out
    };

    let mut rows = Vec::new();
    for (name, arg) in wanted {
        crate::halt::global().check()?;
        let mut where_cmd = Command::new("where.exe");
        where_cmd.arg(name);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            where_cmd.creation_flags(0x0800_0000);
        }
        let found_at = crate::halt::global()
            .run_for(where_cmd, Duration::from_secs(5))
            .ok()
            .filter(|(o, timed_out)| !timed_out && o.status.success())
            .and_then(|(o, _)| first_line(&String::from_utf8_lossy(&o.stdout)));
        let Some(path) = found_at else {
            rows.push(ToolProbe { name: name.to_string(), found: false, version: None, path: None });
            continue;
        };
        let mut cmd = Command::new(&path);
        cmd.arg(arg);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let version = crate::halt::global()
            .run_for(cmd, Duration::from_secs(8))
            .ok()
            .and_then(|(o, timed_out)| {
                if timed_out {
                    return None;
                }
                // `java -version` prints to stderr, most others to stdout.
                first_line(&String::from_utf8_lossy(&o.stdout)).or_else(|| first_line(&String::from_utf8_lossy(&o.stderr)))
            });
        rows.push(ToolProbe { name: name.to_string(), found: true, version, path: Some(path) });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_can_never_be_a_path() {
        assert!(valid_id("term-1a2b3c-0001"));
        for bad in ["", "term-", "../x", "term-../x", "term-zz", "chg-1", "term-1/2", &format!("term-{}", "a".repeat(60))] {
            assert!(!valid_id(bad) || bad == "term-", "{bad}");
        }
        assert!(!valid_id("..\\..\\storage"));
    }

    #[test]
    fn a_path_in_the_launcher_is_always_a_literal() {
        assert_eq!(psq("D:\\Dev\\it's here"), "'D:\\Dev\\it''s here'");
        let l = launcher("npm test", Path::new("D:\\Dev\\O'Brien"), Path::new("C:\\a\\x.log"), "Atlas: it's", true);
        assert!(l.contains("Set-Location -LiteralPath 'D:\\Dev\\O''Brien'"), "{l}");
        assert!(l.contains("WindowTitle = 'Atlas: it''s'"));
    }

    #[test]
    fn the_script_appears_exactly_once_and_unchanged() {
        let script = "Get-ChildItem 'D:\\Dev'\nWrite-Output \"done\"";
        let l = launcher(script, Path::new("D:\\Dev"), Path::new("C:\\a\\x.log"), "t", true);
        assert_eq!(l.matches("Get-ChildItem 'D:\\Dev'\nWrite-Output \"done\"").count(), 1);
        // And the shown line is only a preview, so the full text is not repeated.
        assert!(l.contains("Running: Get-ChildItem 'D:\\Dev' …") || l.contains("Running: Get-ChildItem ''D:\\Dev'' …"));
    }

    #[test]
    fn watching_mirrors_output_and_not_watching_does_not() {
        let on = launcher("npm test", Path::new("D:\\Dev"), Path::new("C:\\a\\x.log"), "t", true);
        let off = launcher("opencode", Path::new("D:\\Dev"), Path::new("C:\\a\\x.log"), "t", false);
        assert!(on.contains("*>&1 | ForEach-Object"));
        assert!(!off.contains("*>&1"));
        // Both still say they started and how they ended.
        for l in [&on, &off] {
            assert!(l.contains("[atlas-started]"));
            assert!(l.contains("[atlas-exit:"));
        }
    }

    #[test]
    fn the_exit_code_is_the_last_marker_and_markers_are_hidden_from_the_text() {
        let log = "[atlas-started]\nhello\n[atlas-exit:1]\nagain\n[atlas-exit:0]\n";
        assert_eq!(exit_code_of(log), Some(0));
        assert_eq!(exit_code_of("[atlas-started]\nstill going"), None);
        assert_eq!(exit_code_of("[atlas-exit:abc]"), None);
        assert_eq!(visible_text(log), "hello\nagain");
    }

    #[test]
    fn a_long_log_is_cut_from_the_front_and_says_so() {
        let log = (0..500).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let (t, cut) = tail(&log, 100);
        assert!(cut);
        assert!(t.chars().count() <= 100);
        assert!(t.ends_with("line 499"));
        assert!(!t.starts_with("ine"), "cut at a line start where it can: {t:?}");
        assert_eq!(tail("short", 100), ("short".to_string(), false));
    }

    #[test]
    fn the_powershell_policy_still_applies_to_what_a_terminal_would_run() {
        // The same table `run_powershell` uses: anything refused there is refused here.
        for bad in ["Remove-Item D:\\x -Recurse", "iex (iwr http://x)", "Start-Process cmd", "powershell -enc AAAA", "reg add HKLM\\x", ""] {
            assert!(crate::powershell::refusal(bad).is_some(), "{bad}");
        }
        for ok in ["opencode", "claude", "npm run dev", "cargo test", "git status", "Write-Output hi"] {
            assert!(crate::powershell::refusal(ok).is_none(), "{ok}: {:?}", crate::powershell::refusal(ok));
        }
    }

    #[test]
    fn only_known_tools_are_ever_probed_and_with_one_fixed_argument() {
        assert_eq!(known_tool("Git"), Some(("git", "--version")));
        assert_eq!(known_tool(" java "), Some(("java", "-version")));
        for bad in ["rm", "powershell", "cmd", "git --exec-path", "../node", "node; calc", ""] {
            assert_eq!(known_tool(bad), None, "{bad}");
        }
        assert!(KNOWN_TOOLS.iter().all(|(_, arg)| arg.starts_with('-') || *arg == "version"));
    }

    #[test]
    fn a_version_is_the_first_line_only() {
        assert_eq!(first_line("\n  git version 2.45.0.windows.1\nmore"), Some("git version 2.45.0.windows.1".into()));
        assert_eq!(first_line("   \n  "), None);
        assert_eq!(first_line(&"x".repeat(500)).unwrap().chars().count(), 120);
    }

    /// Runs a generated launcher for real (hidden, no -NoExit, in a temp folder) and reads its log back.
    #[cfg(windows)]
    fn run_launcher(script: &str, watch: bool) -> String {
        use std::os::windows::process::CommandExt;
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("atlas-term-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("t.log");
        let ps1 = dir.join("t.ps1");
        write_launcher(&ps1, &launcher(script, &dir, &log, "Atlas: test", watch)).unwrap();
        let status = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&ps1)
            .creation_flags(0x0800_0000)
            .status()
            .unwrap();
        assert!(status.success());
        let text = read_log(&log).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        text
    }

    #[cfg(windows)]
    #[test]
    fn a_real_launcher_logs_its_start_its_output_and_its_exit() {
        let log = run_launcher("Write-Output 'hello from atlas'
Write-Output 'second line'", true);
        assert!(log.contains(MARK_STARTED), "{log}");
        assert!(log.contains("hello from atlas") && log.contains("second line"), "{log}");
        assert_eq!(exit_code_of(&log), Some(0), "{log}");
        assert_eq!(visible_text(&log), "hello from atlas
second line");
    }

    #[cfg(windows)]
    #[test]
    fn non_ascii_text_survives_the_launcher() {
        let text = "caf\u{e9} \u{2014} na\u{ef}ve \u{65e5}\u{672c}";
        let log = run_launcher(&format!("Write-Output '{text}'"), true);
        assert!(log.contains(text), "{log}");
    }

    #[cfg(windows)]
    #[test]
    fn a_real_launcher_reports_a_failing_command_and_a_thrown_error() {
        let failing = run_launcher("& cmd.exe /c \"exit 7\"", true);
        assert_eq!(exit_code_of(&failing), Some(7), "{failing}");
        let thrown = run_launcher("throw 'boom'", true);
        assert_eq!(exit_code_of(&thrown), Some(1), "{thrown}");
        assert!(thrown.contains("boom"), "{thrown}");
    }

    #[test]
    fn the_pid_marker_is_read_and_hidden() {
        let log = "[atlas-started]\n[atlas-pid:4242]\nhello\n";
        assert_eq!(pid_of(log), Some(4242));
        assert_eq!(pid_of("[atlas-started]"), None);
        assert_eq!(visible_text(log), "hello");
    }

    /// A real hidden console with something on its screen that was NOT printed through any log: it is read
    /// back through the console's own screen buffer, which is what makes full-screen programs readable.
    #[cfg(windows)]
    #[test]
    fn the_screen_of_a_real_console_can_be_read_back() {
        use std::os::windows::process::CommandExt;
        // The child must own a console of its own (as a window Atlas opens does), not inherit this test's pipes:
        // an outer PowerShell starts it hidden and reports its pid.
        let out = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "(Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoLogo','-NoProfile','-NoExit','-Command',\"Write-Host 'SCREEN-MARKER-7731'; Start-Sleep -Seconds 40\").Id",
            ])
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("a pid");
        let mut seen = String::new();
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(250));
            if let Ok(text) = read_screen(pid) {
                seen = text;
                if seen.contains("SCREEN-MARKER-7731") {
                    break;
                }
            }
        }
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x0800_0000).output();
        assert!(seen.contains("SCREEN-MARKER-7731"), "screen was: {seen:?}");
    }

    #[cfg(windows)]
    #[test]
    fn reading_a_screen_that_does_not_exist_is_an_error_not_a_crash() {
        assert!(read_screen(0xFFFF_FFF0).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_real_unwatched_launcher_still_marks_start_and_exit_without_logging_output() {
        let log = run_launcher("Write-Output 'screen only'", false);
        assert!(log.contains(MARK_STARTED));
        assert!(!log.contains("screen only"), "{log}");
        assert_eq!(exit_code_of(&log), Some(0), "{log}");
    }
}
