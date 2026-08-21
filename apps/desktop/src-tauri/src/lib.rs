//! Atlas desktop — the Tauri shell.
//!
//! Thin by design. The assistant's intelligence lives in `@atlas/engine`, which
//! is platform-agnostic TypeScript; this crate exists to give that engine hands
//! (the commands in `platform.rs`) and a body (a window that appears the
//! instant you ask for it).
//!
//! The one genuinely native idea here is summoning. An assistant you have to go
//! and find is a program; one that arrives on a keystroke, over whatever you
//! were doing, is an assistant. That is what the global shortcut and the
//! hide-on-blur behaviour below are for.

mod intelligence;
#[cfg(windows)]
mod listen;
#[cfg(windows)]
mod os;
mod platform;
#[cfg(windows)]
mod speech;
mod storage;
mod web;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use storage::StorageState;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

/// Bring Atlas to the front, focused and ready to type into.
fn summon(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // The renderer focuses the input itself — it knows whether a
        // conversation is already in progress and where the caret belongs.
        let _ = window.emit("atlas://summoned", ());
    }
}

fn dismiss(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    summon(&app);
}

#[tauri::command]
fn hide_window(app: tauri::AppHandle) {
    dismiss(&app);
}

#[tauri::command]
fn toggle_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => dismiss(&app),
            _ => summon(&app),
        }
    }
}

/// What this build of Atlas can actually do.
///
/// Reported rather than inferred, so the engine hides skills it cannot run
/// instead of offering them and failing. The desktop build has everything; the
/// browser build answers this very differently.
///
/// `speech` and `listening` are the conditional entries: each is reported only
/// when its engine and model are really on disk. Capability absence is data
/// here, not an exception — the registry hides skills whose capabilities are
/// missing, so a build without the voice files is honestly quieter, and one
/// without the listening files honestly deaf, rather than subtly broken.
#[tauri::command]
fn capabilities(app: tauri::AppHandle) -> Vec<&'static str> {
    let mut names = vec![
        "files",
        "fs",
        "apps",
        "system",
        "processes",
        "clipboard",
        "notifications",
        "os",
        "windows",
        "network",
    ];
    if speech::available(&app) {
        names.push("speech");
    }
    if listen::available(&app) {
        names.push("listening");
    }
    names
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ctrl+Space: the summon key. Chosen because it is almost universally free
    // and is already muscle memory for "bring up the thing that helps me".
    let summon_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // Fire on press only; without this the key repeats toggle
                    // the window on the way down *and* the way up.
                    if event.state() == ShortcutState::Pressed && shortcut == &summon_shortcut {
                        if let Some(window) = app.get_webview_window("main") {
                            match window.is_visible() {
                                Ok(true) => dismiss(app),
                                _ => summon(app),
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            capabilities,
            show_window,
            hide_window,
            toggle_window,
            platform::search_files,
            platform::open_path,
            platform::reveal_path,
            platform::open_url,
            platform::system_info,
            platform::running_processes,
            platform::list_apps,
            platform::launch_app,
            platform::create_file,
            platform::create_folder,
            platform::rename_path,
            platform::move_path,
            platform::copy_path,
            platform::delete_path,
            platform::read_text_file,
            platform::open_system_tool,
            platform::path_info,
            platform::append_file,
            platform::list_dir,
            platform::known_folder,
            os::lock_workstation,
            os::power_action,
            os::media_key,
            os::set_volume,
            os::toggle_mute,
            os::display_off,
            os::empty_recycle_bin,
            speech::speech_voices,
            speech::synthesize_speech,
            listen::transcribe_speech,
            web::web_search,
            web::fetch_page,
            intelligence::ask_claude,
            intelligence::ask_openai,
            storage::storage_get,
            storage::storage_set,
            storage::storage_remove,
        ])
        .manage(StorageState(std::sync::Mutex::new(())))
        .setup(move |app| {
            app.global_shortcut().register(summon_shortcut)?;

            // A tray icon, because an assistant that only exists while its
            // window is open isn't resident — it's just an app you closed.
            let show = MenuItem::with_id(app, "show", "Open Atlas", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Atlas — Ctrl+Space")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => summon(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window puts Atlas away rather than quitting it. The
            // engine keeps its memory and the summon key keeps working, which
            // is what "resident" means in practice.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Atlas");
}

use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri::Emitter;
