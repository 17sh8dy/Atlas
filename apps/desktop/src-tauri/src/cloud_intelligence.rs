//! Cloud model providers — optional, user-configured, and never required.
//!
//! ## What this is, and what it deliberately is not
//!
//! Atlas's whole thesis is that it works with nothing connected (see
//! `docs/ARCHITECTURE.md` §1). Local models (`intelligence.rs`) are the local
//! answer to "the engine wants to reason about something it doesn't know."
//! This file is the **opt-in** second answer, for someone who wants stronger
//! conversation quality than a local model gives and is willing to send
//! their own questions to their own account at a provider they chose. It is
//! never registered, never active, and never reachable unless a person adds
//! a provider and saves a key — see `secrets.rs` for where that key actually
//! lives (never here, never in `storage.json`).
//!
//! ## The abstraction: one wire format per `CloudProviderKind`, not per brand
//!
//! Three real request/response shapes exist in the wild, and this maps
//! exactly one Rust path to each:
//!
//!   - `OpenaiCompatible` — `POST {base}/v1/chat/completions`,
//!     `Authorization: Bearer`, `.choices[0].message.content`. This is
//!     OpenAI's own shape, and it is also Kimi/Moonshot's, and it is what a
//!     self-hosted or proxied "Custom Provider" almost always means in
//!     practice — so all three ride this one path, distinguished only by
//!     `base_url`. There is no `Kind::OpenAI` and a separate `Kind::Kimi`;
//!     the *brand* is a Settings-page label over the same wire format, not a
//!     second code path to keep in sync with the first.
//!   - `Anthropic` — `POST {base}/v1/messages`, `x-api-key` +
//!     `anthropic-version`, `.content[0].text`. Different enough (header
//!     name, response shape, no `Bearer`) to prove the abstraction actually
//!     handles a real difference rather than assuming everyone looks like
//!     OpenAI.
//!   - `Gemini` — `POST {base}/v1beta/models/{model}:generateContent`, the
//!     key as a header rather than a query-string parameter (a key belongs
//!     in a header, not somewhere that ends up in a proxy's access log),
//!     `.candidates[0].content.parts[0].text`.
//!
//! ## Not streaming, on purpose, for now
//!
//! Local models stream (`intelligence.rs::ask_local_model_stream`); this doesn't yet.
//! Brandon's own brief for this pass was to "prioritize a clean
//! provider-management foundation rather than trying to fully integrate
//! every provider immediately" — three real, correct, non-streaming
//! backends is that foundation. `ProviderStreamHandlers.onDelta` on the TS
//! side already degrades a non-streaming provider to one `onDone` call (see
//! `Engine.converseWithProvider`), so adding real streaming later is a
//! change to this file alone, not to anything above it.
//!
//! ## Never logging, never echoing, the key
//!
//! `ask_cloud_provider` takes a `provider_id` and reads the key itself via
//! `secrets::read_secret` — the caller (the webview) never holds the value,
//! not even to pass it through. Every error path below is built from the
//! provider's *response*, never from the request, so a key can never end up
//! in a message shown to the user.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 60;
const MAX_PROMPT_CHARS: usize = 100_000;

const DEFAULT_ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const DEFAULT_GEMINI_BASE: &str = "https://generativelanguage.googleapis.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudProviderKind {
    OpenaiCompatible,
    Anthropic,
    Gemini,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

/// A request that ran out of time is not one that failed to connect, and
/// "couldn't reach" would send someone checking their network for nothing.
fn send_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "That provider took too long to answer.".to_string()
    } else {
        "Couldn't reach that provider.".to_string()
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

/// `OpenaiCompatible` covers three real, different endpoints (OpenAI, Kimi,
/// a self-hosted proxy) with no shared default worth guessing — required,
/// explicitly. `Anthropic`/`Gemini` name one real service each, so an empty
/// value falls back to it, the same as `intelligence.rs::validate_base_url`
/// does for the local model endpoint.
fn resolve_base_url(kind: CloudProviderKind, base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    // Every request below appends `/v1/...` itself; a base pasted in as
    // `https://host/v1` would otherwise become `/v1/v1/...` and 404.
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    match kind {
        CloudProviderKind::OpenaiCompatible => {
            Err("This provider needs a base URL.".to_string())
        }
        CloudProviderKind::Anthropic => Ok(DEFAULT_ANTHROPIC_BASE.to_string()),
        CloudProviderKind::Gemini => Ok(DEFAULT_GEMINI_BASE.to_string()),
    }
}

/// Every shape worth trying, in order, for an error body none of these
/// providers are contractually bound to agree on. Falls through to `None`
/// rather than guessing — the caller then shows the plain status code.
fn extract_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("error")
        .and_then(|e| e.get("message").and_then(|m| m.as_str()).or_else(|| e.as_str()))
        .or_else(|| value.get("message").and_then(|m| m.as_str()))
        .map(|s| s.to_string())
}

/// Never includes the key or any request detail — built from the response
/// alone, so this can never leak what was sent.
fn provider_error_message(status: u16, body: &str) -> String {
    let detail = extract_error_message(body);
    match status {
        401 | 403 => detail.unwrap_or_else(|| "That API key was rejected.".to_string()),
        404 => detail.unwrap_or_else(|| "That model wasn't found — check the model name.".to_string()),
        429 => "Rate limited by the provider — try again in a moment.".to_string(),
        _ => detail.unwrap_or_else(|| format!("The provider returned {status}.")),
    }
}

// ---- OpenAI-compatible --------------------------------------------------------

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: [OpenAiMessage<'a>; 1],
    stream: bool,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessageOut,
}
#[derive(Deserialize)]
struct OpenAiMessageOut {
    content: Option<String>,
}
#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

async fn ask_openai_compatible(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(key)
        .json(&OpenAiRequest {
            model,
            messages: [OpenAiMessage { role: "user", content: prompt }],
            stream: false,
        })
        .send()
        .await
        .map_err(|e| send_error(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Couldn't read the provider's response.".to_string())?;
    if !status.is_success() {
        return Err(provider_error_message(status.as_u16(), &text));
    }

    let parsed: OpenAiResponse = serde_json::from_str(&text)
        .map_err(|_| "That provider's response didn't look like what I expected.".to_string())?;
    parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "The provider didn't return any text.".to_string())
}

// ---- Anthropic ------------------------------------------------------------------

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: [AnthropicMessage<'a>; 1],
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(default)]
    text: Option<String>,
}
#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicBlock>,
}

async fn ask_anthropic(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&AnthropicRequest {
            model,
            max_tokens: 4096,
            messages: [AnthropicMessage { role: "user", content: prompt }],
        })
        .send()
        .await
        .map_err(|e| send_error(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Couldn't read the provider's response.".to_string())?;
    if !status.is_success() {
        return Err(provider_error_message(status.as_u16(), &text));
    }

    let parsed: AnthropicResponse = serde_json::from_str(&text)
        .map_err(|_| "That provider's response didn't look like what I expected.".to_string())?;
    parsed
        .content
        .into_iter()
        .find_map(|b| b.text)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "The provider didn't return any text.".to_string())
}

// ---- Gemini -----------------------------------------------------------------------

#[derive(Serialize)]
struct GeminiPart<'a> {
    text: &'a str,
}
#[derive(Serialize)]
struct GeminiContent<'a> {
    parts: [GeminiPart<'a>; 1],
}
#[derive(Serialize)]
struct GeminiRequest<'a> {
    contents: [GeminiContent<'a>; 1],
}

#[derive(Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}
#[derive(Deserialize)]
struct GeminiCandidate {
    content: GeminiCandidateContent,
}
#[derive(Deserialize)]
struct GeminiCandidateContent {
    #[serde(default)]
    parts: Vec<GeminiResponsePart>,
}
#[derive(Deserialize)]
struct GeminiResponsePart {
    #[serde(default)]
    text: Option<String>,
}

async fn ask_gemini(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&GeminiRequest {
            contents: [GeminiContent { parts: [GeminiPart { text: prompt }] }],
        })
        .send()
        .await
        .map_err(|e| send_error(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Couldn't read the provider's response.".to_string())?;
    if !status.is_success() {
        return Err(provider_error_message(status.as_u16(), &text));
    }

    let parsed: GeminiResponse = serde_json::from_str(&text)
        .map_err(|_| "That provider's response didn't look like what I expected.".to_string())?;
    parsed
        .candidates
        .into_iter()
        .next()
        .and_then(|c| c.content.parts.into_iter().find_map(|p| p.text))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "The provider didn't return any text.".to_string())
}

// ---- the one command --------------------------------------------------------------

/// Raced against the emergency stop: a halt drops the request mid-flight,
/// which closes the connection — see `halt::Halt::race`.
#[tauri::command]
pub async fn ask_cloud_provider(provider_id: String, kind: CloudProviderKind, base_url: String, model: String, prompt: String) -> Result<String, String> {
    crate::halt::global().race(ask_cloud_provider_unraced(provider_id, kind, base_url, model, prompt)).await
}

async fn ask_cloud_provider_unraced(
    provider_id: String,
    kind: CloudProviderKind,
    base_url: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    validate_prompt(&prompt)?;
    let key = crate::secrets::read_secret(&provider_id)?
        .ok_or_else(|| "No API key saved for this provider.".to_string())?;
    let base = resolve_base_url(kind, &base_url)?;
    let client = http_client()?;

    match kind {
        CloudProviderKind::OpenaiCompatible => {
            ask_openai_compatible(&client, &base, &key, &model, &prompt).await
        }
        CloudProviderKind::Anthropic => ask_anthropic(&client, &base, &key, &model, &prompt).await,
        CloudProviderKind::Gemini => ask_gemini(&client, &base, &key, &model, &prompt).await,
    }
}

/// The Settings page's "Test connection" button — the same call
/// `ask_cloud_provider` makes, with a fixed, tiny, harmless prompt. Kept as a
/// separate command rather than a flag on the one above: a test is
/// conceptually "does this work at all", not "answer this specific thing",
/// and a caller should never confuse the two by mistake.
#[tauri::command]
pub async fn test_cloud_provider(
    provider_id: String,
    kind: CloudProviderKind,
    base_url: String,
    model: String,
) -> Result<String, String> {
    ask_cloud_provider(
        provider_id,
        kind,
        base_url,
        model,
        "Reply with just the word OK.".to_string(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_compatible_requires_an_explicit_base_url() {
        assert!(resolve_base_url(CloudProviderKind::OpenaiCompatible, "").is_err());
        assert_eq!(
            resolve_base_url(CloudProviderKind::OpenaiCompatible, "https://api.moonshot.ai/").unwrap(),
            "https://api.moonshot.ai"
        );
    }

    #[test]
    fn anthropic_and_gemini_fall_back_to_a_real_default() {
        assert_eq!(
            resolve_base_url(CloudProviderKind::Anthropic, "").unwrap(),
            DEFAULT_ANTHROPIC_BASE
        );
        assert_eq!(
            resolve_base_url(CloudProviderKind::Gemini, "  ").unwrap(),
            DEFAULT_GEMINI_BASE
        );
    }

    #[test]
    fn a_pasted_v1_suffix_is_not_doubled() {
        assert_eq!(
            resolve_base_url(CloudProviderKind::OpenaiCompatible, "https://api.example.com/v1/").unwrap(),
            "https://api.example.com"
        );
    }

    #[test]
    fn a_trailing_slash_is_normalised_away() {
        assert_eq!(
            resolve_base_url(CloudProviderKind::Anthropic, "https://api.anthropic.com/").unwrap(),
            DEFAULT_ANTHROPIC_BASE
        );
    }

    #[test]
    fn error_messages_never_need_the_body_to_say_something_useful() {
        assert!(provider_error_message(401, "").contains("rejected"));
        assert!(provider_error_message(404, "").contains("wasn't found"));
        assert!(provider_error_message(429, "").contains("Rate limited"));
        assert!(provider_error_message(500, "not json").contains("500"));
    }

    #[test]
    fn openai_shaped_error_bodies_are_extracted() {
        let body = r#"{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}"#;
        assert_eq!(extract_error_message(body).as_deref(), Some("Incorrect API key provided"));
        assert!(provider_error_message(401, body).contains("Incorrect API key"));
    }

    #[test]
    fn anthropic_shaped_error_bodies_are_extracted() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(extract_error_message(body).as_deref(), Some("invalid x-api-key"));
    }

    #[test]
    fn gemini_shaped_error_bodies_are_extracted() {
        let body = r#"{"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(extract_error_message(body).as_deref(), Some("API key not valid"));
    }

    #[test]
    fn an_unparseable_body_extracts_nothing_rather_than_panicking() {
        assert_eq!(extract_error_message("not json at all"), None);
        assert_eq!(extract_error_message(""), None);
    }

    #[test]
    fn openai_response_shape_parses_to_the_message_content() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"Paris."}}]}"#;
        let parsed: OpenAiResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.choices[0].message.content.as_deref(), Some("Paris."));
    }

    #[test]
    fn anthropic_response_shape_parses_to_the_first_text_block() {
        let body = r#"{"content":[{"type":"text","text":"Paris."}]}"#;
        let parsed: AnthropicResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.content[0].text.as_deref(), Some("Paris."));
    }

    #[test]
    fn gemini_response_shape_parses_to_the_first_candidates_text() {
        let body = r#"{"candidates":[{"content":{"parts":[{"text":"Paris."}],"role":"model"}}]}"#;
        let parsed: GeminiResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.candidates[0].content.parts[0].text.as_deref(), Some("Paris."));
    }

    #[test]
    fn kind_serializes_to_the_ids_the_ts_side_expects() {
        assert_eq!(
            serde_json::to_string(&CloudProviderKind::OpenaiCompatible).unwrap(),
            "\"openai-compatible\""
        );
        assert_eq!(serde_json::to_string(&CloudProviderKind::Anthropic).unwrap(), "\"anthropic\"");
        assert_eq!(serde_json::to_string(&CloudProviderKind::Gemini).unwrap(), "\"gemini\"");
    }
}
