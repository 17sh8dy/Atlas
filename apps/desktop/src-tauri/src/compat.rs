//! What version of Windows this is — informational, never a gate.
//!
//! Every capability this phase added (window control, UI Automation,
//! `SendInput`, GDI capture) works identically back to Windows 7; none of
//! them are actually version-gated. So this module doesn't invent feature
//! flags that would pretend otherwise — it reads the real product name and
//! build, for the About page to say what it honestly can: newer Windows gets
//! better WebView2 and shell support and more features overall, not that
//! Atlas needs a particular version to function.
//!
//! `GetVersionExW` is not used here on purpose — once an app has a manifest
//! (Tauri apps do), it lies and reports Windows 8 forever. Reading
//! `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` directly is what every
//! tool that needs the *real* build number actually does.

#![cfg(windows)]

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD,
    REG_SZ, REG_VALUE_TYPE,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

struct RegKey(HKEY);
impl Drop for RegKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn open_current_version() -> Option<RegKey> {
    let subkey = wide("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let mut hkey = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if status == ERROR_SUCCESS {
        Some(RegKey(hkey))
    } else {
        None
    }
}

fn read_string(key: &RegKey, value: &str) -> Option<String> {
    let name = wide(value);
    let mut kind = REG_VALUE_TYPE(0);
    let mut size: u32 = 0;
    // First call just asks how big the value is; its own status is
    // meaningless here (a too-small buffer is *expected* to fail) — the type
    // and size it fills in are what matter, checked below.
    let _ = unsafe {
        RegQueryValueExW(key.0, PCWSTR(name.as_ptr()), None, Some(&mut kind), None, Some(&mut size))
    };
    if kind != REG_SZ || size == 0 {
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            None,
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    // The buffer is UTF-16LE bytes, size-prefixed and NUL-terminated by the
    // registry API itself — reinterpret pairs of bytes and drop trailing NULs.
    let units: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    Some(text.trim_end_matches('\0').to_string())
}

fn read_dword(key: &RegKey, value: &str) -> Option<u32> {
    let name = wide(value);
    let mut kind = REG_VALUE_TYPE(0);
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS && kind == REG_DWORD).then_some(data)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsCompatibility {
    /// "Windows 11 Pro", as Windows itself names it.
    pub product_name: String,
    /// "23H2", absent on builds old enough not to have one.
    pub display_version: Option<String>,
    /// The build number as a string, e.g. "22631" — kept as text because
    /// that's the form Windows itself stores it in and compares it as.
    pub build: String,
    /// The update-revision suffix — "22631.**3737**" — absent if unreadable.
    pub ubr: Option<u32>,
    /// The same build number as a plain integer, for whichever caller wants
    /// to compare it rather than just display it.
    pub build_number: u32,
}

#[tauri::command]
pub fn windows_compatibility() -> WindowsCompatibility {
    let Some(key) = open_current_version() else {
        return WindowsCompatibility {
            product_name: "Windows".into(),
            display_version: None,
            build: "unknown".into(),
            ubr: None,
            build_number: 0,
        };
    };

    let build = read_string(&key, "CurrentBuildNumber").unwrap_or_else(|| "unknown".into());
    WindowsCompatibility {
        product_name: read_string(&key, "ProductName").unwrap_or_else(|| "Windows".into()),
        display_version: read_string(&key, "DisplayVersion").or_else(|| read_string(&key, "ReleaseId")),
        build_number: build.parse().unwrap_or(0),
        build,
        ubr: read_dword(&key, "UBR"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live, ignored by default — see `services.rs` for why this pattern is
    /// used throughout this crate for anything that needs a real desktop.
    #[test]
    #[ignore]
    fn reads_a_real_windows_version() {
        let info = windows_compatibility();
        assert!(info.product_name.to_lowercase().contains("windows"), "{}", info.product_name);
        assert!(info.build_number > 10000, "implausible build number: {}", info.build_number);
        assert_ne!(info.build, "unknown");
    }
}
