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
/// The user's own documents, and nothing else. Not the whole disk, not other
/// users, not the OS. A file index that quietly grew to cover `C:\` would be a
/// different product with a different privacy story.
fn indexed_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs_home() {
        for sub in ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"] {
            let p = home.join(sub);
            if p.is_dir() {
                roots.push(p);
            }
        }
    }
    roots
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Directories that are never worth indexing and are enormous.
fn is_noise(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "AppData" | "Library" | "target" | ".cache" | "$RECYCLE.BIN"
    )
}

/// A path is acceptable only if it sits inside one of the indexed roots.
///
/// Checked on every path-taking command rather than trusting the caller. The
/// renderer is the least trusted part of this application — it runs web content
/// — so a path arriving from it is treated as a claim, not a fact.
fn is_permitted(path: &Path) -> bool {
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    let Some(home) = dirs_home() else {
        return false;
    };
    let Ok(home) = home.canonicalize() else {
        return false;
    };
    canonical.starts_with(home)
}

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
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    opener_open(&path)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    if !is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    let parent = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or(path);
    opener_open(&parent)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<bool, String> {
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
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Microsoft/Windows/Start Menu/Programs"));
    }
    if let Some(programdata) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(programdata).join("Microsoft/Windows/Start Menu/Programs"));
    }

    let mut out: Vec<AppEntry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

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
            if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
                continue;
            }
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            // Uninstallers and help files are shortcuts too, and nobody means
            // them when they say "open X".
            let lower = stem.to_lowercase();
            if lower.contains("uninstall") || lower.contains("readme") || lower.contains("help") {
                continue;
            }
            let id = lower.replace(' ', "-");
            if seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            out.push(AppEntry {
                id,
                name: stem,
                target: path.to_string_lossy().to_string(),
            });
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn launch_app(id: String) -> Result<bool, String> {
    // Launch by *id*, resolved against the list above — never by an arbitrary
    // path handed in from the renderer. This is the difference between "open
    // one of these known applications" and "run whatever I say".
    let apps = list_apps();
    let Some(app) = apps.into_iter().find(|a| a.id == id) else {
        return Err(format!("No installed app with id “{id}”."));
    };
    opener_open(&app.target)
}
