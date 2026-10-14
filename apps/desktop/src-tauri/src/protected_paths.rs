//! Atlas's own folders, which ordinary file commands must never read or change.
//!
//! The Allowed Folders default is `%USERPROFILE%`, and Atlas's own state lives inside it:
//! `%APPDATA%\dev.atlas.assistant` (`storage.json`: settings, the account token, saved plans),
//! `%LOCALAPPDATA%\dev.atlas.assistant` (downloaded updates, WebView data) and the per-user
//! install folder. A file command that can reach those can rewrite or read the very state the
//! native authorization design protects, so they are excluded **below** the Allowed Folders
//! list: adding a folder to the list never widens into them.
//!
//! What counts as "inside" is decided on resolved paths, never on the spelling the caller used:
//!
//! * the caller's path is canonicalised first (`..`, symlinks, junctions, `\\?\` forms and 8.3
//!   short names all resolve to the real location);
//! * comparison is by whole path components and case-insensitively, so `Atlas` vs `atlas` and
//!   `dev.atlas.assistant-evil` are decided correctly;
//! * a path that *contains* a protected folder is protected against **change** too, so a rename,
//!   move or delete of `AppData\Roaming` (or the home folder) cannot relocate or remove it;
//! * a file with several hard links is protected if any of its names is inside a protected
//!   folder.
//!
//! What it does not do, stated so nobody assumes it does: it is not a defence against a program
//! the person runs outside Atlas, against a junction created *between* the check and the use
//! (the usual check-then-use window, which a path-taking API cannot close without handles), or
//! against `run_powershell` and the other executing commands, which see the whole user account.
//! Those are listed in `docs/NATIVE-AUTHORIZATION-INVENTORY.md`.

use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::OnceLock;

/// The protected folder names under `%APPDATA%` / `%LOCALAPPDATA%`, from `tauri.conf.json`.
const IDENTIFIER: &str = "dev.atlas.assistant";
/// The per-user installer's default folder name (`productName`).
const PRODUCT: &str = "Atlas";

/// Canonicalise `p`; if it does not exist yet, canonicalise its nearest existing ancestor and
/// append the rest, so a folder that is created later (the updates folder before the first
/// download) is still recognised by its resolved location.
fn lenient_canonical(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        match cur.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => break,
        }
        if !cur.pop() {
            break;
        }
        if let Ok(mut base) = cur.canonicalize() {
            for part in tail.iter().rev() {
                base.push(part);
            }
            return base;
        }
    }
    p.to_path_buf()
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// The protected roots, resolved once. Includes the running executable's folder (the install
/// folder for an installed build, the build output for a development run) and the default
/// per-user install location, so a development build also protects an installed copy.
fn default_roots() -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = Vec::new();
    if let Some(d) = env_dir("APPDATA") {
        raw.push(d.join(IDENTIFIER));
    }
    if let Some(d) = env_dir("LOCALAPPDATA") {
        raw.push(d.join(IDENTIFIER));
        raw.push(d.join(PRODUCT));
        raw.push(d.join("Programs").join(PRODUCT));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            raw.push(dir.to_path_buf());
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for r in raw {
        let c = lenient_canonical(&r);
        if !out.iter().any(|o| same(o, &c)) {
            out.push(c);
        }
    }
    out
}

fn roots() -> &'static [PathBuf] {
    static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    ROOTS.get_or_init(default_roots)
}

/// A comparable form: the drive letter (verbatim or not) and each component, lower-cased.
fn key(p: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => match pre.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                    out.push(format!("{}:", (d as char).to_ascii_lowercase()));
                }
                _ => out.push(pre.as_os_str().to_string_lossy().to_lowercase()),
            },
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => out.push("..".to_string()),
            Component::Normal(n) => out.push(n.to_string_lossy().to_lowercase()),
        }
    }
    out
}

fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

fn inside(path: &[String], root: &[String]) -> bool {
    path.len() >= root.len() && path[..root.len()] == root[..]
}

/// Is this (already resolved) path inside one of `roots`, or one of them itself?
pub(crate) fn is_protected_in(path: &Path, roots: &[PathBuf]) -> bool {
    let p = key(path);
    roots.iter().any(|r| inside(&p, &key(r)))
}

/// Does this (already resolved) path contain one of `roots`, or equal one? Changing such a path
/// (rename, move, delete, attributes) changes where the protected folder is or whether it is.
pub(crate) fn swallows_in(path: &Path, roots: &[PathBuf]) -> bool {
    let p = key(path);
    roots.iter().any(|r| inside(&key(r), &p))
}

/// Inside Atlas's own folders (or one of them). Expects a resolved path.
pub(crate) fn is_protected(resolved: &Path) -> bool {
    is_protected_in(resolved, roots())
}

/// Contains or equals one of Atlas's own folders. Expects a resolved path.
pub(crate) fn swallows_protected(resolved: &Path) -> bool {
    swallows_in(resolved, roots())
}

/// The same question for a path that has not been resolved (a directory walker's entries): the
/// path is resolved as far as it exists, then compared.
pub(crate) fn is_protected_lenient(p: &Path) -> bool {
    is_protected(&lenient_canonical(p))
}

/// Every name this *file* has on its volume, if it has more than one. `None` for a folder, a
/// file with one name, or anything that cannot be asked.
#[cfg(windows)]
fn other_names(resolved: &Path) -> Option<Vec<PathBuf>> {
    use std::os::windows::io::AsRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FindClose, FindFirstFileNameW, FindNextFileNameW, GetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION,
    };

    if !resolved.is_file() {
        return None;
    }
    let file = std::fs::File::open(resolved).ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is valid for the lifetime of `file`, `info` is a plain out-struct.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle() as _), &mut info).ok()? };
    if info.nNumberOfLinks <= 1 {
        return None;
    }
    let prefix = resolved.components().next().map(|c| PathBuf::from(c.as_os_str()))?;
    let wide: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        resolved.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    };
    let mut names = Vec::new();
    let mut buf = vec![0u16; 32768];
    let mut len = buf.len() as u32;
    // SAFETY: `wide` is NUL-terminated and `buf`/`len` describe a writable buffer.
    unsafe {
        let Ok(h) = FindFirstFileNameW(
            PCWSTR(wide.as_ptr()),
            0,
            &mut len,
            windows::core::PWSTR(buf.as_mut_ptr()),
        ) else {
            return Some(names);
        };
        loop {
            let n = (len as usize).saturating_sub(1).min(buf.len());
            let name = String::from_utf16_lossy(&buf[..n]);
            let mut full = prefix.clone();
            full.push(name.trim_start_matches('\\'));
            names.push(full);
            len = buf.len() as u32;
            if FindNextFileNameW(h, &mut len, windows::core::PWSTR(buf.as_mut_ptr())).is_err() {
                break;
            }
        }
        let _ = FindClose(h);
    }
    Some(names)
}

#[cfg(not(windows))]
fn other_names(_resolved: &Path) -> Option<Vec<PathBuf>> {
    None
}

/// Is this file also reachable under a name inside a protected folder?
pub(crate) fn hard_linked_into(resolved: &Path, roots: &[PathBuf]) -> bool {
    other_names(resolved)
        .map(|names| names.iter().any(|n| is_protected_in(n, roots)))
        .unwrap_or(false)
}

pub(crate) fn hard_linked_into_protected(resolved: &Path) -> bool {
    hard_linked_into(resolved, roots())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("atlas-protected-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Scratch(d.canonicalize().unwrap())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink /J failed: {made:?}");
    }

    #[test]
    fn a_path_inside_a_protected_folder_is_protected_and_the_folder_itself_is() {
        let s = Scratch::new("inside");
        let root = s.0.join("dev.atlas.assistant");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("storage.json");
        std::fs::write(&file, "{}").unwrap();
        let roots = vec![root.clone()];
        assert!(is_protected_in(&file, &roots));
        assert!(is_protected_in(&root, &roots));
        assert!(is_protected_in(&root.join("deeper").join("x"), &roots));
    }

    #[test]
    fn a_sibling_with_the_same_prefix_is_not_protected() {
        let s = Scratch::new("sibling");
        let root = s.0.join("dev.atlas.assistant");
        let evil = s.0.join("dev.atlas.assistant-evil");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        assert!(!is_protected_in(&evil, &[root.clone()]));
        assert!(!is_protected_in(&s.0, &[root]));
    }

    #[test]
    fn comparison_ignores_case() {
        let s = Scratch::new("case");
        let root = s.0.join("Dev.Atlas.Assistant");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = PathBuf::from(root.to_string_lossy().to_uppercase()).join("STORAGE.JSON");
        assert!(is_protected_in(&spelled, &[root]));
    }

    #[test]
    fn a_folder_that_contains_a_protected_one_cannot_be_changed() {
        let s = Scratch::new("swallow");
        let roaming = s.0.join("Roaming");
        let root = roaming.join("dev.atlas.assistant");
        std::fs::create_dir_all(&root).unwrap();
        let roots = vec![root.clone()];
        assert!(swallows_in(&roaming, &roots), "the parent holds it");
        assert!(swallows_in(&s.0, &roots), "so does the grandparent");
        assert!(swallows_in(&root, &roots), "and the folder itself");
        assert!(!swallows_in(&roaming.join("other"), &roots));
        assert!(!swallows_in(&root.join("inner"), &roots), "a child is protected, not swallowing");
    }

    #[test]
    fn dot_dot_and_a_junction_resolve_before_they_are_compared() {
        let s = Scratch::new("resolve");
        let root = s.0.join("dev.atlas.assistant");
        let open = s.0.join("Documents");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&open).unwrap();
        std::fs::write(root.join("storage.json"), "{}").unwrap();
        let roots = vec![root.clone()];

        // `..` from an unprotected folder lands inside the protected one.
        let climbed = open.join("..").join("dev.atlas.assistant").join("storage.json");
        assert!(is_protected_in(&climbed.canonicalize().unwrap(), &roots));

        // A junction in an unprotected folder that points at it.
        let link = open.join("shortcut");
        junction(&link, &root);
        let through = link.join("storage.json");
        assert!(is_protected_in(&through.canonicalize().unwrap(), &roots));
        // The spelling is not what decides: unresolved, it would have looked unprotected.
        assert!(!is_protected_in(&through, &roots));
        let _ = std::fs::remove_dir(&link);
    }

    #[test]
    fn a_folder_that_does_not_exist_yet_is_still_recognised() {
        let s = Scratch::new("lenient");
        let later = s.0.join("not-yet").join("updates");
        let resolved = lenient_canonical(&later);
        assert!(resolved.starts_with(&s.0));
        assert!(is_protected_in(&resolved.join("installer.exe"), &[resolved.clone()]));
    }

    #[test]
    fn a_hard_link_to_a_protected_file_is_protected_under_its_other_name() {
        let s = Scratch::new("hardlink");
        let root = s.0.join("dev.atlas.assistant");
        let open = s.0.join("Documents");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&open).unwrap();
        let secret = root.join("storage.json");
        std::fs::write(&secret, "{\"token\":\"x\"}").unwrap();
        let alias = open.join("notes.txt");
        std::fs::hard_link(&secret, &alias).unwrap();
        let roots = vec![root.clone()];

        // By name it looks harmless; by identity it is the protected file.
        assert!(!is_protected_in(&alias, &roots));
        assert!(hard_linked_into(&alias.canonicalize().unwrap(), &roots));
        // An ordinary file with one name is not.
        let plain = open.join("plain.txt");
        std::fs::write(&plain, "x").unwrap();
        assert!(!hard_linked_into(&plain.canonicalize().unwrap(), &roots));
    }

    #[test]
    fn the_default_roots_cover_app_data_local_data_and_the_install_folder() {
        let r = default_roots();
        assert!(!r.is_empty());
        if let Some(a) = env_dir("APPDATA") {
            assert!(is_protected_in(&a.join(IDENTIFIER).join("storage.json"), &r));
            assert!(!is_protected_in(&a.join("SomeOtherApp").join("x"), &r));
        }
        if let Some(l) = env_dir("LOCALAPPDATA") {
            assert!(is_protected_in(&l.join(IDENTIFIER).join("updates").join("a.exe"), &r));
            assert!(is_protected_in(&l.join(PRODUCT).join("Atlas.exe"), &r));
        }
        let exe = std::env::current_exe().unwrap();
        assert!(is_protected_in(&exe, &r), "the running executable's own folder");
    }

    /// The real thing, read-only: the paths this machine actually uses, asked through the same
    /// gate every file command uses. Nothing is created or opened for writing.
    #[test]
    fn the_real_store_and_install_folder_are_refused_by_the_file_gate() {
        let gate = crate::allowed_folders::is_permitted;
        if let Some(a) = env_dir("APPDATA") {
            let store = a.join(IDENTIFIER).join("storage.json");
            if store.exists() {
                assert!(!gate(&store), "storage.json must not be reachable by a file command");
                assert!(!gate(store.parent().unwrap()), "nor its folder");
            }
        }
        if let Some(l) = env_dir("LOCALAPPDATA") {
            let updates = l.join(IDENTIFIER);
            if updates.exists() {
                assert!(!gate(&updates));
            }
        }
        let exe = std::env::current_exe().unwrap();
        assert!(!gate(&exe), "the running program's own file");
    }
}
