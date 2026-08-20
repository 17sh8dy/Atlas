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
//! ## Why `PlaySoundW` and not an audio crate
//!
//! `rodio` or `cpal` would pull in a device-enumeration stack to do something
//! the `windows` crate — already a dependency for `os.rs` — does in one call.
//! `PlaySoundW` also happens to have exactly the semantics wanted here:
//! asynchronous playback, one sound at a time (a second utterance replaces the
//! first rather than talking over it), and passing null stops playback. That
//! is the entire feature set, for no new dependency.
//!
//! The tradeoff is real and accepted: `PlaySoundW` offers no volume control
//! and no "finished" callback. Volume belongs to the system mixer, and nothing
//! in the UI needs to know when a sentence ended.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

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

/// Stop whatever is being said. Passing null to `PlaySoundW` halts playback.
pub fn stop() -> Result<bool, String> {
    unsafe {
        let _ = PlaySoundW(PCWSTR::null(), None, SND_ASYNC);
    }
    Ok(true)
}

/// Synthesise `text` and play it.
///
/// Returns once playback has *started*. Waiting for the end would block the
/// caller for the length of the sentence, and the transcript is already
/// readable — the speech is an accompaniment to the reply, not the reply.
pub fn speak(
    app: &tauri::AppHandle,
    text: &str,
    voice_id: Option<String>,
    pace: Option<f32>,
) -> Result<bool, String> {
    let spoken = text.trim();
    if spoken.is_empty() {
        return Ok(false);
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

    let mut child = Command::new(&exe)
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
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start the speech engine: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or("Couldn't send text to the speech engine.")?;
        stdin
            .write_all(spoken.as_bytes())
            .map_err(|e| format!("Couldn't send text to the speech engine: {e}"))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("The speech engine didn't finish: {e}"))?;
    if !status.success() || !out.exists() {
        return Err("The speech engine produced nothing.".into());
    }

    let mut wide: Vec<u16> = out.to_string_lossy().encode_utf16().collect();
    wide.push(0);
    unsafe {
        // SND_NODEFAULT: if the file is somehow unplayable, say nothing rather
        // than firing the Windows default beep at someone.
        PlaySoundW(
            PCWSTR(wide.as_ptr()),
            None,
            SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
        )
        .ok()
        .map_err(|e| format!("Couldn't play the audio: {e}"))?;
    }
    Ok(true)
}

// ---- commands ---------------------------------------------------------------
//
// Narrow and validated, like everything else the renderer can reach. Note what
// is *not* here: no path, no argument list, no engine selection. The renderer
// picks a voice by id from a fixed table and supplies text. It cannot point
// this at another executable, which is the same line `platform.rs` draws.

#[tauri::command]
pub fn speech_voices() -> Vec<SpeechVoice> {
    voices()
}

#[tauri::command]
pub async fn speak_text(
    app: tauri::AppHandle,
    text: String,
    voice_id: Option<String>,
    pace: Option<f32>,
) -> Result<bool, String> {
    // Synthesis is CPU work measured in tenths of a second. Off the async
    // runtime's thread regardless, so a long reply can never stall the
    // window's event loop.
    tauri::async_runtime::spawn_blocking(move || speak(&app, &text, voice_id, pace))
        .await
        .map_err(|e| format!("The speech task failed: {e}"))?
}

#[tauri::command]
pub fn stop_speaking() -> Result<bool, String> {
    stop()
}
