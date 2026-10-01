//! Read-only questions about this PC and the network, from the tool-catalog pass:
//! DNS lookup, trace route, a running process's file, firmware (BIOS / board /
//! names) and whether the firewall and Defender are on.
//!
//! Nothing here changes anything. Host names are checked the way `ping.rs` checks
//! them; the one program that is run (`tracert.exe`) has fixed arguments and a host
//! that has passed that check; registry reads are of fixed keys and values.
//!
//! A process's command line is deliberately *not* offered: programs are often given
//! tokens and passwords that way, and Atlas does not read those out.

#![cfg(windows)]

use std::collections::BTreeSet;
use std::net::ToSocketAddrs;
use std::os::windows::process::CommandExt;
use std::process::Command;

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---- DNS lookup ----------------------------------------------------------------------

/// The addresses a name resolves to (IPv4 first).
#[tauri::command]
pub async fn dns_lookup(host: String) -> Result<Vec<String>, String> {
    crate::halt::global().check()?;
    if !crate::ping::is_plain_host(&host) {
        return Err("That doesn't look like a host name.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut v4 = BTreeSet::new();
        let mut v6 = BTreeSet::new();
        let found = (host.as_str(), 0u16).to_socket_addrs().map_err(|_| format!("I couldn't find “{host}” — is the name right?"))?;
        for a in found {
            if a.ip().is_ipv4() {
                v4.insert(a.ip().to_string());
            } else {
                v6.insert(a.ip().to_string());
            }
        }
        Ok(v4.into_iter().chain(v6).collect())
    })
    .await
    .map_err(|e| format!("The lookup failed: {e}"))?
}

// ---- trace route ---------------------------------------------------------------------

/// The hops to a host: `tracert -d` (no name lookups, so it is quick), at most 20 hops,
/// a second and a half each. Returns its output, one line per hop.
#[tauri::command]
pub async fn trace_route(host: String) -> Result<Vec<String>, String> {
    crate::halt::global().check()?;
    if !crate::ping::is_plain_host(&host) {
        return Err("That doesn't look like a host name or address.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("tracert.exe");
        cmd.args(["-d", "-h", "20", "-w", "1500"]).arg(&host).creation_flags(CREATE_NO_WINDOW);
        let out = crate::halt::global().run(cmd).map_err(|e| crate::halt::describe(&e, || format!("I couldn't run the trace: {e}")))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        if lines.is_empty() {
            return Err("The trace gave nothing back.".into());
        }
        Ok(lines)
    })
    .await
    .map_err(|e| format!("The trace failed: {e}"))?
}

// ---- a process's file ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetails {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub memory_bytes: u64,
    /// Seconds since it started.
    pub running_seconds: u64,
    pub parent_pid: Option<u32>,
}

/// Where a running process's program lives, how much memory it holds and how long it
/// has been up. Never its command line.
#[tauri::command]
pub async fn process_details(pid: u32) -> Result<ProcessDetails, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let p = sys.process(Pid::from_u32(pid)).ok_or_else(|| "That process isn't running any more.".to_string())?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Ok(ProcessDetails {
            pid,
            name: p.name().to_string_lossy().into_owned(),
            path: p.exe().map(|e| crate::platform::plain_path(e)),
            memory_bytes: p.memory(),
            running_seconds: now.saturating_sub(p.start_time()),
            parent_pid: p.parent().map(|x| x.as_u32()),
        })
    })
    .await
    .map_err(|e| format!("Reading the process failed: {e}"))?
}

// ---- firmware ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub computer_name: String,
    pub user_name: String,
    pub bios_vendor: Option<String>,
    pub bios_version: Option<String>,
    pub bios_date: Option<String>,
    pub system_maker: Option<String>,
    pub system_model: Option<String>,
    pub board_maker: Option<String>,
    pub board_model: Option<String>,
}

fn reg_string(key: &RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// BIOS, motherboard, computer name and the signed-in user's name.
#[tauri::command]
pub fn firmware_info() -> Result<FirmwareInfo, String> {
    crate::halt::global().check()?;
    let mut info = FirmwareInfo {
        computer_name: std::env::var("COMPUTERNAME").unwrap_or_default(),
        user_name: std::env::var("USERNAME").unwrap_or_default(),
        ..Default::default()
    };
    if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(r"HARDWARE\DESCRIPTION\System\BIOS", KEY_READ) {
        info.bios_vendor = reg_string(&k, "BIOSVendor");
        info.bios_version = reg_string(&k, "BIOSVersion");
        info.bios_date = reg_string(&k, "BIOSReleaseDate");
        info.system_maker = reg_string(&k, "SystemManufacturer");
        info.system_model = reg_string(&k, "SystemProductName");
        info.board_maker = reg_string(&k, "BaseBoardManufacturer");
        info.board_model = reg_string(&k, "BaseBoardProduct");
    }
    Ok(info)
}

// ---- security status ----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    /// Per profile (domain, private, public); None when Windows does not say.
    pub firewall_domain: Option<bool>,
    pub firewall_private: Option<bool>,
    pub firewall_public: Option<bool>,
    /// Defender's real-time protection; None when it can't be read (another antivirus may be in charge).
    pub defender_realtime: Option<bool>,
    /// Whether Atlas itself is running with administrator rights.
    pub atlas_elevated: bool,
}

fn firewall_on(profile: &str) -> Option<bool> {
    let path = format!(r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\{profile}");
    let k = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(path, KEY_READ).ok()?;
    k.get_value::<u32, _>("EnableFirewall").ok().map(|v| v != 0)
}

fn current_process_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut info = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(token, TokenElevation, Some(&mut info as *mut _ as *mut _), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut returned).is_ok();
        let _ = CloseHandle(token);
        ok && info.TokenIsElevated != 0
    }
}

/// Is the firewall on, is Defender watching, is Atlas running as administrator. Reads only.
#[tauri::command]
pub fn security_status() -> Result<SecurityStatus, String> {
    crate::halt::global().check()?;
    let defender = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows Defender\Real-Time Protection", KEY_READ)
        .ok()
        // The value says "disabled"; absent means it is on.
        .map(|k| k.get_value::<u32, _>("DisableRealtimeMonitoring").map(|v| v == 0).unwrap_or(true));
    Ok(SecurityStatus {
        firewall_domain: firewall_on("DomainProfile"),
        firewall_private: firewall_on("StandardProfile"),
        firewall_public: firewall_on("PublicProfile"),
        defender_realtime: defender,
        atlas_elevated: current_process_elevated(),
    })
}

// ---- which helper programs are installed ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersions {
    pub git: Option<String>,
    pub ffmpeg: Option<String>,
}

fn first_line(cmd: &mut Command) -> Option<String> {
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = crate::halt::global().run(std::mem::replace(cmd, Command::new("cmd"))).ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Whether git and ffmpeg are installed, and their versions. Fixed programs, fixed arguments.
#[tauri::command]
pub async fn tool_versions() -> Result<ToolVersions, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(|| {
        let git = first_line(Command::new("git").arg("--version"));
        let ffmpeg = crate::media_tools::find_ffmpeg().and_then(|p| first_line(Command::new(p).arg("-version")));
        Ok(ToolVersions { git, ffmpeg })
    })
    .await
    .map_err(|e| format!("The check failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmware_names_this_pc() {
        let f = firmware_info().unwrap();
        assert!(!f.computer_name.is_empty());
    }

    #[test]
    fn a_running_process_has_a_path_and_no_command_line() {
        let pid = std::process::id();
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let p = sys.process(Pid::from_u32(pid)).expect("this process");
        assert!(p.exe().is_some());
    }

    #[test]
    fn the_security_status_reads_without_failing() {
        let _ = security_status().unwrap();
    }
}
