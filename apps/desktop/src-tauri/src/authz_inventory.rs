//! The native-authorization inventory — **data and drift guards only**.
//!
//! Compiled for `cargo test` alone (`#[cfg(test)] mod authz_inventory;` in `lib.rs`): nothing here
//! ships in the binary, changes what any command does, or opens a dialog. It records, for the
//! design in `docs/NATIVE-AUTHORIZATION.md`:
//!
//! * every `#[tauri::command]`, classed by what it can do to the person's machine or to Atlas's
//!   own trust state;
//! * every persistent storage key, classed by how much trust it carries and who consumes it;
//! * the commands that can reach a trust-bearing value *without* going through a dedicated
//!   command (the bypasses a native consent would have to close);
//!
//! and fails the build when a new command or key appears that nobody has classified. The prose
//! version, with the reasoning, is `docs/NATIVE-AUTHORIZATION-INVENTORY.md`.
//!
//! When Phase D of the authorization work lands, `Trust::High` keys become the real `TRUST_KEYS`
//! the generic `storage_set` refuses; until then this is the reviewed list it will be built from.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Inspection with no lasting effect and no private content.
    Read,
    /// Returns content that may hold secrets or private data (files, screens, the store itself).
    SensitiveRead,
    /// Shows, hides or toggles Atlas's own window.
    OwnWindow,
    /// Changes a setting that cannot widen reach or redirect anything (a name, a model, a flag).
    Setting,
    /// Durably widens reach or redirects trust (folders, destinations, the stop key, the store).
    TrustChange,
    /// Saves, deletes or tests a stored secret.
    Secret,
    /// Creates, changes, moves or deletes files inside the Allowed Folders.
    FileChange,
    /// Synthesises mouse, keyboard or UI-Automation input.
    InputSynthesis,
    /// Runs a process or changes system, window or application state outside the file boundary.
    ProcessOrSystem,
    /// Sends renderer-chosen content or reaches a renderer-chosen destination.
    NetworkEgress,
    /// Fetches or installs an update.
    Updater,
    /// The emergency-stop state machine.
    HaltPlumbing,
}

/// `(source file, command, class)`. Sorted by file, then name.
pub const COMMANDS: &[(&str, &str, Class)] = &[
    ("alert_sound.rs", "play_alert_sound", Class::ProcessOrSystem),
    ("allowed_folders.rs", "add_allowed_folder", Class::TrustChange),
    ("allowed_folders.rs", "allowed_folders", Class::Read),
    ("allowed_folders.rs", "remove_allowed_folder", Class::TrustChange),
    ("apps_tools.rs", "winget_install", Class::ProcessOrSystem),
    ("apps_tools.rs", "winget_search", Class::Read),
    ("apps_tools.rs", "winget_uninstall", Class::ProcessOrSystem),
    ("apps_tools.rs", "winget_upgrade", Class::ProcessOrSystem),
    ("apps_tools.rs", "winget_upgrades", Class::Read),
    ("audio.rs", "audio_devices", Class::Read),
    ("catalog_files.rs", "compare_folders", Class::Read),
    ("catalog_files.rs", "file_hash", Class::Read),
    ("catalog_files.rs", "find_files", Class::Read),
    ("catalog_files.rs", "list_archive", Class::Read),
    ("catalog_make.rs", "create_shortcut", Class::FileChange),
    ("catalog_make.rs", "create_url_shortcut", Class::FileChange),
    ("catalog_make.rs", "duplicate_path", Class::FileChange),
    ("catalog_system.rs", "dns_lookup", Class::NetworkEgress),
    ("catalog_system.rs", "firmware_info", Class::Read),
    ("catalog_system.rs", "process_details", Class::Read),
    ("catalog_system.rs", "security_status", Class::Read),
    ("catalog_system.rs", "tool_versions", Class::Read),
    ("catalog_system.rs", "trace_route", Class::NetworkEgress),
    ("cleanup.rs", "cleanup_clean", Class::FileChange),
    ("cleanup.rs", "cleanup_scan", Class::Read),
    ("cloud_intelligence.rs", "ask_cloud_provider", Class::NetworkEgress),
    ("cloud_intelligence.rs", "test_cloud_provider", Class::NetworkEgress),
    ("compat.rs", "windows_compatibility", Class::Read),
    ("devtools.rs", "code_search", Class::Read),
    ("devtools.rs", "deploy_project", Class::ProcessOrSystem),
    ("devtools.rs", "detect_project", Class::Read),
    ("devtools.rs", "dir_tree", Class::Read),
    ("devtools.rs", "git_add", Class::ProcessOrSystem),
    ("devtools.rs", "git_branches", Class::Read),
    ("devtools.rs", "git_checkout", Class::ProcessOrSystem),
    ("devtools.rs", "git_commit", Class::ProcessOrSystem),
    ("devtools.rs", "git_diff", Class::Read),
    ("devtools.rs", "git_log", Class::Read),
    ("devtools.rs", "git_more", Class::ProcessOrSystem),
    ("devtools.rs", "git_pull", Class::ProcessOrSystem),
    ("devtools.rs", "git_push", Class::ProcessOrSystem),
    ("devtools.rs", "git_stash", Class::ProcessOrSystem),
    ("devtools.rs", "git_status", Class::Read),
    ("devtools.rs", "install_dependency", Class::ProcessOrSystem),
    ("devtools.rs", "open_project_editor", Class::ProcessOrSystem),
    ("devtools.rs", "open_project_terminal", Class::ProcessOrSystem),
    ("devtools.rs", "patch_text_file", Class::FileChange),
    ("devtools.rs", "run_devtool", Class::ProcessOrSystem),
    ("devtools.rs", "scaffold_project", Class::FileChange),
    ("devtools.rs", "write_text_file", Class::FileChange),
    ("diagnostics.rs", "log_diagnostic", Class::Read),
    ("diagnostics.rs", "read_diagnostics", Class::Read),
    ("disk_usage.rs", "folder_size", Class::Read),
    ("disk_usage.rs", "largest_files", Class::Read),
    ("disk_usage.rs", "largest_subfolders", Class::Read),
    ("display_audio.rs", "app_volumes", Class::Read),
    ("display_audio.rs", "brightness_get", Class::Read),
    ("display_audio.rs", "brightness_set", Class::ProcessOrSystem),
    ("display_audio.rs", "power_plan", Class::Read),
    ("display_audio.rs", "project_display", Class::ProcessOrSystem),
    ("display_audio.rs", "set_app_volume", Class::ProcessOrSystem),
    ("display_audio.rs", "set_power_plan", Class::ProcessOrSystem),
    ("elevation.rs", "elevation_cancel", Class::ProcessOrSystem),
    ("elevation.rs", "elevation_prepare", Class::ProcessOrSystem),
    ("elevation.rs", "elevation_run", Class::ProcessOrSystem),
    ("elevation.rs", "elevation_status", Class::Read),
    ("engines.rs", "game_engines", Class::Read),
    ("engines.rs", "open_plugins_folder", Class::FileChange),
    ("engines.rs", "plugin_manifests", Class::Read),
    ("environment.rs", "delete_environment_variable", Class::ProcessOrSystem),
    ("environment.rs", "list_environment_variables", Class::Read),
    ("environment.rs", "set_environment_variable", Class::ProcessOrSystem),
    ("file_tools.rs", "compare_files", Class::Read),
    ("file_tools.rs", "file_attributes", Class::Read),
    ("file_tools.rs", "find_duplicates", Class::Read),
    ("file_tools.rs", "recent_changes", Class::Read),
    ("file_tools.rs", "set_file_attributes", Class::FileChange),
    ("file_tools.rs", "unzip_path", Class::FileChange),
    ("file_tools.rs", "zip_path", Class::FileChange),
    ("halt.rs", "halt_now", Class::HaltPlumbing),
    ("halt.rs", "halt_reset", Class::HaltPlumbing),
    ("halt.rs", "halt_set_working", Class::HaltPlumbing),
    ("halt.rs", "halt_status", Class::HaltPlumbing),
    ("halt.rs", "set_halt_shortcut", Class::TrustChange),
    ("input.rs", "cursor_position", Class::Read),
    ("input.rs", "hold_key", Class::InputSynthesis),
    ("input.rs", "hotkey", Class::InputSynthesis),
    ("input.rs", "mouse_click", Class::InputSynthesis),
    ("input.rs", "mouse_drag", Class::InputSynthesis),
    ("input.rs", "mouse_scroll", Class::InputSynthesis),
    ("input.rs", "move_mouse", Class::InputSynthesis),
    ("input.rs", "press_key", Class::InputSynthesis),
    ("input.rs", "type_text", Class::InputSynthesis),
    ("input_guard.rs", "input_probe", Class::Read),
    ("intelligence.rs", "ask_local_model_stream", Class::NetworkEgress),
    ("intelligence.rs", "ask_nova_intelligence_stream", Class::NetworkEgress),
    ("intelligence.rs", "local_model_info", Class::Read),
    ("intelligence.rs", "local_models_installed", Class::Read),
    ("intelligence.rs", "nova_intelligence_reachable", Class::Read),
    ("kokoro.rs", "kokoro_status", Class::Read),
    ("kokoro.rs", "kokoro_unload", Class::Read),
    ("kokoro.rs", "kokoro_voices", Class::Read),
    ("kokoro.rs", "kokoro_warm", Class::Read),
    ("lib.rs", "capabilities", Class::Read),
    ("lib.rs", "hide_window", Class::OwnWindow),
    ("lib.rs", "show_window", Class::OwnWindow),
    ("lib.rs", "summon_key_status", Class::Read),
    ("lib.rs", "toggle_window", Class::OwnWindow),
    ("listen.rs", "transcribe_speech", Class::NetworkEgress),
    ("media_tools.rs", "compress_video", Class::FileChange),
    ("media_tools.rs", "convert_media", Class::FileChange),
    ("media_tools.rs", "edit_media", Class::FileChange),
    ("media_tools.rs", "media_info", Class::Read),
    ("media_tools.rs", "resize_image", Class::FileChange),
    ("net.rs", "network_adapters", Class::Read),
    ("net.rs", "network_reachable", Class::Read),
    ("net.rs", "wifi_networks", Class::Read),
    ("net.rs", "wifi_status", Class::Read),
    ("nova_launcher.rs", "nova_intelligence_launch_state", Class::Read),
    ("nova_launcher.rs", "nova_intelligence_locate", Class::Read),
    ("nova_launcher.rs", "nova_intelligence_start", Class::ProcessOrSystem),
    ("nova_launcher.rs", "nova_intelligence_stop", Class::ProcessOrSystem),
    ("os.rs", "display_off", Class::ProcessOrSystem),
    ("os.rs", "empty_recycle_bin", Class::FileChange),
    ("os.rs", "lock_workstation", Class::ProcessOrSystem),
    ("os.rs", "media_key", Class::ProcessOrSystem),
    ("os.rs", "power_action", Class::ProcessOrSystem),
    ("os.rs", "set_volume", Class::ProcessOrSystem),
    ("os.rs", "toggle_mute", Class::ProcessOrSystem),
    ("pc_health.rs", "document_text", Class::SensitiveRead),
    ("pc_health.rs", "driver_list", Class::Read),
    ("pc_health.rs", "gpu_live", Class::Read),
    ("pc_health.rs", "installed_software", Class::Read),
    ("pc_health.rs", "live_metrics", Class::Read),
    ("pc_health.rs", "network_usage", Class::Read),
    ("pc_health.rs", "recent_errors", Class::Read),
    ("pc_health.rs", "registry_read", Class::SensitiveRead),
    ("pc_health.rs", "verify_file", Class::SensitiveRead),
    ("ping.rs", "ping_host", Class::NetworkEgress),
    ("platform.rs", "append_file", Class::FileChange),
    ("platform.rs", "copy_path", Class::FileChange),
    ("platform.rs", "create_file", Class::FileChange),
    ("platform.rs", "create_folder", Class::FileChange),
    ("platform.rs", "delete_path", Class::FileChange),
    ("platform.rs", "known_folder", Class::Read),
    ("platform.rs", "launch_app", Class::ProcessOrSystem),
    ("platform.rs", "list_apps", Class::Read),
    ("platform.rs", "list_dir", Class::Read),
    ("platform.rs", "move_path", Class::FileChange),
    ("platform.rs", "move_path_to", Class::FileChange),
    ("platform.rs", "open_path", Class::ProcessOrSystem),
    ("platform.rs", "open_system_tool", Class::ProcessOrSystem),
    ("platform.rs", "open_url", Class::ProcessOrSystem),
    ("platform.rs", "open_url_with_app", Class::ProcessOrSystem),
    ("platform.rs", "path_info", Class::Read),
    ("platform.rs", "probe_path", Class::Read),
    ("platform.rs", "read_text_file", Class::SensitiveRead),
    ("platform.rs", "rename_path", Class::FileChange),
    ("platform.rs", "reveal_path", Class::ProcessOrSystem),
    ("platform.rs", "running_processes", Class::Read),
    ("platform.rs", "search_files", Class::Read),
    ("platform.rs", "system_info", Class::Read),
    ("powershell.rs", "run_powershell", Class::ProcessOrSystem),
    ("screen.rs", "capture_display", Class::SensitiveRead),
    ("screen.rs", "capture_screen", Class::SensitiveRead),
    ("screen.rs", "capture_window", Class::SensitiveRead),
    ("screen.rs", "list_displays", Class::Read),
    ("provider_bindings.rs", "provider_add", Class::TrustChange),
    ("provider_bindings.rs", "provider_bind", Class::TrustChange),
    ("provider_bindings.rs", "provider_binding", Class::Read),
    ("provider_bindings.rs", "provider_list", Class::Read),
    ("provider_bindings.rs", "provider_resume", Class::TrustChange),
    ("provider_bindings.rs", "provider_set_caps", Class::TrustChange),
    ("provider_bindings.rs", "provider_set_prices", Class::Setting),
    ("provider_bindings.rs", "provider_update", Class::Setting),
    ("provider_bindings.rs", "provider_unbind", Class::TrustChange),
    ("searxng.rs", "searxng_config", Class::Read),
    ("searxng.rs", "searxng_configure", Class::TrustChange),
    ("searxng.rs", "searxng_test", Class::NetworkEgress),
    ("secrets.rs", "account_session_clear", Class::Secret),
    ("secrets.rs", "account_session_get", Class::Secret),
    ("secrets.rs", "account_session_set", Class::Secret),
    ("secrets.rs", "delete_secret", Class::Secret),
    ("secrets.rs", "has_secret", Class::Secret),
    ("secrets.rs", "save_secret", Class::Secret),
    ("services.rs", "list_services", Class::Read),
    ("services.rs", "service_control", Class::ProcessOrSystem),
    ("services.rs", "service_detail", Class::Read),
    ("settings_controls.rs", "do_not_disturb", Class::Read),
    ("settings_controls.rs", "explorer_options", Class::Read),
    ("settings_controls.rs", "mouse_speed", Class::Read),
    ("settings_controls.rs", "now_playing", Class::Read),
    ("settings_controls.rs", "radios", Class::Read),
    ("settings_controls.rs", "restart_explorer", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_do_not_disturb", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_explorer_option", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_mouse_speed", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_radio", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_shuffle", Class::ProcessOrSystem),
    ("settings_controls.rs", "set_wallpaper", Class::FileChange),
    ("shell_tools.rs", "flush_dns", Class::ProcessOrSystem),
    ("shell_tools.rs", "hardware_specs", Class::Read),
    ("shell_tools.rs", "open_settings_page", Class::ProcessOrSystem),
    ("shell_tools.rs", "print_file", Class::ProcessOrSystem),
    ("shell_tools.rs", "printers", Class::Read),
    ("shell_tools.rs", "recycle_bin_list", Class::Read),
    ("shell_tools.rs", "recycle_bin_restore", Class::FileChange),
    ("shell_tools.rs", "set_default_printer", Class::ProcessOrSystem),
    ("shell_tools.rs", "set_startup_app", Class::ProcessOrSystem),
    ("shell_tools.rs", "speed_test", Class::NetworkEgress),
    ("shell_tools.rs", "startup_apps", Class::Read),
    ("speech.rs", "speech_voices", Class::Read),
    ("speech.rs", "synthesize_speech", Class::Read),
    ("stats.rs", "stats_info", Class::Read),
    ("stats.rs", "stats_record", Class::Setting),
    ("stats.rs", "stats_reset", Class::Setting),
    ("stats.rs", "stats_summary", Class::Read),
    ("stats.rs", "stats_touch", Class::Setting),
    ("storage.rs", "storage_get", Class::SensitiveRead),
    ("storage.rs", "storage_remove", Class::TrustChange),
    ("storage.rs", "storage_set", Class::TrustChange),
    ("system_controls.rs", "cancel_shutdown", Class::ProcessOrSystem),
    ("system_controls.rs", "mic_set", Class::ProcessOrSystem),
    ("system_controls.rs", "mic_state", Class::Read),
    ("system_controls.rs", "power_states", Class::Read),
    ("system_controls.rs", "schedule_shutdown", Class::ProcessOrSystem),
    ("system_controls.rs", "sleep_pc", Class::ProcessOrSystem),
    ("system_controls.rs", "theme_get", Class::Read),
    ("system_controls.rs", "theme_set", Class::ProcessOrSystem),
    ("system_controls.rs", "volume_set", Class::ProcessOrSystem),
    ("system_controls.rs", "volume_state", Class::Read),
    ("uia.rs", "uia_append_value", Class::InputSynthesis),
    ("uia.rs", "uia_capabilities", Class::Read),
    ("uia.rs", "uia_focus", Class::InputSynthesis),
    ("uia.rs", "uia_focused_element", Class::SensitiveRead),
    ("uia.rs", "uia_invoke", Class::InputSynthesis),
    ("uia.rs", "uia_scroll", Class::InputSynthesis),
    ("uia.rs", "uia_set_expanded", Class::InputSynthesis),
    ("uia.rs", "uia_set_value", Class::InputSynthesis),
    ("uia.rs", "uia_tree", Class::SensitiveRead),
    ("updater.rs", "updater_cancel", Class::Updater),
    ("updater.rs", "updater_confirm_launch", Class::Updater),
    ("updater.rs", "updater_download", Class::Updater),
    ("updater.rs", "updater_fetch_manifest", Class::Updater),
    ("updater.rs", "updater_install", Class::Updater),
    ("updater.rs", "updater_restart", Class::Updater),
    ("updater.rs", "updater_startup_status", Class::Updater),
    ("updater.rs", "updater_verify", Class::Updater),
    ("web.rs", "fetch_doc_page", Class::NetworkEgress),
    ("web.rs", "fetch_page", Class::NetworkEgress),
    ("web.rs", "web_search", Class::NetworkEgress),
    ("web.rs", "web_search_provider_ready", Class::Read),
    ("web.rs", "web_search_with", Class::NetworkEgress),
    ("window.rs", "active_window", Class::Read),
    ("window.rs", "close_window", Class::ProcessOrSystem),
    ("window.rs", "end_process", Class::ProcessOrSystem),
    ("window.rs", "focus_window", Class::ProcessOrSystem),
    ("window.rs", "list_windows", Class::Read),
    ("window.rs", "maximize_window", Class::ProcessOrSystem),
    ("window.rs", "minimize_window", Class::ProcessOrSystem),
    ("window.rs", "restore_window", Class::ProcessOrSystem),
    ("window.rs", "set_window_bounds", Class::ProcessOrSystem),
    ("window.rs", "set_window_topmost", Class::ProcessOrSystem),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    /// Changing it changes what Atlas may touch, where data goes, who Atlas acts as, or what runs
    /// unattended. These become `TRUST_KEYS`.
    High,
    /// Changing it changes behaviour a person would notice, or replays saved steps through the
    /// executor (which still asks as its mode requires).
    Medium,
    /// Preference or bookkeeping. A wrong value is an annoyance.
    Low,
    /// Not authority, but private: transcript, history, memory.
    Privacy,
}

pub struct Key {
    pub key: &'static str,
    pub trust: Trust,
    /// Who acts on the value. `native-startup` means Rust reads it once at launch and holds it in
    /// memory, so a change through the store takes effect at the next launch.
    pub consumers: &'static str,
}

pub const KEYS: &[Key] = &[
    Key { key: "atlas.allowed-folders", trust: Trust::High,
          consumers: "native-startup: allowed_folders::init; checked by every path command" },
    Key { key: "atlas.searxng-endpoint", trust: Trust::High,
          consumers: "native-startup: searxng::init; the only address web_search_with ever uses" },
    Key { key: "atlas.provider-bindings", trust: Trust::High,
          consumers: "native-startup: provider_bindings::init; the cloud-provider list and where each saved key may be sent" },
    Key { key: "atlas.migrations", trust: Trust::High,
          consumers: "native-startup: provider_bindings::init; records the one-time provider migration" },
    Key { key: "atlas.nova.account", trust: Trust::High,
          consumers: "legacy only: the sign-in session used to rest here in plain text; it now rests in Credential Manager (account_session_*) and is moved out of this key on first read" },
    Key { key: "atlas.preferences", trust: Trust::High,
          consumers: "renderer: MemoryStore facts. No longer holds cloud-provider trust (moved native, stage 4); still holds provider.active, local/nova enable flags and base URLs (loopback-only, re-checked natively), nova.folder (a program the launcher may start) and execution.mode" },
    Key { key: "atlas.watches", trust: Trust::High,
          consumers: "engine: watch manager; continuation steps run unattended with their saved approval" },
    Key { key: "routines.items", trust: Trust::High,
          consumers: "engine: routines scheduler; saved plans replayed on a schedule. Not atlas.-prefixed" },
    Key { key: "atlas.halt-shortcut", trust: Trust::Medium,
          consumers: "native-startup: halt::start; set_halt_shortcut rebinds the emergency stop" },
    Key { key: "atlas.setups", trust: Trust::Medium,
          consumers: "engine: setup store; saved step lists re-run through the executor" },
    Key { key: "atlas.tasks", trust: Trust::Medium,
          consumers: "engine: task store; resume re-runs steps through the executor" },
    Key { key: "atlas.workflow.transactions", trust: Trust::Medium,
          consumers: "engine: transaction store; stored undo steps run through the executor" },
    Key { key: "atlas.file-journal", trust: Trust::Medium,
          consumers: "renderer: undo journal; undo replays moves and deletes" },
    Key { key: "reminders.items", trust: Trust::Low,
          consumers: "engine: reminders scheduler. Not atlas.-prefixed" },
    Key { key: "atlas.stats.period", trust: Trust::Low, consumers: "renderer: which period the Stats page last showed" },
    Key { key: "atlas.update.autocheck", trust: Trust::Low, consumers: "renderer: update checker" },
    Key { key: "atlas.update.dismissed", trust: Trust::Low, consumers: "renderer: update banner" },
    Key { key: "atlas.settings.alerts", trust: Trust::Low, consumers: "renderer: alert thresholds" },
    Key { key: "atlas.settings.notifications-enabled", trust: Trust::Low, consumers: "renderer: alerts" },
    Key { key: "atlas.settings.scroll", trust: Trust::Low, consumers: "renderer: scroll preference" },
    Key { key: "atlas.accent", trust: Trust::Low, consumers: "renderer: theme" },
    Key { key: "atlas.theme", trust: Trust::Low, consumers: "renderer: theme" },
    Key { key: "atlas.text-style", trust: Trust::Low, consumers: "renderer: text style" },
    Key { key: "atlas.effects.enhanced", trust: Trust::Low, consumers: "renderer: effects" },
    Key { key: "atlas.agent.context-tokens", trust: Trust::Low, consumers: "renderer + engine: context budget" },
    Key { key: "atlas.selftest.probe", trust: Trust::Low, consumers: "renderer: storage self-check scratch key" },
    Key { key: "atlas.transcript", trust: Trust::Privacy, consumers: "renderer: conversation history" },
    Key { key: "atlas.memory.episodes", trust: Trust::Privacy, consumers: "data: MemoryStore episodes" },
    Key { key: "atlas.settings.clipboard-history", trust: Trust::Privacy, consumers: "renderer: clipboard history" },
];

/// `atlas.`-prefixed literals that are not storage keys: a skill id and a fact subject inside
/// `atlas.preferences`. (The older storage sweep skips skill ids the same way.)
pub const NOT_STORAGE_KEYS: &[&str] = &["atlas.hide", "atlas.name"];

/// Commands that can reach a trust-bearing value or widen reach **without** going through the
/// dedicated command for it. Each is a place a native consent would have to cover; none is
/// changed by this inventory.
pub const BYPASSES: &[(&str, &str)] = &[
    ("storage_set", "RESOLVED for TRUST_KEYS (stage 4): refused; every other key stays writable by design"),
    ("storage_remove", "RESOLVED for TRUST_KEYS (stage 4)"),
    ("storage_get", "TRUST_KEYS refused (stage 4); the Nova account token stays readable by the renderer, which owns the sign-in"),
    ("append_file", "RESOLVED (stage 1): Atlas's own folders are refused by is_permitted"),
    ("write_text_file", "RESOLVED (stage 1)"),
    ("patch_text_file", "RESOLVED (stage 1)"),
    ("read_text_file", "RESOLVED (stage 1)"),
    ("document_text", "RESOLVED (stage 1)"),
    ("rename_path", "RESOLVED (stage 1): also refuses a folder that contains Atlas's own"),
    ("move_path_to", "RESOLVED (stage 1)"),
    ("create_file", "RESOLVED (stage 1): the parent folder is refused"),
    ("copy_path", "RESOLVED (stage 1)"),
    ("delete_path", "RESOLVED (stage 1): also refuses a folder that contains Atlas's own"),
    ("ask_cloud_provider", "RESOLVED (stage 2): destination now comes from the native binding, not the caller"),
    ("test_cloud_provider", "RESOLVED (stage 2): same"),
    ("run_powershell", "runs an arbitrary script; only the cwd is checked against Allowed Folders"),
    ("run_devtool", "runs developer tools with renderer-supplied arguments"),
    ("updater_download", "RESOLVED (stage 5): only the installer a signature-verified manifest names, under the pinned repository"),
    ("updater_install", "RESOLVED (stage 5): the measured file must equal the signed hash and version, and be newer; fails closed until a signing key is compiled in"),
    ("set_environment_variable", "changes user or machine environment, which later processes inherit"),
    ("set_startup_app", "adds or removes a start-up entry"),
    ("halt_reset", "clears a latched emergency stop"),
    ("halt_set_working", "tells the stop machinery work is or is not in flight"),
];

// ---- the guards -----------------------------------------------------------------------------

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn repo_root() -> PathBuf {
    crate_root().join("..").join("..").join("..")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, exts: &[&str]) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if matches!(name.as_str(), "node_modules" | "dist" | "target" | ".git" | "gen" | "test" | "tests" | "__tests__") {
                continue;
            }
            walk(&p, out, exts);
        } else if exts.iter().any(|e| name.ends_with(e))
            && !name.contains(".test.")
            && !name.contains(".spec.")
            && !name.ends_with(".d.ts")
        {
            out.push(p);
        }
    }
}

fn files(dirs: &[PathBuf], exts: &[&str]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in dirs {
        walk(d, &mut out, exts);
    }
    out
}

/// Names of every `#[tauri::command]` function in one source file.
fn commands_in(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut armed = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("//") {
            continue;
        }
        if t.starts_with("#[tauri::command") {
            armed = true;
            continue;
        }
        if !armed {
            continue;
        }
        if t.starts_with("#[") || t.is_empty() {
            continue;
        }
        if let Some(i) = t.find("fn ") {
            let rest = &t[i + 3..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if !name.is_empty() {
                found.push(name);
            }
        }
        armed = false;
    }
    found
}

/// Quoted literals that look like a storage key: `atlas.` + `[a-z0-9._-]+`, or `<word>.items`,
/// with the same quote character on both sides.
fn key_literals(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let q = bytes[i];
        if q == b'\'' || q == b'"' || q == b'`' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && (bytes[j].is_ascii_lowercase() || bytes[j].is_ascii_digit() || matches!(bytes[j], b'.' | b'_' | b'-')) {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == q && j > start {
                let lit = &text[start..j];
                let is_atlas = lit.starts_with("atlas.") && lit.len() > 6;
                let is_items = lit.ends_with(".items") && lit.len() > 6 && !lit.starts_with('.');
                if is_atlas || is_items {
                    found.push(lit.to_string());
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn declared_commands() -> BTreeSet<(String, String)> {
        let src = crate_root().join("src");
        let mut set = BTreeSet::new();
        for f in files(&[src], &[".rs"]) {
            let name = f.file_name().unwrap().to_string_lossy().into_owned();
            if name == "authz_inventory.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            for c in commands_in(&text) {
                set.insert((name.clone(), c));
            }
        }
        set
    }

    #[test]
    fn every_native_command_is_classified_and_none_is_stale() {
        let declared = declared_commands();
        assert!(declared.len() > 200, "the scan found only {} commands, so it has stopped looking", declared.len());
        let table: BTreeSet<(String, String)> =
            COMMANDS.iter().map(|(f, n, _)| (f.to_string(), n.to_string())).collect();
        assert_eq!(table.len(), COMMANDS.len(), "a command is listed twice");
        let missing: Vec<_> = declared.difference(&table).collect();
        let stale: Vec<_> = table.difference(&declared).collect();
        assert!(
            missing.is_empty(),
            "native commands nobody has classified in authz_inventory.rs (add each with the Class that fits):\n{missing:#?}"
        );
        assert!(stale.is_empty(), "classified commands that no longer exist:\n{stale:#?}");
    }

    #[test]
    fn every_classified_command_is_registered_with_the_app() {
        let lib = std::fs::read_to_string(crate_root().join("src").join("lib.rs")).unwrap();
        let from = lib.find("generate_handler![").expect("generate_handler! block");
        let block = &lib[from..];
        let to = block.find("])").unwrap_or(block.len());
        let block = &block[..to];
        for (_, name, _) in COMMANDS {
            // Registered as `module::name,` or bare (`name,`) for those defined in lib.rs.
            let registered = block.match_indices(*name).any(|(i, _)| {
                let before = block[..i].chars().next_back().unwrap_or(' ');
                let after = block[i + name.len()..].chars().next().unwrap_or(' ');
                !(before.is_ascii_alphanumeric() || before == '_') && (after == ',' || after.is_whitespace())
            });
            assert!(registered, "{name} is a command but is not registered in generate_handler!");
        }
    }

    #[test]
    fn the_trust_changing_commands_are_the_ones_we_think_they_are() {
        let mut names: Vec<&str> =
            COMMANDS.iter().filter(|(_, _, c)| *c == Class::TrustChange).map(|(_, n, _)| *n).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "add_allowed_folder",
                "provider_add",
                "provider_bind",
                "provider_resume",
                "provider_set_caps",
                "provider_unbind",
                "remove_allowed_folder",
                "searxng_configure",
                "set_halt_shortcut",
                "storage_remove",
                "storage_set",
            ],
            "the set of commands that change trust has changed: review it against docs/NATIVE-AUTHORIZATION.md"
        );
    }

    #[test]
    fn every_storage_key_in_the_source_is_classified_and_none_is_stale() {
        let root = repo_root();
        let dirs = [
            root.join("packages"),
            root.join("apps").join("web").join("src"),
            crate_root().join("src"),
        ];
        let mut seen = BTreeSet::new();
        for f in files(&dirs, &[".ts", ".tsx", ".rs"]) {
            if f.file_name().is_some_and(|n| n == "authz_inventory.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            for k in key_literals(&text) {
                seen.insert(k);
            }
        }
        let known: BTreeSet<String> = KEYS.iter().map(|k| k.key.to_string()).collect();
        let not_keys: BTreeSet<String> = NOT_STORAGE_KEYS.iter().map(|s| s.to_string()).collect();
        assert_eq!(known.len(), KEYS.len(), "a key is listed twice");
        let unclassified: Vec<_> = seen.difference(&known).filter(|k| !not_keys.contains(*k)).collect();
        let stale: Vec<_> = known.difference(&seen).collect();
        assert!(
            unclassified.is_empty(),
            "storage keys nobody has classified in authz_inventory.rs (add each with a Trust level and its consumers):\n{unclassified:#?}"
        );
        assert!(stale.is_empty(), "classified keys that no source file mentions any more:\n{stale:#?}");
    }

    #[test]
    fn the_keys_rust_reads_at_startup_are_high_or_medium_and_say_so() {
        for (key, why) in [
            (crate::allowed_folders::STORAGE_KEY, "allowed folders"),
            (crate::searxng::STORAGE_KEY, "SearXNG address"),
            (crate::halt::SHORTCUT_STORAGE_KEY, "stop key"),
        ] {
            let entry = KEYS.iter().find(|k| k.key == key).unwrap_or_else(|| panic!("{why} key {key} is not classified"));
            assert!(matches!(entry.trust, Trust::High | Trust::Medium), "{why} must be High or Medium");
            assert!(entry.consumers.starts_with("native-startup"), "{why} is read natively at launch; say so");
        }
    }

    #[test]
    fn the_keys_the_generic_store_refuses_are_exactly_the_natively_held_ones() {
        let mut refused: Vec<&str> = crate::storage::TRUST_KEYS.to_vec();
        refused.sort_unstable();
        let mut held: Vec<&str> = KEYS
            .iter()
            .filter(|k| k.consumers.starts_with("native-startup"))
            .map(|k| k.key)
            .collect();
        held.sort_unstable();
        assert_eq!(refused, held, "TRUST_KEYS in storage.rs and the inventory disagree");
    }

    #[test]
    fn no_typescript_source_writes_a_trust_key() {
        let root = repo_root();
        let dirs = [root.join("packages"), root.join("apps").join("web").join("src")];
        for f in files(&dirs, &[".ts", ".tsx"]) {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            for key in crate::storage::TRUST_KEYS {
                assert!(
                    !text.contains(&format!("'{key}'")) && !text.contains(&format!("\"{key}\"")),
                    "{} names the trust key {key}; only native code may",
                    f.display()
                );
            }
        }
    }

    #[test]
    fn every_key_that_changes_what_runs_or_where_data_goes_is_high() {
        for key in ["atlas.allowed-folders", "atlas.searxng-endpoint", "atlas.nova.account", "atlas.preferences", "atlas.watches", "routines.items"] {
            let k = KEYS.iter().find(|k| k.key == key).unwrap();
            assert_eq!(k.trust, Trust::High, "{key}");
        }
    }

    #[test]
    fn every_listed_bypass_is_a_real_command() {
        for (name, why) in BYPASSES {
            assert!(COMMANDS.iter().any(|(_, n, _)| n == name), "{name} is listed as a bypass but is not a command");
            assert!(!why.is_empty());
        }
    }
}
