//! The default audio devices, by name — "which microphone am I using?"
//!
//! Exists so a setup can say "Shure MV7+ is your microphone" as something it
//! *read*, not something it assumed. It reads; it never changes anything.
//! Windows has no documented API for setting the default device (the one
//! everybody uses, `IPolicyConfig`, is undocumented and has changed shape
//! between releases), so a wrong default is reported with a pointer to Sound
//! settings rather than fixed behind the person's back.

#![cfg(windows)]

use serde::Serialize;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    STGM_READ,
};

#[derive(Serialize, Debug, Clone)]
pub struct AudioDevices {
    /// The default recording device's friendly name, or None when there is none.
    pub input: Option<String>,
    /// The default playback device's friendly name, or None when there is none.
    pub output: Option<String>,
}

/// Same shape as uia.rs's guard: one apartment, torn down on the thread that made it.
struct ComGuard(bool);

impl ComGuard {
    fn new() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_ok() {
            Ok(ComGuard(true))
        } else if hr == windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            Ok(ComGuard(false))
        } else {
            Err(format!("Windows couldn't start COM to read audio devices: {}", hr.message()))
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// The friendly name of the default device for one direction. `None` when
/// Windows reports no default at all (no microphone plugged in), which is an
/// answer, not an error.
fn default_name(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Option<String> {
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }.ok()?;
    let store = unsafe { device.OpenPropertyStore(STGM_READ) }.ok()?;
    let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName) }.ok()?;
    let name = value.to_string();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub fn read_audio_devices() -> Result<AudioDevices, String> {
    let _com = ComGuard::new()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| format!("Windows couldn't list audio devices: {}", e.message()))?;
    Ok(AudioDevices {
        input: default_name(&enumerator, eCapture),
        output: default_name(&enumerator, eRender),
    })
}

#[tauri::command]
pub async fn audio_devices() -> Result<AudioDevices, String> {
    tauri::async_runtime::spawn_blocking(read_audio_devices)
        .await
        .map_err(|e| format!("Reading audio devices failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live: runs against this machine's real audio stack. Either direction may
    /// legitimately be absent (a server with no sound card), so the assertion is
    /// that the read *succeeds* and any name it returns is a real, non-empty one.
    #[test]
    fn reads_the_default_devices_without_error() {
        let devices = read_audio_devices().expect("reading audio devices should not fail");
        for name in [&devices.input, &devices.output].into_iter().flatten() {
            assert!(!name.trim().is_empty());
        }
        eprintln!("default input: {:?}, default output: {:?}", devices.input, devices.output);
    }
}
