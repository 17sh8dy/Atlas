//! Making new things from existing ones, from the tool-catalog pass: duplicate a file
//! or folder, and create a shortcut (a `.lnk` to a file or folder, or a `.url` to a
//! web page).
//!
//! Both only ever create something NEW. A duplicate takes a free name ("notes - Copy",
//! "notes - Copy (2)"); a shortcut likewise. Nothing is overwritten, nothing is deleted,
//! and every path has to be inside the folders Atlas may touch.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use walkdir::WalkDir;

use crate::platform::{is_permitted, plain_path};

const MAX_ENTRIES: usize = 100_000;
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const COPY_TIME: Duration = Duration::from_secs(120);

fn permitted(p: &Path) -> Result<(), String> {
    if is_permitted(p) {
        Ok(())
    } else {
        Err("That path is outside the folders Atlas can touch.".into())
    }
}

/// `stem - Copy.ext`, `stem - Copy (2).ext`, … — the first that does not exist.
fn free_copy_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    (1u32..)
        .map(|n| {
            let tag = if n == 1 { " - Copy".to_string() } else { format!(" - Copy ({n})") };
            dir.join(if ext.is_empty() { format!("{stem}{tag}") } else { format!("{stem}{tag}.{ext}") })
        })
        .find(|p| !p.exists())
        .unwrap()
}

/// `stem.ext`, `stem (2).ext`, … — the first that does not exist.
fn free_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    (1u32..)
        .map(|n| {
            let base = if n == 1 { stem.to_string() } else { format!("{stem} ({n})") };
            dir.join(if ext.is_empty() { base } else { format!("{base}.{ext}") })
        })
        .find(|p| !p.exists())
        .unwrap()
}

// ---- duplicate -------------------------------------------------------------------------

fn duplicate_blocking(path: &str) -> Result<String, String> {
    let src = PathBuf::from(path);
    permitted(&src)?;
    let meta = fs::symlink_metadata(&src).map_err(|_| "That doesn't exist.".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("That is a link, not a file or folder — I won't copy through it.".into());
    }
    let dir = src.parent().ok_or("That has no folder to copy into.")?;
    permitted(dir)?;
    let name = src.file_name().and_then(|n| n.to_str()).ok_or("That has no name.")?;

    if meta.is_file() {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s, e),
            _ => (name, ""),
        };
        let out = free_copy_name(dir, stem, ext);
        fs::copy(&src, &out).map_err(|e| format!("I couldn't copy it: {e}"))?;
        return Ok(plain_path(&out));
    }

    // A folder: count and size it first, so a huge one is refused before anything is written.
    let started = Instant::now();
    let (mut entries, mut bytes) = (0usize, 0u64);
    for e in WalkDir::new(&src).follow_links(false).into_iter().filter_map(Result::ok) {
        entries += 1;
        bytes += e.metadata().map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0);
        if entries > MAX_ENTRIES || bytes > MAX_BYTES || started.elapsed() > COPY_TIME {
            return Err("That folder is too big for me to copy (over 100,000 items or 4 GB).".into());
        }
    }
    let out = free_copy_name(dir, name, "");
    // Never copy a folder into itself.
    if out.starts_with(&src) {
        return Err("I can't copy a folder into itself.".into());
    }
    let result = (|| -> Result<(), String> {
        for e in WalkDir::new(&src).follow_links(false).into_iter().filter_map(Result::ok) {
            if crate::halt::global().check().is_err() {
                return Err("Stopped.".into());
            }
            if started.elapsed() > COPY_TIME * 2 {
                return Err("Copying took too long, so I stopped.".into());
            }
            let rel = e.path().strip_prefix(&src).map_err(|e| e.to_string())?;
            let target = out.join(rel);
            let ft = e.file_type();
            if ft.is_dir() {
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            } else if ft.is_file() {
                fs::copy(e.path(), &target).map_err(|e| format!("I couldn't copy {}: {e}", e.to_string()))?;
            }
            // Links inside it are skipped, not followed.
        }
        Ok(())
    })();
    if let Err(e) = result {
        // A half-made copy is worse than none.
        let _ = fs::remove_dir_all(&out);
        return Err(e);
    }
    Ok(plain_path(&out))
}

/// Make a copy of a file or folder beside it ("X - Copy"). Returns the new path.
#[tauri::command]
pub async fn duplicate_path(path: String) -> Result<String, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || duplicate_blocking(&path))
        .await
        .map_err(|e| format!("Copying failed: {e}"))?
}

// ---- shortcuts -------------------------------------------------------------------------

fn clean_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !c.is_control()).collect();
    n.trim().trim_end_matches('.').to_string()
}

fn lnk_blocking(target: &str, dir: &str, name: Option<&str>) -> Result<String, String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let target_path = PathBuf::from(target);
    let dest_dir = PathBuf::from(dir);
    permitted(&target_path)?;
    permitted(&dest_dir)?;
    if !target_path.exists() {
        return Err("What it would point at doesn't exist.".into());
    }
    if !dest_dir.is_dir() {
        return Err("That isn't a folder to put it in.".into());
    }
    let base = name
        .map(clean_name)
        .filter(|n| !n.is_empty())
        .or_else(|| target_path.file_stem().map(|s| clean_name(&s.to_string_lossy())))
        .filter(|n| !n.is_empty())
        .ok_or("It needs a name.")?;
    let out = free_name(&dest_dir, &format!("{base}{}", if target_path.is_dir() { "" } else { "" }), "lnk");

    let work = if target_path.is_dir() { target_path.clone() } else { target_path.parent().map(Path::to_path_buf).unwrap_or_default() };
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> windows::core::Result<()> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(target_path.as_os_str()))?;
            link.SetWorkingDirectory(&HSTRING::from(work.as_os_str()))?;
            let file: IPersistFile = link.cast()?;
            file.Save(&HSTRING::from(out.as_os_str()), true)
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        result.map_err(|e| format!("I couldn't make the shortcut: {}", e.message()))?;
    }
    if !out.is_file() {
        return Err("The shortcut wasn't created.".into());
    }
    Ok(plain_path(&out))
}

/// A `.lnk` to an existing file or folder, in `dir`. Returns its path.
#[tauri::command]
pub async fn create_shortcut(target: String, dir: String, name: Option<String>) -> Result<String, String> {
    crate::halt::global().check()?;
    tauri::async_runtime::spawn_blocking(move || lnk_blocking(&target, &dir, name.as_deref()))
        .await
        .map_err(|e| format!("Making the shortcut failed: {e}"))?
}

/// A `.url` internet shortcut to an http(s) page, in `dir`. Returns its path.
#[tauri::command]
pub fn create_url_shortcut(url: String, name: String, dir: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.len() > 2000 || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("A web shortcut needs an http or https address.".into());
    }
    let dest = PathBuf::from(&dir);
    permitted(&dest)?;
    if !dest.is_dir() {
        return Err("That isn't a folder to put it in.".into());
    }
    let base = clean_name(&name);
    if base.is_empty() {
        return Err("It needs a name.".into());
    }
    let out = free_name(&dest, &base, "url");
    fs::write(&out, format!("[InternetShortcut]\r\nURL={url}\r\n")).map_err(|e| e.to_string())?;
    Ok(plain_path(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("atlas-make-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn copy_names_never_collide() {
        let d = temp("names");
        fs::write(d.join("a.txt"), b"x").unwrap();
        assert_eq!(free_copy_name(&d, "a", "txt"), d.join("a - Copy.txt"));
        fs::write(d.join("a - Copy.txt"), b"x").unwrap();
        assert_eq!(free_copy_name(&d, "a", "txt"), d.join("a - Copy (2).txt"));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("a/b:c*d?.."), "abcd");
        assert_eq!(clean_name("  Docs  "), "Docs");
    }

    #[test]
    fn urls_must_be_web_addresses() {
        assert!(create_url_shortcut("file:///C:/x".into(), "x".into(), "C:\\".into()).is_err());
        assert!(create_url_shortcut("javascript:alert(1)".into(), "x".into(), "C:\\".into()).is_err());
        assert!(create_url_shortcut("https://a b".into(), "x".into(), "C:\\".into()).is_err());
    }

    /// Live (profile-relative temp): duplicate a folder tree, then make a .lnk and a .url.
    #[test]
    fn duplicates_a_folder_and_makes_shortcuts() {
        let d = temp("live");
        if !is_permitted(&d) {
            eprintln!("temp is outside the allowed roots; skipping");
            return;
        }
        let src = d.join("proj");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"one").unwrap();
        fs::write(src.join("sub").join("b.txt"), b"two").unwrap();
        let copy = duplicate_blocking(&src.to_string_lossy()).unwrap();
        assert!(copy.ends_with("proj - Copy"), "{copy}");
        assert_eq!(fs::read(Path::new(&copy).join("sub").join("b.txt")).unwrap(), b"two");
        let again = duplicate_blocking(&src.to_string_lossy()).unwrap();
        assert!(again.ends_with("proj - Copy (2)"), "{again}");
        assert!(src.join("a.txt").is_file());

        let lnk = lnk_blocking(&src.to_string_lossy(), &d.to_string_lossy(), Some("My Project")).unwrap();
        assert!(lnk.ends_with("My Project.lnk") && Path::new(&lnk).is_file());
        let lnk2 = lnk_blocking(&src.to_string_lossy(), &d.to_string_lossy(), Some("My Project")).unwrap();
        assert!(lnk2.ends_with("My Project (2).lnk"));
        let url = create_url_shortcut("https://example.com/x".into(), "Example".into(), d.to_string_lossy().into_owned()).unwrap();
        assert_eq!(fs::read_to_string(&url).unwrap(), "[InternetShortcut]\r\nURL=https://example.com/x\r\n");
        let _ = fs::remove_dir_all(d);
    }
}
