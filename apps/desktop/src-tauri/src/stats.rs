//! Atlas Stats: what you have done with Atlas, kept on your device and nowhere else.
//!
//! "Your activity. Your statistics. Your device."
//!
//! * **Local only.** One small file, `stats/stats.json`, in Atlas's own data folder. Nothing here
//!   is sent anywhere: not to Nova, not to a cloud model, not to a server. There is no network code
//!   in this module and no setting that adds any.
//! * **Not tied to an account.** It does not read, write or depend on the Nova account, a sign-in,
//!   a subscription or an installed version. Signing out, changing account or deleting the account
//!   leaves it exactly as it was, and an update replaces the program, not this folder.
//! * **Counts, not content.** What was counted — never what was said, opened or typed. No file
//!   names, no prompts, no search terms, no paths.
//! * **Real.** Everything is counted where it happens: the native side counts model requests, web
//!   fetches, spoken replies, confirmation questions and stops; the interface only reports the
//!   outcomes only it sees (how many actions ran and how they ended), through a closed list of
//!   metric names. Token figures for models are estimates unless the provider reported its own,
//!   and say so.
//!
//! Stored as daily totals, so a year is a few hundred rows however much is done, and so any period
//! — today, last year, lifetime — is a sum.
//!
//! Cost accounting lives here too: the cloud-safety caps (`cloud_safety.rs`) are enforced against
//! the same monthly totals the Stats page shows, so what you see is what is limited.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "stats.json";
const FLUSH_EVERY: Duration = Duration::from_secs(15);
const VERSION: u32 = 1;

/// Metric names the interface may record. Native code may bump any name it owns; the page may
/// only bump these, so a script in the page cannot invent counters or write free text.
pub const PAGE_METRICS: &[&str] = &[
    "chat.messages_sent",
    "chat.replies_model",
    "chat.replies_atlas",
    "actions.done",
    "actions.failed",
    "actions.declined",
    "actions.halted",
    "tasks.completed",
    "tasks.failed",
    "tasks.cancelled",
    "area.files",
    "area.system",
    "area.web",
    "area.apps",
    "area.dev",
    "area.input",
    "area.other",
];

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    version: u32,
    /// When counting started (milliseconds since the epoch).
    #[serde(default)]
    created_at: u64,
    /// `YYYY-MM-DD` (local) → metric → count.
    #[serde(default)]
    days: BTreeMap<String, BTreeMap<String, u64>>,
}

struct Live {
    store: Store,
    path: Option<PathBuf>,
    dirty: bool,
    last_backup: Option<SystemTime>,
}

fn live() -> &'static Mutex<Live> {
    static L: OnceLock<Mutex<Live>> = OnceLock::new();
    L.get_or_init(|| {
        Mutex::new(Live {
            store: Store { version: VERSION, created_at: now_ms(), ..Default::default() },
            path: None,
            dirty: false,
            last_backup: None,
        })
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- dates (local, no calendar crate) ----------------------------------------------------

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_day(s: &str) -> Option<i64> {
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if it.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Today's local date as `(year, month, day)`.
#[cfg(windows)]
fn local_today() -> (i64, i64, i64) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    (t.wYear as i64, t.wMonth as i64, t.wDay as i64)
}

#[cfg(not(windows))]
fn local_today() -> (i64, i64, i64) {
    (1970, 1, 1)
}

fn key_of(y: i64, m: i64, d: i64) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

pub(crate) fn today_key() -> String {
    let (y, m, d) = local_today();
    key_of(y, m, d)
}

/// `(first day, last day)` as day numbers, for a named period. `None` first = from the beginning.
pub(crate) fn period_range(period: &str, today: (i64, i64, i64)) -> Option<(Option<i64>, i64, String)> {
    let (y, m, d) = today;
    let t = days_from_civil(y, m, d);
    Some(match period {
        "today" => (Some(t), t, "Today".to_string()),
        "yesterday" => (Some(t - 1), t - 1, "Yesterday".to_string()),
        "last7" => (Some(t - 6), t, "Last 7 days".to_string()),
        "last30" => (Some(t - 29), t, "Last 30 days".to_string()),
        "month" => (Some(days_from_civil(y, m, 1)), t, "This month".to_string()),
        "year" => (Some(days_from_civil(y, 1, 1)), t, "This year".to_string()),
        "lastyear" => (
            Some(days_from_civil(y - 1, 1, 1)),
            days_from_civil(y - 1, 12, 31),
            "Last year".to_string(),
        ),
        "lifetime" => (None, i64::MAX, "Lifetime".to_string()),
        _ => return None,
    })
}

// ---- recording ---------------------------------------------------------------------------

/// Count something that happened. Cheap and never fails: a stats problem must never become a
/// problem for the thing being counted.
pub fn bump(metric: &str, n: u64) {
    if n == 0 {
        return;
    }
    let day = today_key();
    if let Ok(mut l) = live().lock() {
        *l.store.days.entry(day).or_default().entry(metric.to_string()).or_insert(0) += n;
        l.dirty = true;
    }
}

/// A model request: counted under the group (`model.local`, `model.cloud`, `model.nova`) and,
/// for a cloud provider, under its own id so a per-provider cap can be enforced.
pub fn model_request(group: &str, provider_id: Option<&str>, tokens_in: u64, tokens_out: u64, ok: bool) {
    bump(&format!("{group}.requests"), 1);
    bump(&format!("{group}.tokens_in"), tokens_in);
    bump(&format!("{group}.tokens_out"), tokens_out);
    if !ok {
        bump(&format!("{group}.failures"), 1);
    }
    if let Some(id) = provider_id {
        bump(&format!("cloud:{id}:requests"), 1);
        bump(&format!("cloud:{id}:tokens_in"), tokens_in);
        bump(&format!("cloud:{id}:tokens_out"), tokens_out);
        if !ok {
            bump(&format!("cloud:{id}:failures"), 1);
        }
    }
}

/// What a person's prompt or a reply costs in tokens when the provider did not say: about four
/// characters each, which is an estimate and is shown as one.
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// Sum of one metric from the first of this month to today (local). Used by the cloud caps.
pub fn month_total(metric: &str) -> u64 {
    let (y, m, d) = local_today();
    let from = key_of(y, m, 1);
    let to = key_of(y, m, d);
    let Ok(l) = live().lock() else { return 0 };
    l.store
        .days
        .range(from..=to)
        .map(|(_, v)| v.get(metric).copied().unwrap_or(0))
        .sum()
}

// ---- persistence -------------------------------------------------------------------------

fn load_file(path: &PathBuf) -> Option<Store> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Store>(&raw).ok()
}

/// Called once from `setup()`. Reads what is there (falling back to the last backup if the file
/// is damaged), counts this launch, and starts the saver.
pub fn init(app: &AppHandle) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d.join("stats"),
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(FILE);
    let backup = dir.join("stats.json.bak");

    let loaded = load_file(&path).or_else(|| {
        let b = load_file(&backup);
        if b.is_some() && path.exists() {
            // A damaged file is kept, not deleted, for anyone who wants to look at it.
            let _ = std::fs::rename(&path, dir.join("stats.json.corrupt"));
        }
        b
    });

    if let Ok(mut l) = live().lock() {
        if let Some(mut s) = loaded {
            if s.created_at == 0 {
                s.created_at = now_ms();
            }
            s.version = VERSION;
            l.store = s;
        }
        l.path = Some(path);
        l.dirty = true;
    }
    bump("app.launches", 1);

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut minute = 0u32;
        loop {
            std::thread::sleep(FLUSH_EVERY);
            minute += 1;
            // Four ticks a minute: count a minute the window was on screen.
            if minute % 4 == 0 {
                let visible = handle
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if visible {
                    bump("app.minutes_open", 1);
                }
            }
            flush();
        }
    });
}

/// Write the file now, if anything changed. Safe to call from anywhere, including at exit.
pub fn flush() {
    let (path, body, want_backup) = {
        let Ok(mut l) = live().lock() else { return };
        if !l.dirty {
            return;
        }
        let Some(path) = l.path.clone() else { return };
        let body = match serde_json::to_string_pretty(&l.store) {
            Ok(b) => b,
            Err(_) => return,
        };
        l.dirty = false;
        let due = l
            .last_backup
            .map(|t| t.elapsed().map(|e| e > Duration::from_secs(600)).unwrap_or(true))
            .unwrap_or(true);
        if due {
            l.last_backup = Some(SystemTime::now());
        }
        (path, body, due)
    };
    if want_backup && path.exists() {
        let _ = std::fs::copy(&path, path.with_file_name("stats.json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if let Ok(mut l) = live().lock() {
            l.dirty = true;
        }
    }
}

// ---- reading -----------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub id: String,
    pub label: String,
    pub requests: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub failures: u64,
    pub limit_hits: u64,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPoint {
    pub label: String,
    pub value: u64,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub period: String,
    pub label: String,
    /// First and last day covered, `YYYY-MM-DD`; `from` is empty for lifetime.
    pub from: String,
    pub to: String,
    /// When counting started, `YYYY-MM-DD` (local); empty if unknown.
    pub since: String,
    pub days_with_activity: u64,
    pub metrics: BTreeMap<String, u64>,
    pub providers: Vec<ProviderUsage>,
    /// Activity over the period: per day for up to 31 days, per month beyond that.
    pub series: Vec<SeriesPoint>,
}

fn activity_of(m: &BTreeMap<String, u64>) -> u64 {
    ["chat.messages_sent", "actions.done", "actions.failed", "tasks.completed"]
        .iter()
        .map(|k| m.get(*k).copied().unwrap_or(0))
        .sum()
}

fn summarise(store: &Store, period: &str, today: (i64, i64, i64), label_for: &dyn Fn(&str) -> String) -> Option<Summary> {
    let (from_day, to_day, label) = period_range(period, today)?;
    let mut metrics: BTreeMap<String, u64> = BTreeMap::new();
    let mut per_day: Vec<(String, u64)> = Vec::new();
    let mut active = 0u64;
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    for (day, row) in &store.days {
        let Some(n) = parse_day(day) else { continue };
        if n > to_day || from_day.is_some_and(|f| n < f) {
            continue;
        }
        if first.is_none() {
            first = Some(day.clone());
        }
        last = Some(day.clone());
        for (k, v) in row {
            *metrics.entry(k.clone()).or_insert(0) += v;
        }
        let a = activity_of(row);
        if a > 0 || row.values().any(|v| *v > 0) {
            active += 1;
        }
        per_day.push((day.clone(), a));
    }

    // Per-provider rows from `cloud:<id>:<metric>`.
    let mut ids: BTreeMap<String, ProviderUsage> = BTreeMap::new();
    for (k, v) in &metrics {
        let Some(rest) = k.strip_prefix("cloud:") else { continue };
        let Some((id, what)) = rest.rsplit_once(':') else { continue };
        let e = ids.entry(id.to_string()).or_insert_with(|| ProviderUsage {
            id: id.to_string(),
            label: label_for(id),
            requests: 0,
            tokens_in: 0,
            tokens_out: 0,
            failures: 0,
            limit_hits: 0,
        });
        match what {
            "requests" => e.requests += v,
            "tokens_in" => e.tokens_in += v,
            "tokens_out" => e.tokens_out += v,
            "failures" => e.failures += v,
            "limit_hits" => e.limit_hits += v,
            _ => {}
        }
    }
    // Provider rows are listed apart; the flat map keeps only named metrics.
    metrics.retain(|k, _| !k.starts_with("cloud:"));

    let series = if per_day.len() <= 31 {
        per_day.into_iter().map(|(label, value)| SeriesPoint { label, value }).collect()
    } else {
        let mut by_month: BTreeMap<String, u64> = BTreeMap::new();
        for (day, a) in per_day {
            *by_month.entry(day[..7].to_string()).or_insert(0) += a;
        }
        by_month.into_iter().map(|(label, value)| SeriesPoint { label, value }).collect()
    };

    let since = {
        let ms = store.created_at;
        if ms == 0 {
            String::new()
        } else {
            let days = (ms / 86_400_000) as i64;
            civil_from_days(days)
        }
    };
    Some(Summary {
        period: period.to_string(),
        label,
        from: from_day.map(|_| first.clone().unwrap_or_default()).unwrap_or_default(),
        to: last.unwrap_or_default(),
        since,
        days_with_activity: active,
        metrics,
        providers: ids.into_values().collect(),
        series,
    })
}

/// `YYYY-MM-DD` for a day count (UTC date; only used to say roughly "since").
fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    key_of(if m <= 2 { y + 1 } else { y }, m, d)
}

// ---- commands ----------------------------------------------------------------------------

#[tauri::command]
pub fn stats_summary(period: String) -> Result<Summary, String> {
    let l = live().lock().map_err(|_| "Stats are unavailable right now.".to_string())?;
    summarise(&l.store, &period, local_today(), &|id| {
        crate::provider_bindings::get(id)
            .map(|p| if p.label.is_empty() { "Cloud provider".to_string() } else { p.label })
            .unwrap_or_else(|| "A provider you removed".to_string())
    })
    .ok_or_else(|| "That isn't a period I know.".to_string())
}

/// Record outcomes only the interface sees. Closed list, small counts, no text.
#[tauri::command]
pub fn stats_record(metric: String, count: Option<u64>) -> Result<(), String> {
    if !PAGE_METRICS.contains(&metric.as_str()) {
        return Err("That isn't something Atlas counts.".into());
    }
    bump(&metric, count.unwrap_or(1).min(1000));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsInfo {
    pub since: String,
    pub days_recorded: u64,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn stats_info() -> StatsInfo {
    let l = live().lock().ok();
    let (since, days, path) = match &l {
        Some(l) => (
            if l.store.created_at == 0 { String::new() } else { civil_from_days((l.store.created_at / 86_400_000) as i64) },
            l.store.days.len() as u64,
            l.path.clone(),
        ),
        None => (String::new(), 0, None),
    };
    let size = path.and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    StatsInfo { since, days_recorded: days, size_bytes: size }
}

/// Start counting again from nothing. Asks first: it cannot be undone.
#[tauri::command]
pub async fn stats_reset() -> Result<(), String> {
    crate::consent::ask(crate::consent::Request::ResetStats).await?;
    {
        let mut l = live().lock().map_err(|_| "Stats are unavailable right now.".to_string())?;
        l.store = Store { version: VERSION, created_at: now_ms(), ..Default::default() };
        l.dirty = true;
    }
    flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(rows: &[(&str, &str, u64)]) -> Store {
        let mut s = Store { version: VERSION, created_at: 1_700_000_000_000, ..Default::default() };
        for (day, metric, n) in rows {
            s.days.entry((*day).to_string()).or_default().insert((*metric).to_string(), *n);
        }
        s
    }

    fn sum(period: &str, today: (i64, i64, i64), s: &Store, metric: &str) -> u64 {
        summarise(s, period, today, &|_| "P".to_string()).unwrap().metrics.get(metric).copied().unwrap_or(0)
    }

    #[test]
    fn civil_date_arithmetic_is_right() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1) - days_from_civil(2000, 2, 28), 2, "2000 is a leap year");
        assert_eq!(days_from_civil(1900, 3, 1) - days_from_civil(1900, 2, 28), 1, "1900 is not");
        assert_eq!(civil_from_days(days_from_civil(2026, 10, 14)), "2026-10-14");
        assert_eq!(parse_day("2026-02-30").map(|_| ()), Some(()), "day range is only sanity-checked");
        assert!(parse_day("nonsense").is_none());
    }

    #[test]
    fn each_period_sums_exactly_its_own_days() {
        let s = store_with(&[
            ("2025-06-01", "actions.done", 5),   // last year
            ("2025-12-31", "actions.done", 7),   // last year, last day
            ("2026-01-01", "actions.done", 11),  // this year, first day
            ("2026-09-30", "actions.done", 13),  // last month
            ("2026-10-01", "actions.done", 17),  // this month
            ("2026-10-13", "actions.done", 19),  // yesterday
            ("2026-10-14", "actions.done", 23),  // today
        ]);
        let t = (2026, 10, 14);
        assert_eq!(sum("today", t, &s, "actions.done"), 23);
        assert_eq!(sum("yesterday", t, &s, "actions.done"), 19);
        assert_eq!(sum("last7", t, &s, "actions.done"), 19 + 23);
        assert_eq!(sum("last30", t, &s, "actions.done"), 13 + 17 + 19 + 23);
        assert_eq!(sum("month", t, &s, "actions.done"), 17 + 19 + 23);
        assert_eq!(sum("year", t, &s, "actions.done"), 11 + 13 + 17 + 19 + 23);
        assert_eq!(sum("lastyear", t, &s, "actions.done"), 5 + 7);
        assert_eq!(sum("lifetime", t, &s, "actions.done"), 5 + 7 + 11 + 13 + 17 + 19 + 23);
        assert!(summarise(&s, "fortnight", t, &|_| String::new()).is_none());
    }

    #[test]
    fn providers_are_listed_apart_with_their_own_totals() {
        let s = store_with(&[
            ("2026-10-13", "cloud:abc:requests", 4),
            ("2026-10-14", "cloud:abc:requests", 6),
            ("2026-10-14", "cloud:abc:tokens_in", 1000),
            ("2026-10-14", "cloud:abc:limit_hits", 1),
            ("2026-10-14", "model.cloud.requests", 10),
        ]);
        let sm = summarise(&s, "lifetime", (2026, 10, 14), &|id| format!("label-{id}")).unwrap();
        assert_eq!(sm.providers.len(), 1);
        let p = &sm.providers[0];
        assert_eq!((p.id.as_str(), p.label.as_str(), p.requests, p.tokens_in, p.limit_hits), ("abc", "label-abc", 10, 1000, 1));
        assert!(!sm.metrics.keys().any(|k| k.starts_with("cloud:")), "the flat list has only named metrics");
        assert_eq!(sm.metrics["model.cloud.requests"], 10);
    }

    #[test]
    fn a_long_period_is_charted_by_month() {
        let mut rows = Vec::new();
        for m in 1..=6 {
            rows.push((format!("2026-{m:02}-10"), "actions.done", 3u64));
            rows.push((format!("2026-{m:02}-20"), "actions.done", 4u64));
        }
        let mut s = Store { version: 1, created_at: 1, ..Default::default() };
        for (d, k, n) in &rows {
            s.days.entry(d.clone()).or_default().insert((*k).to_string(), *n);
        }
        // 12 active days is under the 31-point limit: per day.
        let sm = summarise(&s, "year", (2026, 12, 31), &|_| String::new()).unwrap();
        assert_eq!(sm.series.len(), 12);
        // Pad past the limit and it folds to months.
        for d in 1..=28 {
            s.days.entry(format!("2026-07-{d:02}")).or_default().insert("actions.done".into(), 1);
            s.days.entry(format!("2026-08-{d:02}")).or_default().insert("actions.done".into(), 1);
        }
        let sm = summarise(&s, "year", (2026, 12, 31), &|_| String::new()).unwrap();
        assert_eq!(sm.series.len(), 8);
        assert_eq!(sm.series[0].label, "2026-01");
        assert_eq!(sm.series[0].value, 7);
    }

    #[test]
    fn the_page_can_only_record_names_on_the_list() {
        assert!(stats_record("actions.done".into(), Some(1)).is_ok());
        for bad in ["cloud:abc:requests", "model.cloud.requests", "anything.else", "", "../x"] {
            assert!(stats_record(bad.into(), None).is_err(), "{bad}");
        }
    }

    #[test]
    fn token_estimates_round_up() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn the_stats_file_is_independent_of_accounts_and_updates() {
        // Not a behaviour test: a tripwire. This module must not know the account, the session or
        // the installed version, which is what lets them change without touching the numbers.
        let src = include_str!("stats.rs");
        let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        let forbidden = ["account_session", "nova.account", "reqwest", "CARGO_PKG_VERSION"];
        for f in forbidden {
            let uses = code.matches(f).count();
            // This very list names them once each, in the test itself.
            assert!(uses <= 1, "{f} appears in stats.rs outside this tripwire ({uses})");
        }
    }
}
