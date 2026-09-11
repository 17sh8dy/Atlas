//! Environment variables — what a new process inherits, and how to change it.
//!
//! ## Two persisted scopes, and one that is deliberately never touched
//!
//! Windows keeps environment variables in two registry locations that a new
//! process's environment block is built from: `HKCU\Environment` (the current
//! user's own) and `HKLM\SYSTEM\CurrentControlSet\Control\Session
//! Manager\Environment` (the machine's, shared by everyone who logs into it).
//! This module reads both and writes either one directly — it never touches
//! *this process's own* live environment (`GetEnvironmentVariable` /
//! `SetEnvironmentVariable`), because a value set there would die with Atlas
//! and a value read from there is an already-merged view with no way to tell
//! which scope contributed it. `setx.exe` and System Properties → Environment
//! Variables both work against these same two keys, for the same reason.
//!
//! **A process that is already running keeps the environment it started
//! with** — every open terminal and every open application included.
//! Broadcasting `WM_SETTINGCHANGE` (below) is the documented way to tell
//! *new* top-level windows and a few well-behaved shells (Explorer among
//! them) to notice; it cannot reach back into a process already holding its
//! own copy, and this module makes no claim that it does.
//!
//! ## Administrator rights, the same way `services.rs` earns them
//!
//! `HKCU\Environment` needs nothing — it is the signed-in user's own key.
//! The system scope needs administrator rights, and the elevation is per
//! action, not for the whole app, for the reason `services.rs` gives at
//! length: every capability Atlas has, including this one, would otherwise
//! inherit those rights permanently. The ordinary call is tried first; only
//! once Windows has refused does it go back through `ShellExecuteEx` with the
//! `runas` verb, naming a fixed program (`reg.exe`) with one of two verb
//! shapes and two validated values — never a registry write made *as* the
//! elevated process, because `ShellExecuteEx` starts a separate process with
//! no handle back to this one to hand a registry key to.

#![cfg(windows)]

use std::process::Command;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegEnumValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

const USER_ENV_SUBKEY: &str = "Environment";
const SYSTEM_ENV_SUBKEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

/// The program, and every verb it can be given, for the system scope. In full.
const REG_EXE: &str = "reg.exe";
const RUNAS: &str = "runas";

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

fn open(root: HKEY, subkey: &str, write: bool) -> Option<RegKey> {
    let sub = wide(subkey);
    let mut hkey = HKEY::default();
    let access = if write { KEY_SET_VALUE } else { KEY_READ };
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(sub.as_ptr()), 0, access, &mut hkey) };
    (status == ERROR_SUCCESS).then_some(RegKey(hkey))
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
    /// "user" or "system" — which of the two registry keys this came from.
    pub scope: String,
}

/// Every `REG_SZ`/`REG_EXPAND_SZ` value in one key, name and raw text as
/// stored — expansion (`%SystemRoot%` and friends) is left to whatever
/// eventually consumes the value, the same way `setx` and the Environment
/// Variables dialog both leave it.
fn enumerate(key: &RegKey, scope: &str) -> Vec<EnvVar> {
    let mut out = Vec::new();
    let mut index = 0u32;

    loop {
        // Sized generously and re-passed every iteration: `RegEnumValueW`
        // overwrites the length in-place with however much it actually used,
        // so the capacity has to be reset before each call rather than reused
        // as if it still said its original size.
        let mut name_buf = vec![0u16; 16_384];
        let mut name_len = name_buf.len() as u32;
        let mut kind_raw: u32 = 0;
        let mut data_buf = vec![0u8; 65_536];
        let mut data_len = data_buf.len() as u32;

        let status = unsafe {
            RegEnumValueW(
                key.0,
                index,
                windows::core::PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut kind_raw),
                Some(data_buf.as_mut_ptr()),
                Some(&mut data_len),
            )
        };
        let kind = REG_VALUE_TYPE(kind_raw);

        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        if status != ERROR_SUCCESS {
            // A single unreadable value (there are a handful of undocumented
            // ones on some machines) must not take the whole listing down —
            // skip it and keep going.
            index += 1;
            continue;
        }

        if kind == REG_SZ || kind.0 == 2 {
            // 2 is REG_EXPAND_SZ, which `windows`' constant list names
            // separately from `REG_SZ` but which every environment variable
            // that references another one (`%JAVA_HOME%\bin`) is stored as.
            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            let units: Vec<u16> = data_buf[..data_len as usize]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect();
            let value = String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string();
            if !name.is_empty() {
                out.push(EnvVar { name, value, scope: scope.to_string() });
            }
        }

        index += 1;
    }

    out
}

#[tauri::command]
pub async fn list_environment_variables() -> Result<Vec<EnvVar>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut out = Vec::new();
        if let Some(key) = open(HKEY_CURRENT_USER, USER_ENV_SUBKEY, false) {
            out.extend(enumerate(&key, "user"));
        }
        if let Some(key) = open(HKEY_LOCAL_MACHINE, SYSTEM_ENV_SUBKEY, false) {
            out.extend(enumerate(&key, "system"));
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.scope.cmp(&b.scope)));
        out
    })
    .await
    .map_err(|e| format!("The environment task failed: {e}"))
}

/// Could this be a variable name at all?
///
/// The cheap gate, applied before anything reaches the registry or a process.
/// Windows variable names are conventionally uppercase words but genuinely
/// include parentheses (`ProgramFiles(x86)` is real, on every 64-bit
/// machine), so the allowed set is wider than `services.rs`'s service names —
/// what it still excludes is quotes and control characters, which is what
/// would let a value break out of the quoted argument `reg.exe` receives.
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with(' ')
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '(' | ')' | ' ' | '%')
        })
}

/// A value is almost anything — paths, lists, `%OTHER_VAR%` references — so
/// this only excludes what would actually break the elevated command line: a
/// quote (which would end the quoted argument early) or a control character.
fn is_valid_value(value: &str) -> bool {
    value.len() <= 32_768 && value.chars().all(|c| c != '"' && (c == '\t' || !c.is_control()))
}

fn broadcast_settings_change() {
    // Documented best-effort notification, not a guarantee anything is
    // listening: bounded to 5 seconds so a hung top-level window can never
    // make this call — or the command it's part of — hang with it.
    let env = wide("Environment");
    unsafe {
        let mut result = 0usize;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(env.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            5000,
            Some(&mut result),
        );
    }
}

#[tauri::command]
pub async fn set_environment_variable(
    name: String,
    value: String,
    scope: String,
) -> Result<bool, String> {
    if !is_valid_name(&name) {
        return Err(format!("\u{201c}{name}\u{201d} isn't a valid variable name."));
    }
    if !is_valid_value(&value) {
        return Err("That value can't be stored — it contains a quote or a control character.".into());
    }

    tauri::async_runtime::spawn_blocking(move || match scope.as_str() {
        "user" => set_user(&name, &value),
        "system" => set_system(&name, &value),
        other => Err(format!("No environment scope called \u{201c}{other}\u{201d}.")),
    })
    .await
    .map_err(|e| format!("The environment task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_environment_variable(name: String, scope: String) -> Result<bool, String> {
    if !is_valid_name(&name) {
        return Err(format!("\u{201c}{name}\u{201d} isn't a valid variable name."));
    }

    tauri::async_runtime::spawn_blocking(move || match scope.as_str() {
        "user" => delete_user(&name),
        "system" => delete_system(&name),
        other => Err(format!("No environment scope called \u{201c}{other}\u{201d}.")),
    })
    .await
    .map_err(|e| format!("The environment task failed: {e}"))?
}

fn set_user(name: &str, value: &str) -> Result<bool, String> {
    let key = open(HKEY_CURRENT_USER, USER_ENV_SUBKEY, true)
        .ok_or_else(|| "Couldn't open your environment settings.".to_string())?;
    let name_w = wide(name);
    // REG_SZ data is the UTF-16LE bytes, NUL-terminated, as raw bytes.
    let value_w = wide(value);
    let bytes: Vec<u8> = value_w.iter().flat_map(|u| u.to_le_bytes()).collect();
    let status = unsafe { RegSetValueExW(key.0, PCWSTR(name_w.as_ptr()), 0, REG_SZ, Some(&bytes)) };
    if status != ERROR_SUCCESS {
        return Err(format!("Windows wouldn't set that (error {}).", status.0));
    }
    broadcast_settings_change();
    Ok(true)
}

fn delete_user(name: &str) -> Result<bool, String> {
    let key = open(HKEY_CURRENT_USER, USER_ENV_SUBKEY, true)
        .ok_or_else(|| "Couldn't open your environment settings.".to_string())?;
    let name_w = wide(name);
    let status = unsafe { RegDeleteValueW(key.0, PCWSTR(name_w.as_ptr())) };
    // "Not found" is not a failure here: asking to remove something already
    // gone should land the same as asking to remove something that is there.
    if status != ERROR_SUCCESS && status.0 != 2 {
        return Err(format!("Windows wouldn't remove that (error {}).", status.0));
    }
    broadcast_settings_change();
    Ok(true)
}

fn reg_key_path(scope_subkey: &str) -> String {
    format!("HKLM\\{scope_subkey}")
}

fn set_system(name: &str, value: &str) -> Result<bool, String> {
    let key_path = reg_key_path(SYSTEM_ENV_SUBKEY);
    let args = [
        "add".to_string(),
        key_path,
        "/v".to_string(),
        name.to_string(),
        "/t".to_string(),
        "REG_SZ".to_string(),
        "/d".to_string(),
        value.to_string(),
        "/f".to_string(),
    ];
    run_reg(&args, name, value, "add")
}

fn delete_system(name: &str) -> Result<bool, String> {
    let key_path = reg_key_path(SYSTEM_ENV_SUBKEY);
    let args = ["delete".to_string(), key_path, "/v".to_string(), name.to_string(), "/f".to_string()];
    run_reg(&args, name, "", "delete")
}

/// Run `reg.exe` with a fixed verb and validated values, trying the ordinary
/// call first and escalating only once Windows has actually refused — see the
/// module doc comment and `services.rs::send` for why this order matters.
fn run_reg(args: &[String], name: &str, value: &str, verb: &str) -> Result<bool, String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = Command::new(REG_EXE);
    cmd.args(&arg_refs);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().map_err(|e| format!("Couldn't run reg.exe: {e}"))?;
    if out.status.success() {
        broadcast_settings_change();
        return Ok(true);
    }

    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if text.to_ascii_uppercase().contains("ACCESS IS DENIED") {
        send_elevated(verb, name, value)?;
        broadcast_settings_change();
        return Ok(true);
    }
    Err(format!(
        "Windows refused: {}",
        text.trim().lines().next().unwrap_or("no reason given")
    ))
}

/// Run one `reg.exe` verb with administrator rights, the same
/// `ShellExecuteEx` + `runas` shape `services.rs::send_elevated` uses — see
/// that function's doc comment for why this is not a loophole in the no-`exec`
/// rule. Quoting by hand is safe here only because `is_valid_name` and
/// `is_valid_value` have already excluded every character that could end a
/// quoted argument early.
#[cfg(windows)]
fn send_elevated(verb: &str, name: &str, value: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR as ElevPCWSTR;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn w(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let key_path = reg_key_path(SYSTEM_ENV_SUBKEY);
    let params = if verb == "delete" {
        format!("delete \"{key_path}\" /v \"{name}\" /f")
    } else {
        format!("add \"{key_path}\" /v \"{name}\" /t REG_SZ /d \"{value}\" /f")
    };

    let params_w = w(&params);
    let file_w = w(REG_EXE);
    let action_w = w(RUNAS);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: ElevPCWSTR(action_w.as_ptr()),
        lpFile: ElevPCWSTR(file_w.as_ptr()),
        lpParameters: ElevPCWSTR(params_w.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        const CANCELLED: i32 = -2_147_023_673; // HRESULT for ERROR_CANCELLED.
        if e.code().0 == CANCELLED {
            "You dismissed the Windows prompt, so nothing changed.".to_string()
        } else {
            format!("Windows wouldn't run that with administrator rights: {e}")
        }
    })?;

    #[allow(clippy::undocumented_unsafe_blocks)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::WaitForSingleObject;

        if !info.hProcess.is_invalid() {
            let _ = WaitForSingleObject(info.hProcess, 30_000);
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn send_elevated(_verb: &str, _name: &str, _value: &str) -> Result<(), String> {
    Err("Changing a system environment variable needs administrator rights.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_are_valid() {
        assert!(is_valid_name("PATH"));
        assert!(is_valid_name("JAVA_HOME"));
        // A real value on every 64-bit Windows machine — parentheses are not
        // exotic here.
        assert!(is_valid_name("ProgramFiles(x86)"));
    }

    #[test]
    fn a_name_that_could_break_a_quoted_argument_is_refused() {
        assert!(!is_valid_name(""));
        assert!(!is_valid_name(" LEADING_SPACE"));
        assert!(!is_valid_name("HAS\"QUOTE"));
        assert!(!is_valid_name("HAS\nNEWLINE"));
    }

    #[test]
    fn a_value_with_a_quote_is_refused() {
        // A quote here would end the quoted argument early and let whatever
        // came after it be read as a second argument to reg.exe.
        assert!(!is_valid_value("C:\\some\"path"));
        assert!(is_valid_value("C:\\Program Files\\Java;%PATH%"));
        assert!(is_valid_value(""));
    }

    #[test]
    fn a_value_with_a_control_character_is_refused() {
        assert!(!is_valid_value("line one\nline two"));
        // A tab is a control character too, but a real PATH-like value can
        // reasonably contain one, so it is allowed rather than refused.
        assert!(is_valid_value("a\tb"));
    }

    /// Live, ignored by default — see `services.rs` for why this pattern runs
    /// throughout this crate for anything that touches the real machine.
    /// Round-trips a variable that exists nowhere else, in the user scope
    /// only, so it never needs administrator rights or leaves anything behind.
    #[test]
    #[ignore]
    fn round_trips_a_real_user_variable() {
        const NAME: &str = "ATLAS_TEST_ENV_VAR";
        set_user(NAME, "hello-from-atlas").expect("set");

        let key = open(HKEY_CURRENT_USER, USER_ENV_SUBKEY, false).expect("open for read");
        let found = enumerate(&key, "user").into_iter().find(|v| v.name == NAME);
        assert_eq!(found.map(|v| v.value), Some("hello-from-atlas".to_string()));

        delete_user(NAME).expect("delete");
        let key = open(HKEY_CURRENT_USER, USER_ENV_SUBKEY, false).expect("open for read");
        assert!(enumerate(&key, "user").into_iter().all(|v| v.name != NAME));
    }
}
