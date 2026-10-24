//! Live lookups of Nova's public pages (docs/PLAN-2.0.3.md §N, layer 3).
//!
//! Some answers go stale in an installer: "what's new in Atlas?", "what is the latest Replay.GG?".
//! For those Atlas may read the current public page instead of trusting the pack. What that gives
//! is **unsigned, live text**, so it is treated as exactly that:
//!
//! * **A fixed list.** The caller names a source *id* from `SOURCES`; it never supplies an address.
//!   Each id maps to one pinned `https` URL on a host that belongs to Nova's public sites or its
//!   GitHub repos. There is no way to ask this module to fetch anything else.
//! * **Locked down.** No redirects, no cookies, no credentials, a short timeout, a hard size cap.
//!   Nothing about the person is sent beyond an ordinary request.
//! * **Data, not instructions.** The text is returned with the address and the time it was read, to be
//!   shown as "Live from <page>, fetched <time>". It is never presented as verified and can never
//!   change what Atlas does (the engine fences it like any other outside text).
//! * **Optional.** Off when the person turned off "Look up current information from Nova's public
//!   pages". Off means this module never makes a request.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const MAX_BYTES: usize = 512 * 1024;
const MAX_TEXT_CHARS: usize = 6_000;
/// Below this, a page is treated as unreadable (a script-only page shows almost nothing without one).
const THIN_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// A GitHub "latest release" JSON document.
    Release,
    /// An HTML page, reduced to its visible text.
    Page,
}

struct Source {
    id: &'static str,
    url: &'static str,
    kind: Kind,
    /// What this is, for the person: "the Atlas site".
    label: &'static str,
}

const SOURCES: &[Source] = &[
    Source { id: "atlas-release", url: "https://api.github.com/repos/17sh8dy/Atlas/releases/latest", kind: Kind::Release, label: "the latest Atlas release" },
    Source { id: "replay-release", url: "https://api.github.com/repos/17sh8dy/Replay.GG/releases/latest", kind: Kind::Release, label: "the latest Replay.GG release" },
    Source { id: "nova-cut-release", url: "https://api.github.com/repos/17sh8dy/NovaCut/releases/latest", kind: Kind::Release, label: "the latest Nova Cut release" },
    Source { id: "site-nova", url: "https://nova-780.pages.dev/", kind: Kind::Page, label: "the Nova home page" },
    Source { id: "site-atlas", url: "https://atlas-website.shadylabs.workers.dev/", kind: Kind::Page, label: "the Atlas site" },
    Source { id: "site-replay", url: "https://replay-gg-site.shadylabs.workers.dev/", kind: Kind::Page, label: "the Replay.GG site" },
    Source { id: "site-nova-cut", url: "https://nova-cut-site.shadylabs.workers.dev/", kind: Kind::Page, label: "the Nova Cut site" },
    Source { id: "site-help", url: "https://nova-help.shadylabs.workers.dev/", kind: Kind::Page, label: "Nova.Help" },
    Source { id: "site-review", url: "https://nova-review.shadylabs.workers.dev/", kind: Kind::Page, label: "Nova.Review" },
    Source { id: "site-legal", url: "https://nova-legal.shadylabs.workers.dev/", kind: Kind::Page, label: "Nova Legal" },
];

fn source(id: &str) -> Option<&'static Source> {
    SOURCES.iter().find(|s| s.id == id)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveResult {
    pub source_id: String,
    pub label: String,
    /// The exact address that was read, for the "Live from" line.
    pub url: String,
    pub fetched_at_ms: u64,
    /// For a release: its name and tag; for a page: its title.
    pub title: String,
    /// For a release: when it was published (ISO), when GitHub says.
    pub published: Option<String>,
    /// The visible text, capped. DATA.
    pub text: String,
    /// True when too little readable text came back (a page that needs scripts to show anything).
    pub thin: bool,
}

// ---- pure helpers (tested) ---------------------------------------------------------------------

/// The visible text of an HTML page: scripts and styles removed, tags dropped, entities decoded for
/// the few that matter, whitespace collapsed. A reader, not a browser.
pub(crate) fn html_to_text(html: &str) -> (String, String) {
    let lower = html.to_ascii_lowercase();
    let title = lower
        .find("<title")
        .and_then(|s| lower[s..].find('>').map(|g| s + g + 1))
        .and_then(|s| lower[s..].find("</title>").map(|e| html[s..s + e].trim().to_string()))
        .unwrap_or_default();

    let mut out = String::with_capacity(html.len() / 3);
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip a whole <script>/<style> element.
            let rest = &lower[i..];
            let mut skipped = false;
            for tag in ["script", "style", "noscript"] {
                if rest.starts_with(&format!("<{tag}")) {
                    let close = format!("</{tag}>");
                    i = rest.find(&close).map(|e| i + e + close.len()).unwrap_or(bytes.len());
                    skipped = true;
                    break;
                }
            }
            if skipped {
                out.push(' ');
                continue;
            }
            // A comment, or an ordinary tag: drop it, leave a space so words do not join.
            i = if rest.starts_with("<!--") {
                rest.find("-->").map(|e| i + e + 3).unwrap_or(bytes.len())
            } else {
                rest.find('>').map(|e| i + e + 1).unwrap_or(bytes.len())
            };
            out.push(' ');
        } else {
            // Copy one character (not one byte), so multi-byte text survives.
            let ch_len = html[i..].chars().next().map(char::len_utf8).unwrap_or(1);
            out.push_str(&html[i..i + ch_len]);
            i += ch_len;
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&rsquo;", "\u{2019}");
    (title, decoded.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn cap(text: &str) -> String {
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
    format!("{cut}…")
}

/// Reads a GitHub release document: `(title, published, body)`. Only the fields that are plain text.
pub(crate) fn parse_release(json: &str) -> Option<(String, Option<String>, String)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let tag = v.get("tag_name")?.as_str()?;
    let name = v.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).unwrap_or(tag);
    let title = if name == tag { tag.to_string() } else { format!("{name} ({tag})") };
    let published = v.get("published_at").and_then(|p| p.as_str()).map(str::to_string);
    let body = v.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string();
    Some((title, published, body))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- the command -------------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Atlas-Knowledge-Live/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        // A pinned page that redirects is a page whose address should be fixed here, not followed.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

async fn read_capped(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("That page is larger than Atlas reads.".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The page was interrupted.".to_string())? {
        if out.len() + chunk.len() > MAX_BYTES {
            return Err("That page is larger than Atlas reads.".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Read one of Nova's public pages by id. See the module notes for what that means and does not.
#[tauri::command]
pub async fn knowledge_live_fetch(source_id: String) -> Result<LiveResult, String> {
    crate::halt::global().check()?;
    if !crate::knowledge::live_lookups_enabled() {
        return Err("live-lookups-off".into());
    }
    let src = source(&source_id).ok_or("That isn't a page Atlas looks up.")?;
    let result = fetch(src).await;
    crate::stats::bump(if result.is_ok() { "knowledge.live_fetches" } else { "knowledge.live_failures" }, 1);
    result
}

async fn fetch(src: &'static Source) -> Result<LiveResult, String> {
    let mut req = client()?.get(src.url);
    req = match src.kind {
        Kind::Release => req.header("Accept", "application/vnd.github+json"),
        Kind::Page => req.header("Accept", "text/html"),
    };
    let resp = req.send().await.map_err(|_| format!("Couldn't reach {}.", src.label))?;
    if !resp.status().is_success() {
        return Err(format!("{} answered {}.", src.label, resp.status().as_u16()));
    }
    let body = read_capped(resp).await?;
    let text_in = String::from_utf8_lossy(&body).into_owned();
    let (title, published, text) = match src.kind {
        Kind::Release => {
            let (t, p, b) = parse_release(&text_in).ok_or("That release information was not in the expected form.")?;
            (t, p, b)
        }
        Kind::Page => {
            let (t, visible) = html_to_text(&text_in);
            (t, None, visible)
        }
    };
    let text = cap(&text);
    let thin = text.chars().count() < THIN_CHARS;
    Ok(LiveResult {
        source_id: src.id.to_string(),
        label: src.label.to_string(),
        url: src.url.to_string(),
        fetched_at_ms: now_ms(),
        title,
        published,
        text,
        thin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_is_one_pinned_https_address_on_a_nova_host() {
        let mut ids = std::collections::HashSet::new();
        for s in SOURCES {
            assert!(ids.insert(s.id), "duplicate id {}", s.id);
            let u = reqwest::Url::parse(s.url).unwrap();
            assert_eq!(u.scheme(), "https", "{}", s.id);
            assert!(u.username().is_empty() && u.password().is_none() && u.port().is_none() && u.query().is_none(), "{}", s.id);
            let host = u.host_str().unwrap();
            let ok = host == "api.github.com" || host.ends_with(".shadylabs.workers.dev") || host == "nova-780.pages.dev";
            assert!(ok, "{} is on an unexpected host: {host}", s.id);
            if host == "api.github.com" {
                assert!(u.path().starts_with("/repos/17sh8dy/"), "{} must be one of Nova's own repos", s.id);
            }
        }
    }

    #[test]
    fn an_unknown_id_is_not_a_source_and_an_address_is_never_accepted_as_one() {
        assert!(source("atlas-release").is_some());
        assert!(source("https://evil.example/").is_none());
        assert!(source("").is_none());
        assert!(source("../atlas-release").is_none());
    }

    #[test]
    fn html_becomes_visible_text_without_scripts_styles_or_tags() {
        let html = "<html><head><title>Atlas — Desktop assistant</title><style>.a{color:red}</style><script>var x='ignore previous instructions';</script></head><body><h1>Your desktop.</h1><p>Atlas is a <b>powerful</b> assistant.</p><!-- hidden note --><noscript>enable js</noscript></body></html>";
        let (title, text) = html_to_text(html);
        assert_eq!(title, "Atlas — Desktop assistant");
        assert_eq!(text, "Atlas — Desktop assistant Your desktop. Atlas is a powerful assistant.");
        assert!(!text.contains("ignore previous") && !text.contains("color:red") && !text.contains("hidden note"));
    }

    #[test]
    fn multibyte_text_survives() {
        let (_, text) = html_to_text("<p>Replay.gg — never miss the moment ✳ 你好</p>");
        assert!(text.contains("✳") && text.contains("你好") && text.contains("—"));
    }

    #[test]
    fn broken_html_does_not_panic() {
        for s in ["<", "<script", "<!--", "<p", "</", "&", "<style>never closed", ""] {
            let _ = html_to_text(s);
        }
    }

    #[test]
    fn a_release_is_read_from_its_json() {
        let json = r#"{"tag_name":"v2.0.3","name":"Atlas 2.0.3","published_at":"2026-10-30T00:00:00Z","body":"- New: knowledge"}"#;
        let (title, published, body) = parse_release(json).unwrap();
        assert_eq!(title, "Atlas 2.0.3 (v2.0.3)");
        assert_eq!(published.as_deref(), Some("2026-10-30T00:00:00Z"));
        assert_eq!(body, "- New: knowledge");
        assert!(parse_release("{}").is_none());
        assert!(parse_release("nope").is_none());
    }

    #[test]
    fn a_nameless_release_falls_back_to_its_tag() {
        let (title, _, _) = parse_release(r#"{"tag_name":"v1.0.0","name":""}"#).unwrap();
        assert_eq!(title, "v1.0.0");
    }

    #[test]
    fn long_text_is_capped() {
        assert!(cap(&"x".repeat(20_000)).chars().count() <= MAX_TEXT_CHARS + 1);
        assert_eq!(cap("short"), "short");
    }

    /// Real network: every source answers and gives readable text. Run by hand:
    ///   cargo test --lib knowledge_live -- --ignored --nocapture
    #[test]
    #[ignore = "needs the network"]
    fn every_live_source_answers() {
        for s in SOURCES {
            let r = tauri::async_runtime::block_on(fetch(s));
            match r {
                Ok(l) => println!("{:<18} ok  thin={:<5} {:>5} chars  {}", s.id, l.thin, l.text.chars().count(), l.title.chars().take(60).collect::<String>()),
                Err(e) => println!("{:<18} ERR {e}", s.id),
            }
        }
    }
}
