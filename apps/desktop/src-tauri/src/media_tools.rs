//! Converting and shrinking media with ffmpeg — the program, found where it is
//! installed, run with fixed arguments.
//!
//! Atlas does not bundle ffmpeg (it is large, and many people already have it).
//! When it is not there, the error says so and nothing is attempted.
//!
//! Every operation is an enumerated choice with a fixed ffmpeg argument list: the
//! person picks *what* ("compress", "convert to mp3", "make it 800 wide"), never
//! the flags. The input is a file in the allowed folders; the output is a **new**
//! file beside it (`name (compressed).mp4`, `name (2).mp3`) and is never allowed
//! to replace anything — ffmpeg is run with `-n`, and the name is chosen free
//! first anyway.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::platform::{is_permitted, plain_path};

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaResult {
    pub output: String,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

/// ffmpeg on PATH, or in the places people unpack or install it.
pub(crate) fn find_ffmpeg() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        if let Ok(entries) = std::fs::read_dir(&pf) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().to_ascii_lowercase().starts_with("ffmpeg") {
                    dirs.push(e.path().join("bin"));
                }
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft/WinGet/Links"));
    }
    dirs.into_iter().map(|d| d.join("ffmpeg.exe")).find(|p| p.is_file())
}

const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv"];
const AUDIO_EXT: &[&str] = &["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma", "opus"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// `name.ext`, then `name (2).ext`, … — the first that does not exist.
fn free_output(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    (1u32..)
        .map(|n| dir.join(if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") }))
        .find(|p| !p.exists())
        .unwrap()
}

fn checked_input(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !is_permitted(&p) || !p.is_file() {
        return Err("I can only work on a file in the folders Atlas can touch.".into());
    }
    Ok(p)
}

fn run(ffmpeg: &Path, args: &[String], out: &Path, input: &Path) -> Result<MediaResult, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args).creation_flags(0x0800_0000);
    let output = crate::halt::global()
        .run(cmd)
        .map_err(|e| crate::halt::describe(&e, || format!("I couldn't run ffmpeg: {e}")))?;
    if !output.status.success() || !out.is_file() {
        // Never leave a half-written file behind.
        let _ = std::fs::remove_file(out);
        let err = String::from_utf8_lossy(&output.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("ffmpeg failed.");
        return Err(format!("ffmpeg couldn't do that: {}", last.trim()));
    }
    Ok(MediaResult {
        output: plain_path(out),
        input_bytes: std::fs::metadata(input).map(|m| m.len()).unwrap_or(0),
        output_bytes: std::fs::metadata(out).map(|m| m.len()).unwrap_or(0),
    })
}

fn path_arg(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Shrink a video. `level`: "small" (smallest), "balanced", or "high" (best quality).
#[tauri::command(async)]
pub fn compress_video(path: String, level: String) -> Result<MediaResult, String> {
    crate::halt::global().check()?;
    let input = checked_input(&path)?;
    if !VIDEO_EXT.contains(&ext_of(&input).as_str()) {
        return Err("That doesn't look like a video file.".into());
    }
    // Constant-quality H.264: a higher CRF is a smaller, softer file.
    let (crf, preset) = match level.as_str() {
        "small" => ("32", "slow"),
        "balanced" => ("28", "medium"),
        "high" => ("23", "medium"),
        _ => return Err("Pick small, balanced or high.".into()),
    };
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg isn't installed on this PC, so I can't compress video. Install it (for example with winget install ffmpeg) and ask again.")?;
    let dir = input.parent().ok_or("That file has no folder.")?;
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let out = free_output(dir, &format!("{stem} (compressed)"), "mp4");
    let args: Vec<String> = [
        "-hide_banner", "-loglevel", "error", "-n", "-i", &path_arg(&input),
        "-c:v", "libx264", "-crf", crf, "-preset", preset, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", &path_arg(&out),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    run(&ffmpeg, &args, &out, &input)
}

/// The formats a file can be converted to, and what each needs.
fn target_kind(format: &str) -> Option<&'static str> {
    Some(match format {
        "mp3" | "wav" | "flac" | "m4a" | "ogg" | "opus" => "audio",
        "mp4" | "webm" | "gif" => "video",
        "png" | "jpg" | "webp" | "bmp" => "image",
        _ => return None,
    })
}

/// Convert a media file to another format (new file beside it).
#[tauri::command(async)]
pub fn convert_media(path: String, format: String) -> Result<MediaResult, String> {
    crate::halt::global().check()?;
    let input = checked_input(&path)?;
    let from = ext_of(&input);
    let kind = target_kind(&format).ok_or("I convert to mp3, wav, flac, m4a, ogg, opus, mp4, webm, gif, png, jpg, webp or bmp.")?;
    let source_kind = if VIDEO_EXT.contains(&from.as_str()) {
        "video"
    } else if AUDIO_EXT.contains(&from.as_str()) {
        "audio"
    } else if IMAGE_EXT.contains(&from.as_str()) {
        "image"
    } else {
        return Err("That isn't a video, audio or image file I know.".into());
    };
    // Video -> audio (extract the sound) and video -> gif are fine; a picture to audio is not.
    let ok = match (source_kind, kind) {
        (a, b) if a == b => true,
        ("video", "audio") => true,
        ("video", "image") => true, // the first frame
        _ => false,
    };
    if !ok {
        return Err(format!("I can't turn a {source_kind} file into {format}."));
    }
    if from == format || (from == "jpeg" && format == "jpg") {
        return Err(format!("That's already {format}."));
    }
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg isn't installed on this PC, so I can't convert media.")?;
    let dir = input.parent().ok_or("That file has no folder.")?;
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("converted");
    let out = free_output(dir, stem, &format);
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-n", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(path_arg(&input));
    if kind == "audio" && source_kind == "video" {
        args.push("-vn".into()); // drop the picture, keep the sound
    }
    if kind == "image" && source_kind == "video" {
        args.extend(["-frames:v".into(), "1".into()]);
    }
    if format == "gif" {
        args.extend(["-vf".into(), "fps=12,scale=480:-1:flags=lanczos".into()]);
    }
    args.push(path_arg(&out));
    run(&ffmpeg, &args, &out, &input)
}

/// Resize a picture to a width in pixels (height follows), or to a percentage.
#[tauri::command(async)]
pub fn resize_image(path: String, width: Option<u32>, percent: Option<u32>) -> Result<MediaResult, String> {
    crate::halt::global().check()?;
    let input = checked_input(&path)?;
    let ext = ext_of(&input);
    if !IMAGE_EXT.contains(&ext.as_str()) {
        return Err("That doesn't look like a picture.".into());
    }
    let filter = match (width, percent) {
        (Some(w), None) if (16..=16_000).contains(&w) => format!("scale={w}:-2"),
        (None, Some(p)) if (5..=400).contains(&p) => format!("scale=iw*{p}/100:-2"),
        _ => return Err("Give a width between 16 and 16000 pixels, or a percentage between 5 and 400.".into()),
    };
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg isn't installed on this PC, so I can't resize pictures.")?;
    let dir = input.parent().ok_or("That file has no folder.")?;
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let out = free_output(dir, &format!("{stem} (resized)"), &ext);
    let args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-n", "-i", &path_arg(&input), "-vf", &filter, &path_arg(&out)]
        .iter()
        .map(|s| s.to_string())
        .collect();
    run(&ffmpeg, &args, &out, &input)
}

// ---- what is in a media file, and small edits -------------------------------------------

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate_kbps: Option<u32>,
    pub size_bytes: u64,
}

/// `Duration: 00:01:23.45,` → seconds.
fn parse_duration(line: &str) -> Option<f64> {
    let rest = line.split("Duration:").nth(1)?.trim();
    let t = rest.split(',').next()?.trim();
    if t.starts_with('N') {
        return None; // "N/A"
    }
    let mut parts = t.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Read what ffmpeg prints about an input. Parsed apart from running it, so the
/// fragile part (a program's human-readable output) is the part under test.
fn parse_media_info(text: &str, size_bytes: u64) -> MediaInfo {
    let mut info = MediaInfo { size_bytes, ..Default::default() };
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("Duration:") {
            info.duration_seconds = parse_duration(l);
            if let Some(b) = l.split("bitrate:").nth(1) {
                info.bitrate_kbps = b.trim().split_whitespace().next().and_then(|n| n.parse().ok());
            }
        } else if l.starts_with("Stream #") && l.contains(" Video:") && info.video_codec.is_none() {
            let after = l.split(" Video:").nth(1).unwrap_or("");
            info.video_codec = after.trim().split(|c: char| c == ' ' || c == ',' || c == '(').next().map(str::to_string);
            // The picture size is the first WxH of at least two digits each, outside parentheses.
            for tok in after.split(|c: char| c == ',' || c == ' ') {
                if let Some((w, h)) = tok.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if w >= 16 && h >= 16 {
                            info.width = Some(w);
                            info.height = Some(h);
                            break;
                        }
                    }
                }
            }
            let words: Vec<&str> = after.split(|c: char| c == ',' || c == ' ').filter(|w| !w.is_empty()).collect();
            if let Some(i) = words.iter().position(|w| *w == "fps") {
                info.fps = i.checked_sub(1).and_then(|j| words[j].parse().ok());
            }
        } else if l.starts_with("Stream #") && l.contains(" Audio:") && info.audio_codec.is_none() {
            let after = l.split(" Audio:").nth(1).unwrap_or("");
            info.audio_codec = after.trim().split(|c: char| c == ' ' || c == ',').next().map(str::to_string);
        }
    }
    info
}

/// Length, picture size, frame rate, codecs and bitrate of a video, audio or picture file.
#[tauri::command(async)]
pub fn media_info(path: String) -> Result<MediaInfo, String> {
    use std::os::windows::process::CommandExt;
    crate::halt::global().check()?;
    let input = checked_input(&path)?;
    let ext = ext_of(&input);
    if !VIDEO_EXT.contains(&ext.as_str()) && !AUDIO_EXT.contains(&ext.as_str()) && !IMAGE_EXT.contains(&ext.as_str()) {
        return Err("That isn't a video, audio or image file I know.".into());
    }
    let ffmpeg = find_ffmpeg().ok_or("ffmpeg isn't installed on this PC, so I can't read media details.")?;
    // `-i` with no output prints the details and then exits with an error; that is expected.
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-i"]).arg(&input).creation_flags(0x0800_0000);
    let out = crate::halt::global()
        .run(cmd)
        .map_err(|e| crate::halt::describe(&e, || format!("I couldn't run ffmpeg: {e}")))?;
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    if !text.contains("Stream #") {
        return Err("I couldn't read that file as media.".into());
    }
    Ok(parse_media_info(&text, std::fs::metadata(&input).map(|m| m.len()).unwrap_or(0)))
}

/// Seconds, if sane: not negative, not NaN, under a day.
fn sane_seconds(v: Option<f64>) -> Option<f64> {
    v.filter(|s| s.is_finite() && *s >= 0.0 && *s <= 86_400.0)
}

/// Small edits, each a fixed ffmpeg recipe, always to a new file beside the original.
/// `op`: `trim` (a = start, b = end, seconds), `frame` (a = when, seconds; a picture),
/// `rotate` (a = 90, 180 or 270 clockwise; pictures), `flip` (a = 0 sideways, 1 upside down;
/// pictures), `square` (centre crop; pictures), `thumbnail` (256 pixels wide; pictures).
#[tauri::command(async)]
pub fn edit_media(path: String, op: String, a: Option<f64>, b: Option<f64>) -> Result<MediaResult, String> {
    crate::halt::global().check()?;
    let input = checked_input(&path)?;
    let ext = ext_of(&input);
    let is_video = VIDEO_EXT.contains(&ext.as_str());
    let is_audio = AUDIO_EXT.contains(&ext.as_str());
    let is_image = IMAGE_EXT.contains(&ext.as_str());
    let dir = input.parent().ok_or("That file has no folder.")?;
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("media").to_string();
    let inp = path_arg(&input);
    let base = |extra: &[&str], out: &Path| -> Vec<String> {
        let mut v: Vec<String> = ["-hide_banner", "-loglevel", "error", "-n"].iter().map(|s| s.to_string()).collect();
        v.extend(extra.iter().map(|s| s.to_string()));
        v.push(path_arg(out));
        v
    };
    let need_ffmpeg = |what: &str| find_ffmpeg().ok_or(format!("ffmpeg isn't installed on this PC, so I can't {what}."));

    match op.as_str() {
        "trim" => {
            if !is_video && !is_audio {
                return Err("I can only trim a video or an audio file.".into());
            }
            let (start, end) = match (sane_seconds(a), sane_seconds(b)) {
                (Some(s), Some(e)) if e > s => (s, e),
                _ => return Err("Give a start and an end time in seconds, with the end after the start.".into()),
            };
            let ffmpeg = need_ffmpeg("trim media")?;
            let out = free_output(dir, &format!("{stem} (trimmed)"), &ext);
            let (s, e) = (format!("{start}"), format!("{end}"));
            let mut extra: Vec<&str> = vec!["-i", &inp, "-ss", &s, "-to", &e];
            if is_video {
                extra.extend(["-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
            }
            run(&ffmpeg, &base(&extra, &out), &out, &input)
        }
        "frame" => {
            if !is_video {
                return Err("I can only take a still from a video.".into());
            }
            let at = sane_seconds(a).ok_or("Say when, in seconds.")?;
            let ffmpeg = need_ffmpeg("take a still from a video")?;
            let out = free_output(dir, &format!("{stem} (frame at {}s)", at.round() as u64), "png");
            let t = format!("{at}");
            run(&ffmpeg, &base(&["-ss", &t, "-i", &inp, "-frames:v", "1"], &out), &out, &input)
        }
        "rotate" | "flip" | "square" | "thumbnail" => {
            if !is_image {
                return Err("That one only works on a picture.".into());
            }
            let (filter, label): (&str, &str) = match (op.as_str(), a.map(|v| v as i64)) {
                ("rotate", Some(90)) => ("transpose=1", "rotated"),
                ("rotate", Some(180)) => ("transpose=1,transpose=1", "rotated"),
                ("rotate", Some(270)) => ("transpose=2", "rotated"),
                ("rotate", _) => return Err("I rotate by 90, 180 or 270 degrees.".into()),
                ("flip", Some(0)) => ("hflip", "flipped"),
                ("flip", Some(1)) => ("vflip", "flipped"),
                ("flip", _) => return Err("Flip sideways or upside down.".into()),
                ("square", _) => ("crop='min(iw,ih)':'min(iw,ih)'", "square"),
                ("thumbnail", _) => ("scale=256:-2", "thumbnail"),
                _ => return Err(format!("There's no picture edit called “{op}”.")),
            };
            let ffmpeg = need_ffmpeg("edit pictures")?;
            let out = free_output(dir, &format!("{stem} ({label})"), &ext);
            run(&ffmpeg, &base(&["-i", &inp, "-vf", filter], &out), &out, &input)
        }
        _ => Err(format!("There's no media edit called “{op}”.")),
    }
}

#[cfg(test)]
mod more_tests {
    use super::*;

    const SAMPLE: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  Duration: 00:01:23.45, start: 0.000000, bitrate: 2500 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2368 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)\n";

    #[test]
    fn reads_what_ffmpeg_says_about_a_video() {
        let i = parse_media_info(SAMPLE, 1000);
        assert!((i.duration_seconds.unwrap() - 83.45).abs() < 0.001);
        assert_eq!((i.width, i.height), (Some(1920), Some(1080)));
        assert_eq!(i.fps, Some(29.97));
        assert_eq!(i.video_codec.as_deref(), Some("h264"));
        assert_eq!(i.audio_codec.as_deref(), Some("aac"));
        assert_eq!(i.bitrate_kbps, Some(2500));
    }

    #[test]
    fn a_picture_has_a_size_and_no_length() {
        let png = "Input #0, png_pipe, from 'a.png':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 320x200, 25 fps, 25 tbr, 25 tbn\n";
        let i = parse_media_info(png, 5);
        assert_eq!(i.duration_seconds, None);
        assert_eq!((i.width, i.height), (Some(320), Some(200)));
    }

    #[test]
    fn bad_edits_are_refused_before_ffmpeg_is_looked_for() {
        assert!(edit_media("C:\\nope.mp4".into(), "trim".into(), Some(1.0), Some(2.0)).is_err());
        assert!(sane_seconds(Some(-1.0)).is_none());
        assert!(sane_seconds(Some(f64::NAN)).is_none());
        assert!(sane_seconds(Some(10.0)).is_some());
    }

    /// Live: make a tiny test clip and picture, then read and edit them.
    /// Run on purpose: `cargo test --lib media_tools -- --ignored`.
    #[test]
    #[ignore]
    fn live_info_trim_frame_rotate() {
        let Some(ffmpeg) = find_ffmpeg() else { return };
        let d = std::env::temp_dir().join(format!("atlas-media-more-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        if !is_permitted(&d) {
            return;
        }
        let clip = d.join("clip.mp4");
        let made = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=4", "-pix_fmt", "yuv420p", "-y"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(made.success());
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let info = media_info(s(&clip)).unwrap();
        assert_eq!((info.width, info.height), (Some(320), Some(240)));
        assert!((info.duration_seconds.unwrap() - 4.0).abs() < 0.2);
        let cut = edit_media(s(&clip), "trim".into(), Some(1.0), Some(3.0)).unwrap();
        assert!(cut.output.ends_with("clip (trimmed).mp4"));
        let cut_info = media_info(cut.output.clone()).unwrap();
        assert!((cut_info.duration_seconds.unwrap() - 2.0).abs() < 0.3, "{:?}", cut_info.duration_seconds);
        let frame = edit_media(s(&clip), "frame".into(), Some(2.0), None).unwrap();
        assert!(frame.output.ends_with("clip (frame at 2s).png"));
        let rot = edit_media(frame.output.clone(), "rotate".into(), Some(90.0), None).unwrap();
        let ri = media_info(rot.output).unwrap();
        assert_eq!((ri.width, ri.height), (Some(240), Some(320)));
        let sq = edit_media(frame.output, "square".into(), None, None).unwrap();
        let si = media_info(sq.output).unwrap();
        assert_eq!(si.width, si.height);
        assert!(clip.is_file());
        let _ = std::fs::remove_dir_all(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_never_collide() {
        let d = std::env::temp_dir().join(format!("atlas-media-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.mp3"), b"x").unwrap();
        std::fs::write(d.join("a (2).mp3"), b"x").unwrap();
        assert_eq!(free_output(&d, "a", "mp3"), d.join("a (3).mp3"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn what_can_become_what() {
        assert_eq!(target_kind("mp3"), Some("audio"));
        assert_eq!(target_kind("gif"), Some("video"));
        assert_eq!(target_kind("webp"), Some("image"));
        assert_eq!(target_kind("exe"), None);
        assert_eq!(target_kind("../x"), None);
    }

    #[test]
    fn bad_levels_and_sizes_are_refused_before_ffmpeg_is_looked_for() {
        assert!(compress_video("C:\\definitely\\not\\allowed.mp4".into(), "small".into()).is_err());
        assert!(resize_image("C:\\nope.png".into(), Some(1), None).is_err());
        assert!(convert_media("C:\\nope.mp4".into(), "exe".into()).is_err());
    }

    /// Live: with ffmpeg installed, make a tiny test picture, convert and resize it.
    /// Run on purpose: `cargo test --lib media_tools -- --ignored`.
    #[test]
    #[ignore]
    fn live_convert_and_resize_a_real_picture() {
        let Some(ffmpeg) = find_ffmpeg() else {
            eprintln!("ffmpeg not installed; skipping");
            return;
        };
        let d = std::env::temp_dir().join(format!("atlas-media-live-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        if !is_permitted(&d) {
            eprintln!("temp is outside the allowed roots here; skipping");
            return;
        }
        let png = d.join("test.png");
        let made = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x200", "-frames:v", "1", "-y"])
            .arg(&png)
            .status()
            .unwrap();
        assert!(made.success() && png.is_file());

        let jpg = convert_media(png.to_string_lossy().into_owned(), "jpg".into()).unwrap();
        assert!(jpg.output.ends_with("test.jpg") && Path::new(&jpg.output).is_file());
        let small = resize_image(png.to_string_lossy().into_owned(), Some(100), None).unwrap();
        assert!(small.output.ends_with("test (resized).png"));
        // the original is untouched
        assert!(png.is_file());
        // a second conversion gets a new name rather than replacing the first
        let again = convert_media(png.to_string_lossy().into_owned(), "jpg".into()).unwrap();
        assert!(again.output.ends_with("test (2).jpg"), "{}", again.output);
        let _ = std::fs::remove_dir_all(d);
    }
}
