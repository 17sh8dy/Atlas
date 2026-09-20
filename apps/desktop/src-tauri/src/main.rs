// Prevents a console window from appearing alongside the app on Windows
// release builds. Debug builds keep it, because that's where the logs go.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The updater re-runs this same executable as a short-lived helper that
    // replaces the program once the app has quit. That is all it does.
    #[cfg(windows)]
    if atlas_desktop_lib::updater::maybe_run_helper() {
        return;
    }
    atlas_desktop_lib::run()
}
