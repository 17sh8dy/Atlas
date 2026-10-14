//! Keeping credentials out of anything Atlas writes down or shows.
//!
//! Atlas's own secrets live in Windows Credential Manager and nowhere else. This module is the
//! belt to that braces: **anything that is about to be written to the diagnostics file, or
//! returned to the screen as an error, passes through `redact` first**, so a key that reaches
//! text by accident (a provider that echoes the key it rejected, a pasted value in a message, an
//! `Authorization` header in an error) is replaced rather than kept.
//!
//! It is deliberately **eager**: losing a harmless long identifier from a log line costs nothing,
//! keeping a key costs everything. It works on whole tokens, not substrings, so ordinary words and
//! Windows paths (which contain `\`) are untouched; SHA-256 style hex digests are left alone
//! because the updater's messages need them and they are not credentials.
//!
//! The TypeScript twin is `packages/core/src/redact.ts`; both are tested against the same
//! examples.

pub const HIDDEN: &str = "[key hidden]";

/// Prefixes that name a credential on their own, with the minimum length a real one has.
const PREFIXES: &[(&str, usize)] = &[
    ("sk-", 20),
    ("sk_", 20),
    ("pk_", 20),
    ("rk_", 20),
    ("hf_", 20),
    ("tvly-", 16),
    ("AIza", 30),
    ("ghp_", 30),
    ("gho_", 30),
    ("ghu_", 30),
    ("ghs_", 30),
    ("ghr_", 30),
    ("github_pat_", 30),
    ("xoxb-", 15),
    ("xoxp-", 15),
    ("xoxa-", 15),
    ("xoxs-", 15),
    ("AKIA", 20),
];

/// Names whose value (after `=` or `:`) is a secret whatever it looks like.
const SECRET_NAMES: &[&str] = &[
    "api_key", "apikey", "api-key", "x-api-key", "x-goog-api-key", "authorization", "token",
    "access_token", "refresh_token", "secret", "client_secret", "password", "passwd", "pwd",
];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '~' | '+' | '/' | '=')
}

fn is_hex_digest(t: &str) -> bool {
    t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit())
}

fn looks_random(t: &str) -> bool {
    if t.len() < 32 || is_hex_digest(t) {
        return false;
    }
    let (mut lower, mut upper, mut digit) = (false, false, false);
    for c in t.chars() {
        lower |= c.is_ascii_lowercase();
        upper |= c.is_ascii_uppercase();
        digit |= c.is_ascii_digit();
    }
    // Mixed case and digits: a key, not a word or a file name.
    if !(lower && upper && digit) {
        return false;
    }
    let mut counts = std::collections::HashMap::new();
    for c in t.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    let n = t.chars().count() as f64;
    let h: f64 = counts.values().map(|&k| { let p = k as f64 / n; -p * p.log2() }).sum();
    h >= 3.5
}

fn is_secret_token(t: &str) -> bool {
    let t = t.trim_end_matches(['.', ',', ';']);
    if t.starts_with("eyJ") && t.matches('.').count() == 2 && t.len() >= 24 {
        return true;
    }
    for (p, min) in PREFIXES {
        if t.starts_with(p) && t.len() >= *min {
            return true;
        }
    }
    // A path or URL is judged one segment at a time: it is long because it is a path.
    if t.contains('/') {
        return t.split('/').any(looks_random);
    }
    looks_random(t)
}

fn name_of(run: &str) -> Option<&str> {
    let name = run.trim_end_matches(['=', ':']);
    if name.len() == run.len() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    SECRET_NAMES.iter().find(|n| **n == lower).map(|_| name)
}

/// Replace anything credential-shaped with `[key hidden]`.
pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_word = String::new();
    let mut hide_next = false;
    let mut run = String::new();

    // One whitespace/punctuation-delimited token at a time.
    let mut take = |run: &mut String, out: &mut String| {
        if run.is_empty() {
            return;
        }
        let r = std::mem::take(run);
        // `name=value` or `name:value` written without a space.
        if let Some(i) = r.find(['=', ':']) {
            let (left, right) = r.split_at(i + 1);
            if !right.is_empty() {
                let lower = left.trim_end_matches(['=', ':']).to_ascii_lowercase();
                if SECRET_NAMES.contains(&lower.as_str())
                    || (!right.starts_with("//") && is_secret_token(right))
                {
                    out.push_str(left);
                    out.push_str(HIDDEN);
                    prev_word.clear();
                    hide_next = false;
                    return;
                }
            }
        }
        let secret = (hide_next && r.len() >= 8)
            || (prev_word.eq_ignore_ascii_case("bearer") && r.len() >= 16)
            || is_secret_token(&r);
        if secret {
            out.push_str(HIDDEN);
            hide_next = false;
        } else {
            out.push_str(&r);
            // `Authorization:` / `api_key=` followed by a space: the next token is the value.
            hide_next = name_of(&r).is_some() || r.eq_ignore_ascii_case("bearer") && hide_next;
        }
        prev_word = r;
    };

    for c in input.chars() {
        if is_token_char(c) || c == ':' {
            run.push(c);
        } else {
            take(&mut run, &mut out);
            out.push(c);
        }
    }
    take(&mut run, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_key_shapes_are_hidden() {
        for k in [
            "sk-proj-abcdefghijklmnopqrstuvwx",
            "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
            "hf_abcdefghijklmnopqrstuvwxyzABCD",
            "tvly-dev-abcdefghijklmnop",
            "AIzaSyA-abcdefghijklmnopqrstuvwxyz0123",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "AKIAABCDEFGHIJKLMNOP",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
        ] {
            let out = redact(&format!("provider said: key {k} rejected"));
            assert!(!out.contains(k), "{k} survived: {out}");
            assert!(out.contains(HIDDEN), "{out}");
            assert!(out.starts_with("provider said: key "), "{out}");
        }
    }

    #[test]
    fn a_bearer_header_and_named_values_are_hidden() {
        let o = redact("sent Authorization: Bearer abcdEFGH1234567890zzzz to host");
        assert!(!o.contains("abcdEFGH1234567890zzzz"), "{o}");
        let o = redact("api_key=Zx81hq92 and x-api-key: Qq77aa88bb99");
        assert!(!o.contains("Zx81hq92") && !o.contains("Qq77aa88bb99"), "{o}");
        let o = redact("password=hunter2hunter2");
        assert!(!o.contains("hunter2"), "{o}");
    }

    #[test]
    fn a_long_random_looking_token_is_hidden_but_a_hash_a_path_and_words_are_not() {
        let rnd = "Zq8Lm3Xv9Tp2Wc7Rb5Nk1Hd4Jf6Gs0YaQe";
        assert!(!redact(&format!("value {rnd} end")).contains(rnd));
        let sha = "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
        assert!(redact(&format!("sha256 {sha}")).contains(sha), "a digest is not a credential");
        let path = r"C:\Users\Brandon\AppData\Roaming\dev.atlas.assistant\storage.json";
        assert_eq!(redact(path), path);
        let words = "The download is version 2.0.0, not 1.0.10. Not installing.";
        assert_eq!(redact(words), words);
    }

    #[test]
    fn urls_and_ordinary_log_lines_survive() {
        let l = "stop key unavailable: F8 is already registered by another program";
        assert_eq!(redact(l), l);
        let u = "https://github.com/17sh8dy/Atlas/releases/latest/download/latest.json";
        assert_eq!(redact(u), u);
    }
}
