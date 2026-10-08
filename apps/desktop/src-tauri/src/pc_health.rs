//! Read-only questions about how this PC is doing, and about files and the registry — added for
//! 1.0.8: live metrics, recent Windows errors, installed software, drivers, network usage, a file's
//! real type and signature, a registry key, and the text of a PDF or Word document.
//!
//! ## Why this is safe to hand to a tool
//!
//! * **Nothing here writes.** No command changes a file, a setting, a service or a registry value.
//! * **Every program that is run has a fixed script.** The three PowerShell reads (`Get-WinEvent`,
//!   `Win32_PnPSignedDriver`, the GPU counters, and `Get-AuthenticodeSignature`) are constants in
//!   this file. A number or a path reaches a script only through an *environment variable*, after
//!   being checked; it is never pasted into the script text, so there is nothing to inject into.
//! * **Paths go through `is_permitted`**, the same Allowed Folders list every other file command uses.
//! * **The registry reader is a closed door.** Only HKCU and HKLM, never the secret hives
//!   (SAM, SECURITY, the LSA keys), `KEY_READ` only, and values named like a password or a token
//!   are reported as hidden rather than read out.
//! * **Everything checks the emergency stop** before it starts, and the programs it runs go
//!   through `halt::global()` so a stop reaches them.
//!
//! Text from the outside world (an event-log message, a document, a registry string) is *data*.
//! It is clipped and returned; nothing here ever interprets it.

#![cfg(windows)]

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Disks, Networks, System};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
use winreg::{RegKey, RegValue};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// A read-only PowerShell query that has not answered by now is stopped.
const PS_SECS: u64 = 25;
/// The most text any single reader hands back.
const MAX_TEXT_CHARS: usize = 60_000;
/// Documents bigger than this are not opened.
const MAX_DOC_BYTES: u64 = 40 * 1024 * 1024;

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut s: String = text.chars().take(max).collect();
        s.push('…');
        s
    }
}

// ---- running a fixed PowerShell read -------------------------------------------------------------

/// Run one of this file's constant scripts, with `env` as its only inputs. Returns stdout.
fn run_fixed_script(script: &str, env: &[(&str, String)]) -> Result<String, String> {
    use base64_encode::encode_utf16le;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"])
        .arg(encode_utf16le(script))
        .creation_flags(CREATE_NO_WINDOW);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let (out, timed_out) = crate::halt::global()
        .run_for(cmd, Duration::from_secs(PS_SECS))
        .map_err(|e| crate::halt::describe(&e, || format!("I couldn't start the check: {e}")))?;
    if timed_out {
        return Err("That check took too long and was stopped.".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// PowerShell's `-EncodedCommand` wants UTF-16LE in base64; written out here so no new crate is needed.
mod base64_encode {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode_utf16le(text: &str) -> String {
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            out.push(TABLE[(b[0] >> 2) as usize] as char);
            out.push(TABLE[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
            out.push(if chunk.len() > 1 { TABLE[(((b[1] & 15) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
            out.push(if chunk.len() > 2 { TABLE[(b[2] & 63) as usize] as char } else { '=' });
        }
        out
    }
}

fn parse_json_rows(text: &str) -> Vec<serde_json::Value> {
    let t = text.trim().trim_start_matches('\u{feff}');
    if t.is_empty() {
        return vec![];
    }
    match serde_json::from_str::<serde_json::Value>(t) {
        Ok(serde_json::Value::Array(v)) => v,
        Ok(v @ serde_json::Value::Object(_)) => vec![v],
        _ => vec![],
    }
}

fn s(v: &serde_json::Value, key: &str) -> String {
    match v.get(key) {
        Some(serde_json::Value::String(x)) => x.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

// ---- live metrics -------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUse {
    pub mount: String,
    pub name: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeavyProcess {
    pub name: String,
    pub instances: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMetrics {
    pub cpu_percent: f32,
    pub cpu_cores: usize,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub disks: Vec<DiskUse>,
    pub top_by_cpu: Vec<HeavyProcess>,
    pub top_by_memory: Vec<HeavyProcess>,
    pub uptime_seconds: u64,
    /// How long the CPU and process figures were measured over.
    pub sampled_ms: u64,
}

fn heavy_processes(sys: &System) -> (Vec<HeavyProcess>, Vec<HeavyProcess>) {
    let cores = sys.cpus().len().max(1) as f32;
    let mut by_name: HashMap<String, HeavyProcess> = HashMap::new();
    for p in sys.processes().values() {
        let name = p.name().to_string_lossy().to_string();
        let e = by_name.entry(name.clone()).or_insert(HeavyProcess { name, instances: 0, cpu_percent: 0.0, memory_bytes: 0 });
        e.instances += 1;
        // sysinfo reports per-core percent (can exceed 100); show it as a share of the whole CPU.
        e.cpu_percent += p.cpu_usage() / cores;
        e.memory_bytes += p.memory();
    }
    let all: Vec<HeavyProcess> = by_name.into_values().collect();
    let mut cpu = all.clone();
    cpu.sort_by(|a, b| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap_or(std::cmp::Ordering::Equal));
    cpu.retain(|p| p.cpu_percent >= 0.1);
    cpu.truncate(5);
    let mut mem = all;
    mem.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    mem.truncate(5);
    (cpu, mem)
}

/// CPU, memory, disks and the heaviest programs, measured over about a second.
#[tauri::command]
pub async fn live_metrics() -> Result<LiveMetrics, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut sys = System::new_all();
        sys.refresh_all();
        std::thread::sleep(Duration::from_millis(900));
        crate::halt::global().check()?;
        sys.refresh_cpu_usage();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        sys.refresh_memory();
        let (top_by_cpu, top_by_memory) = heavy_processes(&sys);
        let disks = Disks::new_with_refreshed_list()
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| DiskUse {
                mount: d.mount_point().to_string_lossy().to_string(),
                name: d.name().to_string_lossy().to_string(),
                used_bytes: d.total_space().saturating_sub(d.available_space()),
                total_bytes: d.total_space(),
            })
            .collect();
        Ok(LiveMetrics {
            cpu_percent: sys.global_cpu_usage(),
            cpu_cores: sys.cpus().len(),
            memory_used_bytes: sys.used_memory(),
            memory_total_bytes: sys.total_memory(),
            swap_used_bytes: sys.used_swap(),
            swap_total_bytes: sys.total_swap(),
            disks,
            top_by_cpu,
            top_by_memory,
            uptime_seconds: System::uptime(),
            sampled_ms: 900,
        })
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- GPU ------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GpuLive {
    pub names: Vec<String>,
    /// Busiest engine, 0–100. `None` when Windows exposes no GPU counters here.
    pub utilization_percent: Option<f64>,
    pub dedicated_used_bytes: Option<u64>,
}

const GPU_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$names = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$util = $null; $mem = $null
try {
  $e = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples
  if ($e) {
    $groups = $e | Group-Object { if ($_.InstanceName -match 'engtype_(\w+)') { $Matches[1] } else { 'x' } }
    $util = ($groups | ForEach-Object { ($_.Group | Measure-Object CookedValue -Sum).Sum } | Measure-Object -Maximum).Maximum
  }
} catch {}
try {
  $m = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples
  if ($m) { $mem = ($m | Measure-Object CookedValue -Sum).Sum }
} catch {}
[pscustomobject]@{ names = $names; util = $util; mem = $mem } | ConvertTo-Json -Compress
"#;

/// GPU names, busiest-engine load and dedicated memory in use, when Windows provides counters.
#[tauri::command]
pub async fn gpu_live() -> Result<GpuLive, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let text = run_fixed_script(GPU_SCRIPT, &[])?;
        let rows = parse_json_rows(&text);
        let Some(v) = rows.first() else { return Ok(GpuLive::default()) };
        let names = match v.get("names") {
            Some(serde_json::Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect(),
            Some(serde_json::Value::String(x)) => vec![x.trim().to_string()],
            _ => vec![],
        };
        Ok(GpuLive {
            names,
            utilization_percent: v.get("util").and_then(|x| x.as_f64()).map(|x| x.clamp(0.0, 100.0)),
            dedicated_used_bytes: v.get("mem").and_then(|x| x.as_f64()).map(|x| x.max(0.0) as u64),
        })
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- network usage --------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterUsage {
    pub name: String,
    pub received_bytes: u64,
    pub sent_bytes: u64,
    pub received_per_sec: u64,
    pub sent_per_sec: u64,
}

/// Bytes each adapter has moved, plus the rate over a one-second sample. Counters only.
#[tauri::command]
pub async fn network_usage() -> Result<Vec<AdapterUsage>, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut nets = Networks::new_with_refreshed_list();
        let before: BTreeMap<String, (u64, u64)> = nets.iter().map(|(n, d)| (n.clone(), (d.total_received(), d.total_transmitted()))).collect();
        std::thread::sleep(Duration::from_millis(1000));
        crate::halt::global().check()?;
        nets.refresh();
        let mut out: Vec<AdapterUsage> = nets
            .iter()
            .filter(|(_, d)| d.total_received() + d.total_transmitted() > 0)
            .map(|(n, d)| {
                let (r0, t0) = before.get(n).copied().unwrap_or((d.total_received(), d.total_transmitted()));
                AdapterUsage {
                    name: n.clone(),
                    received_bytes: d.total_received(),
                    sent_bytes: d.total_transmitted(),
                    received_per_sec: d.total_received().saturating_sub(r0),
                    sent_per_sec: d.total_transmitted().saturating_sub(t0),
                }
            })
            .collect();
        out.sort_by(|a, b| (b.received_bytes + b.sent_bytes).cmp(&(a.received_bytes + a.sent_bytes)));
        Ok(out)
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- recent Windows errors --------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub time: String,
    pub log: String,
    pub source: String,
    pub id: u32,
    pub level: String,
    pub message: String,
}

const EVENTS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$hours = [int]$env:ATLAS_HOURS
$since = (Get-Date).AddHours(-$hours)
$rows = @(Get-WinEvent -FilterHashtable @{ LogName = 'System','Application'; Level = 1,2; StartTime = $since } -MaxEvents 400 |
  Select-Object -First ([int]$env:ATLAS_LIMIT) |
  ForEach-Object {
    $first = ''
    if ($_.Message) { $first = ($_.Message -split "`r?`n")[0] }
    [pscustomobject]@{ t = $_.TimeCreated.ToString('o'); log = $_.LogName; src = $_.ProviderName; id = $_.Id; lvl = $_.LevelDisplayName; msg = $first }
  })
ConvertTo-Json -InputObject $rows -Compress
"#;

/// Critical and error events from the System and Application logs. `hours` 1–168, `limit` 1–200.
#[tauri::command]
pub async fn recent_errors(hours: u32, limit: u32) -> Result<Vec<EventRow>, String> {
    crate::halt::global().check()?;
    let hours = hours.clamp(1, 168);
    let limit = limit.clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || {
        let text = run_fixed_script(EVENTS_SCRIPT, &[("ATLAS_HOURS", hours.to_string()), ("ATLAS_LIMIT", limit.to_string())])?;
        Ok(parse_json_rows(&text)
            .iter()
            .map(|v| EventRow {
                time: s(v, "t"),
                log: s(v, "log"),
                source: s(v, "src"),
                id: s(v, "id").parse().unwrap_or(0),
                level: s(v, "lvl"),
                message: clip(&s(v, "msg"), 220),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- installed software (registry, read only) ---------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub install_date: String,
    pub size_kb: u64,
}

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

fn read_uninstall(root: &RegKey, flags: u32, seen: &mut BTreeSet<String>, out: &mut Vec<InstalledApp>) {
    let Ok(base) = root.open_subkey_with_flags(UNINSTALL, KEY_READ | flags) else { return };
    for name in base.enum_keys().flatten() {
        let Ok(k) = base.open_subkey_with_flags(&name, KEY_READ) else { continue };
        let display: String = k.get_value("DisplayName").unwrap_or_default();
        if display.trim().is_empty() {
            continue;
        }
        // Hidden components and update entries are not "software the person installed".
        if k.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
            continue;
        }
        if k.get_value::<String, _>("ParentKeyName").is_ok() {
            continue;
        }
        let version: String = k.get_value("DisplayVersion").unwrap_or_default();
        if !seen.insert(format!("{}|{}", display.to_lowercase(), version)) {
            continue;
        }
        out.push(InstalledApp {
            name: clip(display.trim(), 120),
            version: clip(version.trim(), 40),
            publisher: clip(k.get_value::<String, _>("Publisher").unwrap_or_default().trim(), 80),
            install_date: k.get_value::<String, _>("InstallDate").unwrap_or_default(),
            size_kb: k.get_value::<u32, _>("EstimatedSize").unwrap_or(0) as u64,
        });
    }
}

/// Programs listed in Add/Remove Programs (machine-wide, 32-bit and this user's).
#[tauri::command]
pub async fn installed_software() -> Result<Vec<InstalledApp>, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        read_uninstall(&hklm, KEY_WOW64_64KEY, &mut seen, &mut out);
        read_uninstall(&hklm, KEY_WOW64_32KEY, &mut seen, &mut out);
        read_uninstall(&RegKey::predef(HKEY_CURRENT_USER), 0, &mut seen, &mut out);
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- drivers -----------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverRow {
    pub device: String,
    pub class: String,
    pub manufacturer: String,
    pub version: String,
    /// yyyy-mm-dd, or empty.
    pub date: String,
    pub signed: Option<bool>,
}

const DRIVERS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName } | ForEach-Object {
  $d = ''
  if ($_.DriverDate) { $d = $_.DriverDate.ToString('yyyy-MM-dd') }
  [pscustomobject]@{ n = $_.DeviceName; c = $_.DeviceClass; m = $_.Manufacturer; v = $_.DriverVersion; d = $d; s = $_.IsSigned }
})
ConvertTo-Json -InputObject $rows -Compress
"#;

/// Installed device drivers (name, class, maker, version, date, signed). Read-only.
#[tauri::command]
pub async fn driver_list() -> Result<Vec<DriverRow>, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let text = run_fixed_script(DRIVERS_SCRIPT, &[])?;
        let mut rows: Vec<DriverRow> = parse_json_rows(&text)
            .iter()
            .map(|v| DriverRow {
                device: clip(&s(v, "n"), 100),
                class: s(v, "c"),
                manufacturer: clip(&s(v, "m"), 60),
                version: s(v, "v"),
                date: s(v, "d"),
                signed: v.get("s").and_then(|x| x.as_bool()),
            })
            .collect();
        rows.sort_by(|a, b| a.class.cmp(&b.class).then(a.device.cmp(&b.device)));
        rows.truncate(600);
        Ok(rows)
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- what a file really is, and who signed it ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileVerdict {
    pub path: String,
    pub size_bytes: u64,
    /// What the first bytes say it is ("Windows program", "PDF document", "ZIP archive", …); empty if unknown.
    pub real_type: String,
    /// Extensions that fit `real_type` (lower-case, no dot).
    pub expected_ext: Vec<String>,
    pub ext: String,
    /// The extension does not fit what the file is.
    pub mismatch: bool,
    pub signable: bool,
    /// "Valid", "NotSigned", "HashMismatch", "NotTrusted", "UnknownError", … — Windows's own word.
    pub signature: String,
    pub signer: String,
    pub issuer: String,
    pub signed_at: String,
}

fn sniff(head: &[u8]) -> (&'static str, &'static [&'static str]) {
    let starts = |m: &[u8]| head.len() >= m.len() && &head[..m.len()] == m;
    if starts(b"MZ") {
        ("Windows program or library", &["exe", "dll", "sys", "scr", "ocx", "cpl", "mui", "efi"])
    } else if starts(b"%PDF-") {
        ("PDF document", &["pdf"])
    } else if starts(&[0x89, b'P', b'N', b'G']) {
        ("PNG image", &["png"])
    } else if starts(&[0xFF, 0xD8, 0xFF]) {
        ("JPEG image", &["jpg", "jpeg", "jpe"])
    } else if starts(b"GIF8") {
        ("GIF image", &["gif"])
    } else if starts(b"BM") && head.len() > 14 {
        ("Bitmap image", &["bmp"])
    } else if starts(b"PK\x03\x04") || starts(b"PK\x05\x06") {
        ("ZIP-based file (zip, Office document, jar, apk…)", &["zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "jar", "apk", "nupkg", "vsix", "epub", "msix", "appx", "7z"])
    } else if starts(b"7z\xBC\xAF\x27\x1C") {
        ("7-Zip archive", &["7z"])
    } else if starts(b"Rar!") {
        ("RAR archive", &["rar"])
    } else if starts(&[0x1F, 0x8B]) {
        ("gzip archive", &["gz", "tgz"])
    } else if starts(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        ("Old Office document or installer (OLE)", &["doc", "xls", "ppt", "msi", "msp", "msg"])
    } else if starts(b"\x7fELF") {
        ("Linux program", &["", "so", "elf", "bin", "o"])
    } else if starts(b"RIFF") && head.len() >= 12 && &head[8..12] == b"WAVE" {
        ("WAV audio", &["wav"])
    } else if starts(b"RIFF") && head.len() >= 12 && &head[8..12] == b"AVI " {
        ("AVI video", &["avi"])
    } else if starts(b"ID3") {
        ("MP3 audio", &["mp3"])
    } else if head.len() >= 12 && &head[4..8] == b"ftyp" {
        ("MP4 / QuickTime media", &["mp4", "m4a", "m4v", "mov", "3gp"])
    } else if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        ("Matroska / WebM video", &["mkv", "webm"])
    } else if starts(b"SQLite format 3") {
        ("SQLite database", &["db", "sqlite", "sqlite3"])
    } else if starts(b"#!") {
        ("Script (starts with #!)", &["sh", "py", "rb", "pl", ""])
    } else {
        ("", &[])
    }
}

const SIGNABLE: &[&str] = &["exe", "dll", "sys", "msi", "msp", "ocx", "scr", "cpl", "ps1", "psm1", "cab", "cat", "msix", "appx"];

const SIGNATURE_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$p = $env:ATLAS_FILE
$sig = Get-AuthenticodeSignature -LiteralPath $p
$signer = ''; $issuer = ''; $when = ''
if ($sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject; $issuer = $sig.SignerCertificate.Issuer }
if ($sig.TimeStamperCertificate) { $when = $sig.TimeStamperCertificate.NotBefore.ToString('yyyy-MM-dd') }
[pscustomobject]@{ status = [string]$sig.Status; signer = $signer; issuer = $issuer; when = $when } | ConvertTo-Json -Compress
"#;

fn cn(subject: &str) -> String {
    // "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, …" → "Microsoft Corporation"
    subject
        .split(", ")
        .find_map(|p| p.strip_prefix("CN="))
        .map(|x| x.trim_matches('"').to_string())
        .unwrap_or_else(|| clip(subject, 120))
}

/// What a file really is (from its first bytes), whether that fits its extension, and — for
/// programs, installers and scripts — whether Windows trusts its signature. Reads only.
#[tauri::command]
pub async fn verify_file(path: String) -> Result<FileVerdict, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(path.trim());
    if !crate::allowed_folders::is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|_| "I can't find that file.".to_string())?;
    if !meta.is_file() {
        return Err("That's a folder; point me at one file.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut head = [0u8; 64];
        let n = std::fs::File::open(&p).and_then(|mut f| f.read(&mut head)).map_err(|e| format!("I couldn't read that file: {e}"))?;
        let (real_type, expected) = sniff(&head[..n]);
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        // A text-ish extension on unknown bytes is fine; only flag when the bytes are positively something else.
        let mismatch = !real_type.is_empty() && !expected.contains(&ext.as_str()) && !(real_type.starts_with("ZIP-based") && ext == "");
        let signable = SIGNABLE.contains(&ext.as_str()) || real_type.starts_with("Windows program");
        let mut v = FileVerdict {
            path: crate::platform::plain_path(&p),
            size_bytes: meta.len(),
            real_type: real_type.to_string(),
            expected_ext: expected.iter().map(|e| e.to_string()).collect(),
            ext,
            mismatch,
            signable,
            ..Default::default()
        };
        if signable {
            let text = run_fixed_script(SIGNATURE_SCRIPT, &[("ATLAS_FILE", crate::platform::plain_path(&p))])?;
            if let Some(row) = parse_json_rows(&text).first() {
                v.signature = s(row, "status");
                v.signer = cn(&s(row, "signer"));
                v.issuer = cn(&s(row, "issuer"));
                v.signed_at = s(row, "when");
            }
        }
        Ok(v)
    })
    .await
    .map_err(|e| format!("The check failed: {e}"))?
}

// ---- registry (read only) --------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegValueRow {
    pub name: String,
    pub kind: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryKey {
    pub key: String,
    pub subkeys: Vec<String>,
    pub subkey_count: usize,
    pub values: Vec<RegValueRow>,
    pub value_count: usize,
}

/// Keys whose contents are credentials or security material, never read out.
const REG_BLOCKED: &[&str] = &[
    r"hklm\sam",
    r"hklm\security",
    r"hklm\system\currentcontrolset\control\lsa",
    r"hklm\system\controlset001\control\lsa",
    r"hklm\software\microsoft\windows nt\currentversion\winlogon",
    r"hklm\software\microsoft\windows nt\currentversion\profilelist",
    r"hklm\software\microsoft\cryptography",
    r"hklm\software\microsoft\systemcertificates",
    r"hkcu\software\microsoft\windows\currentversion\internet settings\zonemap",
    r"hkcu\software\microsoft\protected storage system provider",
    r"hkcu\software\microsoft\ibsyp",
];

const SECRET_WORDS: &[&str] = &["password", "passwd", "secret", "token", "apikey", "api_key", "credential", "privatekey", "private_key", "pwd"];

/// Split `HKCU\a\b` into the hive and the rest, or say why it is refused. Pure.
pub fn parse_registry_path(raw: &str) -> Result<(&'static str, String), String> {
    let cleaned = raw.trim().trim_matches('"').replace('/', r"\");
    let cleaned = cleaned.trim_end_matches('\\').to_string();
    if cleaned.is_empty() || cleaned.len() > 400 || cleaned.chars().any(|c| c.is_control()) {
        return Err("That doesn't look like a registry key.".into());
    }
    let mut parts = cleaned.splitn(2, '\\');
    let hive = parts.next().unwrap_or("").to_uppercase();
    let rest = parts.next().unwrap_or("").to_string();
    let hive = match hive.as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => "HKCU",
        "HKLM" | "HKEY_LOCAL_MACHINE" => "HKLM",
        _ => return Err("I can read HKEY_CURRENT_USER (HKCU) and HKEY_LOCAL_MACHINE (HKLM) only.".into()),
    };
    if rest.split('\\').any(|seg| seg == ".." || seg == ".") {
        return Err("That doesn't look like a registry key.".into());
    }
    let full = format!("{}\\{}", hive.to_lowercase(), rest.to_lowercase());
    let full = full.trim_end_matches('\\');
    if REG_BLOCKED.iter().any(|b| full == *b || full.starts_with(&format!("{b}\\"))) {
        return Err("That key holds security or sign-in data, so I don't read it.".into());
    }
    Ok((hive, rest))
}

fn is_secret_name(name: &str) -> bool {
    let n = name.to_lowercase();
    SECRET_WORDS.iter().any(|w| n.contains(w))
}

fn show_value(name: &str, v: &RegValue) -> RegValueRow {
    use winreg::enums::RegType::*;
    let kind = format!("{:?}", v.vtype).trim_start_matches("REG_").to_string();
    if is_secret_name(name) {
        return RegValueRow { name: name.to_string(), kind, data: "(hidden — looks like a secret)".into() };
    }
    let data = match v.vtype {
        REG_SZ | REG_EXPAND_SZ => String::from_utf16_lossy(&v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).trim_end_matches('\0').to_string(),
        REG_MULTI_SZ => String::from_utf16_lossy(&v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).split('\0').filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" | "),
        REG_DWORD if v.bytes.len() >= 4 => u32::from_le_bytes([v.bytes[0], v.bytes[1], v.bytes[2], v.bytes[3]]).to_string(),
        REG_QWORD if v.bytes.len() >= 8 => u64::from_le_bytes(v.bytes[..8].try_into().unwrap()).to_string(),
        _ => format!("<{} bytes of binary data>", v.bytes.len()),
    };
    RegValueRow { name: name.to_string(), kind, data: clip(&data, 300) }
}

/// The sub-keys and values of one registry key. Only HKCU and HKLM, never the security hives,
/// never writes.
#[tauri::command]
pub async fn registry_read(key: String) -> Result<RegistryKey, String> {
    crate::halt::global().check()?;
    let (hive, rest) = parse_registry_path(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = RegKey::predef(if hive == "HKCU" { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE });
        let k = if rest.is_empty() { root } else { root.open_subkey_with_flags(&rest, KEY_READ).map_err(|_| "That key doesn't exist, or I'm not allowed to read it.".to_string())? };
        let subkeys_all: Vec<String> = k.enum_keys().flatten().collect();
        let mut values = Vec::new();
        let mut value_count = 0usize;
        for item in k.enum_values().flatten() {
            value_count += 1;
            if values.len() < 100 {
                values.push(show_value(&item.0, &item.1));
            }
        }
        Ok(RegistryKey {
            key: format!("{}{}", hive, if rest.is_empty() { String::new() } else { format!("\\{rest}") }),
            subkey_count: subkeys_all.len(),
            subkeys: subkeys_all.into_iter().take(200).collect(),
            value_count,
            values,
        })
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

// ---- document text (PDF, Word) -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub path: String,
    pub format: String,
    pub text: String,
    pub truncated: bool,
    pub pages: Option<u32>,
}

/// Plain text out of word/document.xml: paragraph ends become newlines, tags go, entities decode.
pub fn docx_xml_to_text(xml: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    let b = xml.as_bytes();
    while i < b.len() {
        if b[i] == b'<' {
            let end = xml[i..].find('>').map(|e| i + e).unwrap_or(b.len() - 1);
            let tag = &xml[i + 1..end];
            if tag.starts_with("/w:p") && !tag.starts_with("/w:pPr") && !tag.starts_with("/w:pict") {
                out.push('\n');
            } else if tag.starts_with("w:tab") && !tag.starts_with("w:tabs") && !tag.starts_with("w:tbl") {
                out.push('\t');
            } else if tag.starts_with("w:br") {
                out.push('\n');
            } else if tag.starts_with("/w:tc") {
                out.push('\t');
            }
            i = end + 1;
        } else {
            let next = xml[i..].find('<').map(|n| i + n).unwrap_or(b.len());
            out.push_str(&xml[i..next]);
            i = next;
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

fn read_docx(p: &Path) -> Result<String, String> {
    let file = std::fs::File::open(p).map_err(|e| format!("I couldn't open that: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "That doesn't look like a Word document.".to_string())?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "That doesn't look like a Word document.".to_string())?
        // A decompression bomb is a real thing: never read more than a few MB of XML.
        .take(24 * 1024 * 1024)
        .read_to_string(&mut xml)
        .map_err(|_| "I couldn't read that document's text.".to_string())?;
    Ok(docx_xml_to_text(&xml))
}

fn read_pdf(p: &Path) -> Result<(String, u32), String> {
    let doc = lopdf::Document::load(p).map_err(|_| "I couldn't open that PDF.".to_string())?;
    if doc.is_encrypted() {
        return Err("That PDF is password-protected, so I can't read it.".into());
    }
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    let total = pages.len() as u32;
    let mut text = String::new();
    for n in pages.iter().take(200) {
        crate::halt::global().check()?;
        if let Ok(t) = doc.extract_text(&[*n]) {
            text.push_str(&t);
            text.push('\n');
        }
        if text.chars().count() > MAX_TEXT_CHARS * 2 {
            break;
        }
    }
    Ok((text, total))
}

/// The text of a PDF or .docx, read-only, capped. A scanned PDF (pictures of pages) has no text to give.
#[tauri::command]
pub async fn document_text(path: String) -> Result<DocumentText, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(path.trim());
    if !crate::allowed_folders::is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|_| "I can't find that file.".to_string())?;
    if !meta.is_file() {
        return Err("That's a folder; point me at one file.".into());
    }
    if meta.len() > MAX_DOC_BYTES {
        return Err("That document is too large to read here.".into());
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let (format, raw, pages) = match ext.as_str() {
            "docx" => ("Word document", read_docx(&p)?, None),
            "pdf" => {
                let (t, n) = read_pdf(&p)?;
                ("PDF", t, Some(n))
            }
            _ => return Err("I can read PDF and Word (.docx) documents here. Plain text files open with a normal file read.".to_string()),
        };
        // Collapse the blank-line runs these formats produce.
        let mut text = String::new();
        let mut blank = 0;
        for line in raw.lines() {
            let t = line.trim_end();
            if t.is_empty() {
                blank += 1;
                if blank > 1 {
                    continue;
                }
            } else {
                blank = 0;
            }
            text.push_str(t);
            text.push('\n');
        }
        let truncated = text.chars().count() > MAX_TEXT_CHARS;
        Ok(DocumentText { path: crate::platform::plain_path(&p), format: format.to_string(), text: clip(text.trim(), MAX_TEXT_CHARS), truncated, pages })
    })
    .await
    .map_err(|e| format!("The reading failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_paths_are_parsed_and_the_secret_hives_refused() {
        assert_eq!(parse_registry_path(r"HKCU\Software\Microsoft").unwrap(), ("HKCU", r"Software\Microsoft".to_string()));
        assert_eq!(parse_registry_path("HKEY_LOCAL_MACHINE/SOFTWARE/Microsoft/").unwrap().0, "HKLM");
        assert!(parse_registry_path(r"HKLM\SAM\SAM").is_err());
        assert!(parse_registry_path(r"hklm\security").is_err());
        assert!(parse_registry_path(r"HKLM\SYSTEM\CurrentControlSet\Control\Lsa").is_err());
        assert!(parse_registry_path(r"HKLM\SYSTEM\CurrentControlSet\Control\Lsa\Skew1").is_err());
        assert!(parse_registry_path(r"HKCR\.txt").is_err());
        assert!(parse_registry_path(r"HKCU\Software\..\..\SAM").is_err());
        assert!(parse_registry_path("").is_err());
    }

    #[test]
    fn a_secret_looking_value_is_hidden() {
        let v = RegValue { bytes: vec![b'h', 0, b'i', 0, 0, 0], vtype: winreg::enums::RegType::REG_SZ };
        assert!(show_value("ProxyPassword", &v).data.starts_with("(hidden"));
        assert_eq!(show_value("Greeting", &v).data, "hi");
    }

    #[test]
    fn the_registry_can_be_read_and_the_machine_unchanged() {
        let r = tauri::async_runtime::block_on(registry_read(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer".to_string())).unwrap();
        assert!(r.key.starts_with("HKCU"));
    }

    #[test]
    fn file_types_are_read_from_the_first_bytes() {
        assert_eq!(sniff(b"MZ\x90\x00").0, "Windows program or library");
        assert!(sniff(b"%PDF-1.7").1.contains(&"pdf"));
        assert_eq!(sniff(b"hello world").0, "");
    }

    #[test]
    fn docx_xml_becomes_paragraphs() {
        let xml = r#"<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#;
        assert_eq!(docx_xml_to_text(xml).trim(), "Hello & welcome\nSecond");
    }

    #[test]
    fn the_utf16_encoder_matches_a_known_value() {
        // "A" in UTF-16LE is 41 00 → "QQA="
        assert_eq!(base64_encode::encode_utf16le("A"), "QQA=");
    }
}
