//! Where a stored cloud-provider key may be sent.
//!
//! A saved API key is only as safe as the address it is attached to. Before this module the
//! renderer passed `kind` and `base_url` with every request, so anything that could call
//! `ask_cloud_provider` could point a saved key at any https host. Now the destination is held
//! here, natively, **per provider id**, and the request commands take only the id:
//!
//! * `provider_bind(id, kind, base_url)` records an approved destination (validated the same way
//!   a request is: https, or plain http to this machine only; link-local and metadata addresses
//!   never). In the authorization stage this is the call that asks the person first.
//! * `ask_cloud_provider(id, model, prompt)` and `test_cloud_provider(id, model)` resolve the
//!   destination from the binding. An id with no binding is refused; so is an id that has a key
//!   saved for something else (the search provider's key can never be sent to a model endpoint).
//! * Requests never follow redirects (see `cloud_intelligence.rs`), so a destination cannot hand
//!   the key on to another host.
//!
//! The bindings live in `atlas.provider-bindings`, which is a trust-bearing key: it is read once
//! at startup and held in memory. Providers configured before this existed are adopted **once**,
//! at startup, from the saved provider list — and only when a key is already saved for that id —
//! so nobody has to re-enter anything. That adoption is a trust-on-first-use step and is
//! documented as such: a renderer that tampered with the saved list *before* the first run of
//! this version could have chosen the address that gets adopted.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::cloud_intelligence::{resolve_base_url, CloudProviderKind};

pub(crate) const STORAGE_KEY: &str = "atlas.provider-bindings";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub kind: CloudProviderKind,
    /// Resolved and normalised, exactly what a request will use.
    pub base_url: String,
}

/// What the Settings page may see: where the key goes, never the key.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BindingView {
    pub kind: CloudProviderKind,
    pub base_url: String,
    pub host: String,
}

fn view(b: &Binding) -> BindingView {
    BindingView { kind: b.kind, base_url: b.base_url.clone(), host: host_of(&b.base_url) }
}

fn host_of(base: &str) -> String {
    reqwest::Url::parse(base)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
        })
        .unwrap_or_default()
}

fn table() -> &'static RwLock<BTreeMap<String, Binding>> {
    static T: OnceLock<RwLock<BTreeMap<String, Binding>>> = OnceLock::new();
    T.get_or_init(|| RwLock::new(BTreeMap::new()))
}

pub(crate) fn get(provider_id: &str) -> Option<Binding> {
    table().read().ok()?.get(provider_id).cloned()
}

/// A provider id is a short plain identifier (it is also a Credential Manager target name).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Ids that name something other than a model provider. A key saved under one of these is for a
/// fixed service with its own fixed address, and must never be attachable to a model endpoint.
fn reserved(id: &str) -> bool {
    id.starts_with("search-")
}

/// Refuses destinations that are never a model provider and are the classic way to turn a
/// server-side request into an attack on the local network or the machine's own metadata.
fn check_destination(base: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base).map_err(|_| "That doesn't look like a URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address can't carry a user name or password.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The address can't carry a query or fragment.".into());
    }
    let host = url.host_str().ok_or("That address has no host.")?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        let bad = match ip {
            IpAddr::V4(v4) => v4.is_unspecified() || v4.is_link_local() || v4.is_multicast() || v4.is_broadcast(),
            IpAddr::V6(v6) => {
                v6.is_unspecified()
                    || v6.is_multicast()
                    // fe80::/10, link-local
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
        if bad {
            return Err("That address isn't somewhere a model provider lives.".into());
        }
    }
    Ok(())
}

/// Validate and normalise; the single place a destination is judged.
pub(crate) fn validate(kind: CloudProviderKind, base_url: &str) -> Result<String, String> {
    let resolved = resolve_base_url(kind, base_url)?;
    check_destination(&resolved)?;
    Ok(resolved)
}

fn persist(app: &AppHandle) -> Result<(), String> {
    let snapshot = table().read().map_err(|_| "Couldn't read the provider bindings.".to_string())?.clone();
    crate::storage::storage_set(
        app.clone(),
        app.state::<crate::storage::StorageState>(),
        STORAGE_KEY.to_string(),
        serde_json::to_value(snapshot).map_err(|e| e.to_string())?,
    )
}

/// Called once from `setup()`, before any command can run.
///
/// `saved` is the stored bindings; `legacy_facts` is the stored `atlas.preferences` array, read
/// only to adopt providers that already have a key saved (`has_key` tells which). Returns how
/// many providers were adopted.
pub(crate) fn init(
    saved: Option<serde_json::Value>,
    legacy_facts: Option<serde_json::Value>,
    has_key: impl Fn(&str) -> bool,
) -> (usize, bool) {
    let mut map: BTreeMap<String, Binding> = BTreeMap::new();
    if let Some(v) = saved {
        if let Ok(parsed) = serde_json::from_value::<BTreeMap<String, Binding>>(v) {
            for (id, b) in parsed {
                // Stored values are re-validated: a hand-edited file does not get a pass.
                if valid_id(&id) && !reserved(&id) {
                    if let Ok(base) = validate(b.kind, &b.base_url) {
                        map.insert(id, Binding { kind: b.kind, base_url: base });
                    }
                }
            }
        }
    }
    let had_any = !map.is_empty();
    let mut adopted = 0;
    if !had_any {
        for (id, kind, base_url) in legacy_providers(legacy_facts.as_ref()) {
            if !valid_id(&id) || reserved(&id) || map.contains_key(&id) || !has_key(&id) {
                continue;
            }
            if let Ok(base) = validate(kind, &base_url) {
                map.insert(id, Binding { kind, base_url: base });
                adopted += 1;
            }
        }
    }
    if let Ok(mut guard) = table().write() {
        *guard = map;
    }
    (adopted, had_any)
}

/// `(id, kind, baseUrl)` for each entry of the provider list inside the saved preference facts.
fn legacy_providers(facts: Option<&serde_json::Value>) -> Vec<(String, CloudProviderKind, String)> {
    let mut out = Vec::new();
    let Some(arr) = facts.and_then(|f| f.as_array()) else { return out };
    let list = arr.iter().find(|f| {
        f.get("kind").and_then(|k| k.as_str()) == Some("preference")
            && f.get("subject").and_then(|s| s.as_str()) == Some("cloudProviders.list")
    });
    let Some(raw) = list.and_then(|f| f.get("value")).and_then(|v| v.as_str()) else { return out };
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else { return out };
    for e in entries {
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let kind = e
            .get("kind")
            .and_then(|v| serde_json::from_value::<CloudProviderKind>(v.clone()).ok());
        let base = e.get("baseUrl").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if let Some(kind) = kind {
            out.push((id, kind, base));
        }
    }
    out
}

/// Persist what `init` adopted. Separate so `lib.rs` can call it once it has a handle.
pub(crate) fn persist_after_init(app: &AppHandle) {
    let _ = persist(app);
}

#[tauri::command]
pub fn provider_binding(provider_id: String) -> Option<BindingView> {
    get(&provider_id).as_ref().map(view)
}

/// Record where this provider's key may be sent. Replaces any earlier binding for the id.
#[tauri::command]
pub fn provider_bind(
    app: AppHandle,
    provider_id: String,
    kind: CloudProviderKind,
    base_url: String,
) -> Result<BindingView, String> {
    if !valid_id(&provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    if reserved(&provider_id) {
        return Err("That id is for a built-in service, not a model provider.".into());
    }
    let resolved = validate(kind, &base_url)?;
    let binding = Binding { kind, base_url: resolved };
    let out = view(&binding);
    {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider bindings.".to_string())?;
        guard.insert(provider_id, binding);
    }
    persist(&app)?;
    Ok(out)
}

/// Forget a provider's destination (called when the provider is removed).
#[tauri::command]
pub fn provider_unbind(app: AppHandle, provider_id: String) -> Result<(), String> {
    {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider bindings.".to_string())?;
        guard.remove(&provider_id);
    }
    persist(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is process-wide; tests that touch it take turns.
    fn turn() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(map: BTreeMap<String, Binding>) {
        *table().write().unwrap() = map;
    }

    #[test]
    fn a_destination_must_be_https_or_this_machine() {
        let k = CloudProviderKind::OpenaiCompatible;
        assert!(validate(k, "https://api.example.com").is_ok());
        assert!(validate(k, "http://127.0.0.1:4000/v1").is_ok());
        assert!(validate(k, "http://api.example.com").is_err());
        assert!(validate(k, "ftp://api.example.com").is_err());
    }

    #[test]
    fn link_local_and_metadata_addresses_are_never_a_provider() {
        let k = CloudProviderKind::OpenaiCompatible;
        assert!(validate(k, "https://169.254.169.254").is_err(), "cloud metadata");
        assert!(validate(k, "https://[fe80::1]").is_err());
        assert!(validate(k, "https://0.0.0.0").is_err());
        assert!(validate(k, "https://api.example.com@evil.example").is_err(), "userinfo hides the real host");
        assert!(validate(k, "https://user:pw@api.example.com").is_err(), "no embedded credentials");
        assert!(validate(k, "https://api.example.com/?x=1").is_err(), "no query");
    }

    #[test]
    fn the_host_shown_is_the_host_used() {
        assert_eq!(host_of("https://api.moonshot.ai"), "api.moonshot.ai");
        assert_eq!(host_of("http://127.0.0.1:4000"), "127.0.0.1:4000");
    }

    #[test]
    fn an_unbound_id_has_no_destination() {
        let _t = turn();
        set(BTreeMap::new());
        assert!(get("cloud-1").is_none());
    }

    #[test]
    fn search_ids_can_never_be_bound_or_adopted() {
        let _t = turn();
        assert!(reserved("search-tavily"));
        let facts = serde_json::json!([{
            "kind": "preference", "subject": "cloudProviders.list",
            "value": serde_json::to_string(&serde_json::json!([
                {"id": "search-tavily", "kind": "openai-compatible", "baseUrl": "https://evil.example"}
            ])).unwrap()
        }]);
        let (adopted, _) = init(None, Some(facts), |_| true);
        assert_eq!(adopted, 0);
        assert!(get("search-tavily").is_none());
    }

    #[test]
    fn existing_providers_with_a_saved_key_are_adopted_once_and_others_are_not() {
        let _t = turn();
        let list = serde_json::to_string(&serde_json::json!([
            {"id": "cloud-a", "kind": "openai-compatible", "baseUrl": "https://api.moonshot.ai/v1/"},
            {"id": "cloud-b", "kind": "anthropic", "baseUrl": ""},
            {"id": "cloud-c", "kind": "openai-compatible", "baseUrl": "http://evil.example"}
        ]))
        .unwrap();
        let facts = serde_json::json!([{ "kind": "preference", "subject": "cloudProviders.list", "value": list }]);
        let (adopted, had) = init(None, Some(facts.clone()), |id| id != "cloud-b");
        assert!(!had);
        assert_eq!(adopted, 1, "only the one with a key and a valid address");
        assert_eq!(get("cloud-a").unwrap().base_url, "https://api.moonshot.ai");
        assert!(get("cloud-b").is_none(), "no key saved, so nothing to protect or adopt");
        assert!(get("cloud-c").is_none(), "an http address to another machine is refused");

        // Once bindings exist the saved list is never consulted again: a later edit to the list
        // cannot move an approved destination.
        let saved = serde_json::to_value(table().read().unwrap().clone()).unwrap();
        let tampered = serde_json::json!([{
            "kind": "preference", "subject": "cloudProviders.list",
            "value": serde_json::to_string(&serde_json::json!([
                {"id": "cloud-a", "kind": "openai-compatible", "baseUrl": "https://evil.example"}
            ])).unwrap()
        }]);
        let (adopted, had) = init(Some(saved), Some(tampered), |_| true);
        assert!(had);
        assert_eq!(adopted, 0);
        assert_eq!(get("cloud-a").unwrap().base_url, "https://api.moonshot.ai");
    }

    #[test]
    fn a_stored_binding_with_a_bad_address_is_dropped_on_load() {
        let _t = turn();
        let saved = serde_json::json!({
            "cloud-x": { "kind": "openai-compatible", "baseUrl": "http://evil.example" },
            "cloud-y": { "kind": "openai-compatible", "baseUrl": "https://api.example.com" }
        });
        let _ = init(Some(saved), None, |_| false);
        assert!(get("cloud-x").is_none());
        assert!(get("cloud-y").is_some());
    }

    #[test]
    fn a_request_for_an_unbound_provider_is_refused_before_anything_is_sent() {
        let _t = turn();
        set(BTreeMap::new());
        let err = tauri::async_runtime::block_on(crate::cloud_intelligence::ask_cloud_provider(
            "cloud-unbound".to_string(),
            "m".to_string(),
            "hello".to_string(),
        ))
        .unwrap_err();
        assert!(err.contains("hasn't been confirmed"), "{err}");
        // And the built-in search key can never be borrowed as a model-provider key.
        let err = tauri::async_runtime::block_on(crate::cloud_intelligence::test_cloud_provider(
            "search-tavily".to_string(),
            "m".to_string(),
        ))
        .unwrap_err();
        assert!(err.contains("hasn't been confirmed"), "{err}");
    }
}
