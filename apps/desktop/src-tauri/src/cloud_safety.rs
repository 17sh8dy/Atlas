//! Cloud safety: Atlas's own protections around a paid provider.
//!
//! A provider's own limits are not enough. They differ in kind (a hard cap that stops requests, a
//! soft budget that only warns, a prepaid balance), they can be enforced late, and a runaway loop
//! can spend a lot before any of them speak. So Atlas keeps its own guard, natively, in front of
//! every request:
//!
//! 1. **A provider that says it is out of money is paused.** The response is recognised (HTTP 402,
//!    or the provider's own words: `insufficient_quota`, `billing_hard_limit_reached`, "credit
//!    balance is too low", a spending cap…), the provider is marked paused, and every later request
//!    to it is refused *without being sent* until the person resumes it. A plain rate limit is not
//!    mistaken for this: it is reported as one and nothing is paused.
//! 2. **Caps the person sets, enforced by Atlas.** A monthly request cap and/or a monthly token cap
//!    per provider, counted against the same totals the Stats page shows (`stats.rs`). Provider-
//!    reported token usage is used when present; otherwise it is an estimate (about four
//!    characters a token) and is labelled as one.
//! 3. **A runaway guard.** More than `BURST_PER_MINUTE` requests to one provider in a minute is a
//!    loop, not a conversation: the provider is paused for `BURST_COOLDOWN` and the person is told.
//! 4. **Never another provider.** Nothing in this module, or anything that uses it, picks a
//!    different provider. A paused or capped provider produces a message; spending money somewhere
//!    else is always the person's decision.
//!
//! Resuming a paused provider, or loosening or removing a cap, is a native question
//! (`consent.rs`): both make spending possible again.
//!
//! The refusals are tagged strings the interface turns into plain wording:
//! `limit-reached:provider`, `limit-reached:atlas-requests:<cap>`,
//! `limit-reached:atlas-tokens:<cap>`, `limit-reached:burst:<n>`, and `rate-limited:<message>`.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const BURST_PER_MINUTE: usize = 30;
pub const BURST_COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Paused {
    /// `provider-limit` — the provider said so. (Caps and bursts are computed, not stored.)
    pub reason: String,
    /// Milliseconds since the epoch.
    pub at: u64,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ResponseClass {
    /// Out of money, quota or credit: stops until the person acts.
    SpendLimit,
    /// Too many requests for now: transient.
    RateLimited,
}

/// What a failed response means. Pure, so each provider's wording can be pinned by a test.
pub fn classify(status: u16, body: &str) -> Option<ResponseClass> {
    let b = body.to_ascii_lowercase();
    const SPEND: &[&str] = &[
        "insufficient_quota",
        "billing_hard_limit_reached",
        "billing_not_active",
        "exceeded your current quota",
        "credit balance is too low",
        "credit_balance_too_low",
        "insufficient_balance",
        "insufficient balance",
        "insufficient credits",
        "out of credits",
        "spending limit",
        "spend limit",
        "monthly spend",
        "usage limit has been reached",
        "api usage limits",
        "reached your specified",
        "plans & billing",
        "plans and billing",
        "payment required",
        "account is not active",
        "quota exceeded for quota metric",
    ];
    if status == 402 {
        return Some(ResponseClass::SpendLimit);
    }
    if matches!(status, 400 | 403 | 429) && SPEND.iter().any(|p| b.contains(p)) {
        return Some(ResponseClass::SpendLimit);
    }
    // Gemini reports both a per-minute rate and a daily/billing quota as RESOURCE_EXHAUSTED.
    if status == 429
        && b.contains("resource_exhausted")
        && (b.contains("billing") || b.contains("per day") || b.contains("daily") || b.contains("free tier"))
    {
        return Some(ResponseClass::SpendLimit);
    }
    if status == 429 {
        return Some(ResponseClass::RateLimited);
    }
    None
}

/// The error string a failed provider call carries to the interface.
pub fn tag_failure(status: u16, body: &str, message: String) -> String {
    match classify(status, body) {
        Some(ResponseClass::SpendLimit) => "limit-reached:provider".to_string(),
        Some(ResponseClass::RateLimited) => format!("rate-limited:{message}"),
        None => message,
    }
}

/// The `(input, output)` a provider reported in a success body, if it did. Kept as a thin wrapper
/// over `usage::parse` for one release; new code uses `usage::parse` and keeps the cache split.
pub fn usage_in(body: &str) -> Option<(u64, u64)> {
    crate::usage::parse(body).map(|u| (u.input_total, u.output))
}

// ---- the runaway guard --------------------------------------------------------------------

#[derive(Default)]
pub struct Burst {
    recent: VecDeque<Instant>,
    cooling_until: Option<Instant>,
}

impl Burst {
    /// Record a request about to be made. `Err(n)` when it must be refused.
    pub fn admit(&mut self, now: Instant, per_minute: usize, cooldown: Duration) -> Result<(), usize> {
        if let Some(until) = self.cooling_until {
            if until > now {
                return Err(per_minute);
            }
            self.cooling_until = None;
            self.recent.clear();
        }
        while let Some(&f) = self.recent.front() {
            if now.duration_since(f) > Duration::from_secs(60) {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.recent.len() >= per_minute {
            self.cooling_until = Some(now + cooldown);
            return Err(per_minute);
        }
        self.recent.push_back(now);
        Ok(())
    }
}

fn bursts() -> &'static Mutex<BTreeMap<String, Burst>> {
    static B: OnceLock<Mutex<BTreeMap<String, Burst>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(BTreeMap::new()))
}

// ---- the decision ---------------------------------------------------------------------------

/// Everything `before_request` needs to know, so the rule can be tested without a store.
pub struct Standing {
    pub paused: bool,
    pub cap_requests: Option<u64>,
    pub cap_tokens: Option<u64>,
    pub month_requests: u64,
    pub month_tokens: u64,
}

pub fn judge(s: &Standing) -> Result<(), String> {
    if s.paused {
        return Err("limit-reached:provider".into());
    }
    if let Some(cap) = s.cap_requests {
        if s.month_requests >= cap {
            return Err(format!("limit-reached:atlas-requests:{cap}"));
        }
    }
    if let Some(cap) = s.cap_tokens {
        if s.month_tokens >= cap {
            return Err(format!("limit-reached:atlas-tokens:{cap}"));
        }
    }
    Ok(())
}

/// What counts against a monthly token cap: confirmed + estimated, and also the "uncertain"
/// input of requests that may have reached the provider, because a cap protects money and those
/// may have cost some. Cached input is already inside `tokens_in`, so it is not added again.
pub fn month_tokens_of(id: &str) -> u64 {
    crate::stats::month_total(&format!("cloud:{id}:tokens_in"))
        + crate::stats::month_total(&format!("cloud:{id}:tokens_out"))
        + crate::stats::month_total(&format!("cloud:{id}:tokens_unc_in"))
}

pub fn standing_of(id: &str) -> Option<Standing> {
    let p = crate::provider_bindings::get(id)?;
    Some(Standing {
        paused: p.paused.is_some(),
        cap_requests: p.cap_requests,
        cap_tokens: p.cap_tokens,
        month_requests: crate::stats::month_total(&format!("cloud:{id}:requests")),
        month_tokens: month_tokens_of(id),
    })
}

/// Called before every request to a provider. `Err` is a tagged refusal; nothing was sent.
pub fn before_request(provider_id: &str) -> Result<(), String> {
    if let Some(s) = standing_of(provider_id) {
        judge(&s)?;
    }
    let mut map = bursts().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(provider_id.to_string())
        .or_default()
        .admit(Instant::now(), BURST_PER_MINUTE, BURST_COOLDOWN)
        .map_err(|n| format!("limit-reached:burst:{n}"))
}

/// Called after a failed request: a spending limit pauses the provider.
pub fn after_failure(provider_id: &str, error: &str) {
    if error.starts_with("limit-reached:provider") {
        crate::stats::bump(&format!("cloud:{provider_id}:limit_hits"), 1);
        crate::stats::bump("model.cloud.limit_hits", 1);
        crate::provider_bindings::mark_paused(provider_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_provider_s_own_words_for_out_of_money_are_recognised() {
        let cases: &[(u16, &str)] = &[
            (429, r#"{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}"#),
            (400, r#"{"error":{"message":"Billing hard limit has been reached","type":"billing_hard_limit_reached"}}"#),
            (400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}"#),
            (403, r#"{"error":{"message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}"#),
            (402, r#"{"error":{"message":"Insufficient Balance"}}"#),
            (429, r#"{"error":{"code":429,"message":"You exceeded your current quota. Please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}"#),
            (429, r#"{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for quota metric 'Generate Content API requests per day' and limit 'free tier'"}}"#),
        ];
        for (status, body) in cases {
            assert_eq!(classify(*status, body), Some(ResponseClass::SpendLimit), "{status} {body}");
        }
    }

    #[test]
    fn a_plain_rate_limit_is_not_a_spending_limit() {
        let o = r#"{"error":{"message":"Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 3, Used 3, Requested 1.","type":"requests","code":"rate_limit_exceeded"}}"#;
        assert_eq!(classify(429, o), Some(ResponseClass::RateLimited));
        assert_eq!(classify(429, ""), Some(ResponseClass::RateLimited));
        let a = r#"{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#;
        assert_eq!(classify(429, a), Some(ResponseClass::RateLimited));
        let g = r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Resource has been exhausted (e.g. check quota)."}}"#;
        assert_eq!(classify(429, g), Some(ResponseClass::RateLimited), "a per-minute gemini limit");
    }

    #[test]
    fn other_failures_are_left_alone() {
        assert_eq!(classify(401, r#"{"error":{"message":"Incorrect API key"}}"#), None);
        assert_eq!(classify(404, "model not found"), None);
        assert_eq!(classify(500, "oops"), None);
        assert_eq!(classify(403, "forbidden"), None);
    }

    #[test]
    fn failures_are_tagged_for_the_interface() {
        assert_eq!(tag_failure(402, "", "x".into()), "limit-reached:provider");
        assert!(tag_failure(429, "", "Rate limited".into()).starts_with("rate-limited:"));
        assert_eq!(tag_failure(401, "", "That API key was rejected.".into()), "That API key was rejected.");
    }

    #[test]
    fn usage_is_read_from_all_three_wire_formats() {
        assert_eq!(usage_in(r#"{"usage":{"prompt_tokens":12,"completion_tokens":34}}"#), Some((12, 34)));
        assert_eq!(usage_in(r#"{"usage":{"input_tokens":5,"output_tokens":6}}"#), Some((5, 6)));
        assert_eq!(usage_in(r#"{"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":8}}"#), Some((7, 8)));
        assert_eq!(usage_in(r#"{"choices":[]}"#), None);
        assert_eq!(usage_in("not json"), None);
    }

    fn standing(paused: bool, cr: Option<u64>, ct: Option<u64>, mr: u64, mt: u64) -> Standing {
        Standing { paused, cap_requests: cr, cap_tokens: ct, month_requests: mr, month_tokens: mt }
    }

    #[test]
    fn a_paused_provider_is_refused_before_anything_is_sent() {
        assert_eq!(judge(&standing(true, None, None, 0, 0)).unwrap_err(), "limit-reached:provider");
    }

    #[test]
    fn caps_are_enforced_against_the_months_totals() {
        assert!(judge(&standing(false, Some(100), Some(50_000), 99, 49_999)).is_ok());
        assert_eq!(judge(&standing(false, Some(100), None, 100, 0)).unwrap_err(), "limit-reached:atlas-requests:100");
        assert_eq!(judge(&standing(false, None, Some(50_000), 0, 50_000)).unwrap_err(), "limit-reached:atlas-tokens:50000");
        assert!(judge(&standing(false, None, None, 1_000_000, 1_000_000_000)).is_ok(), "no cap, no limit");
    }

    #[test]
    fn a_runaway_loop_is_stopped_and_then_allowed_again() {
        let mut b = Burst::default();
        let t0 = Instant::now();
        for i in 0..30 {
            assert!(b.admit(t0 + Duration::from_millis(i * 10), 30, Duration::from_secs(300)).is_ok());
        }
        assert!(b.admit(t0 + Duration::from_secs(1), 30, Duration::from_secs(300)).is_err(), "the 31st in a minute");
        assert!(b.admit(t0 + Duration::from_secs(200), 30, Duration::from_secs(300)).is_err(), "still cooling");
        assert!(b.admit(t0 + Duration::from_secs(302), 30, Duration::from_secs(300)).is_ok(), "and then it ends");
    }

    #[test]
    fn a_normal_pace_never_trips_the_guard() {
        let mut b = Burst::default();
        let t0 = Instant::now();
        for i in 0..200 {
            // One request every five seconds, all afternoon.
            assert!(b.admit(t0 + Duration::from_secs(i * 5), 30, Duration::from_secs(300)).is_ok());
        }
    }
}
