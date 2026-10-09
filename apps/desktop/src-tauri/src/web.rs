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
/// Documentation pages are read further than a search snippet's worth, but still bounded.
const MAX_DOC_CHARS: usize = 16_000;
const MAX_LINKS: usize = 80;
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

#[derive(Serialize, Debug)]
pub struct WebPageDto {
    pub title: String,
    pub url: String,
    pub text: String,
    /// Only filled by `fetch_doc_page`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<LinkDto>,
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

#[derive(Serialize, Debug)]
pub struct LinkDto {
    pub text: String,
    pub url: String,
}

/// How a page is fetched and read. `fetch_page` (a person asked for this page) keeps its original,
/// plain shape; `fetch_doc_page` (Atlas is researching on its own) is polite and richer.
struct FetchOpts {
    max_chars: usize,
    /// Honour the site's robots.txt before fetching.
    respect_robots: bool,
    /// Keep `<pre>` code blocks (fenced) and report the page's links.
    docs: bool,
}

/// Where a redirect may lead. Followed by hand, one hop at a time, so every hop is checked the same
/// way the first address is — a public page that redirects to `http://192.168.1.1/` gets nothing.
const MAX_REDIRECTS: usize = 5;

fn fetch_client() -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::ACCEPT, "text/html,text/plain;q=0.9,*/*;q=0.5".parse().unwrap());
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .default_headers(headers)
        // Redirects are followed below, with the safety check on every hop.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast(),
        // `is_unique_local` needs a newer Rust than this crate's floor (1.77) declares, so fc00::/7 is checked by hand.
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || (v6.octets()[0] & 0xfe) == 0xfc || (v6.octets()[0] == 0xfe && (v6.octets()[1] & 0xc0) == 0x80),
    }
}

/// `is_safe_fetch_target`, plus where the NAME actually points: a host called `intranet.example.com` that
/// resolves to 10.0.0.5 is the LAN too. A name that does not resolve is not safe either.
async fn target_is_safe(url: &str) -> bool {
    if !is_safe_fetch_target(url) {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let host = match host_of(&parsed) {
        Some(Host::Name(name)) => name,
        // An address was already judged by is_safe_fetch_target.
        Some(Host::Ip(_)) => return true,
        None => return false,
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        match (host.as_str(), port).to_socket_addrs() {
            Ok(addrs) => {
                let addrs: Vec<_> = addrs.collect();
                !addrs.is_empty() && addrs.iter().all(|a| !ip_is_blocked(a.ip()))
            }
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false)
}

// ---- robots.txt ---------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Robots {
    /// (allow, path pattern), for the group that applies to Atlas.
    rules: Vec<(bool, String)>,
    /// The robots file itself could not be trusted (server error): treat the site as closed for now.
    closed: bool,
}

/// Pick the group for `atlas…` if the file has one, else `*`, and read its Allow / Disallow lines.
fn parse_robots(text: &str) -> Robots {
    let mut groups: Vec<(Vec<String>, Vec<(bool, String)>)> = Vec::new();
    let mut agents: Vec<String> = Vec::new();
    let mut rules: Vec<(bool, String)> = Vec::new();
    let mut in_rules = false;
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        match k.as_str() {
            "user-agent" => {
                if in_rules {
                    groups.push((std::mem::take(&mut agents), std::mem::take(&mut rules)));
                    in_rules = false;
                }
                agents.push(v.to_ascii_lowercase());
            }
            "allow" | "disallow" => {
                in_rules = true;
                if !v.is_empty() || k == "allow" {
                    if !v.is_empty() {
                        rules.push((k == "allow", v.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    if !agents.is_empty() || !rules.is_empty() {
        groups.push((agents, rules));
    }
    let ours = groups.iter().find(|(a, _)| a.iter().any(|x| x.contains("atlas")));
    let star = groups.iter().find(|(a, _)| a.iter().any(|x| x == "*"));
    Robots { rules: ours.or(star).map(|g| g.1.clone()).unwrap_or_default(), closed: false }
}

/// `*` matches anything, a trailing `$` anchors the end; otherwise a prefix match.
fn robots_pattern_matches(pattern: &str, path: &str) -> bool {
    let (pat, anchored) = match pattern.strip_suffix('$') {
        Some(p) => (p, true),
        None => (pattern, false),
    };
    let parts: Vec<&str> = pat.split('*').collect();
    let mut pos = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !path.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else {
            match path[pos..].find(part) {
                Some(at) => pos += at + part.len(),
                None => return false,
            }
        }
    }
    !anchored || pos == path.len() || parts.last().map(|l| l.is_empty()).unwrap_or(false)
}

/// The longest matching rule wins; on a tie, Allow wins. No matching rule means allowed.
fn robots_allows(r: &Robots, path_and_query: &str) -> bool {
    if r.closed {
        return false;
    }
    let mut best: Option<(usize, bool)> = None;
    for (allow, pattern) in &r.rules {
        if robots_pattern_matches(pattern, path_and_query) {
            let len = pattern.len();
            best = match best {
                Some((l, a)) if l > len || (l == len && a) => Some((l, a)),
                _ => Some((len, *allow)),
            };
        }
    }
    best.map(|(_, a)| a).unwrap_or(true)
}

fn robots_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Robots)>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Robots)>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// May Atlas fetch this URL automatically? Fetches (and caches for an hour) the site's robots.txt.
/// No file, or one we cannot reach, means yes; a server error means no, for now (RFC 9309).
async fn robots_permits(client: &reqwest::Client, url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let key = format!("{}://{}", url.scheme(), url.authority());
    if let Some((at, r)) = robots_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < Duration::from_secs(3600) {
            return robots_allows(&r, &path_and_query(url));
        }
    }
    let robots_url = format!("{}://{}/robots.txt", url.scheme(), url.authority());
    let rules = if !target_is_safe(&robots_url).await {
        Robots::default()
    } else {
        match client.get(&robots_url).timeout(Duration::from_secs(4)).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(b) if b.len() <= 200_000 => parse_robots(&String::from_utf8_lossy(&b)),
                _ => Robots::default(),
            },
            Ok(resp) if resp.status().is_server_error() => Robots { rules: vec![], closed: true },
            _ => Robots::default(),
        }
    };
    let _ = host;
    if let Ok(mut c) = robots_cache().lock() {
        c.insert(key, (std::time::Instant::now(), rules.clone()));
    }
    robots_allows(&rules, &path_and_query(url))
}

fn path_and_query(url: &reqwest::Url) -> String {
    match url.query() {
        Some(q) => format!("{}?{}", url.path(), q),
        None => url.path().to_string(),
    }
}

// ---- the fetch itself -----------------------------------------------------------------------------------

async fn fetch_text_page(url: &str, opts: FetchOpts) -> Result<WebPageDto, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("I only fetch http and https links.".into());
    }
    let mut current = reqwest::Url::parse(url).map_err(|_| "That doesn't look like a web address.".to_string())?;
    // An address with a name and password in it is a credential in a URL: never sent, never logged.
    if !current.username().is_empty() || current.password().is_some() {
        return Err("I don't fetch addresses that contain a login.".into());
    }

    let client = fetch_client()?;
    let mut hops = 0usize;
    let resp = loop {
        if !target_is_safe(current.as_str()).await {
            return Err("That address isn't something I'll fetch.".into());
        }
        if opts.respect_robots && !robots_permits(&client, &current).await {
            return Err("That site's robots.txt asks automated tools not to read that page, so I didn't.".into());
        }
        let resp = client.get(current.clone()).send().await.map_err(|_| "Couldn't reach that page.".to_string())?;
        if resp.status().is_redirection() {
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err("That page redirected too many times.".into());
            }
            let next = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| current.join(loc).ok())
                .ok_or_else(|| "That page redirected somewhere I couldn't follow.".to_string())?;
            if !matches!(next.scheme(), "http" | "https") || !next.username().is_empty() || next.password().is_some() {
                return Err("That page redirected somewhere I won't go.".into());
            }
            current = next;
            continue;
        }
        break resp;
    };
    if !resp.status().is_success() {
        return Err(format!("That page returned {}.", resp.status()));
    }

    // Absent content-type defaults to readable rather than refused — plenty of small servers omit it —
    // but an explicit non-text type is honoured.
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
    // Declared size first, so a huge body is refused before it is downloaded.
    if resp.content_length().map(|n| n as usize > MAX_PAGE_BYTES).unwrap_or(false) {
        return Err("That page is too large to read.".into());
    }

    let bytes = resp.bytes().await.map_err(|_| "That page took too long or was too large.".to_string())?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("That page is too large to read.".into());
    }

    let html = String::from_utf8_lossy(&bytes);
    let (title, text, links) = extract_page(&html, &current, opts.docs);
    Ok(WebPageDto { title, url: current.to_string(), text: truncate_chars(&text, opts.max_chars), links })
}

#[tauri::command]
pub async fn fetch_page(url: String) -> Result<WebPageDto, String> {
    fetch_text_page(&url, FetchOpts { max_chars: MAX_EXTRACT_CHARS, respect_robots: false, docs: false }).await
}

/// For research Atlas does on its own (documentation, API references): respects robots.txt, keeps code
/// blocks, reports the page's links so a documentation index can be followed, and reads more of the page.
#[tauri::command]
pub async fn fetch_doc_page(url: String) -> Result<WebPageDto, String> {
    crate::halt::global().check()?;
    fetch_text_page(&url, FetchOpts { max_chars: MAX_DOC_CHARS, respect_robots: true, docs: true }).await
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
    let Some(host) = host_of(&parsed) else {
        return false;
    };
    match host {
        Host::Ip(ip) => !ip_is_blocked(ip),
        Host::Name(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !(name == "localhost" || name.ends_with(".localhost"))
        }
    }
}

enum Host {
    Ip(IpAddr),
    Name(String),
}

/// An address or a name. `Url::host_str()` returns an IPv6 address WITH its brackets ("[::1]"), which does not
/// parse as an address — the old check treated it as a name and let `http://[::1]/` straight through.
fn host_of(url: &reqwest::Url) -> Option<Host> {
    let h = url.host_str()?;
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    Some(match bare.parse::<IpAddr>() {
        Ok(ip) => Host::Ip(ip),
        Err(_) => Host::Name(h.to_string()),
    })
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

/// Readable text for the page, plus (for documentation reading) its `<pre>` code blocks in order, fenced,
/// and its links resolved against the page address. Scripts, styles and navigation chrome are never selected.
fn extract_page(html: &str, base: &reqwest::Url, docs: bool) -> (String, String, Vec<LinkDto>) {
    let doc = Html::parse_document(html);

    let title = Selector::parse("title")
        .ok()
        .and_then(|sel| doc.select(&sel).next())
        .map(|t| t.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    let selector = if docs { "h1, h2, h3, h4, p, li, pre" } else { "h1, h2, h3, h4, p, li" };
    let Ok(content_sel) = Selector::parse(selector) else {
        return (title, String::new(), vec![]);
    };
    let pre_sel = Selector::parse("pre").ok();

    let mut parts: Vec<String> = Vec::new();
    for el in doc.select(&content_sel) {
        let name = el.value().name();
        if name == "pre" {
            let code: String = el.text().collect::<String>();
            let code = code.trim_matches('\n').trim_end();
            if !code.trim().is_empty() {
                parts.push(format!("```\n{}\n```", code));
            }
            continue;
        }
        // A list item that holds a code block is represented by the block itself, not twice.
        if name == "li" && docs {
            if let Some(p) = &pre_sel {
                if el.select(p).next().is_some() {
                    continue;
                }
            }
        }
        let text: String = el.text().collect::<String>();
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }

    let mut links: Vec<LinkDto> = Vec::new();
    if docs {
        if let Ok(a_sel) = Selector::parse("a[href]") {
            let mut seen = std::collections::HashSet::new();
            for a in doc.select(&a_sel) {
                if links.len() >= MAX_LINKS {
                    break;
                }
                let Some(href) = a.value().attr("href") else { continue };
                let Ok(mut url) = base.join(href.trim()) else { continue };
                if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
                    continue;
                }
                url.set_fragment(None);
                let text = a.text().collect::<String>();
                let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if text.is_empty() || !seen.insert(url.to_string()) {
                    continue;
                }
                links.push(LinkDto { text: text.chars().take(80).collect(), url: url.to_string() });
            }
        }
    }
    (title, parts.join("\n"), links)
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

    // ---- documentation fetching (1.0.8) -------------------------------------------------------------------

    #[test]
    fn robots_rules_pick_the_atlas_group_then_star_and_longest_match_wins() {
        let r = parse_robots("User-agent: *\nDisallow: /private/\nAllow: /private/public.html\n\nUser-agent: Googlebot\nDisallow: /\n");
        assert!(robots_allows(&r, "/docs/intro"));
        assert!(!robots_allows(&r, "/private/secret"));
        assert!(robots_allows(&r, "/private/public.html"), "the longer Allow beats the shorter Disallow");
        let ours = parse_robots("User-agent: *\nDisallow: /\n\nUser-agent: AtlasAssistant\nDisallow: /nope\n");
        assert!(robots_allows(&ours, "/anything"), "a group for Atlas replaces the * group");
        assert!(!robots_allows(&ours, "/nope/page"));
    }

    #[test]
    fn robots_wildcards_and_anchors() {
        let r = parse_robots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*cache\n");
        assert!(!robots_allows(&r, "/a/b/file.pdf"));
        assert!(robots_allows(&r, "/a/file.pdf.html"));
        assert!(!robots_allows(&r, "/tmp/x/cache"));
        assert!(robots_allows(&parse_robots(""), "/x"), "no file means allowed");
        assert!(!robots_allows(&Robots { rules: vec![], closed: true }, "/x"), "a server error means closed for now");
        assert!(robots_allows(&parse_robots("User-agent: *\nDisallow:\n"), "/x"), "an empty Disallow allows everything");
    }

    #[test]
    fn documentation_extraction_keeps_code_in_order_and_resolves_links() {
        let html = r#"<html><head><title>Router docs</title><script>var secret = 1;</script></head><body>
            <nav><a href="/">Home</a></nav>
            <h1>Routing</h1><p>Use <code>createRouter</code> to start.</p>
            <pre><code>const r = createRouter({ routes })
r.start()</code></pre>
            <ul><li><a href="guide/nesting#top">Nesting</a></li><li><pre>inside a list</pre></li></ul>
            <a href="javascript:alert(1)">bad</a><a href="https://other.example/x">Other</a><a href="guide/nesting#again">Nesting again</a>
        </body></html>"#;
        let base = reqwest::Url::parse("https://docs.example.com/v2/intro").unwrap();
        let (title, text, links) = extract_page(html, &base, true);
        assert_eq!(title, "Router docs");
        assert!(text.contains("```\nconst r = createRouter({ routes })\nr.start()\n```"));
        assert!(text.find("Routing").unwrap() < text.find("createRouter({").unwrap(), "document order is kept");
        assert!(!text.contains("secret"), "scripts are never read");
        assert_eq!(text.matches("inside a list").count(), 1, "a list item holding code is not repeated");
        let urls: Vec<_> = links.iter().map(|l| l.url.as_str()).collect();
        assert!(urls.contains(&"https://docs.example.com/v2/guide/nesting"), "{urls:?}");
        assert_eq!(urls.iter().filter(|u| u.ends_with("/guide/nesting")).count(), 1, "fragments do not make a second link");
        assert!(urls.contains(&"https://other.example/x"));
        assert!(!urls.iter().any(|u| u.starts_with("javascript:")));
        // The plain reader is unchanged: no code blocks, no links.
        let (_, plain, none) = extract_page(html, &base, false);
        assert!(!plain.contains("```") && none.is_empty());
    }

    #[test]
    fn private_and_local_addresses_are_blocked_including_by_name() {
        assert!(!is_safe_fetch_target("http://127.0.0.1:8080/"));
        assert!(!is_safe_fetch_target("http://192.168.1.1/"));
        assert!(!is_safe_fetch_target("http://localhost/"));
        assert!(!is_safe_fetch_target("http://[::1]/"));
        assert!(ip_is_blocked("169.254.1.1".parse().unwrap()));
        assert!(ip_is_blocked("10.0.0.5".parse().unwrap()));
        assert!(ip_is_blocked("fe80::1".parse().unwrap()));
        assert!(!ip_is_blocked("93.184.216.34".parse().unwrap()));
        // A name that does not resolve is not a target.
        assert!(!tauri::async_runtime::block_on(target_is_safe("https://this-name-does-not-exist.invalid/")));
        assert!(!tauri::async_runtime::block_on(target_is_safe("http://localhost:3000/")));
    }

    #[test]
    fn addresses_with_a_login_and_non_web_schemes_are_refused_without_a_request() {
        assert!(tauri::async_runtime::block_on(fetch_doc_page("https://user:pass@example.com/".into())).unwrap_err().contains("login"));
        assert!(tauri::async_runtime::block_on(fetch_doc_page("file:///C:/Windows/win.ini".into())).unwrap_err().contains("http"));
        assert!(tauri::async_runtime::block_on(fetch_doc_page("ftp://example.com/x".into())).is_err());
    }

    /// Live (needs the internet), ignored by default: a real documentation page, politely.
    #[test]
    #[ignore]
    fn live_fetch_doc_page_reads_code_and_links_from_a_real_docs_site() {
        let page = tauri::async_runtime::block_on(fetch_doc_page("https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch".into())).unwrap();
        println!("title={:?} chars={} links={}", page.title, page.text.chars().count(), page.links.len());
        assert!(page.text.contains("```"), "a documentation page has code blocks");
        assert!(!page.links.is_empty());
        // Redirects are followed by hand and still end at a real page.
        let page = tauri::async_runtime::block_on(fetch_doc_page("http://developer.mozilla.org/en-US/docs/Web/API/Window/fetch".into())).unwrap();
        assert!(page.url.starts_with("https://"), "the http address redirected to https: {}", page.url);
    }
}
