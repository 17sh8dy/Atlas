// Prevents a console window from appearing alongside the app on Windows
// release builds. Debug builds keep it, because that's where the logs go.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    atlas_desktop_lib::run()
}
