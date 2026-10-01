//! The Recycle Bin (list and restore), startup apps, printers, Windows Settings
//! pages, and an internet speed test.
//!
//! Same discipline as everywhere: every command takes an enumerated or
//! validated argument. Nothing here runs a command line. Restoring never
//! overwrites; the startup list only flips Windows' own enabled/disabled flag
//! (it never deletes an entry or edits a command); a Settings page is chosen
//! from a fixed table.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

use crate::platform::{is_permitted, plain_path};

// ---- Recycle Bin ----------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BinItem {
    pub name: String,
    pub original: String,
    pub size_bytes: u64,
    /// Epoch milliseconds.
    pub deleted_at: u64,
    pub is_dir: bool,
}

struct RawBinItem {
    item: BinItem,
    info_path: PathBuf,
    data_path: PathBuf,
}

/// One `$I…` record: where the item came from, how big it was, when it was deleted.
/// Version 1 (Vista–8) has a fixed 520-byte path; version 2 (Windows 10+) has a length.
fn parse_info(bytes: &[u8]) -> Option<(String, u64, u64)> {
    if bytes.len() < 28 {
        return None;
    }
    let version = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
    let size = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let filetime = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let path_bytes = match version {
        1 => &bytes[24..],
        2 => {
            let chars = u32::from_le_bytes(bytes[24..28].try_into().ok()?) as usize;
            let end = 28usize.checked_add(chars.checked_mul(2)?)?;
            bytes.get(28..end.min(bytes.len()))?
        }
        _ => return None,
    };
    let units: Vec<u16> = path_bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    let path = String::from_utf16(&units).ok()?;
    if path.is_empty() {
        return None;
    }
    // FILETIME is 100 ns ticks since 1601; Unix epoch is 11,644,473,600 s later.
    let ms = (filetime / 10_000).saturating_sub(11_644_473_600_000);
    Some((path, size, ms))
}

fn bin_items() -> Vec<RawBinItem> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let bin = PathBuf::from(format!("{}:\\$Recycle.Bin", letter as char));
        let Ok(sids) = fs::read_dir(&bin) else { continue };
        for sid in sids.flatten() {
            // Another user's folder simply fails to open; only ours is listed.
            let Ok(entries) = fs::read_dir(sid.path()) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !name.starts_with("$I") {
                    continue;
                }
                let Ok(bytes) = fs::read(e.path()) else { continue };
                let Some((original, size, deleted_at)) = parse_info(&bytes) else { continue };
                let data_path = sid.path().join(format!("$R{}", &name[2..]));
                if !data_path.exists() {
                    continue;
                }
                let file_name = Path::new(&original)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| original.clone());
                out.push(RawBinItem {
                    item: BinItem {
                        name: file_name,
                        original,
                        size_bytes: size,
                        deleted_at,
                        is_dir: data_path.is_dir(),
                    },
                    info_path: e.path(),
                    data_path,
                });
            }
        }
    }
    out.sort_by(|a, b| b.item.deleted_at.cmp(&a.item.deleted_at));
    out
}

/// What is in the Recycle Bin, newest first.
#[tauri::command]
pub async fn recycle_bin_list(limit: Option<u32>) -> Result<Vec<BinItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bin_items().into_iter().take(limit.unwrap_or(30).clamp(1, 200) as usize).map(|r| r.item).collect()
    })
    .await
    .map_err(|e| format!("Reading the Recycle Bin failed: {e}"))
}

/// Put the newest item whose name matches back where it was deleted from. Never
/// overwrites: if something is already there, nothing is restored.
#[tauri::command]
pub async fn recycle_bin_restore(name: String) -> Result<BinItem, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let wanted = name.trim().to_ascii_lowercase();
        if wanted.is_empty() {
            return Err("Restore which one?".to_string());
        }
        let items = bin_items();
        let found: Vec<&RawBinItem> = items
            .iter()
            .filter(|r| r.item.name.to_ascii_lowercase() == wanted)
            .collect();
        let hit = match found.first() {
            Some(h) => h,
            None => {
                let partial: Vec<&RawBinItem> =
                    items.iter().filter(|r| r.item.name.to_ascii_lowercase().contains(&wanted)).collect();
                match partial.len() {
                    0 => return Err(format!("There's nothing called “{}” in the Recycle Bin.", name.trim())),
                    1 => partial[0],
                    n => {
                        return Err(format!(
                            "“{}” matches {n} items in the Recycle Bin — say more of the name.",
                            name.trim()
                        ))
                    }
                }
            }
        };
        let dest = PathBuf::from(&hit.item.original);
        let parent = dest.parent().ok_or("That item has no original folder.")?;
        if !parent.is_dir() {
            return Err("The folder it came from doesn't exist any more.".into());
        }
        // The same boundary as every other file operation.
        if !is_permitted(parent) {
            return Err("It came from outside the folders Atlas can touch — restore it from the Recycle Bin yourself.".into());
        }
        if dest.exists() {
            return Err("Something with that name is already there, so I haven't restored it over it.".into());
        }
        fs::rename(&hit.data_path, &dest).map_err(|e| format!("I couldn't move it back: {e}"))?;
        let _ = fs::remove_file(&hit.info_path);
        Ok(BinItem { original: plain_path(&dest), ..hit.item.clone() })
    })
    .await
    .map_err(|e| format!("Restoring failed: {e}"))?
}

// ---- startup apps ---------------------------------------------------------------------------

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

#[derive(Serialize, Debug, Clone)]
pub struct StartupApp {
    pub name: String,
    pub command: String,
    pub enabled: bool,
    /// "user" or "machine" — where the entry is registered. Machine entries can be
    /// switched off for this user, but not removed.
    pub scope: String,
}

fn approved_enabled(name: &str) -> bool {
    let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(APPROVED_KEY, KEY_READ) else {
        return true;
    };
    match k.get_raw_value(name) {
        // First byte: even = enabled (0x02), odd = disabled (0x03).
        Ok(v) => v.bytes.first().map_or(true, |b| b % 2 == 0),
        Err(_) => true,
    }
}

#[tauri::command]
pub fn startup_apps() -> Vec<StartupApp> {
    let mut out = Vec::new();
    for (hive, scope) in [(HKEY_CURRENT_USER, "user"), (HKEY_LOCAL_MACHINE, "machine")] {
        let Ok(k) = RegKey::predef(hive).open_subkey_with_flags(RUN_KEY, KEY_READ) else { continue };
        for (name, value) in k.enum_values().flatten() {
            let command = value.to_string();
            out.push(StartupApp { enabled: approved_enabled(&name), name, command, scope: scope.into() });
        }
    }
    out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    out
}

/// Switch a startup entry on or off for this user. Only Windows' own
/// enabled/disabled flag changes — the entry and its command are never touched.
#[tauri::command]
pub fn set_startup_app(name: String, enabled: bool) -> Result<StartupApp, String> {
    crate::halt::global().check()?;
    let wanted = name.trim().to_ascii_lowercase();
    let apps = startup_apps();
    let exact: Vec<&StartupApp> = apps.iter().filter(|a| a.name.to_ascii_lowercase() == wanted).collect();
    let pool: Vec<&StartupApp> = if exact.is_empty() {
        apps.iter().filter(|a| !wanted.is_empty() && a.name.to_ascii_lowercase().contains(&wanted)).collect()
    } else {
        exact
    };
    let app = match pool.len() {
        0 => return Err(format!("I don't see a startup app called “{}”.", name.trim())),
        1 => pool[0],
        n => return Err(format!("“{}” matches {n} startup apps — say more of the name.", name.trim())),
    };
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE | KEY_READ)
        .map_err(|e| e.to_string())?;
    // 12 bytes: the state in the first, the rest a timestamp Windows fills in.
    let mut data = vec![0u8; 12];
    data[0] = if enabled { 2 } else { 3 };
    if !enabled {
        let ft = (SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
            + 11_644_473_600_000)
            * 10_000;
        data[4..12].copy_from_slice(&ft.to_le_bytes());
    }
    key.set_raw_value(&app.name, &winreg::RegValue { bytes: data, vtype: winreg::enums::REG_BINARY })
        .map_err(|e| e.to_string())?;
    Ok(StartupApp { enabled, ..app.clone() })
}

// ---- Windows Settings pages --------------------------------------------------------------------

/// Pages that Windows only lets a person change themselves — the default
/// browser, night light, the hotspot, time zone and language, resolution. Atlas
/// opens the right page rather than pretending it can.
fn settings_uri(page: &str) -> Option<&'static str> {
    Some(match page {
        "default-apps" => "ms-settings:defaultapps",
        "network" => "ms-settings:network-status",
        "night-light" => "ms-settings:nightlight",
        "display" => "ms-settings:display",
        "hotspot" => "ms-settings:network-mobilehotspot",
        "time-language" => "ms-settings:dateandtime",
        "language" => "ms-settings:regionlanguage",
        "printers" => "ms-settings:printers",
        "sound" => "ms-settings:sound",
        "bluetooth" => "ms-settings:bluetooth",
        "wifi" => "ms-settings:network-wifi",
        "startup-apps" => "ms-settings:startupapps",
        "installed-apps" => "ms-settings:appsfeatures",
        "storage" => "ms-settings:storagesense",
        "power" => "ms-settings:powersleep",
        "notifications" => "ms-settings:notifications",
        "personalization" => "ms-settings:personalization",
        "windows-update" => "ms-settings:windowsupdate",
        "taskbar" => "ms-settings:taskbar",
        "privacy" => "ms-settings:privacy",
        _ => return None,
    })
}

#[tauri::command]
pub fn open_settings_page(page: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let uri = settings_uri(&page).ok_or_else(|| format!("I don't have a Settings page called “{page}”."))?;
    open::that(uri).map_err(|e| format!("I couldn't open Settings: {e}"))?;
    Ok(true)
}

// ---- printers ----------------------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct Printers {
    pub default: Option<String>,
    pub names: Vec<String>,
}

fn list_printers() -> Result<Printers, String> {
    use windows::Win32::Graphics::Printing::{
        EnumPrintersW, GetDefaultPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        let _ = EnumPrintersW(flags, windows::core::PCWSTR::null(), 4, None, &mut needed, &mut count);
        let mut names = Vec::new();
        if needed > 0 {
            let mut buf = vec![0u8; needed as usize];
            EnumPrintersW(flags, windows::core::PCWSTR::null(), 4, Some(&mut buf), &mut needed, &mut count)
                .map_err(|e| e.message())?;
            let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
            for i in infos {
                if !i.pPrinterName.is_null() {
                    names.push(i.pPrinterName.to_string().unwrap_or_default());
                }
            }
        }
        let mut len = 0u32;
        let _ = GetDefaultPrinterW(windows::core::PWSTR::null(), &mut len);
        let default = if len > 1 {
            let mut b = vec![0u16; len as usize];
            if GetDefaultPrinterW(windows::core::PWSTR(b.as_mut_ptr()), &mut len).as_bool() {
                Some(String::from_utf16_lossy(&b[..(len as usize).saturating_sub(1)]))
            } else {
                None
            }
        } else {
            None
        };
        Ok(Printers { default, names })
    }
}

#[tauri::command]
pub fn printers() -> Result<Printers, String> {
    list_printers()
}

/// Make an installed printer the default. The name must be one Windows lists.
#[tauri::command]
pub fn set_default_printer(name: String) -> Result<Printers, String> {
    use windows::Win32::Graphics::Printing::SetDefaultPrinterW;
    crate::halt::global().check()?;
    let all = list_printers()?;
    let wanted = name.trim().to_ascii_lowercase();
    let pool: Vec<&String> = all.names.iter().filter(|n| n.to_ascii_lowercase() == wanted).collect();
    let pool = if pool.is_empty() {
        all.names.iter().filter(|n| !wanted.is_empty() && n.to_ascii_lowercase().contains(&wanted)).collect()
    } else {
        pool
    };
    let chosen = match pool.len() {
        0 => return Err(format!("No printer called “{}” is installed.", name.trim())),
        1 => pool[0].clone(),
        n => return Err(format!("“{}” matches {n} printers — say more of the name.", name.trim())),
    };
    let wide: Vec<u16> = chosen.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SetDefaultPrinterW(windows::core::PCWSTR(wide.as_ptr())) }
        .ok()
        .map_err(|e| e.message())?;
    list_printers()
}

/// Send a file to the default printer through the shell's own "print" verb —
/// the same as right-click → Print. Only files inside the allowed folders, and
/// only types Windows knows how to print.
#[tauri::command]
pub fn print_file(path: String) -> Result<bool, String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) || !p.is_file() {
        return Err("I can only print a file in the folders Atlas can touch.".into());
    }
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // Anything executable "printed" would be run, so only document types.
    if !matches!(ext.as_str(), "pdf" | "txt" | "doc" | "docx" | "rtf" | "png" | "jpg" | "jpeg" | "bmp" | "gif" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "csv") {
        return Err("I only print documents and pictures (PDF, Word, text, images and the like).".into());
    }
    let wide: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(p.as_os_str()).chain(std::iter::once(0)).collect();
    let r = unsafe { ShellExecuteW(None, w!("print"), PCWSTR(wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_HIDE) };
    if (r.0 as isize) <= 32 {
        return Err("Windows has nothing set up to print that kind of file.".into());
    }
    Ok(true)
}

// ---- flush the DNS cache ----------------------------------------------------------------------------

/// Clear Windows' DNS resolver cache — the fix for "that site won't load but others
/// do". `ipconfig.exe` by its fixed system path with its one fixed switch; no
/// administrator rights are needed on current Windows.
#[tauri::command(async)]
pub fn flush_dns() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    crate::halt::global().check()?;
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let exe = Path::new(&root).join("System32").join("ipconfig.exe");
    if !exe.is_file() {
        return Err("ipconfig isn't where Windows keeps it.".into());
    }
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("/flushdns").creation_flags(0x0800_0000);
    let out = crate::halt::global().run(cmd).map_err(|e| crate::halt::describe(&e, || format!("I couldn't flush the DNS cache: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok("DNS cache flushed.".into())
    } else if text.to_ascii_lowercase().contains("administrator") || text.to_ascii_lowercase().contains("function failed") {
        Err("Windows wants administrator rights to flush the DNS cache on this PC, and I don't do that.".into())
    } else {
        Err("Windows wouldn't flush the DNS cache.".into())
    }
}

// ---- what this PC is --------------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Specs {
    pub cpu: String,
    pub cores: usize,
    pub threads: usize,
    pub memory_gb: f64,
    pub os: String,
    pub computer: String,
    pub gpus: Vec<String>,
}

/// The graphics adapters Windows reports (DXGI), skipping the software renderer.
fn gpu_names() -> Vec<String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            if let Ok(desc) = adapter.GetDesc1() {
                let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..len]);
                if !name.contains("Microsoft Basic Render") && !name.is_empty() {
                    let vram = desc.DedicatedVideoMemory as f64 / 1_073_741_824.0;
                    out.push(if vram >= 0.5 { format!("{name} ({vram:.0} GB)") } else { name });
                }
            }
        }
    }
    out
}

/// CPU, memory, operating system and graphics — what "what are my specs" means.
#[tauri::command(async)]
pub fn hardware_specs() -> Specs {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    Specs {
        cpu: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        cores: sys.physical_core_count().unwrap_or(0),
        threads: sys.cpus().len(),
        memory_gb: sys.total_memory() as f64 / 1_073_741_824.0,
        os: format!("{} {}", System::name().unwrap_or_default(), System::os_version().unwrap_or_default()).trim().to_string(),
        computer: System::host_name().unwrap_or_default(),
        gpus: gpu_names(),
    }
}

// ---- speed test ---------------------------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub download_mbps: f64,
    pub latency_ms: u64,
    pub bytes: u64,
}

/// Download 25 MB from Cloudflare's public speed endpoint and time it. A network
/// call, and only ever on request; nothing is uploaded and nothing is kept.
#[tauri::command]
pub async fn speed_test() -> Result<SpeedResult, String> {
    crate::halt::global().check()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    client
        .get("https://speed.cloudflare.com/__down?bytes=1000")
        .send()
        .await
        .map_err(|_| "I couldn't reach the speed test server — is the internet working?".to_string())?;
    let latency_ms = t0.elapsed().as_millis() as u64;

    let t1 = Instant::now();
    let mut resp = client
        .get("https://speed.cloudflare.com/__down?bytes=25000000")
        .send()
        .await
        .map_err(|_| "The speed test download failed.".to_string())?;
    let mut bytes = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The speed test download was cut off.".to_string())? {
        bytes += chunk.len() as u64;
        if crate::halt::global().check().is_err() {
            return Err("Stopped.".into());
        }
    }
    let secs = t1.elapsed().as_secs_f64().max(0.001);
    Ok(SpeedResult { download_mbps: (bytes as f64 * 8.0 / 1_000_000.0) / secs, latency_ms, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_v2(path: &str, size: u64) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(2u64.to_le_bytes());
        b.extend(size.to_le_bytes());
        // 2026-01-01 00:00:00 UTC as a FILETIME
        let ft: u64 = (1_767_225_600u64 + 11_644_473_600) * 10_000_000;
        b.extend(ft.to_le_bytes());
        let units: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        b.extend((units.len() as u32).to_le_bytes());
        for u in units {
            b.extend(u.to_le_bytes());
        }
        b
    }

    #[test]
    fn a_recycle_bin_record_is_read_back() {
        let (path, size, ms) = parse_info(&record_v2("C:\\Users\\me\\notes.txt", 1234)).unwrap();
        assert_eq!(path, "C:\\Users\\me\\notes.txt");
        assert_eq!(size, 1234);
        assert_eq!(ms, 1_767_225_600_000);
    }

    #[test]
    fn a_truncated_or_unknown_record_is_ignored_not_a_crash() {
        assert!(parse_info(&[0u8; 10]).is_none());
        let mut bad = record_v2("x", 1);
        bad[0] = 9; // unknown version
        assert!(parse_info(&bad).is_none());
        let mut short = record_v2("C:\\a\\b.txt", 1);
        short.truncate(30);
        let _ = parse_info(&short); // must not panic
    }

    #[test]
    fn settings_pages_come_from_a_table() {
        assert_eq!(settings_uri("night-light"), Some("ms-settings:nightlight"));
        assert!(settings_uri("calc.exe").is_none());
        assert!(open_settings_page("../../x".into()).is_err());
    }

    #[test]
    fn hold_key_refuses_before_pressing_anything() {
        assert!(crate::input::hold_key("w".into(), 0.0).is_err());
        assert!(crate::input::hold_key("w".into(), 60.0).is_err());
    }

    /// Live, read-only: what this PC has in each of these.
    #[test]
    fn live_reads() {
        let s = hardware_specs();
        eprintln!("specs: {s:?}");
        assert!(!s.cpu.is_empty() && s.memory_gb > 1.0 && s.threads >= 1);
        eprintln!("bin: {} items", bin_items().len());
        eprintln!("startup: {:?}", startup_apps().iter().map(|a| (&a.name, a.enabled)).collect::<Vec<_>>());
        eprintln!("printers: {:?}", list_printers());
    }

    /// Live round trip on a throwaway file: delete it to the real Recycle Bin,
    /// find it in the listing, restore it, and check it is back, unchanged.
    #[test]
    #[ignore]
    fn live_round_trip_restores_a_deleted_file() {
        let dir = std::env::temp_dir().join(format!("atlas-bin-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        if !is_permitted(&dir) {
            eprintln!("temp is outside the allowed roots here; skipping");
            return;
        }
        let name = format!("atlas-bin-test-{}.txt", std::process::id());
        let f = dir.join(&name);
        fs::write(&f, "restore me").unwrap();
        trash::delete(&f).unwrap();
        assert!(!f.exists());
        assert!(bin_items().iter().any(|r| r.item.name == name), "it should be in the bin");
        let got = tauri::async_runtime::block_on(recycle_bin_restore(name.clone())).unwrap();
        assert_eq!(got.name, name);
        assert_eq!(fs::read_to_string(&f).unwrap(), "restore me");
        // restoring again, with the file back in place, must refuse rather than overwrite
        trash::delete(&f).unwrap();
        fs::write(&f, "newer").unwrap();
        assert!(tauri::async_runtime::block_on(recycle_bin_restore(name)).is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "newer");
        let _ = fs::remove_dir_all(dir);
    }
}
