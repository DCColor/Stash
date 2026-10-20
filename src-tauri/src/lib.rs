use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use chrono::{Datelike, Timelike};

#[derive(Default, Clone, serde::Serialize)]
struct ZipProgress {
    running: bool,
    done: bool,
    cancelled: bool,
    total_bytes: u64,
    written_bytes: u64,
    output_path: String,
    error: String,
}

struct ZipState(Arc<Mutex<ZipProgress>>);

fn path_size(p: &std::path::Path) -> u64 {
    let meta = match std::fs::symlink_metadata(p) { Ok(m) => m, Err(_) => return 0 };
    if meta.file_type().is_symlink() { return 0; }
    if meta.is_file() { return meta.len(); }
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(p) {
        for e in entries.flatten() {
            if e.file_name() == ".DS_Store" { continue; }
            total += path_size(&e.path());
        }
    }
    total
}

fn common_parent(paths: &[String]) -> Option<std::path::PathBuf> {
    let mut iter = paths.iter();
    let first = std::path::Path::new(iter.next()?).parent()?.to_path_buf();
    let mut common: Vec<_> = first.components().collect();
    for p in iter {
        let parent = std::path::Path::new(p).parent()?;
        let comps: Vec<_> = parent.components().collect();
        let n = common
            .iter()
            .zip(comps.iter())
            .take_while(|(a, b)| a == b)
            .count();
        common.truncate(n);
    }
    if common.is_empty() { return None; }
    Some(common.iter().collect())
}

fn collect_entries(path: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if path.file_name().map(|n| n == ".DS_Store").unwrap_or(false) { return; }
    out.push(path.to_path_buf());
    let meta = match std::fs::symlink_metadata(path) { Ok(m) => m, Err(_) => return };
    if meta.is_dir() {
        if let Ok(rd) = std::fs::read_dir(path) {
            let mut children: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            children.sort();
            for c in children { collect_entries(&c, out); }
        }
    }
}

fn dos_time(meta: &std::fs::Metadata) -> zip::DateTime {
    meta.modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Local>::from(t))
        .and_then(|dt| zip::DateTime::from_date_and_time(
            dt.year() as u16, dt.month() as u8, dt.day() as u8,
            dt.hour() as u8, dt.minute() as u8, dt.second() as u8,
        ).ok())
        .unwrap_or_default()
}

const CANCELLED: &str = "__cancelled__";

fn write_zip(
    shared: &std::sync::Arc<Mutex<ZipProgress>>,
    paths: &[String],
    base: &std::path::Path,
    dest: &str,
    skip: &[&std::path::Path],
) -> Result<(), String> {
    let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::with_capacity(1 << 20, file));

    let mut entries = Vec::new();
    for p in paths { collect_entries(std::path::Path::new(p), &mut entries); }
    // The archive may be written inside a folder being archived; never include it in itself
    entries.retain(|e| !skip.contains(&e.as_path()));

    let mut buf = vec![0u8; 1 << 20];
    let mut written: u64 = 0;

    for path in entries {
        if shared.lock().map(|s| s.cancelled).unwrap_or(false) {
            return Err(CANCELLED.into());
        }
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        let name = path.strip_prefix(base)
            .map_err(|_| format!("{} is outside the common parent", path.display()))?
            .to_string_lossy()
            .to_string();

        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .last_modified_time(dos_time(&meta))
            .unix_permissions(meta.permissions().mode() & 0o7777);

        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(&path).map_err(|e| e.to_string())?;
            zip.add_symlink(name, target.to_string_lossy(), opts).map_err(|e| e.to_string())?;
        } else if meta.is_dir() {
            zip.add_directory(name, opts).map_err(|e| e.to_string())?;
        } else {
            zip.start_file(name, opts.large_file(meta.len() >= 0xFFFF_FFFF))
                .map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                zip.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                written += n as u64;
                if let Ok(mut s) = shared.lock() {
                    s.written_bytes = written;
                    if s.cancelled { return Err(CANCELLED.into()); }
                }
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(
        source: *const std::os::raw::c_void,
        virtual_key: u16,
        key_down: bool,
    ) -> *mut std::os::raw::c_void;
    fn CGEventSetFlags(event: *mut std::os::raw::c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *mut std::os::raw::c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *mut std::os::raw::c_void);
}

#[tauri::command]
fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    unsafe { AXIsProcessTrusted() != 0 }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

#[tauri::command]
fn paste_to_frontmost() {
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(120));
            const KEY_V: u16 = 9;
            const FLAG_COMMAND: u64 = 0x00100000;
            const TAP_HID: u32 = 0;
            unsafe {
                let down = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_V, true);
                let up = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_V, false);
                if !down.is_null() && !up.is_null() {
                    CGEventSetFlags(down, FLAG_COMMAND);
                    CGEventSetFlags(up, FLAG_COMMAND);
                    CGEventPost(TAP_HID, down);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    CGEventPost(TAP_HID, up);
                    CFRelease(down);
                    CFRelease(up);
                }
            }
        });
    }
}

#[derive(serde::Serialize)]
struct FileDates {
    path: String,
    name: String,
    created: i64,
    modified: i64,
}

fn systime_to_secs(t: std::time::SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn get_file_dates(paths: Vec<String>) -> Vec<FileDates> {
    paths.iter().filter_map(|p| {
        let meta = std::fs::metadata(p).ok()?;
        if meta.is_dir() { return None; }
        let name = std::path::Path::new(p)
            .file_name()?
            .to_string_lossy()
            .to_string();
        Some(FileDates {
            path: p.clone(),
            name,
            created: meta.created().map(systime_to_secs).unwrap_or(0),
            modified: meta.modified().map(systime_to_secs).unwrap_or(0),
        })
    }).collect()
}

#[tauri::command]
fn list_folder_files(folder: String) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() {
                if let Some(n) = p.file_name() {
                    if n.to_string_lossy().starts_with('.') { continue; }
                }
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    out
}

#[cfg(target_os = "macos")]
fn set_attr_time(path: &str, attr: u32, secs: i64) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_void};

    #[repr(C)]
    struct Attrlist {
        bitmapcount: u16,
        reserved: u16,
        commonattr: u32,
        volattr: u32,
        dirattr: u32,
        fileattr: u32,
        forkattr: u32,
    }

    #[repr(C)]
    struct Timespec { tv_sec: i64, tv_nsec: i64 }

    extern "C" {
        fn setattrlist(
            path: *const c_char,
            attr_list: *mut c_void,
            attr_buf: *mut c_void,
            attr_buf_size: usize,
            options: u32,
        ) -> c_int;
    }

    let c_path = CString::new(path).map_err(|e| e.to_string())?;
    let mut list = Attrlist {
        bitmapcount: 5,
        reserved: 0,
        commonattr: attr,
        volattr: 0,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut ts = Timespec { tv_sec: secs, tv_nsec: 0 };

    let res = unsafe {
        setattrlist(
            c_path.as_ptr(),
            &mut list as *mut _ as *mut c_void,
            &mut ts as *mut _ as *mut c_void,
            std::mem::size_of::<Timespec>(),
            0,
        )
    };
    if res == 0 { Ok(()) } else {
        Err(format!("{}", std::io::Error::last_os_error()))
    }
}

#[tauri::command]
fn set_file_dates(path: String, created: Option<i64>, modified: Option<i64>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        const ATTR_CMN_CRTIME: u32 = 0x00000200;
        const ATTR_CMN_MODTIME: u32 = 0x00000400;
        if let Some(c) = created {
            set_attr_time(&path, ATTR_CMN_CRTIME, c)?;
        }
        if let Some(m) = modified {
            set_attr_time(&path, ATTR_CMN_MODTIME, m)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_frontmost_app() -> String {
    let output = std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"])
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => "Unknown".to_string(),
    }
}

#[tauri::command]
fn set_menu_bar_mode(app: tauri::AppHandle, enabled: bool) {
    #[cfg(target_os = "macos")]
    {
        if enabled {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        } else {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn start_zip(
    state: tauri::State<ZipState>,
    paths: Vec<String>,
    output: String,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No files selected".into());
    }
    {
        let s = state.0.lock().map_err(|e| e.to_string())?;
        if s.running {
            return Err("A zip is already running".into());
        }
    }

    let base = common_parent(&paths).ok_or("Could not determine a common parent folder")?;

    {
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        *s = ZipProgress {
            running: true,
            done: false,
            cancelled: false,
            total_bytes: 0,
            written_bytes: 0,
            output_path: output.clone(),
            error: String::new(),
        };
    }

    let shared = state.inner().0.clone();
    let paths_owned = paths.clone();
    std::thread::spawn(move || {
        let total: u64 = paths_owned.iter().map(|p| path_size(std::path::Path::new(p))).sum();
        if let Ok(mut s) = shared.lock() { s.total_bytes = total; }

        if shared.lock().map(|s| s.cancelled).unwrap_or(false) {
            if let Ok(mut s) = shared.lock() { s.running = false; s.done = true; }
            return;
        }

        let partial = format!("{}.stash-partial", output);
        let skip = [std::path::Path::new(&output), std::path::Path::new(&partial)];
        let result = write_zip(&shared, &paths_owned, &base, &partial, &skip);

        let mut final_error = String::new();
        match result {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&partial, &output) {
                    let _ = std::fs::remove_file(&partial);
                    final_error = format!("could not move archive into place: {}", e);
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&partial);
                if e != CANCELLED { final_error = e; }
            }
        }

        if let Ok(mut s) = shared.lock() {
            s.running = false;
            s.done = true;
            s.error = final_error;
            if s.error.is_empty() && !s.cancelled { s.written_bytes = s.total_bytes; }
        }
    });

    Ok(())
}

#[tauri::command]
fn get_zip_progress(state: tauri::State<ZipState>) -> ZipProgress {
    state.0.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
fn cancel_zip(state: tauri::State<ZipState>) {
    if let Ok(mut s) = state.0.lock() {
        if s.running {
            s.cancelled = true;
        }
    }
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ZipState(Arc::new(Mutex::new(ZipProgress::default()))))
        .invoke_handler(tauri::generate_handler![
            get_frontmost_app,
            set_menu_bar_mode,
            check_accessibility,
            open_accessibility_settings,
            paste_to_frontmost,
            get_file_dates,
            list_folder_files,
            set_file_dates,
            start_zip,
            get_zip_progress,
            cancel_zip,
            path_exists
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let settings_path = app.path().app_data_dir()
                    .unwrap_or_default()
                    .join("stash-settings.json");
                let menu_bar_mode = std::fs::read_to_string(&settings_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v.get("menuBarMode").and_then(|m| m.as_bool()))
                    .unwrap_or(false);
                if menu_bar_mode {
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }

            let quit = MenuItem::with_id(app, "quit", "Quit Stash", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Stash", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id == "quit" {
                        app.exit(0);
                    } else if event.id == "show" {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
