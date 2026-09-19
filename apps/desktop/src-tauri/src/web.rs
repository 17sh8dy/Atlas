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
    /// As the source reported it; only some backends supply one.
    #[serde(rename = "publishedDate", skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
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

/// Why a backend refused, as a short tag the engine's search manager acts on
/// (`packages/engine/src/web/providers.ts`, `classifySearchError`). The tag is
/// the whole contract: the manager decides how long to leave a backend alone
/// from it, so a spent quota and a CAPTCHA are told apart here, natively,
/// where the HTTP status is known, instead of by matching English later.
struct SearchErr {
    kind: &'static str,
    msg: String,
}

impl SearchErr {
    fn new(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { kind, msg: msg.into() }
    }
    fn tagged(&self) -> String {
        format!("{}: {}", self.kind, self.msg)
    }
}

/// The key-free default, kept under its original name and message text.
#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<WebSearchResultDto>, String> {
    ddg_search(&query).await.map_err(|e| e.msg)
}

/// Search through one *named* backend. An allowlist on purpose — not a way to
/// point Atlas at an arbitrary URL — so adding a backend is one new arm here
/// and one provider in the engine, and nothing else changes.
#[tauri::command]
pub async fn web_search_with(
    provider: String,
    query: String,
    topic: Option<String>,
) -> Result<Vec<WebSearchResultDto>, String> {
    let out = match provider.as_str() {
        "duckduckgo" => ddg_search(&query).await,
        "tavily" => tavily_search(&query, topic.as_deref()).await,
        "wikipedia" => wikipedia_search(&query).await,
        _ => Err(SearchErr::new("error", "That isn't a search provider Atlas knows.")),
    };
    out.map_err(|e| e.tagged())
}

/// Whether a backend can run right now. For a keyed one that is "is a key
/// saved" — answered without the key ever leaving this process.
#[tauri::command]
pub fn web_search_provider_ready(provider: String) -> Result<bool, String> {
    match provider.as_str() {
        "duckduckgo" | "wikipedia" => Ok(true),
        "tavily" => Ok(crate::secrets::read_secret(TAVILY_SECRET_ID)?.is_some()),
        _ => Ok(false),
    }
}

fn check_query(query: &str) -> Result<&str, SearchErr> {
    let query = query.trim();
    if query.is_empty() {
        return Err(SearchErr::new("error", "Give me something to search for."));
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(SearchErr::new("error", "That search is too long."));
    }
    Ok(query)
}

async fn ddg_search(query: &str) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let query = check_query(query)?;
    let client = http_client().map_err(|e| SearchErr::new("error", e))?;
    let encoded = utf8_percent_encode(query, NON_ALPHANUMERIC).to_string();
    let url = format!("https://html.duckduckgo.com/html/?q={encoded}");

    let resp = client.get(&url).send().await.map_err(|_| {
        SearchErr::new("offline", "Couldn't reach the search engine — check the connection.")
    })?;
    if !resp.status().is_success() {
        return Err(SearchErr::new("error", format!("The search engine returned {}.", resp.status())));
    }
    let body = resp
        .text()
        .await
        .map_err(|_| SearchErr::new("error", "Couldn't read the search results."))?;

    if is_anomaly_challenge(&body) {
        return Err(SearchErr::new(
            "blocked",
            "The search engine wants to confirm this isn't automated traffic. Try again in a moment.",
        ));
    }

    Ok(parse_search_results(&body))
}

// ---- Tavily ---------------------------------------------------------------

/// Where the key lives: Windows Credential Manager, through `secrets.rs`,
/// like every other key in Atlas. It is read here to build one request and
/// goes nowhere else — not into a log, not into an error message, not back
/// across the IPC boundary.
const TAVILY_SECRET_ID: &str = "search-tavily";
const TAVILY_URL: &str = "https://api.tavily.com/search";
const MAX_SNIPPET_CHARS: usize = 600;

/// Tavily's documented statuses → the manager's categories. 432 is a plan or
/// key limit and 433 a pay-as-you-go spending cap: both mean "stop asking for
/// a while", which is exactly what `quota` does upstream.
fn classify_tavily_status(status: u16) -> SearchErr {
    match status {
        401 => SearchErr::new("auth", "Tavily didn't accept the saved key."),
        429 => SearchErr::new("rate", "Tavily is rate-limiting requests right now."),
        432 | 433 => SearchErr::new("quota", "Tavily's search allowance is used up for now."),
        400 | 422 => SearchErr::new("error", "Tavily rejected that search."),
        500..=599 => SearchErr::new("error", "Tavily is having trouble right now."),
        other => SearchErr::new("error", format!("Tavily returned {other}.")),
    }
}

fn parse_tavily_response(body: &str) -> Vec<WebSearchResultDto> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(items) = v.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let url = item.get("url").and_then(|x| x.as_str()).unwrap_or("").trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            continue;
        }
        let title = item.get("title").and_then(|x| x.as_str()).unwrap_or("").trim();
        let content = item.get("content").and_then(|x| x.as_str()).unwrap_or("").trim();
        let published = item
            .get("published_date")
            .and_then(|x| x.as_str())
            .filter(|d| !d.trim().is_empty())
            .map(|d| d.trim().to_string());
        out.push(WebSearchResultDto {
            title: if title.is_empty() { url.to_string() } else { title.to_string() },
            url: url.to_string(),
            snippet: truncate_chars(content, MAX_SNIPPET_CHARS),
            published_date: published,
        });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    out
}

async fn tavily_search(query: &str, topic: Option<&str>) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let query = check_query(query)?;
    let key = crate::secrets::read_secret(TAVILY_SECRET_ID)
        .map_err(|e| SearchErr::new("error", e))?
        .ok_or_else(|| SearchErr::new("auth", "No Tavily key is saved."))?;

    let client = http_client().map_err(|e| SearchErr::new("error", e))?;
    let body = serde_json::json!({
        "query": query,
        "search_depth": "basic",
        "max_results": MAX_RESULTS,
        "topic": if topic == Some("news") { "news" } else { "general" },
        "include_answer": false,
        "include_raw_content": false,
        "include_published_date": true,
    });

    // `bearer_auth` marks the header sensitive, so it is redacted from any
    // debug output of the request as well.
    let resp = client
        .post(TAVILY_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(|_| SearchErr::new("offline", "Couldn't reach Tavily — check the connection."))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(classify_tavily_status(status.as_u16()));
    }
    let text = resp
        .text()
        .await
        .map_err(|_| SearchErr::new("error", "Couldn't read Tavily's reply."))?;
    Ok(parse_tavily_response(&text))
}

// ---- Wikipedia ------------------------------------------------------------

/// The keyless knowledge backend: Wikipedia's own search API, which is meant
/// for programs, needs no account and asks only that a client identify
/// itself (`USER_AGENT` does). It is an encyclopedia, so it answers "what is
/// X" well and "what happened this week" badly — the engine knows that and
/// says so on any answer built from it.
const WIKIPEDIA_API: &str = "https://en.wikipedia.org/w/api.php";

/// `Fortnite (video game)` → `https://en.wikipedia.org/wiki/Fortnite_(video_game)`.
/// Underscores and the punctuation Wikipedia leaves readable stay as they are.
fn wikipedia_url(title: &str) -> String {
    use percent_encoding::AsciiSet;
    const KEEP: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'_')
        .remove(b'(')
        .remove(b')')
        .remove(b',')
        .remove(b'.')
        .remove(b'-')
        .remove(b'\'')
        .remove(b'!');
    let slug = title.trim().replace(' ', "_");
    format!("https://en.wikipedia.org/wiki/{}", utf8_percent_encode(&slug, KEEP))
}

fn parse_wikipedia_response(body: &str) -> Vec<WebSearchResultDto> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(pages) = v.pointer("/query/pages").and_then(|p| p.as_array()) else {
        return Vec::new();
    };
    // `generator=search` returns pages in no particular order; `index` is the
    // search rank, and the engine treats earlier results as better.
    let mut ranked: Vec<(i64, &serde_json::Value)> = pages
        .iter()
        .map(|p| (p.get("index").and_then(|i| i.as_i64()).unwrap_or(i64::MAX), p))
        .collect();
    ranked.sort_by_key(|(i, _)| *i);

    let mut out = Vec::new();
    for (_, page) in ranked {
        let title = page.get("title").and_then(|x| x.as_str()).unwrap_or("").trim();
        if title.is_empty() {
            continue;
        }
        let extract = page.get("extract").and_then(|x| x.as_str()).unwrap_or("").trim();
        // A disambiguation page is a list of other pages, not an answer.
        if extract.contains("may refer to") {
            continue;
        }
        out.push(WebSearchResultDto {
            title: title.to_string(),
            url: wikipedia_url(title),
            snippet: truncate_chars(extract, MAX_SNIPPET_CHARS),
            published_date: None,
        });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }
    out
}

async fn wikipedia_search(query: &str) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let query = check_query(query)?;
    let client = http_client().map_err(|e| SearchErr::new("error", e))?;
    let resp = client
        .get(WIKIPEDIA_API)
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&[
            ("action", "query"),
            ("generator", "search"),
            ("gsrsearch", query),
            ("gsrnamespace", "0"),
            ("gsrlimit", "6"),
            ("prop", "extracts"),
            ("exintro", "1"),
            ("explaintext", "1"),
            ("exlimit", "6"),
            ("exchars", "700"),
            ("redirects", "1"),
            ("format", "json"),
            ("formatversion", "2"),
        ])
        .send()
        .await
        .map_err(|_| SearchErr::new("offline", "Couldn't reach Wikipedia — check the connection."))?;

    let status = resp.status();
    if status.as_u16() == 429 {
        return Err(SearchErr::new("rate", "Wikipedia is rate-limiting requests right now."));
    }
    if !status.is_success() {
        return Err(SearchErr::new("error", format!("Wikipedia returned {status}.")));
    }
    let text = resp
        .text()
        .await
        .map_err(|_| SearchErr::new("error", "Couldn't read Wikipedia's reply."))?;
    Ok(parse_wikipedia_response(&text))
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

        out.push(WebSearchResultDto { title, url: target, snippet, published_date: None });
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
    fn tavily_statuses_map_to_the_categories_the_manager_acts_on() {
        assert_eq!(classify_tavily_status(401).kind, "auth");
        assert_eq!(classify_tavily_status(429).kind, "rate");
        assert_eq!(classify_tavily_status(432).kind, "quota");
        assert_eq!(classify_tavily_status(433).kind, "quota");
        assert_eq!(classify_tavily_status(400).kind, "error");
        assert_eq!(classify_tavily_status(503).kind, "error");
        assert_eq!(classify_tavily_status(418).kind, "error");
    }

    #[test]
    fn errors_are_tagged_the_way_the_engine_parses_them() {
        assert_eq!(
            classify_tavily_status(432).tagged(),
            "quota: Tavily's search allowance is used up for now."
        );
        assert!(classify_tavily_status(401).tagged().starts_with("auth: "));
    }

    #[test]
    fn parses_a_tavily_reply_and_keeps_the_published_date() {
        let body = r#"{"query":"q","results":[
            {"title":"Fortnite.GG","url":"https://fortnite.gg/","content":"Chapter 6 Season 2.","score":0.9,"published_date":"2026-09-10"},
            {"title":"","url":"https://example.com/x","content":"No title here"}
        ],"response_time":1.2}"#;
        let r = parse_tavily_response(body);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "Fortnite.GG");
        assert_eq!(r[0].snippet, "Chapter 6 Season 2.");
        assert_eq!(r[0].published_date.as_deref(), Some("2026-09-10"));
        assert_eq!(r[1].title, "https://example.com/x", "an untitled hit is titled by its address");
        assert_eq!(r[1].published_date, None);
    }

    #[test]
    fn drops_non_http_links_and_survives_garbage() {
        let body = r#"{"results":[
            {"title":"a","url":"javascript:alert(1)","content":"x"},
            {"title":"b","url":"file:///C:/secret.txt","content":"x"},
            {"title":"c","url":"https://ok.example/","content":"x"}
        ]}"#;
        let r = parse_tavily_response(body);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://ok.example/");
        assert!(parse_tavily_response("not json").is_empty());
        assert!(parse_tavily_response(r#"{"results":"nope"}"#).is_empty());
        assert!(parse_tavily_response("{}").is_empty());
    }

    #[test]
    fn caps_results_and_snippet_length() {
        let many: Vec<String> = (0..20)
            .map(|i| {
                format!(
                    r#"{{"title":"t{i}","url":"https://e{i}.example/","content":"{}"}}"#,
                    "y".repeat(2000)
                )
            })
            .collect();
        let body = format!(r#"{{"results":[{}]}}"#, many.join(","));
        let r = parse_tavily_response(&body);
        assert_eq!(r.len(), MAX_RESULTS);
        assert!(r[0].snippet.chars().count() <= MAX_SNIPPET_CHARS + 1);
    }

    #[test]
    fn queries_are_validated_before_anything_leaves_the_machine() {
        assert!(check_query("   ").is_err());
        assert!(check_query(&"x".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert_eq!(check_query("  hello  ").ok(), Some("hello"));
    }

    #[tokio::test]
    async fn an_unknown_provider_is_refused_not_dispatched() {
        let out = web_search_with("evil".into(), "q".into(), None).await;
        assert!(out.err().expect("must be refused").starts_with("error: "));
        assert!(!web_search_provider_ready("evil".into()).unwrap());
        assert!(web_search_provider_ready("duckduckgo".into()).unwrap());
        assert!(web_search_provider_ready("wikipedia".into()).unwrap());
    }

    #[test]
    fn wikipedia_urls_keep_readable_punctuation_and_encode_the_rest() {
        assert_eq!(wikipedia_url("Fortnite"), "https://en.wikipedia.org/wiki/Fortnite");
        assert_eq!(
            wikipedia_url("Fortnite (video game)"),
            "https://en.wikipedia.org/wiki/Fortnite_(video_game)"
        );
        assert_eq!(
            wikipedia_url("AC/DC"),
            "https://en.wikipedia.org/wiki/AC%2FDC",
            "a slash in a title must not become a path separator"
        );
        assert!(wikipedia_url("Zürich").contains("Z%C3%BCrich"));
    }

    #[test]
    fn parses_wikipedia_in_rank_order_and_drops_disambiguation_pages() {
        let body = r#"{"query":{"pages":[
            {"pageid":3,"title":"Third","index":3,"extract":"The third one."},
            {"pageid":1,"title":"First","index":1,"extract":"The first one."},
            {"pageid":2,"title":"Mercury","index":2,"extract":"Mercury may refer to:"},
            {"pageid":4,"title":"","index":4,"extract":"no title"}
        ]}}"#;
        let r = parse_wikipedia_response(body);
        let titles: Vec<&str> = r.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(titles, vec!["First", "Third"]);
        assert_eq!(r[0].snippet, "The first one.");
        assert_eq!(r[0].published_date, None);
    }

    #[test]
    fn wikipedia_parsing_survives_garbage() {
        assert!(parse_wikipedia_response("not json").is_empty());
        assert!(parse_wikipedia_response("{}").is_empty());
        assert!(parse_wikipedia_response(r#"{"query":{}}"#).is_empty());
        assert!(parse_wikipedia_response(r#"{"error":{"code":"x"}}"#).is_empty());
    }

    /// Describes the SHAPE of the saved key — never its value.
    #[test]
    #[ignore] // reads the real Credential Manager entry
    fn saved_tavily_key_shape() {
        let key = crate::secrets::read_secret(TAVILY_SECRET_ID).unwrap().expect("no key saved");
        eprintln!(
            "key shape: len={} starts_with_tvly={} has_whitespace={} has_control={} has_quote={} looks_like_url={}",
            key.chars().count(),
            key.starts_with("tvly-"),
            key.chars().any(|c| c.is_whitespace()),
            key.chars().any(|c| c.is_control()),
            key.contains('"') || key.contains('\''),
            key.contains("://"),
        );
    }

    /// Uses whatever key is saved in Credential Manager. Prints the outcome
    /// only — never the key, and never a header.
    #[tokio::test]
    #[ignore] // hits the real network and needs a saved key
    async fn live_tavily_with_the_saved_key() {
        match web_search_with("tavily".into(), "Fortnite current season".into(), None).await {
            Ok(r) => {
                eprintln!("live Tavily: {} results, first = {:?}", r.len(), r.first().map(|x| (&x.title, &x.url)));
                assert!(!r.is_empty());
            }
            Err(tagged) => panic!("live Tavily refused: {tagged}"),
        }
    }

    #[tokio::test]
    #[ignore] // hits the real network — run manually with `cargo test -- --ignored`
    async fn live_wikipedia_returns_real_articles() {
        let r = web_search_with("wikipedia".into(), "Fortnite video game".into(), None)
            .await
            .expect("Wikipedia's API should answer");
        eprintln!("live Wikipedia: {} results, first = {:?}", r.len(), r.first().map(|x| (&x.title, &x.url)));
        assert!(!r.is_empty());
        assert!(r[0].url.starts_with("https://en.wikipedia.org/wiki/"));
        assert!(!r[0].snippet.is_empty(), "the intro extract should come back with the hit");
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
                eprintln!("live DuckDuckGo: {} results, first = {:?}", results.len(), results.first().map(|r| &r.url));
                assert!(!results.is_empty(), "a non-challenge response should parse to real results");
                for r in &results {
                    assert!(r.url.starts_with("http"));
                    assert!(!r.title.is_empty());
                }
            }
            Err(msg) => {
                eprintln!("live DuckDuckGo: refused ({msg})");
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
