//! Listening — Atlas hearing you, locally.
//!
//! ## Why a bundled engine rather than a service
//!
//! This is the half of Phase 8 that was deferred for two years' worth of good
//! reasons, all of which came down to one: every convenient speech-recognition
//! API is a microphone with a network cable on it. An assistant whose whole
//! thesis is "works with nothing connected, nothing is sent anywhere" cannot
//! ship a feature whose resting state is streaming your voice to a company.
//!
//! whisper.cpp settles it. The model runs on this CPU, the audio never leaves
//! the machine, and the deferred question turns out to have a local answer
//! that is fast enough: `base.en` transcribes a three-second utterance in
//! under a second on this hardware, model load included.
//!
//! ## This module transcribes. It does not record.
//!
//! The same split as `speech.rs`, for the same reason and in the other
//! direction. Rust owns the part that needs the machine — a neural model and a
//! CPU. The surface owns the part that needs the hardware the user consented
//! to: the microphone, its echo cancellation, its level meter and the silence
//! detection that decides when a sentence ended. So audio arrives here already
//! captured, already 16 kHz mono, and leaves as text.
//!
//! It also means there is no always-on microphone in this process. Rust cannot
//! start listening; it can only be handed something already recorded.
//!
//! ## The prompt is not decoration
//!
//! whisper takes an "initial prompt" that biases decoding, and without one it
//! reliably hears the product's own name as "at this". With a vocabulary line
//! in front of it, the same audio transcribes correctly. That is the
//! difference between an assistant you talk to and one you repeat yourself at,
//! so the prompt is treated as part of the engine rather than as a tuning
//! knob — and the surface may append what it knows (the names of apps you
//! actually have installed) to the base vocabulary.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::Manager;

/// The words Atlas expects to hear, given to whisper before it decodes.
///
/// Kept short on purpose: the initial prompt shares the model's 224-token
/// context, and a long one crowds out the audio it is supposed to be helping
/// with. These are the words whose *absence* was measurably wrong — the
/// product name first, then the verbs the grammar actually recognises.
const BASE_VOCABULARY: &str = "Atlas is a desktop assistant. \
Commands include: open, close, launch, run, search, find, show, \
clipboard, screenshot, volume, mute, timer, reminder, note, to-do, \
folder, file, window, battery, disk, uptime, processes.";

/// A transcript, and enough context for the surface to decide what to do.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Transcript {
    /// What was heard. Empty when the audio held no speech.
    pub text: String,
    /// True when the engine decided this was silence rather than words.
    pub empty: bool,
}

/// Where the engine and model live.
///
/// Bundled as Tauri resources in a shipped build, and read straight out of
/// `vendor/` during development. Both are checked because both are real: the
/// dev path does not exist on a user's machine, and the resource path does not
/// exist in a `cargo run`.
fn engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("vendor").join("whisper"));

    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vendor")
        .join("whisper");

    for candidate in [bundled, Some(dev)].into_iter().flatten() {
        if candidate.join("whisper-cli.exe").exists() && candidate.join("ggml-base.en.bin").exists()
        {
            return Some(candidate);
        }
    }
    None
}

pub fn available(app: &tauri::AppHandle) -> bool {
    engine_dir(app).is_some()
}

/// whisper's own markers for "there were no words here".
///
/// It emits these as if they were a transcript, and passing `[BLANK_AUDIO]`
/// to the engine as a user's question would be absurd. Matched case-insensitively
/// against the whole trimmed output, never against a substring — a sentence
/// that happens to contain "silence" is a real sentence.
fn is_silence(text: &str) -> bool {
    let lowered = text.trim().to_ascii_lowercase();
    lowered.is_empty()
        || lowered == "[blank_audio]"
        || lowered == "(blank_audio)"
        || lowered == "[silence]"
        || lowered == "(silence)"
        || lowered == "[inaudible]"
        || lowered == "(inaudible)"
        || lowered == "you"
        || lowered == "."
}

/// Transcribe 16 kHz mono WAV bytes.
///
/// `hints` is appended to the base vocabulary — the surface passes the names
/// of installed apps, so "open CrosshairX" survives the trip.
pub fn transcribe(
    app: &tauri::AppHandle,
    audio: &[u8],
    hints: Option<String>,
) -> Result<Transcript, String> {
    // A floor, not a guess: anything this short cannot contain a word, and
    // running the model on it wastes half a second to be told so.
    if audio.len() < 4_000 {
        return Ok(Transcript {
            text: String::new(),
            empty: true,
        });
    }

    let dir = engine_dir(app).ok_or("The listening engine isn't installed.")?;
    let exe = dir.join("whisper-cli.exe");
    let model = dir.join("ggml-base.en.bin");

    // A distinct name per call. Two utterances can overlap when a reply is
    // still being transcribed as the next one is captured, and a shared path
    // would have them reading each other's audio.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let input = std::env::temp_dir().join(format!("atlas-listen-{stamp}.wav"));
    fs::write(&input, audio).map_err(|e| format!("Couldn't stage the audio: {e}"))?;

    let prompt = match hints.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
        Some(extra) => format!("{BASE_VOCABULARY} {extra}"),
        None => BASE_VOCABULARY.to_string(),
    };

    let mut command = Command::new(&exe);
    // Without this every utterance flashes a console window, which is exactly
    // the bug that made speaking feel broken before it was found.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let finished = command
        // ggml loads its CPU backend as a sibling DLL chosen at runtime by
        // probing CPU features, and it looks for it next to the binary.
        .current_dir(&dir)
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&input)
        .arg("-l")
        .arg("en")
        // No timestamps and no progress chatter: stdout should be the sentence
        // and nothing else, so parsing it needs no cleverness.
        .arg("-nt")
        .arg("-np")
        .arg("--prompt")
        .arg(&prompt)
        .stdout(Stdio::piped())
        // Captured rather than discarded, for the same reason as piper's: a
        // missing model or an unreadable file reports here, and throwing it
        // away turns a fixable error into "it just doesn't work".
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Couldn't start the listening engine: {e}"))?;

    let _ = fs::remove_file(&input);

    if !finished.status.success() {
        let detail = String::from_utf8_lossy(&finished.stderr);
        let tail: String = detail.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(if tail.is_empty() {
            "The listening engine produced nothing.".to_string()
        } else {
            format!("The listening engine failed: {tail}")
        });
    }

    let heard = String::from_utf8_lossy(&finished.stdout).trim().to_string();
    if is_silence(&heard) {
        return Ok(Transcript {
            text: String::new(),
            empty: true,
        });
    }

    Ok(Transcript {
        text: heard,
        empty: false,
    })
}

// ---- commands ---------------------------------------------------------------

/// Transcribe recorded audio.
///
/// The WAV arrives as the request body rather than as JSON — the same reason
/// synthesis returns a `Response`: a few seconds of audio is ~100 KB, and
/// serialising it as an array of a hundred thousand numbers to cross the same
/// process boundary would cost more than the transcription does.
///
/// The vocabulary hint rides in a header because the body is already spoken
/// for. It is percent-encoded on the way in: header values are bytes, app
/// names are not necessarily ASCII, and a name with an accent in it should not
/// take the whole request down.
#[tauri::command]
pub async fn transcribe_speech(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Transcript, String> {
    let audio: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // A JSON body means the raw transport was unavailable and the bytes
        // arrived as an array of numbers. Accepted rather than rejected: the
        // request is well-formed, just expensive.
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|_| "The audio didn't arrive as bytes.".to_string())?,
    };

    let hints = request
        .headers()
        .get("Atlas-Hints")
        .and_then(|value| value.to_str().ok())
        .map(|raw| {
            percent_encoding::percent_decode_str(raw)
                .decode_utf8_lossy()
                .into_owned()
        });

    // Transcription is CPU work measured in tenths of a second. Off the async
    // runtime's threads regardless, so a long utterance can never stall the
    // window's event loop.
    tauri::async_runtime::spawn_blocking(move || transcribe(&app, &audio, hints))
        .await
        .map_err(|e| format!("The listening task failed: {e}"))?
}
