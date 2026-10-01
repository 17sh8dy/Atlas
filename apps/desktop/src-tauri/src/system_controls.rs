//! More of the machine — sleep, a scheduled shutdown, the exact volume, the
//! microphone, and dark mode.
//!
//! The same rules as `os.rs`: every command is a direct Win32 call with an
//! *enumerated* argument (a number in a clamped range, or one of a few words),
//! never a raw flag, key or command line. Nothing here runs a program.
//!
//! Volume and the microphone go through `IAudioEndpointVolume` rather than
//! tapping the volume keys, so "set the volume to 30" lands on 30 and "mute"
//! means muted, not "flip whatever it was".

#![cfg(windows)]

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eCapture, eConsole, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Power::{GetPwrCapabilities, SetSuspendState, SYSTEM_POWER_CAPABILITIES};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, RRF_RT_REG_DWORD,
};
use windows::Win32::System::Shutdown::{
    AbortSystemShutdownW, InitiateSystemShutdownExW, SHUTDOWN_REASON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

use crate::audio::ComGuard;

// ---- sleep and hibernate ------------------------------------------------------

/// What this machine can do, so "hibernate" on one with hibernation switched off
/// is an honest refusal instead of quietly going to sleep.
#[derive(Serialize, Debug, Clone)]
pub struct PowerStates {
    pub sleep: bool,
    pub hibernate: bool,
}

#[tauri::command]
pub fn power_states() -> Result<PowerStates, String> {
    let mut caps = SYSTEM_POWER_CAPABILITIES::default();
    let ok = unsafe { GetPwrCapabilities(&mut caps) };
    if !ok.as_bool() {
        return Err("Windows wouldn't say what power states this PC supports.".into());
    }
    Ok(PowerStates {
        // Modern standby machines report S3 as absent and still sleep fine, so
        // "sleep" is assumed available; only hibernate has a file to check for.
        sleep: true,
        hibernate: caps.HiberFilePresent.as_bool(),
    })
}

/// "sleep" or "hibernate". The call blocks until the machine wakes again, so it
/// runs on its own thread after a short pause — long enough for Atlas to say
/// what it is doing before the screen goes dark.
#[tauri::command]
pub fn sleep_pc(kind: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let hibernate = match kind.as_str() {
        "sleep" => false,
        "hibernate" => true,
        _ => return Err(format!("No sleep state called “{kind}”.")),
    };
    if hibernate && !power_states()?.hibernate {
        return Err(
            "Hibernation is switched off on this PC. (An administrator can turn it on with “powercfg /hibernate on”.)"
                .into(),
        );
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        // Not forced: apps that object get to. Wake events left as they were.
        unsafe { SetSuspendState(hibernate, false, false) };
    });
    Ok(true)
}

// ---- a shutdown on a timer ------------------------------------------------------

/// Windows' own shutdown countdown, so it shows its own warning and can be
/// cancelled from anywhere (`shutdown /a`), not only by Atlas. The delay is
/// clamped: at least 10 seconds (time to change your mind) and at most a day.
#[tauri::command]
pub fn schedule_shutdown(action: String, seconds: u32) -> Result<bool, String> {
    crate::halt::global().check()?;
    let restart = match action.as_str() {
        "shutdown" => false,
        "restart" => true,
        _ => return Err(format!("A scheduled “{action}” isn't something I do.")),
    };
    if !(10..=86_400).contains(&seconds) {
        return Err("Pick a delay between 10 seconds and 24 hours.".into());
    }
    crate::os::enable_shutdown_privilege()?;
    let mut message: Vec<u16> = "Atlas scheduled this. Say “cancel the shutdown” to stop it.\0"
        .encode_utf16()
        .collect();
    unsafe {
        InitiateSystemShutdownExW(
            PCWSTR::null(),
            windows::core::PWSTR(message.as_mut_ptr()),
            seconds,
            BOOL::from(false), // never force apps closed
            BOOL::from(restart),
            SHUTDOWN_REASON(0x8000_0000),
        )
    }
    .map_err(|e| e.message())?;
    Ok(true)
}

/// Stop a pending shutdown, whoever scheduled it. `false` when none was pending.
#[tauri::command]
pub fn cancel_shutdown() -> Result<bool, String> {
    crate::halt::global().check()?;
    crate::os::enable_shutdown_privilege()?;
    Ok(unsafe { AbortSystemShutdownW(PCWSTR::null()) }.is_ok())
}

// ---- volume and microphone --------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct AudioState {
    /// 0–100.
    pub level: u8,
    pub muted: bool,
}

fn endpoint(flow: EDataFlow) -> Result<IAudioEndpointVolume, String> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("Windows couldn't list audio devices: {}", e.message()))?;
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }.map_err(|_| {
        if flow == eCapture {
            "Windows has no microphone selected.".to_string()
        } else {
            "Windows has no speakers or headphones selected.".to_string()
        }
    })?;
    unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }
        .map_err(|e| format!("I couldn't reach that device's volume: {}", e.message()))
}

fn read(ep: &IAudioEndpointVolume) -> Result<AudioState, String> {
    let level = unsafe { ep.GetMasterVolumeLevelScalar() }.map_err(|e| e.message())?;
    let muted = unsafe { ep.GetMute() }.map_err(|e| e.message())?;
    Ok(AudioState { level: (level * 100.0).round().clamp(0.0, 100.0) as u8, muted: muted.as_bool() })
}

/// Shared by the two directions. `level` and `muted` are each optional so one
/// call can set either or both; `None` leaves it alone.
fn change(flow: EDataFlow, level: Option<u8>, muted: Option<bool>) -> Result<AudioState, String> {
    let _com = ComGuard::new()?;
    let ep = endpoint(flow)?;
    if let Some(l) = level {
        if l > 100 {
            return Err("A volume is between 0 and 100.".into());
        }
        unsafe { ep.SetMasterVolumeLevelScalar(f32::from(l) / 100.0, std::ptr::null()) }
            .map_err(|e| e.message())?;
    }
    if let Some(m) = muted {
        unsafe { ep.SetMute(BOOL::from(m), std::ptr::null()) }.map_err(|e| e.message())?;
    }
    read(&ep)
}

#[tauri::command]
pub async fn volume_state() -> Result<AudioState, String> {
    tauri::async_runtime::spawn_blocking(|| change(eRender, None, None))
        .await
        .map_err(|e| format!("Reading the volume failed: {e}"))?
}

#[tauri::command]
pub async fn volume_set(level: Option<u8>, muted: Option<bool>) -> Result<AudioState, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || change(eRender, level, muted))
        .await
        .map_err(|e| format!("Changing the volume failed: {e}"))?
}

#[tauri::command]
pub async fn mic_state() -> Result<AudioState, String> {
    tauri::async_runtime::spawn_blocking(|| change(eCapture, None, None))
        .await
        .map_err(|e| format!("Reading the microphone failed: {e}"))?
}

#[tauri::command]
pub async fn mic_set(level: Option<u8>, muted: Option<bool>) -> Result<AudioState, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || change(eCapture, level, muted))
        .await
        .map_err(|e| format!("Changing the microphone failed: {e}"))?
}

// ---- light and dark mode --------------------------------------------------------------

const PERSONALIZE: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");

fn read_dword(name: PCWSTR) -> Option<u32> {
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            name,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    rc.is_ok().then_some(value)
}

fn write_dword(key: HKEY, name: PCWSTR, value: u32) -> Result<(), String> {
    unsafe { RegSetValueExW(key, name, 0, REG_DWORD, Some(&value.to_le_bytes())) }
        .ok()
        .map_err(|e| e.message())
}

/// "light" or "dark" — for apps and for the system (taskbar, Start), the way
/// the Settings toggle does both together.
#[tauri::command]
pub fn theme_set(mode: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let light = match mode.as_str() {
        "light" => 1u32,
        "dark" => 0u32,
        _ => return Err(format!("Windows has a light and a dark mode, not “{mode}”.")),
    };
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PERSONALIZE,
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
        .ok()
        .map_err(|e| e.message())?;
        let result = write_dword(key, w!("AppsUseLightTheme"), light)
            .and_then(|_| write_dword(key, w!("SystemUsesLightTheme"), light));
        let _ = RegCloseKey(key);
        result?;

        // Tell running windows, so the change is seen now and not at the next sign-in.
        let mut _ignored = 0usize;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(w!("ImmersiveColorSet").as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            3000,
            Some(&mut _ignored),
        );
    }
    let _ = HWND::default();
    Ok(true)
}

/// "light" or "dark", as apps currently see it.
#[tauri::command]
pub fn theme_get() -> Result<String, String> {
    Ok(match read_dword(w!("AppsUseLightTheme")) {
        Some(0) => "dark",
        _ => "light",
    }
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live, and read-only: the volume and microphone answer with sane numbers
    /// (either may be absent on a machine with no sound hardware).
    #[test]
    fn reads_the_audio_levels_without_changing_them() {
        for flow in [eRender, eCapture] {
            match change(flow, None, None) {
                Ok(s) => assert!(s.level <= 100),
                Err(e) => eprintln!("no device for this direction: {e}"),
            }
        }
    }

    #[test]
    fn theme_reads_as_light_or_dark() {
        let t = theme_get().unwrap();
        assert!(t == "light" || t == "dark");
    }

    #[test]
    fn a_shutdown_delay_outside_the_range_is_refused_before_anything_happens() {
        assert!(schedule_shutdown("shutdown".into(), 5).is_err());
        assert!(schedule_shutdown("shutdown".into(), 90_000).is_err());
        assert!(schedule_shutdown("hibernate".into(), 60).is_err());
    }

    /// Live round trip on this machine's real audio and theme, each put back as
    /// it was found. Run on purpose: `cargo test --lib live_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn live_round_trip_restores_everything() {
        // Speakers: set the level it already has, flip mute, flip it back.
        if let Ok(before) = change(eRender, None, None) {
            let same = change(eRender, Some(before.level), None).unwrap();
            assert_eq!(same.level, before.level, "setting the same level leaves it there");
            let flipped = change(eRender, None, Some(!before.muted)).unwrap();
            assert_eq!(flipped.muted, !before.muted, "mute actually changed");
            let back = change(eRender, None, Some(before.muted)).unwrap();
            assert_eq!(back.muted, before.muted, "mute restored");
            assert_eq!(back.level, before.level);
            eprintln!("speakers ok: {before:?}");
        }
        // Microphone, the same way.
        if let Ok(before) = change(eCapture, None, None) {
            let flipped = change(eCapture, None, Some(!before.muted)).unwrap();
            assert_eq!(flipped.muted, !before.muted);
            let back = change(eCapture, None, Some(before.muted)).unwrap();
            assert_eq!(back.muted, before.muted);
            eprintln!("microphone ok: {before:?}");
        }
        // Dark / light, and back.
        let before = theme_get().unwrap();
        let other = if before == "dark" { "light" } else { "dark" };
        theme_set(other.into()).unwrap();
        assert_eq!(theme_get().unwrap(), other);
        theme_set(before.clone()).unwrap();
        assert_eq!(theme_get().unwrap(), before);
        eprintln!("theme ok: {before}");
    }

    #[test]
    fn unknown_words_are_refused() {
        assert!(sleep_pc("nap".into()).is_err());
        assert!(theme_set("sepia".into()).is_err());
    }
}
