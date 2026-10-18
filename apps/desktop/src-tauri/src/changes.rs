//! Checkpoints for file edits: what a file was, what Atlas made it, and the way back.
//!
//! When Atlas edits a file (`code.edit`, `code.write`) the page records both sides here, in Atlas's
//! own data folder, so the edit can be reviewed afterwards and undone. That is the whole job; nothing
//! in this module decides WHETHER an edit may happen. Every write the commands below make goes
//! through the same Allowed-Folders gate as `write_text_file`, and Atlas's own folders (where these
//! checkpoints live) are protected from its file tools by `protected_paths`, so a checkpoint cannot
//! be read or rewritten through them.
//!
//! The two rules that matter:
//!
//!   · **Never overwrite work Atlas did not do.** Putting a change back, or replacing it with the
//!     person's own version, happens only if the file STILL holds exactly what Atlas wrote. If it
//!     has been edited since, the answer is `conflict` and the file is left exactly as it is.
//!   · **Nothing is kept that cannot be kept whole.** A side over 256 KB is refused (the same size
//!     Atlas can read and patch), so a checkpoint is never a truncated copy that "restores" half a
//!     file. Total size and count are bounded; the oldest are dropped first.
//!
//! Layout: `<app data>/changes/index.json` (a list of small records) and `<id>.json` per change with
//! the two texts. Everything is written to a temporary file and renamed, so a crash leaves the old
//! version, not a torn one.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DIR: &str = "changes";
const INDEX: &str = "index.json";
/// Each side of a change; the same size Atlas can read and patch.
const MAX_SIDE_BYTES: usize = 256 * 1024;
const MAX_CHANGES: usize = 100;
const MAX_TOTAL_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub path: String,
    pub name: String,
    /// Milliseconds since the epoch.
    pub at: u64,
    /// `applied`, `kept` or `reverted`.
    pub status: String,
    pub added: u64,
    pub removed: u64,
    pub source: String,
    #[serde(default)]
    pub edited: bool,
    /// Bytes held for this change (both sides), for the size bound.
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct Body {
    before: String,
    after: String,
}

/// A change with both sides, as the review panel reads it.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(flatten)]
    pub meta: Meta,
    pub before: String,
    pub after: String,
}

/// How an undo or an edit ended. Mirrors `ChangeOutcome` in `@atlas/core`.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub struct Outcome {
    pub ok: bool,
    pub outcome: &'static str,
    pub message: String,
}

impl Outcome {
    fn yes(outcome: &'static str, message: impl Into<String>) -> Self {
        Outcome { ok: true, outcome, message: message.into() }
    }
    fn no(outcome: &'static str, message: impl Into<String>) -> Self {
        Outcome { ok: false, outcome, message: message.into() }
    }
}

/// A change's id is `chg-` + hex and nothing else, so it can never be a path.
fn valid_id(id: &str) -> bool {
    id.len() <= 48 && id.starts_with("chg-") && id[4..].chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn name_of(path: &str) -> String {
    path.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The store, over a directory. Free of any global state so a test can run it on a temporary folder
/// and a permissive `allowed` check; the commands below hand it the real Allowed-Folders gate.
pub struct Store {
    dir: PathBuf,
    index: Vec<Meta>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let _ = std::fs::create_dir_all(&dir);
        let index = std::fs::read_to_string(dir.join(INDEX))
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<Meta>>(&t).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|m| valid_id(&m.id) && dir.join(format!("{}.json", m.id)).is_file())
            .collect();
        Store { dir, index }
    }

    fn save_index(&self) -> Result<(), String> {
        let text = serde_json::to_string(&self.index).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join(INDEX), &text).map_err(|e| e.to_string())
    }

    fn body_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn body(&self, id: &str) -> Option<Body> {
        std::fs::read_to_string(self.body_path(id)).ok().and_then(|t| serde_json::from_str(&t).ok())
    }

    fn position(&self, id: &str) -> Option<usize> {
        if !valid_id(id) {
            return None;
        }
        self.index.iter().position(|m| m.id == id)
    }

    /// Drop the oldest changes until the count and total size are within bounds.
    fn prune(&mut self) {
        loop {
            let total: u64 = self.index.iter().map(|m| m.bytes).sum();
            if self.index.len() <= MAX_CHANGES && total <= MAX_TOTAL_BYTES {
                break;
            }
            if self.index.is_empty() {
                break;
            }
            let gone = self.index.remove(0);
            let _ = std::fs::remove_file(self.body_path(&gone.id));
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &mut self,
        path: &str,
        before: &str,
        after: &str,
        source: &str,
        added: u64,
        removed: u64,
        allowed: &dyn Fn(&Path) -> bool,
    ) -> Result<String, String> {
        let p = PathBuf::from(path);
        if !p.is_absolute() || !allowed(&p) {
            return Err("That path is outside the folders Atlas can touch.".into());
        }
        if before.len() > MAX_SIDE_BYTES || after.len() > MAX_SIDE_BYTES {
            return Err("That file is too large to keep a checkpoint of.".into());
        }
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let at = now_ms();
        let id = format!("chg-{:x}-{:04x}", at, COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff);
        let body = serde_json::to_string(&Body { before: before.to_string(), after: after.to_string() })
            .map_err(|e| e.to_string())?;
        write_atomic(&self.body_path(&id), &body).map_err(|e| e.to_string())?;
        let source: String = source
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            .take(40)
            .collect();
        self.index.push(Meta {
            id: id.clone(),
            path: path.to_string(),
            name: name_of(path),
            at,
            status: "applied".into(),
            added,
            removed,
            source,
            edited: false,
            bytes: (before.len() + after.len()) as u64,
        });
        self.prune();
        self.save_index()?;
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Option<Record> {
        let i = self.position(id)?;
        let body = self.body(id)?;
        Some(Record { meta: self.index[i].clone(), before: body.before, after: body.after })
    }

    /// Newest first, without the text.
    pub fn list(&self, limit: usize) -> Vec<Meta> {
        self.index.iter().rev().take(limit.clamp(1, MAX_CHANGES)).cloned().collect()
    }

    pub fn keep(&mut self, id: &str) -> Outcome {
        let Some(i) = self.position(id) else {
            return Outcome::no("unknown", "I don't have that change any more.");
        };
        match self.index[i].status.as_str() {
            "reverted" => Outcome::no("conflict", "That change was already put back."),
            "kept" => Outcome::yes("kept", "Already marked as kept."),
            _ => {
                self.index[i].status = "kept".into();
                match self.save_index() {
                    Ok(()) => Outcome::yes("kept", "Marked as kept."),
                    Err(e) => Outcome::no("unknown", e),
                }
            }
        }
    }

    /// Put the file back to what it was before Atlas wrote it, but only if it still holds exactly
    /// what Atlas wrote.
    pub fn revert(&mut self, id: &str, may_change: &dyn Fn(&Path) -> bool) -> Outcome {
        let Some(i) = self.position(id) else {
            return Outcome::no("unknown", "I don't have that change any more.");
        };
        let Some(body) = self.body(id) else {
            return Outcome::no("unknown", "The saved copy of that change is gone, so I can't put it back.");
        };
        let meta = self.index[i].clone();
        if meta.status == "reverted" {
            return Outcome::yes("already", format!("{} was already put back.", meta.name));
        }
        let p = PathBuf::from(&meta.path);
        if !may_change(&p) {
            return Outcome::no("denied", "That path is outside the folders Atlas can touch.");
        }
        let current = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Outcome::no("missing", format!("{} isn't there any more, so there is nothing to put back.", meta.name))
            }
            Err(_) => {
                return Outcome::no("conflict", format!("I couldn't read {} to check it, so I left it alone.", meta.name))
            }
        };
        if current == body.before {
            self.index[i].status = "reverted".into();
            let _ = self.save_index();
            return Outcome::yes("already", format!("{} already holds what it did before the edit.", meta.name));
        }
        if current != body.after {
            return Outcome::no(
                "conflict",
                format!("{} has changed since Atlas edited it, so I left it alone. Nothing was overwritten.", meta.name),
            );
        }
        if let Err(e) = std::fs::write(&p, &body.before) {
            return Outcome::no("unknown", format!("I couldn't write {}: {e}", meta.name));
        }
        self.index[i].status = "reverted".into();
        match self.save_index() {
            Ok(()) => Outcome::yes("reverted", format!("Put {} back as it was before Atlas edited it.", meta.name)),
            Err(e) => Outcome::yes("reverted", format!("Put {} back (the history could not be updated: {e}).", meta.name)),
        }
    }

    /// Replace what Atlas wrote with the person's own version, under the same rule as `revert`. The
    /// original text stays the checkpoint, so undo still restores what the file was before Atlas.
    pub fn edit(
        &mut self,
        id: &str,
        content: &str,
        added: u64,
        removed: u64,
        may_change: &dyn Fn(&Path) -> bool,
    ) -> Outcome {
        let Some(i) = self.position(id) else {
            return Outcome::no("unknown", "I don't have that change any more.");
        };
        if content.len() > MAX_SIDE_BYTES {
            return Outcome::no("too-large", "That's too much text to keep a checkpoint of.");
        }
        let Some(mut body) = self.body(id) else {
            return Outcome::no("unknown", "The saved copy of that change is gone.");
        };
        let meta = self.index[i].clone();
        if meta.status == "reverted" {
            return Outcome::no("conflict", "That change was already put back, so there is nothing of Atlas's left to edit.");
        }
        let p = PathBuf::from(&meta.path);
        if !may_change(&p) {
            return Outcome::no("denied", "That path is outside the folders Atlas can touch.");
        }
        match std::fs::read_to_string(&p) {
            Ok(current) if current == body.after => {}
            Ok(_) => {
                return Outcome::no(
                    "conflict",
                    format!("{} has changed since Atlas edited it, so I left it alone. Nothing was overwritten.", meta.name),
                )
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Outcome::no("missing", format!("{} isn't there any more.", meta.name))
            }
            Err(_) => return Outcome::no("conflict", format!("I couldn't read {} to check it, so I left it alone.", meta.name)),
        }
        if let Err(e) = std::fs::write(&p, content) {
            return Outcome::no("unknown", format!("I couldn't write {}: {e}", meta.name));
        }
        body.after = content.to_string();
        let text = match serde_json::to_string(&body) {
            Ok(t) => t,
            Err(e) => return Outcome::no("unknown", e.to_string()),
        };
        if let Err(e) = write_atomic(&self.body_path(id), &text) {
            return Outcome::no("unknown", format!("Saved the file, but not its checkpoint: {e}"));
        }
        let m = &mut self.index[i];
        m.edited = true;
        m.added = added;
        m.removed = removed;
        m.bytes = (body.before.len() + body.after.len()) as u64;
        match self.save_index() {
            Ok(()) => Outcome::yes("edited", format!("Saved your edit to {}. Undo still restores the original.", meta.name)),
            Err(e) => Outcome::yes("edited", format!("Saved your edit to {} (the history could not be updated: {e}).", meta.name)),
        }
    }
}

// ---- the real store, behind the commands --------------------------------------------------

fn global() -> &'static Mutex<Option<Store>> {
    static S: OnceLock<Mutex<Option<Store>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Called once from `setup()`.
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(mut g) = global().lock() {
            *g = Some(Store::open(dir.join(DIR)));
        }
    }
}

fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> Result<T, String> {
    let mut g = global().lock().map_err(|_| "Checkpoints are unavailable right now.".to_string())?;
    let s = g.as_mut().ok_or_else(|| "Checkpoints are unavailable right now.".to_string())?;
    Ok(f(s))
}

#[tauri::command]
pub fn change_record(
    path: String,
    before: String,
    after: String,
    source: String,
    added: u64,
    removed: u64,
) -> Result<String, String> {
    crate::halt::global().check()?;
    with_store(|s| s.record(&path, &before, &after, &source, added, removed, &|p| crate::allowed_folders::is_permitted(p)))?
}

#[tauri::command]
pub fn change_get(id: String) -> Result<Option<Record>, String> {
    with_store(|s| s.get(&id))
}

#[tauri::command]
pub fn change_list(limit: Option<u32>) -> Result<Vec<Meta>, String> {
    with_store(|s| s.list(limit.unwrap_or(50) as usize))
}

#[tauri::command]
pub fn change_keep(id: String) -> Result<Outcome, String> {
    with_store(|s| s.keep(&id))
}

#[tauri::command]
pub fn change_revert(id: String) -> Result<Outcome, String> {
    crate::halt::global().check()?;
    with_store(|s| s.revert(&id, &|p| crate::allowed_folders::is_permitted_to_change(p)))
}

#[tauri::command]
pub fn change_edit(id: String, content: String, added: u64, removed: u64) -> Result<Outcome, String> {
    crate::halt::global().check()?;
    with_store(|s| s.edit(&id, &content, added, removed, &|p| crate::allowed_folders::is_permitted_to_change(p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "atlas-changes-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const ANY: &dyn Fn(&Path) -> bool = &|_| true;
    const NONE: &dyn Fn(&Path) -> bool = &|_| false;

    /// A store, plus a real file Atlas "edited" from `before` to `after`.
    fn with_edit(tag: &str, before: &str, after: &str) -> (Store, PathBuf, String, PathBuf) {
        let root = scratch(tag);
        let file = root.join("app.ts");
        std::fs::write(&file, after).unwrap();
        let mut s = Store::open(root.join("changes"));
        let id = s.record(file.to_str().unwrap(), before, after, "code.edit", 1, 1, ANY).unwrap();
        (s, file, id, root)
    }

    #[test]
    fn a_recorded_change_comes_back_whole() {
        let (s, file, id, _r) = with_edit("whole", "a\nb\n", "a\nB\n");
        let rec = s.get(&id).unwrap();
        assert_eq!((rec.before.as_str(), rec.after.as_str()), ("a\nb\n", "a\nB\n"));
        assert_eq!(rec.meta.status, "applied");
        assert_eq!(rec.meta.name, "app.ts");
        assert_eq!(rec.meta.path, file.to_str().unwrap());
        assert_eq!((rec.meta.added, rec.meta.removed), (1, 1));
    }

    #[test]
    fn undo_puts_the_original_back_when_nothing_else_touched_the_file() {
        let (mut s, file, id, _r) = with_edit("undo", "old\n", "new\n");
        let o = s.revert(&id, ANY);
        assert_eq!((o.ok, o.outcome), (true, "reverted"), "{}", o.message);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old\n");
        assert_eq!(s.get(&id).unwrap().meta.status, "reverted");
        // A second undo is a no-op, not a second write.
        let again = s.revert(&id, ANY);
        assert_eq!((again.ok, again.outcome), (true, "already"));
    }

    #[test]
    fn undo_refuses_to_overwrite_work_atlas_did_not_do() {
        let (mut s, file, id, _r) = with_edit("conflict", "old\n", "new\n");
        // The person kept working after Atlas's edit.
        std::fs::write(&file, "new\nplus my own line\n").unwrap();
        let o = s.revert(&id, ANY);
        assert_eq!((o.ok, o.outcome), (false, "conflict"));
        assert!(o.message.contains("changed since Atlas edited it"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new\nplus my own line\n", "their work is untouched");
        assert_eq!(s.get(&id).unwrap().meta.status, "applied", "and it is still reviewable");
    }

    #[test]
    fn undo_of_a_file_already_back_to_the_original_is_not_an_error() {
        let (mut s, file, id, _r) = with_edit("manual", "old\n", "new\n");
        std::fs::write(&file, "old\n").unwrap(); // they undid it themselves
        let o = s.revert(&id, ANY);
        assert_eq!((o.ok, o.outcome), (true, "already"));
        assert_eq!(s.get(&id).unwrap().meta.status, "reverted");
    }

    #[test]
    fn a_missing_file_is_reported_not_recreated() {
        let (mut s, file, id, _r) = with_edit("missing", "old\n", "new\n");
        std::fs::remove_file(&file).unwrap();
        let o = s.revert(&id, ANY);
        assert_eq!((o.ok, o.outcome), (false, "missing"));
        assert!(!file.exists(), "undo must not conjure a file that was deleted");
    }

    #[test]
    fn nothing_is_written_where_atlas_may_not_write() {
        let (mut s, file, id, _r) = with_edit("denied", "old\n", "new\n");
        let o = s.revert(&id, NONE);
        assert_eq!((o.ok, o.outcome), (false, "denied"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new\n");
        // And a path outside the allowed folders is never even recorded.
        let root = scratch("deny-record");
        let mut s2 = Store::open(root.join("changes"));
        assert!(s2.record(root.join("x.txt").to_str().unwrap(), "a", "b", "code.edit", 1, 1, NONE).is_err());
        assert!(s2.list(10).is_empty());
    }

    #[test]
    fn a_relative_path_is_never_recorded() {
        let root = scratch("relative");
        let mut s = Store::open(root.join("changes"));
        assert!(s.record("src/app.ts", "a", "b", "code.edit", 1, 1, ANY).is_err());
    }

    #[test]
    fn a_side_over_the_read_cap_is_refused_whole_rather_than_truncated() {
        let root = scratch("big");
        let mut s = Store::open(root.join("changes"));
        let big = "x".repeat(MAX_SIDE_BYTES + 1);
        let e = s.record(root.join("f.txt").to_str().unwrap(), &big, "small", "code.write", 1, 1, ANY).unwrap_err();
        assert!(e.contains("too large"));
        assert!(s.list(10).is_empty());
        // Exactly at the cap is fine.
        let max = "x".repeat(MAX_SIDE_BYTES);
        assert!(s.record(root.join("f.txt").to_str().unwrap(), &max, "small", "code.write", 1, 1, ANY).is_ok());
    }

    #[test]
    fn keep_marks_a_change_reviewed_without_touching_the_file() {
        let (mut s, file, id, _r) = with_edit("keep", "old\n", "new\n");
        let o = s.keep(&id);
        assert_eq!((o.ok, o.outcome), (true, "kept"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new\n");
        assert_eq!(s.get(&id).unwrap().meta.status, "kept");
        // A kept change can still be undone later.
        assert_eq!(s.revert(&id, ANY).outcome, "reverted");
        // But a reverted one cannot then be "kept".
        assert!(!s.keep(&id).ok);
    }

    #[test]
    fn editing_keeps_the_original_as_the_checkpoint() {
        let (mut s, file, id, _r) = with_edit("edit", "old\n", "new\n");
        let o = s.edit(&id, "new, and then some\n", 2, 1, ANY);
        assert_eq!((o.ok, o.outcome), (true, "edited"), "{}", o.message);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new, and then some\n");
        let rec = s.get(&id).unwrap();
        assert_eq!(rec.before, "old\n", "the original is still what undo restores");
        assert_eq!(rec.after, "new, and then some\n");
        assert!(rec.meta.edited);
        assert_eq!((rec.meta.added, rec.meta.removed), (2, 1));
        // Undo now restores the ORIGINAL, in one step.
        assert_eq!(s.revert(&id, ANY).outcome, "reverted");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old\n");
    }

    #[test]
    fn editing_refuses_when_the_file_moved_on_underneath() {
        let (mut s, file, id, _r) = with_edit("edit-conflict", "old\n", "new\n");
        std::fs::write(&file, "somebody else's version\n").unwrap();
        let o = s.edit(&id, "mine\n", 1, 1, ANY);
        assert_eq!((o.ok, o.outcome), (false, "conflict"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "somebody else's version\n");
    }

    #[test]
    fn the_newest_changes_come_first_and_the_oldest_are_dropped() {
        let root = scratch("prune");
        let mut s = Store::open(root.join("changes"));
        let mut ids = Vec::new();
        for i in 0..(MAX_CHANGES + 5) {
            ids.push(s.record(root.join("f.txt").to_str().unwrap(), "a", &format!("b{i}"), "code.edit", 1, 1, ANY).unwrap());
        }
        let all = s.list(1000);
        assert_eq!(all.len(), MAX_CHANGES, "bounded");
        assert_eq!(all[0].id, *ids.last().unwrap(), "newest first");
        assert!(s.get(&ids[0]).is_none(), "the oldest is gone");
        assert!(!s.body_path(&ids[0]).exists(), "and so is its saved copy");
        assert!(s.get(ids.last().unwrap()).is_some());
    }

    #[test]
    fn the_history_survives_a_restart_and_a_damaged_index_is_not_fatal() {
        let (s, _f, id, root) = with_edit("restart", "old\n", "new\n");
        drop(s);
        let reopened = Store::open(root.join("changes"));
        assert_eq!(reopened.get(&id).unwrap().meta.status, "applied");
        std::fs::write(root.join("changes").join(INDEX), "{ not json").unwrap();
        let broken = Store::open(root.join("changes"));
        assert!(broken.list(10).is_empty(), "a torn index is an empty history, not a crash");
    }

    #[test]
    fn an_index_entry_whose_saved_copy_is_gone_is_dropped_on_load() {
        let (s, _f, id, root) = with_edit("orphan", "old\n", "new\n");
        std::fs::remove_file(s.body_path(&id)).unwrap();
        drop(s);
        assert!(Store::open(root.join("changes")).list(10).is_empty());
    }

    #[test]
    fn an_id_can_never_be_a_path() {
        let (s, _f, _id, _r) = with_edit("ids", "a", "b");
        for bad in ["", "..\\..\\storage", "../x", "chg-../x", "chg-zz", "storage", &format!("chg-{}", "a".repeat(60))] {
            assert!(s.get(bad).is_none(), "{bad}");
        }
        assert!(valid_id("chg-19f3a2b-0001"));
    }

    #[test]
    fn the_source_is_reduced_to_a_name() {
        let root = scratch("source");
        let mut s = Store::open(root.join("changes"));
        let id = s.record(root.join("f.txt").to_str().unwrap(), "a", "b", "code.edit <script>\n", 1, 1, ANY).unwrap();
        assert_eq!(s.get(&id).unwrap().meta.source, "code.editscript");
    }
}
