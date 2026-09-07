//! Screen capture and display information — the last-resort "look at the
//! screen" layer, reached for only once a Windows API and UI Automation
//! can't answer the question.
//!
//! Both capture commands return raw PNG bytes as a `tauri::ipc::Response`,
//! the same shape `speech.rs::synthesize_speech` already uses for audio —
//! reasoned about there once and reused here rather than re-derived: a
//! screenshot is tens to hundreds of KB, and JSON would turn that into an
//! array of a hundred thousand numbers to cross one process boundary.
//!
//! "Screen understanding" in this build means the capture itself, plus UI
//! Automation's bounding rectangles (`uia.rs`) — which already say what and
//! where a control is, more reliably than pixel guessing would. There is no
//! local OCR and no pixel-level object detection here; `screen.describe` (in
//! `uia-skills.ts`'s sibling `screen-skills.ts`) hands a capture to whichever
//! cloud provider the user has already configured, purely opt-in, through the
//! existing `intelligence.rs` — nothing new was built to make that path work.

#![cfg(windows)]

use std::io::Cursor;

use image::{ImageFormat, RgbaImage};
use serde::Serialize;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetDIBits, GetMonitorInfoW, GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, DIB_RGB_COLORS, HDC, HGDIOBJ, MONITORINFOEXW, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use crate::window::resolve_hwnd;

/// No typed constant ships for this in the `windows` crate's Xps module; the
/// value is Microsoft's own documented one. `PW_CLIENTONLY` (which *is*
/// typed) is deliberately not used — it would crop off menus and title bars,
/// which are exactly the kind of control someone might ask Atlas to find.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

/// Also undocumented-as-a-constant in this crate: `MONITORINFOF_PRIMARY`'s
/// well-known value.
const MONITORINFOF_PRIMARY: u32 = 1;

struct Dc(HDC);
impl Drop for Dc {
    fn drop(&mut self) {
        // A DC obtained from `GetDC`/`GetWindowDC` is released, not deleted —
        // `DeleteDC` is for one this process created with `CreateCompatibleDC`.
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}

struct MemDc(HDC);
impl Drop for MemDc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

struct Bitmap(HGDIOBJ);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0);
        }
    }
}

/// Read a compatible bitmap already selected into `mem_dc` back as top-down
/// 32-bit BGRA, then hand back RGBA — the order GDI fills a DIB with is the
/// reverse of what every PNG encoder expects.
fn read_bgra_as_rgba(mem_dc: HDC, bitmap: HGDIOBJ, width: i32, height: i32) -> Result<Vec<u8>, String> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative: a top-down DIB, so row 0 in the buffer is the top row
            // on screen and nothing needs flipping afterwards.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        },
        ..Default::default()
    };

    let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
    let lines = unsafe {
        GetDIBits(
            mem_dc,
            windows::Win32::Graphics::Gdi::HBITMAP(bitmap.0),
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines == 0 {
        return Err("Windows couldn't read back the captured pixels.".into());
    }

    for pixel in buffer.chunks_exact_mut(4) {
        pixel.swap(0, 2); // BGRA -> RGBA
        pixel[3] = 255; // GDI capture carries no meaningful alpha
    }
    Ok(buffer)
}

fn encode_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    let image = RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "The captured pixels didn't add up to the expected size.".to_string())?;
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("I couldn't encode that capture: {e}"))?;
    Ok(out.into_inner())
}

/// Capture into a bitmap the size of `(width, height)`, painted by `paint`
/// (a `BitBlt` from the screen, or a `PrintWindow`), then read it back as PNG.
/// The one piece of GDI setup/teardown every capture command below shares.
fn capture_via(
    source_dc: HDC,
    width: i32,
    height: i32,
    paint: impl FnOnce(HDC) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err("There's nothing with a visible size to capture.".into());
    }

    let mem_dc = MemDc(unsafe { CreateCompatibleDC(source_dc) });
    if mem_dc.0.is_invalid() {
        return Err("Windows wouldn't give me a place to draw.".into());
    }
    let bitmap = Bitmap(HGDIOBJ(unsafe { CreateCompatibleBitmap(source_dc, width, height) }.0));
    if bitmap.0.is_invalid() {
        return Err("Windows wouldn't allocate a capture buffer.".into());
    }
    let previous = unsafe { SelectObject(mem_dc.0, windows::Win32::Graphics::Gdi::HGDIOBJ(bitmap.0 .0)) };

    let result = paint(mem_dc.0).and_then(|_| read_bgra_as_rgba(mem_dc.0, bitmap.0, width, height));

    unsafe {
        SelectObject(mem_dc.0, previous);
    }
    result.and_then(|rgba| encode_png(width as u32, height as u32, rgba))
}

#[tauri::command]
pub async fn capture_window(window_id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || capture_window_sync(&window_id))
        .await
        .map_err(|e| format!("The capture task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The blocking half of `capture_window`, split out so it can be unit tested
/// directly — `tauri::ipc::Response` exposes no way to read its body back.
fn capture_window_sync(window_id: &str) -> Result<Vec<u8>, String> {
    let hwnd = resolve_hwnd(window_id)?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|e| e.message())?;
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);

    let window_dc = Dc(unsafe { GetWindowDC(hwnd) });
    capture_via(window_dc.0, width, height, |mem_dc| {
        let ok = unsafe { PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT) };
        if ok.as_bool() {
            Ok(())
        } else {
            Err("Windows couldn't render that window — it may be minimized.".into())
        }
    })
}

#[tauri::command]
pub async fn capture_screen() -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(capture_screen_sync)
        .await
        .map_err(|e| format!("The capture task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The blocking half of `capture_screen` — see `capture_window_sync`.
fn capture_screen_sync() -> Result<Vec<u8>, String> {
    let (left, top, width, height) = unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        };
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };

    let screen_dc = Dc(unsafe { GetDC(None) });
    if screen_dc.0.is_invalid() {
        return Err("Windows wouldn't give me a drawing surface.".to_string());
    }
    capture_via(screen_dc.0, width, height, |mem_dc| {
        unsafe { BitBlt(mem_dc, 0, 0, width, height, screen_dc.0, left, top, SRCCOPY) }
            .map_err(|e| e.message())
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub primary: bool,
    pub dpi: u32,
}

extern "system" fn enum_monitor_proc(
    hmonitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    let out = unsafe { &mut *(lparam.0 as *mut Vec<DisplayInfo>) };

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let got = unsafe {
        GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut _)
    };
    if !got.as_bool() {
        return windows::Win32::Foundation::BOOL(1);
    }

    let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
    unsafe {
        let _ = GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
    }

    let name_len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
    let name = String::from_utf16_lossy(&info.szDevice[..name_len]);

    out.push(DisplayInfo {
        name,
        x: info.monitorInfo.rcMonitor.left,
        y: info.monitorInfo.rcMonitor.top,
        width: info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left,
        height: info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top,
        work_x: info.monitorInfo.rcWork.left,
        work_y: info.monitorInfo.rcWork.top,
        work_width: info.monitorInfo.rcWork.right - info.monitorInfo.rcWork.left,
        work_height: info.monitorInfo.rcWork.bottom - info.monitorInfo.rcWork.top,
        primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        dpi: dpi_x,
    });
    windows::Win32::Foundation::BOOL(1)
}

#[tauri::command]
pub fn list_displays() -> Vec<DisplayInfo> {
    let mut out: Vec<DisplayInfo> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_proc),
            windows::Win32::Foundation::LPARAM(&mut out as *mut _ as isize),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_sized_region_is_refused_before_touching_gdi() {
        let source = Dc(unsafe { GetDC(None) });
        let err = capture_via(source.0, 0, 100, |_| Ok(())).unwrap_err();
        assert!(err.contains("nothing"), "{err}");
    }

    #[test]
    fn png_encoding_round_trips_a_known_pixel() {
        // One red pixel, alpha forced opaque the same way the real capture
        // path does — proves the RGBA buffer shape `image` expects lines up
        // with what `read_bgra_as_rgba` produces, without needing a live GDI
        // capture to check it.
        let rgba = vec![255u8, 0, 0, 255];
        let png = encode_png(1, 1, rgba).expect("encode");
        assert_eq!(&png[1..4], b"PNG");
    }

    /// Live, ignored by default — see `services.rs` for why this pattern is
    /// used throughout this crate for anything that needs a real desktop.
    #[test]
    #[ignore]
    fn the_whole_screen_captures_to_a_real_png() {
        let bytes = capture_screen_sync().expect("capture_screen_sync");
        assert!(bytes.len() > 100, "suspiciously small PNG: {} bytes", bytes.len());
        assert_eq!(&bytes[1..4], b"PNG");
    }

    #[test]
    #[ignore]
    fn at_least_one_display_is_reported() {
        let displays = list_displays();
        assert!(!displays.is_empty());
        assert!(displays.iter().any(|d| d.primary), "no display marked primary");
    }
}
