//! The desktop shell: a window, a tray icon, a global hotkey, autostart and updates.
//! All script work happens in the engine, a Bun process started here as a sidecar.

mod updates;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use updates::Updates;

/// Toggles the window from anywhere.
const HOTKEY: &str = "CommandOrControl+Shift+Space";

struct Running {
    /// Held so the engine's stdin stays open; the engine exits when it closes.
    child: CommandChild,
    pid: u32,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
struct Engine {
    /// `{ port, token, workspace }` once the engine prints YENAE_READY.
    info: Mutex<Option<serde_json::Value>>,
    running: Mutex<Option<Running>>,
    exited: Mutex<Option<Arc<AtomicBool>>>,
    /// How the last engine process ended (3: its port was taken).
    exit_code: Mutex<Option<i32>>,
    /// The engine's last messages, shown if it can't start (also kept in engine.log).
    log: Mutex<std::collections::VecDeque<String>>,
    /// Set when the engine couldn't be started after retrying.
    failed: Mutex<Option<String>>,
}

/// Where the window waits: starting, ready, or failed (with why and the engine's last words).
#[tauri::command]
fn engine_status(app: AppHandle) -> serde_json::Value {
    let e = app.state::<Engine>();
    let ready = e.info.lock().unwrap().is_some();
    let failed = e.failed.lock().unwrap().clone();
    let log: Vec<String> = e.log.lock().unwrap().iter().cloned().collect();
    serde_json::json!({
        "ready": ready,
        "failed": failed,
        "log": log,
        "version": app.package_info().version.to_string(),
        "logFile": app.path().app_data_dir().map(|d| d.join("engine.log").to_string_lossy().to_string()).unwrap_or_default(),
    })
}

/// "Try again" on the window's error: start the engine afresh.
#[tauri::command]
async fn restart_engine(app: AppHandle) {
    stop_engine(&app);
    start_engine_supervised(app).await;
}

/// Starts the engine and makes sure it comes up. If it exits because its port is taken
/// (an engine left over from before an update or a crash), that leftover is stopped and
/// it tries again; a slow first start (a virus scan of a freshly installed Bun) is waited for.
pub(crate) async fn start_engine_supervised(app: AppHandle) {
    let engine = app.state::<Engine>();
    *engine.failed.lock().unwrap() = None;
    for attempt in 1..=3 {
        start_engine(&app);
        let start = Instant::now();
        loop {
            if engine.info.lock().unwrap().is_some() {
                return;
            }
            if engine_exited(&app) || start.elapsed() > Duration::from_secs(45) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let code = *engine.exit_code.lock().unwrap();
        log_line(&app, &format!("engine didn't start (attempt {attempt}, exit {code:?})"));
        stop_engine(&app);
        // A leftover engine (from before an update or a crash) can hold the database or the
        // port: stop it whatever the error was.
        kill_stale_engines(&app);
        tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
    }
    let reason = {
        let log = engine.log.lock().unwrap();
        if log.iter().any(|l| l.contains("couldn't launch the engine")) {
            "Part of Yenae Script is missing or blocked. Download it again from the website and install it over this one.".to_string()
        } else {
            "The background engine didn't start.".to_string()
        }
    };
    *engine.failed.lock().unwrap() = Some(reason);
}

/// Stops engines this app started earlier that are still running (they hold its port).
fn kill_stale_engines(app: &AppHandle) {
    // Engines are recognised by the data folder they were given, wherever they were installed.
    let Ok(data) = app.path().app_data_dir() else { return };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ps = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object {{ $_.CommandLine -like '*main.js*--data*' -and $_.CommandLine.Contains('{}') }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            data.display().to_string().replace('\'', "''")
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps])
            .creation_flags(0x08000000) // no console window
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("pkill").args(["-f", &format!("main.js --data {}", data.display())]).status();
    }
    std::thread::sleep(Duration::from_millis(500));
}

/// Keeps the engine's last lines in memory and appends them to engine.log in the app's data folder.
fn log_line(app: &AppHandle, line: &str) {
    let e = app.state::<Engine>();
    {
        let mut log = e.log.lock().unwrap();
        log.push_back(line.to_string());
        while log.len() > 40 {
            log.pop_front();
        }
    }
    if let Ok(dir) = app.path().app_data_dir() {
        use std::io::Write;
        let path = dir.join("engine.log");
        // Keep the file small: start over past 1 MB.
        if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{} {line}", chrono_now());
        }
    }
}

/// Seconds since 1970, enough to order the log lines.
fn chrono_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub(crate) fn engine_info_value(app: &AppHandle) -> Option<serde_json::Value> {
    app.state::<Engine>().info.lock().unwrap().clone()
}

pub(crate) fn engine_exited(app: &AppHandle) -> bool {
    app.state::<Engine>().exited.lock().unwrap().as_ref().map(|e| e.load(Ordering::SeqCst)).unwrap_or(true)
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

#[tauri::command]
fn update_status(app: AppHandle) -> updates::Status {
    app.state::<Updates>().status(&app)
}

/// "Check for updates" in Settings. Returns whether one is ready.
#[tauri::command]
async fn check_updates(app: AppHandle) -> Result<bool, String> {
    updates::check(&app).await
}

/// "Restart to update": now, or as soon as nothing is running.
#[tauri::command]
async fn apply_update(app: AppHandle) -> Result<(), String> {
    updates::apply_when_idle(&app).await
}

/// The interface calls this once it has drawn, so a new version is known to work.
#[tauri::command]
fn ui_ready(app: AppHandle) {
    app.state::<Updates>().mark_ui_ready();
}

#[tauri::command]
fn dismiss_whats_new(app: AppHandle) {
    app.state::<Updates>().dismiss_whats_new();
    let _ = app.emit("update-status", app.state::<Updates>().status(&app));
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

/// Starts the engine from the active small update, or the one built into the app.
pub(crate) fn start_engine(app: &AppHandle) {
    if let Err(e) = try_start_engine(app) {
        // Couldn't even launch it (a missing or blocked file): say so and stop waiting for it.
        log_line(app, &format!("couldn't launch the engine: {e}"));
        let engine = app.state::<Engine>();
        *engine.info.lock().unwrap() = None;
        *engine.exit_code.lock().unwrap() = None;
        *engine.exited.lock().unwrap() = Some(Arc::new(AtomicBool::new(true)));
    }
}

fn try_start_engine(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let main_js = match app.state::<Updates>().engine_dir() {
        Some(dir) => dir.join("main.js"),
        None => app.path().resolve("engine/main.js", BaseDirectory::Resource)?,
    };
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
    let exited = Arc::new(AtomicBool::new(false));
    let engine = app.state::<Engine>();
    *engine.info.lock().unwrap() = None;
    *engine.exited.lock().unwrap() = Some(exited.clone());
    *engine.exit_code.lock().unwrap() = None;
    *engine.running.lock().unwrap() = Some(Running { pid: child.pid(), child, exited: exited.clone() });

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
                CommandEvent::Stderr(line) => {
                    let l = String::from_utf8_lossy(&line).trim_end().to_string();
                    eprintln!("engine: {l}");
                    log_line(&handle, &l);
                }
                CommandEvent::Terminated(p) => {
                    eprintln!("engine exited: {:?}", p.code);
                    *handle.state::<Engine>().exit_code.lock().unwrap() = p.code;
                    log_line(&handle, &format!("engine exited ({:?})", p.code));
                    exited.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
        }
        exited.store(true, Ordering::SeqCst);
    });
    Ok(())
}

/// Stops the engine and waits for it to go: closing its stdin makes it stop running
/// scripts and exit; if it hasn't after a few seconds, it is ended.
pub(crate) fn stop_engine(app: &AppHandle) {
    let engine = app.state::<Engine>();
    *engine.info.lock().unwrap() = None;
    let Some(Running { child, pid, exited }) = engine.running.lock().unwrap().take() else { return };
    drop(child);
    let start = Instant::now();
    while !exited.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(6) {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !exited.load(Ordering::SeqCst) {
        #[cfg(windows)]
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status();
        #[cfg(not(windows))]
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn quit(app: &AppHandle) {
    stop_engine(app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The interface is served from the active small update when there is one (see updates.rs).
    let mut context = tauri::generate_context!();
    let ui_dir = Arc::new(RwLock::new(None));
    let embedded = context.set_assets(Box::new(updates::NoAssets));
    context.set_assets(Box::new(updates::UiAssets { embedded, dir: ui_dir.clone() }));

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
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_status,
            restart_engine,
            set_attention,
            update_status,
            check_updates,
            apply_update,
            ui_ready,
            dismiss_whats_new
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Choose the version to run before anything loads.
            app.manage(Updates::new(&handle, ui_dir.clone()));

            tauri::async_runtime::spawn(start_engine_supervised(handle.clone()));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Yenae Script")
                .inner_size(1040.0, 700.0)
                .min_inner_size(360.0, 420.0)
                .visible(false)
                .center()
                .build()?;

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

            // Started at login: stay in the tray so schedules run without a window. After a
            // full update, reopen the way the app was before it.
            let hidden = updates::take_relaunch_hidden(&handle).unwrap_or_else(|| std::env::args().any(|a| a == "--hidden"));
            if !hidden {
                show_main(&handle);
            }

            tauri::async_runtime::spawn(updates::watch_startup(handle.clone()));
            tauri::async_runtime::spawn(updates::run(handle.clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app (and schedules) running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(context)
        .expect("error while running Yenae Script");
}
