use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

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
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        } else {
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_frontmost_app, set_menu_bar_mode])
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
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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
