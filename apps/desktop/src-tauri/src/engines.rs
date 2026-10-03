//! Which game engines are on this PC, and the folder plugins live in.
//!
//! Both are read-only discovery. Nothing here starts an engine or changes a file outside Atlas's
//! own data folder: [`game_engines`] looks at the places each engine registers itself (the
//! registry, the Epic launcher's install list, the usual folders) and reports what is really
//! there, and [`plugin_manifests`] hands the plugin folders' `plugin.json` text to the app, which
//! validates it strictly (see `packages/engine/src/plugins/manifest.ts`). A plugin is data, never
//! code: nothing in a plugin folder is ever executed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineInfo {
    /// "unreal" | "unity" | "godot"
    pub kind: String,
    /// "5.7", "6000.0.23f1", "4.3"
    pub version: String,
    /// The install folder (Unreal, Unity) or the folder holding the executable (Godot).
    pub path: String,
    /// The editor executable that exists on disk.
    pub editor: String,
}

fn text(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

// ---------------------------------------------------------------- Unreal

const UNREAL_EDITOR: &[&str] = &["Engine", "Binaries", "Win64", "UnrealEditor.exe"];

fn unreal_at(version: &str, dir: &Path) -> Option<EngineInfo> {
    let mut editor = dir.to_path_buf();
    for part in UNREAL_EDITOR {
        editor.push(part);
    }
    editor.is_file().then(|| EngineInfo {
        kind: "unreal".into(),
        version: version.to_string(),
        path: text(dir),
        editor: text(&editor),
    })
}

/// `("5.7", "D:\\Games\\Epic Games\\UE_5.7")` pairs from the Epic launcher's install list.
fn launcher_installs(json: &str) -> Vec<(String, String)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    v.get("InstallationList")
        .and_then(|l| l.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let name = item.get("AppName")?.as_str()?;
                    let dir = item.get("InstallLocation")?.as_str()?;
                    let version = name.strip_prefix("UE_")?;
                    Some((version.to_string(), dir.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn unreal_engines() -> Vec<EngineInfo> {
    let mut out = Vec::new();

    // Launcher installs register under HKLM\SOFTWARE\EpicGames\Unreal Engine\<version>.
    if let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(r"SOFTWARE\EpicGames\Unreal Engine", KEY_READ) {
        for version in root.enum_keys().flatten() {
            if let Ok(key) = root.open_subkey_with_flags(&version, KEY_READ) {
                if let Ok(dir) = key.get_value::<String, _>("InstalledDirectory") {
                    out.extend(unreal_at(&version, Path::new(&dir)));
                }
            }
        }
    }
    // Builds from source register under HKCU, by a GUID.
    if let Ok(builds) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Software\Epic Games\Unreal Engine\Builds", KEY_READ) {
        for (guid, value) in builds.enum_values().flatten() {
            let dir = value.to_string();
            out.extend(unreal_at(&format!("source build {guid}"), Path::new(dir.trim_matches('"'))));
        }
    }
    // The launcher's own install list, for installs the registry does not mention.
    let program_data = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    if let Ok(json) = fs::read_to_string(program_data.join(r"Epic\UnrealEngineLauncher\LauncherInstalled.dat")) {
        for (version, dir) in launcher_installs(&json) {
            out.extend(unreal_at(&version, Path::new(&dir)));
        }
    }
    out
}

// ---------------------------------------------------------------- Unity

/// Unity Hub keeps editors as `<root>\<version>\Editor\Unity.exe`.
fn scan_unity(root: &Path) -> Vec<EngineInfo> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            let editor = dir.join("Editor").join("Unity.exe");
            editor.is_file().then(|| EngineInfo {
                kind: "unity".into(),
                version: e.file_name().to_string_lossy().to_string(),
                path: text(&dir),
                editor: text(&editor),
            })
        })
        .collect()
}

fn unity_engines() -> Vec<EngineInfo> {
    let mut roots = vec![PathBuf::from(r"C:\Program Files\Unity\Hub\Editor")];
    // A second install location the person chose in Unity Hub.
    if let Some(appdata) = std::env::var_os("APPDATA") {
        if let Ok(s) = fs::read_to_string(PathBuf::from(appdata).join(r"UnityHub\secondaryInstallPath.json")) {
            let p = s.trim().trim_matches('"').replace("\\\\", "\\");
            if !p.is_empty() {
                roots.push(PathBuf::from(p));
            }
        }
    }
    roots.iter().flat_map(|r| scan_unity(r)).collect()
}

// ---------------------------------------------------------------- Godot

/// "Godot_v4.3-stable_win64.exe" -> "4.3"; anything else -> "".
fn godot_version(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    let Some(rest) = lower.strip_prefix("godot_v") else { return String::new() };
    rest.split(|c: char| !(c.is_ascii_digit() || c == '.')).next().unwrap_or("").trim_end_matches('.').to_string()
}

/// Godot ships as a single exe. The "_console" copy is the same editor with a terminal; the plain
/// one is the editor to open.
fn scan_godot(dir: &Path) -> Vec<EngineInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            (lower.starts_with("godot") && lower.ends_with(".exe") && !lower.contains("_console") && e.path().is_file()).then(|| EngineInfo {
                kind: "godot".into(),
                version: godot_version(&name),
                path: text(dir),
                editor: text(&e.path()),
            })
        })
        .collect()
}

fn godot_engines() -> Vec<EngineInfo> {
    let mut dirs: Vec<PathBuf> = vec![PathBuf::from(r"C:\Program Files\Godot"), PathBuf::from(r"C:\Program Files (x86)\Godot")];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join(r"Programs\Godot"));
        // winget installs here, one folder per package.
        if let Ok(pkgs) = fs::read_dir(local.join(r"Microsoft\WinGet\Packages")) {
            for p in pkgs.flatten() {
                if p.file_name().to_string_lossy().to_lowercase().contains("godot") {
                    dirs.push(p.path());
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        dirs.push(home.join(r"scoop\apps\godot\current"));
        dirs.push(home.join("Godot"));
    }
    // Anything on PATH.
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path).filter(|p| p.to_string_lossy().to_lowercase().contains("godot")));
    }
    dirs.iter().flat_map(|d| scan_godot(d)).collect()
}

// ---------------------------------------------------------------- the command

fn dedupe(mut list: Vec<EngineInfo>) -> Vec<EngineInfo> {
    let mut seen = std::collections::HashSet::new();
    list.retain(|e| seen.insert(e.editor.to_lowercase()));
    list.sort_by(|a, b| (&a.kind, &b.version).cmp(&(&b.kind, &a.version)));
    list
}

/// Every game engine editor found on this PC. Read-only.
#[tauri::command]
pub fn game_engines() -> Vec<EngineInfo> {
    let mut all = unreal_engines();
    all.extend(unity_engines());
    all.extend(godot_engines());
    dedupe(all)
}

// ---------------------------------------------------------------- plugins

const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PLUGIN_FOLDERS: usize = 50;

#[derive(Debug, Serialize)]
pub struct PluginFolder {
    /// The folder's name, which is the plugin's id by convention.
    pub folder: String,
    /// The text of plugin.json, if it could be read.
    pub json: Option<String>,
    /// Why it could not be read.
    pub error: Option<String>,
}

fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("plugins"))
}

fn read_plugin_folders(dir: &Path) -> Vec<PluginFolder> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut folders: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    folders.sort();
    folders
        .into_iter()
        .take(MAX_PLUGIN_FOLDERS)
        .map(|p| {
            let folder = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let manifest = p.join("plugin.json");
            match fs::metadata(&manifest) {
                Err(_) => PluginFolder { folder, json: None, error: Some("There is no plugin.json in this folder.".into()) },
                Ok(m) if m.len() > MAX_MANIFEST_BYTES => PluginFolder { folder, json: None, error: Some("plugin.json is larger than 4 MB.".into()) },
                Ok(_) => match fs::read_to_string(&manifest) {
                    Ok(json) => PluginFolder { folder, json: Some(json), error: None },
                    Err(_) => PluginFolder { folder, json: None, error: Some("plugin.json is not readable text.".into()) },
                },
            }
        })
        .collect()
}

/// The plugin.json of every folder under Atlas's plugins folder, unparsed.
#[tauri::command]
pub fn plugin_manifests(app: tauri::AppHandle) -> Result<Vec<PluginFolder>, String> {
    Ok(read_plugin_folders(&plugins_dir(&app)?))
}

/// Open the plugins folder in Explorer, making it first if it is not there yet.
#[tauri::command]
pub fn open_plugins_folder(app: tauri::AppHandle) -> Result<String, String> {
    crate::halt::global().check()?;
    let dir = plugins_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that(&dir).map_err(|e| e.to_string())?;
    Ok(text(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("atlas-engines-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_launcher_install_list_gives_versions_and_folders() {
        let json = r#"{"InstallationList":[
            {"InstallLocation":"D:\\Games\\Epic Games\\UE_5.7","AppName":"UE_5.7"},
            {"InstallLocation":"D:\\Games\\Epic Games\\Fortnite","AppName":"Fortnite"},
            {"InstallLocation":"E:\\UE\\4.27","AppName":"UE_4.27"}]}"#;
        assert_eq!(
            launcher_installs(json),
            vec![("5.7".to_string(), r"D:\Games\Epic Games\UE_5.7".to_string()), ("4.27".to_string(), r"E:\UE\4.27".to_string())]
        );
        assert!(launcher_installs("not json").is_empty());
        assert!(launcher_installs("{}").is_empty());
    }

    #[test]
    fn unreal_counts_only_when_the_editor_is_really_there() {
        let root = temp("ue");
        assert!(unreal_at("5.7", &root).is_none());
        let bin = root.join(r"Engine\Binaries\Win64");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("UnrealEditor.exe"), b"x").unwrap();
        let found = unreal_at("5.7", &root).unwrap();
        assert_eq!((found.kind.as_str(), found.version.as_str()), ("unreal", "5.7"));
        assert!(found.editor.ends_with("UnrealEditor.exe"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unity_editors_are_found_by_version_folder() {
        let root = temp("unity");
        for v in ["2022.3.10f1", "6000.0.23f1"] {
            fs::create_dir_all(root.join(v).join("Editor")).unwrap();
            fs::write(root.join(v).join("Editor").join("Unity.exe"), b"x").unwrap();
        }
        fs::create_dir_all(root.join("empty")).unwrap();
        let mut versions: Vec<String> = scan_unity(&root).into_iter().map(|e| e.version).collect();
        versions.sort();
        assert_eq!(versions, vec!["2022.3.10f1", "6000.0.23f1"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn godot_is_found_by_its_exe_and_the_console_copy_is_skipped() {
        let root = temp("godot");
        fs::write(root.join("Godot_v4.3-stable_win64.exe"), b"x").unwrap();
        fs::write(root.join("Godot_v4.3-stable_win64_console.exe"), b"x").unwrap();
        fs::write(root.join("readme.txt"), b"x").unwrap();
        let found = scan_godot(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].version, "4.3");
        assert_eq!(godot_version("Godot_v4.4.1-stable_win64.exe"), "4.4.1");
        assert_eq!(godot_version("godot.exe"), "");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_editor_reported_twice_is_listed_once() {
        let e = |p: &str| EngineInfo { kind: "unreal".into(), version: "5.7".into(), path: "x".into(), editor: p.into() };
        assert_eq!(dedupe(vec![e(r"D:\UE\Editor.exe"), e(r"d:\ue\editor.exe")]).len(), 1);
    }

    #[test]
    fn plugin_folders_are_read_unparsed_and_problems_are_named() {
        let root = temp("plugins");
        fs::create_dir_all(root.join("good")).unwrap();
        fs::write(root.join("good").join("plugin.json"), r#"{"id":"good"}"#).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(root.join("loose-file.txt"), b"x").unwrap();
        let found = read_plugin_folders(&root);
        assert_eq!(found.len(), 2, "files at the top level are not plugins");
        let good = found.iter().find(|f| f.folder == "good").unwrap();
        assert_eq!(good.json.as_deref(), Some(r#"{"id":"good"}"#));
        let empty = found.iter().find(|f| f.folder == "empty").unwrap();
        assert!(empty.error.as_deref().unwrap().contains("no plugin.json"));
        assert!(read_plugin_folders(&root.join("missing")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    /// Real machine: whatever is installed must be consistent (every editor exists).
    #[test]
    fn whatever_is_found_on_this_pc_really_exists() {
        for e in game_engines() {
            assert!(Path::new(&e.editor).is_file(), "{} is listed but missing", e.editor);
        }
    }
}
