//! What Windows itself says about a process: which program it is, whether it is
//! elevated, and at what integrity level.
//!
//! These are the signals the input guard (`input_guard.rs`) and the elevation
//! ledger (`elevation.rs`) rest on, and they are deliberately the ones a window
//! cannot lie about. A window's *title* is whatever the program that owns it
//! wants to show; the image path of the process that owns it, and the token that
//! process runs under, are facts the operating system keeps.
//!
//! Everything here answers `None` rather than guessing when Windows will not
//! say. Callers treat `None` as "cannot tell", and what they do with that is
//! decided at the call site — the input guard fails closed.

#![cfg(windows)]

use std::path::PathBuf;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenElevation,
    TokenIntegrityLevel, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Integrity levels, as the RID Windows puts at the end of the label SID.
pub const INTEGRITY_MEDIUM: u32 = 0x2000;
pub const INTEGRITY_HIGH: u32 = 0x3000;

#[derive(Debug, Clone, Default)]
pub struct ProcFacts {
    #[allow(dead_code)]
    pub pid: u32,
    /// Full path of the executable, as Windows reports it.
    pub image: Option<PathBuf>,
    /// The token's `TokenIsElevated`.
    pub elevated: Option<bool>,
    /// The integrity RID (`INTEGRITY_MEDIUM`, `INTEGRITY_HIGH`, …).
    pub integrity: Option<u32>,
}

impl ProcFacts {
    /// Lowercased file name, e.g. `consent.exe`.
    pub fn image_name(&self) -> Option<String> {
        self.image
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_ascii_lowercase())
    }
}

struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn token_facts(token: HANDLE) -> (Option<bool>, Option<u32>) {
    let elevated = unsafe {
        let mut info = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut info as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .ok()
        .map(|_| info.TokenIsElevated != 0)
    };

    let integrity = unsafe {
        let mut needed = 0u32;
        // First call only asks how big the label is.
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
        if needed == 0 {
            None
        } else {
            let mut buf = vec![0u8; needed as usize];
            let ok = GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buf.as_mut_ptr() as *mut _),
                needed,
                &mut needed,
            )
            .is_ok();
            if !ok {
                None
            } else {
                let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
                let sid = label.Label.Sid;
                let count = *GetSidSubAuthorityCount(sid);
                if count == 0 {
                    None
                } else {
                    Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
                }
            }
        }
    };
    (elevated, integrity)
}

/// Facts about this process — what Atlas itself is running as.
pub fn self_facts() -> ProcFacts {
    unsafe {
        let mut token = HANDLE::default();
        let mut facts = ProcFacts { pid: std::process::id(), ..Default::default() };
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_ok() {
            let token = Owned(token);
            let (elevated, integrity) = token_facts(token.0);
            facts.elevated = elevated;
            facts.integrity = integrity;
        }
        facts.image = std::env::current_exe().ok();
        facts
    }
}

/// Facts about another process. Whatever Windows will not reveal stays `None`.
pub fn facts_for_pid(pid: u32) -> ProcFacts {
    let mut facts = ProcFacts { pid, ..Default::default() };
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return facts;
        };
        let process = Owned(process);

        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        if QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok()
        {
            facts.image = Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
        }

        let mut token = HANDLE::default();
        if OpenProcessToken(process.0, TOKEN_QUERY, &mut token).is_ok() {
            let token = Owned(token);
            let (elevated, integrity) = token_facts(token.0);
            facts.elevated = elevated;
            facts.integrity = integrity;
        }
    }
    facts
}

/// Is Atlas itself running elevated? It is not meant to be; this is how the
/// elevation flow knows an ordinary call would already have succeeded.
pub fn atlas_is_elevated() -> bool {
    self_facts().elevated.unwrap_or(false)
}
