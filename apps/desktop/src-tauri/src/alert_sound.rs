//! The sound a reminder, alarm or timer makes.
//!
//! Synthesised here and played through Windows' own `PlaySound`, rather than from
//! the web view: a hidden window with no recent click is exactly where a browser
//! refuses to start audio, and an alarm that stays silent because nobody touched
//! the page is the one failure that matters. Nothing is shipped as a sound file —
//! each tone is a few sine waves with a decay, made on the spot.
//!
//! The sound is Atlas's own notification, so it is not held back by the emergency
//! stop (which stops Atlas *acting*); it only ever plays for up to a few seconds.

#![cfg(windows)]

use windows::core::PCWSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_MEMORY, SND_NODEFAULT, SND_SYNC};

const RATE: u32 = 22_050;

/// One note: a frequency with a few overtones and an exponential decay.
fn note(out: &mut Vec<f32>, start: f32, freq: f32, secs: f32, gain: f32, overtones: &[(f32, f32)]) {
    let first = (start * RATE as f32) as usize;
    let n = (secs * RATE as f32) as usize;
    if out.len() < first + n {
        out.resize(first + n, 0.0);
    }
    for i in 0..n {
        let t = i as f32 / RATE as f32;
        let env = (-t * 5.0 / secs).exp() * (1.0 - (-t * 400.0).exp());
        let mut v = (2.0 * std::f32::consts::PI * freq * t).sin();
        for (mult, amp) in overtones {
            v += amp * (2.0 * std::f32::consts::PI * freq * mult * t).sin();
        }
        out[first + i] += v * env * gain;
    }
}

/// The samples for one named sound, or `None` for a name Atlas does not have.
pub fn samples(kind: &str) -> Option<Vec<f32>> {
    let mut s: Vec<f32> = Vec::new();
    match kind {
        // A rising three-note arpeggio — pleasant, hard to miss.
        "chime" => {
            for (i, f) in [1046.5, 1318.5, 1568.0].iter().enumerate() {
                note(&mut s, i as f32 * 0.18, *f, 0.9, 0.35, &[(2.0, 0.25)]);
            }
        }
        // A struck bell: inharmonic partials ring for a while.
        "bell" => note(&mut s, 0.0, 880.0, 1.6, 0.3, &[(2.4, 0.5), (3.0, 0.3), (5.95, 0.15)]),
        // Two short beeps.
        "beep" => {
            note(&mut s, 0.0, 1000.0, 0.16, 0.5, &[]);
            note(&mut s, 0.26, 1000.0, 0.16, 0.5, &[]);
        }
        // Alternating tones, repeated — for an alarm that has to wake you.
        "alarm" => {
            for rep in 0..4 {
                let t = rep as f32 * 0.9;
                note(&mut s, t, 880.0, 0.22, 0.5, &[(2.0, 0.2)]);
                note(&mut s, t + 0.28, 660.0, 0.22, 0.5, &[(2.0, 0.2)]);
                note(&mut s, t + 0.56, 880.0, 0.22, 0.5, &[(2.0, 0.2)]);
            }
        }
        // One quiet note.
        "soft" => note(&mut s, 0.0, 659.3, 0.9, 0.3, &[(2.0, 0.1)]),
        _ => return None,
    }
    Some(s)
}

/// A complete 16-bit mono WAV file, at `volume` percent (0–100).
pub fn wav(samples: &[f32], volume: u32) -> Vec<u8> {
    let scale = (volume.min(100) as f32 / 100.0) * 0.9;
    let pcm: Vec<i16> = samples
        .iter()
        .map(|v| (v.clamp(-1.0, 1.0) * scale * i16::MAX as f32) as i16)
        .collect();
    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Play mono samples (at `RATE`) through the default speakers with WASAPI shared mode — the same
/// path ordinary apps use, so it works wherever their sound works. Resamples to whatever the
/// device mixes at and writes every channel.
fn play_wasapi(samples: &[f32], volume: u32) -> Result<(), String> {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_SHARED,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

    let _com = crate::audio::ComGuard::new()?;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|_| "Windows has no speakers or headphones selected.".to_string())?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let fmt = client.GetMixFormat().map_err(|e| e.message())?;
        let (rate, channels, bits) = ((*fmt).nSamplesPerSec, (*fmt).nChannels as usize, (*fmt).wBitsPerSample);
        if channels == 0 || (bits != 32 && bits != 16) {
            CoTaskMemFree(Some(fmt as *const _));
            return Err(format!("The output format ({bits}-bit, {channels} channels) isn't one I can write to."));
        }
        // Half a second of buffer, in 100 ns units.
        let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 5_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as *const _));
        init.map_err(|e| e.message())?;
        let buffer_frames = client.GetBufferSize().map_err(|e| e.message())? as usize;
        let render: IAudioRenderClient = client.GetService().map_err(|e| e.message())?;

        // Resample (linear) and scale.
        let gain = (volume.min(100) as f32 / 100.0) * 0.9;
        let total = (samples.len() as f64 * rate as f64 / RATE as f64) as usize;
        let sample_at = |i: usize| -> f32 {
            let pos = i as f64 * RATE as f64 / rate as f64;
            let k = pos as usize;
            let frac = (pos - k as f64) as f32;
            let a = samples.get(k).copied().unwrap_or(0.0);
            let b = samples.get(k + 1).copied().unwrap_or(0.0);
            (a + (b - a) * frac) * gain
        };

        client.Start().map_err(|e| e.message())?;
        let mut written = 0usize;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
        while written < total && std::time::Instant::now() < deadline {
            let padding = client.GetCurrentPadding().map_err(|e| e.message())? as usize;
            let free = buffer_frames.saturating_sub(padding);
            let n = free.min(total - written);
            if n > 0 {
                let ptr = render.GetBuffer(n as u32).map_err(|e| e.message())?;
                for f in 0..n {
                    let v = sample_at(written + f).clamp(-1.0, 1.0);
                    for c in 0..channels {
                        if bits == 32 {
                            *(ptr as *mut f32).add(f * channels + c) = v;
                        } else {
                            *(ptr as *mut i16).add(f * channels + c) = (v * i16::MAX as f32) as i16;
                        }
                    }
                }
                render.ReleaseBuffer(n as u32, 0).map_err(|e| e.message())?;
                written += n;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // Let what is queued finish.
        while client.GetCurrentPadding().map(|p| p > 0).unwrap_or(false) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = client.Stop();
    }
    Ok(())
}

/// Play a named sound to the end, and say whether Windows accepted it. "chime", "bell",
/// "beep", "alarm", "soft", or "system" (Windows' own notification sound).
pub fn play_blocking(kind: &str, volume: u32) -> Result<bool, String> {
    let volume = volume.min(100);
    if kind == "system" {
        // Windows' own notification sound, by its registered alias.
        let ok = unsafe {
            PlaySoundW(windows::core::w!("SystemNotification"), HMODULE::default(), SND_ALIAS | SND_SYNC | SND_NODEFAULT)
        };
        if ok.as_bool() {
            return Ok(true);
        }
        // Windows' alias route can be refused (it is on some audio setups); a chime always works.
        return play_blocking("chime", volume);
    }
    let Some(s) = samples(kind) else {
        return Err(format!("I don't have a sound called “{kind}”."));
    };
    match play_wasapi(&s, volume) {
        Ok(()) => Ok(true),
        Err(first) => {
            // The older route, for a machine where WASAPI will not open the device.
            let bytes = wav(&s, volume);
            let ok = unsafe { PlaySoundW(PCWSTR(bytes.as_ptr() as *const u16), HMODULE::default(), SND_MEMORY | SND_SYNC | SND_NODEFAULT) };
            if ok.as_bool() { Ok(true) } else { Err(first) }
        }
    }
}

/// Start a sound and return at once (it plays on its own thread). The name is checked first,
/// so a bad one is an error here, not a silent failure later.
#[tauri::command]
pub fn play_alert_sound(kind: String, volume: Option<u32>) -> Result<bool, String> {
    if kind != "system" && samples(&kind).is_none() {
        return Err(format!("I don't have a sound called “{kind}”."));
    }
    let volume = volume.unwrap_or(70);
    std::thread::spawn(move || match play_blocking(&kind, volume) {
        Ok(true) => {}
        Ok(false) => eprintln!("alert sound {kind}: Windows refused to play it"),
        Err(e) => eprintln!("alert sound {kind}: {e}"),
    });
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sound_exists_and_is_a_few_seconds_at_most() {
        for k in ["chime", "bell", "beep", "alarm", "soft"] {
            let s = samples(k).unwrap_or_else(|| panic!("{k}"));
            let secs = s.len() as f32 / RATE as f32;
            assert!((0.3..=5.0).contains(&secs), "{k} is {secs}s");
            assert!(s.iter().any(|v| v.abs() > 0.05), "{k} is silent");
        }
        assert!(samples("klaxon").is_none());
    }

    #[test]
    fn the_wav_is_well_formed() {
        let b = wav(&samples("beep").unwrap(), 100);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(&b[8..16], b"WAVEfmt ");
        let data_len = u32::from_le_bytes(b[40..44].try_into().unwrap()) as usize;
        assert_eq!(b.len(), 44 + data_len);
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize, b.len() - 8);
    }

    #[test]
    fn volume_scales_and_never_clips() {
        let s = samples("alarm").unwrap();
        let loud = wav(&s, 100);
        let quiet = wav(&s, 20);
        let peak = |b: &[u8]| b[44..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs()).max().unwrap();
        assert!(peak(&loud) > peak(&quiet) * 3);
        assert!(peak(&loud) < i16::MAX as u16);
        // an out-of-range volume is clamped, not trusted
        assert_eq!(wav(&s, 500).len(), loud.len());
    }

    #[test]
    fn an_unknown_name_is_refused() {
        assert!(play_alert_sound("klaxon".into(), Some(50)).is_err());
    }

    /// Live: makes a sound on this PC, checks Windows accepted it and that it took real time to
    /// play (a sound that returns instantly was not played). Run on purpose:
    /// `cargo test --lib alert_sound -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_plays_every_sound() {
        for k in ["chime", "bell", "beep", "soft", "alarm", "system"] {
            let t = std::time::Instant::now();
            let ok = play_blocking(k, 40).unwrap();
            let took = t.elapsed().as_millis();
            eprintln!("{k}: accepted={ok} took={took}ms");
            assert!(ok, "{k} was refused");
            assert!(took > 150, "{k} returned in {took}ms — nothing was played");
        }
    }
}

