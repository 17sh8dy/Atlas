//! SearXNG as a search backend the person points Atlas at.
//!
//! ## What this is, and what it is not
//!
//! SearXNG is a metasearch engine you run yourself (or reach on a server you trust). Atlas
//! can use one as a search backend, optionally, with no account and no API key. It is *not*
//! a general "fetch this URL" door and it does not choose a server for you:
//!
//!  - there is **no default instance**. Until a person types an address, this backend is
//!    "not set up" and no query is ever sent to it;
//!  - the address is stored and checked **here, in Rust**. The renderer never passes a URL
//!    along with a search; `web_search_with("searxng", …)` reads the configured one. So a
//!    compromised page cannot redirect a query somewhere by naming a host;
//!  - Atlas installs nothing and starts nothing: no Docker, no WSL, no service.
//!
//! ## Addresses, and why this is not "block localhost"
//!
//! People run SearXNG on their own machine (`http://127.0.0.1:8888`), so loopback is a
//! first-class, explicitly handled case rather than something to forbid. What matters is
//! that an address cannot be used to reach something the person did not mean to:
//!
//! | where it points                         | allowed when                                   |
//! | --------------------------------------- | ---------------------------------------------- |
//! | this machine (localhost, 127.x, ::1)    | always; plain http is fine                      |
//! | your local network (10.x, 192.168.x …)  | the person confirmed "this server is on my network" |
//! | the internet                            | https only                                      |
//! | link-local (169.254.x, fe80::), unspecified, multicast | never — the cloud-metadata range among them |
//!
//! A *name* is checked after it is resolved, and the connection is pinned to the address that
//! was checked, so a name that answers "public" to the check cannot answer "10.0.0.1" to the
//! connection (DNS rebinding). Redirects are never followed: a redirect is a way to be sent
//! somewhere the address check never saw. The address may not carry a login, a query string
//! or a fragment. Replies are size-capped and time-capped.
//!
//! ## Reporting
//!
//! The most common failure is a server with JSON output switched off (the default). That is
//! reported as exactly that, with the fix, rather than as a generic failure.

use std::net::{IpAddr, SocketAddr};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::web::{check_query, truncate_chars, SearchErr, WebSearchResultDto, MAX_RESULTS, MAX_SNIPPET_CHARS, USER_AGENT};

pub(crate) const STORAGE_KEY: &str = "atlas.searxng-endpoint";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_BODY_BYTES: usize = 1_500_000;
/// Everything is a "misconfiguration" tag the engine acts on: a server that is up but cannot
/// answer Atlas as asked. Not retried for a few minutes; fixing it in Settings clears it.
const MISCONFIGURED: &str = "misconfigured";

// ---- the stored setting ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredConfig {
    pub url: String,
    /// The person confirmed this server is on their own network (a private address).
    #[serde(default)]
    pub allow_private: bool,
}

/// Where an address points, for the person and for the checks.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Reach {
    ThisMachine,
    PrivateNetwork,
    Internet,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearxngView {
    pub configured: bool,
    pub url: String,
    pub allow_private: bool,
    pub reach: Option<Reach>,
}

// ---- addresses ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum EndpointError {
    /// Not a usable address, with what to change.
    Invalid(String),
    /// A private-network address the person has not confirmed.
    NeedsPrivate(String),
}

impl EndpointError {
    /// Matched by prefix on the TypeScript side to show the confirmation box.
    pub fn message(&self) -> String {
        match self {
            EndpointError::Invalid(m) => m.clone(),
            EndpointError::NeedsPrivate(m) => format!("private-network: {m}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// `scheme://host[:port][/prefix]`, no trailing slash. The search path is appended.
    pub base: String,
    pub host: String,
    pub port: u16,
    pub https: bool,
    pub reach: Reach,
    /// The host was written as an IP address (so there is nothing to resolve).
    pub ip_literal: Option<IpAddr>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpClass {
    Loopback,
    Private,
    Public,
    Forbidden,
}

fn classify_ip(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            if v4.is_loopback() {
                IpClass::Loopback
            } else if v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast() || v4.is_link_local() || o[0] == 0 {
                IpClass::Forbidden
            } else if v4.is_private() || (o[0] == 100 && (64..=127).contains(&o[1])) {
                // RFC 1918 and carrier-grade NAT: somebody's network, not the internet.
                IpClass::Private
            } else {
                IpClass::Public
            }
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return classify_ip(IpAddr::V4(mapped));
            }
            let s = v6.segments();
            if v6.is_loopback() {
                IpClass::Loopback
            } else if v6.is_unspecified() || v6.is_multicast() || (s[0] & 0xffc0) == 0xfe80 {
                IpClass::Forbidden
            } else if (s[0] & 0xfe00) == 0xfc00 {
                IpClass::Private
            } else {
                IpClass::Public
            }
        }
    }
}

/// Check an address as typed. Pure — no DNS — so a name's real destination is a separate,
/// later check (`resolve_checked`).
pub fn parse_endpoint(raw: &str, allow_private: bool) -> Result<Endpoint, EndpointError> {
    let bad = |m: &str| Err(EndpointError::Invalid(m.to_string()));
    let raw = raw.trim();
    if raw.is_empty() {
        return bad("Enter the address of your SearXNG server, like http://127.0.0.1:8888.");
    }
    let url = match reqwest::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return bad("That doesn't look like an address. Include http:// or https://, like http://127.0.0.1:8888."),
    };
    let https = match url.scheme() {
        "https" => true,
        "http" => false,
        _ => return bad("The address has to start with http:// or https://."),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return bad("Leave the username and password out of the address; Atlas doesn't send logins.");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return bad("Use just the server's address, without anything after a ? or #.");
    }
    let Some(host_str) = url.host_str() else {
        return bad("That address has no server name in it.");
    };
    let host = host_str.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(if https { 443 } else { 80 });

    let ip_literal = host.parse::<IpAddr>().ok();
    let reach = match ip_literal {
        Some(ip) => match classify_ip(ip) {
            IpClass::Loopback => Reach::ThisMachine,
            IpClass::Private => Reach::PrivateNetwork,
            IpClass::Public => Reach::Internet,
            IpClass::Forbidden => {
                return bad("That address can't be used: it is not a server on this machine, your network or the internet.");
            }
        },
        None if host == "localhost" || host.ends_with(".localhost") => Reach::ThisMachine,
        // A name: where it points is only known once it is resolved. Held to https unless the
        // person has said the server is on their own network.
        None => Reach::Internet,
    };

    if reach == Reach::PrivateNetwork && !allow_private {
        return Err(EndpointError::NeedsPrivate(
            "That address is on your local network. Confirm it is your own server to use it.".to_string(),
        ));
    }
    if !https && reach == Reach::Internet && !(allow_private && ip_literal.is_none()) {
        return bad("An address on the internet has to use https://, so your searches aren't sent in the clear.");
    }

    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/search").unwrap_or(path);
    if path.split('/').any(|seg| seg == ".." || seg == ".") {
        return bad("That address has a path Atlas won't follow.");
    }
    let shown_host = if host.contains(':') { format!("[{host}]") } else { host.clone() };
    let default_port = if https { 443 } else { 80 };
    let base = if port == default_port {
        format!("{}://{shown_host}{path}", url.scheme())
    } else {
        format!("{}://{shown_host}:{port}{path}", url.scheme())
    };
    Ok(Endpoint { base, host, port, https, reach, ip_literal })
}

/// Resolve a name and decide whether every address it gives is acceptable, returning the ones
/// the connection is allowed to use. An IP literal needs no lookup.
pub(crate) async fn resolve_checked(ep: &Endpoint, allow_private: bool) -> Result<Vec<SocketAddr>, SearchErr> {
    if let Some(ip) = ep.ip_literal {
        return Ok(vec![SocketAddr::new(ip, ep.port)]);
    }
    let lookup = tokio::net::lookup_host((ep.host.as_str(), ep.port)).await;
    let addrs: Vec<SocketAddr> = match lookup {
        Ok(it) => it.collect(),
        Err(_) => return Err(SearchErr::new("offline", format!("Couldn't find a server called {}.", ep.host))),
    };
    if addrs.is_empty() {
        return Err(SearchErr::new("offline", format!("Couldn't find a server called {}.", ep.host)));
    }
    let classes: Vec<IpClass> = addrs.iter().map(|a| classify_ip(a.ip())).collect();
    if classes.contains(&IpClass::Forbidden) {
        return Err(SearchErr::new(
            MISCONFIGURED,
            format!("{} points at an address Atlas won't use for search.", ep.host),
        ));
    }
    let all_local = classes.iter().all(|c| matches!(c, IpClass::Loopback | IpClass::Private));
    let any_local = classes.iter().any(|c| matches!(c, IpClass::Loopback | IpClass::Private));
    if ep.reach == Reach::ThisMachine {
        // "localhost" has to mean this machine, whatever a hosts file or resolver says.
        if !classes.iter().all(|c| *c == IpClass::Loopback) {
            return Err(SearchErr::new(MISCONFIGURED, "“localhost” resolved to an address that is not this machine."));
        }
    } else if any_local && !allow_private {
        // A public-looking name that answers with a private address is the DNS-rebinding shape.
        return Err(SearchErr::new(
            MISCONFIGURED,
            format!("{} points at a private address. If it is your own server, confirm that in Settings.", ep.host),
        ));
    } else if !ep.https && !all_local {
        // Plain http is only for servers wholly on a private network.
        return Err(SearchErr::new(MISCONFIGURED, "That name points at the internet, so it has to use https://."));
    }
    Ok(addrs)
}

// ---- the request -------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub(crate) struct Options {
    pub timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self { timeout: REQUEST_TIMEOUT }
    }
}

/// One search, end to end, for an address as stored. `allow_private` is the stored consent.
pub(crate) async fn search_configured(
    raw_url: &str,
    allow_private: bool,
    query: &str,
    topic: Option<&str>,
    options: Options,
) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let query = check_query(query)?;
    let ep = parse_endpoint(raw_url, allow_private).map_err(|e| SearchErr::new(MISCONFIGURED, e.message()))?;
    let addrs = resolve_checked(&ep, allow_private).await?;

    let mut builder = reqwest::Client::builder()
        .timeout(options.timeout)
        .connect_timeout(options.timeout.min(CONNECT_TIMEOUT))
        .user_agent(USER_AGENT)
        // A redirect is a route the address check never saw.
        .redirect(reqwest::redirect::Policy::none())
        // Atlas's own checked connection, not whatever proxy the environment names.
        .no_proxy();
    if ep.ip_literal.is_none() {
        // Connect to the addresses that were checked, not to whatever the name says next.
        builder = builder.resolve_to_addrs(&ep.host, &addrs);
    }
    let client = builder.build().map_err(|e| SearchErr::new("error", e.to_string()))?;

    let categories = if topic == Some("news") { "news" } else { "general" };
    let resp = client
        .get(format!("{}/search", ep.base))
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&[("q", query), ("format", "json"), ("categories", categories), ("pageno", "1")])
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                SearchErr::new("offline", "The SearXNG server took too long to answer.")
            } else {
                SearchErr::new("offline", "Couldn't reach the SearXNG server — is it running?")
            }
        })?;

    let status = resp.status();
    if status.is_redirection() {
        return Err(SearchErr::new(
            MISCONFIGURED,
            "The SearXNG address redirected somewhere else (often http to https). Use the address it redirects to.",
        ));
    }
    match status.as_u16() {
        200..=299 => {}
        401 => return Err(SearchErr::new("auth", "That SearXNG server asked for a login, which Atlas doesn't send.")),
        403 => {
            return Err(SearchErr::new(
                MISCONFIGURED,
                "This SearXNG server has JSON output turned off. In its settings.yml, add json under search → formats, then restart it.",
            ))
        }
        404 => return Err(SearchErr::new(MISCONFIGURED, "There is no SearXNG search page at that address.")),
        429 => return Err(SearchErr::new("rate", "The SearXNG server is rate-limiting requests right now.")),
        _ => return Err(SearchErr::new("error", format!("The SearXNG server returned {status}."))),
    }

    // Read at most MAX_BODY_BYTES: a server that streams forever is not a search engine.
    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SearchErr::new("error", "The SearXNG reply was cut off."))?;
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(SearchErr::new("error", "The SearXNG reply was larger than Atlas will read."));
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body);
    parse_response(&text)
}

// ---- the reply ---------------------------------------------------------------------------

/// A URL reduced to what makes two results "the same page": scheme folded, `www.` and
/// fragment dropped, tracking parameters removed, trailing slash ignored.
pub(crate) fn canonical_url(url: &str) -> String {
    let Ok(mut u) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    u.set_fragment(None);
    let keep: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !(k.starts_with("utm_") || matches!(k.as_str(), "fbclid" | "gclid" | "mc_cid" | "mc_eid" | "ref" | "ref_src"))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    u.set_query(None);
    if !keep.is_empty() {
        u.query_pairs_mut().extend_pairs(keep.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
    format!("{}{}{}", host, u.path().trim_end_matches('/'), u.query().map(|q| format!("?{q}")).unwrap_or_default())
}

/// SearXNG's JSON reply as results. Distinguishes "the server answered with a web page" (JSON
/// not enabled, or a proxy in the way) from "malformed" and from "no results".
pub(crate) fn parse_response(body: &str) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let trimmed = body.trim_start();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Err(if trimmed.starts_with('<') {
            SearchErr::new(
                MISCONFIGURED,
                "That address answered with a web page, not search results. It may not be SearXNG, or JSON output is off.",
            )
        } else {
            SearchErr::new("error", "The SearXNG reply wasn't readable.")
        });
    };
    let Some(items) = v.get("results").and_then(|r| r.as_array()) else {
        return Err(SearchErr::new("error", "That reply doesn't look like SearXNG search results."));
    };

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let url = item.get("url").and_then(|x| x.as_str()).unwrap_or("").trim();
        let title = item.get("title").and_then(|x| x.as_str()).unwrap_or("").trim();
        if title.is_empty() || !(url.starts_with("http://") || url.starts_with("https://")) {
            continue;
        }
        match reqwest::Url::parse(url) {
            Ok(u) if u.username().is_empty() && u.password().is_none() => {}
            _ => continue,
        }
        if !seen.insert(canonical_url(url)) {
            continue;
        }
        let content = item.get("content").and_then(|x| x.as_str()).unwrap_or("").trim();
        let published = item
            .get("publishedDate")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut engines: Vec<String> = item
            .get("engines")
            .and_then(|e| e.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        if engines.is_empty() {
            if let Some(e) = item.get("engine").and_then(|e| e.as_str()) {
                engines.push(e.to_string());
            }
        }
        engines.truncate(6);
        out.push(WebSearchResultDto {
            title: truncate_chars(title, 300),
            url: url.to_string(),
            snippet: truncate_chars(content, MAX_SNIPPET_CHARS),
            published_date: published,
            engines,
        });
        if out.len() >= MAX_RESULTS {
            break;
        }
    }

    if out.is_empty() {
        // Nothing came back. If that is because every upstream engine refused, say so — an
        // empty list would read as "nothing found" when the truth is "couldn't ask".
        let failed: Vec<(String, String)> = v
            .get("unresponsive_engines")
            .and_then(|u| u.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|e| {
                        let pair = e.as_array()?;
                        Some((pair.first()?.as_str()?.to_string(), pair.get(1).and_then(|r| r.as_str()).unwrap_or("").to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !failed.is_empty() {
            let detail = failed
                .iter()
                .take(4)
                .map(|(n, r)| if r.is_empty() { n.clone() } else { format!("{n} ({r})") })
                .collect::<Vec<_>>()
                .join(", ");
            let lower = detail.to_ascii_lowercase();
            return Err(if lower.contains("captcha") || lower.contains("denied") || lower.contains("blocked") {
                SearchErr::new("blocked", format!("SearXNG's search engines turned the request away: {detail}."))
            } else if lower.contains("too many") || lower.contains("rate") {
                SearchErr::new("rate", format!("SearXNG's search engines are rate-limiting it: {detail}."))
            } else {
                SearchErr::new("error", format!("SearXNG's search engines didn't answer: {detail}."))
            });
        }
    }
    Ok(out)
}

// ---- commands ----------------------------------------------------------------------------

/// The saved setting, held in memory like the Allowed Folders list: read once at startup
/// (`init`), replaced only by `searxng_configure`. A search takes no address from its caller.
fn current() -> &'static RwLock<Option<StoredConfig>> {
    static CONFIG: OnceLock<RwLock<Option<StoredConfig>>> = OnceLock::new();
    CONFIG.get_or_init(|| RwLock::new(None))
}

fn read_config() -> Option<StoredConfig> {
    current().read().ok().and_then(|c| c.clone())
}

/// Called once at startup with whatever was saved last time. A saved value that no longer
/// passes the address checks is dropped, not trusted.
pub fn init(saved: Option<serde_json::Value>) {
    let config = saved
        .and_then(|v| serde_json::from_value::<StoredConfig>(v).ok())
        .filter(|c| parse_endpoint(&c.url, c.allow_private).is_ok());
    if let Ok(mut slot) = current().write() {
        *slot = config;
    }
}

pub(crate) fn is_configured() -> bool {
    read_config().is_some()
}

/// The backend arm of `web_search_with`. Reads the configured address; takes none from the caller.
pub(crate) async fn search(query: &str, topic: Option<&str>) -> Result<Vec<WebSearchResultDto>, SearchErr> {
    let Some(config) = read_config() else {
        return Err(SearchErr::new("auth", "No SearXNG server is set up."));
    };
    search_configured(&config.url, config.allow_private, query, topic, Options::default()).await
}

fn view_of(config: Option<&StoredConfig>) -> SearxngView {
    match config {
        None => SearxngView { configured: false, url: String::new(), allow_private: false, reach: None },
        Some(c) => SearxngView {
            configured: true,
            url: c.url.clone(),
            allow_private: c.allow_private,
            reach: parse_endpoint(&c.url, c.allow_private).ok().map(|e| e.reach),
        },
    }
}

/// What is set up now. A read.
#[tauri::command]
pub fn searxng_config() -> SearxngView {
    view_of(read_config().as_ref())
}

/// Save (or, with an empty address, clear) the server. Validated here; the stored value is
/// what every later search uses. A person operates this from Settings.
#[tauri::command]
pub fn searxng_configure(app: AppHandle, url: String, allow_private: bool) -> Result<SearxngView, String> {
    let state = app.state::<crate::storage::StorageState>();
    if url.trim().is_empty() {
        crate::storage::storage_remove(app.clone(), state, STORAGE_KEY.to_string())?;
        if let Ok(mut slot) = current().write() {
            *slot = None;
        }
        return Ok(view_of(None));
    }
    let ep = parse_endpoint(&url, allow_private).map_err(|e| e.message())?;
    let config = StoredConfig {
        url: ep.base,
        // Remembered only where it matters: a confirmation for a server that is not private is noise.
        allow_private: allow_private && ep.reach != Reach::ThisMachine,
    };
    crate::storage::storage_set(
        app.clone(),
        state,
        STORAGE_KEY.to_string(),
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    )?;
    if let Ok(mut slot) = current().write() {
        *slot = Some(config.clone());
    }
    Ok(view_of(Some(&config)))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearxngTestReport {
    pub ok: bool,
    /// `ok`, `not-set-up`, `unreachable`, `json-off-or-misconfigured`, `rate-limited`, `blocked`,
    /// `login-required`, `invalid`.
    pub status: &'static str,
    pub message: String,
    pub result_count: usize,
}

pub(crate) fn report_for(outcome: Result<Vec<WebSearchResultDto>, SearchErr>) -> SearxngTestReport {
    match outcome {
        Ok(rows) => SearxngTestReport {
            ok: true,
            status: "ok",
            message: if rows.is_empty() {
                "The server answered, but found nothing for the test search.".to_string()
            } else {
                format!("Working — {} results for the test search.", rows.len())
            },
            result_count: rows.len(),
        },
        Err(e) => {
            let status = match e.kind {
                "offline" => "unreachable",
                MISCONFIGURED => "json-off-or-misconfigured",
                "rate" => "rate-limited",
                "blocked" => "blocked",
                "auth" => "login-required",
                _ => "invalid",
            };
            SearxngTestReport { ok: false, status, message: e.msg, result_count: 0 }
        }
    }
}

/// One real search against the configured server, reported in words. Costs one query.
#[tauri::command]
pub async fn searxng_test() -> SearxngTestReport {
    if read_config().is_none() {
        return SearxngTestReport {
            ok: false,
            status: "not-set-up",
            message: "No SearXNG server is set up yet.".to_string(),
            result_count: 0,
        };
    }
    report_for(search("Atlas connection test", None).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ---- address validation -----------------------------------------------------------

    #[test]
    fn this_machine_is_a_first_class_address() {
        for raw in ["http://127.0.0.1:8888", "http://localhost:8888", "http://[::1]:8888", "https://127.0.0.1", "http://searx.localhost"] {
            let ep = parse_endpoint(raw, false).unwrap_or_else(|e| panic!("{raw}: {e:?}"));
            assert_eq!(ep.reach, Reach::ThisMachine, "{raw}");
        }
        assert_eq!(parse_endpoint("http://127.0.0.1:8888", false).unwrap().base, "http://127.0.0.1:8888");
        // The loopback range is wider than one address.
        assert_eq!(parse_endpoint("http://127.5.5.5:1", false).unwrap().reach, Reach::ThisMachine);
    }

    #[test]
    fn a_private_network_address_needs_the_person_to_say_so() {
        for raw in ["http://192.168.1.20:8080", "http://10.0.0.5", "http://172.16.4.4", "http://100.64.1.1", "http://[fd00::5]:80"] {
            assert!(matches!(parse_endpoint(raw, false), Err(EndpointError::NeedsPrivate(_))), "{raw}");
            let ep = parse_endpoint(raw, true).unwrap_or_else(|e| panic!("{raw}: {e:?}"));
            assert_eq!(ep.reach, Reach::PrivateNetwork, "{raw}");
        }
        let msg = parse_endpoint("http://192.168.1.20", false).unwrap_err().message();
        assert!(msg.starts_with("private-network:"), "{msg}");
    }

    #[test]
    fn an_address_on_the_internet_must_be_https() {
        assert!(parse_endpoint("http://searx.example.org", false).is_err());
        assert!(parse_endpoint("http://8.8.8.8:8888", false).is_err());
        assert!(parse_endpoint("http://8.8.8.8:8888", true).is_err(), "confirming a private network does not allow plain http to a public IP");
        assert_eq!(parse_endpoint("https://searx.example.org", false).unwrap().reach, Reach::Internet);
        assert!(parse_endpoint("https://8.8.8.8", false).is_ok());
    }

    #[test]
    fn a_name_may_use_plain_http_only_when_the_person_says_it_is_their_network() {
        assert!(parse_endpoint("http://searx.home.arpa:8080", false).is_err());
        let ep = parse_endpoint("http://searx.home.arpa:8080", true).unwrap();
        assert!(!ep.https);
    }

    #[test]
    fn addresses_that_are_never_a_search_server_are_refused_even_when_confirmed() {
        for raw in [
            "http://169.254.169.254",    // cloud metadata
            "http://169.254.1.1",
            "http://0.0.0.0:8888",
            "http://224.0.0.1",
            "http://255.255.255.255",
            "http://[fe80::1]",
            "http://[ff02::1]",
            "http://[::]",
            "http://0.1.2.3",
        ] {
            assert!(parse_endpoint(raw, true).is_err(), "{raw} must be refused");
            assert!(parse_endpoint(raw, false).is_err(), "{raw} must be refused");
        }
    }

    #[test]
    fn an_ipv4_address_in_ipv6_clothing_is_classified_as_what_it_is() {
        assert!(parse_endpoint("http://[::ffff:169.254.169.254]", true).is_err());
        assert_eq!(parse_endpoint("http://[::ffff:127.0.0.1]:8888", false).unwrap().reach, Reach::ThisMachine);
        assert!(matches!(parse_endpoint("http://[::ffff:10.0.0.1]", false), Err(EndpointError::NeedsPrivate(_))));
    }

    #[test]
    fn the_address_cannot_smuggle_a_login_a_query_or_another_scheme() {
        assert!(parse_endpoint("http://user:pw@127.0.0.1:8888", false).is_err());
        assert!(parse_endpoint("http://user@127.0.0.1", false).is_err());
        assert!(parse_endpoint("http://127.0.0.1:8888/?q=1", false).is_err());
        assert!(parse_endpoint("http://127.0.0.1:8888/#x", false).is_err());
        assert!(parse_endpoint("ftp://127.0.0.1", false).is_err());
        assert!(parse_endpoint("file:///C:/Windows", false).is_err());
        assert!(parse_endpoint("javascript:alert(1)", false).is_err());
        assert!(parse_endpoint("", false).is_err());
        assert!(parse_endpoint("   ", false).is_err());
        assert!(parse_endpoint("not a url", false).is_err());
    }

    #[test]
    fn a_name_that_merely_starts_with_localhost_is_not_this_machine() {
        // `localhost.evil.example` must not be treated as loopback.
        assert!(parse_endpoint("http://localhost.evil.example:8888", false).is_err());
        assert_eq!(parse_endpoint("https://localhost.evil.example", false).unwrap().reach, Reach::Internet);
        // And a userinfo trick: the host is what follows the @.
        assert!(parse_endpoint("http://127.0.0.1@evil.example", false).is_err());
    }

    #[test]
    fn a_pasted_search_path_and_trailing_slash_are_tidied_and_a_prefix_is_kept() {
        assert_eq!(parse_endpoint("http://127.0.0.1:8888/", false).unwrap().base, "http://127.0.0.1:8888");
        assert_eq!(parse_endpoint("http://127.0.0.1:8888/search", false).unwrap().base, "http://127.0.0.1:8888");
        assert_eq!(parse_endpoint("https://example.org/searxng/", false).unwrap().base, "https://example.org/searxng");
        assert_eq!(parse_endpoint("https://EXAMPLE.org:443", false).unwrap().base, "https://example.org");
    }

    #[test]
    fn ip_classes() {
        let c = |s: &str| classify_ip(s.parse().unwrap());
        assert_eq!(c("127.0.0.1"), IpClass::Loopback);
        assert_eq!(c("::1"), IpClass::Loopback);
        assert_eq!(c("192.168.0.1"), IpClass::Private);
        assert_eq!(c("172.31.255.255"), IpClass::Private);
        assert_eq!(c("172.32.0.1"), IpClass::Public);
        assert_eq!(c("1.1.1.1"), IpClass::Public);
        assert_eq!(c("169.254.169.254"), IpClass::Forbidden);
        assert_eq!(c("2606:4700::1111"), IpClass::Public);
    }

    // ---- name resolution --------------------------------------------------------------

    #[tokio::test]
    async fn localhost_resolves_to_this_machine_and_is_accepted() {
        let ep = parse_endpoint("http://localhost:8888", false).unwrap();
        let addrs = resolve_checked(&ep, false).await.expect("localhost resolves to loopback");
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|a| a.ip().is_loopback()));
    }

    #[tokio::test]
    async fn a_name_that_does_not_exist_is_reported_as_unreachable_not_as_a_bad_setting() {
        let ep = parse_endpoint("https://this-name-does-not-exist.invalid", false).unwrap();
        let err = resolve_checked(&ep, false).await.unwrap_err();
        assert_eq!(err.kind, "offline");
    }

    // ---- replies ----------------------------------------------------------------------

    const GOOD: &str = r#"{
      "query": "rust",
      "number_of_results": 0,
      "results": [
        {"url": "https://www.rust-lang.org/", "title": "Rust Programming Language", "content": "A language empowering everyone.", "engine": "duckduckgo", "engines": ["duckduckgo", "brave"], "score": 3.2, "publishedDate": "2024-05-01T00:00:00"},
        {"url": "https://rust-lang.org/#top", "title": "Rust (duplicate)", "content": "dup", "engine": "google"},
        {"url": "https://doc.rust-lang.org/book/?utm_source=x", "title": "The Book", "content": "Learn Rust.", "engine": "brave"},
        {"url": "javascript:alert(1)", "title": "Bad scheme", "content": ""},
        {"url": "https://example.org/", "title": "", "content": "no title"},
        {"url": "https://user:pw@example.org/", "title": "With a login", "content": ""}
      ],
      "unresponsive_engines": [["google", "timeout"]]
    }"#;

    #[test]
    fn a_normal_reply_becomes_clean_attributed_results() {
        let rows = parse_response(GOOD).unwrap();
        let urls: Vec<&str> = rows.iter().map(|r| r.url.as_str()).collect();
        // The duplicate (www/fragment) and the three unusable entries are gone.
        assert_eq!(urls, vec!["https://www.rust-lang.org/", "https://doc.rust-lang.org/book/?utm_source=x"]);
        assert_eq!(rows[0].title, "Rust Programming Language");
        assert_eq!(rows[0].snippet, "A language empowering everyone.");
        assert_eq!(rows[0].published_date.as_deref(), Some("2024-05-01T00:00:00"));
        assert_eq!(rows[0].engines, vec!["duckduckgo", "brave"]);
        // A single `engine` field is used when `engines` is absent.
        assert_eq!(rows[1].engines, vec!["brave"]);
    }

    #[test]
    fn a_reply_with_no_results_is_empty_not_an_error() {
        assert_eq!(parse_response(r#"{"results": []}"#).unwrap().len(), 0);
        assert_eq!(parse_response(r#"{"results": [], "unresponsive_engines": []}"#).unwrap().len(), 0);
    }

    #[test]
    fn no_results_because_every_engine_refused_is_said_so() {
        let blocked = parse_response(r#"{"results": [], "unresponsive_engines": [["duckduckgo","CAPTCHA"],["google","access denied"]]}"#).unwrap_err();
        assert_eq!(blocked.kind, "blocked");
        assert!(blocked.msg.contains("duckduckgo (CAPTCHA)"));
        let rate = parse_response(r#"{"results": [], "unresponsive_engines": [["brave","too many requests"]]}"#).unwrap_err();
        assert_eq!(rate.kind, "rate");
        let other = parse_response(r#"{"results": [], "unresponsive_engines": [["bing","timeout"]]}"#).unwrap_err();
        assert_eq!(other.kind, "error");
    }

    #[test]
    fn some_engines_failing_does_not_hide_results_that_arrived() {
        let rows = parse_response(r#"{"results":[{"url":"https://a.example/","title":"A"}],"unresponsive_engines":[["google","timeout"]]}"#).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn a_web_page_where_json_was_expected_is_reported_as_a_setup_problem() {
        let err = parse_response("<!doctype html><html><body>SearXNG</body></html>").unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
        assert!(err.msg.contains("web page"));
    }

    #[test]
    fn malformed_replies_are_errors_and_never_panics() {
        for body in ["", "not json", "{\"results\": 5}", "{}", "[1,2,3]", "{\"results\": [", "null"] {
            assert!(parse_response(body).is_err(), "{body:?}");
        }
        // Wrong-typed fields inside otherwise valid results are skipped, not fatal.
        let rows = parse_response(r#"{"results":[{"url":5,"title":6},{"url":"https://ok.example/","title":"ok","content":7,"engines":"x"}]}"#).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn results_are_capped_and_snippets_are_bounded() {
        let many: Vec<String> = (0..40).map(|i| format!(r#"{{"url":"https://e{i}.example/","title":"T{i}","content":"{}"}}"#, "x".repeat(2000))).collect();
        let rows = parse_response(&format!(r#"{{"results":[{}]}}"#, many.join(","))).unwrap();
        assert_eq!(rows.len(), MAX_RESULTS);
        assert!(rows.iter().all(|r| r.snippet.chars().count() <= MAX_SNIPPET_CHARS + 1));
    }

    #[test]
    fn canonical_urls_fold_the_variants_of_one_page() {
        assert_eq!(canonical_url("https://www.Example.org/a/"), canonical_url("http://example.org/a#frag"));
        assert_eq!(canonical_url("https://example.org/a?utm_source=x&id=1"), canonical_url("https://example.org/a?id=1"));
        assert_ne!(canonical_url("https://example.org/a?id=1"), canonical_url("https://example.org/a?id=2"));
    }

    #[test]
    fn the_test_report_says_what_to_do() {
        let ok = report_for(Ok(vec![]));
        assert!(ok.ok);
        assert!(ok.message.contains("found nothing"));
        let off = report_for(Err(SearchErr::new(MISCONFIGURED, "JSON is off")));
        assert!(!off.ok);
        assert_eq!(off.status, "json-off-or-misconfigured");
        assert_eq!(report_for(Err(SearchErr::new("offline", "x"))).status, "unreachable");
        assert_eq!(report_for(Err(SearchErr::new("rate", "x"))).status, "rate-limited");
    }

    // ---- a mock server --------------------------------------------------------------

    /// Answers each accepted connection with the next canned reply (raw HTTP), then closes.
    async fn mock(replies: Vec<Vec<u8>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for reply in replies {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(&reply).await;
                let _ = sock.shutdown().await;
            }
        });
        port
    }

    /// A server that accepts and then says nothing for a long time.
    async fn silent() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock);
            }
        });
        port
    }

    fn http(status: &str, headers: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).into_bytes()
    }

    fn quick() -> Options {
        Options { timeout: Duration::from_millis(600) }
    }

    async fn search_mock(reply: Vec<u8>) -> Result<Vec<WebSearchResultDto>, SearchErr> {
        let port = mock(vec![reply]).await;
        search_configured(&format!("http://127.0.0.1:{port}"), false, "rust", None, quick()).await
    }

    #[tokio::test]
    async fn a_valid_json_reply_from_a_localhost_server_returns_results() {
        let rows = search_mock(http("200 OK", "Content-Type: application/json\r\n", GOOD)).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].url, "https://www.rust-lang.org/");
    }

    #[tokio::test]
    async fn the_request_asks_for_json_and_carries_the_query() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let _ = sock.write_all(&http("200 OK", "", r#"{"results":[]}"#)).await;
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        search_configured(&format!("http://127.0.0.1:{port}"), false, "hello world", Some("news"), quick()).await.unwrap();
        let req = seen.await.unwrap();
        let first = req.lines().next().unwrap();
        assert!(first.starts_with("GET /search?"), "{first}");
        assert!(first.contains("format=json"), "{first}");
        assert!(first.contains("q=hello+world") || first.contains("q=hello%20world"), "{first}");
        assert!(first.contains("categories=news"), "{first}");
        assert!(req.to_ascii_lowercase().contains("accept: application/json"));
    }

    #[tokio::test]
    async fn an_empty_result_list_is_an_empty_success() {
        let rows = search_mock(http("200 OK", "", r#"{"results":[]}"#)).await.unwrap();
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn a_403_is_reported_as_json_output_being_off_with_the_fix() {
        let err = search_mock(http("403 Forbidden", "", "<html>Forbidden</html>")).await.unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
        assert!(err.msg.contains("JSON output turned off"), "{}", err.msg);
        assert!(err.msg.contains("settings.yml"));
    }

    #[tokio::test]
    async fn html_with_a_200_is_not_mistaken_for_results() {
        let err = search_mock(http("200 OK", "Content-Type: text/html\r\n", "<html><body>Hi</body></html>")).await.unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
    }

    #[tokio::test]
    async fn a_malformed_reply_is_an_error() {
        let err = search_mock(http("200 OK", "", r#"{"results": [ {"url": "#)).await.unwrap_err();
        assert_eq!(err.kind, "error");
    }

    #[tokio::test]
    async fn rate_limiting_is_reported_as_such() {
        let err = search_mock(http("429 Too Many Requests", "", "slow down")).await.unwrap_err();
        assert_eq!(err.kind, "rate");
    }

    #[tokio::test]
    async fn a_login_wall_and_a_missing_page_and_a_server_error_each_say_so() {
        assert_eq!(search_mock(http("401 Unauthorized", "", "")).await.unwrap_err().kind, "auth");
        assert_eq!(search_mock(http("404 Not Found", "", "")).await.unwrap_err().kind, MISCONFIGURED);
        assert_eq!(search_mock(http("500 Internal Server Error", "", "")).await.unwrap_err().kind, "error");
    }

    #[tokio::test]
    async fn a_redirect_is_reported_and_never_followed() {
        // The second listener would receive the follow-up request if Atlas followed the redirect.
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        let followed = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_millis(500), target.accept()).await.is_ok()
        });
        let location = format!("Location: http://127.0.0.1:{target_port}/search\r\n");
        let err = search_mock(http("302 Found", &location, "")).await.unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
        assert!(err.msg.contains("redirected"));
        assert!(!followed.await.unwrap(), "the redirect target must never be contacted");
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_or_metadata_address_is_equally_not_followed() {
        let location = "Location: http://169.254.169.254/latest/meta-data/\r\n";
        let err = search_mock(http("301 Moved Permanently", location, "")).await.unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
    }

    #[tokio::test]
    async fn a_connection_that_is_refused_is_unreachable() {
        // Bind then drop, so the port is closed.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let err = search_configured(&format!("http://127.0.0.1:{port}"), false, "rust", None, quick()).await.unwrap_err();
        assert_eq!(err.kind, "offline");
        // Windows can take longer than a short test timeout to refuse a closed port, so either
        // honest wording is correct; what matters is that it is "unreachable", not a setup fault.
        assert!(err.msg.contains("is it running") || err.msg.contains("too long"), "{}", err.msg);
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let port = silent().await;
        let started = std::time::Instant::now();
        let err = search_configured(&format!("http://127.0.0.1:{port}"), false, "rust", None, quick()).await.unwrap_err();
        assert_eq!(err.kind, "offline");
        assert!(err.msg.contains("too long"), "{}", err.msg);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_reply_larger_than_the_cap_is_refused_not_buffered() {
        let big = format!(r#"{{"results":[],"pad":"{}"}}"#, "x".repeat(MAX_BODY_BYTES + 10));
        let err = search_mock(http("200 OK", "", &big)).await.unwrap_err();
        assert_eq!(err.kind, "error");
        assert!(err.msg.contains("larger"));
    }

    #[tokio::test]
    async fn an_unsafe_configured_address_is_refused_before_anything_is_sent() {
        for raw in ["http://169.254.169.254", "http://user:pw@127.0.0.1", "http://example.org", "ftp://127.0.0.1"] {
            let err = search_configured(raw, false, "rust", None, quick()).await.unwrap_err();
            assert_eq!(err.kind, MISCONFIGURED, "{raw}");
        }
        // A private address that was never confirmed is refused too.
        let err = search_configured("http://192.168.1.50:8888", false, "rust", None, quick()).await.unwrap_err();
        assert_eq!(err.kind, MISCONFIGURED);
        assert!(err.msg.starts_with("private-network:"));
    }

    #[tokio::test]
    async fn an_empty_or_oversized_query_is_refused_without_a_request() {
        let err = search_configured("http://127.0.0.1:1", false, "   ", None, quick()).await.unwrap_err();
        assert_eq!(err.kind, "error");
        let long = "a".repeat(500);
        let err = search_configured("http://127.0.0.1:1", false, &long, None, quick()).await.unwrap_err();
        assert!(err.msg.contains("too long"));
    }

    // ---- the storage key --------------------------------------------------------------

    #[test]
    fn the_storage_key_is_one_storage_accepts() {
        assert!(crate::storage::is_valid_key(STORAGE_KEY));
    }
}
