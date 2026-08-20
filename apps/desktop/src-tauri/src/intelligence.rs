//! Real `IntelligenceProvider` backends: Claude (Anthropic) and ChatGPT
//! (OpenAI). Both are non-streaming — one request, one complete answer —
//! rather than a second, event-based channel for incremental tokens.
//! `ProviderStreamHandlers`' `onDelta`/`onDone` contract already degrades
//! cleanly when only `onDone` ever fires (see `engine.ts`'s
//! `converseWithProvider`), so nothing above this layer needed to change to
//! support that; a streaming version can replace these commands later
//! without touching the engine.
//!
//! Both keys are supplied per-call from the renderer, never stored here —
//! `provider-keys.ts` (`packages/data`) owns persistence, through the same
//! `Storage` port everything else in Atlas uses.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 60; // a real answer can take a while
const MAX_PROMPT_CHARS: usize = 100_000;

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

fn validate(api_key: &str, prompt: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("No API key is saved for this provider.".into());
    }
    if prompt.trim().is_empty() {
        return Err("Nothing to ask.".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("That's too long to send.".into());
    }
    Ok(())
}

// ---- Claude (Anthropic Messages API) --------------------------------------

const CLAUDE_MODEL: &str = "claude-3-5-sonnet-20241022";

#[derive(Serialize)]
struct ClaudeMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ClaudeRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<ClaudeMessage<'a>>,
}

#[derive(Deserialize)]
struct ClaudeContentBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeResponse {
    content: Vec<ClaudeContentBlock>,
}

#[derive(Deserialize)]
struct ClaudeErrorBody {
    error: ClaudeErrorDetail,
}

#[derive(Deserialize)]
struct ClaudeErrorDetail {
    message: String,
}

#[tauri::command]
pub async fn ask_claude(api_key: String, prompt: String) -> Result<String, String> {
    validate(&api_key, &prompt)?;
    let client = http_client()?;

    let body = ClaudeRequest {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: vec![ClaudeMessage { role: "user", content: &prompt }],
    };

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| "Couldn't reach Claude — check the connection.".to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Couldn't read Claude's response.".to_string())?;

    if !status.is_success() {
        return Err(claude_error_message(status.as_u16(), &text));
    }

    let parsed: ClaudeResponse =
        serde_json::from_str(&text).map_err(|_| "Claude's response didn't look like what I expected.".to_string())?;

    extract_claude_text(&parsed)
}

fn extract_claude_text(resp: &ClaudeResponse) -> Result<String, String> {
    let text: String = resp
        .content
        .iter()
        .filter(|b| b.kind == "text")
        .filter_map(|b| b.text.as_deref())
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        return Err("Claude didn't return any text.".into());
    }
    Ok(text)
}

fn claude_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<ClaudeErrorBody>(body).ok().map(|e| e.error.message);
    match status {
        401 => "That Claude API key was rejected. Check it in Settings → Developer.".to_string(),
        429 => "Claude's rate limit was hit — try again shortly.".to_string(),
        _ => detail.unwrap_or_else(|| format!("Claude returned {status}.")),
    }
}

// ---- ChatGPT (OpenAI Chat Completions API) --------------------------------

const OPENAI_MODEL: &str = "gpt-4o-mini";

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct OpenAiRequest<'a> {
    model: &'a str,
    messages: Vec<OpenAiMessage<'a>>,
}

#[derive(Deserialize)]
struct OpenAiResponseMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiResponseMessage,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiErrorBody {
    error: OpenAiErrorDetail,
}

#[derive(Deserialize)]
struct OpenAiErrorDetail {
    message: String,
}

#[tauri::command]
pub async fn ask_openai(api_key: String, prompt: String) -> Result<String, String> {
    validate(&api_key, &prompt)?;
    let client = http_client()?;

    let body = OpenAiRequest { model: OPENAI_MODEL, messages: vec![OpenAiMessage { role: "user", content: &prompt }] };

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|_| "Couldn't reach ChatGPT — check the connection.".to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| "Couldn't read ChatGPT's response.".to_string())?;

    if !status.is_success() {
        return Err(openai_error_message(status.as_u16(), &text));
    }

    let parsed: OpenAiResponse =
        serde_json::from_str(&text).map_err(|_| "ChatGPT's response didn't look like what I expected.".to_string())?;

    extract_openai_text(&parsed)
}

fn extract_openai_text(resp: &OpenAiResponse) -> Result<String, String> {
    resp.choices
        .first()
        .and_then(|c| c.message.content.clone())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "ChatGPT didn't return any text.".to_string())
}

fn openai_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<OpenAiErrorBody>(body).ok().map(|e| e.error.message);
    match status {
        401 => "That ChatGPT API key was rejected. Check it in Settings → Developer.".to_string(),
        429 => "ChatGPT's rate limit was hit — try again shortly.".to_string(),
        _ => detail.unwrap_or_else(|| format!("ChatGPT returned {status}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_a_missing_key() {
        assert!(validate("", "hello").is_err());
        assert!(validate("   ", "hello").is_err());
    }

    #[test]
    fn validate_rejects_an_empty_prompt() {
        assert!(validate("sk-xxx", "").is_err());
    }

    #[test]
    fn validate_accepts_a_real_looking_call() {
        assert!(validate("sk-ant-xxx", "what happened in the news today?").is_ok());
    }

    // ---- Claude — fixtures match Anthropic's documented Messages API shape ----

    #[test]
    fn extracts_text_from_a_real_shaped_claude_response() {
        let json = r#"{
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "The answer is 42."}],
            "model": "claude-3-5-sonnet-20241022",
            "stop_reason": "end_turn"
        }"#;
        let parsed: ClaudeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(extract_claude_text(&parsed).unwrap(), "The answer is 42.");
    }

    #[test]
    fn joins_multiple_claude_text_blocks() {
        let json = r#"{"content": [{"type": "text", "text": "Part one. "}, {"type": "text", "text": "Part two."}]}"#;
        let parsed: ClaudeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(extract_claude_text(&parsed).unwrap(), "Part one. Part two.");
    }

    #[test]
    fn claude_error_message_recognises_auth_failure() {
        let body = r#"{"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}"#;
        assert!(claude_error_message(401, body).contains("rejected"));
    }

    #[test]
    fn claude_error_message_falls_back_to_the_status_code() {
        assert!(claude_error_message(500, "not json").contains("500"));
    }

    // ---- ChatGPT — fixtures match OpenAI's documented Chat Completions shape --

    #[test]
    fn extracts_text_from_a_real_shaped_openai_response() {
        let json = r#"{
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "The answer is 42."}, "finish_reason": "stop"}]
        }"#;
        let parsed: OpenAiResponse = serde_json::from_str(json).unwrap();
        assert_eq!(extract_openai_text(&parsed).unwrap(), "The answer is 42.");
    }

    #[test]
    fn openai_error_message_recognises_auth_failure() {
        let body = r#"{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}"#;
        assert!(openai_error_message(401, body).contains("rejected"));
    }

    #[test]
    fn openai_error_message_falls_back_to_the_status_code() {
        assert!(openai_error_message(500, "not json").contains("500"));
    }
}
