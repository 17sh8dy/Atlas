//! A software project, as far as Atlas is allowed to look at and act on it.
//!
//! ## The pattern this file follows
//!
//! The same rule as `net.rs` and `services.rs`, applied to the hardest case
//! yet: **a variable command string is forbidden; a fixed one is not.**
//! `run_devtool` never takes a command line — it takes a `DevTool`, a closed
//! enum naming one fixed executable and one fixed subcommand shape, plus a
//! single validated argument slot. A reader can enumerate the complete set of
//! programs this file will ever run by reading `DevTool`'s match arms in
//! [`dispatch`]. The variable part of that slot (an npm script, a cargo test
//! filter, a cmake target) is either checked against real project data read
//! fresh from disk — an npm script must be a key `package.json` already
//! has — or restricted to a narrow, injection-inert character set. Neither is
//! ever handed to a shell for interpretation, with one documented exception
//! below.
//!
//! ## Why npm and pnpm are the one exception
//!
//! Every other tool here (`git`, `cargo`, `cmake`, `dotnet`, `python`) ships as
//! a real `.exe` that `std::process::Command` launches directly — no shell
//! involved, so shell metacharacters in an argument are inert by construction.
//! npm and pnpm ship as `.cmd` batch files on Windows, which `CreateProcessW`
//! (what `Command` calls) cannot execute on its own — a `.cmd` needs `cmd.exe`
//! as its interpreter. `npm_or_pnpm` wraps exactly those two through
//! `cmd.exe /C`, which *does* re-parse its command line for shell
//! metacharacters — so the one variable slot that goes through it (a script
//! name) is both validated against `package.json`'s real `scripts` keys *and*
//! restricted to [`is_safe_tool_arg`]'s character set, closing the gap twice
//! over rather than trusting either check alone.
//!
//! ## Every path is scoped by the allowed-folders list
//!
//! `cwd` is checked with `crate::allowed_folders::is_permitted` before
//! anything runs — the same check every other path-taking command in this
//! crate makes. Nothing here can act outside a folder the user explicitly
//! allowed.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

// ── Every process here runs under `crate::halt` ─────────────────────────────
// `Halt::run` replaces `Command::output()` throughout, so an emergency stop can
// end a build or a test run mid-way — Ctrl+C first, then its whole Job Object.
//
// And every command that runs one is `#[tauri::command(async)]`. A plain
// synchronous command runs on Tauri's main thread, which is also the event
// loop: a ten-minute `cargo test` used to freeze the whole window for ten
// minutes, including every button that could have stopped it.

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

fn permitted_dir(cwd: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(cwd);
    if !crate::allowed_folders::is_permitted(&p) {
        return Err("That folder is outside the folders Atlas can touch.".into());
    }
    if !p.is_dir() {
        return Err("That isn't a folder.".into());
    }
    Ok(p)
}

fn permitted_file(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !crate::allowed_folders::is_permitted(&p) {
        return Err("That path is outside the folders Atlas can touch.".into());
    }
    Ok(p)
}

/// No shell ever sees this, but every variable slot passed to a fixed command
/// is still checked against it — defense in depth, and the one real gate for
/// the `cmd.exe /C` path npm/pnpm take. Deliberately conservative: this is for
/// short identifiers (a script name, a target, a test filter), not free text.
fn is_safe_tool_arg(s: &str) -> bool {
    if s.is_empty() || s.len() > 200 {
        return false;
    }
    s.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '\\' | ':' | ' ' | '+')
    })
}

// ---- project detection ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DevSystem {
    Cmake,
    Cargo,
    Npm,
    Pnpm,
    Dotnet,
    Make,
    Pytest,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub systems: Vec<DevSystem>,
    #[serde(rename = "npmScripts")]
    pub npm_scripts: Vec<String>,
    #[serde(rename = "isGitRepo")]
    pub is_git_repo: bool,
    #[serde(rename = "cmakeConfigured")]
    pub cmake_configured: bool,
}

fn npm_scripts_of(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    json.get("scripts")
        .and_then(|s| s.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

fn has_extension(root: &Path, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    })
}

/// Detect every ecosystem present, from the marker files a project root
/// actually has — never a guess from a name or a description.
fn detect(root: &Path) -> ProjectInfo {
    let mut systems = Vec::new();

    if root.join("CMakeLists.txt").exists() {
        systems.push(DevSystem::Cmake);
    }
    if root.join("Cargo.toml").exists() {
        systems.push(DevSystem::Cargo);
    }
    let npm_scripts = if root.join("package.json").exists() {
        if root.join("pnpm-lock.yaml").exists() {
            systems.push(DevSystem::Pnpm);
        } else {
            systems.push(DevSystem::Npm);
        }
        npm_scripts_of(root)
    } else {
        Vec::new()
    };
    if has_extension(root, "sln") || has_extension(root, "csproj") {
        systems.push(DevSystem::Dotnet);
    }
    if root.join("Makefile").exists() || root.join("makefile").exists() {
        systems.push(DevSystem::Make);
    }
    if root.join("pyproject.toml").exists()
        || root.join("setup.py").exists()
        || root.join("requirements.txt").exists()
    {
        systems.push(DevSystem::Pytest);
    }

    ProjectInfo {
        root: root.to_string_lossy().into_owned(),
        cmake_configured: root.join("build").join("CMakeCache.txt").exists(),
        is_git_repo: root.join(".git").exists(),
        npm_scripts,
        systems,
    }
}

#[tauri::command]
pub fn detect_project(cwd: String) -> Result<ProjectInfo, String> {
    let root = permitted_dir(&cwd)?;
    Ok(detect(&root))
}

// ---- directory tree ---------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub depth: u32,
}

/// Folders never worth walking into by default — dependency trees and build
/// output would otherwise drown out a project's own source in every result.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "build", "dist", "out", ".venv", "venv",
    "__pycache__", "bin", "obj", ".turbo", ".next", ".cache",
];

fn walk_tree(root: &Path, dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<TreeEntry>, cap: usize) {
    if out.len() >= cap || depth > max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        if out.len() >= cap {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
        out.push(TreeEntry { path: rel, name, is_directory: is_dir, depth });
        if is_dir {
            walk_tree(root, &path, depth + 1, max_depth, out, cap);
        }
    }
}

#[tauri::command]
pub fn dir_tree(cwd: String, max_depth: Option<u32>, max_entries: Option<u32>) -> Result<Vec<TreeEntry>, String> {
    let root = permitted_dir(&cwd)?;
    let depth = max_depth.unwrap_or(3).min(6);
    let cap = max_entries.unwrap_or(400).min(2000) as usize;
    let mut out = Vec::new();
    walk_tree(&root, &root, 0, depth, &mut out, cap);
    Ok(out)
}

// ---- content search ----------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

const SEARCH_SKIP_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "exe", "dll", "pdb",
    "wasm", "woff", "woff2", "ttf", "mp3", "mp4", "wav", "onnx", "bin", "lock",
];

fn search_fallback(root: &Path, query: &str, limit: usize) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    let needle = query.to_lowercase();
    let mut stack = vec![(root.to_path_buf(), 0u32)];

    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= limit || depth > 8 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= limit {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if SEARCH_SKIP_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > 512 * 1024 {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    out.push(SearchMatch {
                        path: rel.clone(),
                        line: (i + 1) as u32,
                        text: line.trim().chars().take(300).collect(),
                    });
                    if out.len() >= limit {
                        break;
                    }
                }
            }
        }
    }
    out
}

fn parse_ripgrep(root: &Path, output: &str) -> Vec<SearchMatch> {
    // `--no-heading` output: "relative/path:line:text"
    let mut out = Vec::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, ':');
        let (Some(path), Some(lineno), Some(text)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let Ok(n) = lineno.parse::<u32>() else { continue };
        let _ = root;
        out.push(SearchMatch { path: path.to_string(), line: n, text: text.trim().chars().take(300).collect() });
    }
    out
}

#[tauri::command(async)]
pub fn code_search(cwd: String, query: String, glob: Option<String>, limit: Option<u32>) -> Result<Vec<SearchMatch>, String> {
    let root = permitted_dir(&cwd)?;
    let query = query.trim();
    if query.is_empty() {
        return Err("Nothing to search for.".into());
    }
    let cap = limit.unwrap_or(50).min(200) as usize;

    let mut cmd = Command::new("rg");
    cmd.current_dir(&root)
        .arg("--line-number")
        .arg("--no-heading")
        .arg("--max-count")
        .arg("500")
        .arg("--max-columns")
        .arg("500");
    if let Some(g) = glob.as_deref().filter(|g| !g.is_empty()) {
        cmd.arg("--glob").arg(g);
    }
    cmd.arg("-e").arg(query).arg(".");
    #[cfg(windows)]
    no_window(&mut cmd);

    match crate::halt::global().run(cmd) {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let mut matches = parse_ripgrep(&root, &text);
            matches.truncate(cap);
            Ok(matches)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Ok(search_fallback(&root, query, cap))
        }
        Err(e) => Err(crate::halt::describe(&e, || format!("Couldn't search: {e}"))),
    }
}

// ---- git (reads) --------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub clean: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

fn run_git(root: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args);
    #[cfg(windows)]
    no_window(&mut cmd);
    let out = crate::halt::global()
        .run(cmd)
        .map_err(|e| crate::halt::describe(&e, || format!("Couldn't run git: {e}")))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// `git status --porcelain=v1 -b` — parsed apart from running it so the
/// fragile part (Windows/porcelain output shape) is the part under test.
fn parse_status(text: &str) -> GitStatus {
    let mut branch = String::new();
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).trim().to_string();
            if let Some(idx) = branch.find(' ') {
                branch.truncate(idx);
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let (index, worktree) = (line.as_bytes()[0] as char, line.as_bytes()[1] as char);
        let path = line[3..].to_string();
        if index == '?' && worktree == '?' {
            untracked.push(path);
        } else {
            if index != ' ' {
                staged.push(path.clone());
            }
            if worktree != ' ' {
                unstaged.push(path);
            }
        }
    }

    GitStatus {
        clean: staged.is_empty() && unstaged.is_empty() && untracked.is_empty(),
        branch,
        staged,
        unstaged,
        untracked,
    }
}

#[tauri::command(async)]
pub fn git_status(cwd: String) -> Result<GitStatus, String> {
    let root = permitted_dir(&cwd)?;
    let (ok, out, err) = run_git(&root, &["status", "--porcelain=v1", "-b"])?;
    if !ok {
        return Err(if err.trim().is_empty() { "That isn't a git repository.".into() } else { err });
    }
    Ok(parse_status(&out))
}

const MAX_OUTPUT_CHARS: usize = 20_000;

fn truncate_output(mut s: String) -> (String, bool) {
    if s.chars().count() > MAX_OUTPUT_CHARS {
        s = s.chars().take(MAX_OUTPUT_CHARS).collect();
        (s, true)
    } else {
        (s, false)
    }
}

#[tauri::command(async)]
pub fn git_diff(cwd: String, path: Option<String>) -> Result<String, String> {
    let root = permitted_dir(&cwd)?;
    let mut args = vec!["diff"];
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        args.push("--");
        args.push(p);
    }
    let (ok, out, err) = run_git(&root, &args)?;
    if !ok {
        return Err(if err.trim().is_empty() { "git diff failed.".into() } else { err });
    }
    Ok(truncate_output(out).0)
}

fn parse_log(text: &str) -> Vec<GitLogEntry> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{1f}');
            let hash = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let date = parts.next()?.to_string();
            let message = parts.next().unwrap_or("").to_string();
            Some(GitLogEntry { hash, author, date, message })
        })
        .collect()
}

#[tauri::command(async)]
pub fn git_log(cwd: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let root = permitted_dir(&cwd)?;
    let n = limit.unwrap_or(20).min(200).to_string();
    let (ok, out, err) = run_git(
        &root,
        &["log", "-n", &n, "--pretty=format:%h\u{1f}%an\u{1f}%ad\u{1f}%s", "--date=short"],
    )?;
    if !ok {
        return Err(if err.trim().is_empty() { "That isn't a git repository.".into() } else { err });
    }
    Ok(parse_log(&out))
}

// ---- git (writes — confirm-tier at the skill layer) ---------------------------

#[tauri::command(async)]
pub fn git_add(cwd: String, path: String) -> Result<bool, String> {
    // Emergency stop: refuse before acting, even if this call was already
    // on its way when the halt landed. See halt.rs.
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let (ok, _out, err) = run_git(&root, &["add", "--", &path])?;
    if !ok {
        return Err(if err.trim().is_empty() { "git add failed.".into() } else { err });
    }
    Ok(true)
}

#[tauri::command(async)]
pub fn git_commit(cwd: String, message: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    if message.trim().is_empty() {
        return Err("A commit needs a message.".into());
    }
    let (ok, _out, err) = run_git(&root, &["commit", "-m", &message])?;
    if !ok {
        return Err(if err.trim().is_empty() { "git commit failed.".into() } else { err });
    }
    let (_, hash, _) = run_git(&root, &["rev-parse", "--short", "HEAD"])?;
    Ok(hash.trim().to_string())
}

// ---- build/test dispatch -------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DevTool {
    CmakeConfigure,
    CmakeBuild,
    Ctest,
    CargoBuild,
    CargoTest,
    NpmRun,
    NpmTest,
    PnpmRun,
    PnpmTest,
    DotnetBuild,
    DotnetTest,
    MakeBuild,
    Pytest,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    pub truncated: bool,
}

/// Run `program` with fixed args directly — no shell, so nothing in `args`
/// (including a validated user-supplied slot) is ever re-interpreted.
fn run_direct(root: &Path, program: &str, args: &[&str]) -> Result<ToolResult, String> {
    let mut cmd = Command::new(program);
    cmd.current_dir(root).args(args);
    #[cfg(windows)]
    no_window(&mut cmd);
    let out = crate::halt::global().run(cmd).map_err(|e| {
        crate::halt::describe(&e, || format!("Couldn't run {program}: {e} (is it installed and on PATH?)"))
    })?;
    let (stdout, t1) = truncate_output(String::from_utf8_lossy(&out.stdout).into_owned());
    let (stderr, t2) = truncate_output(String::from_utf8_lossy(&out.stderr).into_owned());
    Ok(ToolResult { ok: out.status.success(), stdout, stderr, exit_code: out.status.code(), truncated: t1 || t2 })
}

/// npm/pnpm alone: `.cmd` shims on Windows, which `CreateProcessW` cannot
/// execute directly. Routed through `cmd.exe /C`, whose own re-parsing is why
/// `script` is restricted to [`is_safe_tool_arg`]'s character set *and*
/// checked against `package.json`'s real keys before this is ever called —
/// see the module doc.
fn run_npm_or_pnpm(root: &Path, manager: &str, verb: &str, script: Option<&str>) -> Result<ToolResult, String> {
    let mut line = format!("{manager} {verb}");
    if let Some(s) = script {
        line.push(' ');
        line.push_str(s);
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.current_dir(root).arg("/C").arg(&line);
        no_window(&mut cmd);
        let out = crate::halt::global().run(cmd).map_err(|e| {
            crate::halt::describe(&e, || format!("Couldn't run {manager}: {e} (is it installed and on PATH?)"))
        })?;
        let (stdout, t1) = truncate_output(String::from_utf8_lossy(&out.stdout).into_owned());
        let (stderr, t2) = truncate_output(String::from_utf8_lossy(&out.stderr).into_owned());
        Ok(ToolResult { ok: out.status.success(), stdout, stderr, exit_code: out.status.code(), truncated: t1 || t2 })
    }
    #[cfg(not(windows))]
    {
        let mut args = vec![verb];
        if let Some(s) = script {
            args.push(s);
        }
        run_direct(root, manager, &args)
    }
}

fn npm_script_exists(root: &Path, script: &str) -> Result<(), String> {
    let scripts = npm_scripts_of(root);
    if scripts.iter().any(|s| s == script) {
        Ok(())
    } else if scripts.is_empty() {
        Err("This project's package.json has no \"scripts\" to run.".into())
    } else {
        Err(format!("No script called \"{script}\". Available: {}", scripts.join(", ")))
    }
}

#[tauri::command(async)]
pub fn run_devtool(cwd: String, tool: DevTool, arg: Option<String>) -> Result<ToolResult, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let arg = arg.filter(|a| !a.is_empty());
    if let Some(a) = arg.as_deref() {
        if !is_safe_tool_arg(a) {
            return Err("That argument contains characters I won't pass to a build tool.".into());
        }
    }

    match tool {
        DevTool::CmakeConfigure => {
            let build_type = arg.as_deref().unwrap_or("Debug");
            if !["Debug", "Release", "RelWithDebInfo", "MinSizeRel"].contains(&build_type) {
                return Err("buildType must be one of Debug, Release, RelWithDebInfo, MinSizeRel.".into());
            }
            run_direct(&root, "cmake", &["-S", ".", "-B", "build", &format!("-DCMAKE_BUILD_TYPE={build_type}")])
        }
        DevTool::CmakeBuild => match arg.as_deref() {
            Some(target) => run_direct(&root, "cmake", &["--build", "build", "--target", target]),
            None => run_direct(&root, "cmake", &["--build", "build"]),
        },
        DevTool::Ctest => match arg.as_deref() {
            Some(filter) => run_direct(&root, "ctest", &["--test-dir", "build", "--output-on-failure", "-R", filter]),
            None => run_direct(&root, "ctest", &["--test-dir", "build", "--output-on-failure"]),
        },
        DevTool::CargoBuild => run_direct(&root, "cargo", &["build"]),
        DevTool::CargoTest => match arg.as_deref() {
            Some(filter) => run_direct(&root, "cargo", &["test", filter]),
            None => run_direct(&root, "cargo", &["test"]),
        },
        DevTool::NpmRun => {
            let script = arg.as_deref().ok_or("A script name is required.")?;
            npm_script_exists(&root, script)?;
            run_npm_or_pnpm(&root, "npm", "run", Some(script))
        }
        DevTool::NpmTest => run_npm_or_pnpm(&root, "npm", "test", None),
        DevTool::PnpmRun => {
            let script = arg.as_deref().ok_or("A script name is required.")?;
            npm_script_exists(&root, script)?;
            run_npm_or_pnpm(&root, "pnpm", "run", Some(script))
        }
        DevTool::PnpmTest => run_npm_or_pnpm(&root, "pnpm", "test", None),
        DevTool::DotnetBuild => run_direct(&root, "dotnet", &["build"]),
        DevTool::DotnetTest => run_direct(&root, "dotnet", &["test"]),
        DevTool::MakeBuild => match arg.as_deref() {
            Some(target) => run_direct(&root, "make", &[target]),
            None => run_direct(&root, "make", &[]),
        },
        DevTool::Pytest => match arg.as_deref() {
            Some(filter) => run_direct(&root, "python", &["-m", "pytest", "-k", filter]),
            None => run_direct(&root, "python", &["-m", "pytest"]),
        },
    }
}

// ---- file writing --------------------------------------------------------------

const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let p = permitted_file(&path)?;
    if !p.is_file() {
        return Err("That file doesn't exist yet — create it first.".into());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err("That's too much content to write in one go.".into());
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Exact-substring replacement — refuses when `find` is missing, and refuses
/// when it isn't unique unless `replace_all` is set. See the module doc on
/// `Platform.patchTextFile` for why this exists instead of a whole-file
/// overwrite.
#[tauri::command]
pub fn patch_text_file(path: String, find: String, replace: String, replace_all: Option<bool>) -> Result<String, String> {
    crate::halt::global().check()?;
    let p = permitted_file(&path)?;
    if !p.is_file() {
        return Err("That file doesn't exist.".into());
    }
    if find.is_empty() {
        return Err("Nothing to find — the search text is empty.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 256 * 1024 {
        return Err("That file is too large to patch here.".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "That doesn't look like plain text.".to_string())?;

    let occurrences = text.matches(find.as_str()).count();
    if occurrences == 0 {
        return Err("That text isn't in the file — nothing to replace.".into());
    }
    let all = replace_all.unwrap_or(false);
    if occurrences > 1 && !all {
        return Err(format!(
            "That text appears {occurrences} times — pass more context to make it unique, or replaceAll."
        ));
    }

    let patched = if all {
        text.replace(find.as_str(), &replace)
    } else {
        text.replacen(find.as_str(), &replace, 1)
    };
    std::fs::write(&p, patched).map_err(|e| e.to_string())?;

    let count = if all { occurrences } else { 1 };
    Ok(format!("Replaced {count} occurrence{}.", if count == 1 { "" } else { "s" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_tool_arg_accepts_ordinary_identifiers() {
        assert!(is_safe_tool_arg("build"));
        assert!(is_safe_tool_arg("test_engine"));
        assert!(is_safe_tool_arg("packages/engine"));
        assert!(is_safe_tool_arg("Release"));
    }

    #[test]
    fn safe_tool_arg_rejects_shell_metacharacters() {
        for bad in ["a; rm -rf /", "a && b", "a | b", "a`b`", "a$(b)", "a\nb", "a\"b"] {
            assert!(!is_safe_tool_arg(bad), "should reject: {bad}");
        }
    }

    #[test]
    fn safe_tool_arg_rejects_empty_and_overlong() {
        assert!(!is_safe_tool_arg(""));
        assert!(!is_safe_tool_arg(&"x".repeat(201)));
        assert!(is_safe_tool_arg(&"x".repeat(200)));
    }

    #[test]
    fn status_parses_branch_and_three_buckets() {
        let text = "## main...origin/main [ahead 1]\nM  staged.txt\n M unstaged.txt\n?? new.txt\n";
        let status = parse_status(text);
        assert_eq!(status.branch, "main");
        assert_eq!(status.staged, vec!["staged.txt".to_string()]);
        assert_eq!(status.unstaged, vec!["unstaged.txt".to_string()]);
        assert_eq!(status.untracked, vec!["new.txt".to_string()]);
        assert!(!status.clean);
    }

    #[test]
    fn status_reports_clean_when_nothing_changed() {
        let status = parse_status("## main...origin/main\n");
        assert!(status.clean);
        assert_eq!(status.branch, "main");
    }

    #[test]
    fn status_handles_a_detached_or_unborn_branch_line() {
        // No "..." upstream segment at all.
        let status = parse_status("## main\n");
        assert_eq!(status.branch, "main");
    }

    #[test]
    fn status_handles_a_path_with_a_colon_in_it() {
        // Porcelain always reserves columns 0-2 for the two status letters and
        // a space, so a colon inside the path itself must not confuse the
        // fixed-width split.
        let text = "## main\nM  notes:draft.txt\n";
        let status = parse_status(text);
        assert_eq!(status.staged, vec!["notes:draft.txt".to_string()]);
    }

    #[test]
    fn log_parses_the_unit_separator_format() {
        let text = "abc123\u{1f}Jane\u{1f}2026-09-10\u{1f}Fix the thing\nd4e5f6\u{1f}Jane\u{1f}2026-09-09\u{1f}Add tests\n";
        let entries = parse_log(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].hash, "abc123");
        assert_eq!(entries[0].author, "Jane");
        assert_eq!(entries[0].date, "2026-09-10");
        assert_eq!(entries[0].message, "Fix the thing");
    }

    #[test]
    fn log_ignores_a_malformed_line_rather_than_panicking() {
        let entries = parse_log("not enough fields\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn ripgrep_output_parses_into_matches() {
        let out = "src/main.rs:12:    let x = 1;\nsrc/lib.rs:3:fn x() {}\n";
        let matches = parse_ripgrep(Path::new("."), out);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].path, "src/main.rs");
        assert_eq!(matches[0].line, 12);
        assert_eq!(matches[0].text, "let x = 1;");
    }

    #[test]
    fn truncate_output_marks_when_it_cuts_and_when_it_does_not() {
        let (short, cut) = truncate_output("hello".to_string());
        assert_eq!(short, "hello");
        assert!(!cut);

        let long = "x".repeat(MAX_OUTPUT_CHARS + 500);
        let (out, cut) = truncate_output(long);
        assert_eq!(out.chars().count(), MAX_OUTPUT_CHARS);
        assert!(cut);
    }

    #[test]
    fn dev_tool_serializes_to_the_kebab_case_ids_the_ts_side_expects() {
        assert_eq!(serde_json::to_string(&DevTool::Ctest).unwrap(), "\"ctest\"");
        assert_eq!(serde_json::to_string(&DevTool::CmakeConfigure).unwrap(), "\"cmake-configure\"");
        assert_eq!(serde_json::to_string(&DevTool::NpmRun).unwrap(), "\"npm-run\"");
    }

    #[test]
    fn detect_finds_every_marker_in_a_temp_project() {
        let dir = std::env::temp_dir().join(format!("atlas-devtools-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname=\"x\"").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"build":"tsc","test":"vitest"}}"#).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();

        let info = detect(&dir);
        assert!(info.systems.contains(&DevSystem::Cargo));
        assert!(info.systems.contains(&DevSystem::Npm));
        assert!(!info.systems.contains(&DevSystem::Pnpm));
        assert!(info.is_git_repo);
        assert!(!info.cmake_configured);
        let mut scripts = info.npm_scripts.clone();
        scripts.sort();
        assert_eq!(scripts, vec!["build".to_string(), "test".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detect_prefers_pnpm_when_its_lockfile_is_present() {
        let dir = std::env::temp_dir().join(format!("atlas-devtools-test-pnpm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();

        let info = detect(&dir);
        assert!(info.systems.contains(&DevSystem::Pnpm));
        assert!(!info.systems.contains(&DevSystem::Npm));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn walk_tree_skips_known_dependency_folders() {
        let dir = std::env::temp_dir().join(format!("atlas-devtools-test-tree-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("node_modules").join("x")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("main.ts"), "").unwrap();

        let mut out = Vec::new();
        walk_tree(&dir, &dir, 0, 6, &mut out, 400);
        assert!(!out.iter().any(|e| e.name == "node_modules"));
        assert!(out.iter().any(|e| e.name == "main.ts"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
