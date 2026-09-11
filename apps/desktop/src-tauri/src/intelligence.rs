//! The one path to reasoning Atlas doesn't do itself: **Cortex**.
//!
//! ## Cortex is the only one, and that is the point
//!
//! This file used to hold two commands — `ask_claude` and `ask_openai` —
//! posting to `api.anthropic.com` and `api.openai.com` with a user-supplied
//! key. Both are gone. Atlas escalates to exactly one place now, and that
//! place runs on this machine.
//!
//! The reason is the one that removed Supabase from this project: an
//! assistant that reads your files, watches your processes and knows your
//! habits should not also hold a credential for somebody else's datacentre
//! and a habit of posting your questions to it. Every provider added is a
//! privacy story that has to be defended forever. One local provider is a
//! story that defends itself.
//!
//! ## Why this is in Rust at all
//!
//! Cortex is reached over plain HTTP on the loopback interface, which the
//! webview could technically do itself with `fetch`. It happens here anyway,
//! for two reasons: the webview would need Cortex to send CORS headers back
//! — making Atlas's transport a constraint on a separate project's server —
//! and routing it through the Tauri command boundary keeps the base URL
//! validated in one place. See `validate_base_url`, which is what stops a
//! stored preference from turning this into a general-purpose HTTP client
//! pointed anywhere the caller likes.
//!
//! ## Loopback only, enforced here
//!
//! `validate_base_url` rejects anything that is not `127.0.0.1`, `localhost`
//! or `::1`. That is not decoration: without it, "the Cortex endpoint" is a
//! settings field that would let a request go anywhere — precisely the cloud
//! fallback this file was rewritten to remove.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Emitter;

/// Local inference is not fast, and a first call may load a model from disk.
/// Generous compared to a network call, because none of this is a network
/// call in the sense that matters.
const REQUEST_TIMEOUT_SECS: u64 = 120;
const MAX_PROMPT_CHARS: usize = 100_000;

/// Where Cortex listens when nothing says otherwise.
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8765";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

/// The whole security boundary of this module.
///
/// Only loopback. A hostname that merely *contains* "localhost"
/// (`localhost.evil.com`) is rejected, which is why this parses the host out
/// rather than calling `contains`.
fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(DEFAULT_BASE_URL.to_string());
    }

    let parsed =
        reqwest::Url::parse(trimmed).map_err(|_| "That doesn't look like a URL.".to_string())?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Cortex has to be reached over http.".into());
    }

    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => {
            Ok(trimmed.to_string())
        }
        _ => Err("Cortex has to run on this machine — only 127.0.0.1 or localhost.".into()),
    }
}

fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Nothing to ask.".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("That's too long to send.".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct CortexRequest<'a> {
    prompt: &'a str,
}

#[derive(Deserialize)]
struct CortexResponse {
    /// The answer. `text` is the field name; `response` is accepted as an
    /// alias so a Cortex build that used the more obvious word still works.
    #[serde(alias = "response")]
    text: Option<String>,
}

#[derive(Deserialize)]
struct CortexErrorBody {
    error: Option<String>,
    detail: Option<String>,
}

/// Ask Cortex a question.
///
/// Returns the sentinel string `offline` when Cortex simply is not running,
/// because that is not an error anyone needs a paragraph about — the renderer
/// maps it onto `ProviderStreamHandlers`' `offline` reason and Atlas carries
/// on with everything it can do without a model, which is nearly everything.
#[tauri::command]
pub async fn ask_cortex(base_url: String, prompt: String) -> Result<String, String> {
    validate_prompt(&prompt)?;
    let base = validate_base_url(&base_url)?;
    let client = http_client()?;

    let resp = client
        .post(format!("{base}/v1/ask"))
        .json(&CortexRequest { prompt: &prompt })
        .send()
        .await
        // A refused connection means Cortex isn't up. Deliberately not
        // dressed up as a failure: it is the normal state on a machine where
        // Cortex was never started.
        .map_err(|_| "offline".to_string())?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|_| "Couldn't read Cortex's response.".to_string())?;

    if !status.is_success() {
        return Err(cortex_error_message(status.as_u16(), &text));
    }

    let parsed: CortexResponse = serde_json::from_str(&text)
        .map_err(|_| "Cortex's response didn't look like what I expected.".to_string())?;

    extract_cortex_text(&parsed)
}

fn extract_cortex_text(resp: &CortexResponse) -> Result<String, String> {
    match resp.text.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => Ok(t.to_string()),
        _ => Err("Cortex didn't return any text.".into()),
    }
}

fn cortex_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<CortexErrorBody>(body)
        .ok()
        .and_then(|e| e.error.or(e.detail));
    match status {
        404 => "Cortex is running but has no /v1/ask endpoint.".to_string(),
        503 => "Cortex is running but has no model loaded yet.".to_string(),
        _ => detail.unwrap_or_else(|| format!("Cortex returned {status}.")),
    }
}

/// One `data: {...}` event out of Cortex's SSE stream, decoded into what the
/// caller below actually needs. `None` for a line that wasn't a `data:` line
/// or wasn't valid JSON — a stream is read best-effort, not line-by-line
/// asserted.
enum CortexEvent {
    Delta(String),
    Done { ok: bool, text: String, error: Option<String> },
}

fn parse_cortex_event(data: &str) -> Option<CortexEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    if value.get("done").and_then(|d| d.as_bool()) == Some(true) {
        return Some(CortexEvent::Done {
            ok: value.get("ok").and_then(|o| o.as_bool()).unwrap_or(false),
            text: value.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            error: value.get("error").and_then(|e| e.as_str()).map(String::from),
        });
    }
    let delta = value.get("delta").and_then(|d| d.as_str())?;
    Some(CortexEvent::Delta(delta.to_string()))
}

/// Where one SSE event ends and the next begins, and how much of the buffer
/// to drop once it's consumed. Checked in this order deliberately: searching
/// for the bare `\n\n` first would also match the second half of a `\r\n\r\n`
/// pair, corrupting the next event's leading byte.
fn find_event_boundary(buf: &str) -> Option<(usize, usize)> {
    if let Some(idx) = buf.find("\r\n\r\n") {
        return Some((idx, idx + 4));
    }
    buf.find("\n\n").map(|idx| (idx, idx + 2))
}

/// Read Cortex's SSE body incrementally, forwarding each delta to
/// `atlas://intelligence/{stream_id}` as it arrives, and resolve with the
/// full answer once the stream's own `"done"` event says so. The event
/// carries the complete text itself (not just the accumulated deltas) —
/// see `_handle_ask_stream`'s doc comment on the Cortex side — so a delta
/// this function fails to forward for any reason still doesn't cost the
/// final answer's correctness.
async fn consume_cortex_sse(
    app: &tauri::AppHandle,
    stream_id: &str,
    response: reqwest::Response,
) -> Result<String, String> {
    let channel = format!("atlas://intelligence/{stream_id}");
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut resolution: Option<Result<String, String>> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Cortex's stream was interrupted: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some((end, next_start)) = find_event_boundary(&buffer) {
            let event_text = buffer[..end].to_string();
            buffer.drain(..next_start);

            for line in event_text.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                match parse_cortex_event(data.trim()) {
                    Some(CortexEvent::Delta(delta)) => {
                        let _ = app.emit(&channel, &delta);
                    }
                    Some(CortexEvent::Done { ok, text, error }) => {
                        resolution = Some(if ok {
                            Ok(text)
                        } else {
                            Err(error.unwrap_or_else(|| "Cortex couldn't answer.".to_string()))
                        });
                    }
                    None => {}
                }
            }
        }

        if resolution.is_some() {
            break;
        }
    }

    resolution.unwrap_or_else(|| {
        Err("Cortex's stream ended before it finished answering.".to_string())
    })
}

/// The streaming twin of `ask_cortex` — same validation, same loopback-only
/// endpoint check, a different path on the wire (`/v1/ask/stream`). Deltas
/// arrive as `atlas://intelligence/{stream_id}` events while this call is in
/// flight; the call itself still resolves with the complete answer, so a
/// caller that never subscribed to the channel still gets the right text —
/// exactly the degrade-cleanly contract `providers.ts` already relies on.
#[tauri::command]
pub async fn ask_cortex_stream(
    app: tauri::AppHandle,
    base_url: String,
    prompt: String,
    stream_id: String,
) -> Result<String, String> {
    validate_prompt(&prompt)?;
    let base = validate_base_url(&base_url)?;
    let client = http_client()?;

    let resp = client
        .post(format!("{base}/v1/ask/stream"))
        .json(&CortexRequest { prompt: &prompt })
        .send()
        .await
        .map_err(|_| "offline".to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(cortex_error_message(status.as_u16(), &text));
    }

    consume_cortex_sse(&app, &stream_id, resp).await
}

/// Is Cortex up? Lets Settings show a live state rather than a guess.
#[tauri::command]
pub async fn cortex_reachable(base_url: String) -> Result<bool, String> {
    let base = validate_base_url(&base_url)?;
    let client = reqwest::Client::builder()
        // A reachability probe that takes a minute is not a probe.
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(format!("{base}/health")).send().await {
        Ok(r) => Ok(r.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_prompt() {
        assert!(validate_prompt("").is_err());
        assert!(validate_prompt("   ").is_err());
    }

    #[test]
    fn accepts_a_real_looking_prompt() {
        assert!(validate_prompt("what does RAM actually do?").is_ok());
    }

    #[test]
    fn an_empty_base_url_falls_back_to_the_default() {
        assert_eq!(validate_base_url("").unwrap(), DEFAULT_BASE_URL);
        assert_eq!(validate_base_url("   ").unwrap(), DEFAULT_BASE_URL);
    }

    #[test]
    fn loopback_is_allowed() {
        assert!(validate_base_url("http://127.0.0.1:8765").is_ok());
        assert!(validate_base_url("http://localhost:9000").is_ok());
    }

    #[test]
    fn a_trailing_slash_is_normalised_away() {
        assert_eq!(
            validate_base_url("http://127.0.0.1:8765/").unwrap(),
            "http://127.0.0.1:8765"
        );
    }

    /// The test this module exists for. If any of these ever start passing,
    /// the "Cortex is the only cloud AI" guarantee is gone.
    #[test]
    fn anything_that_is_not_loopback_is_refused() {
        for url in [
            "https://api.openai.com",
            "https://api.anthropic.com",
            "https://generativelanguage.googleapis.com",
            "http://192.168.1.10:8765",
            "http://example.com",
            // The reason the host is parsed rather than substring-matched.
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
        ] {
            assert!(validate_base_url(url).is_err(), "should have refused {url}");
        }
    }

    #[test]
    fn a_non_http_scheme_is_refused() {
        assert!(validate_base_url("file:///etc/passwd").is_err());
        assert!(validate_base_url("ftp://127.0.0.1").is_err());
    }

    #[test]
    fn extracts_the_answer() {
        let parsed: CortexResponse =
            serde_json::from_str(r#"{"text": "RAM is working memory."}"#).unwrap();
        assert_eq!(
            extract_cortex_text(&parsed).unwrap(),
            "RAM is working memory."
        );
    }

    #[test]
    fn accepts_response_as_an_alias_for_text() {
        let parsed: CortexResponse = serde_json::from_str(r#"{"response": "Answered."}"#).unwrap();
        assert_eq!(extract_cortex_text(&parsed).unwrap(), "Answered.");
    }

    #[test]
    fn an_empty_answer_is_an_error_not_an_empty_reply() {
        let parsed: CortexResponse = serde_json::from_str(r#"{"text": "   "}"#).unwrap();
        assert!(extract_cortex_text(&parsed).is_err());
    }

    #[test]
    fn event_boundary_prefers_crlf_over_the_bare_lf_pair_inside_it() {
        // Searching for "\n\n" first would match the second half of this
        // "\r\n\r\n" and corrupt the next event's leading byte.
        let buf = "data: {}\r\n\r\ndata: {}\r\n\r\n";
        let (end, next_start) = find_event_boundary(buf).unwrap();
        assert_eq!(&buf[..end], "data: {}");
        assert_eq!(next_start, end + 4);
    }

    #[test]
    fn event_boundary_falls_back_to_a_bare_double_newline() {
        let buf = "data: {}\n\nrest";
        let (end, next_start) = find_event_boundary(buf).unwrap();
        assert_eq!(&buf[..end], "data: {}");
        assert_eq!(next_start, end + 2);
    }

    #[test]
    fn event_boundary_is_none_for_an_incomplete_event() {
        assert!(find_event_boundary("data: {\"delta\":").is_none());
    }

    #[test]
    fn a_delta_event_parses() {
        match parse_cortex_event(r#"{"delta": "Hel"}"#) {
            Some(CortexEvent::Delta(d)) => assert_eq!(d, "Hel"),
            other => panic!("expected a delta, got a different shape or none: {}", other.is_some()),
        }
    }

    #[test]
    fn a_done_event_parses_every_field() {
        match parse_cortex_event(r#"{"done": true, "ok": true, "text": "Hello.", "error": null}"#) {
            Some(CortexEvent::Done { ok, text, error }) => {
                assert!(ok);
                assert_eq!(text, "Hello.");
                assert_eq!(error, None);
            }
            _ => panic!("expected a done event"),
        }
    }

    #[test]
    fn a_failed_done_event_carries_its_error() {
        match parse_cortex_event(r#"{"done": true, "ok": false, "text": "", "error": "no model loaded"}"#) {
            Some(CortexEvent::Done { ok, error, .. }) => {
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("no model loaded"));
            }
            _ => panic!("expected a done event"),
        }
    }

    #[test]
    fn a_malformed_event_parses_to_nothing_rather_than_panicking() {
        assert!(parse_cortex_event("not json").is_none());
        assert!(parse_cortex_event(r#"{"unrelated": true}"#).is_none());
    }

    #[test]
    fn error_messages_explain_the_two_states_worth_explaining() {
        assert!(cortex_error_message(404, "").contains("/v1/ask"));
        assert!(cortex_error_message(503, "").contains("no model"));
        assert!(cortex_error_message(500, r#"{"error": "boom"}"#).contains("boom"));
        assert!(cortex_error_message(500, "not json").contains("500"));
    }
}
