//! Atlas's knowledge pack: what is loaded, where it came from, and how it is refreshed
//! (docs/PLAN-2.0.3.md §B2, §N).
//!
//! Two places a pack can come from, in this order of preference:
//!
//!   1. the **refreshed** pack in Atlas's data folder, if it verifies and is newer;
//!   2. the **bundled** pack that shipped in the installer, the offline floor.
//!
//! Every pack, bundled or refreshed, is verified against the compiled-in key
//! (`knowledge_signature.rs`) before it is used: nothing unsigned is ever read. A pack that fails to
//! verify is ignored, not partly used, and the reason is recorded for the Settings page.
//!
//! The refresh fetches exactly two pinned addresses (the pack and its signature), only follows
//! redirects to GitHub's own download hosts, refuses anything over the size cap, and runs at most once
//! a day, at startup, when the person has not turned it off. With it off, Atlas never contacts GitHub
//! for knowledge. Failure always falls back silently to what is already in use.
//!
//! The pack's *text* is data: this module only verifies and hands it on; it never interprets it.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::knowledge_signature as sig;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Hosts a pinned GitHub release download may redirect to. Anything else aborts the request.
const REDIRECT_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// Refresh the pack from the Nova-Knowledge release, at most once a day. Default ON.
    #[serde(default = "yes")]
    auto_refresh: bool,
    /// Look up current information from Nova's public pages when a question needs it (layer 3,
    /// docs/PLAN-2.0.3.md §N). Default ON. Off = Atlas never fetches a Nova page to answer a question.
    #[serde(default = "yes")]
    live_lookups: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_refresh: true, live_lookups: true }
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Bookkeeping {
    #[serde(default)]
    last_checked_ms: u64,
    #[serde(default)]
    last_updated_ms: u64,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    None,
    Bundled,
    Refreshed,
}

#[derive(Clone)]
struct Active {
    source: Source,
    seq: u64,
    built_at: String,
    /// The verified pack file, as text. Handed to the engine unchanged.
    text: String,
}

struct State {
    dir: Option<PathBuf>,
    bundled_dir: Option<PathBuf>,
    settings: Settings,
    book: Bookkeeping,
    active: Option<Active>,
    bundled_seq: Option<u64>,
    /// Why the bundled pack was not used, for the Settings page.
    bundled_problem: Option<String>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(State {
            dir: None,
            bundled_dir: None,
            settings: Settings::default(),
            book: Bookkeeping::default(),
            active: None,
            bundled_seq: None,
            bundled_problem: None,
        })
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- pure rules (tested) ---------------------------------------------------------------------

/// Has a day passed since the last check?
pub(crate) fn due(last_checked_ms: u64, now: u64) -> bool {
    now.saturating_sub(last_checked_ms) >= DAY_MS
}

/// May a redirect to this host be followed?
pub(crate) fn redirect_host_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    REDIRECT_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// Of the packs that verified, the one to use: the highest `seq`; on a tie the bundled one (it is
/// the one that was reviewed with the release).
pub(crate) fn best(bundled: Option<Active>, refreshed: Option<Active>) -> Option<Active> {
    match (bundled, refreshed) {
        (Some(b), Some(r)) => Some(if r.seq > b.seq { r } else { b }),
        (b, r) => b.or(r),
    }
}

/// Cached pack file names to delete, keeping the newest `keep` by sequence number.
pub(crate) fn prune_list(mut seqs: Vec<u64>, keep: usize) -> Vec<u64> {
    seqs.sort_unstable_by(|a, b| b.cmp(a));
    seqs.into_iter().skip(keep).collect()
}

fn verify_files(pack: &Path, sig_path: &Path, source: Source) -> Result<Active, String> {
    let bytes = std::fs::read(pack).map_err(|_| "pack file missing".to_string())?;
    let sig_text = std::fs::read_to_string(sig_path).map_err(|_| "signature file missing".to_string())?;
    let v = sig::verify(&bytes, &sig_text)?;
    let text = String::from_utf8(bytes).map_err(|_| "pack is not text".to_string())?;
    Ok(Active { source, seq: v.seq, built_at: v.built_at, text })
}

// ---- files -----------------------------------------------------------------------------------

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

fn persist(s: &State) {
    let Some(dir) = &s.dir else { return };
    let _ = write_atomic(&dir.join("settings.json"), serde_json::to_string_pretty(&s.settings).unwrap_or_default().as_bytes());
    let _ = write_atomic(&dir.join("state.json"), serde_json::to_string_pretty(&s.book).unwrap_or_default().as_bytes());
}

fn cached_seqs(dir: &Path) -> Vec<u64> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    name.strip_prefix("pack-")?.strip_suffix(".json")?.parse::<u64>().ok()
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- startup ---------------------------------------------------------------------------------

/// Called once from `setup()`. Loads settings, the bundled pack and the newest valid cached one.
pub fn init(app: &AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("knowledge"),
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(&dir);
    let bundled_dir = app.path().resource_dir().ok().map(|d| d.join("knowledge"));
    load(dir, bundled_dir);

    let refresh_due = state().lock().map(|s| s.settings.auto_refresh && due(s.book.last_checked_ms, now_ms())).unwrap_or(false);
    if refresh_due {
        tauri::async_runtime::spawn(async {
            let _ = check_now_inner().await;
        });
    }
}

fn load(dir: PathBuf, bundled_dir: Option<PathBuf>) {
    let settings: Settings = read_json(&dir.join("settings.json"));
    let book: Bookkeeping = read_json(&dir.join("state.json"));

    let mut bundled_problem = None;
    let bundled = bundled_dir.as_ref().and_then(|b| {
        match verify_files(&b.join("knowledge-pack.json"), &b.join("knowledge-pack.sig"), Source::Bundled) {
            Ok(a) => Some(a),
            Err(e) => {
                bundled_problem = Some(e);
                None
            }
        }
    });

    // The newest cached pack that verifies. A corrupt or tampered one is deleted, not trusted.
    let mut refreshed: Option<Active> = None;
    let mut seqs = cached_seqs(&dir);
    seqs.sort_unstable_by(|a, b| b.cmp(a));
    for seq in seqs {
        let pack = dir.join(format!("pack-{seq}.json"));
        let sigf = dir.join(format!("pack-{seq}.sig"));
        match verify_files(&pack, &sigf, Source::Refreshed) {
            Ok(a) if a.seq == seq => {
                refreshed = Some(a);
                break;
            }
            _ => {
                let _ = std::fs::remove_file(&pack);
                let _ = std::fs::remove_file(&sigf);
            }
        }
    }

    if let Ok(mut s) = state().lock() {
        s.bundled_seq = bundled.as_ref().map(|b| b.seq);
        s.bundled_problem = bundled_problem;
        s.active = best(bundled, refreshed);
        s.settings = settings;
        s.book = book;
        s.dir = Some(dir);
        s.bundled_dir = bundled_dir;
    }
}

// ---- refresh ---------------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Atlas-Knowledge/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else if attempt.url().host_str().is_some_and(redirect_host_allowed) && attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.error("redirected somewhere that is not a GitHub download host")
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// Download one pinned address, refusing anything over `cap` bytes.
async fn fetch_capped(client: &reqwest::Client, url: &str, cap: usize) -> Result<Vec<u8>, String> {
    if !sig::url_allowed(url) {
        return Err("That address is not one Atlas fetches knowledge from.".into());
    }
    let mut resp = client.get(url).send().await.map_err(|_| "Couldn't reach GitHub.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}.", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n as usize > cap) {
        return Err("The knowledge pack is larger than Atlas accepts.".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The download was interrupted.".to_string())? {
        if out.len() + chunk.len() > cap {
            return Err("The knowledge pack is larger than Atlas accepts.".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

async fn check_now_inner() -> Result<(), String> {
    let (dir, in_use) = {
        let s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
        (s.dir.clone().ok_or("Knowledge is not set up.")?, s.active.as_ref().map(|a| a.seq))
    };
    let result = refresh(&dir, in_use).await;
    let mut s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    s.book.last_checked_ms = now_ms();
    crate::stats::bump(if result.is_ok() { "knowledge.refreshes" } else { "knowledge.refresh_failures" }, 1);
    match &result {
        Ok(Some(active)) => {
            s.book.last_updated_ms = now_ms();
            s.book.last_error = None;
            s.active = best(s.active.take(), Some(active.clone()));
        }
        Ok(None) => s.book.last_error = None,
        Err(e) => s.book.last_error = Some(e.clone()),
    }
    persist(&s);
    result.map(|_| ())
}

/// Fetch, verify, and (if newer than what is in use) store a refreshed pack.
async fn refresh(dir: &Path, in_use: Option<u64>) -> Result<Option<Active>, String> {
    let client = client()?;
    let pack = fetch_capped(&client, sig::PINNED_PACK_URL, sig::MAX_PACK_BYTES).await?;
    let sig_bytes = fetch_capped(&client, sig::PINNED_SIG_URL, 16 * 1024).await?;
    let sig_text = String::from_utf8(sig_bytes).map_err(|_| "The signature was not text.".to_string())?;
    let v = sig::verify(&pack, &sig_text)?;
    if !sig::is_newer(v.seq, in_use) {
        return Ok(None); // verified, but not newer: nothing to do (and never a replay of an old pack)
    }
    let text = String::from_utf8(pack.clone()).map_err(|_| "The pack was not text.".to_string())?;
    write_atomic(&dir.join(format!("pack-{}.json", v.seq)), &pack).map_err(|_| "Couldn't save the knowledge pack.".to_string())?;
    write_atomic(&dir.join(format!("pack-{}.sig", v.seq)), sig_text.as_bytes()).map_err(|_| "Couldn't save the knowledge pack.".to_string())?;
    // Keep the newest and the one before it; the rest are deleted.
    for old in prune_list(cached_seqs(dir), 2) {
        let _ = std::fs::remove_file(dir.join(format!("pack-{old}.json")));
        let _ = std::fs::remove_file(dir.join(format!("pack-{old}.sig")));
    }
    Ok(Some(Active { source: Source::Refreshed, seq: v.seq, built_at: v.built_at, text }))
}

// ---- what the interface sees -------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Where the pack in use came from; `none` when nothing verified.
    pub source: Source,
    pub seq: Option<u64>,
    pub built_at: Option<String>,
    pub bundled_seq: Option<u64>,
    /// False in a build with no knowledge key: nothing can verify.
    pub provisioned: bool,
    pub auto_refresh: bool,
    pub live_lookups: bool,
    pub last_checked_ms: u64,
    pub last_updated_ms: u64,
    pub last_error: Option<String>,
    pub bundled_problem: Option<String>,
}

fn status_of(s: &State) -> Status {
    Status {
        source: s.active.as_ref().map(|a| a.source).unwrap_or(Source::None),
        seq: s.active.as_ref().map(|a| a.seq),
        built_at: s.active.as_ref().map(|a| a.built_at.clone()),
        bundled_seq: s.bundled_seq,
        provisioned: !sig::PUBLIC_KEY_HEX.is_empty(),
        auto_refresh: s.settings.auto_refresh,
        live_lookups: s.settings.live_lookups,
        last_checked_ms: s.book.last_checked_ms,
        last_updated_ms: s.book.last_updated_ms,
        last_error: s.book.last_error.clone(),
        bundled_problem: s.bundled_problem.clone(),
    }
}

#[tauri::command]
pub fn knowledge_status() -> Result<Status, String> {
    let s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    Ok(status_of(&s))
}

/// The verified pack, as text, for the engine to search. `None` when nothing verified.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPack {
    pub source: Source,
    pub seq: u64,
    pub built_at: String,
    pub text: String,
}

#[tauri::command]
pub fn knowledge_pack() -> Result<Option<LoadedPack>, String> {
    let s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    Ok(s.active.as_ref().map(|a| LoadedPack { source: a.source, seq: a.seq, built_at: a.built_at.clone(), text: a.text.clone() }))
}

/// Check for a newer pack now, whatever the daily schedule says. Works even with auto-refresh off:
/// the person asked. The only network traffic in this module besides the daily check.
#[tauri::command]
pub async fn knowledge_check_now() -> Result<Status, String> {
    crate::halt::global().check()?;
    let outcome = check_now_inner().await;
    let s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    // A failed check is reported in the status (`last_error`), not as a thrown error: the page
    // shows it as a row, and Atlas carries on with the pack it has.
    let _ = outcome;
    Ok(status_of(&s))
}

#[tauri::command]
pub fn knowledge_set_auto_refresh(enabled: bool) -> Result<Status, String> {
    let mut s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    s.settings.auto_refresh = enabled;
    persist(&s);
    Ok(status_of(&s))
}

#[tauri::command]
pub fn knowledge_set_live_lookups(enabled: bool) -> Result<Status, String> {
    let mut s = state().lock().map_err(|_| "Knowledge is unavailable right now.".to_string())?;
    s.settings.live_lookups = enabled;
    persist(&s);
    Ok(status_of(&s))
}

/// Is the live lookup of Nova's public pages switched on? (Used by `knowledge_live.rs`.)
pub fn live_lookups_enabled() -> bool {
    state().lock().map(|s| s.settings.live_lookups).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(seq: u64, source: Source) -> Active {
        Active { source, seq, built_at: "t".into(), text: String::new() }
    }

    #[test]
    fn a_check_is_due_after_a_day_and_not_before() {
        assert!(due(0, DAY_MS));
        assert!(!due(1_000, 1_000 + DAY_MS - 1));
        assert!(due(1_000, 1_000 + DAY_MS));
        assert!(!due(u64::MAX, 5), "a clock that went backwards does not trigger a check");
    }

    #[test]
    fn redirects_may_only_go_to_githubs_download_hosts() {
        assert!(redirect_host_allowed("github.com"));
        assert!(redirect_host_allowed("objects.githubusercontent.com"));
        assert!(redirect_host_allowed("release-assets.githubusercontent.com"));
        assert!(!redirect_host_allowed("evil.example"));
        assert!(!redirect_host_allowed("github.com.evil.example"));
        assert!(!redirect_host_allowed("notgithub.com"));
    }

    #[test]
    fn the_newest_verified_pack_wins_and_ties_go_to_the_bundled_one() {
        assert_eq!(best(Some(active(5, Source::Bundled)), Some(active(9, Source::Refreshed))).unwrap().source, Source::Refreshed);
        assert_eq!(best(Some(active(9, Source::Bundled)), Some(active(5, Source::Refreshed))).unwrap().source, Source::Bundled);
        assert_eq!(best(Some(active(7, Source::Bundled)), Some(active(7, Source::Refreshed))).unwrap().source, Source::Bundled);
        assert_eq!(best(None, Some(active(1, Source::Refreshed))).unwrap().source, Source::Refreshed);
        assert!(best(None, None).is_none(), "nothing verified means no knowledge, not unverified knowledge");
    }

    #[test]
    fn only_the_newest_two_cached_packs_are_kept() {
        assert_eq!(prune_list(vec![3, 9, 1, 7], 2), vec![3, 1]);
        assert!(prune_list(vec![2, 1], 2).is_empty());
    }

    #[test]
    fn settings_default_to_on_and_survive_a_missing_field() {
        assert_eq!(Settings::default(), Settings { auto_refresh: true, live_lookups: true });
        let parsed: Settings = serde_json::from_str("{}").unwrap();
        assert!(parsed.auto_refresh && parsed.live_lookups);
        let off: Settings = serde_json::from_str(r#"{"autoRefresh":false}"#).unwrap();
        assert!(!off.auto_refresh && off.live_lookups);
    }

    #[test]
    fn a_tampered_cached_pack_is_deleted_and_the_bundled_pack_is_used() {
        let tmp = std::env::temp_dir().join(format!("atlas-knowledge-test-{}", now_ms()));
        let cache = tmp.join("cache");
        let bundled = tmp.join("bundled");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::create_dir_all(&bundled).unwrap();

        // The vector is signed with a throwaway key, not the compiled-in one, so it can never verify
        // here: that is exactly the "garbage in the cache" case.
        let v = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("knowledge-signature-vector.json");
        let vec: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(v).unwrap()).unwrap();
        std::fs::write(cache.join("pack-1000.json"), vec["pack"].as_str().unwrap()).unwrap();
        std::fs::write(cache.join("pack-1000.sig"), vec["sig"].to_string()).unwrap();

        load(cache.clone(), Some(bundled));
        let st = state().lock().unwrap();
        assert!(st.active.is_none(), "an unverifiable pack is not used");
        drop(st);
        assert!(!cache.join("pack-1000.json").exists(), "the bad cached pack was deleted");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
