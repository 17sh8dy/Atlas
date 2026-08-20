//! The Rust half of web search and page fetching.
//!
//! Both commands leave the machine, which is why they live apart from the
//! rest of `platform.rs`'s narrow, validated operations rather than blurring
//! into them. Same shape, same rule: no raw "fetch anything with any
//! headers" escape hatch, two named operations that validate their own
//! input, and everything they return is plain text — never something Atlas
//! (or a model reading it) could mistake for an instruction to run.
//!
//! `web_search` always talks to one fixed, Atlas-chosen host. `fetch_page`
//! does not — its target comes from a search result or a model, so it gets
//! an extra guard (`is_safe_fetch_target`) that a fixed-destination command
//! doesn't need: no fetching the user's own LAN or localhost services,
//! which a manipulated search result could otherwise point at.

use std::net::IpAddr;
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use scraper::{Html, Selector};
use serde::Serialize;

const REQUEST_TIMEOUT_SECS: u64 = 10;
const MAX_QUERY_CHARS: usize = 400;
const MAX_RESULTS: usize = 8;
const MAX_PAGE_BYTES: usize = 2_000_000;
const MAX_EXTRACT_CHARS: usize = 6_000;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; AtlasAssistant/1.0; local desktop app)";

#[derive(Serialize)]
pub struct WebSearchResultDto {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct WebPageDto {
    pub title: String,
    pub url: String,
    pub text: String,
}

fn http_client() -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    // A bare User-Agent with no Accept/Accept-Language reads as automated
    // traffic to DuckDuckGo's anomaly detection far more readily than a real
    // browser's request does — these are the two next most load-bearing
    // headers a browser always sends.
    headers.insert(
        reqwest::header::ACCEPT,
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".parse().unwrap(),
    );
    headers.insert(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9".parse().unwrap());

    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

/// DuckDuckGo occasionally answers an automated-looking request with a
/// CAPTCHA ("select all squares containing a duck") instead of results. This
/// is unofficial scraping of a page meant for browsers, not an API — the
/// honest failure mode is telling the user that plainly, not silently
/// returning an empty result list that reads as "nothing found."
fn is_anomaly_challenge(html: &str) -> bool {
    html.contains("anomaly-modal") || html.contains("challenge-form")
}

#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<WebSearchResultDto>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Give me something to search for.".into());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err("That search is too long.".into());
    }

    let client = http_client()?;
    let encoded = utf8_percent_encode(query, NON_ALPHANUMERIC).to_string();
    let url = format!("https://html.duckduckgo.com/html/?q={encoded}");

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "Couldn't reach the search engine — check the connection.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("The search engine returned {}.", resp.status()));
    }
    let body = resp
        .text()
        .await
        .map_err(|_| "Couldn't read the search results.".to_string())?;

    if is_anomaly_challenge(&body) {
        return Err(
            "The search engine wants to confirm this isn't automated traffic. Try again in a moment.".into(),
        );
    }

    Ok(parse_search_results(&body))
}

/// DuckDuckGo's no-JS HTML results page — chosen because it needs no API key
/// and no account, matching Atlas's "works with nothing connected" default.
/// This is the one function that would change for a different backend
/// (a paid search API, a self-hosted SearxNG instance, …); nothing else in
/// this file or in the engine above it knows or cares which one is in use.
fn parse_search_results(html: &str) -> Vec<WebSearchResultDto> {
    let doc = Html::parse_document(html);
    let Ok(result_sel) = Selector::parse("div.result, div.web-result") else {
        return Vec::new();
    };
    let Ok(link_sel) = Selector::parse("a.result__a") else {
        return Vec::new();
    };
    let Ok(snippet_sel) = Selector::parse(".result__snippet") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for el in doc.select(&result_sel) {
        let Some(link) = el.select(&link_sel).next() else {
            continue;
        };
        let title: String = link.text().collect::<String>().trim().to_string();
        let href = link.value().attr("href").unwrap_or_default();
        let target = resolve_result_link(href);
        if title.is_empty() || target.is_empty() {
            continue;
        }
        let snippet: String = el
            .select(&snippet_sel)
            .next()
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        out.push(WebSearchResultDto { title, url: target, snippet });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    out
}

/// DuckDuckGo's HTML results wrap each link in a redirect
/// (`//duckduckgo.com/l/?uddg=<real-url>&rut=…`) rather than linking directly.
fn resolve_result_link(href: &str) -> String {
    if let Some(idx) = href.find("uddg=") {
        let rest = &href[idx + 5..];
        let encoded = rest.split('&').next().unwrap_or("");
        if let Ok(decoded) = percent_encoding::percent_decode_str(encoded).decode_utf8() {
            let decoded = decoded.into_owned();
            if decoded.starts_with("http://") || decoded.starts_with("https://") {
                return decoded;
            }
        }
        return String::new();
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    String::new()
}

#[tauri::command]
pub async fn fetch_page(url: String) -> Result<WebPageDto, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("I only fetch http and https links.".into());
    }
    if !is_safe_fetch_target(url) {
        return Err("That address isn't something I'll fetch.".into());
    }

    let client = http_client()?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Couldn't reach that page.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("That page returned {}.", resp.status()));
    }

    // Absent content-type defaults to readable rather than refused — plenty
    // of small servers omit it — but an explicit non-text type is honoured.
    let is_text = match resp.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        Some(ct) => {
            let ct = ct.to_lowercase();
            ct.contains("html") || ct.contains("text")
        }
        None => true,
    };
    if !is_text {
        return Err("That doesn't look like a readable page.".into());
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|_| "That page took too long or was too large.".to_string())?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("That page is too large to read.".into());
    }

    let html = String::from_utf8_lossy(&bytes);
    let (title, text) = extract_readable_text(&html);
    Ok(WebPageDto {
        title,
        url: url.to_string(),
        text: truncate_chars(&text, MAX_EXTRACT_CHARS),
    })
}

/// Blocks the user's own machine and LAN. `web_search` never needs this — it
/// only ever talks to one fixed host — but `fetch_page`'s target comes from a
/// search result or a model's own choice, and a manipulated result pointing
/// at `http://192.168.1.1/` or `http://localhost:PORT/` should not get an
/// answer just because Atlas asked politely.
fn is_safe_fetch_target(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
            }
            // `is_unique_local` needs a newer Rust than this crate's floor
            // (1.77) declares, so fc00::/7 is checked by hand instead.
            IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unspecified() || (v6.octets()[0] & 0xfe) == 0xfc
            }
        };
        if blocked {
            return false;
        }
    }
    true
}

/// The "smallest clean version" of readable-text extraction: headings,
/// paragraphs and list items only. Selecting those tags directly — rather
/// than taking `<body>`'s full text and trying to strip `<script>`/`<style>`
/// back out — sidesteps script/CSS source leaking into the extract entirely,
/// without needing a real Readability-style article parser.
fn extract_readable_text(html: &str) -> (String, String) {
    let doc = Html::parse_document(html);

    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| doc.select(&sel).next())
        .map(|t| t.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    let Ok(content_sel) = Selector::parse("h1, h2, h3, h4, p, li") else {
        return (title, String::new());
    };

    let mut parts = Vec::new();
    for el in doc.select(&content_sel) {
        let text: String = el.text().collect::<String>();
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    (title, parts.join("\n"))
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("…");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ddg_redirect_links() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123";
        assert_eq!(resolve_result_link(href), "https://example.com/page");
    }

    #[test]
    fn passes_through_direct_links() {
        assert_eq!(resolve_result_link("https://example.com/"), "https://example.com/");
    }

    #[test]
    fn rejects_non_http_targets() {
        assert_eq!(resolve_result_link("javascript:alert(1)"), "");
    }

    #[test]
    fn blocks_loopback_and_private_fetch_targets() {
        assert!(!is_safe_fetch_target("http://localhost:8080/"));
        assert!(!is_safe_fetch_target("http://127.0.0.1/"));
        assert!(!is_safe_fetch_target("http://192.168.1.1/admin"));
        assert!(!is_safe_fetch_target("http://169.254.169.254/latest/meta-data"));
        assert!(is_safe_fetch_target("https://example.com/"));
    }

    #[test]
    fn extracts_headings_and_paragraphs_but_not_script_or_style() {
        let html = "<html><head><title>T</title></head><body>\
            <script>evil()</script><style>.x{}</style>\
            <h1>Hello</h1><p>World</p></body></html>";
        let (title, text) = extract_readable_text(html);
        assert_eq!(title, "T");
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(!text.contains("evil"));
    }

    #[test]
    fn parses_a_realistic_ddg_results_page() {
        let html = r#"
            <div class="result results_links results_links_deep web-result">
                <div class="links_main links_deep result__body">
                    <h2 class="result__title">
                        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffortnite&rut=x">Fortnite update</a>
                    </h2>
                    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffortnite">The latest Fortnite patch notes.</a>
                </div>
            </div>
        "#;
        let results = parse_search_results(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Fortnite update");
        assert_eq!(results[0].url, "https://example.com/fortnite");
        assert_eq!(results[0].snippet, "The latest Fortnite patch notes.");
    }

    #[test]
    fn recognises_the_anomaly_challenge_page() {
        // A trimmed real capture: DuckDuckGo occasionally answers an
        // automated-looking request with a "select all squares containing a
        // duck" CAPTCHA instead of results (HTTP 202, not an error status).
        let html = r#"
            <form id="challenge-form" action="//duckduckgo.com/anomaly.js" method="POST">
                <div class="anomaly-modal__mask">
                    <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
                </div>
            </form>
        "#;
        assert!(is_anomaly_challenge(html));
        assert!(!is_anomaly_challenge("<div class=\"result\">ordinary results page</div>"));
    }

    /// Hits the real network — run manually with `cargo test -- --ignored`.
    ///
    /// Not a hard pass/fail on results: DuckDuckGo's html endpoint is a page
    /// meant for browsers, not an API, and it occasionally answers automated
    /// -looking traffic with a CAPTCHA instead (see `is_anomaly_challenge`,
    /// confirmed against this exact endpoint during development). Success
    /// here means either real results came back, or the anomaly page was
    /// recognised and turned into the clear error Atlas shows the user —
    /// both are "working correctly." A raw network failure or a parse that
    /// silently returns nothing on a real results page would not be.
    #[tokio::test]
    #[ignore]
    async fn live_search_either_returns_results_or_reports_the_challenge_clearly() {
        match web_search("Rust programming language".to_string()).await {
            Ok(results) => {
                assert!(!results.is_empty(), "a non-challenge response should parse to real results");
                for r in &results {
                    assert!(r.url.starts_with("http"));
                    assert!(!r.title.is_empty());
                }
            }
            Err(msg) => {
                assert!(
                    msg.contains("automated traffic"),
                    "an unrecognised failure, not the known anomaly page: {msg}"
                );
            }
        }
    }

    #[tokio::test]
    #[ignore] // hits the real network — run manually with `cargo test -- --ignored`
    async fn live_fetch_page_extracts_real_text() {
        let page = fetch_page("https://example.com/".to_string()).await.expect("fetch should succeed");
        assert_eq!(page.title, "Example Domain");
        assert!(page.text.to_lowercase().contains("domain"));
        assert!(!page.text.is_empty());
    }
}
