//! Real `IntelligenceProvider` backends: Claude (Anthropic) and ChatGPT
//! (OpenAI). **Both stream**, over Server-Sent Events.
//!
//! ── How streaming is threaded through ───────────────────────────────────────
//! The obvious design — hand a stream back to JS — is not available to a Tauri
//! command, which resolves exactly once. So the split is:
//!
//!   * incremental text  → emitted as Tauri events, one per chunk
//!   * the finished text → still the command's return value
//!   * any failure       → still the command's `Err`
//!
//! That leaves `ProviderStreamHandlers` exactly as it was: `onDone(full)` and
//! `onError` come from the promise, and `onDelta` is the only new path. It
//! also means a caller that ignores the events still receives a correct,
//! complete answer — which is what makes this safe to land without the engine
//! changing at all.
//!
//! Each call carries its own `stream_id` and emits on a channel named after
//! it. Two answers in flight cannot then interleave: one shared event name
//! would drop the second answer's tokens into the first answer's bubble.
//!
//! ── Why a hand-written SSE reader ──────────────────────────────────────────
//! `eventsource-stream` would do this, but the format needed here is one rule
//! ("lines beginning `data:`, blank line ends the event") and the parser is
//! ~20 lines. That is cheaper than another dependency in a binary whose size
//! is a stated goal.
//!
//! Both keys are supplied per-call from the renderer, never stored here —
//! `provider-keys.ts` (`packages/data`) owns persistence, through the same
//! `Storage` port everything else in Atlas uses.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// How long to wait for the connection itself. Short: a server that has not
/// completed the handshake by now is not about to.
const CONNECT_TIMEOUT_SECS: u64 = 15;

/// Ceiling on a whole streamed answer.
///
/// Much longer than the 60s the non-streaming version used, and it has to be:
/// that timeout covered "produce the entire answer", which is the very thing
/// streaming exists to stop waiting for. A long reply that is actively
/// arriving must not be killed halfway through.
const STREAM_TIMEOUT_SECS: u64 = 300;

const MAX_PROMPT_CHARS: usize = 100_000;

/// One chunk of a streamed answer, as it goes to the renderer.
#[derive(Clone, Serialize)]
struct StreamChunk {
    text: String,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(STREAM_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())
}

/// The channel one call's chunks are emitted on.
fn stream_channel(stream_id: &str) -> String {
    format!("atlas://intelligence/{stream_id}")
}

/// Pull an SSE body, hand every `data:` payload to `extract`, emit whatever
/// text comes back, and return the accumulated answer.
///
/// `extract` returns:
///   * `Ok(Some(text))` — a chunk of the answer
///   * `Ok(None)`       — a protocol event carrying no text (ping, start, stop)
///   * `Err(message)`   — the stream itself reported an error
async fn consume_sse<F>(
    app: &AppHandle,
    stream_id: Option<&str>,
    response: reqwest::Response,
    extract: F,
) -> Result<String, String>
where
    F: Fn(&str) -> Result<Option<String>, String>,
{
    let channel = stream_id.map(stream_channel);
    let mut body = response.bytes_stream();
    let mut buffer = String::new();
    let mut answer = String::new();

    while let Some(chunk) = body.next().await {
        let bytes = chunk.map_err(|_| "The connection dropped mid-answer.".to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Events are separated by a blank line. Whatever follows the last
        // separator is a partial event and stays buffered until the rest
        // arrives — which is the entire reason this is a buffer rather than a
        // per-chunk parse. A network chunk boundary lands mid-JSON constantly.
        while let Some((end, separator)) = find_event_boundary(&buffer) {
            let event = buffer[..end].to_string();
            buffer = buffer[end + separator..].to_string();

            for line in event.lines() {
                let Some(payload) = line.strip_prefix("data:") else {
                    continue; // `event:` and `id:` lines carry nothing we need
                };
                let payload = payload.trim();
                // `[DONE]` is OpenAI's end sentinel and is not JSON.
                if payload.is_empty() || payload == "[DONE]" {
                    continue;
                }

                if let Some(text) = extract(payload)? {
                    if text.is_empty() {
                        continue;
                    }
                    answer.push_str(&text);
                    if let Some(channel) = channel.as_deref() {
                        // A failed emit must never abort the answer: the text
                        // is still accumulating and is returned in full.
                        let _ = app.emit(channel, StreamChunk { text });
                    }
                }
            }
        }
    }

    Ok(answer)
}

/// Where the next complete SSE event ends, and how many bytes its separator is.
///
/// Servers disagree about line endings, so both `\n\n` and `\r\n\r\n` count.
/// Checking CRLF first matters: searching for `\n\n` in a CRLF stream matches
/// the second half of the separator and leaves a stray `\r` on the next event.
fn find_event_boundary(buffer: &str) -> Option<(usize, usize)> {
    match (buffer.find("\r\n\r\n"), buffer.find("\n\n")) {
        (Some(crlf), Some(lf)) if crlf <= lf => Some((crlf, 4)),
        (Some(crlf), None) => Some((crlf, 4)),
        (_, Some(lf)) => Some((lf, 2)),
        (None, None) => None,
    }
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
    stream: bool,
    messages: Vec<ClaudeMessage<'a>>,
}

// ---- Claude streaming events ----------------------------------------------
//
// Only the shapes that matter are modelled. `message_start`, `ping`,
// `content_block_start/stop` and `message_stop` all deserialize into a struct
// whose optional fields are simply absent, and produce no text — so unknown
// event types are ignored by construction rather than by a match arm that
// would need updating every time the API grows one.

#[derive(Deserialize)]
struct ClaudeStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    delta: Option<ClaudeStreamDelta>,
    error: Option<ClaudeErrorDetail>,
}

#[derive(Deserialize)]
struct ClaudeStreamDelta {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

/// Pull the text out of one Claude SSE payload.
fn claude_stream_text(payload: &str) -> Result<Option<String>, String> {
    let event: ClaudeStreamEvent = match serde_json::from_str(payload) {
        Ok(e) => e,
        // A payload we cannot parse is not worth failing an answer over: the
        // API adds event types over time, and dropping one costs nothing.
        Err(_) => return Ok(None),
    };

    // An `error` event mid-stream is the one case that must stop everything.
    if event.kind == "error" {
        return Err(event
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| "Claude reported an error mid-answer.".to_string()));
    }

    if event.kind != "content_block_delta" {
        return Ok(None);
    }

    let delta = match event.delta {
        Some(d) => d,
        None => return Ok(None),
    };
    // `text_delta` is the prose. Ignoring other delta kinds is deliberate:
    // `thinking_delta` and `input_json_delta` are not the answer and must not
    // be shown as if they were.
    if delta.kind.as_deref() != Some("text_delta") {
        return Ok(None);
    }
    Ok(delta.text)
}

#[derive(Deserialize)]
struct ClaudeErrorBody {
    error: ClaudeErrorDetail,
}

#[derive(Deserialize)]
struct ClaudeErrorDetail {
    message: String,
}

/// Ask Claude, streaming the answer.
///
/// `stream_id` is optional: without one the answer is still produced in full,
/// just without per-chunk events. That keeps the command usable from anywhere
/// that only wants the final text (and keeps the tests honest).
#[tauri::command]
pub async fn ask_claude(
    app: AppHandle,
    api_key: String,
    prompt: String,
    stream_id: Option<String>,
) -> Result<String, String> {
    validate(&api_key, &prompt)?;
    let client = http_client()?;

    let body = ClaudeRequest {
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        stream: true,
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

    // The status arrives with the headers, before any body — so a rejected key
    // or a rate limit is still caught up front, and the friendly messages below
    // are unchanged by streaming.
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(claude_error_message(status.as_u16(), &text));
    }

    let answer = consume_sse(&app, stream_id.as_deref(), resp, claude_stream_text).await?;
    if answer.is_empty() {
        return Err("Claude didn't return any text.".into());
    }
    Ok(answer)
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
    stream: bool,
    messages: Vec<OpenAiMessage<'a>>,
}

// ---- ChatGPT streaming events ---------------------------------------------

#[derive(Deserialize)]
struct OpenAiStreamChunk {
    choices: Vec<OpenAiStreamChoice>,
}

#[derive(Deserialize)]
struct OpenAiStreamChoice {
    delta: OpenAiStreamDelta,
}

#[derive(Deserialize)]
struct OpenAiStreamDelta {
    content: Option<String>,
}

/// Pull the text out of one ChatGPT SSE payload.
///
/// The terminating `[DONE]` sentinel never reaches here — `consume_sse` skips
/// it, because it is the one payload in the stream that is not JSON.
fn openai_stream_text(payload: &str) -> Result<Option<String>, String> {
    // OpenAI reports mid-stream failures as a JSON object with an `error` key
    // rather than a distinct event type, so that is checked before the chunk
    // shape — a parse of the chunk shape would just yield an empty `choices`
    // and silently swallow the error.
    if let Ok(failure) = serde_json::from_str::<OpenAiErrorBody>(payload) {
        return Err(failure.error.message);
    }

    let chunk: OpenAiStreamChunk = match serde_json::from_str(payload) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    // The final chunk carries `finish_reason` and an empty delta, which lands
    // here as `None` and contributes nothing.
    Ok(chunk.choices.into_iter().next().and_then(|c| c.delta.content))
}

#[derive(Deserialize)]
struct OpenAiErrorBody {
    error: OpenAiErrorDetail,
}

#[derive(Deserialize)]
struct OpenAiErrorDetail {
    message: String,
}

/// Ask ChatGPT, streaming the answer. See `ask_claude` for the `stream_id`
/// contract — it is identical.
#[tauri::command]
pub async fn ask_openai(
    app: AppHandle,
    api_key: String,
    prompt: String,
    stream_id: Option<String>,
) -> Result<String, String> {
    validate(&api_key, &prompt)?;
    let client = http_client()?;

    let body = OpenAiRequest {
        model: OPENAI_MODEL,
        stream: true,
        messages: vec![OpenAiMessage { role: "user", content: &prompt }],
    };

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|_| "Couldn't reach ChatGPT — check the connection.".to_string())?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(openai_error_message(status.as_u16(), &text));
    }

    let answer = consume_sse(&app, stream_id.as_deref(), resp, openai_stream_text).await?;
    if answer.is_empty() {
        return Err("ChatGPT didn't return any text.".into());
    }
    Ok(answer)
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

    #[test]
    fn each_call_gets_its_own_channel() {
        // Two answers in flight must not share an event name, or one
        // transcript bubble receives the other's tokens.
        assert_ne!(stream_channel("a1"), stream_channel("b2"));
        assert!(stream_channel("a1").starts_with("atlas://intelligence/"));
    }

    // ---- SSE framing ------------------------------------------------------

    #[test]
    fn finds_an_event_ending_in_lf() {
        assert_eq!(find_event_boundary("data: x\n\nrest"), Some((7, 2)));
    }

    #[test]
    fn finds_an_event_ending_in_crlf() {
        // The trap: searching for a bare LF pair also matches the second
        // half of a CRLF pair, which leaves a stray carriage return at the
        // head of the next event and corrupts its `data:` prefix.
        let raw = "data: x\r\n\r\ndata: y";
        let (end, sep) = find_event_boundary(raw).unwrap();
        assert_eq!(sep, 4);
        assert_eq!(&raw[end + sep..], "data: y");
    }

    #[test]
    fn a_partial_event_is_not_a_boundary() {
        assert_eq!(find_event_boundary("data: {\"par"), None);
    }

    // ---- Claude — fixtures match Anthropic's documented SSE shape ----------

    #[test]
    fn extracts_text_from_a_claude_content_block_delta() {
        let payload = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        assert_eq!(claude_stream_text(payload).unwrap(), Some("Hello".to_string()));
    }

    #[test]
    fn ignores_claude_protocol_events() {
        for payload in [
            r#"{"type":"message_start","message":{"id":"msg_01"}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
            r#"{"type":"message_stop"}"#,
            r#"{"type":"ping"}"#,
        ] {
            assert_eq!(claude_stream_text(payload).unwrap(), None, "{payload}");
        }
    }

    #[test]
    fn ignores_claude_thinking_deltas() {
        // Thinking is not the answer and must never be rendered as if it were.
        let payload = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#;
        assert_eq!(claude_stream_text(payload).unwrap(), None);
    }

    #[test]
    fn a_claude_error_event_stops_the_stream() {
        let payload = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert_eq!(claude_stream_text(payload).unwrap_err(), "Overloaded");
    }

    #[test]
    fn an_unparseable_claude_payload_is_skipped_not_fatal() {
        // The API grows event types over time; dropping one costs nothing,
        // failing the whole answer over one costs the answer.
        assert_eq!(claude_stream_text("not json").unwrap(), None);
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

    // ---- ChatGPT — fixtures match OpenAI's documented SSE shape ------------

    #[test]
    fn extracts_text_from_an_openai_chunk() {
        let payload = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        assert_eq!(openai_stream_text(payload).unwrap(), Some("Hello".to_string()));
    }

    #[test]
    fn the_openai_role_and_final_chunks_carry_no_text() {
        let role = r#"{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#;
        let last = r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        assert_eq!(openai_stream_text(role).unwrap(), None);
        assert_eq!(openai_stream_text(last).unwrap(), None);
    }

    #[test]
    fn an_openai_error_object_stops_the_stream() {
        // OpenAI signals a mid-stream failure with an `error` key rather than a
        // distinct event type, so it has to be checked before the chunk shape —
        // otherwise it parses as an empty `choices` and is silently swallowed.
        let payload = r#"{"error":{"message":"The server had an error","type":"server_error"}}"#;
        assert_eq!(openai_stream_text(payload).unwrap_err(), "The server had an error");
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
