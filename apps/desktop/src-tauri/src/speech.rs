//! Speech — Atlas saying things out loud, locally.
//!
//! ## Why a bundled engine rather than the OS voices
//!
//! Windows already has SAPI, and the WebView already has `speechSynthesis`.
//! Both were rejected: this machine ships only David, Mark and Zira, all
//! American, and a British voice needs a language pack the user has to install
//! by hand. An assistant that sounds right only after a system settings detour
//! is an assistant that sounds wrong.
//!
//! Piper synthesises on the CPU from a bundled neural model. No key, no
//! account, no network at speech time — the same standard every other
//! capability here is held to. Measured on this machine: a real-time factor of
//! about 0.055, so a sentence is ready in a fraction of the time it takes to
//! say it.
//!
//! ## This module synthesises. It does not play.
//!
//! It used to do both, via `PlaySoundW`. That was wrong twice over.
//!
//! It did not work: `PlaySoundW` was called from a `spawn_blocking` thread
//! that returned immediately afterwards, and asynchronous winmm playback does
//! not reliably outlive the thread that started it. The call returned `TRUE`
//! and the room stayed silent — the worst kind of failure, because it looks
//! like success from Rust.
//!
//! And it was the wrong seam: audio played by the OS is audio the WebView
//! cannot see. An audio-reactive visualiser needs an `AnalyserNode` over the
//! samples actually being heard, so the audio has to reach the page. Handing
//! back bytes gives the surface the analyser, real volume control, and a
//! genuine "finished" event — none of which `PlaySoundW` could offer.
//!
//! So: Rust owns synthesis, which is the part that needs the machine. The
//! renderer owns playback, which is the part that needs the speakers.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// A selectable voice. Mirrors `SpeechVoice` in `@atlas/core`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeechVoice {
    pub id: String,
    pub label: String,
    pub group: String,
    pub region: String,
}

/// The curated voices, and the only place a speaker number appears.
///
/// The model carries 109 speakers. Almost all of them are variations on a few
/// accents, and a picker listing all 109 would be a worse experience than one
/// listing eight that are audibly different from each other — which is why the
/// five male options here are five *regions*, not five shades of the same
/// received pronunciation.
///
/// The numbers are indices into the model's own speaker map, taken from
/// `en_GB-vctk-medium.onnx.json`. The `pNNN` in each comment is the VCTK
/// speaker id, kept so the metadata behind a label can be traced.
const VOICES: &[(&str, &str, &str, &str, i64)] = &[
    // id, label, group, region, speaker index
    ("male-surrey", "British male — Surrey", "male", "Surrey", 76), // p254
    ("male-london", "British male — London", "male", "London", 81), // p243
    ("male-birmingham", "British male — Birmingham", "male", "Birmingham", 104), // p256
    ("male-yorkshire", "British male — Yorkshire", "male", "Yorkshire", 12), // p270
    ("male-newcastle", "British male — Newcastle", "male", "Newcastle", 9), // p286
    ("female-southern", "British female — Southern England", "female", "Southern England", 107), // p225
    ("female-manchester", "British female — Manchester", "female", "Manchester", 1), // p236
    ("female-oxford", "British female — Oxford", "female", "Oxford", 11), // p276
];

const DEFAULT_VOICE: &str = "male-surrey";

fn speaker_for(voice_id: &str) -> i64 {
    VOICES
        .iter()
        .find(|(id, ..)| *id == voice_id)
        .or_else(|| VOICES.iter().find(|(id, ..)| *id == DEFAULT_VOICE))
        .map(|(.., speaker)| *speaker)
        .unwrap_or(0)
}

/// Where the engine and model live.
///
/// Bundled as Tauri resources in a shipped build, and read straight out of
/// `vendor/` during development so a rebuild is not needed to try a new voice.
/// Both are checked because both are real: the dev path does not exist on a
/// user's machine, and the resource path does not exist in a `cargo run`.
fn engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("vendor").join("piper"));

    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vendor")
        .join("piper");

    for candidate in [bundled, Some(dev)].into_iter().flatten() {
        if candidate.join("piper").join("piper.exe").exists() {
            return Some(candidate);
        }
    }
    None
}

pub fn available(app: &tauri::AppHandle) -> bool {
    engine_dir(app).is_some()
}

pub fn voices() -> Vec<SpeechVoice> {
    VOICES
        .iter()
        .map(|(id, label, group, region, _)| SpeechVoice {
            id: (*id).to_string(),
            label: (*label).to_string(),
            group: (*group).to_string(),
            region: (*region).to_string(),
        })
        .collect()
}

/// Synthesise `text` and return the WAV bytes.
///
/// Nothing is played here — see the note at the top of the file. The caller
/// gets audio it can analyse, scale and stop.
pub fn synthesize(
    app: &tauri::AppHandle,
    text: &str,
    voice_id: Option<String>,
    pace: Option<f32>,
) -> Result<Vec<u8>, String> {
    let spoken = text.trim();
    if spoken.is_empty() {
        return Ok(Vec::new());
    }
    // A cap, not a truncation of meaning: this reads out replies, and anything
    // past a few paragraphs is a wall of speech nobody wants to sit through.
    let spoken: String = spoken.chars().take(2000).collect();

    let dir = engine_dir(app).ok_or("The speech engine isn't installed.")?;
    let exe = dir.join("piper").join("piper.exe");
    let model = dir.join("en_GB-vctk-medium.onnx");
    if !model.exists() {
        return Err("The voice model is missing.".into());
    }

    let speaker = speaker_for(voice_id.as_deref().unwrap_or(DEFAULT_VOICE));
    // Clamped rather than validated: an out-of-range pace should be brisk or
    // slow, never silence or a crash.
    let length_scale = pace.unwrap_or(1.06).clamp(0.6, 2.0);

    let out = std::env::temp_dir().join("atlas-speech.wav");
    let _ = fs::remove_file(&out);

    let mut command = Command::new(&exe);
    // Without this, every single utterance flashes a console window on screen.
    // Piper is a console program; nothing about it should be visible.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        // piper resolves espeak-ng-data relative to its own directory, so it
        // has to run from there or every synthesis fails on phonemisation.
        .current_dir(dir.join("piper"))
        .arg("--model")
        .arg(&model)
        .arg("--speaker")
        .arg(speaker.to_string())
        .arg("--length_scale")
        .arg(format!("{length_scale}"))
        .arg("--output_file")
        .arg(&out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        // Captured, not discarded. Piper reports a missing model, a bad
        // speaker index and a phonemisation failure here, and throwing that
        // away is what turns a fixable error into "it just doesn't work".
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start the speech engine: {e}"))?;

    {
        // Taken, not borrowed, so it is *dropped* at the end of this block.
        // Piper reads its input to EOF; a stdin handle left open means it
        // waits forever for a line that is never coming.
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Couldn't send text to the speech engine.")?;
        stdin
            .write_all(spoken.as_bytes())
            .map_err(|e| format!("Couldn't send text to the speech engine: {e}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("Couldn't send text to the speech engine: {e}"))?;
    }

    let finished = child
        .wait_with_output()
        .map_err(|e| format!("The speech engine didn't finish: {e}"))?;
    if !finished.status.success() || !out.exists() {
        let detail = String::from_utf8_lossy(&finished.stderr);
        // Piper logs progress to stderr even on success, so only the tail is
        // useful and only when something actually went wrong.
        let tail: String = detail.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(if tail.is_empty() {
            "The speech engine produced nothing.".to_string()
        } else {
            format!("The speech engine failed: {tail}")
        });
    }

    let bytes = fs::read(&out).map_err(|e| format!("Couldn't read the audio: {e}"))?;
    // The temp file has done its job the moment it is in memory. Piper writes
    // to a path rather than stdout, so the file is a step on the way, not
    // something to leave lying around with the user's words in it.
    let _ = fs::remove_file(&out);
    Ok(bytes)
}

// ---- commands ---------------------------------------------------------------
//
// Narrow and validated, like everything else the renderer can reach. Note what
// is *not* here: no path, no argument list, no engine selection. The renderer
// picks a voice by id from a fixed table and supplies text. It cannot point
// this at another executable, which is the same line `platform.rs` draws.

/// Every voice this build can actually produce.
///
/// The refined ones are appended only when their model is installed, which
/// keeps the picker honest: an option that cannot make a sound is worse than
/// no option at all, because the person choosing it has no way to tell a
/// missing model from a broken app.
///
/// They are listed first because when they are present they are the better
/// answer, and a picker's order is a recommendation whether or not it is meant
/// as one.
#[tauri::command]
pub fn speech_voices(app: tauri::AppHandle) -> Vec<SpeechVoice> {
    let mut all = Vec::new();
    if crate::kokoro::available(&app) {
        all.extend(crate::kokoro::voices());
    }
    all.extend(voices());
    all
}

/// Synthesise, and hand back the audio itself.
///
/// Returns a `Response`, which reaches JavaScript as an `ArrayBuffer` rather
/// than as JSON. A WAV serialised the ordinary way would become an array of a
/// hundred thousand numbers — megabytes of text to encode and parse for
/// something that is already bytes.
///
/// ## The voice id chooses the engine
///
/// There is no engine setting, and deliberately so. Two engines exposed as a
/// switch would mean a person has to understand what a "speech engine" is
/// before they can pick a voice, and then keep a voice choice and an engine
/// choice consistent by hand — with a broken pairing always reachable. A voice
/// belongs to exactly one engine, so the voice is the whole decision and the
/// wrong combination cannot be expressed.
///
/// A refined id with the model missing falls back to piper rather than
/// failing. That case is real: the preference is saved, and the model is a
/// separate download that can be absent on a fresh machine. Speaking in the
/// wrong voice is a far better answer than not speaking.
#[tauri::command]
pub async fn synthesize_speech(
    app: tauri::AppHandle,
    text: String,
    voice_id: Option<String>,
    pace: Option<f32>,
) -> Result<tauri::ipc::Response, String> {
    // Synthesis is CPU work measured in tenths of a second. Off the async
    // runtime's thread regardless, so a long reply can never stall the
    // window's event loop.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let refined = voice_id
            .as_deref()
            .is_some_and(|id| id.starts_with(REFINED_PREFIX));

        if refined && crate::kokoro::available(&app) {
            crate::kokoro::synthesize(&app, &text, voice_id, pace)
        } else {
            // Piper has no idea what a refined id means, and would silently
            // use its own default speaker for it. Clearing it says the same
            // thing explicitly.
            let fallback = if refined { None } else { voice_id };
            synthesize(&app, &text, fallback, pace)
        }
    })
    .await
    .map_err(|e| format!("The speech task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// How a refined voice id is recognised. The one place the two engines' id
/// spaces meet, and the reason they can never collide.
pub const REFINED_PREFIX: &str = "kokoro-";
