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
        // Never follow a redirect. The key travels in a request header
        // (`x-api-key`, `x-goog-api-key`, `Authorization`), and the HTTP client
        // only strips the standard ones when a redirect leaves the host; a
        // provider that redirects is a provider whose address should be fixed.
        .redirect(reqwest::redirect::Policy::none())
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
pub(crate) fn resolve_base_url(kind: CloudProviderKind, base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    // Every request below appends `/v1/...` itself; a base pasted in as
    // `https://host/v1` would otherwise become `/v1/v1/...` and 404.
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    if !trimmed.is_empty() {
        check_transport(trimmed)?;
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

/// The key is sent to this address, so it has to be somewhere a key may go:
/// https, or plain http only to this machine (a self-hosted proxy). A pasted
/// `http://api.example.com` would otherwise send the key across the network in
/// the clear.
fn check_transport(base: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base).map_err(|_| "That doesn't look like a URL.".to_string())?;
    match url.scheme() {
        "https" => Ok(()),
        "http" => match url.host_str() {
            Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => Ok(()),
            _ => Err("That address has to start with https:// — a key is never sent over plain http to another machine.".to_string()),
        },
        _ => Err("That address has to start with https://.".to_string()),
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

// ---- what a provider hands back ---------------------------------------------------

/// A tool the model proposed to call. Only ever a *proposal*: it is returned to the interface,
/// validated against the registered skills there, and run (or not) by the executor like any plan.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// The reply: what the model said, and any tool calls it proposed.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudReply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Records a request as "may have been billed" if it is dropped (halted) while in flight.
struct InFlight {
    provider_id: String,
    input: u64,
    armed: bool,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if self.armed {
            crate::stats::record_model(
                "model.cloud",
                Some(&self.provider_id),
                crate::usage::Counted::Uncertain { input: self.input },
                false,
            );
        }
    }
}

struct Parsed {
    reply: CloudReply,
    usage: Option<crate::usage::Usage>,
}

/// A failed provider call: what to tell the person, and how far the request got, which decides
/// whether it may have been billed (see `usage.rs`).
struct Failure {
    message: String,
    tx: crate::usage::Transmission,
    /// If the failed response still said what it used, the provider counted it.
    usage: Option<crate::usage::Usage>,
}

impl Failure {
    fn transport(e: &reqwest::Error) -> Self {
        Failure { message: send_error(e), tx: crate::usage::classify_transport(e), usage: None }
    }
    /// The reply started and then could not be read to the end: the provider got the request.
    fn unreadable() -> Self {
        Failure {
            message: "Couldn't read the provider's response.".to_string(),
            tx: crate::usage::Transmission::MaybeSent,
            usage: None,
        }
    }
    fn status(status: u16, body: &str) -> Self {
        Failure {
            message: crate::cloud_safety::tag_failure(status, body, provider_error_message(status, body)),
            tx: crate::usage::classify_status(status),
            usage: crate::usage::parse(body),
        }
    }
    /// A 2xx whose body wasn't the expected shape: the provider processed the request.
    fn malformed(body: &str) -> Self {
        Failure {
            message: "That provider's response didn't look like what I expected.".to_string(),
            tx: crate::usage::Transmission::MaybeSent,
            usage: crate::usage::parse(body),
        }
    }
    fn empty(body: &str) -> Self {
        Failure { message: empty_reply(), tx: crate::usage::Transmission::MaybeSent, usage: crate::usage::parse(body) }
    }
}

fn empty_reply() -> String {
    "The provider didn't return any text.".to_string()
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
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessageOut,
}
#[derive(Deserialize)]
struct OpenAiMessageOut {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<OpenAiToolCall>,
}
#[derive(Deserialize)]
struct OpenAiToolCall {
    function: OpenAiFunction,
}
#[derive(Deserialize)]
struct OpenAiFunction {
    name: String,
    /// A JSON document in a string, per the wire format.
    #[serde(default)]
    arguments: String,
}
#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

/// `[{name, description, parameters}]` → OpenAI's `tools`.
fn openai_tools(tools: &serde_json::Value) -> Vec<serde_json::Value> {
    tools
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": t.get("name").cloned().unwrap_or_default(),
                            "description": t.get("description").cloned().unwrap_or_default(),
                            "parameters": t.get("parameters").cloned().unwrap_or_default(),
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn ask_openai_compatible(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
    tools: Option<&serde_json::Value>,
    schema: Option<&serde_json::Value>,
) -> Result<Parsed, Failure> {
    let tool_defs = tools.map(openai_tools).filter(|d| !d.is_empty());
    let resp = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth(key)
        .json(&OpenAiRequest {
            model,
            messages: [OpenAiMessage { role: "user", content: prompt }],
            stream: false,
            tool_choice: tool_defs.as_ref().map(|_| "auto"),
            tools: tool_defs,
            response_format: schema.map(|s| {
                serde_json::json!({
                    "type": "json_schema",
                    "json_schema": { "name": "atlas_plan", "schema": s, "strict": false }
                })
            }),
        })
        .send()
        .await
        .map_err(|e| Failure::transport(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| Failure::unreadable())?;
    if !status.is_success() {
        return Err(Failure::status(status.as_u16(), &text));
    }

    let parsed: OpenAiResponse = serde_json::from_str(&text)
        .map_err(|_| Failure::malformed(&text))?;
    let message = parsed.choices.into_iter().next().map(|c| c.message).ok_or_else(|| Failure::empty(&text))?;
    let calls: Vec<ToolCall> = message
        .tool_calls
        .into_iter()
        .map(|c| ToolCall {
            name: c.function.name,
            arguments: serde_json::from_str(&c.function.arguments).unwrap_or(serde_json::Value::Null),
        })
        .collect();
    let said = message.content.unwrap_or_default();
    if said.trim().is_empty() && calls.is_empty() {
        return Err(Failure::empty(&text));
    }
    Ok(Parsed {
        reply: CloudReply { text: said, tool_calls: calls },
        usage: crate::usage::parse(&text),
    })
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
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    input: Option<serde_json::Value>,
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
    tools: Option<&serde_json::Value>,
) -> Result<Parsed, Failure> {
    let defs: Option<Vec<serde_json::Value>> = tools
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.get("name").cloned().unwrap_or_default(),
                        "description": t.get("description").cloned().unwrap_or_default(),
                        "input_schema": t.get("parameters").cloned().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .filter(|d: &Vec<serde_json::Value>| !d.is_empty());
    let resp = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&AnthropicRequest {
            model,
            max_tokens: 4096,
            messages: [AnthropicMessage { role: "user", content: prompt }],
            tools: defs,
        })
        .send()
        .await
        .map_err(|e| Failure::transport(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| Failure::unreadable())?;
    if !status.is_success() {
        return Err(Failure::status(status.as_u16(), &text));
    }

    let parsed: AnthropicResponse = serde_json::from_str(&text)
        .map_err(|_| Failure::malformed(&text))?;
    let mut said = String::new();
    let mut calls = Vec::new();
    for block in parsed.content {
        match block.kind.as_deref() {
            Some("tool_use") => {
                if let Some(name) = block.name {
                    calls.push(ToolCall { name, arguments: block.input.unwrap_or(serde_json::Value::Null) });
                }
            }
            _ => {
                if said.is_empty() {
                    if let Some(t) = block.text {
                        said = t;
                    }
                }
            }
        }
    }
    if said.trim().is_empty() && calls.is_empty() {
        return Err(Failure::empty(&text));
    }
    Ok(Parsed {
        reply: CloudReply { text: said, tool_calls: calls },
        usage: crate::usage::parse(&text),
    })
}

// ---- Gemini -----------------------------------------------------------------------
// Plain text only: Atlas does not declare tool calling for Gemini, so none is offered.

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
) -> Result<Parsed, Failure> {
    let resp = client
        .post(format!("{base}/v1beta/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&GeminiRequest {
            contents: [GeminiContent { parts: [GeminiPart { text: prompt }] }],
        })
        .send()
        .await
        .map_err(|e| Failure::transport(&e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|_| Failure::unreadable())?;
    if !status.is_success() {
        return Err(Failure::status(status.as_u16(), &text));
    }

    let parsed: GeminiResponse = serde_json::from_str(&text)
        .map_err(|_| Failure::malformed(&text))?;
    let said = parsed
        .candidates
        .into_iter()
        .next()
        .and_then(|c| c.content.parts.into_iter().find_map(|p| p.text))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Failure::empty(&text))?;
    Ok(Parsed {
        reply: CloudReply { text: said, tool_calls: Vec::new() },
        usage: crate::usage::parse(&text),
    })
}

// ---- the one command --------------------------------------------------------------

/// Raced against the emergency stop: a halt drops the request mid-flight,
/// which closes the connection — see `halt::Halt::race`.
#[tauri::command]
pub async fn ask_cloud_provider(
    provider_id: String,
    model: String,
    prompt: String,
    tools: Option<serde_json::Value>,
    schema: Option<serde_json::Value>,
) -> Result<CloudReply, String> {
    // A provider's error text is shown to the person and may be logged; some echo the key they
    // rejected, so it is redacted at the one place everything leaves through.
    crate::halt::global()
        .race(ask_cloud_provider_unraced(provider_id, model, prompt, tools, schema))
        .await
        .map_err(|e| crate::redact::redact(&e))
}

async fn ask_cloud_provider_unraced(
    provider_id: String,
    model: String,
    prompt: String,
    tools: Option<serde_json::Value>,
    schema: Option<serde_json::Value>,
) -> Result<CloudReply, String> {
    validate_prompt(&prompt)?;
    // Shape-checked and bounded here, in the same words the local path uses: what a page offers a
    // model as tools or as a schema is data for the model, never something Atlas runs.
    crate::intelligence::check_constraints(tools.as_ref(), schema.as_ref())?;
    // Where this key may go is decided here, from the native binding, never from the caller: a
    // request that names its own address cannot get a saved key attached to it.
    let binding = crate::provider_bindings::get(&provider_id).ok_or_else(|| {
        "This provider's address hasn't been confirmed. Remove it and add it again in Settings → Intelligence."
            .to_string()
    })?;
    let key = crate::secrets::read_secret(&provider_id)?
        .ok_or_else(|| "No API key saved for this provider.".to_string())?;
    // Re-judged on every request: a binding is data, and data is not trusted just for being stored.
    let kind = binding.kind;
    let base = crate::provider_bindings::validate(kind, &binding.base_url)?;

    // Atlas's own protections come first, and cost nothing: a provider that is paused, over a cap
    // the person set, or being hammered by a loop is refused here, before any request is made.
    crate::cloud_safety::before_request(&provider_id)?;

    let client = http_client()?;
    let tokens_in = crate::stats::estimate_tokens(&prompt);
    // The emergency stop drops this future mid-request. A request that was in flight may have
    // reached the provider, so if we are dropped before an outcome is known it is recorded as
    // uncertain rather than vanishing from the cap.
    let mut in_flight = InFlight { provider_id: provider_id.clone(), input: tokens_in, armed: true };
    let outcome = match kind {
        CloudProviderKind::OpenaiCompatible => {
            ask_openai_compatible(&client, &base, &key, &model, &prompt, tools.as_ref(), schema.as_ref()).await
        }
        CloudProviderKind::Anthropic => {
            ask_anthropic(&client, &base, &key, &model, &prompt, tools.as_ref()).await
        }
        CloudProviderKind::Gemini => ask_gemini(&client, &base, &key, &model, &prompt).await,
    };

    in_flight.armed = false;
    match outcome {
        Ok(Parsed { reply, usage }) => {
            // The provider's own figures when it gave them; otherwise an estimate, which the
            // Stats page labels as one.
            let counted = crate::usage::for_success(usage, tokens_in, crate::stats::estimate_tokens(&reply.text));
            crate::stats::record_model("model.cloud", Some(&provider_id), counted, true);
            Ok(reply)
        }
        Err(Failure { message, tx, usage }) => {
            // A failure is NOT charged an invented token count. What it is counted as depends on
            // how far it got: nothing if it never left this machine, the request alone if the
            // provider turned it away, and an "uncertain" input estimate if it may have been billed.
            crate::stats::record_model("model.cloud", Some(&provider_id), crate::usage::for_failure(tx, usage, tokens_in), false);
            // A spending limit pauses the provider here, natively, so the next request is refused
            // without being sent. It never switches to another provider.
            crate::cloud_safety::after_failure(&provider_id, &message);
            Err(message)
        }
    }
}

/// The Settings page's "Test connection" button — the same call
/// `ask_cloud_provider` makes, with a fixed, tiny, harmless prompt. Kept as a
/// separate command rather than a flag on the one above: a test is
/// conceptually "does this work at all", not "answer this specific thing",
/// and a caller should never confuse the two by mistake.
#[tauri::command]
pub async fn test_cloud_provider(provider_id: String, model: String) -> Result<String, String> {
    ask_cloud_provider(provider_id, model, "Reply with just the word OK.".to_string(), None, None)
        .await
        .map(|r| r.text)
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
    fn a_key_is_never_sent_over_plain_http_to_another_machine() {
        let k = CloudProviderKind::OpenaiCompatible;
        assert!(resolve_base_url(k, "http://api.example.com").is_err());
        assert!(resolve_base_url(k, "ftp://api.example.com").is_err());
        assert!(resolve_base_url(k, "not a url").is_err());
        assert!(resolve_base_url(k, "https://api.example.com").is_ok());
        // A proxy on this machine is fine over http.
        assert!(resolve_base_url(k, "http://localhost:4000").is_ok());
        assert!(resolve_base_url(k, "http://127.0.0.1:4000/v1").is_ok());
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
