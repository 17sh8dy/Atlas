//! Installing, removing and updating apps with winget (Windows Package Manager).
//!
//! `winget.exe` is run by its own path with **fixed arguments**; the only free
//! value is a package id, checked to letters, digits and `. _ + -`. There is no
//! way to pass a flag, a source URL or a second argument through any of these.
//! Installers raise Windows' own permission prompt when they need one — Atlas
//! never answers it (see `input_guard.rs`).
//!
//! When winget is not installed the error says so; nothing is attempted.

#![cfg(windows)]

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct WingetPackage {
    pub name: String,
    pub id: String,
    pub version: String,
}

fn find_winget() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft/WindowsApps"));
    }
    dirs.into_iter().map(|d| d.join("winget.exe")).find(|p| p.is_file())
}

/// A package id: `Spotify.Spotify`, `Microsoft.VisualStudioCode`, `7zip.7zip`.
fn is_package_id(s: &str) -> bool {
    s.len() >= 2
        && s.len() <= 100
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

/// A search term: short, plain words — it is only ever handed to `winget search`.
fn is_search_term(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty()
        && t.len() <= 60
        && !t.starts_with('-')
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '+' | '-'))
}

/// winget prints a fixed-width table: a header, a rule of dashes, then rows. Column
/// starts come from the header, so names with spaces survive.
pub fn parse_table(text: &str) -> Vec<WingetPackage> {
    let lines: Vec<&str> = text.lines().collect();
    let Some(h) = lines.iter().position(|l| l.trim_start().starts_with("Name") && l.contains("Id")) else {
        return Vec::new();
    };
    let header = lines[h];
    let id_at = header.find("Id").unwrap_or(0);
    let ver_at = header.find("Version").unwrap_or(header.len());
    let mut out = Vec::new();
    for line in lines.iter().skip(h + 1) {
        if line.trim().is_empty() || line.trim_start().starts_with("---") {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let take = |from: usize, to: usize| -> String {
            chars.iter().skip(from).take(to.saturating_sub(from)).collect::<String>().trim().to_string()
        };
        let name = take(0, id_at);
        let id = take(id_at, ver_at);
        let rest = take(ver_at, chars.len());
        let version = rest.split_whitespace().next().unwrap_or("").to_string();
        if !name.is_empty() && is_package_id(&id) {
            out.push(WingetPackage { name, id, version });
        }
    }
    out
}

fn run(args: &[&str]) -> Result<(bool, String), String> {
    use std::os::windows::process::CommandExt;
    let exe = find_winget().ok_or("winget isn't installed on this PC (it comes with the App Installer from the Microsoft Store), so I can't install or update apps.")?;
    let mut cmd = Command::new(exe);
    cmd.args(args).creation_flags(0x0800_0000);
    let out = crate::halt::global()
        .run(cmd)
        .map_err(|e| crate::halt::describe(&e, || format!("I couldn't run winget: {e}")))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Ok((out.status.success(), text))
}

fn tail(text: &str) -> String {
    text.lines().filter(|l| !l.trim().is_empty()).rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

#[tauri::command(async)]
pub fn winget_search(query: String) -> Result<Vec<WingetPackage>, String> {
    crate::halt::global().check()?;
    if !is_search_term(&query) {
        return Err("That doesn't look like an app name.".into());
    }
    let (_ok, text) = run(&["search", query.trim(), "--accept-source-agreements", "--count", "8"])?;
    Ok(parse_table(&text))
}

#[tauri::command(async)]
pub fn winget_install(id: String) -> Result<String, String> {
    crate::halt::global().check()?;
    if !is_package_id(&id) {
        return Err("That isn't a package id I'll pass to winget.".into());
    }
    let (ok, text) = run(&[
        "install", "--id", &id, "--exact", "--silent", "--disable-interactivity",
        "--accept-package-agreements", "--accept-source-agreements",
    ])?;
    if ok { Ok(tail(&text)) } else { Err(format!("winget couldn't install it.\n{}", tail(&text))) }
}

#[tauri::command(async)]
pub fn winget_uninstall(id: String) -> Result<String, String> {
    crate::halt::global().check()?;
    if !is_package_id(&id) {
        return Err("That isn't a package id I'll pass to winget.".into());
    }
    let (ok, text) = run(&["uninstall", "--id", &id, "--exact", "--silent", "--disable-interactivity"])?;
    if ok { Ok(tail(&text)) } else { Err(format!("winget couldn't remove it.\n{}", tail(&text))) }
}

#[tauri::command(async)]
pub fn winget_upgrade(id: String) -> Result<String, String> {
    crate::halt::global().check()?;
    if !is_package_id(&id) {
        return Err("That isn't a package id I'll pass to winget.".into());
    }
    let (ok, text) = run(&[
        "upgrade", "--id", &id, "--exact", "--silent", "--disable-interactivity",
        "--accept-package-agreements", "--accept-source-agreements",
    ])?;
    if ok { Ok(tail(&text)) } else { Err(format!("winget couldn't update it.\n{}", tail(&text))) }
}

/// Apps winget knows a newer version of.
#[tauri::command(async)]
pub fn winget_upgrades() -> Result<Vec<WingetPackage>, String> {
    crate::halt::global().check()?;
    let (_ok, text) = run(&["upgrade", "--accept-source-agreements"])?;
    Ok(parse_table(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Name                       Id                         Version   Match        Source\r
-----------------------------------------------------------------------------------\r
Spotify                    Spotify.Spotify            1.2.52    Tag: spotify winget\r
Spotify Premium Toolkit    Some.SpotifyToolkit        0.9       Tag: spotify winget\r
";

    #[test]
    fn a_real_looking_table_is_read_with_names_that_have_spaces() {
        let rows = parse_table(SAMPLE);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], WingetPackage { name: "Spotify".into(), id: "Spotify.Spotify".into(), version: "1.2.52".into() });
        assert_eq!(rows[1].name, "Spotify Premium Toolkit");
        assert_eq!(rows[1].id, "Some.SpotifyToolkit");
    }

    #[test]
    fn noise_and_empty_output_give_no_rows_not_a_crash() {
        assert!(parse_table("").is_empty());
        assert!(parse_table("No package found matching input criteria.").is_empty());
        assert!(parse_table("Name Id\n---\n   \n").is_empty());
    }

    #[test]
    fn only_plain_ids_and_search_terms_get_through() {
        for ok in ["Spotify.Spotify", "7zip.7zip", "Microsoft.VisualStudioCode", "Notepad++.Notepad++"] {
            assert!(is_package_id(ok), "{ok}");
        }
        for bad in ["", "a", "-x", "--source", "a b", "a;b", "a&b", "a|b", "a\"b", "../x", "x\\y", "a$b", &"x".repeat(101)] {
            assert!(!is_package_id(bad), "{bad}");
        }
        assert!(is_search_term("visual studio code"));
        assert!(!is_search_term("--help"));
        assert!(!is_search_term("a;b"));
        assert!(!is_search_term(&"x".repeat(61)));
    }

    #[test]
    fn a_bad_id_is_refused_before_winget_is_looked_for() {
        assert!(winget_install("--source evil".into()).is_err());
        assert!(winget_uninstall("a;b".into()).is_err());
        assert!(winget_upgrade("".into()).is_err());
    }

    #[test]
    fn live_without_winget_says_so() {
        if find_winget().is_none() {
            let e = winget_search("spotify".into()).unwrap_err();
            assert!(e.contains("winget isn't installed"), "{e}");
        }
    }
}
