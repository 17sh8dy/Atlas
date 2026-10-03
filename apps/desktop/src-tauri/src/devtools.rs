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
//!
//! ## `install_dependency` is the same pattern one door over
//!
//! Adding a dependency is a variable-command-string temptation for exactly
//! the reason a build is: "install whatever the user asks for" sounds like it
//! needs a free-form string. It doesn't. [`DepManager`] closes which
//! executable runs (`npm`, `pnpm`, `cargo`, or `python -m pip`) the same way
//! [`DevTool`] closes it for build/test, and the one variable slot — the
//! package name — is checked against [`is_safe_package_name`], which is
//! *stricter* than [`is_safe_tool_arg`]: a leading `-` is refused outright so
//! a "package name" can never double as a manager flag.

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

// ---- git: branches, pull, push, stash -----------------------------------------
//
// Same shape as add/commit: a fixed `git` subcommand with, at most, one
// validated slot. There is no way to pass a flag through any of these — in
// particular no `--force`, no `-D`, no `reset`, no `clean`: what they can do is
// move between branches, bring the upstream in, send the current branch to its
// own upstream, and set work aside and bring it back. Network commands run
// with prompts disabled, so a missing credential is an error message rather
// than a git process waiting forever for a keyboard nobody is at.

#[derive(Debug, Clone, Serialize)]
pub struct GitBranches {
    pub current: String,
    pub branches: Vec<String>,
}

/// A branch name that cannot be mistaken for an option and has no tricks in it.
fn is_safe_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with(".lock")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

fn parse_branches(text: &str) -> GitBranches {
    let mut current = String::new();
    let mut branches = Vec::new();
    for line in text.lines() {
        let is_current = line.starts_with('*');
        let name = line.trim_start_matches('*').trim().to_string();
        // "(HEAD detached at abc123)" is a state, not a branch.
        if name.is_empty() || name.starts_with('(') {
            if is_current {
                current = name;
            }
            continue;
        }
        if is_current {
            current = name.clone();
        }
        branches.push(name);
    }
    GitBranches { current, branches }
}

fn run_git_noprompt(root: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root).args(args).env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never");
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

#[tauri::command(async)]
pub fn git_branches(cwd: String) -> Result<GitBranches, String> {
    let root = permitted_dir(&cwd)?;
    let (ok, out, err) = run_git(&root, &["branch", "--list", "--no-color"])?;
    if !ok {
        return Err(if err.trim().is_empty() { "That isn't a git repository.".into() } else { err });
    }
    Ok(parse_branches(&out))
}

/// Switch to a branch, or with `create` make it first (from where you are).
#[tauri::command(async)]
pub fn git_checkout(cwd: String, branch: String, create: bool) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    if !is_safe_branch_name(&branch) {
        return Err("That isn't a branch name I'll pass to git.".into());
    }
    let args: Vec<&str> = if create { vec!["checkout", "-b", &branch] } else { vec!["checkout", &branch] };
    let (ok, out, err) = run_git(&root, &args)?;
    if !ok {
        return Err(if err.trim().is_empty() { "git checkout failed.".into() } else { err.trim().to_string() });
    }
    Ok(format!("{}{}", out.trim(), if out.trim().is_empty() { err.trim() } else { "" }))
}

/// Bring the upstream in — fast-forward only, so it can never create a merge
/// commit or rewrite anything behind a person's back.
#[tauri::command(async)]
pub fn git_pull(cwd: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let (ok, out, err) = run_git_noprompt(&root, &["pull", "--ff-only"])?;
    if !ok {
        return Err(if err.trim().is_empty() { "git pull failed.".into() } else { err.trim().to_string() });
    }
    Ok(out.trim().to_string())
}

/// Send the current branch to its own upstream. Never forced, never to a
/// different remote or branch than the one it already tracks.
#[tauri::command(async)]
pub fn git_push(cwd: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let (ok, out, err) = run_git_noprompt(&root, &["push"])?;
    if !ok {
        return Err(if err.trim().is_empty() { "git push failed.".into() } else { err.trim().to_string() });
    }
    // git writes push progress to stderr even on success.
    Ok(format!("{}{}", out.trim(), err.trim()).trim().to_string())
}

/// `action`: "push" (set the working changes aside), "pop" (bring the latest back), "list".
#[tauri::command(async)]
pub fn git_stash(cwd: String, action: String) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let args: &[&str] = match action.as_str() {
        "push" => &["stash", "push"],
        "pop" => &["stash", "pop"],
        "list" => &["stash", "list"],
        _ => return Err(format!("There's no stash action called “{action}”.")),
    };
    let (ok, out, err) = run_git(&root, args)?;
    if !ok {
        return Err(if err.trim().is_empty() { "git stash failed.".into() } else { err.trim().to_string() });
    }
    Ok(out.trim().to_string())
}

/// A path inside the repository, as git is handed it: relative, no climbing out,
/// nothing that could be read as an option.
fn is_safe_repo_path(p: &str) -> bool {
    p == "."
        || (!p.is_empty()
            && p.len() <= 300
            && !p.starts_with(['-', '/', '\\'])
            && !p.contains(':')
            && !p.split(['/', '\\']).any(|part| part == "..")
            && !p.chars().any(|c| c.is_control()))
}

/// The rest of everyday git, each a fixed command: `merge` (a branch into this one),
/// `tag`, `tags`, `unstage` (take a file out of the next commit), `discard` (throw away
/// a file's uncommitted changes — the one that cannot be undone), and `init`.
/// A merge that conflicts is aborted at once, so a repository is never left half-merged.
#[tauri::command(async)]
pub fn git_more(cwd: String, action: String, arg: Option<String>) -> Result<String, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let arg = arg.unwrap_or_default();
    let fail = |err: &str, fallback: &str| if err.trim().is_empty() { fallback.to_string() } else { err.trim().to_string() };
    match action.as_str() {
        "merge" => {
            if !is_safe_branch_name(&arg) {
                return Err("That isn't a branch name I'll pass to git.".into());
            }
            let (ok, out, err) = run_git(&root, &["merge", "--no-edit", &arg])?;
            if !ok {
                let text = format!("{out}{err}");
                if text.contains("CONFLICT") {
                    let _ = run_git(&root, &["merge", "--abort"]);
                    return Err(format!("Merging {arg} would conflict, so I stopped and put everything back as it was. Resolve it in your editor."));
                }
                return Err(fail(&err, "git merge failed."));
            }
            Ok(out.trim().to_string())
        }
        "tag" => {
            if !is_safe_branch_name(&arg) {
                return Err("That isn't a tag name I'll pass to git.".into());
            }
            let (ok, _, err) = run_git(&root, &["tag", &arg])?;
            if !ok {
                return Err(fail(&err, "git tag failed."));
            }
            Ok(format!("Tagged {arg}."))
        }
        "tags" => {
            let (ok, out, err) = run_git(&root, &["tag", "--list", "--sort=-creatordate"])?;
            if !ok {
                return Err(fail(&err, "git tag failed."));
            }
            Ok(out.trim().to_string())
        }
        "unstage" => {
            if !is_safe_repo_path(&arg) {
                return Err("That isn't a path inside the repository.".into());
            }
            let (ok, _, err) = run_git(&root, &["restore", "--staged", "--", &arg])?;
            if !ok {
                return Err(fail(&err, "git restore failed."));
            }
            Ok(String::new())
        }
        "discard" => {
            if !is_safe_repo_path(&arg) || arg == "." {
                return Err("Name the file whose changes to throw away — not the whole folder.".into());
            }
            let (ok, _, err) = run_git(&root, &["restore", "--", &arg])?;
            if !ok {
                return Err(fail(&err, "git restore failed."));
            }
            Ok(String::new())
        }
        "init" => {
            if root.join(".git").exists() {
                return Err("That folder is already a git repository.".into());
            }
            let (ok, out, err) = run_git(&root, &["init"])?;
            if !ok {
                return Err(fail(&err, "git init failed."));
            }
            Ok(out.trim().to_string())
        }
        _ => Err(format!("There's no git action called “{action}”.")),
    }
}

#[cfg(test)]
mod git_more_tests {
    use super::*;

    #[test]
    fn repo_paths_are_relative_and_cannot_climb() {
        assert!(is_safe_repo_path("src/main.rs"));
        assert!(is_safe_repo_path("."));
        assert!(!is_safe_repo_path("../secret"));
        assert!(!is_safe_repo_path("a/../../b"));
        assert!(!is_safe_repo_path("-rf"));
        assert!(!is_safe_repo_path("C:\\Windows"));
        assert!(!is_safe_repo_path("/etc/passwd"));
        assert!(!is_safe_repo_path(""));
    }
}

// ---- opening a project somewhere ---------------------------------------------------------

/// Open a terminal window with the project as its working folder. Nothing is
/// typed into it; it is just a new shell, as if opened from the folder.
#[tauri::command(async)]
pub fn open_project_terminal(cwd: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows Terminal when it is installed; a plain PowerShell window when not.
        let wt = Command::new("wt.exe").arg("-d").arg(&root).spawn();
        if wt.is_ok() {
            return Ok(true);
        }
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        Command::new("powershell.exe")
            .current_dir(&root)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("I couldn't open a terminal: {e}"))?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("Opening a terminal isn't supported here.".into())
    }
}

/// Where VS Code installs on Windows, per user and per machine.
#[cfg(windows)]
fn vscode_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("Programs/Microsoft VS Code/Code.exe"));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            candidates.push(PathBuf::from(pf).join("Microsoft VS Code/Code.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Open the project in VS Code. Launches `Code.exe` directly with the folder as
/// its one argument — no shell, so nothing in the path can be read as a command.
#[tauri::command(async)]
pub fn open_project_editor(cwd: String) -> Result<bool, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    #[cfg(windows)]
    {
        let exe = vscode_exe().ok_or("VS Code doesn't look installed on this PC.")?;
        Command::new(exe)
            .arg(&root)
            .spawn()
            .map_err(|e| format!("I couldn't open VS Code: {e}"))?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        Err("Opening an editor isn't supported here.".into())
    }
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
    /// Install everything the project's package.json lists. No package name: it is `npm install`.
    NpmInstall,
    PnpmInstall,
    PnpmRun,
    PnpmTest,
    DotnetBuild,
    DotnetTest,
    MakeBuild,
    Pytest,
    /// `python <script>`: one .py file inside the project, never a command line. Stopped after
    /// [`SCRIPT_RUN_SECS`] if it is still running (a game, a server).
    PythonRun,
    /// `node <script>`: one .js/.mjs/.cjs file inside the project. Same limit.
    NodeRun,
}

/// How long a script may run before it is stopped and reported as "still running".
const SCRIPT_RUN_SECS: u64 = 30;

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
/// every word joining the command line is restricted to [`is_safe_tool_arg`]'s
/// character set (a script name, additionally checked against `package.json`'s
/// real keys before this is ever called) or [`is_safe_package_name`]'s (a
/// dependency to install) — see the module doc.
fn run_npm_or_pnpm_words(root: &Path, manager: &str, words: &[&str]) -> Result<ToolResult, String> {
    let line = format!("{manager} {}", words.join(" "));

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
        run_direct(root, manager, words)
    }
}

fn run_npm_or_pnpm(root: &Path, manager: &str, verb: &str, script: Option<&str>) -> Result<ToolResult, String> {
    match script {
        Some(s) => run_npm_or_pnpm_words(root, manager, &[verb, s]),
        None => run_npm_or_pnpm_words(root, manager, &[verb]),
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
        DevTool::NpmInstall => run_npm_or_pnpm(&root, "npm", "install", None),
        DevTool::PnpmInstall => run_npm_or_pnpm(&root, "pnpm", "install", None),
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
        DevTool::PythonRun => {
            let script = script_in_project(&root, arg.as_deref().ok_or("A script file is required.")?, &["py", "pyw"])?;
            run_script(&root, "python", &script)
        }
        DevTool::NodeRun => {
            let script = script_in_project(&root, arg.as_deref().ok_or("A script file is required.")?, &["js", "mjs", "cjs"])?;
            run_script(&root, "node", &script)
        }
    }
}

/// The script a "run it" call names, checked: relative, inside the project, a real file with an
/// expected extension, and never something a program could read as an option (`-c`, `--eval`).
/// Returned relative to the project, because that is how the program is started.
fn script_in_project(root: &Path, script: &str, extensions: &[&str]) -> Result<String, String> {
    let rel = script.trim().replace('\\', "/");
    if rel.is_empty() || rel.starts_with('-') || rel.starts_with('/') || rel.contains(':') {
        return Err("Name the script relative to the project folder, like game.py or src/app.js.".into());
    }
    if rel.split('/').any(|part| part == ".." || part.is_empty() || part.starts_with('-')) {
        return Err("A script has to be inside the project folder.".into());
    }
    let ext_ok = Path::new(&rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)));
    if !ext_ok {
        return Err(format!("That isn't a .{} file.", extensions.join(" / .")));
    }
    let full = root.join(&rel);
    let (root_c, full_c) = (
        root.canonicalize().map_err(|e| e.to_string())?,
        full.canonicalize().map_err(|_| format!("There is no file called {rel} in this project."))?,
    );
    if !full_c.starts_with(&root_c) || !full_c.is_file() {
        return Err("A script has to be a file inside the project folder.".into());
    }
    Ok(rel)
}

/// Run `program script` in the project under the emergency stop, for at most [`SCRIPT_RUN_SECS`].
/// Still running at the limit is a result, not a failure: it is stopped and reported as such.
fn run_script(root: &Path, program: &str, script: &str) -> Result<ToolResult, String> {
    run_script_for(root, program, script, SCRIPT_RUN_SECS)
}

fn run_script_for(root: &Path, program: &str, script: &str, secs: u64) -> Result<ToolResult, String> {
    let mut cmd = Command::new(program);
    cmd.current_dir(root).arg(script).env("PYTHONUNBUFFERED", "1");
    #[cfg(windows)]
    no_window(&mut cmd);
    let (out, timed_out) = crate::halt::global()
        .run_for(cmd, std::time::Duration::from_secs(secs))
        .map_err(|e| {
            crate::halt::describe(&e, || format!("Couldn't run {program}: {e} (is it installed and on PATH?)"))
        })?;
    let (mut stdout, t1) = truncate_output(String::from_utf8_lossy(&out.stdout).into_owned());
    let (stderr, t2) = truncate_output(String::from_utf8_lossy(&out.stderr).into_owned());
    if timed_out {
        stdout.push_str(&format!("\n[Still running after {secs} seconds, so it was stopped. It did not crash in that time.]"));
    }
    Ok(ToolResult {
        ok: timed_out || out.status.success(),
        stdout,
        stderr,
        exit_code: if timed_out { None } else { out.status.code() },
        truncated: t1 || t2,
    })
}

// ---- starting a project, and shipping one ------------------------------------------------
//
// Both are closed operations in the same shape as `install_dependency`: a fixed
// tool, an enumerated choice, and at most one validated name. There is no slot for a
// flag or a command line.

/// The Vite starter templates Atlas will scaffold.
const SCAFFOLD_TEMPLATES: &[&str] = &[
    "vanilla", "vanilla-ts", "react", "react-ts", "vue", "vue-ts", "svelte", "svelte-ts",
];

/// A new project's folder name: lowercase letters, digits, dashes and underscores.
fn is_safe_project_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 60
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

/// Make a new app from a Vite template inside `parent`, as a new folder called
/// `name`. Refuses to touch a folder that already exists.
#[tauri::command(async)]
pub fn scaffold_project(parent: String, name: String, template: String) -> Result<ToolResult, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&parent)?;
    if !is_safe_project_name(&name) {
        return Err("A project name is lowercase letters, digits, dashes and underscores (like my-app).".into());
    }
    if !SCAFFOLD_TEMPLATES.contains(&template.as_str()) {
        return Err(format!("I can start these: {}.", SCAFFOLD_TEMPLATES.join(", ")));
    }
    if root.join(&name).exists() {
        return Err(format!("There's already something called {name} there."));
    }
    run_npm_or_pnpm_words(&root, "npm", &["create", "--yes", "vite@latest", &name, "--", "--template", &template])
}

/// Where a project can be shipped. Each is the tool's own deploy command, run in the
/// project folder, signed in as the person already is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeployTarget {
    Vercel,
    Cloudflare,
}

#[tauri::command(async)]
pub fn deploy_project(cwd: String, target: DeployTarget) -> Result<ToolResult, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    match target {
        DeployTarget::Vercel => run_npm_or_pnpm_words(&root, "vercel", &["deploy", "--prod", "--yes"]),
        DeployTarget::Cloudflare => run_npm_or_pnpm_words(&root, "npx", &["--yes", "wrangler", "deploy"]),
    }
}

// ---- dependency install -----------------------------------------------------

/// The one door for adding a dependency: a fixed package manager, and one
/// validated package-name slot — the same "closed command, one checked
/// argument" shape as [`DevTool`] above, applied to `install`/`add` instead of
/// `build`/`test`. There is no variant that takes a manager's raw flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DepManager {
    Npm,
    Pnpm,
    Cargo,
    Pip,
}

/// A package name (npm scoped names and version specifiers included, e.g.
/// `@vitejs/plugin-vue` or `react@18.2.0`), never a flag.
///
/// Deliberately stricter than [`is_safe_tool_arg`]: a leading `-` is refused
/// outright so a "package name" can never smuggle in a manager flag
/// (`--registry=http://evil`, `-e`) even though nothing here reaches a shell
/// for cargo/pip — npm/pnpm still route through `cmd.exe /C`, so this is the
/// one real gate on that path, the same role `is_safe_tool_arg` plays for a
/// script name.
fn is_safe_package_name(s: &str) -> bool {
    if s.is_empty() || s.len() > 214 || s.starts_with('-') {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | '/'))
}

#[tauri::command(async)]
pub fn install_dependency(
    cwd: String,
    manager: DepManager,
    package: String,
    dev: Option<bool>,
) -> Result<ToolResult, String> {
    crate::halt::global().check()?;
    let root = permitted_dir(&cwd)?;
    let package = package.trim();
    if !is_safe_package_name(package) {
        return Err("That package name contains characters I won't pass to a package manager.".into());
    }
    let dev = dev.unwrap_or(false);

    match manager {
        DepManager::Npm => {
            let mut words = vec!["install", package];
            if dev {
                words.push("--save-dev");
            }
            run_npm_or_pnpm_words(&root, "npm", &words)
        }
        DepManager::Pnpm => {
            let mut words = vec!["add", package];
            if dev {
                words.push("-D");
            }
            run_npm_or_pnpm_words(&root, "pnpm", &words)
        }
        DepManager::Cargo => {
            let mut args = vec!["add", package];
            if dev {
                args.push("--dev");
            }
            run_direct(&root, "cargo", &args)
        }
        // pip has no first-class "dev dependency" concept the way npm/cargo
        // do (that's a `requirements-dev.txt` convention, not a flag) — `dev`
        // is accepted for a uniform call shape and simply has no effect here.
        DepManager::Pip => run_direct(&root, "python", &["-m", "pip", "install", package]),
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
    fn script_in_project_accepts_a_real_file_and_refuses_everything_else() {
        let root = std::env::temp_dir().join(format!("atlas-script-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("game.py"), "print(1)").unwrap();
        std::fs::write(root.join("src").join("app.js"), "1").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        assert_eq!(script_in_project(&root, "game.py", &["py"]).unwrap(), "game.py");
        assert_eq!(script_in_project(&root, "src\\app.js", &["js"]).unwrap(), "src/app.js");
        // not a script, missing, an option, absolute, a drive, or climbing out
        for bad in ["notes.txt", "nope.py", "-c", "--version", "/etc/x.py", "C:/x.py", "../x.py", "src/../../x.py", "", "a//b.py"] {
            assert!(script_in_project(&root, bad, &["py"]).is_err(), "{bad} should be refused");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Runs a real Python (skipped quietly if there isn't one): a script that finishes is reported
    /// as it finished, a crashing one as failed, and one that never exits is stopped and reported.
    #[test]
    fn run_script_reports_finished_crashed_and_still_running() {
        if Command::new("python").arg("--version").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("atlas-script-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.py"), "print('hello from the script')").unwrap();
        std::fs::write(root.join("bad.py"), "raise SystemExit('boom')").unwrap();
        std::fs::write(root.join("loop.py"), "import time\nprint('started', flush=True)\ntime.sleep(60)").unwrap();

        let ok = run_script_for(&root, "python", "ok.py", 20).unwrap();
        assert!(ok.ok && ok.stdout.contains("hello from the script") && ok.exit_code == Some(0));

        let bad = run_script_for(&root, "python", "bad.py", 20).unwrap();
        assert!(!bad.ok && bad.stderr.contains("boom"));

        let began = std::time::Instant::now();
        let long = run_script_for(&root, "python", "loop.py", 2).unwrap();
        assert!(long.ok, "still running at the limit is a result, not a failure");
        assert!(long.stdout.contains("started") && long.stdout.contains("Still running after 2 seconds"));
        assert!(long.exit_code.is_none());
        assert!(began.elapsed().as_secs() < 15, "it must be stopped, not waited out");
        let _ = std::fs::remove_dir_all(&root);
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
    fn dep_manager_serializes_to_the_lowercase_ids_the_ts_side_expects() {
        assert_eq!(serde_json::to_string(&DepManager::Npm).unwrap(), "\"npm\"");
        assert_eq!(serde_json::to_string(&DepManager::Pnpm).unwrap(), "\"pnpm\"");
        assert_eq!(serde_json::to_string(&DepManager::Cargo).unwrap(), "\"cargo\"");
        assert_eq!(serde_json::to_string(&DepManager::Pip).unwrap(), "\"pip\"");
    }

    #[test]
    fn safe_package_name_accepts_ordinary_and_scoped_names() {
        assert!(is_safe_package_name("react"));
        assert!(is_safe_package_name("react@18.2.0"));
        assert!(is_safe_package_name("@vitejs/plugin-vue"));
        assert!(is_safe_package_name("some_crate.v2"));
    }

    #[test]
    fn safe_package_name_rejects_flag_injection_and_shell_metacharacters() {
        // A leading `-` could smuggle a manager flag past the argument slot —
        // refused outright, unlike `is_safe_tool_arg` which only rejects
        // metacharacters.
        for bad in ["--registry=http://evil", "-e", "; rm -rf /", "a b", "a`b`", "a$(b)", "a\nb"] {
            assert!(!is_safe_package_name(bad), "should reject: {bad}");
        }
    }

    #[test]
    fn branch_names_are_checked_before_git_sees_them() {
        for good in ["main", "feature/login", "release-1.2", "fix_bug"] {
            assert!(is_safe_branch_name(good), "{good}");
        }
        let long = "x".repeat(101);
        for bad in [
            "", "-D", "--force", "../x", "a..b", "a b", "a;b", "a$(x)", "/abs", "x.lock", "a//b", ".hidden",
            long.as_str(),
        ] {
            assert!(!is_safe_branch_name(bad), "{bad}");
        }
    }

    #[test]
    fn branch_list_is_parsed_with_the_current_one_marked() {
        let b = parse_branches("  dev\n* main\n  feature/x\n");
        assert_eq!(b.current, "main");
        assert_eq!(b.branches, vec!["dev", "main", "feature/x"]);
        let detached = parse_branches("* (HEAD detached at abc1234)\n  main\n");
        assert_eq!(detached.branches, vec!["main"]);
        assert!(detached.current.starts_with("(HEAD detached"));
    }

    /// Real git, real temp repo: branches, switching, stashing — and a push
    /// with nowhere to push is an error message, not a hang.
    #[test]
    fn git_round_trip_in_a_temp_repo() {
        let dir = std::env::temp_dir().join(format!("atlas-git-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g = |args: &[&str]| run_git(&dir, args).unwrap();
        if !g(&["--version"]).0 {
            eprintln!("git not installed; skipping");
            return;
        }
        assert!(g(&["init", "-q", "-b", "main"]).0);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "T"]);
        g(&["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "one").unwrap();
        g(&["add", "."]);
        assert!(g(&["commit", "-q", "-m", "first"]).0);

        assert!(g(&["checkout", "-q", "-b", "dev"]).0);
        let b = parse_branches(&g(&["branch", "--list", "--no-color"]).1);
        assert_eq!(b.current, "dev");
        assert!(b.branches.contains(&"main".to_string()));

        // stash and pop bring back exactly the edit
        std::fs::write(dir.join("a.txt"), "two").unwrap();
        assert!(g(&["stash", "push"]).0);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one");
        assert!(g(&["stash", "pop"]).0);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "two");

        let (ok, _o, e) = run_git_noprompt(&dir, &["push"]).unwrap();
        assert!(!ok && !e.trim().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_names_and_templates_are_closed() {
        for good in ["my-app", "app_2", "a"] {
            assert!(is_safe_project_name(good), "{good}");
        }
        for bad in ["", "My-App", "-x", "a b", "a;b", "../x", "a/b", &"x".repeat(61)] {
            assert!(!is_safe_project_name(bad), "{bad}");
        }
        assert!(scaffold_project(r"D:\Dev".into(), "ok".into(), "exe".into()).is_err());
        assert!(scaffold_project(r"D:\Dev".into(), "A B".into(), "react".into()).is_err());
    }

    #[test]
    fn safe_package_name_rejects_empty_and_overlong() {
        assert!(!is_safe_package_name(""));
        assert!(!is_safe_package_name(&"x".repeat(215)));
        assert!(is_safe_package_name(&"x".repeat(214)));
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
