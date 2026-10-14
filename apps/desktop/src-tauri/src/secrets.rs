//! API keys, kept out of `storage.json` entirely.
//!
//! ## Why this file exists
//!
//! `storage.rs` is one plaintext JSON document — the right amount of
//! machinery for a theme preference, and exactly the wrong place for a cloud
//! provider's API key. This uses **Windows Credential Manager**
//! (`CredWriteW`/`CredReadW`/`CredDeleteW`, bound directly against the
//! `windows` crate the same way every other native surface in this codebase
//! is — `uia.rs`'s COM calls, `services.rs`'s `ShellExecuteEx`, no wrapper
//! crate) instead: the value is encrypted at rest by Windows itself (DPAPI,
//! under the hood), tied to this Windows account, and visible/removable
//! through Windows' own Credential Manager control panel — not a bespoke
//! format only Atlas can read.
//!
//! ## The one rule that makes this safe: the value never comes back to JS
//!
//! `save_secret` takes a key once, at the moment the user types it in, and
//! never returns it. `read_secret` exists for exactly one caller —
//! `cloud_intelligence.rs`, which uses the value to build an outbound
//! request and never hands it back across the IPC boundary. Every other
//! caller (the Settings UI, "is a key saved?") uses `has_secret`, which
//! confirms presence without ever touching the value. There is deliberately
//! no command that returns a stored secret to the renderer — the least
//! trusted part of the app (see `platform.rs`'s own framing) has no business
//! holding one even transiently.
//!
//! ## Target naming
//!
//! `Atlas:cloudProvider:<providerId>` — namespaced so Atlas's entries are
//! identifiable (and removable as a group, by prefix) in Windows' own
//! Credential Manager UI without colliding with anything else on the
//! machine.

use windows::core::{Error as WinError, PCWSTR};
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

const TARGET_PREFIX: &str = "Atlas:cloudProvider:";

fn target_for(provider_id: &str) -> String {
    format!("{TARGET_PREFIX}{provider_id}")
}

/// A provider id is embedded in a Credential Manager target name — reject
/// anything that isn't a short, plain identifier before it ever reaches
/// there, the same "a value from the renderer is a claim, not a fact" rule
/// `storage.rs`'s `is_valid_key` applies to its own keys.
fn is_valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Saving a key is a credential change: the person is asked natively first (`consent.rs`), with
/// the address the key is bound to, never the id the renderer chose.
#[tauri::command]
pub async fn save_secret(provider_id: String, secret: String) -> Result<(), String> {
    if !is_valid_provider_id(&provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    if secret.is_empty() {
        return Err("That key is empty.".into());
    }
    crate::consent::ask(crate::consent::Request::SaveKey {
        what: crate::consent::describe_key(&provider_id),
    })
    .await?;
    save_secret_now(provider_id, secret)
}

/// The write itself. Callers have already obtained consent.
pub(crate) fn save_secret_now(provider_id: String, secret: String) -> Result<(), String> {
    if !is_valid_provider_id(&provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    if secret.is_empty() {
        return Err("That key is empty.".into());
    }
    write_target(&target_for(&provider_id), secret)
}

/// Credential Manager write for any target name. Windows caps a blob at 2560 bytes.
fn write_target(target: &str, secret: String) -> Result<(), String> {
    let target_wide = to_wide_null(target);
    let mut blob = secret.into_bytes();

    let mut credential = CREDENTIALW {
        Flags: Default::default(),
        Type: CRED_TYPE_GENERIC,
        TargetName: windows::core::PWSTR(target_wide.as_ptr() as *mut u16),
        Comment: windows::core::PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: windows::core::PWSTR::null(),
        UserName: windows::core::PWSTR::null(),
    };

    let result = unsafe { CredWriteW(&credential, 0) };
    // The blob held the plaintext key for exactly as long as the call above
    // needed it — zeroed immediately after, win or lose, rather than left for
    // the allocator to reuse whenever it likes.
    blob.iter_mut().for_each(|b| *b = 0);
    let _ = &mut credential; // silence "unused mut" if the compiler ever disagrees

    result.map_err(|e: WinError| format!("Couldn't save that key: {e}"))
}

/// Read a stored key back. **The only legitimate callers are
/// `cloud_intelligence.rs` and `web.rs`** (the Tavily search key), each to
/// build one outbound request — see the module doc. Never exposed as a `#[tauri::command]`, so no path from the renderer
/// can call it at all.
pub fn read_secret(provider_id: &str) -> Result<Option<String>, String> {
    if !is_valid_provider_id(provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    read_target(&target_for(provider_id))
}

fn read_target(target: &str) -> Result<Option<String>, String> {
    let target_wide = to_wide_null(target);

    unsafe {
        let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
        let target = PCWSTR(target_wide.as_ptr());
        match CredReadW(target, CRED_TYPE_GENERIC, 0, &mut ptr) {
            Ok(()) => {
                let cred = &*ptr;
                let bytes = std::slice::from_raw_parts(
                    cred.CredentialBlob,
                    cred.CredentialBlobSize as usize,
                );
                let value = String::from_utf8(bytes.to_vec())
                    .map_err(|_| "Stored key wasn't valid text.".to_string());
                CredFree(ptr as *const _);
                value.map(Some)
            }
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
            Err(e) => Err(format!("Couldn't read that key: {e}")),
        }
    }
}

#[tauri::command]
pub fn has_secret(provider_id: String) -> Result<bool, String> {
    Ok(read_secret(&provider_id)?.is_some())
}

#[tauri::command]
pub async fn delete_secret(provider_id: String) -> Result<(), String> {
    if !is_valid_provider_id(&provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    // Nothing to ask about when no key is saved.
    if read_secret(&provider_id)?.is_none() {
        return Ok(());
    }
    crate::consent::ask(crate::consent::Request::DeleteKey {
        what: crate::consent::describe_key(&provider_id),
    })
    .await?;
    delete_target(&target_for(&provider_id))
}

fn delete_target(target: &str) -> Result<(), String> {
    let target_wide = to_wide_null(target);
    unsafe {
        match CredDeleteW(PCWSTR(target_wide.as_ptr()), CRED_TYPE_GENERIC, 0) {
            Ok(()) => Ok(()),
            // Deleting something already gone is not a failure — the caller
            // wanted it gone, and it is.
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
            Err(e) => Err(format!("Couldn't remove that key: {e}")),
        }
    }
}

// ---- the Nova account session ---------------------------------------------------------------
//
// The sign-in session used to sit in `storage.json` as plain text. It is a credential, so it lives
// here with the keys: DPAPI-protected, tied to this Windows account, visible in Credential
// Manager, and not in a file that a backup, a sync tool or a support attachment would carry.
// The renderer's account client still needs the value (it talks to Nova itself), so these three
// commands hand it back; what changes is where it rests.

const SESSION_TARGET: &str = "Atlas:account:session";
const MAX_SESSION_CHARS: usize = 2000;

/// The key the session used to sit under in `storage.json`.
const LEGACY_SESSION_KEY: &str = "atlas.nova.account";

/// At startup: a session left in `storage.json` by an earlier version moves into Credential
/// Manager and is removed from the file. A copy still in the file is the newer one (this version
/// never writes it there), so it wins over what is already held.
pub(crate) fn adopt_legacy_session(app: &tauri::AppHandle) {
    let Some(serde_json::Value::String(session)) = crate::storage::get_trusted(app, LEGACY_SESSION_KEY) else {
        return;
    };
    if session.is_empty() || session.chars().count() > MAX_SESSION_CHARS {
        return;
    }
    // Removed from the file only once it is safely in Credential Manager.
    if write_target(SESSION_TARGET, session).is_ok() {
        let _ = crate::storage::remove_trusted(app, LEGACY_SESSION_KEY);
    }
}

#[tauri::command]
pub fn account_session_get() -> Result<Option<String>, String> {
    read_target(SESSION_TARGET)
}

#[tauri::command]
pub fn account_session_set(value: String) -> Result<(), String> {
    if value.is_empty() || value.chars().count() > MAX_SESSION_CHARS {
        return Err("That isn't a usable sign-in session.".into());
    }
    write_target(SESSION_TARGET, value)
}

#[tauri::command]
pub fn account_session_clear() -> Result<(), String> {
    delete_target(SESSION_TARGET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_provider_ids_are_valid() {
        assert!(is_valid_provider_id("openai-1"));
        assert!(is_valid_provider_id("custom_2"));
    }

    #[test]
    fn a_provider_id_that_could_escape_the_target_namespace_is_refused() {
        for bad in ["", "has space", "colon:here", "a".repeat(65).as_str(), "../etc"] {
            assert!(!is_valid_provider_id(bad), "should reject: {bad}");
        }
    }

    #[test]
    fn the_target_name_is_namespaced() {
        assert_eq!(target_for("openai-1"), "Atlas:cloudProvider:openai-1");
    }

    // The round-trip (save/read/delete against the real Credential Manager)
    // is exercised manually, not in this suite: it would write to this
    // machine's actual credential store every test run, which is exactly the
    // side effect a unit test must not have. `is_valid_provider_id` and
    // `target_for` are the parts with real logic in them; the Win32 calls
    // themselves are thin, direct, and the same pattern already proven by
    // every other native call in this crate.
}
