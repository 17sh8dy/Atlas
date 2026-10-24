//! The token estimator: one heuristic for everything in Atlas that has to guess what text costs.
//!
//! Its TypeScript twin is `packages/core/src/tokens.ts`; both read the same
//! `packages/core/src/token-weights.json` and must agree to the token on every fixture in
//! `packages/core/test/token-fixtures.json` (the parity test below).
//!
//! It is an ESTIMATE, always shown as one. A count the provider or model server reports is used
//! whenever there is one; this only fills the gap, and a calibration ratio learned from those
//! reports (calibration.rs) nudges it toward the model in use.
//!
//! Integer maths on purpose (milli-tokens): floating point would let the two languages drift.

use serde::Deserialize;
use std::sync::OnceLock;

const WEIGHTS_JSON: &str = include_str!("../../../../packages/core/src/token-weights.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerChar {
    alnum: u64,
    digit: u64,
    space: u64,
    newline: u64,
    punct: u64,
    latin_ext: u64,
    cjk: u64,
    other_script: u64,
    emoji: u64,
    joiner: u64,
    combining: u64,
    other: u64,
}

#[derive(Deserialize)]
struct Kinds {
    prose: u64,
    code: u64,
    json: u64,
    logs: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Weights {
    per_char: PerChar,
    kind: Kinds,
    agent_chars_per_token: u64,
}

fn weights() -> &'static Weights {
    static W: OnceLock<Weights> = OnceLock::new();
    // The file is compiled in and covered by a test, so a malformed one fails the build's tests,
    // never a person's request.
    W.get_or_init(|| serde_json::from_str(WEIGHTS_JSON).expect("token-weights.json is valid"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContentKind {
    Prose,
    Code,
    Json,
    Logs,
}

impl ContentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ContentKind::Prose => "prose",
            ContentKind::Code => "code",
            ContentKind::Json => "json",
            ContentKind::Logs => "logs",
        }
    }
    fn mult(self) -> u64 {
        let k = &weights().kind;
        match self {
            ContentKind::Prose => k.prose,
            ContentKind::Code => k.code,
            ContentKind::Json => k.json,
            ContentKind::Logs => k.logs,
        }
    }
}

fn char_weight(c: char) -> u64 {
    let w = &weights().per_char;
    let cp = c as u32;
    if cp == 0x20 || cp == 0x09 {
        return w.space;
    }
    if cp == 0x0a || cp == 0x0d {
        return w.newline;
    }
    if (0x30..=0x39).contains(&cp) {
        return w.digit;
    }
    if (0x41..=0x5a).contains(&cp) || (0x61..=0x7a).contains(&cp) {
        return w.alnum;
    }
    if cp < 0x80 {
        return w.punct;
    }
    if cp == 0x200d || cp == 0xfe0f || cp == 0xfe0e || (0x1f3fb..=0x1f3ff).contains(&cp) {
        return w.joiner;
    }
    if (0x0300..=0x036f).contains(&cp) || (0x20d0..=0x20ff).contains(&cp) {
        return w.combining;
    }
    if (0x1f000..=0x1faff).contains(&cp) || (0x2600..=0x27bf).contains(&cp) || (0x2190..=0x2bff).contains(&cp) {
        return w.emoji;
    }
    if (0x3040..=0x30ff).contains(&cp)
        || (0x3400..=0x4dbf).contains(&cp)
        || (0x4e00..=0x9fff).contains(&cp)
        || (0xac00..=0xd7af).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0x20000..=0x2fa1f).contains(&cp)
    {
        return w.cjk;
    }
    if (0x0590..=0x06ff).contains(&cp) || (0x0900..=0x0dff).contains(&cp) || (0x0e00..=0x0eff).contains(&cp) {
        return w.other_script;
    }
    if (0x00a0..=0x024f).contains(&cp) || (0x0370..=0x052f).contains(&cp) {
        return w.latin_ext;
    }
    w.other
}

/// Trim only ASCII whitespace, to match the TypeScript twin exactly.
fn trim_ascii(s: &str) -> &str {
    s.trim_matches(|c| c == ' ' || c == '\t' || c == '\n' || c == '\r')
}

const SYMBOLS: &str = "{}[]()<>;=+*/\\|&^~";

/// A cheap single-pass guess at what kind of text a paragraph is.
pub fn classify(paragraph: &str) -> ContentKind {
    let t = trim_ascii(paragraph);
    let (mut n, mut sym, mut quotes) = (0u64, 0u64, 0u64);
    for ch in t.chars() {
        n += 1;
        if ch == '"' {
            quotes += 1;
        }
        if SYMBOLS.contains(ch) {
            sym += 1;
        }
    }
    if n == 0 {
        return ContentKind::Prose;
    }

    let first = t.chars().next();
    let last = t.chars().next_back();
    if matches!(first, Some('{') | Some('[')) && matches!(last, Some('}') | Some(']')) && quotes * 10 >= n {
        return ContentKind::Json;
    }

    let (mut lines, mut indented, mut logish) = (0u64, 0u64, 0u64);
    for line in t.split('\n') {
        if trim_ascii(line).is_empty() {
            continue;
        }
        lines += 1;
        if line.starts_with("  ") || line.starts_with('\t') {
            indented += 1;
        }
        let c = line.chars().next().unwrap_or(' ');
        if (c.is_ascii_digit() || c == '[') && line.contains(':') {
            logish += 1;
        }
    }
    if lines >= 3 && logish * 10 >= lines * 6 {
        return ContentKind::Logs;
    }
    if t.contains("```") || sym * 100 >= n * 6 || (lines >= 3 && indented * 10 >= lines * 4) {
        return ContentKind::Code;
    }
    ContentKind::Prose
}

fn raw_milli(text: &str) -> u64 {
    text.chars().map(char_weight).sum()
}

fn total_milli(text: &str, forced: Option<ContentKind>) -> u64 {
    let mut total = 0u64;
    for (i, part) in text.split("\n\n").enumerate() {
        let kind = forced.unwrap_or_else(|| classify(part));
        total += raw_milli(part) * kind.mult() / 1000;
        // The blank line between two paragraphs is two newlines.
        if i > 0 {
            total += 2 * weights().per_char.newline;
        }
    }
    total
}

fn finish(milli: u64, calibration_permille: u64) -> u64 {
    (milli * calibration_permille / 1000).div_ceil(1000)
}

/// Estimated tokens in `text`, rounded up. `calibration_permille` scales the result by what real
/// counts have taught us about this model (1000 = no change).
pub fn estimate_calibrated(text: &str, calibration_permille: u64) -> u64 {
    if text.is_empty() {
        return 0;
    }
    finish(total_milli(text, None), calibration_permille)
}

pub fn estimate(text: &str) -> u64 {
    estimate_calibrated(text, 1000)
}

/// As `estimate`, but the caller says what the text is (e.g. serialized tool definitions).
pub fn estimate_as(text: &str, kind: ContentKind) -> u64 {
    if text.is_empty() {
        return 0;
    }
    finish(total_milli(text, Some(kind)), 1000)
}

/// Everything a request sends: the prompt, plus any tool definitions and response schema, which
/// the provider reads and bills as input too (counted as JSON).
pub fn estimate_request(prompt: &str, tools: Option<&serde_json::Value>, schema: Option<&serde_json::Value>) -> u64 {
    let extra = |v: Option<&serde_json::Value>| v.map(|v| estimate_as(&v.to_string(), ContentKind::Json)).unwrap_or(0);
    estimate(prompt) + extra(tools) + extra(schema)
}

/// Characters per token for sizing a budget the other way round; see the TypeScript twin.
pub fn agent_chars_per_token() -> u64 {
    weights().agent_chars_per_token
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_weights_file_parses() {
        assert!(weights().per_char.alnum > 0);
        assert_eq!(agent_chars_per_token(), 3);
    }

    #[test]
    fn empty_is_zero_and_short_text_rounds_up() {
        assert_eq!(estimate(""), 0);
        assert_eq!(estimate("a"), 1);
        assert_eq!(estimate("abcd"), 1);
        assert_eq!(estimate("abcde"), 2);
    }

    #[test]
    fn cjk_costs_far_more_per_character_than_english() {
        let english = "the quick brown fox jumps over";
        let cjk = "你好世界你好世界你好世界你好世界你好世界你好世界你好";
        assert!(estimate(cjk) as f64 / cjk.chars().count() as f64 > 2.0 * (estimate(english) as f64 / english.len() as f64));
    }

    #[test]
    fn emoji_zwj_sequences_are_not_counted_as_many_separate_emoji() {
        let family = "👨‍👩‍👧‍👦"; // four emoji joined by three ZWJ
        let four_separate = "👨👩👧👦";
        assert!(estimate(family) < estimate(four_separate) * 2);
        assert!(estimate(family) >= estimate(four_separate));
    }

    #[test]
    fn code_and_json_cost_more_than_the_same_length_of_prose() {
        let prose = "This is a plain sentence about nothing in particular, written for the test.";
        let code = "fn main() { let x = vec![1, 2, 3]; for i in &x { println!(\"{}\", i); } }";
        assert_eq!(classify(prose), ContentKind::Prose);
        assert_eq!(classify(code), ContentKind::Code);
        assert!(estimate(code) as f64 / code.len() as f64 > estimate(prose) as f64 / prose.len() as f64);
        assert_eq!(classify(r#"{"a":"b","c":["d","e"],"f":{"g":"h"}}"#), ContentKind::Json);
    }

    #[test]
    fn logs_are_recognised() {
        let logs = "2026-10-21 12:00:01: started\n2026-10-21 12:00:02: ready\n[12:00:03] listening: 8080";
        assert_eq!(classify(logs), ContentKind::Logs);
    }

    #[test]
    fn a_mixed_prompt_is_estimated_per_paragraph() {
        let prose = "Please look at this function and tell me what is wrong with it.";
        let code = "fn add(a: i32, b: i32) -> i32 {\n    a - b\n}";
        let both = format!("{prose}\n\n{code}");
        // Not the code multiplier over everything, and not the prose one over everything.
        assert!(estimate(&both) > estimate(prose) + estimate_as(code, ContentKind::Prose));
        assert!(estimate(&both) < estimate_as(&both, ContentKind::Json));
    }

    #[test]
    fn longer_text_never_estimates_fewer_tokens() {
        let mut s = String::new();
        let mut last = 0;
        for piece in ["hello ", "world ", "你好 ", "{\"a\":1} ", "😀 ", "ünïcödé ", "\n\n", "x"] {
            s.push_str(piece);
            let now = estimate(&s);
            assert!(now >= last, "went down after {piece:?}");
            last = now;
        }
    }

    #[test]
    fn calibration_scales_the_estimate() {
        let t = "a".repeat(1000);
        assert!(estimate_calibrated(&t, 1500) > estimate(&t));
        assert!(estimate_calibrated(&t, 500) < estimate(&t));
        assert_eq!(estimate_calibrated(&t, 1000), estimate(&t));
    }

    #[test]
    fn a_request_counts_its_tools_and_schema() {
        let tools = serde_json::json!([{"name":"open_app","description":"Open an application","parameters":{"type":"object"}}]);
        assert!(estimate_request("hi", Some(&tools), None) > estimate("hi"));
        assert_eq!(estimate_request("hi", None, None), estimate("hi"));
    }

    #[test]
    fn nothing_panics_on_odd_input() {
        for s in ["\0", "\u{FFFF}", "\r\n\r\n\r\n", "\n\n\n\n", "   ", "\u{200D}", "a\u{0301}\u{0301}", &"x".repeat(100_000)] {
            let _ = estimate(s);
            let _ = classify(s);
        }
    }

    /// The Rust and TypeScript estimators must give identical answers. The expected values live in
    /// the shared fixture file, generated by the TypeScript side and checked by both.
    #[test]
    fn rust_and_typescript_agree_on_every_shared_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            name: String,
            text: String,
            kind: String,
            tokens: u64,
        }
        let raw = include_str!("../../../../packages/core/test/token-fixtures.json");
        let fixtures: Vec<Fixture> = serde_json::from_str(raw).expect("fixtures parse");
        assert!(fixtures.len() >= 20, "the fixture set should stay broad");
        for f in fixtures {
            assert_eq!(classify(&f.text).as_str(), f.kind, "kind of {}", f.name);
            assert_eq!(estimate(&f.text), f.tokens, "tokens of {}", f.name);
        }
    }
}
