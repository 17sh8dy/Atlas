//! The intelligence layer's native half: **local models** (through Ollama on
//! this machine) and **Nova Intelligence** (Nova's own from-scratch model,
//! served by its own local process).
//!
//! ## Intelligence, not control
//!
//! Everything in this file is the *conversation and reasoning* layer. It
//! sends text to a model and streams text back. It does not run a command,
//! touch a file, click, type or launch anything — those belong to Atlas's own
//! skills and executor, which stay exactly as they were, behind the same
//! permissions, confirmations and emergency stop. A model can read a request
//! and *ask* for a skill; choosing a different model changes how Atlas
//! reasons, never what it is allowed to do.
//!
//! ## Why this is in Rust at all
//!
//! Both are reached over plain HTTP on the loopback interface, which the
//! webview could technically do itself with `fetch`. It happens here anyway,
//! for two reasons: the webview would need the model server to send CORS
//! headers back — making Atlas's transport a constraint on somebody else's
//! server — and routing it through the Tauri command boundary keeps the base
//! URL validated in one place. See `validate_base_url`, which is what stops a
//! stored preference from turning this into a general-purpose HTTP client
//! pointed anywhere the caller likes.
//!
//! ## Loopback only, enforced here
//!
//! `validate_base_url` rejects anything that is not `127.0.0.1`, `localhost`
//! or `::1`. Cloud models are a separate, opt-in path with their own keys
//! (`cloud_intelligence.rs`); this one never leaves the machine.
//!
//! ## Two wire formats
//!
//! * **Ollama** — `POST /api/chat`, newline-delimited JSON. Each line carries
//!   a piece of the answer in `message.content` and, for a thinking model,
//!   the model's reasoning in `message.thinking`. Only the answer is ever
//!   forwarded: what a model thought is not shown, stored or logged.
//! * **Nova Intelligence** — `POST /v1/ask/stream`, server-sent events with
//!   `delta` and a final `done`.
//!
//! Both deliver to the renderer as `atlas://intelligence/{stream_id}` events
//! while the call is in flight, and both calls still resolve with the whole
//! answer, so a caller that never subscribed still gets the right text.

use futures_util::StreamExt;
use serde::Serialize;
use std::time::Duration;
use tauri::Emitter;

/// Local inference is not fast, and a first call may load a model from disk —
/// a 30B model on a modest PC can take minutes. Generous compared to a
/// network call, because none of this is a network call in the sense that
/// matters.
const REQUEST_TIMEOUT_SECS: u64 = 900;
const MAX_PROMPT_CHARS: usize = 100_000;
const MAX_MODEL_TAG_CHARS: usize = 100;
/// How long Ollama keeps a model in memory after its last message.
const KEEP_ALIVE: &str = "30m";

/// Where Ollama listens when nothing says otherwise.
pub const OLLAMA_DEFAULT_URL: &str = "http://127.0.0.1:11434";
/// Where Nova Intelligence's server listens when nothing says otherwise.
pub const NOVA_DEFAULT_URL: &str = "http://127.0.0.1:8766";

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
fn validate_base_url(base_url: &str, default: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(default.to_string());
    }

    let parsed =
        reqwest::Url::parse(trimmed).map_err(|_| "That doesn't look like a URL.".to_string())?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("The model server has to be reached over http.".into());
    }

    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => {
            Ok(trimmed.to_string())
        }
        _ => Err("The model server has to run on this machine — only 127.0.0.1 or localhost.".into()),
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

/// A model tag is `name`, `name:tag` or `namespace/name:tag`. Anything else
/// is a claim from the renderer that is not a model, and is refused before it
/// becomes part of a request.
fn validate_model_tag(tag: &str) -> Result<(), String> {
    let ok = !tag.is_empty()
        && tag.chars().count() <= MAX_MODEL_TAG_CHARS
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
        // A name never climbs, starts at a root, or has an empty segment.
        && !tag.contains("..")
        && !tag.contains("//")
        && !tag.starts_with('/')
        && !tag.starts_with('.');
    if ok {
        Ok(())
    } else {
        Err("That isn't a model name Atlas can use.".into())
    }
}

// ---------------------------------------------------------------------------
// Ollama: local models
// ---------------------------------------------------------------------------

/// The request body. `think` is only sent when it is an explicit choice: a
/// model without a thinking mode refuses `think: true`, so "leave it alone"
/// has to mean the field is absent, not `null`.
fn chat_body(model: &str, prompt: &str, think: Option<bool>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": true,
        // Ollama unloads a model after five idle minutes, and loading a big
        // one costs seconds on the next message. Keep it warm for a while.
        "keep_alive": KEEP_ALIVE,
    });
    if let Some(t) = think {
        body["think"] = serde_json::Value::Bool(t);
    }
    body
}

/// What one line of Ollama's stream means.
#[derive(Debug, PartialEq)]
struct ChatLine {
    /// The next piece of the *answer*. Never the model's reasoning.
    delta: String,
    done: bool,
    error: Option<String>,
}

fn parse_chat_line(line: &str) -> Option<ChatLine> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Some(ChatLine { delta: String::new(), done: true, error: Some(err.to_string()) });
    }
    Some(ChatLine {
        delta: v
            .pointer("/message/content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        done: v.get("done").and_then(|d| d.as_bool()).unwrap_or(false),
        error: None,
    })
}

/// Drops `<think>…</think>` spans from a stream.
///
/// Current Ollama returns a thinking model's reasoning in a separate field, so
/// this normally has nothing to do. An older server puts it inline in the
/// answer instead, and without this the user would read the model's private
/// working as though it were the reply. Tags can be split across chunks, so a
/// possible partial tag is held back until the next chunk settles it.
struct ThinkFilter {
    inside: bool,
    pending: String,
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

impl ThinkFilter {
    fn new() -> Self {
        Self { inside: false, pending: String::new() }
    }

    /// The length of the longest suffix of `s` that could be the start of `tag`.
    fn partial_tag_len(s: &str, tag: &str) -> usize {
        (1..tag.len().min(s.len() + 1))
            .rev()
            .find(|&n| s.is_char_boundary(s.len() - n) && tag.starts_with(&s[s.len() - n..]))
            .unwrap_or(0)
    }

    fn push(&mut self, chunk: &str) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.push_str(chunk);
        let mut out = String::new();
        loop {
            if self.inside {
                if let Some(i) = buf.find(CLOSE) {
                    buf = buf[i + CLOSE.len()..].to_string();
                    self.inside = false;
                    continue;
                }
                let keep = Self::partial_tag_len(&buf, CLOSE);
                self.pending = buf[buf.len() - keep..].to_string();
                return out;
            }
            if let Some(i) = buf.find(OPEN) {
                out.push_str(&buf[..i]);
                buf = buf[i + OPEN.len()..].to_string();
                self.inside = true;
                continue;
            }
            let keep = Self::partial_tag_len(&buf, OPEN);
            out.push_str(&buf[..buf.len() - keep]);
            self.pending = buf[buf.len() - keep..].to_string();
            return out;
        }
    }

    /// The stream ended: a held-back partial tag that never completed was
    /// ordinary text after all.
    fn finish(&mut self) -> String {
        if self.inside {
            self.pending.clear();
            String::new()
        } else {
            std::mem::take(&mut self.pending)
        }
    }
}

/// Ollama's refusal when `think` is set on a model with no thinking mode.
fn is_think_unsupported(status: u16, body: &str) -> bool {
    status == 400 && body.to_lowercase().contains("thinking")
}

/// Ollama's own words for "no such model", turned into a sentinel the
/// renderer can explain with the exact command to run.
fn ollama_error_message(status: u16, body: &str, model: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
    if status == 404 || detail.as_deref().map_or(false, |d| d.contains("not found")) {
        return format!("model-missing:{model}");
    }
    detail.unwrap_or_else(|| format!("The local model server returned {status}."))
}

/// Ask a local model, streaming the answer to
/// `atlas://intelligence/{stream_id}` as it arrives.
///
/// Returns the sentinel `offline` when Ollama is simply not running — that is
/// not an error anyone needs a paragraph about — and `model-missing:<tag>`
/// when it is running but the model has not been pulled. Raced against the
/// emergency stop: a halt drops the request mid-flight, which closes the
/// connection, so the model stops generating for us rather than finishing an
/// answer nobody will read — see `halt::Halt::race`.
#[tauri::command]
pub async fn ask_local_model_stream(
    app: tauri::AppHandle,
    base_url: String,
    model: String,
    prompt: String,
    think: Option<bool>,
    stream_id: String,
) -> Result<String, String> {
    crate::halt::global()
        .race(ask_local_model_unraced(app, base_url, model, prompt, think, stream_id))
        .await
}

async fn ask_local_model_unraced(
    app: tauri::AppHandle,
    base_url: String,
    model: String,
    prompt: String,
    think: Option<bool>,
    stream_id: String,
) -> Result<String, String> {
    validate_prompt(&prompt)?;
    validate_model_tag(&model)?;
    let base = validate_base_url(&base_url, OLLAMA_DEFAULT_URL)?;
    let client = http_client()?;

    let send = |think: Option<bool>| {
        client
            .post(format!("{base}/api/chat"))
            .json(&chat_body(&model, &prompt, think))
            .send()
    };
    // A refused connection means Ollama isn't up: the normal state on a
    // machine where it was never started.
    let mut resp = send(think).await.map_err(|_| "offline".to_string())?;

    // Thinking is switched off for speed, but not every model has a thinking
    // mode to switch. Ask again without the field rather than fail a chat over
    // a speed preference.
    if !resp.status().is_success() && think.is_some() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if is_think_unsupported(status, &text) {
            resp = send(None).await.map_err(|_| "offline".to_string())?;
        } else {
            return Err(ollama_error_message(status, &text, &model));
        }
    }

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(ollama_error_message(status, &text, &model));
    }

    let channel = format!("atlas://intelligence/{stream_id}");
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut partial: Vec<u8> = Vec::new();
    let mut filter = ThinkFilter::new();
    let mut answer = String::new();
    let mut finished = false;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("The model's stream was interrupted: {e}"))?;
        push_utf8(&mut buffer, &mut partial, &bytes);

        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].to_string();
            buffer.drain(..=newline);
            let Some(parsed) = parse_chat_line(&line) else { continue };
            if let Some(err) = parsed.error {
                return Err(if err.contains("not found") {
                    format!("model-missing:{model}")
                } else {
                    err
                });
            }
            let piece = filter.push(&parsed.delta);
            if !piece.is_empty() {
                answer.push_str(&piece);
                let _ = app.emit(&channel, &piece);
            }
            if parsed.done {
                finished = true;
            }
        }
        if finished {
            break;
        }
    }
    let tail = filter.finish();
    if !tail.is_empty() {
        answer.push_str(&tail);
        let _ = app.emit(&channel, &tail);
    }

    let answer = answer.trim().to_string();
    if answer.is_empty() {
        return Err("The model didn't return any text.".into());
    }
    Ok(answer)
}

/// Append a network chunk to `buffer` without splitting a multi-byte character.
///
/// A chunk boundary can fall in the middle of a character (an accented letter,
/// an emoji), and decoding each chunk on its own would turn both halves into
/// U+FFFD and corrupt the JSON line they sit in. The incomplete tail is held in
/// `partial` until the rest arrives; genuinely invalid bytes are still replaced.
fn push_utf8(buffer: &mut String, partial: &mut Vec<u8>, chunk: &[u8]) {
    partial.extend_from_slice(chunk);
    match std::str::from_utf8(partial) {
        Ok(text) => {
            buffer.push_str(text);
            partial.clear();
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            buffer.push_str(std::str::from_utf8(&partial[..valid]).unwrap_or(""));
            partial.drain(..valid);
        }
        Err(_) => {
            buffer.push_str(&String::from_utf8_lossy(partial));
            partial.clear();
        }
    }
}

/// One model Ollama has on disk.
#[derive(Serialize)]
pub struct InstalledModel {
    pub name: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

fn parse_tags(body: &str) -> Vec<InstalledModel> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    v.get("models")
        .and_then(|m| m.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    Some(InstalledModel {
                        name: m.get("name")?.as_str()?.to_string(),
                        size_bytes: m.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Which models Ollama has installed. `Err("offline")` when it is not
/// running — which is how Settings tells "not running" from "running, nothing
/// pulled yet". A read: it changes nothing on the machine.
#[tauri::command]
pub async fn local_models_installed(base_url: String) -> Result<Vec<InstalledModel>, String> {
    let base = validate_base_url(&base_url, OLLAMA_DEFAULT_URL)?;
    let client = reqwest::Client::builder()
        // A probe that takes a minute is not a probe.
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|_| "offline".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("The local model server returned {}.", resp.status()));
    }
    let body = resp.text().await.map_err(|_| "offline".to_string())?;
    Ok(parse_tags(&body))
}

// ---------------------------------------------------------------------------
// Nova Intelligence
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct NovaRequest<'a> {
    prompt: &'a str,
}

fn nova_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| {
        v.get("error")
            .or_else(|| v.get("detail"))
            .and_then(|e| e.as_str())
            .map(String::from)
    });
    match status {
        404 => "Nova Intelligence is running but has no /v1/ask/stream endpoint.".to_string(),
        503 => "Nova Intelligence is running but has no model loaded yet.".to_string(),
        _ => detail.unwrap_or_else(|| format!("Nova Intelligence returned {status}.")),
    }
}

/// One `data: {...}` event out of the SSE stream, decoded into what the
/// caller below actually needs. `None` for a line that wasn't valid JSON — a
/// stream is read best-effort, not line-by-line asserted.
enum NovaEvent {
    Delta(String),
    Done { ok: bool, text: String, error: Option<String> },
}

fn parse_nova_event(data: &str) -> Option<NovaEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    if value.get("done").and_then(|d| d.as_bool()) == Some(true) {
        return Some(NovaEvent::Done {
            ok: value.get("ok").and_then(|o| o.as_bool()).unwrap_or(false),
            text: value.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            error: value.get("error").and_then(|e| e.as_str()).map(String::from),
        });
    }
    let delta = value.get("delta").and_then(|d| d.as_str())?;
    Some(NovaEvent::Delta(delta.to_string()))
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

async fn consume_nova_sse(
    app: &tauri::AppHandle,
    stream_id: &str,
    response: reqwest::Response,
) -> Result<String, String> {
    let channel = format!("atlas://intelligence/{stream_id}");
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut partial: Vec<u8> = Vec::new();
    let mut resolution: Option<Result<String, String>> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Nova Intelligence's stream was interrupted: {e}"))?;
        push_utf8(&mut buffer, &mut partial, &bytes);

        while let Some((end, next_start)) = find_event_boundary(&buffer) {
            let event_text = buffer[..end].to_string();
            buffer.drain(..next_start);

            for line in event_text.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                match parse_nova_event(data.trim()) {
                    Some(NovaEvent::Delta(delta)) => {
                        let _ = app.emit(&channel, &delta);
                    }
                    Some(NovaEvent::Done { ok, text, error }) => {
                        resolution = Some(if ok {
                            Ok(text)
                        } else {
                            Err(error.unwrap_or_else(|| {
                                "Nova Intelligence couldn't answer.".to_string()
                            }))
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
        Err("Nova Intelligence's stream ended before it finished answering.".to_string())
    })
}

/// Ask Nova Intelligence, streaming to `atlas://intelligence/{stream_id}`.
/// Same contract as `ask_local_model_stream`: `offline` when it is not
/// running, raced against the emergency stop.
#[tauri::command]
pub async fn ask_nova_intelligence_stream(
    app: tauri::AppHandle,
    base_url: String,
    prompt: String,
    stream_id: String,
) -> Result<String, String> {
    crate::halt::global()
        .race(ask_nova_unraced(app, base_url, prompt, stream_id))
        .await
}

async fn ask_nova_unraced(
    app: tauri::AppHandle,
    base_url: String,
    prompt: String,
    stream_id: String,
) -> Result<String, String> {
    validate_prompt(&prompt)?;
    let base = validate_base_url(&base_url, NOVA_DEFAULT_URL)?;
    let client = http_client()?;

    let resp = client
        .post(format!("{base}/v1/ask/stream"))
        .json(&NovaRequest { prompt: &prompt })
        .send()
        .await
        .map_err(|_| "offline".to_string())?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(nova_error_message(status, &text));
    }

    consume_nova_sse(&app, &stream_id, resp).await
}

/// Is Nova Intelligence up? Lets Settings show a live state rather than a
/// guess. A read: it changes nothing on the machine.
#[tauri::command]
pub async fn nova_intelligence_reachable(base_url: String) -> Result<bool, String> {
    let base = validate_base_url(&base_url, NOVA_DEFAULT_URL)?;
    let client = reqwest::Client::builder()
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

    // ---- validation --------------------------------------------------------

    #[test]
    fn a_character_split_across_chunks_survives() {
        let text = "café 🍕 done";
        let whole = text.as_bytes();
        for cut in 1..whole.len() {
            let (mut buf, mut part) = (String::new(), Vec::new());
            push_utf8(&mut buf, &mut part, &whole[..cut]);
            push_utf8(&mut buf, &mut part, &whole[cut..]);
            assert_eq!(buf, text, "cut at {cut}");
            assert!(part.is_empty());
        }
    }

    #[test]
    fn rejects_an_empty_prompt() {
        assert!(validate_prompt("").is_err());
        assert!(validate_prompt("   ").is_err());
        assert!(validate_prompt("what does RAM actually do?").is_ok());
    }

    #[test]
    fn an_empty_base_url_falls_back_to_each_servers_own_default() {
        assert_eq!(validate_base_url("", OLLAMA_DEFAULT_URL).unwrap(), OLLAMA_DEFAULT_URL);
        assert_eq!(validate_base_url("   ", NOVA_DEFAULT_URL).unwrap(), NOVA_DEFAULT_URL);
    }

    #[test]
    fn loopback_is_allowed_and_a_trailing_slash_is_normalised_away() {
        assert!(validate_base_url("http://127.0.0.1:11434", OLLAMA_DEFAULT_URL).is_ok());
        assert!(validate_base_url("http://localhost:9000", OLLAMA_DEFAULT_URL).is_ok());
        assert_eq!(
            validate_base_url("http://127.0.0.1:11434/", OLLAMA_DEFAULT_URL).unwrap(),
            "http://127.0.0.1:11434"
        );
    }

    /// The test this module exists for. If any of these ever start passing,
    /// the "local models never leave the machine" guarantee is gone.
    #[test]
    fn anything_that_is_not_loopback_is_refused() {
        for url in [
            "https://api.openai.com",
            "https://api.anthropic.com",
            "https://generativelanguage.googleapis.com",
            "http://192.168.1.10:11434",
            "http://example.com",
            // The reason the host is parsed rather than substring-matched.
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
        ] {
            assert!(
                validate_base_url(url, OLLAMA_DEFAULT_URL).is_err(),
                "should have refused {url}"
            );
        }
    }

    #[test]
    fn a_non_http_scheme_is_refused() {
        assert!(validate_base_url("file:///etc/passwd", OLLAMA_DEFAULT_URL).is_err());
        assert!(validate_base_url("ftp://127.0.0.1", OLLAMA_DEFAULT_URL).is_err());
    }

    #[test]
    fn model_tags_are_names_and_nothing_else() {
        for ok in ["qwen3:8b", "qwen3-coder:30b", "llama3.2:3b", "hf.co/user/model:Q4_K_M", "qwen3"] {
            assert!(validate_model_tag(ok).is_ok(), "{ok}");
        }
        let too_long = "x".repeat(101);
        for bad in ["", "a b", "qwen3;rm -rf", "../../etc", "model\n", "a\"b", too_long.as_str()] {
            assert!(validate_model_tag(bad).is_err(), "{bad:?}");
        }
    }

    // ---- which model a request names --------------------------------------

    #[test]
    fn the_request_names_exactly_the_model_it_was_given() {
        for model in ["qwen3:8b", "qwen3:30b", "qwen3-coder:30b", "qwen3.5:9b"] {
            let body = chat_body(model, "hi", None);
            assert_eq!(body["model"], model);
            assert_eq!(body["stream"], true);
            assert_eq!(body["messages"][0]["role"], "user");
            assert_eq!(body["messages"][0]["content"], "hi");
        }
    }

    #[test]
    fn the_model_is_kept_loaded_between_messages() {
        assert_eq!(chat_body("qwen3:8b", "x", None)["keep_alive"], "30m");
    }

    #[test]
    fn a_model_with_no_thinking_mode_is_asked_again_without_the_field() {
        assert!(is_think_unsupported(400, r#"{"error":"\"llama3\" does not support thinking"}"#));
        assert!(!is_think_unsupported(404, r#"{"error":"model not found"}"#));
        assert!(!is_think_unsupported(400, r#"{"error":"bad json"}"#));
        assert!(!is_think_unsupported(500, "thinking"));
    }

    #[test]
    fn thinking_is_only_sent_when_it_was_chosen() {
        assert_eq!(chat_body("qwen3:8b", "x", Some(false))["think"], false);
        assert_eq!(chat_body("qwen3:8b", "x", Some(true))["think"], true);
        // "leave it alone" is an absent field — a model with no thinking mode
        // refuses `think: true`, and `null` is not the same as absent.
        assert!(chat_body("qwen3-coder:30b", "x", None).get("think").is_none());
    }

    // ---- reading the stream -----------------------------------------------

    #[test]
    fn a_chat_line_yields_the_answer_and_never_the_thinking() {
        let line = r#"{"model":"qwen3:30b","message":{"role":"assistant","content":"Hel","thinking":"the user wants a greeting"},"done":false}"#;
        let parsed = parse_chat_line(line).unwrap();
        assert_eq!(parsed.delta, "Hel");
        assert!(!parsed.done);
        assert!(!parsed.delta.contains("greeting"));
    }

    #[test]
    fn a_thinking_only_line_yields_no_text() {
        let line = r#"{"message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}"#;
        assert_eq!(parse_chat_line(line).unwrap().delta, "");
    }

    #[test]
    fn the_final_line_and_an_error_line_are_recognised() {
        assert!(parse_chat_line(r#"{"message":{"content":""},"done":true}"#).unwrap().done);
        let e = parse_chat_line(r#"{"error":"model 'x' not found"}"#).unwrap();
        assert_eq!(e.error.as_deref(), Some("model 'x' not found"));
        assert!(parse_chat_line("not json").is_none());
    }

    #[test]
    fn ollama_errors_become_the_sentinel_the_renderer_explains() {
        assert_eq!(ollama_error_message(404, "", "qwen3:8b"), "model-missing:qwen3:8b");
        assert_eq!(
            ollama_error_message(500, r#"{"error":"model 'qwen3:8b' not found"}"#, "qwen3:8b"),
            "model-missing:qwen3:8b"
        );
        assert!(ollama_error_message(500, r#"{"error":"boom"}"#, "m").contains("boom"));
        assert!(ollama_error_message(500, "not json", "m").contains("500"));
    }

    #[test]
    fn parses_the_installed_model_list() {
        let body = r#"{"models":[{"name":"qwen3:8b","size":5200000000},{"name":"qwen3.5:9b","size":6600000000},{"nope":1}]}"#;
        let m = parse_tags(body);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].name, "qwen3:8b");
        assert_eq!(m[1].size_bytes, 6_600_000_000);
        assert!(parse_tags("garbage").is_empty());
        assert!(parse_tags("{}").is_empty());
    }

    // ---- <think> filtering -------------------------------------------------

    fn run_filter(chunks: &[&str]) -> String {
        let mut f = ThinkFilter::new();
        let mut out = String::new();
        for c in chunks {
            out.push_str(&f.push(c));
        }
        out.push_str(&f.finish());
        out
    }

    #[test]
    fn inline_thinking_is_removed_in_one_chunk() {
        assert_eq!(run_filter(&["<think>plan the reply</think>Hello there."]), "Hello there.");
        assert_eq!(run_filter(&["A <think>x</think>B <think>y</think>C"]), "A B C");
    }

    #[test]
    fn a_tag_split_across_chunks_is_still_recognised() {
        assert_eq!(run_filter(&["Hi <thi", "nk>secret</th", "ink> there"]), "Hi  there");
        assert_eq!(run_filter(&["<", "think>", "a", "</think>", "ok"]), "ok");
    }

    #[test]
    fn text_that_only_looks_like_a_tag_is_kept() {
        assert_eq!(run_filter(&["use a < b and c > d"]), "use a < b and c > d");
        assert_eq!(run_filter(&["ends with <thi"]), "ends with <thi");
    }

    #[test]
    fn an_unterminated_thought_is_dropped_not_shown() {
        assert_eq!(run_filter(&["Answer. <think>never closed"]), "Answer. ");
    }

    #[test]
    fn plain_text_passes_through_untouched() {
        assert_eq!(run_filter(&["Hello ", "wörld ", "✓"]), "Hello wörld ✓");
    }

    // ---- Nova Intelligence's SSE stream ------------------------------------

    #[test]
    fn event_boundary_prefers_crlf_over_the_bare_lf_pair_inside_it() {
        let buf = "data: {}\r\n\r\ndata: {}\r\n\r\n";
        let (end, next_start) = find_event_boundary(buf).unwrap();
        assert_eq!(&buf[..end], "data: {}");
        assert_eq!(next_start, end + 4);
    }

    #[test]
    fn event_boundary_falls_back_to_a_bare_double_newline_and_waits_for_a_complete_event() {
        let buf = "data: {}\n\nrest";
        let (end, next_start) = find_event_boundary(buf).unwrap();
        assert_eq!(&buf[..end], "data: {}");
        assert_eq!(next_start, end + 2);
        assert!(find_event_boundary("data: {\"delta\":").is_none());
    }

    #[test]
    fn nova_events_parse() {
        match parse_nova_event(r#"{"delta": "Hel"}"#) {
            Some(NovaEvent::Delta(d)) => assert_eq!(d, "Hel"),
            _ => panic!("expected a delta"),
        }
        match parse_nova_event(
            r#"{"done": true, "ok": false, "text": "", "error": "no model loaded"}"#,
        ) {
            Some(NovaEvent::Done { ok, error, .. }) => {
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("no model loaded"));
            }
            _ => panic!("expected a done event"),
        }
        assert!(parse_nova_event("not json").is_none());
        assert!(parse_nova_event(r#"{"unrelated": true}"#).is_none());
    }

    #[test]
    fn nova_errors_explain_the_two_states_worth_explaining() {
        assert!(nova_error_message(404, "").contains("/v1/ask/stream"));
        assert!(nova_error_message(503, "").contains("no model"));
        assert!(nova_error_message(500, r#"{"error": "boom"}"#).contains("boom"));
        assert!(nova_error_message(500, "not json").contains("500"));
    }

    // ---- the model layer cannot act ----------------------------------------

    /// The whole point of the split: this file may only *talk*. If code that
    /// runs, launches or presses anything ever appears here it belongs in a
    /// skill, behind the executor's permissions.
    #[test]
    fn this_module_cannot_act_on_the_machine() {
        let src = include_str!("intelligence.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for forbidden in [
            "std::process",
            "Command::new",
            "ShellExecute",
            "SendInput",
            "std::fs::write",
            "std::fs::remove",
            "CreateProcess",
        ] {
            assert!(!body.contains(forbidden), "intelligence.rs must not use {forbidden}");
        }
    }
}
