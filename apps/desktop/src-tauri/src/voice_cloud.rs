//! Speaking and listening through a connected service, when you ask for it.
//!
//! ## This is the exception, and it is shaped like one
//!
//! Everything else about voice in Atlas runs on this machine. This module is
//! the one path where a recording or a sentence leaves it, so it is kept in
//! its own file rather than folded into `speech.rs` and `listen.rs`: reading
//! either of those should never leave you wondering whether the audio went
//! somewhere. It did not. It goes somewhere here, and only here.
//!
//! It is unreachable unless two separate things are true — the `voice.online`
//! preference is on, and an API key is configured. Neither defaults to true,
//! and the preference is read so that a missing or malformed value is false.
//!
//! ## What it actually buys, measured
//!
//! Not speed. On this hardware Piper synthesises a sentence in about a fifth
//! of a second (real-time factor 0.067) and whisper `base.en` transcribes a
//! three-second clip in 0.9s including model load — both comfortably faster
//! than a round trip to a datacentre. What a service offers is a different
//! set of voices and a larger transcription model that copes better with
//! accents, background noise and unfamiliar names.
//!
//! On a slower machine the speed argument may invert. That is the honest
//! reason this is a preference rather than a recommendation.
//!
//! ## Voices are not the same voices
//!
//! The local model's personas are eight British regional speakers, which are
//! a property of that model and do not exist elsewhere. Rather than pretend
//! to map "Yorkshire" onto a service's catalogue, the online path uses one
//! named voice and the Voice tab says so. A picker that silently substitutes
//! a different voice than the one selected is worse than one that admits the
//! two sets are different.

use serde::Serialize;

/// The service's text-to-speech voice.
///
/// One, named, rather than a second picker. `onyx` is the deeper male option,
/// which is the nearest thing to the local default the user chose.
const ONLINE_VOICE: &str = "onyx";

/// Small and current rather than the flagship: this reads short replies
/// aloud, a job the smaller model does indistinguishably and faster.
const TTS_MODEL: &str = "gpt-4o-mini-tts";

/// The newer transcription model rather than `whisper-1` — better on exactly
/// the audio the local model struggles with, which is the only reason anyone
/// would turn this on.
const STT_MODEL: &str = "gpt-4o-transcribe";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A ceiling on waiting. A voice feature that hangs is worse than one
        // that fails, because there is nothing to fall back to until it does.
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Couldn't start the request: {e}"))
}

fn check(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("No key is configured for online voices.".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct SpeechRequest<'a> {
    model: &'a str,
    voice: &'a str,
    input: &'a str,
    /// WAV rather than the default MP3: the page decodes this through Web
    /// Audio, which handles both, but WAV needs no decoder work and the
    /// bytes are going straight into an `AudioBuffer` either way.
    response_format: &'a str,
    speed: f32,
}

/// Synthesise through the service. Returns WAV bytes, like the local path.
#[tauri::command]
pub async fn synthesize_speech_online(
    api_key: String,
    text: String,
    pace: Option<f32>,
) -> Result<tauri::ipc::Response, String> {
    check(&api_key)?;
    let spoken = text.trim();
    if spoken.is_empty() {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let spoken: String = spoken.chars().take(2000).collect();

    // The local engine's `pace` is a length scale where higher is slower; the
    // service takes a speed multiplier where higher is faster. Inverted here
    // rather than at the call site, so one preference means one thing
    // everywhere and this is the only place that knows the difference.
    let speed = (1.0 / pace.unwrap_or(1.06).clamp(0.6, 2.0)).clamp(0.25, 4.0);

    let client = http_client()?;
    let response = client
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(&api_key)
        .json(&SpeechRequest {
            model: TTS_MODEL,
            voice: ONLINE_VOICE,
            input: &spoken,
            response_format: "wav",
            speed,
        })
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the speech service: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(describe(status, &detail));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Couldn't read the audio: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// Transcribe through the service. Takes the same 16 kHz mono WAV the local
/// path takes, so the recorder needs to know nothing about which is in use.
/// The key arrives as a header, not an argument.
///
/// A command whose body is raw bytes has no room for JSON arguments beside
/// them — the body *is* the payload. Headers are the remaining channel, and
/// this one never leaves the IPC boundary inside the process.
#[tauri::command]
pub async fn transcribe_speech_online(
    request: tauri::ipc::Request<'_>,
) -> Result<crate::listen::Transcript, String> {
    let api_key = request
        .headers()
        .get("Atlas-Api-Key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    check(&api_key)?;

    let audio: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|_| "The audio didn't arrive as bytes.".to_string())?,
    };
    if audio.len() < 4_000 {
        return Ok(crate::listen::Transcript {
            text: String::new(),
            empty: true,
        });
    }

    let part = reqwest::multipart::Part::bytes(audio)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Couldn't package the audio: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .text("model", STT_MODEL)
        // English is stated rather than detected. The local model is
        // English-only, so letting the online one silently accept other
        // languages would make the two behave differently for the same words.
        .text("language", "en")
        .text("response_format", "json")
        .part("file", part);

    let client = http_client()?;
    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the transcription service: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(describe(status, &detail));
    }

    #[derive(serde::Deserialize)]
    struct TranscriptionResponse {
        text: String,
    }

    let parsed: TranscriptionResponse = response
        .json()
        .await
        .map_err(|e| format!("The transcription service sent something unreadable: {e}"))?;

    let heard = parsed.text.trim().to_string();
    Ok(crate::listen::Transcript {
        empty: heard.is_empty(),
        text: heard,
    })
}

/// Turn an HTTP failure into something a person can act on.
///
/// The service's own error body is a JSON envelope that says "invalid_api_key"
/// in the middle of a paragraph of schema. The status code carries the part
/// that determines what to *do*, so that is what gets said, with the body kept
/// short behind it for the cases that are genuinely unusual.
fn describe(status: reqwest::StatusCode, detail: &str) -> String {
    let hint = match status.as_u16() {
        401 | 403 => "The key was rejected. Check it in Settings → Developer.",
        429 => "The service is rate-limiting or the account is out of credit.",
        500..=599 => "The service is having trouble. Nothing is wrong on this machine.",
        _ => "The service refused the request.",
    };
    let tail: String = detail.chars().take(200).collect();
    if tail.trim().is_empty() {
        format!("{hint} ({status})")
    } else {
        format!("{hint} ({status}: {tail})")
    }
}
