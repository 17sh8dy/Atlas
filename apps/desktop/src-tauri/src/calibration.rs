//! What real token counts have taught the estimator about each model.
//!
//! Every time a model server or provider reports its own token count for a request Atlas also
//! estimated, the ratio `reported / estimated` is folded into a moving average for that
//! (provider, model, kind of text). After enough samples the estimator is scaled by it, so a
//! model whose tokenizer is hungrier or leaner than the generic weights gets a closer estimate.
//!
//! **Stored: only ratios, sample counts and the model name. Never any text.** One small file,
//! `stats/calibration.json`, beside the stats file, on this device only.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Samples needed before a ratio is used. A handful of requests is noise.
pub const MIN_SAMPLES: u32 = 20;
/// A learned ratio is kept inside this band (permille): a model that "needs" 5x the estimate is a
/// sign something else is wrong, and silently applying it would hide that.
const MIN_PERMILLE: u64 = 500;
const MAX_PERMILLE: u64 = 2000;
/// Weight of each new sample in the moving average, in permille (100 = 10%).
const ALPHA_PERMILLE: u64 = 100;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Moving average of `reported / estimated`, in permille (1000 = estimate was exact).
    pub ratio_permille: u64,
    pub samples: u32,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Doc {
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

fn key(provider: &str, model: &str, kind: &str) -> String {
    format!("{provider}|{model}|{kind}")
}

fn fold(entry: &mut Entry, estimated: u64, reported: u64) {
    if estimated == 0 || reported == 0 {
        return; // nothing to learn from
    }
    let sample = (reported.saturating_mul(1000) / estimated).clamp(MIN_PERMILLE, MAX_PERMILLE);
    if entry.samples == 0 {
        entry.ratio_permille = sample;
    } else {
        entry.ratio_permille =
            (entry.ratio_permille * (1000 - ALPHA_PERMILLE) + sample * ALPHA_PERMILLE) / 1000;
    }
    entry.samples = entry.samples.saturating_add(1);
}

fn usable(entry: &Entry) -> Option<u64> {
    (entry.samples >= MIN_SAMPLES).then_some(entry.ratio_permille.clamp(MIN_PERMILLE, MAX_PERMILLE))
}

// ---- the live store --------------------------------------------------------------------

struct Live {
    doc: Doc,
    path: Option<PathBuf>,
}

fn live() -> &'static Mutex<Live> {
    static L: OnceLock<Mutex<Live>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Live { doc: Doc::default(), path: None }))
}

/// Called once from `setup()` with the stats folder.
pub fn init(dir: PathBuf) {
    let path = dir.join("calibration.json");
    let doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Doc>(&raw).ok())
        .unwrap_or_default();
    if let Ok(mut l) = live().lock() {
        l.doc = doc;
        l.path = Some(path);
    }
}

fn save(l: &Live) {
    let Some(path) = &l.path else { return };
    if let Ok(body) = serde_json::to_string_pretty(&l.doc) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Learn from one request that has both an estimate and a reported count.
pub fn observe(provider: &str, model: &str, kind: &str, estimated: u64, reported: u64) {
    if let Ok(mut l) = live().lock() {
        fold(l.doc.entries.entry(key(provider, model, kind)).or_default(), estimated, reported);
        save(&l);
    }
}

/// The ratio to scale an estimate by for this model and kind of text, once it has been learned.
pub fn ratio(provider: &str, model: &str, kind: &str) -> Option<u64> {
    let l = live().lock().ok()?;
    l.doc.entries.get(&key(provider, model, kind)).and_then(usable)
}

/// Scale `estimated` by what has been learned for this model, or leave it alone.
pub fn apply(provider: &str, model: &str, kind: &str, estimated: u64) -> u64 {
    match ratio(provider, model, kind) {
        Some(r) => estimated.saturating_mul(r).div_ceil(1000),
        None => estimated,
    }
}

// ---- the Knowledge tab's "Token accuracy" table -------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub provider: String,
    pub model: String,
    pub kind: String,
    pub samples: u32,
    pub ratio_permille: u64,
    /// True once there are enough samples for the ratio to be applied.
    pub in_use: bool,
}

fn rows_of(doc: &Doc) -> Vec<Row> {
    doc.entries
        .iter()
        .filter_map(|(k, e)| {
            let mut it = k.splitn(3, '|');
            Some(Row {
                provider: it.next()?.to_string(),
                model: it.next()?.to_string(),
                kind: it.next()?.to_string(),
                samples: e.samples,
                ratio_permille: e.ratio_permille,
                in_use: usable(e).is_some(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn calibration_status() -> Vec<Row> {
    live().lock().map(|l| rows_of(&l.doc)).unwrap_or_default()
}

/// Forget everything learned. Only ever makes estimates less tailored, so it needs no question.
#[tauri::command]
pub fn calibration_reset() {
    if let Ok(mut l) = live().lock() {
        l.doc = Doc::default();
        save(&l);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_sample_sets_the_ratio_and_later_ones_move_it_gently() {
        let mut e = Entry::default();
        fold(&mut e, 100, 120);
        assert_eq!((e.ratio_permille, e.samples), (1200, 1));
        fold(&mut e, 100, 200); // a wild sample moves it by only a tenth of the way
        assert_eq!(e.ratio_permille, 1280);
        assert_eq!(e.samples, 2);
    }

    #[test]
    fn nothing_is_learned_from_zeros() {
        let mut e = Entry::default();
        fold(&mut e, 0, 50);
        fold(&mut e, 50, 0);
        assert_eq!(e, Entry::default());
    }

    #[test]
    fn a_single_sample_is_clamped_into_the_band() {
        let mut e = Entry::default();
        fold(&mut e, 10, 1000);
        assert_eq!(e.ratio_permille, MAX_PERMILLE);
        let mut e = Entry::default();
        fold(&mut e, 1000, 1);
        assert_eq!(e.ratio_permille, MIN_PERMILLE);
    }

    #[test]
    fn a_ratio_is_not_used_until_there_are_enough_samples() {
        let mut e = Entry::default();
        for _ in 0..MIN_SAMPLES - 1 {
            fold(&mut e, 100, 130);
        }
        assert_eq!(usable(&e), None);
        fold(&mut e, 100, 130);
        assert_eq!(usable(&e), Some(1300));
    }

    #[test]
    fn apply_scales_only_when_learned() {
        // Nothing is stored for this model in a fresh process, so the estimate is returned as is.
        assert_eq!(apply("p", "never-seen-model", "prose", 100), 100);
    }

    #[test]
    fn the_stored_file_holds_ratios_and_names_but_never_text() {
        let mut doc = Doc::default();
        fold(doc.entries.entry(key("local", "qwen3.5:9b", "prose")).or_default(), 100, 110);
        let json = serde_json::to_string(&doc).unwrap();
        // Every key in the file is one of these; a field that could carry text would fail here.
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let entry = &v["entries"]["local|qwen3.5:9b|prose"];
        let mut fields: Vec<&str> = entry.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        fields.sort_unstable();
        assert_eq!(fields, vec!["ratioPermille", "samples"]);
    }

    #[test]
    fn rows_split_the_key_back_into_its_parts() {
        let mut doc = Doc::default();
        fold(doc.entries.entry(key("local", "qwen3.5:9b", "code")).or_default(), 100, 90);
        let rows = rows_of(&doc);
        assert_eq!((rows[0].provider.as_str(), rows[0].model.as_str(), rows[0].kind.as_str()), ("local", "qwen3.5:9b", "code"));
        assert!(!rows[0].in_use);
    }
}
