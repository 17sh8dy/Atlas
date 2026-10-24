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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "stats.json";
const FLUSH_EVERY: Duration = Duration::from_secs(15);
/// 1 = tokens as one combined count. 2 = adds the confirmed/estimated/uncertain split (see
/// `usage.rs`); every v1 key keeps its meaning, so a v2 file is still readable by v1.
const VERSION: u32 = 2;

/// Time with Atlas is counted only while the person is actually using it: a quarter-minute tick
/// counts when the window is on screen AND some input reached Atlas within the last minute. Leaving
/// Atlas open in the corner counts nothing (that is `app.minutes_open`, kept separately).
const IDLE_AFTER_MS: u64 = 60_000;
/// Messages closer together than this are one conversation; a longer silence starts a new one.
const CONVERSATION_GAP_MS: u64 = 30 * 60 * 1000;

/// When input last reached Atlas (milliseconds since the epoch; 0 = not since launch).
static LAST_INPUT_MS: AtomicU64 = AtomicU64::new(0);

/// Note that the person just did something in Atlas. Cheap: one atomic store.
pub fn touch() {
    LAST_INPUT_MS.store(now_ms(), Ordering::Relaxed);
}

/// Whether `last_input` is recent enough, at `now`, for the time since to count as active use.
pub(crate) fn is_active_at(last_input: u64, now: u64) -> bool {
    last_input != 0 && now >= last_input && now - last_input <= IDLE_AFTER_MS
}

/// Whether a message at `now` starts a new conversation, given when the previous one was sent.
pub(crate) fn starts_conversation(last_message: u64, now: u64) -> bool {
    last_message == 0 || now.saturating_sub(last_message) > CONVERSATION_GAP_MS
}

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
    "files.edited",
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
    /// When the last message was sent, so a conversation carries on across a restart.
    #[serde(default)]
    last_message_ms: u64,
    /// The first day (`YYYY-MM-DD`) recorded with the confirmed/estimated/uncertain split. Days
    /// before it only have the combined totals, and are shown as such rather than guessed at.
    #[serde(default)]
    split_from: String,
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
            store: Store { version: VERSION, created_at: now_ms(), split_from: today_key(), ..Default::default() },
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

/// Brings a loaded store up to the current version. Returns true when it was an older one, so the
/// caller can keep a copy. Nothing in the old data is rewritten: the new counters only exist from
/// `split_from` on.
fn migrate(s: &mut Store, today: &str) -> bool {
    let was_old = s.version < VERSION || s.split_from.is_empty();
    if s.split_from.is_empty() {
        s.split_from = today.to_string();
    }
    s.version = VERSION;
    was_old
}

/// Record one finished model request. What it counts depends on how sure the figures are:
///
///   * Confirmed / Estimated: the request and its tokens. `tokens_in/out` are the lifetime figure
///     (confirmed + estimated); `_est` is the estimated part; `tokens_cached_in` and
///     `tokens_cache_write_in` are parts of `tokens_in`, never added to it.
///   * Uncertain: the request and a failure, and `tokens_unc_in`, which is NOT in `tokens_in` (it
///     counts toward a monthly cap, not the lifetime total).
///   * RequestOnly: the request and a failure, no tokens.
///   * Nothing: it never left the machine, so nothing is recorded.
pub fn record_model(group: &str, provider_id: Option<&str>, counted: crate::usage::Counted, ok: bool) {
    if matches!(counted, crate::usage::Counted::Nothing) {
        return;
    }
    let day = today_key();
    if let Ok(mut l) = live().lock() {
        apply_model(l.store.days.entry(day).or_default(), group, provider_id, counted, ok);
        l.dirty = true;
    }
}

/// The counting rule itself, on one day's metrics, so it can be tested without the global store.
fn apply_model(
    day: &mut BTreeMap<String, u64>,
    group: &str,
    provider_id: Option<&str>,
    counted: crate::usage::Counted,
    ok: bool,
) {
    use crate::usage::Counted;
    let mut put = |suffix: &str, n: u64| {
        if n == 0 {
            return;
        }
        *day.entry(format!("{group}.{suffix}")).or_insert(0) += n;
        if let Some(id) = provider_id {
            *day.entry(format!("cloud:{id}:{suffix}")).or_insert(0) += n;
        }
    };
    if matches!(counted, Counted::Nothing) {
        return;
    }
    put("requests", 1);
    if !ok {
        put("failures", 1);
    }
    match counted {
        Counted::Confirmed(u) => {
            put("tokens_in", u.input_total);
            put("tokens_out", u.output);
            put("tokens_cached_in", u.cached_in);
            put("tokens_cache_write_in", u.cache_write_in);
        }
        Counted::Estimated { input, output } => {
            put("tokens_in", input);
            put("tokens_out", output);
            put("tokens_in_est", input);
            put("tokens_out_est", output);
        }
        Counted::Uncertain { input } => put("tokens_unc_in", input),
        Counted::RequestOnly | Counted::Nothing => {}
    }
}

/// What a person's prompt or a reply costs in tokens when the provider did not say: about four
/// characters each, which is an estimate and is shown as one.
pub fn estimate_tokens(text: &str) -> u64 {
    crate::tokens::estimate(text)
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
    crate::calibration::init(dir.clone());

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
            if migrate(&mut s, &today_key()) {
                // One copy of the v1 file, once, before the first v2 write replaces it.
                let keep = path.with_file_name("stats.v1.bak.json");
                if path.exists() && !keep.exists() {
                    let _ = std::fs::copy(&path, &keep);
                }
            }
            l.store = s;
        } else {
            l.store.split_from = today_key();
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
            let visible = handle
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            // Four ticks a minute: count a minute the window was on screen.
            if minute % 4 == 0 && visible {
                bump("app.minutes_open", 1);
            }
            // Active use: on screen and touched within the last minute. Counted in seconds so a
            // short session is not rounded up to a whole minute.
            if visible && is_active_at(LAST_INPUT_MS.load(Ordering::Relaxed), now_ms()) {
                bump("app.active_seconds", FLUSH_EVERY.as_secs());
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
    /// This provider's estimated cost in US dollars, only when the person entered both prices.
    pub est_cost_usd: Option<f64>,
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
    /// Active minutes over the same buckets as `series`.
    pub active_series: Vec<SeriesPoint>,
    /// Estimated spending for THIS period (see `Spend`).
    pub spend: Spend,
    /// The all-time dashboard figures, the same whichever period is chosen.
    pub lifetime: Lifetime,
    pub streak: Streak,
    /// The last twelve weeks, one cell a day, for the activity calendar.
    pub calendar: Vec<CalendarDay>,
    /// The first day active time was counted (`YYYY-MM-DD`), or empty if it has not been yet.
    pub active_since: String,
}

/// What the cloud usage in a period would cost at the prices the person entered. An ESTIMATE, and
/// only for providers whose prices were entered: the rest are counted as `unpriced`, never guessed.
#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    /// `None` until at least one provider has prices to estimate from.
    pub estimate_usd: Option<f64>,
    pub priced_providers: u64,
    pub unpriced_providers: u64,
    /// Tokens (in + out) that no price covers, so the person can see how much is not in the figure.
    pub unpriced_tokens: u64,
}

#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lifetime {
    pub active_seconds: u64,
    pub messages: u64,
    pub tokens: u64,
    /// Tokens used by models that run on this PC (Ollama, Nova Intelligence). They cost nothing and
    /// are a different thing from cloud tokens, so they are never added into one headline figure.
    pub local_tokens: u64,
    /// How much of `local_tokens` the model SERVER counted itself; the rest is Atlas's estimate.
    pub local_tokens_reported: u64,
    /// Tokens sent to cloud providers, as Atlas counted them (or as the provider reported where it
    /// said). NOT authoritative: the provider's own dashboard and bill are the only real figures.
    pub cloud_tokens: u64,
    /// Of `cloud_tokens`: how much Atlas estimated because the provider did not report it. Only
    /// counted from `cloud_split_from` on; earlier days have one combined number.
    pub cloud_tokens_estimated: u64,
    /// Of `cloud_tokens` from `cloud_split_from` on: how much the provider reported itself.
    pub cloud_tokens_confirmed: u64,
    /// Cloud tokens from days before the split existed: neither confirmed nor estimated is known.
    pub cloud_tokens_unsplit: u64,
    /// Of cloud input: the part served from the provider's cache (already inside `cloud_tokens`).
    pub cloud_tokens_cached: u64,
    /// Input of requests that may have reached the provider and then failed. They may have been
    /// billed, so they count toward a monthly limit, but they are NOT in `cloud_tokens`.
    pub cloud_tokens_uncertain: u64,
    /// The first day (`YYYY-MM-DD`) recorded with the confirmed/estimated split.
    pub cloud_split_from: String,
    pub conversations: u64,
    pub tasks_completed: u64,
    pub files_edited: u64,
    pub spend: Spend,
}

#[derive(Serialize, Debug, PartialEq, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Streak {
    pub current: u64,
    pub longest: u64,
    /// The last day of the longest streak, `YYYY-MM-DD`; empty when there is none.
    pub longest_ended: String,
    pub active_today: bool,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDay {
    pub day: String,
    /// 0 = nothing, 1..=4 = how much, relative to the busiest day shown.
    pub level: u8,
}

fn activity_of(m: &BTreeMap<String, u64>) -> u64 {
    ["chat.messages_sent", "actions.done", "actions.failed", "tasks.completed"]
        .iter()
        .map(|k| m.get(*k).copied().unwrap_or(0))
        .sum()
}

/// A day on which the person actually used Atlas: sent a message, had it act, finished a task, or
/// was active in it. Opening it (`app.launches`) or leaving it on screen does not make a day active.
fn is_active_day(m: &BTreeMap<String, u64>) -> bool {
    activity_of(m) > 0 || m.get("app.active_seconds").copied().unwrap_or(0) > 0
}

/// `(current streak, longest streak, last day of the longest)` over the sorted, de-duplicated day
/// numbers on which something was done. A streak is a run of consecutive such days. The current one
/// is still alive if the last active day was today or yesterday (today is not over yet), and is 0
/// once a whole day has been skipped. Ties for longest go to the most recent run.
pub(crate) fn streaks(active_days: &[i64], today: i64) -> (u64, u64, Option<i64>) {
    let mut longest = 0u64;
    let mut longest_end: Option<i64> = None;
    let mut run = 0u64;
    let mut prev: Option<i64> = None;
    let mut last_run = 0u64;
    for &d in active_days {
        run = match prev {
            Some(p) if d == p + 1 => run + 1,
            Some(p) if d == p => run,
            _ => 1,
        };
        if run >= longest {
            longest = run;
            longest_end = Some(d);
        }
        last_run = run;
        prev = Some(d);
    }
    let current = match prev {
        Some(last) if last == today || last == today - 1 => last_run,
        _ => 0,
    };
    (current, longest, longest_end)
}

/// One provider's cost at the prices the person entered, in US dollars. Prices are thousandths of
/// a dollar per million tokens.
pub(crate) fn cost_usd(tokens_in: u64, tokens_out: u64, price_in_milli: u64, price_out_milli: u64) -> f64 {
    (tokens_in as f64 * price_in_milli as f64 + tokens_out as f64 * price_out_milli as f64) / 1_000.0 / 1_000_000.0
}

/// Per-provider rows from the `cloud:<id>:<metric>` counters, priced where the person gave prices.
fn provider_rows(
    metrics: &BTreeMap<String, u64>,
    label_for: &dyn Fn(&str) -> String,
    price_for: &dyn Fn(&str) -> (Option<u64>, Option<u64>),
) -> Vec<ProviderUsage> {
    let mut ids: BTreeMap<String, ProviderUsage> = BTreeMap::new();
    for (k, v) in metrics {
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
            est_cost_usd: None,
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
    for p in ids.values_mut() {
        if let (Some(pi), Some(po)) = price_for(&p.id) {
            p.est_cost_usd = Some(cost_usd(p.tokens_in, p.tokens_out, pi, po));
        }
    }
    ids.into_values().collect()
}

/// The estimate across providers: priced ones are summed, the rest are counted and left out.
fn spend_of(rows: &[ProviderUsage]) -> Spend {
    let mut s = Spend::default();
    let mut sum = 0.0;
    for p in rows {
        if p.requests == 0 && p.tokens_in == 0 && p.tokens_out == 0 {
            continue;
        }
        match p.est_cost_usd {
            Some(c) => {
                s.priced_providers += 1;
                sum += c;
            }
            None => {
                s.unpriced_providers += 1;
                s.unpriced_tokens += p.tokens_in + p.tokens_out;
            }
        }
    }
    if s.priced_providers > 0 {
        s.estimate_usd = Some(sum);
    }
    s
}

fn sum_metrics(store: &Store, from_day: Option<i64>, to_day: i64) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for (day, row) in &store.days {
        let Some(n) = parse_day(day) else { continue };
        if n > to_day || from_day.is_some_and(|f| n < f) {
            continue;
        }
        for (k, v) in row {
            *out.entry(k.clone()).or_insert(0) += v;
        }
    }
    out
}

#[cfg(test)]
fn summarise(store: &Store, period: &str, today: (i64, i64, i64), label_for: &dyn Fn(&str) -> String) -> Option<Summary> {
    summarise_with(store, period, today, label_for, &|_| (None, None))
}

fn summarise_with(
    store: &Store,
    period: &str,
    today: (i64, i64, i64),
    label_for: &dyn Fn(&str) -> String,
    price_for: &dyn Fn(&str) -> (Option<u64>, Option<u64>),
) -> Option<Summary> {
    let (from_day, to_day, label) = period_range(period, today)?;
    let today_n = days_from_civil(today.0, today.1, today.2);
    let mut metrics: BTreeMap<String, u64> = BTreeMap::new();
    // (day, activity, active seconds)
    let mut per_day: Vec<(String, u64, u64)> = Vec::new();
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
        per_day.push((day.clone(), a, row.get("app.active_seconds").copied().unwrap_or(0)));
    }

    // Per-provider rows from `cloud:<id>:<metric>`; the flat map keeps only named metrics.
    let providers = provider_rows(&metrics, label_for, price_for);
    let spend = spend_of(&providers);
    metrics.retain(|k, _| !k.starts_with("cloud:"));

    let bucket = |value: &dyn Fn(&(String, u64, u64)) -> u64| -> Vec<SeriesPoint> {
        if per_day.len() <= 31 {
            per_day.iter().map(|d| SeriesPoint { label: d.0.clone(), value: value(d) }).collect()
        } else {
            let mut by_month: BTreeMap<String, u64> = BTreeMap::new();
            for d in &per_day {
                *by_month.entry(d.0[..7].to_string()).or_insert(0) += value(d);
            }
            by_month.into_iter().map(|(label, value)| SeriesPoint { label, value }).collect()
        }
    };
    let series = bucket(&|d| d.1);
    // Seconds are summed first and only then turned into whole minutes, so no day is rounded up.
    let mut active_series = bucket(&|d| d.2);
    for p in &mut active_series {
        p.value = p.value.div_ceil(60);
    }

    // ---- all-time figures, whatever period is chosen ----
    let all = sum_metrics(store, None, i64::MAX);
    let all_providers = provider_rows(&all, label_for, price_for);
    let m = |k: &str| all.get(k).copied().unwrap_or(0);
    // Days from the split on are the only ones where confirmed and estimated can be told apart.
    let since_split = match parse_day(&store.split_from) {
        Some(d) => sum_metrics(store, Some(d), i64::MAX),
        None => BTreeMap::new(),
    };
    let lifetime = Lifetime {
        active_seconds: m("app.active_seconds"),
        messages: m("chat.messages_sent"),
        tokens: ["model.local", "model.cloud", "model.nova"]
            .iter()
            .map(|g| m(&format!("{g}.tokens_in")) + m(&format!("{g}.tokens_out")))
            .sum(),
        local_tokens: ["model.local", "model.nova"]
            .iter()
            .map(|g| m(&format!("{g}.tokens_in")) + m(&format!("{g}.tokens_out")))
            .sum(),
        local_tokens_reported: m("model.local.tokens_reported"),
        cloud_tokens: m("model.cloud.tokens_in") + m("model.cloud.tokens_out"),
        cloud_tokens_estimated: m("model.cloud.tokens_in_est") + m("model.cloud.tokens_out_est"),
        cloud_tokens_confirmed: since_split
            .get("model.cloud.tokens_in")
            .copied()
            .unwrap_or(0)
            .saturating_add(since_split.get("model.cloud.tokens_out").copied().unwrap_or(0))
            .saturating_sub(m("model.cloud.tokens_in_est") + m("model.cloud.tokens_out_est")),
        cloud_tokens_unsplit: (m("model.cloud.tokens_in") + m("model.cloud.tokens_out")).saturating_sub(
            since_split.get("model.cloud.tokens_in").copied().unwrap_or(0)
                + since_split.get("model.cloud.tokens_out").copied().unwrap_or(0),
        ),
        cloud_tokens_cached: m("model.cloud.tokens_cached_in"),
        cloud_tokens_uncertain: m("model.cloud.tokens_unc_in"),
        cloud_split_from: store.split_from.clone(),
        conversations: m("chat.conversations"),
        tasks_completed: m("tasks.completed"),
        files_edited: m("files.edited"),
        spend: spend_of(&all_providers),
    };

    let mut active_days: Vec<i64> = store
        .days
        .iter()
        .filter(|(_, row)| is_active_day(row))
        .filter_map(|(d, _)| parse_day(d))
        .collect();
    active_days.sort_unstable();
    active_days.dedup();
    let (current, longest, longest_end) = streaks(&active_days, today_n);
    let streak = Streak {
        current,
        longest,
        longest_ended: longest_end.map(civil_from_days).unwrap_or_default(),
        active_today: active_days.last() == Some(&today_n),
    };

    // The last twelve weeks, one cell a day, shaded relative to the busiest of them.
    let weight = |day: i64| -> u64 {
        store
            .days
            .get(&civil_from_days(day))
            .map(|r| activity_of(r) + r.get("app.active_seconds").copied().unwrap_or(0) / 60)
            .unwrap_or(0)
    };
    let window: Vec<(i64, u64)> = (today_n - 83..=today_n).map(|d| (d, weight(d))).collect();
    let busiest = window.iter().map(|(_, w)| *w).max().unwrap_or(0).max(1);
    let calendar = window
        .into_iter()
        .map(|(d, w)| CalendarDay {
            day: civil_from_days(d),
            level: if w == 0 { 0 } else { 1 + ((w * 3) / busiest).min(3) as u8 },
        })
        .collect();

    let active_since = store
        .days
        .iter()
        .find(|(_, row)| row.get("app.active_seconds").copied().unwrap_or(0) > 0)
        .map(|(d, _)| d.clone())
        .unwrap_or_default();

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
        providers,
        series,
        active_series,
        spend,
        lifetime,
        streak,
        calendar,
        active_since,
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
    summarise_with(
        &l.store,
        &period,
        local_today(),
        &|id| {
            crate::provider_bindings::get(id)
                .map(|p| if p.label.is_empty() { "Cloud provider".to_string() } else { p.label })
                .unwrap_or_else(|| "A provider you removed".to_string())
        },
        &crate::provider_bindings::prices_of,
    )
    .ok_or_else(|| "That isn't a period I know.".to_string())
}

/// Record outcomes only the interface sees. Closed list, small counts, no text.
#[tauri::command]
pub fn stats_record(metric: String, count: Option<u64>) -> Result<(), String> {
    if !PAGE_METRICS.contains(&metric.as_str()) {
        return Err("That isn't something Atlas counts.".into());
    }
    // Anything the page reports is something the person did, so it is also activity.
    touch();
    if metric == "chat.messages_sent" {
        let now = now_ms();
        if let Ok(mut l) = live().lock() {
            if starts_conversation(l.store.last_message_ms, now) {
                *l.store.days.entry(today_key()).or_default().entry("chat.conversations".to_string()).or_insert(0) += 1;
            }
            l.store.last_message_ms = now;
            l.dirty = true;
        }
    }
    bump(&metric, count.unwrap_or(1).min(1000));
    Ok(())
}

/// The person used Atlas just now (a key, a click, a scroll). The page sends this at most every few
/// seconds; it carries nothing but the fact that it happened.
#[tauri::command]
pub fn stats_touch() {
    touch();
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
        l.store = Store { version: VERSION, created_at: now_ms(), split_from: today_key(), ..Default::default() };
        l.dirty = true;
    }
    flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn lifetime_cloud_tokens_split_into_confirmed_estimated_and_unsplit() {
        let mut st = store_with(&[
            // Before the split existed: 1000 tokens, nobody knows how many were estimated.
            ("2026-09-01", "model.cloud.tokens_in", 600),
            ("2026-09-01", "model.cloud.tokens_out", 400),
            // After: 300 in/200 out, of which 100 in and 50 out were estimated; 40 of the input cached.
            ("2026-10-21", "model.cloud.tokens_in", 300),
            ("2026-10-21", "model.cloud.tokens_out", 200),
            ("2026-10-21", "model.cloud.tokens_in_est", 100),
            ("2026-10-21", "model.cloud.tokens_out_est", 50),
            ("2026-10-21", "model.cloud.tokens_cached_in", 40),
            ("2026-10-21", "model.cloud.tokens_unc_in", 70),
        ]);
        st.split_from = "2026-10-20".into();
        let l = summarise(&st, "lifetime", (2026, 10, 22), &|_| "P".to_string()).unwrap().lifetime;
        assert_eq!(l.cloud_tokens, 1500, "lifetime total unchanged: confirmed + estimated");
        assert_eq!(l.cloud_tokens_estimated, 150);
        assert_eq!(l.cloud_tokens_confirmed, 350, "500 since the split minus the 150 estimated");
        assert_eq!(l.cloud_tokens_unsplit, 1000, "days before the split are never guessed at");
        assert_eq!(l.cloud_tokens_cached, 40);
        assert_eq!(l.cloud_tokens_uncertain, 70);
        assert_eq!(l.cloud_tokens_confirmed + l.cloud_tokens_estimated + l.cloud_tokens_unsplit, l.cloud_tokens);
    }

    // ---- 2.0.3: confirmed / estimated / uncertain ----------------------------------------

    fn applied(counted: crate::usage::Counted, ok: bool) -> BTreeMap<String, u64> {
        let mut day = BTreeMap::new();
        apply_model(&mut day, "model.cloud", Some("p"), counted, ok);
        day
    }
    fn g(m: &BTreeMap<String, u64>, k: &str) -> u64 {
        m.get(k).copied().unwrap_or(0)
    }

    #[test]
    fn a_request_that_never_left_the_machine_leaves_every_counter_untouched() {
        assert!(applied(crate::usage::Counted::Nothing, false).is_empty());
    }

    #[test]
    fn a_failure_is_not_charged_an_invented_token_count() {
        let m = applied(crate::usage::Counted::RequestOnly, false);
        assert_eq!((g(&m, "model.cloud.requests"), g(&m, "model.cloud.failures")), (1, 1));
        assert_eq!(g(&m, "model.cloud.tokens_in"), 0);
        assert_eq!(g(&m, "model.cloud.tokens_unc_in"), 0);
    }

    #[test]
    fn uncertain_tokens_are_kept_out_of_the_lifetime_total_but_are_recorded() {
        let m = applied(crate::usage::Counted::Uncertain { input: 400 }, false);
        assert_eq!(g(&m, "model.cloud.tokens_unc_in"), 400);
        assert_eq!(g(&m, "cloud:p:tokens_unc_in"), 400);
        assert_eq!(g(&m, "model.cloud.tokens_in"), 0, "uncertain is NOT in the lifetime total");
    }

    #[test]
    fn estimated_tokens_are_in_the_total_and_marked_as_the_estimated_part() {
        let m = applied(crate::usage::Counted::Estimated { input: 100, output: 40 }, true);
        assert_eq!((g(&m, "model.cloud.tokens_in"), g(&m, "model.cloud.tokens_out")), (100, 40));
        assert_eq!((g(&m, "model.cloud.tokens_in_est"), g(&m, "model.cloud.tokens_out_est")), (100, 40));
    }

    #[test]
    fn confirmed_tokens_are_not_marked_estimated_and_cached_is_a_part_not_an_addition() {
        let u = crate::usage::Usage { input_total: 1000, cached_in: 800, cache_write_in: 50, output: 20, reasoning: None };
        let m = applied(crate::usage::Counted::Confirmed(u), true);
        assert_eq!(g(&m, "model.cloud.tokens_in"), 1000, "cached is inside the input, not on top of it");
        assert_eq!(g(&m, "model.cloud.tokens_cached_in"), 800);
        assert_eq!(g(&m, "model.cloud.tokens_cache_write_in"), 50);
        assert_eq!(g(&m, "model.cloud.tokens_in_est"), 0);
    }

    #[test]
    fn local_requests_have_no_provider_keys() {
        let mut day = BTreeMap::new();
        apply_model(&mut day, "model.local", None, crate::usage::Counted::Estimated { input: 4, output: 4 }, true);
        assert!(day.keys().all(|k| k.starts_with("model.local.")));
    }

    #[test]
    fn a_v1_store_is_migrated_without_rewriting_its_data() {
        let mut s = Store { version: 1, created_at: 5, ..Default::default() };
        s.days.entry("2026-09-01".into()).or_default().insert("model.cloud.tokens_in".into(), 123);
        assert!(migrate(&mut s, "2026-10-21"), "reports that it was an older file");
        assert_eq!((s.version, s.split_from.as_str()), (2, "2026-10-21"));
        assert_eq!(s.days["2026-09-01"]["model.cloud.tokens_in"], 123, "old days are untouched");
        // Running it again changes nothing and does not ask for another backup.
        assert!(!migrate(&mut s, "2026-12-31"));
        assert_eq!(s.split_from, "2026-10-21");
    }

    #[test]
    fn a_v2_file_still_loads_as_a_v1_reader_would() {
        // An older build's Store has no split_from; unknown keys are ignored, nothing breaks.
        #[derive(serde::Deserialize)]
        struct V1 {
            #[serde(default)]
            version: u32,
            #[serde(default)]
            days: BTreeMap<String, BTreeMap<String, u64>>,
        }
        let mut s = Store { version: 2, split_from: "2026-10-21".into(), ..Default::default() };
        s.days.entry("2026-10-21".into()).or_default().insert("model.cloud.tokens_unc_in".into(), 9);
        let back: V1 = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!((back.version, back.days.len()), (2, 1));
    }

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

/// The 2.0 dashboard: active time, streaks, conversations and the spending estimate.
#[cfg(test)]
mod dashboard_tests {
    use super::*;

    fn d(y: i64, m: i64, day: i64) -> i64 {
        days_from_civil(y, m, day)
    }

    fn store_with(rows: &[(&str, &str, u64)]) -> Store {
        let mut s = Store { version: VERSION, created_at: 1_700_000_000_000, ..Default::default() };
        for (day, metric, n) in rows {
            s.days.entry((*day).to_string()).or_default().insert((*metric).to_string(), *n);
        }
        s
    }

    fn summary(s: &Store, period: &str, today: (i64, i64, i64)) -> Summary {
        summarise_with(s, period, today, &|_| "P".to_string(), &|id| match id {
            "priced" => (Some(2_500), Some(10_000)), // $2.50 in, $10 out per million tokens
            _ => (None, None),
        })
        .unwrap()
    }

    #[test]
    fn active_use_needs_recent_input_not_just_an_open_window() {
        let now = 10_000_000;
        assert!(!is_active_at(0, now), "no input since launch is not active");
        assert!(is_active_at(now - 1_000, now));
        assert!(is_active_at(now - IDLE_AFTER_MS, now), "exactly at the limit still counts");
        assert!(!is_active_at(now - IDLE_AFTER_MS - 1, now), "a minute of silence stops the clock");
        assert!(!is_active_at(now + 5, now), "a clock that went backwards is not activity");
    }

    #[test]
    fn a_long_silence_starts_a_new_conversation() {
        let t = 1_000_000_000;
        assert!(starts_conversation(0, t), "the first message ever");
        assert!(!starts_conversation(t, t + 60_000), "a minute later is the same conversation");
        assert!(!starts_conversation(t, t + CONVERSATION_GAP_MS), "exactly at the gap is still the same");
        assert!(starts_conversation(t, t + CONVERSATION_GAP_MS + 1), "past it is a new one");
        assert!(!starts_conversation(t + 10, t), "an earlier clock reading never starts one");
    }

    #[test]
    fn streaks_are_runs_of_consecutive_active_days() {
        let t = d(2026, 10, 18);
        // Nothing yet.
        assert_eq!(streaks(&[], t), (0, 0, None));
        // Today only.
        assert_eq!(streaks(&[t], t), (1, 1, Some(t)));
        // Yesterday and the day before, nothing yet today: the streak is still alive.
        assert_eq!(streaks(&[t - 2, t - 1], t), (2, 2, Some(t - 1)));
        // Last active two days ago: it has been broken.
        assert_eq!(streaks(&[t - 3, t - 2], t), (0, 2, Some(t - 2)));
        // An older, longer run is the longest; the current one is the short recent run.
        let days = [t - 20, t - 19, t - 18, t - 17, t - 1, t];
        assert_eq!(streaks(&days, t), (2, 4, Some(t - 17)));
        // Ties go to the most recent run.
        assert_eq!(streaks(&[t - 10, t - 9, t - 1, t], t), (2, 2, Some(t)));
        // The same day twice is one day.
        assert_eq!(streaks(&[t - 1, t - 1, t], t), (2, 2, Some(t)));
    }

    #[test]
    fn only_real_use_makes_a_day_count_for_a_streak() {
        let s = store_with(&[
            ("2026-10-16", "app.launches", 3),        // opened it, did nothing
            ("2026-10-16", "app.minutes_open", 40),   // left it on screen
            ("2026-10-17", "chat.messages_sent", 1),  // used it
            ("2026-10-18", "app.active_seconds", 45), // active, no message
        ]);
        let sm = summary(&s, "lifetime", (2026, 10, 18));
        assert_eq!(sm.streak.current, 2, "the 16th (open but unused) does not count");
        assert_eq!(sm.streak.longest, 2);
        assert!(sm.streak.active_today);
        assert_eq!(sm.streak.longest_ended, "2026-10-18");
    }

    #[test]
    fn lifetime_totals_ignore_the_chosen_period() {
        let s = store_with(&[
            ("2026-01-05", "chat.messages_sent", 10),
            ("2026-01-05", "chat.conversations", 2),
            ("2026-10-18", "chat.messages_sent", 5),
            ("2026-10-18", "chat.conversations", 1),
            ("2026-10-18", "tasks.completed", 3),
            ("2026-10-18", "files.edited", 4),
            ("2026-01-05", "model.local.tokens_in", 100),
            ("2026-10-18", "model.cloud.tokens_out", 40),
            ("2026-10-18", "model.nova.tokens_in", 7),
            ("2026-10-18", "app.active_seconds", 90),
        ]);
        for period in ["today", "last7", "lifetime", "lastyear"] {
            let l = summary(&s, period, (2026, 10, 18)).lifetime;
            assert_eq!(l.messages, 15, "{period}");
            assert_eq!(l.conversations, 3, "{period}");
            assert_eq!(l.tasks_completed, 3, "{period}");
            assert_eq!(l.files_edited, 4, "{period}");
            assert_eq!(l.tokens, 147, "{period}");
            assert_eq!(l.active_seconds, 90, "{period}");
        }
        // ...while the period's own metrics still follow the period.
        assert_eq!(summary(&s, "today", (2026, 10, 18)).metrics.get("chat.messages_sent"), Some(&5));
    }

    #[test]
    fn spending_is_only_estimated_where_a_price_was_entered() {
        let s = store_with(&[
            ("2026-10-18", "cloud:priced:requests", 4),
            ("2026-10-18", "cloud:priced:tokens_in", 2_000_000),
            ("2026-10-18", "cloud:priced:tokens_out", 500_000),
            ("2026-10-18", "cloud:unpriced:requests", 2),
            ("2026-10-18", "cloud:unpriced:tokens_in", 1_000),
            ("2026-10-18", "cloud:unpriced:tokens_out", 234),
        ]);
        let sp = summary(&s, "today", (2026, 10, 18)).spend;
        // 2M x $2.50 + 0.5M x $10.00 = $5.00 + $5.00
        assert!((sp.estimate_usd.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(sp.priced_providers, 1);
        assert_eq!(sp.unpriced_providers, 1);
        assert_eq!(sp.unpriced_tokens, 1_234, "what the figure does not cover is said, not guessed");
    }

    #[test]
    fn no_prices_means_no_estimate_rather_than_zero_dollars() {
        let s = store_with(&[("2026-10-18", "cloud:unpriced:requests", 1), ("2026-10-18", "cloud:unpriced:tokens_in", 50)]);
        let sp = summary(&s, "lifetime", (2026, 10, 18)).spend;
        assert_eq!(sp.estimate_usd, None);
        assert_eq!(sp.unpriced_providers, 1);
        // And nothing at all is not a spend of $0 either.
        let none = summary(&store_with(&[("2026-10-18", "chat.messages_sent", 1)]), "lifetime", (2026, 10, 18)).spend;
        assert_eq!(none, Spend::default());
    }

    #[test]
    fn the_cost_arithmetic_is_exact() {
        assert_eq!(cost_usd(1_000_000, 0, 1_000, 0), 1.0, "$1 per million tokens in");
        assert!((cost_usd(0, 1_000, 0, 15_000) - 0.015).abs() < 1e-12, "1k tokens out at $15/M");
        assert_eq!(cost_usd(0, 0, 5_000, 5_000), 0.0);
    }

    #[test]
    fn active_time_is_summed_in_seconds_then_shown_in_whole_minutes() {
        let s = store_with(&[
            ("2026-10-17", "app.active_seconds", 30),
            ("2026-10-18", "app.active_seconds", 90),
        ]);
        let sm = summary(&s, "last7", (2026, 10, 18));
        let minutes: Vec<u64> = sm.active_series.iter().map(|p| p.value).collect();
        assert_eq!(minutes, vec![1, 2], "30 s shows as 1 min, 90 s as 2 min; nothing is invented between");
        assert_eq!(sm.active_since, "2026-10-17");
        assert_eq!(sm.lifetime.active_seconds, 120);
    }

    #[test]
    fn active_time_has_no_start_date_until_some_was_counted() {
        let s = store_with(&[("2026-10-18", "chat.messages_sent", 1)]);
        assert_eq!(summary(&s, "lifetime", (2026, 10, 18)).active_since, "");
    }

    #[test]
    fn the_calendar_is_twelve_weeks_ending_today_and_shaded_relative() {
        let s = store_with(&[
            ("2026-10-18", "chat.messages_sent", 40),
            ("2026-10-17", "chat.messages_sent", 10),
            ("2026-09-01", "chat.messages_sent", 1),
        ]);
        let c = summary(&s, "lifetime", (2026, 10, 18)).calendar;
        assert_eq!(c.len(), 84);
        assert_eq!(c.last().unwrap().day, "2026-10-18");
        assert_eq!(c.last().unwrap().level, 4, "the busiest day is the darkest");
        let get = |day: &str| c.iter().find(|x| x.day == day).unwrap().level;
        assert!(get("2026-10-17") > 0 && get("2026-10-17") < 4);
        assert_eq!(get("2026-10-10"), 0, "a quiet day is empty, not invented");
        assert!(c.iter().all(|x| x.level <= 4));
    }

    #[test]
    fn an_empty_store_gives_an_honest_empty_dashboard() {
        let sm = summary(&Store { version: VERSION, ..Default::default() }, "lifetime", (2026, 10, 18));
        assert_eq!(sm.lifetime, Lifetime::default());
        assert_eq!(sm.streak, Streak::default());
        assert_eq!(sm.spend, Spend::default());
        assert!(sm.calendar.iter().all(|c| c.level == 0));
        assert_eq!(sm.active_since, "");
    }

    #[test]
    fn the_page_may_report_files_edited_and_nothing_it_invents() {
        assert!(PAGE_METRICS.contains(&"files.edited"));
        assert!(!PAGE_METRICS.contains(&"app.active_seconds"), "active time is measured natively, never reported");
        assert!(!PAGE_METRICS.contains(&"chat.conversations"), "conversations are derived natively, never reported");
    }
}

/// Tokens on this PC and tokens at a provider are different things and are never one number.
#[cfg(test)]
mod token_split_tests {
    use super::*;

    fn store_with(rows: &[(&str, &str, u64)]) -> Store {
        let mut s = Store { version: VERSION, created_at: 1_700_000_000_000, ..Default::default() };
        for (day, metric, n) in rows {
            s.days.entry((*day).to_string()).or_default().insert((*metric).to_string(), *n);
        }
        s
    }

    #[test]
    fn local_and_cloud_tokens_are_kept_apart_and_nova_counts_as_local() {
        let s = store_with(&[
            ("2026-10-18", "model.local.tokens_in", 1_000),
            ("2026-10-18", "model.local.tokens_out", 4_000),
            ("2026-10-18", "model.local.tokens_reported", 3_000),
            ("2026-10-18", "model.nova.tokens_in", 50),
            ("2026-10-18", "model.cloud.tokens_in", 200),
            ("2026-10-18", "model.cloud.tokens_out", 100),
        ]);
        let l = summarise(&s, "today", (2026, 10, 18), &|_| String::new()).unwrap().lifetime;
        assert_eq!(l.local_tokens, 5_050, "Ollama + Nova Intelligence both run on this PC");
        assert_eq!(l.local_tokens_reported, 3_000, "how much the model server counted itself");
        assert_eq!(l.cloud_tokens, 300);
        assert_eq!(l.tokens, l.local_tokens + l.cloud_tokens, "the combined figure still adds up");
    }

    #[test]
    fn local_use_never_enters_the_spending_estimate() {
        let s = store_with(&[("2026-10-18", "model.local.tokens_in", 9_000_000), ("2026-10-18", "model.local.tokens_out", 9_000_000)]);
        let sm = summarise(&s, "lifetime", (2026, 10, 18), &|_| String::new()).unwrap();
        assert_eq!(sm.lifetime.spend, Spend::default());
        assert_eq!(sm.lifetime.cloud_tokens, 0);
    }

    #[test]
    fn nothing_used_is_zero_everywhere() {
        let sm = summarise(&Store { version: VERSION, ..Default::default() }, "lifetime", (2026, 10, 18), &|_| String::new()).unwrap();
        assert_eq!((sm.lifetime.local_tokens, sm.lifetime.local_tokens_reported, sm.lifetime.cloud_tokens), (0, 0, 0));
    }
}
