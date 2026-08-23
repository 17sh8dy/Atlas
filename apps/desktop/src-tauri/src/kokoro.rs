//! Kokoro — the refined voice, run inside this process.
//!
//! ## Why a second engine rather than a better piper voice
//!
//! Piper is fast and it is not going anywhere: it is the voice that works the
//! moment the app is installed, and `speech.rs` still owns that path. What it
//! cannot do is sound like the thing this assistant is supposed to be. The
//! VCTK model is a corpus of 109 people reading sentences, and a corpus reader
//! sounds like a corpus reader — accurate, flat, and unmistakably a machine
//! reading aloud.
//!
//! Kokoro is an 82M-parameter model under **Apache 2.0** — a better licence
//! than the archived-MIT position piper is pinned to, and far better than
//! piper's own GPL successor. Its British voices carry intonation across a
//! sentence rather than word by word, which is the whole difference between
//! "the computer is speaking" and "someone is speaking".
//!
//! ## The architecture is the opposite of piper's, on purpose
//!
//! `speech.rs` spawns `piper.exe` per utterance. That is fine when an
//! utterance is a whole reply, and it is wrong now that a reply is synthesised
//! a sentence at a time: four sentences would mean four process launches and
//! four model loads, and the model load is most of the cost. So this engine is
//! **resident**. The session is built once, on first use, and every sentence
//! after that is inference only.
//!
//! That is what makes sentence-at-a-time synthesis pay off rather than cost:
//! the first sentence pays for the load, and every one after it is quick
//! enough to stay ahead of the speaker.
//!
//! ## What it costs, measured
//!
//! On the machine this was written on (Zen 3, 16 cores), with the fp16 export
//! and eight threads:
//!
//!   * a short sentence — 200–290 ms
//!   * a normal one — 470–680 ms for 3.2 s of speech
//!   * a long one — 1.6–2.1 s for 9.1 s of speech
//!
//! So a real-time factor around **0.15–0.23**, depending on what else the
//! machine is doing: four to six times faster than the speech it produces.
//! That margin is the whole budget for the pipeline in
//! `useSpeech` — the next sentence has to be finished before the current one
//! stops playing, and at this factor it always is.
//!
//! ⚠️ Piper is still far quicker (RTF ~0.067), and it always will be — it is a
//! much smaller network. What this buys for the extra time is the difference
//! between a voice that reads words and one that reads sentences. The first
//! sentence of a reply is the only part anyone waits for, and 200 ms is under
//! the threshold where waiting is noticed.
//!
//! ⚠️ **The obvious build is the slow one here.** See the note beside the
//! download in `fetch-speech.mjs`: the int8 export is five times slower than
//! fp16 on this CPU, because int8 inference needs VNNI and Zen 3 has none.
//!
//! ## What actually runs here
//!
//! Two libraries are loaded at runtime and neither is linked:
//!
//!   * **onnxruntime**, shipped in `vendor/kokoro/` and reached through ort's
//!     `load-dynamic`. Pointed at by absolute path, so there is no search-path
//!     ambiguity and no chance of binding to some other copy on the machine.
//!   * **espeak-ng**, borrowed from piper's vendor directory, which already
//!     ships the DLL *and* its data. Loading it here rather than shelling out
//!     keeps the "no variable command string" rule intact — nothing in this
//!     file executes a program at all.
//!
//! ⚠️ That second point is a real coupling: Kokoro cannot work if piper's
//! vendor directory is removed, because that is where `espeak-ng-data` lives.
//! `available()` checks for both, so the capability simply reports false
//! rather than failing at synthesis time.
//!
//! ## Text becomes sound in four steps
//!
//! 1. **Punctuation is split off** and set aside. espeak discards it, and
//!    Kokoro needs it: its vocabulary has tokens for `.` `,` `?` and the rest,
//!    and they are what give a sentence its shape. Phonemising the whole
//!    string and hoping is how you get an assistant that reads a list as one
//!    breathless run-on.
//! 2. **espeak turns each fragment into IPA**, in `en-gb`.
//! 3. **IPA becomes token ids** through the model's own 114-entry vocabulary.
//!    Anything not in it is dropped, which is exactly what the reference
//!    implementation does — a phoneme the model never saw is noise, not a
//!    sound.
//! 4. **The model runs**, and its 24 kHz float samples are written into a WAV
//!    the renderer can decode.
//!
//! The voice itself is a 256-float style vector chosen by *how many phonemes
//! are being said* — the model was trained with one vector per length, and
//! using the wrong row makes a voice that is recognisably the right person
//! with the wrong pacing.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

use crate::speech::SpeechVoice;

/// Sample rate the model produces. Not configurable; it is a property of the
/// trained network, not a setting.
const SAMPLE_RATE: u32 = 24_000;

/// Width of a style vector.
const STYLE_DIM: usize = 256;

/// Longest run of phonemes the model will accept.
///
/// Also the number of rows in a voice file, and that is not a coincidence:
/// there is one style vector per possible length.
const MAX_PHONEMES: usize = 510;

/// The curated voices.
///
/// Four British men, and the point of offering four is that they are
/// *different people*, not four settings of one. The brief this was built to
/// was an assistant that is calm, articulate, lightly formal and warm — George
/// is the closest single answer to that, so it is the default; the others are
/// there because "warm" is a matter of taste and the alternatives are genuinely
/// distinct rather than shades of the same reading.
///
/// The `region` column carries a character note rather than a place. Kokoro's
/// speakers are not drawn from a regional corpus the way VCTK's are, so a
/// county name would be an invention; what a person choosing a voice actually
/// wants to know is how it sounds.
const VOICES: &[(&str, &str, &str, &str, &str)] = &[
    // id, label, group, note, kokoro voice file
    (
        "kokoro-george",
        "Refined British male — Measured",
        "refined",
        "Measured — warm, unhurried, faintly amused",
        "bm_george",
    ),
    (
        "kokoro-fable",
        "Refined British male — Cinematic",
        "refined",
        "Cinematic — a storyteller's cadence, more colour",
        "bm_fable",
    ),
    (
        "kokoro-daniel",
        "Refined British male — Crisp",
        "refined",
        "Crisp — precise, and a little more formal",
        "bm_daniel",
    ),
    (
        "kokoro-lewis",
        "Refined British male — Low",
        "refined",
        "Low — deeper and slower, with more weight",
        "bm_lewis",
    ),
];

const DEFAULT_VOICE: &str = "kokoro-george";

fn voice_file(voice_id: &str) -> &'static str {
    VOICES
        .iter()
        .find(|(id, ..)| *id == voice_id)
        .or_else(|| VOICES.iter().find(|(id, ..)| *id == DEFAULT_VOICE))
        .map(|(.., file)| *file)
        .unwrap_or("bm_george")
}

pub fn voices() -> Vec<SpeechVoice> {
    VOICES
        .iter()
        .map(|(id, label, group, note, _)| SpeechVoice {
            id: (*id).to_string(),
            label: (*label).to_string(),
            group: (*group).to_string(),
            region: (*note).to_string(),
        })
        .collect()
}

// ---- where the files live ---------------------------------------------------

/// Kokoro's own directory: the model, the voices, and the ONNX runtime.
///
/// Bundled as a Tauri resource in a shipped build and read out of `vendor/`
/// during development, exactly like `speech.rs` — both paths are checked
/// because both are real.
fn engine_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("vendor").join("kokoro"));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vendor")
        .join("kokoro");

    for candidate in [bundled, Some(dev)].into_iter().flatten() {
        if candidate.join("kokoro.onnx").exists() {
            return Some(candidate);
        }
    }
    None
}

/// Where espeak-ng and its data live — piper's directory. See the ⚠️ note at
/// the top of this file for why this is borrowed rather than duplicated.
fn espeak_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;

    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("vendor").join("piper").join("piper"));
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("vendor")
        .join("piper")
        .join("piper");

    for candidate in [bundled, Some(dev)].into_iter().flatten() {
        // `phontab` specifically, not just the directory. It is the first file
        // espeak opens, and a data directory that exists but is missing it is a
        // failure espeak handles by *terminating the process* — see the note on
        // `ESPEAK_DONT_EXIT`. Checking here is what keeps that unreachable.
        if candidate.join("espeak-ng.dll").exists()
            && candidate.join("espeak-ng-data").join("phontab").exists()
        {
            return Some(candidate);
        }
    }
    None
}

/// Strip Windows' verbatim-path prefix.
///
/// ⚠️ This is not cosmetic. `resource_dir()` hands back a `\\?\C:\…` path, and
/// that prefix means "pass this to the filesystem untouched, do not normalise
/// it" — which specifically includes *not* converting forward slashes to
/// backslashes. espeak builds its data path by appending `"/espeak-ng-data"`
/// with a forward slash, so a verbatim prefix turns a correct path into one
/// Windows will never resolve, and every file it then opens fails.
///
/// This cost an app crash to find: the path check passed, espeak was handed the
/// prefixed path, it could not read its phoneme table, and it called `exit()`
/// on the spot — so the whole window vanished on the click that opened the
/// voice screen.
fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    // `\\?\UNC\server\share` is a network path whose real form is `\\server\share`.
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

/// True when every piece this engine needs is present.
///
/// Checked rather than assumed because the model is a 90 MB download that a
/// developer clone will not have until `pnpm speech` has been run, and a
/// capability that lies about being there produces a mystery at synthesis
/// time instead of a clear absence in Settings.
pub fn available(app: &tauri::AppHandle) -> bool {
    let Some(dir) = engine_dir(app) else {
        return false;
    };
    if espeak_dir(app).is_none() {
        return false;
    }
    if !dir.join("onnxruntime.dll").exists() {
        return false;
    }
    VOICES
        .iter()
        .any(|(.., file)| dir.join("voices").join(format!("{file}.bin")).exists())
}

// ---- espeak ----------------------------------------------------------------

/// The three espeak entry points this needs, resolved from the DLL at runtime.
///
/// espeak is a C library with global state and no thread safety of any kind,
/// which is why the whole engine sits behind one mutex rather than this struct
/// carrying its own.
struct Espeak {
    // Held so the library stays mapped for as long as the symbols do. Dropping
    // this unloads the DLL and turns every function pointer below into a
    // dangling one.
    _library: libloading::Library,
    text_to_phonemes:
        unsafe extern "C" fn(*mut *const c_void, c_int, c_int) -> *const c_char,
}

/// espeak's `espeakCHARS_UTF8`.
const ESPEAK_CHARS_UTF8: c_int = 1;
/// Phoneme output mode: bit 1 set means IPA, and no other bits are wanted.
const ESPEAK_PHONEMES_IPA: c_int = 2;
/// `AUDIO_OUTPUT_SYNCHRONOUS`. Nothing here plays audio — this is the mode
/// piper's own phonemiser initialises with, and it avoids opening a device.
const ESPEAK_AUDIO_SYNCHRONOUS: c_int = 2;
/// `espeakINITIALIZE_DONT_EXIT`.
///
/// ⚠️ Without this flag espeak-ng responds to an unreadable data directory by
/// calling `exit()`, and it takes the entire application with it — no panic, no
/// unwind, no error to report, the window simply disappears. That happened
/// here, on the click that opens the voice screen, and it is the reason this
/// constant exists.
///
/// The path bug that triggered it is fixed (see `plain_path`), but this stays:
/// a library that can terminate the process must never be given the chance,
/// because the next cause will be something nobody predicted either.
const ESPEAK_DONT_EXIT: c_int = 0x8000;

impl Espeak {
    /// Load the library and put it in `en-gb`.
    ///
    /// # Safety
    ///
    /// The signatures declared here must match espeak-ng's. They are taken
    /// from `speak_lib.h` and are stable across every release that has ever
    /// shipped this DLL.
    unsafe fn load(dir: &Path) -> Result<Self, String> {
        let library = libloading::Library::new(dir.join("espeak-ng.dll"))
            .map_err(|e| format!("Couldn't load the phonemiser: {e}"))?;

        let initialize: libloading::Symbol<
            unsafe extern "C" fn(c_int, c_int, *const c_char, c_int) -> c_int,
        > = library
            .get(b"espeak_Initialize\0")
            .map_err(|e| format!("The phonemiser is missing espeak_Initialize: {e}"))?;
        let set_voice: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> c_int> = library
            .get(b"espeak_SetVoiceByName\0")
            .map_err(|e| format!("The phonemiser is missing espeak_SetVoiceByName: {e}"))?;
        let text_to_phonemes: libloading::Symbol<
            unsafe extern "C" fn(*mut *const c_void, c_int, c_int) -> *const c_char,
        > = library
            .get(b"espeak_TextToPhonemes\0")
            .map_err(|e| format!("The phonemiser is missing espeak_TextToPhonemes: {e}"))?;

        // espeak wants the directory *containing* `espeak-ng-data`, not the
        // data directory itself — and it wants it without a verbatim prefix.
        let path = CString::new(plain_path(dir))
            .map_err(|_| "The phonemiser path isn't representable.".to_string())?;
        // Returns the sample rate it would synthesise at, or -1. We never ask
        // it for audio, but a failure here means the data files are unreadable
        // and every later call would return nothing.
        if initialize(
            ESPEAK_AUDIO_SYNCHRONOUS,
            0,
            path.as_ptr(),
            ESPEAK_DONT_EXIT,
        ) < 0
        {
            return Err(format!(
                "The phonemiser couldn't read its data files in {}.",
                plain_path(dir)
            ));
        }

        // ⚠️ Not just "en-gb". `espeak_SetVoiceByName` matches the voice
        // *file*, and which files exist has changed across espeak-ng releases:
        // the build vendored with piper has no `en-gb` at all. Its `en` is the
        // one titled "English (Great Britain)" and declaring `language en-gb`,
        // so it is the same voice under the name this data version uses.
        //
        // Order matters. `en-gb` first for builds that have it, `en` last as
        // the one that has always existed. Deliberately *not* including
        // `en-gb-x-rp`, tempting as Received Pronunciation sounds for this
        // brief: Kokoro was trained on the plain en-gb phoneme set, and
        // feeding it a different one trades a known voice for a guess.
        const CANDIDATES: [&str; 3] = ["en-gb", "en-GB", "en"];
        let mut chosen = None;
        for name in CANDIDATES {
            let candidate = CString::new(name).expect("literal has no interior nul");
            if set_voice(candidate.as_ptr()) == 0 {
                chosen = Some(name);
                break;
            }
        }
        if chosen.is_none() {
            return Err(format!(
                "The phonemiser has no British English voice; tried {}.",
                CANDIDATES.join(", ")
            ));
        }

        // The symbol borrows the library, so it has to be copied out as a
        // plain function pointer before the library is moved into the struct.
        let text_to_phonemes = *text_to_phonemes;
        Ok(Self {
            _library: library,
            text_to_phonemes,
        })
    }

    /// IPA for one run of text with no punctuation in it.
    fn phonemize_fragment(&self, text: &str) -> String {
        let Ok(source) = CString::new(text) else {
            return String::new();
        };
        let mut cursor = source.as_ptr() as *const c_void;
        let mut out = String::new();

        // espeak returns one clause per call and advances the cursor, setting
        // it to null when the text is exhausted. A fragment usually is one
        // clause, but a long one is not, so this has to loop.
        //
        // Bounded, because a cursor that somehow fails to advance would
        // otherwise spin forever inside a lock held by the whole app. There is
        // no legitimate input that produces hundreds of clauses from a
        // fragment this size.
        for _ in 0..256 {
            if cursor.is_null() {
                break;
            }
            // SAFETY: `cursor` points into `source`, which outlives this loop.
            // The returned pointer is espeak's own static buffer, valid until
            // the next call, and it is copied into `out` before that happens.
            let produced = unsafe {
                (self.text_to_phonemes)(&mut cursor, ESPEAK_CHARS_UTF8, ESPEAK_PHONEMES_IPA)
            };
            if produced.is_null() {
                break;
            }
            let Ok(text) = (unsafe { CStr::from_ptr(produced) }).to_str() else {
                break;
            };
            out.push_str(text);
        }
        out
    }
}

/// The characters Kokoro has tokens for and espeak throws away.
///
/// Kept in the phoneme string because they are what the model uses to place
/// pauses and to shape a question. Without them every reply is read as one
/// flat run, which is the single most machine-like thing a voice can do.
fn punctuation_token(ch: char) -> Option<char> {
    match ch {
        ';' | ':' | ',' | '.' | '!' | '?' | '…' | '"' | '(' | ')' => Some(ch),
        // Normalised to the forms the vocabulary actually contains.
        '—' | '–' | '-' => Some('—'),
        '“' | '”' => Some('"'),
        '‘' | '’' => Some('\''),
        _ => None,
    }
}

/// The model's vocabulary: IPA character to token id.
///
/// Transcribed from `config.json` in the Kokoro repository. It is written out
/// rather than read from a file because it is part of *this* build's contract
/// with *that* model file — a vocabulary that silently differed from the
/// weights would produce fluent nonsense, which is far harder to notice than a
/// crash.
fn vocabulary() -> &'static HashMap<char, i64> {
    static VOCAB: OnceLock<HashMap<char, i64>> = OnceLock::new();
    VOCAB.get_or_init(|| {
        const ENTRIES: &[(char, i64)] = &[
            (';', 1),
            (':', 2),
            (',', 3),
            ('.', 4),
            ('!', 5),
            ('?', 6),
            ('—', 9),
            ('…', 10),
            ('"', 11),
            ('(', 12),
            (')', 13),
            ('“', 14),
            ('”', 15),
            (' ', 16),
            ('\u{0303}', 17),
            ('ʣ', 18),
            ('ʥ', 19),
            ('ʦ', 20),
            ('ʨ', 21),
            ('ᵝ', 22),
            ('\u{ab67}', 23),
            ('A', 24),
            ('I', 25),
            ('O', 31),
            ('Q', 33),
            ('S', 35),
            ('T', 36),
            ('W', 39),
            ('Y', 41),
            ('ᵊ', 42),
            ('a', 43),
            ('b', 44),
            ('c', 45),
            ('d', 46),
            ('e', 47),
            ('f', 48),
            ('h', 50),
            ('i', 51),
            ('j', 52),
            ('k', 53),
            ('l', 54),
            ('m', 55),
            ('n', 56),
            ('o', 57),
            ('p', 58),
            ('q', 59),
            ('r', 60),
            ('s', 61),
            ('t', 62),
            ('u', 63),
            ('v', 64),
            ('w', 65),
            ('x', 66),
            ('y', 67),
            ('z', 68),
            ('ɑ', 69),
            ('ɐ', 70),
            ('ɒ', 71),
            ('æ', 72),
            ('β', 75),
            ('ɔ', 76),
            ('ɕ', 77),
            ('ç', 78),
            ('ɖ', 80),
            ('ð', 81),
            ('ʤ', 82),
            ('ə', 83),
            ('ɚ', 85),
            ('ɛ', 86),
            ('ɜ', 87),
            ('ɟ', 90),
            ('ɡ', 92),
            ('ɥ', 99),
            ('ɨ', 101),
            ('ɪ', 102),
            ('ʝ', 103),
            ('ɯ', 110),
            ('ɰ', 111),
            ('ŋ', 112),
            ('ɳ', 113),
            ('ɲ', 114),
            ('ɴ', 115),
            ('ø', 116),
            ('ɸ', 118),
            ('θ', 119),
            ('œ', 120),
            ('ɹ', 123),
            ('ɾ', 125),
            ('ɻ', 126),
            ('ʁ', 128),
            ('ɽ', 129),
            ('ʂ', 130),
            ('ʃ', 131),
            ('ʈ', 132),
            ('ʧ', 133),
            ('ʊ', 135),
            ('ʋ', 136),
            ('ʌ', 138),
            ('ɣ', 139),
            ('ɤ', 140),
            ('χ', 142),
            ('ʎ', 143),
            ('ʒ', 147),
            ('ʔ', 148),
            ('ˈ', 156),
            ('ˌ', 157),
            ('ː', 158),
            ('ʰ', 162),
            ('ʲ', 164),
            ('↓', 169),
            ('→', 171),
            ('↗', 172),
            ('↘', 173),
            ('ᵻ', 177),
        ];
        ENTRIES.iter().copied().collect()
    })
}

// ---- the engine -------------------------------------------------------------

struct Engine {
    session: Session,
    espeak: Espeak,
    dir: PathBuf,
    /// Style tables, keyed by Kokoro voice name. Loaded on first use of each.
    styles: HashMap<String, Vec<f32>>,
    /// The export names this input differently across versions.
    tokens_input: String,
    /// Some exports type `speed` as int32, which cannot carry a fraction.
    speed_is_int: bool,
}

/// The one engine, built on first use and kept.
///
/// A `Mutex` rather than anything cleverer because espeak has process-global
/// state and `Session::run` takes `&mut self`. Synthesis is short and the
/// caller is already on a blocking thread, so contention costs a queue rather
/// than a stall.
static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();

fn engine_lock() -> &'static Mutex<Option<Engine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// How many threads inference may use.
///
/// Measured on the machine this was built on (Zen 3, 16 cores / 32 threads),
/// synthesising a three-second sentence:
///
///   1 thread    RTF 0.96      4 threads   RTF 0.81
///   2 threads   RTF 0.96      8 threads   RTF 0.76      16 threads   RTF 0.75
///
/// The curve is flat past eight, so taking more is spending cores on nothing.
/// Half the machine, capped at eight, keeps the window responsive while
/// synthesis runs — and it has to, because synthesis happens *while Atlas is
/// speaking the previous sentence*, which is exactly when a stutter would be
/// heard.
///
/// Halved rather than taken whole for the small machines: on four cores,
/// handing every one of them to the model is how the interface freezes.
fn inference_threads() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    (cores / 2).clamp(2, 8)
}

/// Resolve both directories from the app, then load.
///
/// Split from `Engine::load` so the engine can be built from explicit paths in
/// a test. The alternative — a `tauri::AppHandle` — cannot be constructed
/// outside a running app, which would have left the only part of this file
/// that talks to a neural network as the only part with no test at all.
fn load_engine(app: &tauri::AppHandle) -> Result<Engine, String> {
    let dir = engine_dir(app).ok_or("The refined voice isn't installed.")?;
    let speak_dir = espeak_dir(app).ok_or("The phonemiser isn't installed.")?;
    Engine::load(dir, speak_dir)
}

impl Engine {
    fn load(dir: PathBuf, speak_dir: PathBuf) -> Result<Self, String> {
        // ort's load-dynamic reads this at first use. Set to an absolute path
        // so there is no search-order ambiguity with any other copy of the
        // runtime that happens to be on this machine.
        let runtime = dir.join("onnxruntime.dll");
        if !runtime.exists() {
            return Err("The inference runtime is missing.".into());
        }
        std::env::set_var("ORT_DYLIB_PATH", &runtime);

        // SAFETY: the signatures are espeak-ng's published ones; see `load`.
        let espeak = unsafe { Espeak::load(&speak_dir)? };

        // ⚠️ No `with_optimization_level` here. This ort release candidate
        // sends it as a session *config entry*, which onnxruntime 1.22 rejects
        // outright with "graph_optimization_level is not valid" — the session
        // then fails to build at all. Nothing is lost by leaving it out: the
        // runtime's own default is already the full optimisation level this
        // was asking for.
        let session = Session::builder()
            .map_err(|e| format!("Couldn't prepare the voice: {e}"))?
            .with_intra_threads(inference_threads())
            .map_err(|e| format!("Couldn't prepare the voice: {e}"))?
            .commit_from_file(dir.join("kokoro.onnx"))
            .map_err(|e| format!("Couldn't load the voice model: {e}"))?;

        // Read the graph's own signature rather than assuming it. The exports
        // in circulation disagree about both of these, and guessing wrong
        // produces a runtime type error rather than anything diagnosable.
        let mut tokens_input = "input_ids".to_string();
        let mut speed_is_int = false;
        for input in session.inputs() {
            match input.name() {
                "input_ids" | "tokens" => tokens_input = input.name().to_string(),
                "speed" => {
                    speed_is_int = format!("{:?}", input.dtype()).to_lowercase().contains("int32")
                }
                _ => {}
            }
        }

        Ok(Self {
            session,
            espeak,
            dir,
            styles: HashMap::new(),
            tokens_input,
            speed_is_int,
        })
    }

    /// The style table for a voice, loaded once and kept.
    ///
    /// The file is a flat array of `MAX_PHONEMES` rows of `STYLE_DIM` floats,
    /// little-endian, with no header at all — so the length is the only check
    /// available that the right file is being read, and it is worth making.
    fn styles_for(&mut self, voice: &str) -> Result<&[f32], String> {
        if !self.styles.contains_key(voice) {
            let path = self.dir.join("voices").join(format!("{voice}.bin"));
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("Couldn't read the voice \"{voice}\": {e}"))?;

            let expected = MAX_PHONEMES * STYLE_DIM * 4;
            if bytes.len() != expected {
                return Err(format!(
                    "The voice \"{voice}\" is {} bytes; expected {expected}.",
                    bytes.len()
                ));
            }

            let floats = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect::<Vec<f32>>();
            self.styles.insert(voice.to_string(), floats);
        }
        Ok(self.styles.get(voice).expect("just inserted"))
    }

    /// Text to IPA, with the punctuation put back.
    ///
    /// The text is cut at every character the model has a token for; the
    /// fragments between are phonemised and the characters themselves are
    /// re-inserted in place. espeak would otherwise swallow all of them, and
    /// they are most of what makes a sentence sound like a sentence.
    fn phonemize(&self, text: &str) -> String {
        let mut out = String::new();
        let mut fragment = String::new();

        for ch in text.chars() {
            if let Some(token) = punctuation_token(ch) {
                if !fragment.trim().is_empty() {
                    out.push_str(&self.espeak.phonemize_fragment(fragment.trim()));
                }
                fragment.clear();
                out.push(token);
                // A space after a mark, so the model reads it as a break
                // between two things rather than as part of the next word.
                out.push(' ');
            } else {
                fragment.push(ch);
            }
        }
        if !fragment.trim().is_empty() {
            out.push_str(&self.espeak.phonemize_fragment(fragment.trim()));
        }
        out
    }

    /// One run of phonemes to samples.
    fn synthesize_tokens(&mut self, tokens: &[i64], style: &[f32], speed: f32) -> Result<Vec<f32>, String> {
        // The model expects the sequence wrapped in a leading and trailing 0.
        let mut padded = Vec::with_capacity(tokens.len() + 2);
        padded.push(0);
        padded.extend_from_slice(tokens);
        padded.push(0);

        let length = padded.len();
        let ids = Tensor::from_array(([1_usize, length], padded))
            .map_err(|e| format!("Couldn't shape the phonemes: {e}"))?;
        let style_row = Tensor::from_array(([1_usize, STYLE_DIM], style.to_vec()))
            .map_err(|e| format!("Couldn't shape the voice: {e}"))?;

        // The `speed` input is typed differently across exports, and the type
        // has to match exactly — ONNX Runtime will not coerce an f32 into an
        // int32 slot, it will refuse the whole call.
        let outputs = if self.speed_is_int {
            let pace = Tensor::from_array(([1_usize], vec![speed.round() as i32]))
                .map_err(|e| format!("Couldn't shape the pace: {e}"))?;
            self.session.run(ort::inputs![
                self.tokens_input.as_str() => ids,
                "style" => style_row,
                "speed" => pace,
            ])
        } else {
            let pace = Tensor::from_array(([1_usize], vec![speed]))
                .map_err(|e| format!("Couldn't shape the pace: {e}"))?;
            self.session.run(ort::inputs![
                self.tokens_input.as_str() => ids,
                "style" => style_row,
                "speed" => pace,
            ])
        }
        .map_err(|e| format!("The voice failed: {e}"))?;

        // Bound rather than chained: the extracted view borrows from the value
        // inside `outputs`, so the iterator's item has to outlive the copy.
        let (_, first) = outputs.iter().next().ok_or("The voice produced no output.")?;
        let (_, samples) = first
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Couldn't read the audio: {e}"))?;

        Ok(samples.to_vec())
    }
}

/// Synthesise `text` and return WAV bytes.
///
/// Mirrors `speech::synthesize` exactly in shape, so the two engines are
/// interchangeable at the call site and the renderer never learns which one is
/// running.
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
    // The same cap `speech.rs` applies, for the same reason: this reads out
    // replies, and past a few paragraphs it is a wall of speech nobody wants.
    let spoken: String = spoken.chars().take(2000).collect();

    let mut guard = engine_lock()
        .lock()
        .map_err(|_| "The voice is in a bad state; restart Atlas.".to_string())?;

    if guard.is_none() {
        *guard = Some(load_engine(app)?);
    }
    guard
        .as_mut()
        .expect("just loaded")
        .speak(&spoken, voice_id.as_deref(), pace)
}

impl Engine {
    /// Text to WAV bytes, on an engine that is already loaded.
    ///
    /// Everything above this is about *having* an engine; this is the part
    /// that uses one, and it is separate so a test can drive it without an app.
    fn speak(
        &mut self,
        text: &str,
        voice_id: Option<&str>,
        pace: Option<f32>,
    ) -> Result<Vec<u8>, String> {
        let file = voice_file(voice_id.unwrap_or(DEFAULT_VOICE)).to_string();

        // ⚠️ Pace inverts here, exactly as it does in `voice_cloud.rs`. Atlas's
        // `pace` is piper's length scale — higher is *slower*. Kokoro takes a
        // speed multiplier, where higher is faster. Passing it through
        // unchanged would make the "slower" setting speed the voice up.
        let scale = pace.unwrap_or(1.06).clamp(0.6, 2.0);
        let speed = (1.0 / scale).clamp(0.5, 2.0);

        let phonemes = self.phonemize(text);
        let vocab = vocabulary();
        let tokens: Vec<i64> = phonemes.chars().filter_map(|c| vocab.get(&c).copied()).collect();

        if tokens.is_empty() {
            return Err("Nothing in that could be pronounced.".into());
        }

        // Longer than the model's context. The renderer already cuts replies
        // into sentences, so reaching this means one sentence was enormous;
        // truncating is better than refusing, because the alternative is
        // silence.
        let tokens = &tokens[..tokens.len().min(MAX_PHONEMES)];

        // One style vector per phoneme count: row n - 1 for n phonemes.
        let row = tokens.len() - 1;
        let style = {
            let table = self.styles_for(&file)?;
            table[row * STYLE_DIM..(row + 1) * STYLE_DIM].to_vec()
        };

        let samples = self.synthesize_tokens(tokens, &style, speed)?;
        if samples.is_empty() {
            return Err("The voice produced no audio.".into());
        }

        Ok(to_wav(&samples))
    }
}

/// Free the model and the phonemiser.
///
/// Worth having because the session holds ~100 MB resident, and a person who
/// has switched the refined voice off is entitled to get that back without
/// restarting the app.
pub fn unload() {
    if let Ok(mut guard) = engine_lock().lock() {
        *guard = None;
    }
}

/// Float samples to a 16-bit mono WAV.
///
/// Written by hand for the same reason `recorder.ts` writes its own header: a
/// WAV header is 44 bytes of well-documented fields, and a crate to produce
/// them would be a dependency to audit and update forever.
fn to_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM header size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM, uncompressed
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // bytes per frame
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        // Clamped before scaling. A model can and does overshoot ±1 on a loud
        // syllable, and letting that wrap turns a peak into a burst of noise —
        // which is far more audible than the clipping it replaces.
        let clamped = sample.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }
    out
}

// ---- commands ---------------------------------------------------------------

/// What the renderer is told about this engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KokoroStatus {
    /// Every file is present and synthesis can be attempted.
    pub installed: bool,
    /// The model is loaded and the next sentence is inference only.
    pub loaded: bool,
}

#[tauri::command]
pub fn kokoro_status(app: tauri::AppHandle) -> KokoroStatus {
    KokoroStatus {
        installed: available(&app),
        loaded: engine_lock()
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false),
    }
}

#[tauri::command]
pub fn kokoro_voices() -> Vec<SpeechVoice> {
    voices()
}

/// Load the model without saying anything.
///
/// The first sentence through a cold engine pays for reading 90 MB of weights
/// and building the graph, and that cost lands exactly where it is least
/// welcome — in front of the first thing Atlas ever says. Calling this when
/// the voice screen opens moves it somewhere nobody is waiting.
#[tauri::command]
pub async fn kokoro_warm(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !available(&app) {
            return Ok(false);
        }
        let mut guard = engine_lock()
            .lock()
            .map_err(|_| "The voice is in a bad state; restart Atlas.".to_string())?;
        if guard.is_none() {
            *guard = Some(load_engine(&app)?);
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("The warm-up task failed: {e}"))?
}

#[tauri::command]
pub fn kokoro_unload() {
    unload();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_describes_the_samples_it_carries() {
        let wav = to_wav(&[0.0, 0.5, -0.5, 1.0]);

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 44 + 4 * 2);

        // Sizes are the two fields that are wrong most often, and a decoder
        // that reads past the end of a short one produces noise, not an error.
        let riff = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff as usize, wav.len() - 8);
        let data = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data as usize, wav.len() - 44);

        let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        assert_eq!(rate, SAMPLE_RATE);
    }

    #[test]
    fn peaks_clip_rather_than_wrap() {
        // A model overshooting ±1 must come out as a loud sample, never as one
        // of the opposite sign — which is what an unclamped cast would give.
        let wav = to_wav(&[2.0, -2.0]);
        let first = i16::from_le_bytes([wav[44], wav[45]]);
        let second = i16::from_le_bytes([wav[46], wav[47]]);
        assert_eq!(first, 32767);
        assert_eq!(second, -32767);
    }

    #[test]
    fn every_voice_maps_to_a_file_and_the_default_is_one_of_them() {
        for (id, ..) in VOICES {
            assert!(!voice_file(id).is_empty());
        }
        assert!(VOICES.iter().any(|(id, ..)| *id == DEFAULT_VOICE));
        // An unknown id must fall back to the default rather than to silence.
        assert_eq!(voice_file("no-such-voice"), voice_file(DEFAULT_VOICE));
    }

    #[test]
    fn punctuation_the_model_knows_survives_and_the_rest_does_not() {
        let vocab = vocabulary();
        // Every mark kept must have a token, or keeping it is pointless.
        for ch in [';', ':', ',', '.', '!', '?', '…', '"', '(', ')', '—'] {
            let kept = punctuation_token(ch).expect("kept");
            assert!(vocab.contains_key(&kept), "no token for {kept:?}");
        }
        // A letter is not punctuation, and must reach the phonemiser.
        assert_eq!(punctuation_token('a'), None);
        // The dash forms are normalised onto the one the vocabulary has.
        assert_eq!(punctuation_token('–'), Some('—'));
    }

    /// The engine, built straight out of the development vendor directory.
    ///
    /// Returns `None` when the model has not been fetched, so a clone that has
    /// not run `pnpm speech` skips these rather than failing.
    fn dev_engine() -> Option<Engine> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor");
        let kokoro = root.join("kokoro");
        let espeak = root.join("piper").join("piper");
        if !kokoro.join("kokoro.onnx").exists() || !espeak.join("espeak-ng.dll").exists() {
            return None;
        }
        Some(Engine::load(kokoro, espeak).expect("the engine should load"))
    }

    /// ⚠️ Runs the real model. Ignored by default because it loads 90 MB of
    /// weights; run it with `cargo test -- --ignored` after `pnpm speech`.
    ///
    /// This is the only test that proves the chain actually works end to end —
    /// espeak produced IPA, the IPA was in the vocabulary, the graph accepted
    /// the shapes, and audio came back. Every part of that is a place where a
    /// wrong assumption produces silence rather than an error.
    #[test]
    #[ignore = "loads the real model"]
    fn the_real_model_turns_a_sentence_into_audible_speech() {
        let Some(mut engine) = dev_engine() else {
            eprintln!("skipped: run `pnpm --filter @atlas/desktop speech` first");
            return;
        };

        let wav = engine
            .speak("Good evening. Everything is running normally.", None, None)
            .expect("synthesis should succeed");

        assert_eq!(&wav[0..4], b"RIFF");
        let samples = (wav.len() - 44) / 2;
        let seconds = samples as f32 / SAMPLE_RATE as f32;
        // That sentence takes roughly two and a half seconds to say. The bounds
        // are wide because pacing is the model's business, but they catch the
        // two failures that matter: a fraction of a second means the phonemes
        // were dropped, and thirty seconds means the token ids are wrong and it
        // is reading noise.
        assert!(
            (1.0..8.0).contains(&seconds),
            "expected a sentence of speech, got {seconds:.2}s"
        );

        // Not silence. A graph that runs but is fed the wrong style row can
        // return a buffer of zeros, which every check above would pass.
        let peak = wav[44..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
            .max()
            .unwrap_or(0);
        assert!(peak > 2000, "audio is near-silent (peak {peak})");
    }

    /// ⚠️ Runs the real model, and reports rather than asserts.
    ///
    /// The numbers this prints are the whole argument for the design around
    /// it: if the first sentence is not ready well inside the time it takes to
    /// say the sentence before it, the pipelining in `useSpeech` buys nothing
    /// and the engine choice was wrong. Run it with `--nocapture`.
    ///
    /// It asserts only the one thing that would invalidate the architecture —
    /// synthesis being slower than real time — because a hard threshold on a
    /// machine-dependent number is a test that fails for the wrong reasons.
    #[test]
    #[ignore = "loads the real model"]
    fn synthesis_is_comfortably_faster_than_speech() {
        use std::time::Instant;

        let Some(mut engine) = dev_engine() else {
            eprintln!("skipped: run `pnpm --filter @atlas/desktop speech` first");
            return;
        };

        // The first call through a warm engine, so this measures inference and
        // not the model load. The load is measured separately below.
        let _ = engine.speak("Warming up.", None, None).expect("warm-up");

        for line in [
            "Yes.",
            "Everything is running normally.",
            "The disk has forty-one gigabytes free, memory is at thirty-eight per cent, and nothing is pinned at the top of the process list.",
        ] {
            let started = Instant::now();
            let wav = engine.speak(line, None, None).expect("synthesis");
            let took = started.elapsed().as_secs_f32();
            let spoken = ((wav.len() - 44) / 2) as f32 / SAMPLE_RATE as f32;

            eprintln!(
                "  {:>5.0}ms to synthesise {:>5.2}s of speech (RTF {:.3}) — {:?}",
                took * 1000.0,
                spoken,
                took / spoken,
                line.chars().take(40).collect::<String>(),
            );

            assert!(
                took < spoken,
                "synthesis is slower than real time; the pipeline cannot keep up"
            );
        }
    }

    /// ⚠️ Runs the real model. See above.
    #[test]
    #[ignore = "loads the real model"]
    fn each_voice_produces_its_own_audio() {
        let Some(mut engine) = dev_engine() else {
            eprintln!("skipped: run `pnpm --filter @atlas/desktop speech` first");
            return;
        };

        let line = "The disk is nearly full.";
        let george = engine.speak(line, Some("kokoro-george"), None).expect("george");
        let lewis = engine.speak(line, Some("kokoro-lewis"), None).expect("lewis");

        // Four voices that are actually one voice is the failure mode of
        // getting the style vector wrong, and it is invisible from any other
        // check — both would be perfectly good speech.
        assert_ne!(george, lewis, "two voices produced identical audio");
    }

    /// ⚠️ Runs the real model. See above.
    ///
    /// The inversion this checks has been got wrong once already in this
    /// codebase, in the other direction, for the online engine.
    #[test]
    #[ignore = "loads the real model"]
    fn a_higher_pace_number_makes_a_longer_recording() {
        let Some(mut engine) = dev_engine() else {
            eprintln!("skipped: run `pnpm --filter @atlas/desktop speech` first");
            return;
        };

        let line = "Everything is running normally.";
        let brisk = engine.speak(line, None, Some(0.8)).expect("brisk");
        let slow = engine.speak(line, None, Some(1.5)).expect("slow");

        assert!(
            slow.len() > brisk.len(),
            "pace 1.5 should be slower than 0.8, but gave {} bytes against {}",
            slow.len(),
            brisk.len()
        );
    }

    #[test]
    fn the_verbatim_prefix_is_stripped_before_espeak_sees_a_path() {
        // The regression that crashed the whole app. `resource_dir()` returns a
        // `\\?\` path; espeak appends "/espeak-ng-data" to whatever it is given
        // and a verbatim path is never normalised, so the forward slash makes
        // the result unopenable — and espeak's answer to that was `exit()`.
        assert_eq!(
            plain_path(Path::new(r"\\?\D:\Dev\Atlas\vendor\piper\piper")),
            r"D:\Dev\Atlas\vendor\piper\piper"
        );
        // A network share keeps its two leading slashes; dropping them would
        // turn `\\server\share` into a nonexistent local path.
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\server\share\piper")),
            r"\\server\share\piper"
        );
        // An ordinary path is untouched.
        assert_eq!(plain_path(Path::new(r"D:\Dev\Atlas")), r"D:\Dev\Atlas");
    }

    #[test]
    fn the_vocabulary_is_the_size_the_model_was_trained_with() {
        // 114 entries, from the model's own config. A transcription slip here
        // is silent: the wrong id is still a valid id, and the voice would say
        // the wrong sound rather than fail.
        assert_eq!(vocabulary().len(), 114);
    }
}
