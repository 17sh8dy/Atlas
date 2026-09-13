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
//!
//! ## The one thing that registry key still gets wrong
//!
//! `ProductName` under that key reads "Windows 10 Pro" on every Windows 11
//! machine that has ever existed — Microsoft never updated the string when
//! 11 shipped, and still hasn't. `CurrentBuildNumber` is the only field this
//! key exposes that's actually trustworthy for telling the two apart: 22000
//! was Windows 11's first public build, so anything at or above it is 11
//! regardless of what `ProductName` claims. `corrected_product_name` below
//! is the fix every tool reading this key by hand has to apply by hand.

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

/** The first build number Windows 11 shipped as. Below this, `ProductName` is trustworthy. */
const WINDOWS_11_BUILD: u32 = 22000;

/// `ProductName`, corrected for the one thing it's known to lie about.
///
/// Only ever rewrites a leading "Windows 10" into "Windows 11" — an edition
/// suffix ("Pro", "Home", "Enterprise") passes through untouched, and any
/// `ProductName` that doesn't start with "Windows 10" (an actually-honest
/// build, or a future Windows this build has never seen) is returned as-is.
fn corrected_product_name(raw: &str, build_number: u32) -> String {
    if build_number >= WINDOWS_11_BUILD {
        if let Some(rest) = raw.strip_prefix("Windows 10") {
            return format!("Windows 11{rest}");
        }
    }
    raw.to_string()
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
    let build_number: u32 = build.parse().unwrap_or(0);
    let raw_product_name = read_string(&key, "ProductName").unwrap_or_else(|| "Windows".into());
    WindowsCompatibility {
        product_name: corrected_product_name(&raw_product_name, build_number),
        display_version: read_string(&key, "DisplayVersion").or_else(|| read_string(&key, "ReleaseId")),
        build_number,
        build,
        ubr: read_dword(&key, "UBR"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windows_11_build_is_relabelled() {
        assert_eq!(corrected_product_name("Windows 10 Pro", 22000), "Windows 11 Pro");
        assert_eq!(corrected_product_name("Windows 10 Home", 26200), "Windows 11 Home");
    }

    #[test]
    fn a_real_windows_10_build_is_left_alone() {
        assert_eq!(corrected_product_name("Windows 10 Pro", 19045), "Windows 10 Pro");
    }

    #[test]
    fn the_build_just_below_11_is_left_alone() {
        assert_eq!(corrected_product_name("Windows 10 Pro", 21999), "Windows 10 Pro");
    }

    #[test]
    fn a_name_that_never_said_windows_10_is_untouched() {
        // A hypothetical honest future ProductName, or an unreadable registry's "Windows" fallback.
        assert_eq!(corrected_product_name("Windows 12 Pro", 30000), "Windows 12 Pro");
        assert_eq!(corrected_product_name("Windows", 0), "Windows");
    }

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

    /// Live, ignored by default. On any machine actually running Windows 11
    /// (this one, going by the environment build number 26200), the real
    /// registry read must come back corrected — the bug this file exists to
    /// fix, caught against the real machine rather than only the pure
    /// function above.
    #[test]
    #[ignore]
    fn a_real_windows_11_machine_is_reported_as_windows_11() {
        let info = windows_compatibility();
        if info.build_number >= WINDOWS_11_BUILD {
            assert!(info.product_name.contains("Windows 11"), "{}", info.product_name);
        }
    }
}
