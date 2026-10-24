//! What a model request cost, in tokens, and how sure we are.
//!
//! Three kinds of number, kept apart (docs/PLAN-2.0.3.md §A1):
//!
//!   * **Confirmed**: the provider or model server said so.
//!   * **Estimated**: the request succeeded but nothing was reported, so Atlas estimated.
//!   * **Uncertain**: the request may have reached the provider and then failed or was cut off, so
//!     it may have been billed. Counts toward a monthly cap, never toward the lifetime total.
//!
//! This module is pure: no store, no network. `stats.rs` records what it decides.

use serde_json::Value;

/// What one provider response reported, normalised so providers can be added up.
///
/// `cached_in` and `cache_write_in` are *parts of* `input_total`; they are never added to it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    /// Everything billed as input, cached tokens included.
    pub input_total: u64,
    /// The part of `input_total` read from the provider's cache.
    pub cached_in: u64,
    /// The part of `input_total` written to the provider's cache (only some providers say).
    pub cache_write_in: u64,
    /// Everything billed as output. Includes reasoning tokens where the provider bills them as output.
    pub output: u64,
    /// Reasoning tokens, when reported. Informational: already inside `output`.
    pub reasoning: Option<u64>,
}

fn n(v: Option<&Value>) -> Option<u64> {
    v.and_then(|v| v.as_u64())
}

/// Reads the usage a provider put in a success body, whatever its shape.
///
/// The shapes differ in what "input" means, and getting that wrong silently under- or over-counts:
///
///   * OpenAI-compatible: `prompt_tokens` already includes cached tokens (cached is a subset).
///   * Anthropic: `input_tokens` EXCLUDES cache reads and cache writes. The three are additive on
///     the wire, so they are summed here.
///   * Gemini: `promptTokenCount` includes cached content (a subset). Thinking tokens are billed
///     as output but reported beside `candidatesTokenCount`, not inside it.
pub fn parse(body: &str) -> Option<Usage> {
    let v: Value = serde_json::from_str(body).ok()?;
    from_value(&v)
}

pub fn from_value(v: &Value) -> Option<Usage> {
    if let Some(u) = v.get("usage") {
        // OpenAI-compatible.
        let (i, o) = (n(u.get("prompt_tokens")), n(u.get("completion_tokens")));
        if i.is_some() || o.is_some() {
            let input_total = i.unwrap_or(0);
            let cached = n(u.get("prompt_tokens_details").and_then(|d| d.get("cached_tokens")))
                // Compatible servers that put it elsewhere: Kimi (top level), DeepSeek (hit count).
                .or_else(|| n(u.get("cached_tokens")))
                .or_else(|| n(u.get("prompt_cache_hit_tokens")))
                .unwrap_or(0);
            let reasoning = n(u.get("completion_tokens_details").and_then(|d| d.get("reasoning_tokens")));
            return Some(Usage {
                input_total,
                cached_in: cached.min(input_total),
                cache_write_in: 0,
                output: o.unwrap_or(0),
                reasoning,
            });
        }
        // Anthropic.
        let (i, o) = (n(u.get("input_tokens")), n(u.get("output_tokens")));
        if i.is_some() || o.is_some() {
            let read = n(u.get("cache_read_input_tokens")).unwrap_or(0);
            let write = n(u.get("cache_creation_input_tokens")).unwrap_or(0);
            return Some(Usage {
                input_total: i.unwrap_or(0).saturating_add(read).saturating_add(write),
                cached_in: read,
                cache_write_in: write,
                output: o.unwrap_or(0),
                reasoning: None,
            });
        }
    }
    // Gemini.
    if let Some(u) = v.get("usageMetadata") {
        let (p, c) = (n(u.get("promptTokenCount")), n(u.get("candidatesTokenCount")));
        if p.is_some() || c.is_some() {
            // Tokens the model spent on tool-use prompts are billed as input.
            let tool = n(u.get("toolUsePromptTokenCount")).unwrap_or(0);
            let input_total = p.unwrap_or(0).saturating_add(tool);
            let cand = c.unwrap_or(0);
            let thoughts = n(u.get("thoughtsTokenCount"));
            // Documented: thoughts are reported separately from candidates and billed as output.
            // Guard against a response where they are already inside `candidatesTokenCount`: when
            // the provider gives a total, add thoughts only if the total says they are separate.
            let add_thoughts = match (thoughts, n(u.get("totalTokenCount"))) {
                (Some(t), Some(total)) => total >= input_total.saturating_add(cand).saturating_add(t),
                (Some(_), None) => true,
                (None, _) => false,
            };
            let output = cand.saturating_add(if add_thoughts { thoughts.unwrap_or(0) } else { 0 });
            let cached = n(u.get("cachedContentTokenCount")).unwrap_or(0);
            return Some(Usage {
                input_total,
                cached_in: cached.min(input_total),
                cache_write_in: 0,
                output,
                reasoning: thoughts,
            });
        }
    }
    None
}

// ---- did the request leave the machine? ---------------------------------------------------

/// How far a failed request got, which decides what (if anything) it is counted as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transmission {
    /// Failed before any request body went out (no key, bad URL, DNS, refused, TLS). Costs nothing.
    NotSent,
    /// The provider answered with a client error before processing. The request counts; tokens don't.
    Rejected,
    /// The provider may have processed it: a timeout after sending, a reset mid-response, a 5xx, an
    /// unreadable body, or the person halting a request in flight. It may have been billed.
    MaybeSent,
}

/// A failure by HTTP status. 4xx means the provider turned the request away; 408 (it gave up
/// waiting for us) and everything 5xx are not that.
pub fn classify_status(status: u16) -> Transmission {
    match status {
        408 => Transmission::MaybeSent,
        400..=499 => Transmission::Rejected,
        _ => Transmission::MaybeSent,
    }
}

/// A failure to complete the HTTP exchange at all. Ambiguous errors default to `MaybeSent`, which
/// is the cap-safe side: better to count a request that was free than to miss one that was billed.
pub fn classify_transport(e: &reqwest::Error) -> Transmission {
    // A connect error (DNS, refused, TLS handshake, connect timeout) never reached the provider,
    // and so does a request that could not even be built.
    if e.is_connect() || e.is_builder() {
        return Transmission::NotSent;
    }
    // Anything else (a read timeout, a reset mid-response, a body error) happened after the
    // request went out.
    Transmission::MaybeSent
}

// ---- what to record -----------------------------------------------------------------------

/// What a finished request is counted as. Built by the caller, recorded by `stats::record_model`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counted {
    /// Provider-reported figures.
    Confirmed(Usage),
    /// Succeeded with nothing reported: Atlas's own estimate.
    Estimated { input: u64, output: u64 },
    /// May have been billed; input estimate only (the output is unknowable).
    Uncertain { input: u64 },
    /// The request counts, its tokens do not (the provider turned it away).
    RequestOnly,
    /// It never left the machine: nothing is recorded at all.
    Nothing,
}

/// A successful request: the provider's figures when it gave them, otherwise an estimate.
pub fn for_success(reported: Option<Usage>, est_in: u64, est_out: u64) -> Counted {
    match reported {
        Some(u) => Counted::Confirmed(u),
        None => Counted::Estimated { input: est_in, output: est_out },
    }
}

/// A failed request. If the failure still carried a usage block, the provider counted it, so it is
/// confirmed rather than uncertain.
pub fn for_failure(tx: Transmission, reported: Option<Usage>, est_in: u64) -> Counted {
    if let Some(u) = reported {
        return Counted::Confirmed(u);
    }
    match tx {
        Transmission::NotSent => Counted::Nothing,
        Transmission::Rejected => Counted::RequestOnly,
        Transmission::MaybeSent => Counted::Uncertain { input: est_in },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(i: u64, c: u64, w: u64, o: u64) -> Usage {
        Usage { input_total: i, cached_in: c, cache_write_in: w, output: o, reasoning: None }
    }

    #[test]
    fn openai_cached_is_a_subset_of_prompt_tokens() {
        let body = r#"{"usage":{"prompt_tokens":1000,"completion_tokens":50,
            "prompt_tokens_details":{"cached_tokens":800}}}"#;
        // input stays 1000: the 800 cached are part of it, not added on top.
        assert_eq!(parse(body), Some(u(1000, 800, 0, 50)));
    }

    #[test]
    fn openai_without_cache_fields() {
        assert_eq!(parse(r#"{"usage":{"prompt_tokens":12,"completion_tokens":34}}"#), Some(u(12, 0, 0, 34)));
    }

    #[test]
    fn openai_reasoning_is_informational_not_added() {
        let body = r#"{"usage":{"prompt_tokens":10,"completion_tokens":100,
            "completion_tokens_details":{"reasoning_tokens":60}}}"#;
        let got = parse(body).unwrap();
        assert_eq!(got.output, 100, "completion_tokens already includes reasoning");
        assert_eq!(got.reasoning, Some(60));
    }

    #[test]
    fn compatible_servers_that_report_cache_elsewhere() {
        assert_eq!(
            parse(r#"{"usage":{"prompt_tokens":100,"completion_tokens":1,"cached_tokens":40}}"#).unwrap().cached_in,
            40
        );
        assert_eq!(
            parse(r#"{"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_cache_hit_tokens":70}}"#)
                .unwrap()
                .cached_in,
            70
        );
    }

    #[test]
    fn cached_can_never_exceed_input() {
        let body = r#"{"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":99}}}"#;
        assert_eq!(parse(body).unwrap().cached_in, 10);
    }

    #[test]
    fn anthropic_input_excludes_cache_so_the_three_are_summed() {
        // 5 fresh + 900 read from cache + 100 written to cache = 1005 billed as input.
        let body = r#"{"usage":{"input_tokens":5,"output_tokens":6,
            "cache_read_input_tokens":900,"cache_creation_input_tokens":100}}"#;
        assert_eq!(parse(body), Some(u(1005, 900, 100, 6)));
    }

    #[test]
    fn anthropic_without_caching_is_unchanged() {
        assert_eq!(parse(r#"{"usage":{"input_tokens":5,"output_tokens":6}}"#), Some(u(5, 0, 0, 6)));
    }

    #[test]
    fn gemini_cached_is_a_subset_of_the_prompt() {
        let body = r#"{"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":20,
            "cachedContentTokenCount":400,"totalTokenCount":520}}"#;
        assert_eq!(parse(body), Some(u(500, 400, 0, 20)));
    }

    #[test]
    fn gemini_thoughts_are_added_when_the_total_says_they_are_separate() {
        let body = r#"{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,
            "thoughtsTokenCount":300,"totalTokenCount":330}}"#;
        let got = parse(body).unwrap();
        assert_eq!(got.output, 320);
        assert_eq!(got.reasoning, Some(300));
    }

    #[test]
    fn gemini_thoughts_are_not_double_counted_when_already_inside_candidates() {
        // total = prompt + candidates, so the 300 thoughts are already in the 320.
        let body = r#"{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":320,
            "thoughtsTokenCount":300,"totalTokenCount":330}}"#;
        assert_eq!(parse(body).unwrap().output, 320);
    }

    #[test]
    fn gemini_thoughts_without_a_total_follow_the_documented_rule() {
        let body = r#"{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"thoughtsTokenCount":5}}"#;
        assert_eq!(parse(body).unwrap().output, 25);
    }

    #[test]
    fn gemini_tool_use_prompt_tokens_are_input() {
        let body = r#"{"usageMetadata":{"promptTokenCount":10,"toolUsePromptTokenCount":7,"candidatesTokenCount":1}}"#;
        assert_eq!(parse(body).unwrap().input_total, 17);
    }

    #[test]
    fn no_usage_is_none() {
        assert_eq!(parse(r#"{"choices":[]}"#), None);
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"usage":{}}"#), None);
    }

    #[test]
    fn sums_never_overflow() {
        let body = format!(
            r#"{{"usage":{{"input_tokens":{m},"output_tokens":1,"cache_read_input_tokens":{m},"cache_creation_input_tokens":{m}}}}}"#,
            m = u64::MAX
        );
        assert_eq!(parse(&body).unwrap().input_total, u64::MAX);
    }

    #[test]
    fn status_classes() {
        for s in [400, 401, 402, 403, 404, 422, 429] {
            assert_eq!(classify_status(s), Transmission::Rejected, "{s}");
        }
        for s in [408, 500, 502, 503, 504] {
            assert_eq!(classify_status(s), Transmission::MaybeSent, "{s}");
        }
    }

    #[test]
    fn what_each_failure_is_counted_as() {
        assert_eq!(for_failure(Transmission::NotSent, None, 100), Counted::Nothing);
        assert_eq!(for_failure(Transmission::Rejected, None, 100), Counted::RequestOnly);
        assert_eq!(for_failure(Transmission::MaybeSent, None, 100), Counted::Uncertain { input: 100 });
        // A failure that still carried a usage block was counted by the provider: confirmed.
        let reported = u(7, 0, 0, 0);
        assert_eq!(for_failure(Transmission::MaybeSent, Some(reported), 100), Counted::Confirmed(reported));
    }

    #[test]
    fn success_prefers_the_providers_figures() {
        let reported = u(7, 0, 0, 3);
        assert_eq!(for_success(Some(reported), 99, 99), Counted::Confirmed(reported));
        assert_eq!(for_success(None, 99, 50), Counted::Estimated { input: 99, output: 50 });
    }
}
