//! Monitor brightness, per-app volume, the power plan, and display projection.
//!
//! The same rules as the rest of the native surface: a direct Win32 call with a
//! range-checked or enumerated argument; nothing takes a command line. The one
//! exception to "no program is started" is `DisplaySwitch.exe`, the Windows
//! utility behind Win+P, which is launched by its fixed system path with one of
//! four fixed switches (see `project_display`).

#![cfg(windows)]

use std::ffi::c_void;

use serde::Serialize;
use windows::core::{Interface, GUID};
use windows::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
};
use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Power::{PowerGetActiveScheme, PowerSetActiveScheme};

use crate::audio::ComGuard;

// ---- brightness ------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct Brightness {
    /// 0–100, as a percentage of what the monitor reports as its range.
    pub level: u32,
    pub monitors: u32,
}

unsafe extern "system" fn collect(h: HMONITOR, _dc: HDC, _r: *mut RECT, lp: LPARAM) -> BOOL {
    let v = &mut *(lp.0 as *mut Vec<HMONITOR>);
    v.push(h);
    BOOL(1)
}

/// Every physical monitor Windows can talk to over DDC/CI (and laptop panels
/// that expose brightness). A monitor that does not answer is simply absent.
fn with_monitors<T>(mut f: impl FnMut(&PHYSICAL_MONITOR) -> Option<T>) -> Vec<T> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    let mut out = Vec::new();
    for h in handles {
        unsafe {
            let mut n = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(h, &mut n).is_err() || n == 0 {
                continue;
            }
            let mut mons = vec![PHYSICAL_MONITOR::default(); n as usize];
            if GetPhysicalMonitorsFromHMONITOR(h, &mut mons).is_err() {
                continue;
            }
            for m in &mons {
                if let Some(v) = f(m) {
                    out.push(v);
                }
            }
            let _ = DestroyPhysicalMonitors(&mons);
        }
    }
    out
}

fn read_brightness(m: &PHYSICAL_MONITOR) -> Option<(u32, u32, u32)> {
    let (mut lo, mut cur, mut hi) = (0u32, 0u32, 0u32);
    let handle = m.hPhysicalMonitor;
    let ok = unsafe { GetMonitorBrightness(handle, &mut lo, &mut cur, &mut hi) };
    (ok != 0 && hi > lo).then_some((lo, cur, hi))
}

fn percent(lo: u32, cur: u32, hi: u32) -> u32 {
    (((cur.saturating_sub(lo)) as f32 / (hi - lo) as f32) * 100.0).round().clamp(0.0, 100.0) as u32
}

#[tauri::command]
pub async fn brightness_get() -> Result<Brightness, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let levels = with_monitors(|m| read_brightness(m).map(|(lo, cur, hi)| percent(lo, cur, hi)));
        if levels.is_empty() {
            return Err("None of your displays lets Windows change its brightness (many desktop monitors only do it with their own buttons).".to_string());
        }
        Ok(Brightness { level: levels[0], monitors: levels.len() as u32 })
    })
    .await
    .map_err(|e| format!("Reading the brightness failed: {e}"))?
}

/// Set every adjustable display to `level` percent (never fully dark: 5–100).
#[tauri::command]
pub async fn brightness_set(level: u32) -> Result<Brightness, String> {
    crate::halt::global().check()?;
    if !(5..=100).contains(&level) {
        return Err("Brightness is between 5 and 100 — I won't turn a screen fully black.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let changed = with_monitors(|m| {
            let (lo, _cur, hi) = read_brightness(m)?;
            let target = lo + ((hi - lo) as f32 * level as f32 / 100.0).round() as u32;
            let handle = m.hPhysicalMonitor;
            (unsafe { SetMonitorBrightness(handle, target) } != 0).then_some(())
        });
        if changed.is_empty() {
            return Err("None of your displays lets Windows change its brightness (many desktop monitors only do it with their own buttons).".to_string());
        }
        Ok(Brightness { level, monitors: changed.len() as u32 })
    })
    .await
    .map_err(|e| format!("Changing the brightness failed: {e}"))?
}

// ---- per-app volume ------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct AppVolume {
    pub app: String,
    pub pid: u32,
    pub level: u32,
    pub muted: bool,
}

fn process_name(pid: u32) -> String {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    sys.process(Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().trim_end_matches(".exe").to_string())
        .unwrap_or_default()
}

/// Every app with an audio session on the default speakers. `matching` narrows
/// to apps whose name contains it; `level`/`muted` (when given) are applied.
fn sessions(matching: Option<&str>, level: Option<u32>, muted: Option<bool>) -> Result<Vec<AppVolume>, String> {
    let _com = ComGuard::new()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| e.message())?;
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|_| "Windows has no speakers or headphones selected.".to_string())?;
    let mgr: IAudioSessionManager2 =
        unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|e| e.message())?;
    let list = unsafe { mgr.GetSessionEnumerator() }.map_err(|e| e.message())?;
    let count = unsafe { list.GetCount() }.map_err(|e| e.message())?;
    let wanted = matching.map(|m| m.to_ascii_lowercase());
    let mut out = Vec::new();
    for i in 0..count {
        let Ok(ctl) = (unsafe { list.GetSession(i) }) else { continue };
        let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
        let pid = unsafe { ctl2.GetProcessId() }.unwrap_or(0);
        // pid 0 is the "system sounds" session, which has no app to name.
        if pid == 0 {
            continue;
        }
        let app = process_name(pid);
        if app.is_empty() {
            continue;
        }
        if let Some(w) = &wanted {
            if !app.to_ascii_lowercase().contains(w) {
                continue;
            }
        }
        let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else { continue };
        if let Some(l) = level {
            unsafe { vol.SetMasterVolume(l as f32 / 100.0, &GUID::zeroed()) }.map_err(|e| e.message())?;
        }
        if let Some(m) = muted {
            unsafe { vol.SetMute(BOOL::from(m), &GUID::zeroed()) }.map_err(|e| e.message())?;
        }
        let lv = unsafe { vol.GetMasterVolume() }.unwrap_or(0.0);
        let mu = unsafe { vol.GetMute() }.map(|b| b.as_bool()).unwrap_or(false);
        out.push(AppVolume { app, pid, level: (lv * 100.0).round() as u32, muted: mu });
    }
    // One entry per app: a browser has a session per tab.
    out.sort_by(|a, b| a.app.cmp(&b.app).then(a.pid.cmp(&b.pid)));
    Ok(out)
}

#[tauri::command]
pub async fn app_volumes() -> Result<Vec<AppVolume>, String> {
    tauri::async_runtime::spawn_blocking(|| sessions(None, None, None))
        .await
        .map_err(|e| format!("Reading app volumes failed: {e}"))?
}

#[tauri::command]
pub async fn set_app_volume(app: String, level: Option<u32>, muted: Option<bool>) -> Result<Vec<AppVolume>, String> {
    crate::halt::global().check()?;
    let app = app.trim().to_string();
    if app.is_empty() || app.len() > 60 || !app.chars().all(|c| c.is_ascii_alphanumeric() || " ._-+".contains(c)) {
        return Err("That doesn't look like an app name.".into());
    }
    if level.is_some_and(|l| l > 100) {
        return Err("A volume is between 0 and 100.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let r = sessions(Some(&app), level, muted)?;
        if r.is_empty() {
            return Err(format!("{app} isn't playing any sound right now, so Windows has no volume for it yet."));
        }
        Ok(r)
    })
    .await
    .map_err(|e| format!("Changing the app volume failed: {e}"))?
}

// ---- power plan -------------------------------------------------------------------------

const BALANCED: GUID = GUID::from_u128(0x381b4222_f694_41f0_9685_ff5bb260df2e);
const HIGH_PERFORMANCE: GUID = GUID::from_u128(0x8c5e7fda_e8bf_4a96_9a85_a6e23a8c635c);
const POWER_SAVER: GUID = GUID::from_u128(0xa1841308_3541_4fab_bc81_f71556f20b4a);

fn plan_name(g: &GUID) -> &'static str {
    if *g == BALANCED {
        "balanced"
    } else if *g == HIGH_PERFORMANCE {
        "high-performance"
    } else if *g == POWER_SAVER {
        "power-saver"
    } else {
        "custom"
    }
}

#[tauri::command]
pub fn power_plan() -> Result<String, String> {
    unsafe {
        let mut p: *mut GUID = std::ptr::null_mut();
        if PowerGetActiveScheme(None, &mut p).is_err() || p.is_null() {
            return Err("Windows wouldn't say which power plan is active.".into());
        }
        let name = plan_name(&*p);
        let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(p as *mut c_void));
        Ok(name.to_string())
    }
}

/// "balanced", "high-performance" or "power-saver" — Windows' three built-in plans.
#[tauri::command]
pub fn set_power_plan(plan: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let guid = match plan.as_str() {
        "balanced" => BALANCED,
        "high-performance" => HIGH_PERFORMANCE,
        "power-saver" => POWER_SAVER,
        _ => return Err(format!("Windows' plans are balanced, high performance and power saver — not “{plan}”.")),
    };
    let rc = unsafe { PowerSetActiveScheme(None, Some(&guid)) };
    if rc.0 != 0 {
        return Err("Windows wouldn't switch to that plan (this PC may not have it).".into());
    }
    power_plan()
}

// ---- projection ---------------------------------------------------------------------------

/// "pc-only", "duplicate", "extend" or "second-only" — what Win+P offers.
#[tauri::command]
pub fn project_display(mode: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let switch = match mode.as_str() {
        "pc-only" => "/internal",
        "duplicate" => "/clone",
        "extend" => "/extend",
        "second-only" => "/external",
        _ => return Err(format!("Win+P has pc only, duplicate, extend and second screen only — not “{mode}”.")),
    };
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let exe = std::path::Path::new(&root).join("System32").join("DisplaySwitch.exe");
    if !exe.is_file() {
        return Err("DisplaySwitch isn't on this PC.".into());
    }
    std::process::Command::new(exe)
        .arg(switch)
        .spawn()
        .map_err(|e| format!("I couldn't switch the display mode: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brightness_bounds_are_enforced_before_anything_is_sent() {
        let r = tauri::async_runtime::block_on(brightness_set(0));
        assert!(r.is_err());
        let r = tauri::async_runtime::block_on(brightness_set(101));
        assert!(r.is_err());
    }

    #[test]
    fn app_names_and_levels_are_checked() {
        assert!(tauri::async_runtime::block_on(set_app_volume("a;b".into(), Some(10), None)).is_err());
        assert!(tauri::async_runtime::block_on(set_app_volume("".into(), Some(10), None)).is_err());
        assert!(tauri::async_runtime::block_on(set_app_volume("spotify".into(), Some(101), None)).is_err());
    }

    #[test]
    fn unknown_plans_and_modes_are_refused() {
        assert!(set_power_plan("turbo".into()).is_err());
        assert!(project_display("mirror".into()).is_err());
    }

    /// Live round trip, each put back where it was found. Run on purpose:
    /// `cargo test --lib live_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn live_round_trip_restores_everything() {
        if let Ok(b) = tauri::async_runtime::block_on(brightness_get()) {
            // Dim a little, see it move, put it back.
            let lower = if b.level > 20 { b.level - 10 } else { b.level + 10 };
            let _ = tauri::async_runtime::block_on(brightness_set(lower)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(700));
            let seen = tauri::async_runtime::block_on(brightness_get()).unwrap().level;
            assert!(seen.abs_diff(lower) <= 3, "asked for {lower}, monitor says {seen}");
            tauri::async_runtime::block_on(brightness_set(b.level)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(700));
            let back = tauri::async_runtime::block_on(brightness_get()).unwrap().level;
            assert!(back.abs_diff(b.level) <= 3, "restored {back}, was {}", b.level);
            eprintln!("brightness ok ({} -> {lower} -> {back})", b.level);
        }
        if let Ok(apps) = tauri::async_runtime::block_on(app_volumes()) {
            if let Some(a) = apps.first() {
                let r = tauri::async_runtime::block_on(set_app_volume(a.app.clone(), None, Some(!a.muted))).unwrap();
                assert!(r.iter().all(|x| x.muted == !a.muted));
                let r = tauri::async_runtime::block_on(set_app_volume(a.app.clone(), None, Some(a.muted))).unwrap();
                assert!(r.iter().all(|x| x.muted == a.muted));
                eprintln!("app volume ok ({})", a.app);
            }
        }
        let plan = power_plan().unwrap();
        assert_eq!(set_power_plan(if plan == "custom" { "balanced".into() } else { plan.clone() }).unwrap(), plan_or(&plan));
        eprintln!("power plan ok ({plan})");
    }

    fn plan_or(p: &str) -> String {
        if p == "custom" { "balanced".into() } else { p.to_string() }
    }

    /// Live, read-only: what this PC says about brightness, app volumes and its plan.
    #[test]
    fn live_reads() {
        eprintln!("brightness: {:?}", tauri::async_runtime::block_on(brightness_get()));
        eprintln!("app volumes: {:?}", tauri::async_runtime::block_on(app_volumes()));
        eprintln!("plan: {:?}", power_plan());
    }
}
