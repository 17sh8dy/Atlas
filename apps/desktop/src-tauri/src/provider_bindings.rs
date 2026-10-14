//! The cloud-provider list, held natively, and where each provider's key may be sent.
//!
//! A saved API key is only as safe as the address it is attached to, and a provider list that the
//! webview can rewrite is a way to change that address. So the list lives here, not in the
//! renderer's preferences:
//!
//! * `provider_add(id, kind, base_url, secret, label, model)` records a provider, its destination
//!   and its key behind **one** native question (`consent.rs`).
//! * `provider_bind(id, kind, base_url)` moves a provider's destination; that asks too, and asks
//!   nothing when the address is unchanged.
//! * `provider_update(id, label, model, enabled)` changes what cannot redirect a key: the name,
//!   the model, and whether the provider may be selected. Enabling or switching between providers
//!   the person already approved is deliberately not a question.
//! * `ask_cloud_provider(id, model, prompt)` and `test_cloud_provider(id, model)` resolve the
//!   destination from this table and from nowhere else. An id with no entry is refused; so is any
//!   `search-*` id (the web-search key is for a fixed service and can never go to a model
//!   endpoint). Requests never follow redirects (`cloud_intelligence.rs`).
//!
//! The table is persisted in `atlas.provider-bindings`, a trust key the generic store refuses
//! (`storage.rs`), read once at startup and held in memory.
//!
//! ## The one-time migration
//!
//! Before this existed the list was a fact (`cloudProviders.list`) inside `atlas.preferences`.
//! At the first start of this version it is read **once**, and:
//!
//! 1. `storage.json` is copied to `storage.json.pre-2.0-providers.bak` (only if that copy does
//!    not exist yet);
//! 2. every well-formed entry becomes a table entry (its address re-validated);
//! 3. the table and a marker (`atlas.migrations`) are written, and the store is read back: every
//!    *other* key must be exactly what it was, and the new keys must say what was intended;
//! 4. on any mismatch the backup is put back and nothing is adopted.
//!
//! The old fact is **never deleted or edited**, which is the rollback path: Atlas 1.0.x ignores
//! the new keys and keeps reading it. The cost of that is skew: a provider added by 2.0 is not
//! visible to 1.0.x, and one added by 1.0.x after migration is not adopted by 2.0 (adoption is a
//! single trust-on-first-use step, not a standing channel from the renderer's list into the
//! table). Both are documented in `docs/NATIVE-AUTHORIZATION-INVENTORY.md`.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::cloud_intelligence::{resolve_base_url, CloudProviderKind};

pub(crate) const STORAGE_KEY: &str = "atlas.provider-bindings";
pub(crate) const MIGRATIONS_KEY: &str = "atlas.migrations";
const MIGRATION_ID: &str = "providers-2.0";
const BACKUP_NAME: &str = "storage.json.pre-2.0-providers.bak";
const LEGACY_KEY: &str = "atlas.preferences";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub kind: CloudProviderKind,
    /// Resolved and normalised, exactly what a request will use.
    pub base_url: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Orders the list as the person added it.
    #[serde(default)]
    pub added_at: u64,
    /// Set when the provider said it is out of money: nothing is sent to it until the person
    /// resumes it (`cloud_safety.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<crate::cloud_safety::Paused>,
    /// Caps the person set, counted per calendar month against the Stats totals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_requests: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_tokens: Option<u64>,
}

fn yes() -> bool {
    true
}

impl Provider {
    /// Where a key goes, and nothing else: the part that is trust.
    fn destination(&self) -> (CloudProviderKind, &str) {
        (self.kind, &self.base_url)
    }
}

/// What the Settings page sees: never the key.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub kind: CloudProviderKind,
    pub label: String,
    pub model: String,
    pub base_url: String,
    pub host: String,
    pub enabled: bool,
    /// `provider-limit` when the provider said it is out of money, else `None`.
    pub paused: Option<String>,
    pub cap_requests: Option<u64>,
    pub cap_tokens: Option<u64>,
    /// This calendar month, from Stats: requests, and tokens (reported by the provider where it
    /// said, otherwise estimated).
    pub month_requests: u64,
    pub month_tokens: u64,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BindingView {
    pub kind: CloudProviderKind,
    pub base_url: String,
    pub host: String,
}

fn view_of(id: &str, p: &Provider) -> ProviderView {
    ProviderView {
        id: id.to_string(),
        kind: p.kind,
        label: p.label.clone(),
        model: p.model.clone(),
        base_url: p.base_url.clone(),
        host: host_of(&p.base_url),
        enabled: p.enabled,
        paused: p.paused.as_ref().map(|x| x.reason.clone()),
        cap_requests: p.cap_requests,
        cap_tokens: p.cap_tokens,
        month_requests: crate::stats::month_total(&format!("cloud:{id}:requests")),
        month_tokens: crate::stats::month_total(&format!("cloud:{id}:tokens_in"))
            + crate::stats::month_total(&format!("cloud:{id}:tokens_out")),
    }
}

fn binding_view(p: &Provider) -> BindingView {
    BindingView { kind: p.kind, base_url: p.base_url.clone(), host: host_of(&p.base_url) }
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

type Table = BTreeMap<String, Provider>;

fn table() -> &'static RwLock<Table> {
    static T: OnceLock<RwLock<Table>> = OnceLock::new();
    T.get_or_init(|| RwLock::new(BTreeMap::new()))
}

pub(crate) fn get(provider_id: &str) -> Option<Provider> {
    table().read().ok()?.get(provider_id).cloned()
}

/// A provider id is a short plain identifier (it is also a Credential Manager target name).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Ids that name something other than a model provider.
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
                v6.is_unspecified() || v6.is_multicast() || (v6.segments()[0] & 0xffc0) == 0xfe80
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn persist(app: &AppHandle) -> Result<(), String> {
    let snapshot = table().read().map_err(|_| "Couldn't read the provider list.".to_string())?.clone();
    crate::storage::set_trusted(
        app,
        STORAGE_KEY,
        serde_json::to_value(snapshot).map_err(|e| e.to_string())?,
    )
}

// ---- loading and the one-time migration ------------------------------------------------------

/// Re-validate a stored table: a hand-edited file does not get a pass.
fn load_table(value: Option<serde_json::Value>) -> Table {
    let mut out = Table::new();
    let Some(v) = value else { return out };
    let Ok(parsed) = serde_json::from_value::<Table>(v) else { return out };
    for (id, mut p) in parsed {
        if !valid_id(&id) || reserved(&id) {
            continue;
        }
        if let Ok(base) = validate(p.kind, &p.base_url) {
            p.base_url = base;
            out.insert(id, p);
        }
    }
    out
}

/// A legacy provider-list entry: what the old preference fact held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Legacy {
    pub id: String,
    pub kind: CloudProviderKind,
    pub base_url: String,
    pub label: String,
    pub model: String,
    pub enabled: bool,
}

/// The entries of the provider list inside the saved preference facts.
pub(crate) fn legacy_providers(facts: Option<&serde_json::Value>) -> Vec<Legacy> {
    let mut out = Vec::new();
    let Some(arr) = facts.and_then(|f| f.as_array()) else { return out };
    let list = arr.iter().find(|f| {
        f.get("kind").and_then(|k| k.as_str()) == Some("preference")
            && f.get("subject").and_then(|s| s.as_str()) == Some("cloudProviders.list")
    });
    let Some(raw) = list.and_then(|f| f.get("value")).and_then(|v| v.as_str()) else { return out };
    let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else { return out };
    for e in entries {
        let s = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(kind) = e.get("kind").and_then(|v| serde_json::from_value::<CloudProviderKind>(v.clone()).ok())
        else {
            continue;
        };
        out.push(Legacy {
            id: s("id"),
            kind,
            base_url: s("baseUrl"),
            label: s("label"),
            model: s("model"),
            enabled: e.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    out
}

/// What the table should look like after migrating: the current table, plus every legacy entry
/// that is well-formed and not already present (an existing entry only has its name and model
/// filled in, never its destination). Pure, so it can be tested without a store.
pub(crate) fn plan_migration(current: &Table, legacy: &[Legacy], start_at: u64) -> (Table, usize) {
    let mut next = current.clone();
    let mut adopted = 0;
    for (i, l) in legacy.iter().enumerate() {
        if !valid_id(&l.id) || reserved(&l.id) {
            continue;
        }
        if let Some(existing) = next.get_mut(&l.id) {
            if existing.label.is_empty() {
                existing.label = l.label.clone();
            }
            if existing.model.is_empty() {
                existing.model = l.model.clone();
            }
            continue;
        }
        let Ok(base) = validate(l.kind, &l.base_url) else { continue };
        next.insert(
            l.id.clone(),
            Provider {
                kind: l.kind,
                base_url: base,
                label: l.label.clone(),
                model: l.model.clone(),
                enabled: l.enabled,
                added_at: start_at + i as u64,
                paused: None,
                cap_requests: None,
                cap_tokens: None,
            },
        );
        adopted += 1;
    }
    (next, adopted)
}

/// Did the migration write exactly what it meant to, and touch nothing else?
pub(crate) fn verify_migration(
    before: &std::collections::HashMap<String, serde_json::Value>,
    after: &std::collections::HashMap<String, serde_json::Value>,
    intended: &Table,
) -> Result<(), String> {
    for (k, v) in before {
        if k == STORAGE_KEY || k == MIGRATIONS_KEY {
            continue;
        }
        if after.get(k) != Some(v) {
            return Err(format!("the key {k} changed"));
        }
    }
    for k in after.keys() {
        if k != STORAGE_KEY && k != MIGRATIONS_KEY && !before.contains_key(k) {
            return Err(format!("the key {k} appeared"));
        }
    }
    let written: Table = after
        .get(STORAGE_KEY)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or("the provider table was not written")?;
    if &written != intended {
        return Err("the provider table read back differently".into());
    }
    let marked = after.get(MIGRATIONS_KEY).and_then(|v| v.get(MIGRATION_ID)).is_some();
    if !marked {
        return Err("the migration marker was not written".into());
    }
    Ok(())
}

fn log(msg: String) {
    crate::diagnostics::log_diagnostic("provider_migration".to_string(), msg);
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Mark a provider paused because it said it is out of money, and remember that.
pub(crate) fn mark_paused(provider_id: &str) {
    let changed = {
        let Ok(mut guard) = table().write() else { return };
        match guard.get_mut(provider_id) {
            Some(p) if p.paused.is_none() => {
                p.paused = Some(crate::cloud_safety::Paused {
                    reason: "provider-limit".to_string(),
                    at: now_ms(),
                });
                true
            }
            _ => false,
        }
    };
    if changed {
        if let Some(app) = APP.get() {
            let _ = persist(app);
        }
    }
}

/// Called once from `setup()`, before any command can run.
pub(crate) fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let mut current = load_table(crate::storage::get_trusted(app, STORAGE_KEY));
    let migrated = crate::storage::get_trusted(app, MIGRATIONS_KEY)
        .and_then(|v| v.get(MIGRATION_ID).cloned())
        .is_some();

    if !migrated {
        match migrate(app, &current) {
            Ok(Some(next)) => current = next,
            Ok(None) => {}
            Err(why) => log(format!("not migrated, state left as it was: {why}")),
        }
    }
    if let Ok(mut guard) = table().write() {
        *guard = current;
    }
}

/// `Ok(Some(table))` when entries were adopted and verified, `Ok(None)` when there was nothing to
/// do, `Err` when it was abandoned (the store is back as it was).
fn migrate(app: &AppHandle, current: &Table) -> Result<Option<Table>, String> {
    let legacy = legacy_providers(crate::storage::get_trusted(app, LEGACY_KEY).as_ref());
    let (next, adopted) = plan_migration(current, &legacy, now_ms());
    let marker = serde_json::json!({ MIGRATION_ID: { "at": now_ms(), "adopted": adopted } });

    if legacy.is_empty() && next == *current {
        // Nothing to carry over: record that, so this never looks at the list again.
        crate::storage::set_trusted(app, MIGRATIONS_KEY, marker)?;
        return Ok(None);
    }

    crate::storage::backup_once(app, BACKUP_NAME)?;
    let before = crate::storage::snapshot(app)?;
    let write = || -> Result<(), String> {
        crate::storage::set_trusted(app, STORAGE_KEY, serde_json::to_value(&next).map_err(|e| e.to_string())?)?;
        crate::storage::set_trusted(app, MIGRATIONS_KEY, marker.clone())
    };
    let verified = write().and_then(|_| {
        let after = crate::storage::snapshot(app)?;
        verify_migration(&before, &after, &next)
    });
    match verified {
        Ok(()) => {
            log(format!("adopted {adopted} provider(s); backup kept as {BACKUP_NAME}"));
            Ok(Some(next))
        }
        Err(why) => {
            let restored = crate::storage::restore_backup(app, BACKUP_NAME);
            Err(format!("verification failed ({why}); backup restored: {}", restored.is_ok()))
        }
    }
}

// ---- commands ----------------------------------------------------------------------------

#[tauri::command]
pub fn provider_list() -> Vec<ProviderView> {
    let guard = match table().read() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let mut rows: Vec<(&String, &Provider)> = guard.iter().collect();
    rows.sort_by(|a, b| a.1.added_at.cmp(&b.1.added_at).then(a.0.cmp(b.0)));
    rows.into_iter().map(|(id, p)| view_of(id, p)).collect()
}

#[tauri::command]
pub fn provider_binding(provider_id: String) -> Option<BindingView> {
    get(&provider_id).as_ref().map(binding_view)
}

fn kind_label(kind: CloudProviderKind) -> &'static str {
    match kind {
        CloudProviderKind::OpenaiCompatible => "OpenAI-compatible",
        CloudProviderKind::Anthropic => "Anthropic",
        CloudProviderKind::Gemini => "Gemini",
    }
}

fn check_id(provider_id: &str) -> Result<(), String> {
    if !valid_id(provider_id) {
        return Err("That isn't a valid provider id.".into());
    }
    if reserved(provider_id) {
        return Err("That id is for a built-in service, not a model provider.".into());
    }
    Ok(())
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// Add a provider in one step: where its key goes **and** the key, behind a single question, so
/// adding a provider is one decision and not two.
#[tauri::command]
pub async fn provider_add(
    app: AppHandle,
    provider_id: String,
    kind: CloudProviderKind,
    base_url: String,
    secret: String,
    label: String,
    model: String,
) -> Result<ProviderView, String> {
    check_id(&provider_id)?;
    if secret.is_empty() {
        return Err("That key is empty.".into());
    }
    let resolved = validate(kind, &base_url)?;
    let entry = Provider {
        kind,
        base_url: resolved,
        label: clip(&label, 80),
        model: clip(&model, 120),
        enabled: true,
        added_at: now_ms(),
        paused: None,
        cap_requests: None,
        cap_tokens: None,
    };
    crate::consent::ask(crate::consent::Request::ProviderAdd {
        kind: kind_label(kind).to_string(),
        host: host_of(&entry.base_url),
    })
    .await?;
    let before = get(&provider_id);
    {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
        guard.insert(provider_id.clone(), entry.clone());
    }
    if let Err(e) = crate::secrets::save_secret_now(provider_id.clone(), secret) {
        // Put the table back: a destination with no key behind it would be a half-made provider.
        if let Ok(mut guard) = table().write() {
            match before {
                Some(b) => guard.insert(provider_id, b),
                None => guard.remove(&provider_id),
            };
        }
        return Err(e);
    }
    persist(&app)?;
    Ok(view_of(&provider_id, &entry))
}

/// Move a provider's destination. Asks, unless the address is the one it already has.
#[tauri::command]
pub async fn provider_bind(
    app: AppHandle,
    provider_id: String,
    kind: CloudProviderKind,
    base_url: String,
) -> Result<ProviderView, String> {
    check_id(&provider_id)?;
    let Some(before) = get(&provider_id) else {
        return Err("That provider isn't on the list. Add it first.".into());
    };
    let resolved = validate(kind, &base_url)?;
    let mut next = before.clone();
    next.kind = kind;
    next.base_url = resolved;
    if next.destination() == before.destination() {
        return Ok(view_of(&provider_id, &before));
    }
    crate::consent::ask(crate::consent::Request::ProviderBind {
        kind: kind_label(kind).to_string(),
        host: host_of(&next.base_url),
        was: Some(host_of(&before.base_url)),
    })
    .await?;
    {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
        guard.insert(provider_id.clone(), next.clone());
    }
    persist(&app)?;
    Ok(view_of(&provider_id, &next))
}

/// Change what cannot redirect a key: the name, the model, whether the provider may be selected.
#[tauri::command]
pub fn provider_update(
    app: AppHandle,
    provider_id: String,
    label: Option<String>,
    model: Option<String>,
    enabled: Option<bool>,
) -> Result<ProviderView, String> {
    check_id(&provider_id)?;
    let updated = {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
        let Some(p) = guard.get_mut(&provider_id) else {
            return Err("That provider isn't on the list.".into());
        };
        if let Some(l) = label {
            p.label = clip(&l, 80);
        }
        if let Some(m) = model {
            p.model = clip(&m, 120);
        }
        if let Some(e) = enabled {
            p.enabled = e;
        }
        p.clone()
    };
    persist(&app)?;
    Ok(view_of(&provider_id, &updated))
}

/// Let a paused provider be used again. Asks: it makes spending possible again.
#[tauri::command]
pub async fn provider_resume(app: AppHandle, provider_id: String) -> Result<ProviderView, String> {
    check_id(&provider_id)?;
    let Some(p) = get(&provider_id) else {
        return Err("That provider isn't on the list.".into());
    };
    if p.paused.is_none() {
        return Ok(view_of(&provider_id, &p));
    }
    crate::consent::ask(crate::consent::Request::ResumeProvider {
        kind: kind_label(p.kind).to_string(),
        host: host_of(&p.base_url),
    })
    .await?;
    let updated = {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
        let Some(x) = guard.get_mut(&provider_id) else {
            return Err("That provider isn't on the list.".into());
        };
        x.paused = None;
        x.clone()
    };
    persist(&app)?;
    Ok(view_of(&provider_id, &updated))
}

/// Is `new` a looser limit than `old`? (`None` means no limit at all.)
fn looser(old: Option<u64>, new: Option<u64>) -> bool {
    match (old, new) {
        (Some(_), None) => true,
        (Some(o), Some(n)) => n > o,
        _ => false,
    }
}

/// Set the monthly caps Atlas enforces for a provider (`None` = no cap). Lowering a cap, or setting
/// one where there was none, is free; loosening or removing one asks, because it allows more
/// spending.
#[tauri::command]
pub async fn provider_set_caps(
    app: AppHandle,
    provider_id: String,
    cap_requests: Option<u64>,
    cap_tokens: Option<u64>,
) -> Result<ProviderView, String> {
    check_id(&provider_id)?;
    let Some(before) = get(&provider_id) else {
        return Err("That provider isn't on the list.".into());
    };
    let norm = |v: Option<u64>| v.filter(|n| *n > 0);
    let (cr, ct) = (norm(cap_requests), norm(cap_tokens));
    if looser(before.cap_requests, cr) || looser(before.cap_tokens, ct) {
        crate::consent::ask(crate::consent::Request::RaiseCap {
            host: host_of(&before.base_url),
        })
        .await?;
    }
    let updated = {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
        let Some(x) = guard.get_mut(&provider_id) else {
            return Err("That provider isn't on the list.".into());
        };
        x.cap_requests = cr;
        x.cap_tokens = ct;
        x.clone()
    };
    persist(&app)?;
    Ok(view_of(&provider_id, &updated))
}

/// Forget a provider (called when it is removed). Withdrawing a destination only makes a saved
/// key less usable, so it asks nothing.
#[tauri::command]
pub fn provider_unbind(app: AppHandle, provider_id: String) -> Result<(), String> {
    {
        let mut guard = table().write().map_err(|_| "Couldn't update the provider list.".to_string())?;
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

    fn set(map: Table) {
        *table().write().unwrap() = map;
    }

    fn provider(kind: CloudProviderKind, base: &str) -> Provider {
        Provider {
            kind,
            base_url: base.to_string(),
            label: "L".into(),
            model: "m".into(),
            enabled: true,
            added_at: 1,
            paused: None,
            cap_requests: None,
            cap_tokens: None,
        }
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
        set(Table::new());
        assert!(get("cloud-1").is_none());
    }

    #[test]
    fn a_request_for_an_unbound_provider_is_refused_before_anything_is_sent() {
        let _t = turn();
        set(Table::new());
        let err = tauri::async_runtime::block_on(crate::cloud_intelligence::ask_cloud_provider(
            "cloud-unbound".to_string(),
            "m".to_string(),
            "hello".to_string(),
            None,
            None,
        ))
        .unwrap_err();
        assert!(err.contains("hasn't been confirmed"), "{err}");
        let err = tauri::async_runtime::block_on(crate::cloud_intelligence::test_cloud_provider(
            "search-tavily".to_string(),
            "m".to_string(),
        ))
        .unwrap_err();
        assert!(err.contains("hasn't been confirmed"), "{err}");
    }

    fn legacy_facts(list: serde_json::Value) -> serde_json::Value {
        serde_json::json!([
            { "kind": "preference", "subject": "execution.mode", "value": "doItPlus" },
            { "kind": "preference", "subject": "cloudProviders.list", "value": serde_json::to_string(&list).unwrap() }
        ])
    }

    #[test]
    fn the_saved_list_is_carried_over_with_its_names_models_and_flags() {
        let facts = legacy_facts(serde_json::json!([
            {"id": "cloud-a", "kind": "openai-compatible", "label": "Kimi", "model": "kimi-k2", "baseUrl": "https://api.moonshot.ai/v1/", "enabled": true},
            {"id": "cloud-b", "kind": "anthropic", "label": "Claude", "model": "opus", "baseUrl": "", "enabled": false}
        ]));
        let legacy = legacy_providers(Some(&facts));
        assert_eq!(legacy.len(), 2);
        let (next, adopted) = plan_migration(&Table::new(), &legacy, 1000);
        assert_eq!(adopted, 2);
        let a = &next["cloud-a"];
        assert_eq!((a.label.as_str(), a.model.as_str(), a.enabled), ("Kimi", "kimi-k2", true));
        assert_eq!(a.base_url, "https://api.moonshot.ai", "the same normalisation a request uses");
        assert_eq!(next["cloud-b"].base_url, "https://api.anthropic.com", "an empty address resolves to the default");
        assert!(!next["cloud-b"].enabled);
        assert!(a.added_at < next["cloud-b"].added_at, "the list keeps its order");
    }

    #[test]
    fn a_bad_or_reserved_entry_is_dropped_and_a_good_one_next_to_it_is_not() {
        let facts = legacy_facts(serde_json::json!([
            {"id": "cloud-http", "kind": "openai-compatible", "label": "x", "model": "m", "baseUrl": "http://evil.example", "enabled": true},
            {"id": "search-tavily", "kind": "openai-compatible", "label": "x", "model": "m", "baseUrl": "https://evil.example", "enabled": true},
            {"id": "bad id!", "kind": "openai-compatible", "label": "x", "model": "m", "baseUrl": "https://ok.example", "enabled": true},
            {"id": "cloud-ok", "kind": "openai-compatible", "label": "ok", "model": "m", "baseUrl": "https://ok.example", "enabled": true}
        ]));
        let (next, adopted) = plan_migration(&Table::new(), &legacy_providers(Some(&facts)), 0);
        assert_eq!(adopted, 1);
        assert_eq!(next.keys().collect::<Vec<_>>(), vec!["cloud-ok"]);
    }

    #[test]
    fn an_entry_already_in_the_table_keeps_its_destination() {
        let mut current = Table::new();
        current.insert(
            "cloud-a".into(),
            Provider {
                label: String::new(),
                model: String::new(),
                ..provider(CloudProviderKind::OpenaiCompatible, "https://approved.example")
            },
        );
        let facts = legacy_facts(serde_json::json!([
            {"id": "cloud-a", "kind": "openai-compatible", "label": "Name", "model": "m1", "baseUrl": "https://evil.example", "enabled": true}
        ]));
        let (next, adopted) = plan_migration(&current, &legacy_providers(Some(&facts)), 0);
        assert_eq!(adopted, 0);
        assert_eq!(next["cloud-a"].base_url, "https://approved.example");
        assert_eq!((next["cloud-a"].label.as_str(), next["cloud-a"].model.as_str()), ("Name", "m1"));
    }

    #[test]
    fn verification_accepts_only_exactly_what_was_intended() {
        use std::collections::HashMap;
        let mut intended = Table::new();
        intended.insert(
            "cloud-a".into(),
            provider(CloudProviderKind::Gemini, "https://generativelanguage.googleapis.com"),
        );
        let mut before: HashMap<String, serde_json::Value> = HashMap::new();
        before.insert("atlas.theme".into(), serde_json::json!("dark"));
        before.insert("atlas.nova.account".into(), serde_json::json!({"token": "kept"}));
        let mut after = before.clone();
        after.insert(STORAGE_KEY.into(), serde_json::to_value(&intended).unwrap());
        after.insert(MIGRATIONS_KEY.into(), serde_json::json!({ MIGRATION_ID: {"at": 1} }));
        assert!(verify_migration(&before, &after, &intended).is_ok());

        let mut changed = after.clone();
        changed.insert("atlas.theme".into(), serde_json::json!("light"));
        assert!(verify_migration(&before, &changed, &intended).unwrap_err().contains("atlas.theme"));

        let mut lost = after.clone();
        lost.remove("atlas.nova.account");
        assert!(verify_migration(&before, &lost, &intended).is_err(), "a vanished key is a failure");

        let mut extra = after.clone();
        extra.insert("stray.key".into(), serde_json::json!(1));
        assert!(verify_migration(&before, &extra, &intended).is_err());

        let mut wrong = after.clone();
        wrong.insert(STORAGE_KEY.into(), serde_json::json!({}));
        assert!(verify_migration(&before, &wrong, &intended).is_err());

        let mut unmarked = after.clone();
        unmarked.remove(MIGRATIONS_KEY);
        assert!(verify_migration(&before, &unmarked, &intended).is_err());
    }

    #[test]
    fn a_stored_table_with_a_bad_address_loses_that_entry_on_load() {
        let saved = serde_json::json!({
            "cloud-x": { "kind": "openai-compatible", "baseUrl": "http://evil.example" },
            "cloud-y": { "kind": "openai-compatible", "baseUrl": "https://api.example.com" },
            "search-tavily": { "kind": "openai-compatible", "baseUrl": "https://api.example.com" }
        });
        let t = load_table(Some(saved));
        assert_eq!(t.keys().collect::<Vec<_>>(), vec!["cloud-y"]);
        assert!(t["cloud-y"].enabled, "a table written before the list was native defaults to enabled");
    }

    #[test]
    fn the_earlier_shape_without_names_still_loads() {
        let t = load_table(Some(serde_json::json!({
            "cloud-z": { "kind": "anthropic", "baseUrl": "https://api.anthropic.com" }
        })));
        assert_eq!(t["cloud-z"].label, "");
    }
}
