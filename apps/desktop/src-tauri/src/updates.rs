//! Updates, in two sizes.
//!
//! **Small** (most releases): the engine and the interface, a signed zip of about a megabyte.
//! It unpacks into `<app data>/bundles/<version>/` and the app switches to it without
//! reinstalling: the engine restarts from the new folder and the window reloads its
//! interface from there (see [`UiAssets`]). If the new version doesn't come up, the app goes
//! back to the one before and remembers not to try it again.
//!
//! **Full**: when the shell itself changed (this Rust code, its config, the bundled Bun), the
//! normal installer runs quietly and reopens the app.
//!
//! Which one applies is decided by the shell ID (`scripts/shell-id.ts`): a release's small
//! update is listed under `bundle-<shell id>`, so only apps with that exact shell find it.
//!
//! Neither ever interrupts: both download in the background, and they apply when nothing is
//! running and no schedule is due — straight away while the window is hidden in the tray,
//! or when the person presses "Restart to update".

use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    AppHandle, Emitter, Manager, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

/// This shell's fingerprint, written by `scripts/prepare.ts`.
pub const SHELL_ID: &str = include_str!("../shell-id.txt");

/// Where each release lists its small update (one entry per shell ID).
const BUNDLE_FEED: &str = "https://github.com/eyueldk-labs/yenae-script/releases/latest/download/bundle.json";

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const FIRST_CHECK: Duration = Duration::from_secs(20);

/// Debug builds can point at a local feed and check quickly, for testing updates:
/// YENAE_BUNDLE_FEED=http://127.0.0.1:8787/bundle.json YENAE_CHECK_SECS=10
fn bundle_feed() -> String {
    #[cfg(debug_assertions)]
    if let Ok(f) = std::env::var("YENAE_BUNDLE_FEED") {
        return f;
    }
    BUNDLE_FEED.to_string()
}

fn check_every() -> (Duration, Duration) {
    #[cfg(debug_assertions)]
    if let Some(s) = std::env::var("YENAE_CHECK_SECS").ok().and_then(|s| s.parse().ok()) {
        return (Duration::from_secs(s), Duration::from_secs(s));
    }
    (FIRST_CHECK, CHECK_EVERY)
}
const ENGINE_START_TIMEOUT: Duration = Duration::from_secs(30);
const UI_START_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Serving the interface from the active bundle

/// Serves the interface from the active bundle's `ui/` folder, or the one built into the app.
pub struct UiAssets {
    pub embedded: Box<dyn tauri::Assets<Wry>>,
    pub dir: Arc<RwLock<Option<PathBuf>>>,
}

impl tauri::Assets<Wry> for UiAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(dir) = self.dir.read().unwrap().as_ref() {
            let rel = key.as_ref().trim_start_matches('/');
            if rel.split(['/', '\\']).any(|p| p == "..") {
                return None;
            }
            // A bundle is complete on its own: never mix in files from another version.
            return std::fs::read(dir.join(rel)).ok().map(Cow::Owned);
        }
        self.embedded.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

/// Holds the place while the real assets are being wrapped.
pub struct NoAssets;
impl tauri::Assets<Wry> for NoAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// ---------------------------------------------------------------------------
// State

/// `bundles/current.json`: the small update in use, and the one before it (for going back).
#[derive(Serialize, Deserialize, Clone, Default)]
struct Current {
    version: Option<String>,
    previous: Option<String>,
}

/// `bundles/<version>/manifest.json`, inside every small update.
#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(rename = "shellId")]
    shell_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WhatsNew {
    pub version: String,
    pub notes: String,
}

enum Ready {
    Small { version: String, notes: String },
    Full { version: String, notes: String, update: Update, bytes: Arc<Vec<u8>> },
}

impl Ready {
    fn version(&self) -> &str {
        match self {
            Ready::Small { version, .. } | Ready::Full { version, .. } => version,
        }
    }
}

#[derive(Default)]
struct St {
    /// The small update in use, if any (otherwise the version built into the app).
    active: Option<String>,
    ready: Option<Ready>,
    /// The person pressed "Restart to update" while something was running.
    waiting: bool,
    applying: bool,
    checking: bool,
    /// An update that failed to apply (shown at the top).
    error: Option<String>,
    /// The last check failed, e.g. offline (shown only in Settings).
    check_error: Option<String>,
    last_check: Option<Instant>,
}

pub struct Updates {
    root: PathBuf,
    pub ui_dir: Arc<RwLock<Option<PathBuf>>>,
    st: Mutex<St>,
    ui_ready: AtomicBool,
}

/// What the interface shows.
#[derive(Serialize, Clone)]
pub struct Status {
    version: String,
    ready: Option<String>,
    full: bool,
    notes: Option<String>,
    waiting: bool,
    applying: bool,
    checking: bool,
    error: Option<String>,
    #[serde(rename = "checkError")]
    check_error: Option<String>,
    #[serde(rename = "whatsNew")]
    whats_new: Option<WhatsNew>,
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

fn write_json<T: Serialize>(p: &Path, v: &T) {
    if let Ok(b) = serde_json::to_vec_pretty(v) {
        let tmp = p.with_extension("tmp");
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, p);
        }
    }
}

fn newer(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

impl Updates {
    /// Picks the interface and engine to start with: the newest good small update that is
    /// newer than the app itself, else the built-in one.
    pub fn new(app: &AppHandle, ui_dir: Arc<RwLock<Option<PathBuf>>>) -> Self {
        let root = app.path().app_data_dir().unwrap_or_default().join("bundles");
        let _ = std::fs::create_dir_all(&root);
        let shell_version = app.package_info().version.to_string();
        let current: Current = read_json(&root.join("current.json")).unwrap_or_default();
        let bad = read_json::<Vec<String>>(&root.join("bad.json")).unwrap_or_default();

        let usable = |v: &Option<String>| {
            v.as_ref()
                .filter(|v| newer(v, &shell_version) && !bad.contains(v) && bundle_ok(&root.join(v)))
                .cloned()
        };
        let active = usable(&current.version).or_else(|| usable(&current.previous));
        if active.is_none() {
            // A full update brought the app past every small update: clear them out.
            clean(&root, &[]);
            let _ = std::fs::remove_file(root.join("current.json"));
        }
        *ui_dir.write().unwrap() = active.as_ref().map(|v| root.join(v).join("ui"));
        Updates { root, ui_dir, st: Mutex::new(St { active, ..Default::default() }), ui_ready: AtomicBool::new(false) }
    }

    /// The engine folder to run: the active small update's, or `None` for the built-in one.
    pub fn engine_dir(&self) -> Option<PathBuf> {
        self.st.lock().unwrap().active.as_ref().map(|v| self.root.join(v).join("engine"))
    }

    pub fn mark_ui_ready(&self) {
        self.ui_ready.store(true, Ordering::SeqCst);
    }

    pub fn status(&self, app: &AppHandle) -> Status {
        let st = self.st.lock().unwrap();
        let version = st.active.clone().unwrap_or_else(|| app.package_info().version.to_string());
        let whats_new = read_json::<WhatsNew>(&self.root.join("whats-new.json")).filter(|w| w.version == version);
        let (ready, full, notes) = match &st.ready {
            Some(Ready::Small { version, notes }) => (Some(version.clone()), false, Some(notes.clone())),
            Some(Ready::Full { version, notes, .. }) => (Some(version.clone()), true, Some(notes.clone())),
            None => (None, false, None),
        };
        Status {
            version,
            ready,
            full,
            notes,
            waiting: st.waiting,
            applying: st.applying,
            checking: st.checking,
            error: st.error.clone(),
            check_error: st.check_error.clone(),
            whats_new,
        }
    }

    pub fn dismiss_whats_new(&self) {
        let _ = std::fs::remove_file(self.root.join("whats-new.json"));
        self.st.lock().unwrap().error = None;
    }

    fn bad(&self) -> Vec<String> {
        read_json(&self.root.join("bad.json")).unwrap_or_default()
    }

    fn mark_bad(&self, version: &str) {
        let mut bad = self.bad();
        if !bad.iter().any(|b| b == version) {
            bad.push(version.to_string());
        }
        write_json(&self.root.join("bad.json"), &bad);
    }
}

/// A bundle folder has what it needs to run, and was made for this shell.
fn bundle_ok(dir: &Path) -> bool {
    dir.join("engine").join("main.js").is_file()
        && dir.join("ui").join("index.html").is_file()
        && read_json::<Manifest>(&dir.join("manifest.json")).is_some_and(|m| m.shell_id == SHELL_ID.trim())
}

/// Removes bundle folders other than `keep`.
fn clean(root: &Path, keep: &[&str]) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_dir() && !keep.contains(&name.as_str()) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

fn emit(app: &AppHandle) {
    let u = app.state::<Updates>();
    let _ = app.emit("update-status", u.status(app));
}

fn set_error(app: &AppHandle, e: Option<String>) {
    app.state::<Updates>().st.lock().unwrap().error = e;
    emit(app);
}

// ---------------------------------------------------------------------------
// Checking and downloading

/// Looks for a newer version and downloads it in the background. Returns whether one is ready.
pub async fn check(app: &AppHandle) -> Result<bool, String> {
    let u = app.state::<Updates>();
    {
        let mut st = u.st.lock().unwrap();
        if st.checking || st.applying {
            return Ok(st.ready.is_some());
        }
        st.checking = true;
        st.last_check = Some(Instant::now());
    }
    emit(app);
    let result = check_inner(app).await;
    if let Err(e) = &result {
        eprintln!("update check: {e}");
    }
    {
        let mut st = u.st.lock().unwrap();
        st.checking = false;
        st.check_error = result.as_ref().err().cloned();
    }
    emit(app);
    result
}

async fn check_inner(app: &AppHandle) -> Result<bool, String> {
    let u = app.state::<Updates>();
    let current = u.status(app).version;
    if let Some(r) = &u.st.lock().unwrap().ready {
        if !newer(r.version(), &current) {
            return Ok(true);
        }
    }
    let bad = u.bad();

    // 1. A small update made for this exact shell.
    let cur = Version::parse(&current).map_err(|e| e.to_string())?;
    let (cur2, bad2) = (cur.clone(), bad.clone());
    let small = app
        .updater_builder()
        .endpoints(vec![tauri::Url::parse(&bundle_feed()).map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?
        .target(format!("bundle-{}", SHELL_ID.trim()))
        .version_comparator(move |_, r| r.version > cur2 && !bad2.contains(&r.version.to_string()))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await;
    match small {
        Ok(Some(up)) => {
            // The signature is checked by download().
            let bytes = up.download(|_, _| {}, || {}).await.map_err(|e| format!("download: {e}"))?;
            let version = up.version.clone();
            if let Err(e) = unpack(&u.root, &version, &bytes) {
                // Don't fetch the same broken download again and again.
                u.mark_bad(&version);
                return Err(e);
            }
            let notes = up.body.clone().unwrap_or_default();
            u.st.lock().unwrap().ready = Some(Ready::Small { version, notes });
            return Ok(true);
        }
        // Up to date (the latest release is the one in use).
        Ok(None) => return Ok(false),
        // No small update for this shell (or the feed is missing): look for the full one.
        Err(e) => eprintln!("small update: {e}"),
    }

    // 2. The full installer.
    let full = app
        .updater_builder()
        .version_comparator(move |_, r| r.version > cur && !bad.contains(&r.version.to_string()))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(up) = full else { return Ok(false) };
    let bytes = up.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let notes = up.body.clone().unwrap_or_default();
    u.st.lock().unwrap().ready = Some(Ready::Full { version: up.version.clone(), notes, update: up, bytes: Arc::new(bytes) });
    Ok(true)
}

/// Unpacks a small update into `root/<version>`, checking it is the version announced and
/// made for this shell.
fn unpack(root: &Path, version: &str, bytes: &[u8]) -> Result<(), String> {
    let part = root.join(format!("{version}.part"));
    let _ = std::fs::remove_dir_all(&part);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    zip.extract(&part).map_err(|e| e.to_string())?;
    let m: Manifest = read_json(&part.join("manifest.json")).ok_or("The update is missing its manifest.")?;
    if m.version != version || m.shell_id != SHELL_ID.trim() || !bundle_ok(&part) {
        let _ = std::fs::remove_dir_all(&part);
        return Err("The update doesn't match this app.".into());
    }
    let dest = root.join(version);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Applying

/// Asks the engine whether a restart would interrupt anything.
fn engine_busy(app: &AppHandle) -> bool {
    let Some(info) = crate::engine_info_value(app) else { return false };
    let (Some(port), Some(token)) = (info["port"].as_u64(), info["token"].as_str()) else { return true };
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port as u16).into(), Duration::from_secs(3)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!("GET /api/busy HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return true;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("");
    // An engine too old to answer is treated as busy: only the person can say "go".
    serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["busy"].as_bool()).unwrap_or(true)
}

fn window_hidden(app: &AppHandle) -> bool {
    app.get_webview_window("main").map(|w| !w.is_visible().unwrap_or(false)).unwrap_or(true)
}

/// The person pressed "Restart to update": now if nothing is running, else as soon as it isn't.
pub async fn apply_when_idle(app: &AppHandle) -> Result<(), String> {
    if engine_busy(app) {
        app.state::<Updates>().st.lock().unwrap().waiting = true;
        emit(app);
        return Ok(());
    }
    apply(app).await
}

async fn apply(app: &AppHandle) -> Result<(), String> {
    let u = app.state::<Updates>();
    let ready = {
        let mut st = u.st.lock().unwrap();
        if st.applying {
            return Ok(());
        }
        let Some(r) = st.ready.take() else { return Ok(()) };
        st.applying = true;
        st.waiting = false;
        r
    };
    emit(app);
    let result = match ready {
        Ready::Small { version, notes } => apply_small(app, &version, &notes).await,
        Ready::Full { version, notes, update, bytes } => {
            write_json(&u.root.join("whats-new.json"), &WhatsNew { version, notes });
            // Reopen the way it is now: hidden in the tray, or with the window showing.
            write_json(&u.root.join("relaunch.json"), &serde_json::json!({ "hidden": window_hidden(app) }));
            crate::stop_engine(app);
            // On Windows this hands over to the installer, which reopens the app when done.
            match update.install(bytes.as_slice()) {
                Ok(()) => app.restart(),
                Err(e) => {
                    crate::start_engine(app);
                    Err(e.to_string())
                }
            }
        }
    };
    u.st.lock().unwrap().applying = false;
    if let Err(e) = &result {
        set_error(app, Some(format!("Couldn't update: {e}")));
    }
    emit(app);
    result
}

/// Switches to a downloaded small update, going back if it doesn't come up.
async fn apply_small(app: &AppHandle, version: &str, notes: &str) -> Result<(), String> {
    let u = app.state::<Updates>();
    let previous = u.st.lock().unwrap().active.clone();
    switch_to(app, Some(version)).await;
    if !came_up(app).await {
        u.mark_bad(version);
        switch_to(app, previous.as_deref()).await;
        let _ = std::fs::remove_dir_all(u.root.join(version));
        return Err(format!("{version} didn't start, so the app went back to the version you had"));
    }
    write_json(&u.root.join("current.json"), &Current { version: Some(version.to_string()), previous: previous.clone() });
    write_json(&u.root.join("whats-new.json"), &WhatsNew { version: version.to_string(), notes: notes.to_string() });
    let keep: Vec<&str> = [Some(version), previous.as_deref()].into_iter().flatten().collect();
    clean(&u.root, &keep);
    Ok(())
}

/// Restarts the engine and reloads the window on `version` (`None`: the built-in one).
async fn switch_to(app: &AppHandle, version: Option<&str>) {
    let u = app.state::<Updates>();
    crate::stop_engine(app);
    u.st.lock().unwrap().active = version.map(str::to_string);
    *u.ui_dir.write().unwrap() = version.map(|v| u.root.join(v).join("ui"));
    u.ui_ready.store(false, Ordering::SeqCst);
    crate::start_engine(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("location.reload()");
    }
}

/// Waits for the engine to say it is listening and the interface to say it has drawn.
async fn came_up(app: &AppHandle) -> bool {
    let start = Instant::now();
    while crate::engine_info_value(app).is_none() {
        if start.elapsed() > ENGINE_START_TIMEOUT || crate::engine_exited(app) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let u = app.state::<Updates>();
    let start = Instant::now();
    while !u.ui_ready.load(Ordering::SeqCst) {
        if start.elapsed() > UI_START_TIMEOUT {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    true
}

/// At start, a small update gets the same check as when it was applied: if it doesn't come
/// up, go back to the version before it (or the built-in one) and don't use it again.
pub async fn watch_startup(app: AppHandle) {
    let u = app.state::<Updates>();
    let Some(version) = u.st.lock().unwrap().active.clone() else { return };
    if came_up(&app).await {
        return;
    }
    u.mark_bad(&version);
    let current: Current = read_json(&u.root.join("current.json")).unwrap_or_default();
    let back = current.previous.filter(|p| p != &version && bundle_ok(&u.root.join(p)));
    write_json(&u.root.join("current.json"), &Current { version: back.clone(), previous: None });
    switch_to(&app, back.as_deref()).await;
    set_error(&app, Some(format!("{version} didn't start, so the app went back to the version you had")));
}

/// Checks a little after start and every few hours; applies a ready update as soon as nothing
/// is running, by itself while the window is hidden, or when the person asked.
pub async fn run(app: AppHandle) {
    let (first, every) = check_every();
    tokio::time::sleep(first).await;
    loop {
        let due = {
            let st = app.state::<Updates>().st.lock().unwrap().last_check;
            st.map(|t| t.elapsed() >= every).unwrap_or(true)
        };
        if due {
            let _ = check(&app).await;
        }
        let (ready, waiting) = {
            let u = app.state::<Updates>();
            let st = u.st.lock().unwrap();
            (st.ready.is_some(), st.waiting)
        };
        if ready && (waiting || window_hidden(&app)) && !engine_busy(&app) {
            let _ = apply(&app).await;
        }
        tokio::time::sleep(Duration::from_secs(60).min(every)).await;
    }
}

/// After a full update: open hidden if the app was hidden when it updated.
pub fn take_relaunch_hidden(app: &AppHandle) -> Option<bool> {
    let p = app.path().app_data_dir().ok()?.join("bundles").join("relaunch.json");
    let v: serde_json::Value = read_json(&p)?;
    let _ = std::fs::remove_file(&p);
    v["hidden"].as_bool()
}
