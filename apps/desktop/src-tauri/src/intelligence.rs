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

use serde::{Deserialize, Serialize};
use std::time::Duration;

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
    fn error_messages_explain_the_two_states_worth_explaining() {
        assert!(cortex_error_message(404, "").contains("/v1/ask"));
        assert!(cortex_error_message(503, "").contains("no model"));
        assert!(cortex_error_message(500, r#"{"error": "boom"}"#).contains("boom"));
        assert!(cortex_error_message(500, "not json").contains("500"));
    }
}
