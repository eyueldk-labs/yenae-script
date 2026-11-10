//! The desktop shell: a window, a tray icon, a global hotkey and autostart.
//! All script work happens in the engine, a Bun process started here as a sidecar.

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Toggles the window from anywhere.
const HOTKEY: &str = "CommandOrControl+Shift+Space";

#[derive(Default)]
struct Engine {
    /// `{ port, token, workspace }` once the engine prints YENAE_READY.
    info: Mutex<Option<serde_json::Value>>,
    /// Held so the engine's stdin stays open; the engine exits when it closes.
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn engine_info(engine: tauri::State<Engine>) -> Option<serde_json::Value> {
    engine.info.lock().unwrap().clone()
}

/// The UI reports how many runs need the user (questions waiting, schedules failing),
/// so the tray says so while the window is hidden.
#[tauri::command]
fn set_attention(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("tray") {
        let tip = match count {
            0 => "Yenae Script".to_string(),
            1 => "Yenae Script: 1 needs you".to_string(),
            n => format!("Yenae Script: {n} need you"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Lets the UI put the cursor in search, so the hotkey works as a launcher.
        let _ = w.emit("shown", ());
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

fn start_engine(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let main_js = app.path().resolve("engine/main.js", BaseDirectory::Resource)?;
    let (mut rx, child) = app
        .shell()
        .sidecar("bun")?
        .args([
            main_js.to_string_lossy().to_string(),
            "--data".into(),
            data.to_string_lossy().to_string(),
            "--exit-with-stdin".into(),
        ])
        .spawn()?;
    *app.state::<Engine>().child.lock().unwrap() = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(json) = line.trim().strip_prefix("YENAE_READY ") {
                        if let Ok(v) = serde_json::from_str(json) {
                            *handle.state::<Engine>().info.lock().unwrap() = Some(v);
                        }
                    }
                }
                CommandEvent::Stderr(line) => eprintln!("engine: {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Terminated(p) => eprintln!("engine exited: {:?}", p.code),
                _ => {}
            }
        }
    });
    Ok(())
}

/// Closing the engine's stdin makes it stop running scripts and exit.
fn stop_engine(app: &AppHandle) {
    drop(app.state::<Engine>().child.lock().unwrap().take());
    std::thread::sleep(std::time::Duration::from_millis(400));
}

fn quit(app: &AppHandle) {
    stop_engine(app);
    app.exit(0);
}

/// A newer version, if there is one: `{ version, notes }`.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| serde_json::json!({ "version": u.version, "notes": u.body })))
}

/// Downloads and installs the newest version, then starts it. The engine stops first so the
/// installer can replace its files (on Windows a running bun.exe would be locked).
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("You already have the latest version.")?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    stop_engine(&app);
    // On Windows this hands over to the installer, which closes the app and reopens it.
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running app instead of starting another engine.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![engine_info, set_attention, check_update, install_update])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = start_engine(&handle) {
                eprintln!("could not start engine: {e}");
            }

            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit_item])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Yenae Script")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Err(e) = app.global_shortcut().register(HOTKEY) {
                eprintln!("hotkey {HOTKEY} unavailable: {e}");
            }

            // Started at login: stay in the tray so schedules run without a window.
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app (and schedules) running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Yenae Script");
}
