//! The Rust half of the `Platform` port.
//!
//! Everything Atlas can do to this machine is one of the commands below, and
//! there is deliberately no `exec(command: String)` among them. Each command is
//! a narrow, named operation that validates its own input, which is what makes
//! "what can this program do?" a question with a finite answer.
//!
//! The TypeScript side (`TauriPlatform`) is a thin `invoke` wrapper over these;
//! it adds no capability of its own, so this file is the whole attack surface.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Serialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    #[serde(rename = "sizeBytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(rename = "modifiedAt", skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

#[derive(Serialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub target: String,
}

#[derive(Serialize)]
pub struct DiskInfo {
    pub mount: String,
    #[serde(rename = "usedBytes")]
    pub used_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}

#[derive(Serialize)]
pub struct SystemSnapshot {
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f32,
    #[serde(rename = "memoryUsedBytes")]
    pub memory_used_bytes: u64,
    #[serde(rename = "memoryTotalBytes")]
    pub memory_total_bytes: u64,
    pub disks: Vec<DiskInfo>,
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
}

#[derive(Serialize)]
pub struct ProcessEntry {
    pub pid: u32,
    pub name: String,
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f32,
    #[serde(rename = "memoryBytes")]
    pub memory_bytes: u64,
}

/// Folders Atlas will look inside.
///
/// Every folder on the allowed-folders list (`allowed_folders.rs`) is
/// indexed — the same list every other file command is gated by, so search
/// coverage and file-command coverage never disagree about what Atlas may
/// look at. The home folder is the one exception, kept exactly as narrow as
/// it always was: indexing Desktop/Documents/Downloads/Pictures/Videos/Music
/// specifically rather than the whole home tree, because a home directory
/// also holds `.config`-style dotfolders and app data that were never meant
/// to be searchable. A folder added *beyond* the default (`D:\Dev`, say) has
/// no such distinguished subset — the whole thing is indexed directly.
fn indexed_roots() -> Vec<PathBuf> {
    expand_roots(crate::allowed_folders::roots(), dirs_home())
}

/// Turn the allowed-folders list into what actually gets walked.
///
/// Split from `indexed_roots` so this — the part with a real decision in
/// it — can be tested without the global `allowed_folders` state, the same
/// way `net.rs` and `services.rs` split parsing from the I/O that produces
/// the text they parse.
fn expand_roots(allowed: Vec<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for root in allowed {
        if Some(&root) == home.as_ref() {
            for sub in ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] {
                let p = root.join(sub);
                if p.is_dir() {
                    roots.push(p);
                }
            }
        } else {
            roots.push(root);
        }
    }
    roots
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .and_then(|h| h.canonicalize().ok())
}

/// Directories that are never worth indexing and are enormous.
fn is_noise(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "AppData" | "Library" | "target" | ".cache" | "$RECYCLE.BIN"
    )
}

/// A path is acceptable only if it sits inside one of the allowed folders.
///
/// Checked on every path-taking command rather than trusting the caller. The
/// renderer is the least trusted part of this application — it runs web content
/// — so a path arriving from it is treated as a claim, not a fact.
///
/// A re-export, not a definition: the real check and the list it checks
/// against both live in `allowed_folders.rs` now, behind a user-editable
/// list rather than a hard-coded `%USERPROFILE%`. Kept under this name so
/// every one of the ~20 call sites across this file and `disk_usage.rs`
/// needed no change at all.
pub(crate) use crate::allowed_folders::is_permitted;

#[tauri::command]
pub fn search_files(query: String, kind: Option<String>, limit: Option<usize>) -> Vec<FileEntry> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let cap = limit.unwrap_or(40).min(200);
    let mut out = Vec::new();

    for root in indexed_roots() {
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(6)
            .into_iter()
            .filter_entry(|e| {
                !e.file_name()
                    .to_str()
                    .map(is_noise)
                    .unwrap_or(false)
            })
            .filter_map(Result::ok)
        {
            if out.len() >= cap {
                return out;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().contains(&needle) {
                continue;
            }

            let is_dir = entry.file_type().is_dir();
            let ext = entry
                .path()
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            if let Some(k) = &kind {
                if !matches_kind(k, &ext, is_dir) {
                    continue;
                }
            }

            let meta = entry.metadata().ok();
            out.push(FileEntry {
                path: entry.path().to_string_lossy().to_string(),
                name,
                ext,
                is_directory: is_dir,
                size_bytes: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
                modified_at: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            });
        }
    }
    out
}

/// A file's modification time as epoch milliseconds, which is what the
/// TypeScript side wants — `SystemTime` has no meaning across that boundary.
fn modified_millis(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn matches_kind(kind: &str, ext: &str, is_dir: bool) -> bool {
    match kind {
        "folder" => is_dir,
        "document" => matches!(ext, "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "pages"),
        "image" => matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg" | "bmp"),
        "video" => matches!(ext, "mp4" | "mov" | "mkv" | "avi" | "webm" | "wmv"),
        "audio" => matches!(ext, "mp3" | "wav" | "flac" | "m4a" | "ogg" | "aac"),
        "archive" => matches!(ext, "zip" | "rar" | "7z" | "tar" | "gz"),
        _ => true,
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    opener_open(&path)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let parent = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or(path);
    opener_open(&parent)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    // http(s) only. A `file://` or custom-scheme URL arriving here would be a
    // way to launch things the path checks above are meant to prevent.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http and https links can be opened.".into());
    }
    opener_open(&url)
}

fn opener_open(target: &str) -> Result<bool, String> {
    match open::that_detached(target) {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn system_info() -> SystemSnapshot {
    let mut sys = System::new_all();
    sys.refresh_all();
    // One sample is meaningless for CPU; the second is measured against it.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_cpu_usage();

    let disks = Disks::new_with_refreshed_list()
        .iter()
        .map(|d| DiskInfo {
            mount: d.mount_point().to_string_lossy().to_string(),
            used_bytes: d.total_space().saturating_sub(d.available_space()),
            total_bytes: d.total_space(),
        })
        .collect();

    SystemSnapshot {
        cpu_percent: sys.global_cpu_usage(),
        memory_used_bytes: sys.used_memory(),
        memory_total_bytes: sys.total_memory(),
        disks,
        uptime_seconds: System::uptime(),
    }
}

#[tauri::command]
pub fn running_processes(limit: Option<usize>) -> Vec<ProcessEntry> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let mut procs: Vec<ProcessEntry> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcessEntry {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().to_string(),
            cpu_percent: p.cpu_usage(),
            memory_bytes: p.memory(),
        })
        .collect();

    procs.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));
    procs.truncate(limit.unwrap_or(20));
    procs
}

/// Installed applications, from the Start Menu shortcuts.
///
/// Reading the shortcut folders rather than the registry keeps this to things
/// the user can already see and launch themselves — Atlas surfaces what's
/// there, it doesn't discover anything hidden.
#[tauri::command]
pub fn list_apps() -> Vec<AppEntry> {
    let mut out: Vec<AppEntry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    // Order matters: shortcuts have the nicest names, so they claim a name
    // first and the game launchers fill in what has no shortcut.
    collect_shortcuts(&mut out, &mut seen);
    collect_steam(&mut out, &mut seen);
    collect_epic(&mut out, &mut seen);

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Lowercase alphanumerics only, so "SteelSeries GG" and "steelseries.gg" are
/// the same app and can't both be listed.
fn normalized(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn push_app(out: &mut Vec<AppEntry>, seen: &mut Vec<String>, name: String, target: String) {
    let key = normalized(&name);
    if key.is_empty() || seen.contains(&key) {
        return;
    }
    seen.push(key.clone());
    out.push(AppEntry {
        id: key,
        name,
        target,
    });
}

/// Start Menu and Desktop shortcuts — `.lnk` and `.url` alike.
///
/// `.url` files matter more than they look: a launcher-installed game often has
/// no `.lnk` anywhere, only an internet shortcut holding a `steam://` or
/// `com.epicgames.launcher://` address.
fn collect_shortcuts(out: &mut Vec<AppEntry>, seen: &mut Vec<String>) {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Microsoft/Windows/Start Menu/Programs"));
    }
    if let Some(programdata) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(programdata).join("Microsoft/Windows/Start Menu/Programs"));
    }
    if let Some(home) = dirs_home() {
        roots.push(home.join("Desktop"));
    }
    if let Some(public) = std::env::var_os("PUBLIC") {
        roots.push(PathBuf::from(public).join("Desktop"));
    }

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(4)
            .into_iter()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase());
            if !matches!(ext.as_deref(), Some("lnk") | Some("url")) {
                continue;
            }
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            if is_shortcut_noise(&stem.to_lowercase()) {
                continue;
            }
            push_app(out, seen, stem, path.to_string_lossy().to_string());
        }
    }
}

/// Uninstallers, readmes and support links are shortcuts too, and nobody means
/// them when they say "open X".
fn is_shortcut_noise(lower: &str) -> bool {
    lower.contains("uninstall")
        || lower.contains("readme")
        || lower.contains("help")
        || lower.contains("release notes")
        || lower.contains("documentation")
}

/// Installed Steam games, from Steam's own manifests.
///
/// Read rather than executed: `libraryfolders.vdf` names the library folders
/// and each `appmanifest_*.acf` names one installed game. Launching goes
/// through `steam://rungameid/<id>`, which is Steam's documented handler — so
/// this adds a *list*, not a way to run arbitrary things.
fn collect_steam(out: &mut Vec<AppEntry>, seen: &mut Vec<String>) {
    let mut libraries: Vec<PathBuf> = Vec::new();

    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(dir) = std::env::var_os(var) {
            roots.push(PathBuf::from(dir).join("Steam"));
        }
    }

    for root in &roots {
        let vdf = root.join("steamapps/libraryfolders.vdf");
        let Ok(text) = std::fs::read_to_string(&vdf) else {
            continue;
        };
        libraries.push(root.clone());
        for line in text.lines() {
            // "path"		"D:\\SteamLibrary"
            let trimmed = line.trim();
            if !trimmed.starts_with("\"path\"") {
                continue;
            }
            if let Some(value) = vdf_value(trimmed) {
                libraries.push(PathBuf::from(value.replace("\\\\", "\\")));
            }
        }
    }

    for library in libraries {
        let apps_dir = library.join("steamapps");
        let Ok(entries) = std::fs::read_dir(&apps_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };

            let mut app_id = String::new();
            let mut app_name = String::new();
            for line in text.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("\"appid\"") {
                    app_id = vdf_value(trimmed).unwrap_or_default();
                } else if trimmed.starts_with("\"name\"") {
                    app_name = vdf_value(trimmed).unwrap_or_default();
                }
                if !app_id.is_empty() && !app_name.is_empty() {
                    break;
                }
            }
            if app_id.is_empty() || app_name.is_empty() {
                continue;
            }
            push_app(out, seen, app_name, format!("steam://rungameid/{app_id}"));
        }
    }
}

/// The second quoted field on a VDF line: `"name"		"Half-Life"` → `Half-Life`.
fn vdf_value(line: &str) -> Option<String> {
    let mut parts = line.split('"').filter(|p| !p.trim().is_empty());
    parts.next()?;
    parts.next().map(|s| s.to_string())
}

/// Installed Epic Games Launcher titles, from its manifest folder.
///
/// Each `.item` is JSON naming an install location and an executable — which
/// is how something like a Store-bought overlay tool, with no Start Menu entry
/// anywhere, becomes findable by the name its owner knows it by.
fn collect_epic(out: &mut Vec<AppEntry>, seen: &mut Vec<String>) {
    let Some(programdata) = std::env::var_os("ProgramData") else {
        return;
    };
    let manifests = PathBuf::from(programdata).join("Epic/EpicGamesLauncher/Data/Manifests");
    let Ok(entries) = std::fs::read_dir(&manifests) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        // Plugins and DLC are manifests too; only applications are launchable.
        if json.get("bIsApplication").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }

        let (Some(name), Some(location), Some(exe)) = (
            json.get("DisplayName").and_then(|v| v.as_str()),
            json.get("InstallLocation").and_then(|v| v.as_str()),
            json.get("LaunchExecutable").and_then(|v| v.as_str()),
        ) else {
            continue;
        };

        let target = PathBuf::from(location).join(exe.replace('/', "\\"));
        if !target.exists() {
            continue;
        }
        push_app(
            out,
            seen,
            name.to_string(),
            target.to_string_lossy().to_string(),
        );
    }
}

#[tauri::command]
pub fn launch_app(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    // Launch by *id*, resolved against the list above — never by an arbitrary
    // path handed in from the renderer. This is the difference between "open
    // one of these known applications" and "run whatever I say".
    let apps = list_apps();
    let Some(app) = apps.into_iter().find(|a| a.id == id) else {
        return Err(format!("No installed app with id “{id}”."));
    };
    opener_open(&app.target)
}

// ---- file and folder operations --------------------------------------------
//
// Same trust boundary as everything above: a path from the renderer is a
// claim, not a fact, so every command below re-validates it in Rust. `open_path`
// and `reveal_path` use `is_permitted`, which requires the path to already
// exist; a target that's about to be *created* can't pass that check, so
// these use `is_permitted_for_create` — its parent must exist and sit under
// home, the same rule applied one directory up.

fn is_permitted_for_create(path: &Path) -> bool {
    match path.parent() {
        Some(parent) => is_permitted(parent),
        None => false,
    }
}

/// A bare filename with no path separators or `..` — never a place to hide a
/// path outside the folder a rename is already scoped to.
fn is_bare_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != ".." && name != "."
}

const MAX_READABLE_FILE_BYTES: u64 = 256 * 1024;

#[tauri::command]
pub fn create_file(path: String, content: Option<String>) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted_for_create(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if p.exists() {
        return Err("Something is already there.".into());
    }
    std::fs::write(&p, content.unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn create_folder(path: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted_for_create(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if p.exists() {
        return Err("Something is already there.".into());
    }
    std::fs::create_dir(&p).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if !is_bare_filename(&new_name) {
        return Err("That's not a valid name.".into());
    }
    let Some(parent) = p.parent() else {
        return Err("That path has no parent folder.".into());
    };
    let target = parent.join(&new_name);
    if target.exists() {
        return Err("Something is already named that.".into());
    }
    std::fs::rename(&p, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn move_path(path: String, dest_dir: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    let dest = PathBuf::from(&dest_dir);
    if !is_permitted(&p) || !is_permitted(&dest) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let Some(name) = p.file_name() else {
        return Err("That path has no file name.".into());
    };
    let target = dest.join(name);
    if target.exists() {
        return Err("Something is already there.".into());
    }
    std::fs::rename(&p, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn copy_path(path: String, dest_dir: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    let dest = PathBuf::from(&dest_dir);
    if !is_permitted(&p) || !is_permitted(&dest) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if p.is_dir() {
        return Err("Copying a folder isn't supported yet — only files.".into());
    }
    let Some(name) = p.file_name() else {
        return Err("That path has no file name.".into());
    };
    let target = dest.join(name);
    if target.exists() {
        return Err("Something is already there.".into());
    }
    std::fs::copy(&p, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    // The recycle bin, never a permanent delete — meaningfully safer for a
    // confirm-gated action than fs::remove_file/remove_dir_all would be.
    trash::delete(&p).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READABLE_FILE_BYTES {
        return Err("That file is too large to read here.".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "That doesn't look like plain text.".into())
}

// ---- inspecting and adding to files -----------------------------------------

#[derive(Serialize)]
pub struct PathInfo {
    pub path: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "modifiedAt", skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    /// Entries directly inside, for a folder. `None` for a file.
    #[serde(rename = "entryCount", skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<usize>,
}

#[tauri::command]
pub fn path_info(path: String) -> Result<PathInfo, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    let is_directory = meta.is_dir();

    Ok(PathInfo {
        path: p.to_string_lossy().to_string(),
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone()),
        ext: p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
        is_directory,
        // A folder's own metadata length is meaningless; the size of what's in
        // it is a recursive walk, which this command deliberately isn't.
        size_bytes: if is_directory { 0 } else { meta.len() },
        modified_at: modified_millis(&meta),
        entry_count: if is_directory {
            std::fs::read_dir(&p).ok().map(|entries| entries.count())
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn append_file(path: String, content: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    use std::io::Write;

    let p = PathBuf::from(&path);
    // Appending to a file that exists is a write to that file; creating one is
    // a write to its folder. Both are checked, which is why this can't be used
    // to reach somewhere `create_file` couldn't.
    let permitted = if p.exists() {
        is_permitted(&p)
    } else {
        is_permitted_for_create(&p)
    };
    if !permitted {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if p.is_dir() {
        return Err("That's a folder.".into());
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{content}").map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn list_dir(path: String, limit: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    if !p.is_dir() {
        return Err("That isn't a folder.".into());
    }

    let cap = limit.unwrap_or(100).min(500);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| e.to_string())?.flatten() {
        if out.len() >= cap {
            break;
        }
        let meta = entry.metadata().ok();
        let entry_path = entry.path();
        let is_directory = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        out.push(FileEntry {
            path: entry_path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            ext: entry_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
            is_directory,
            size_bytes: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
            modified_at: meta.as_ref().and_then(modified_millis),
        });
    }
    // Folders first, then names — the order a file manager shows, because this
    // is read by someone looking for something rather than by a program.
    out.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// The handful of folders everyone has, by name rather than by path.
///
/// Resolved here rather than in the renderer because the renderer has no
/// business knowing where the home directory is — and because "Downloads" is a
/// name, not a path, until someone resolves it against this machine.
#[tauri::command]
pub fn known_folder(id: String) -> Result<String, String> {
    let home = dirs_home().ok_or("I can't find your home folder.")?;
    let sub = match id.as_str() {
        "home" => return Ok(home.to_string_lossy().to_string()),
        "downloads" => "Downloads",
        "documents" => "Documents",
        "desktop" => "Desktop",
        "pictures" => "Pictures",
        "music" => "Music",
        "videos" => "Videos",
        _ => return Err(format!("No known folder called \u{201c}{id}\u{201d}.")),
    };
    let path = home.join(sub);
    if !path.is_dir() {
        return Err(format!("You don't seem to have a {sub} folder."));
    }
    Ok(path.to_string_lossy().to_string())
}

// ---- system tools -----------------------------------------------------------


#[tauri::command]
pub fn open_system_tool(id: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    // Resolved against a fixed table, the same "known id, not an arbitrary
    // string" shape as `launch_app` — this is not a general launcher.
    let target = match id.as_str() {
        "task-manager" => "taskmgr.exe",
        "device-manager" => "devmgmt.msc",
        "windows-settings" => "ms-settings:",
        "control-panel" => "control.exe",
        // The shells. File Explorer is here rather than treated as an
        // installed application because it is not one — it has no Start
        // Menu entry to match against, so "open File Explorer" found
        // nothing and said so, which is a strange thing to be told about
        // the file manager.
        "file-explorer" => "explorer.exe",
        "this-pc" => "shell:MyComputerFolder",
        "recycle-bin" => "shell:RecycleBinFolder",
        _ => return Err(format!("No system tool with id “{id}”.")),
    };
    opener_open(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The home folder expands to its six well-known subfolders — the exact
    /// set this always indexed, so a fresh install's search coverage doesn't
    /// change just because the allowed-folders list now exists.
    #[test]
    fn the_home_folder_expands_to_its_named_subfolders() {
        let home = std::env::temp_dir().join(format!("atlas-test-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join("Documents")).unwrap();
        std::fs::create_dir_all(home.join("Downloads")).unwrap();
        // Pictures/Desktop/Videos/Music deliberately don't exist here — a
        // machine's own home folder doesn't always have all six either, and
        // a missing one should be left out rather than produce a bad path.

        let roots = expand_roots(vec![home.clone()], Some(home.clone()));
        assert_eq!(roots, vec![home.join("Documents"), home.join("Downloads")]);

        std::fs::remove_dir_all(&home).ok();
    }

    /// A folder that *isn't* the home folder — `D:\Dev`, the case this whole
    /// module exists for — is walked directly, not expanded into subfolders
    /// it has no reason to have.
    #[test]
    fn a_non_home_folder_is_used_directly() {
        let dev = PathBuf::from("D:\\Dev");
        let home = PathBuf::from("C:\\Users\\someone");
        assert_eq!(expand_roots(vec![dev.clone()], Some(home)), vec![dev]);
    }

    /// With no resolvable home at all (a machine with neither `USERPROFILE`
    /// nor `HOME` set), every allowed folder is still walked directly rather
    /// than the whole list silently vanishing.
    #[test]
    fn every_allowed_folder_survives_when_there_is_no_home() {
        let a = PathBuf::from("D:\\Dev");
        let b = PathBuf::from("E:\\Projects");
        assert_eq!(expand_roots(vec![a.clone(), b.clone()], None), vec![a, b]);
    }
}
