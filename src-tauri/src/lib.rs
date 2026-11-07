//! Markydowny desktop shell.
//!
//! The UI is the same static web app that powers markydowny.com. This crate
//! adds what a native document viewer needs on top of it:
//!
//! * opening `.md` files from Finder (double-click / "Open With"), the Dock,
//!   File > Open… or the command line, one window per document;
//! * grouping those windows as native macOS tabs (see `tabs`);
//! * reading files and folders by path, so relative images resolve;
//! * scoped access to local images through Tauri's asset protocol.

mod crash_reporting;
mod docs;
mod tabs;

pub use crash_reporting::start as start_crash_reporting;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use docs::{DocumentRouter, Placement};
use serde::Serialize;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW: &str = "main";
const OPEN_MENU_ID: &str = "open-document";
const NEW_TAB_MENU_ID: &str = "new-tab";
const PENDING_EVENT: &str = "document-pending";
const MAX_DOCUMENT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Default)]
struct AppState {
    router: Mutex<DocumentRouter>,
    /// Files macOS asked us to open before setup finished.
    launch: Mutex<tabs::LaunchQueue>,
    /// Which document each window shows, for tab titles.
    open_documents: Mutex<tabs::OpenDocuments>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Document {
    path: String,
    name: String,
    /// Parent directory with a trailing `/`, used to resolve relative links.
    dir: String,
    content: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MarkdownEntry {
    path: String,
    /// Path shown in the file picker, relative to what was dropped.
    display: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Hands the calling window the document Finder/Dock/menu routed to it, if any.
#[tauri::command]
fn take_pending_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<Document>, String> {
    let pending = state.router.lock().unwrap().take_pending(window.label());
    pending.map(|path| read_document_at(&path)).transpose()
}

/// Reads a document for display in the calling window.
#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
    read_document_at(Path::new(&path))
}

/// Opens documents like double-clicking them in Finder: the first in the
/// calling window if it's idle, the rest as tabs beside it.
#[tauri::command]
fn open_documents(app: AppHandle, window: WebviewWindow, paths: Vec<String>) {
    route_paths(
        &app,
        paths.into_iter().map(PathBuf::from).collect(),
        Some(window.label().to_string()),
    );
}

/// Shows the native Open panel; picked files open in the calling window if it's idle.
#[tauri::command]
fn show_open_dialog(app: AppHandle, window: WebviewWindow) {
    open_with_dialog(&app, Some(window.label().to_string()));
}

/// ⌃Tab / ⌃⇧Tab from the page: selects the next or previous tab. (The webview
/// gets those keys before the menu could.)
#[tauri::command]
fn select_tab(app: AppHandle, window: WebviewWindow, direction: String) {
    let Some(step) = tabs::TabStep::parse(&direction) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(move || tabs::native::select_tab(&window, step));
    #[cfg(not(target_os = "macos"))]
    let _ = (app, window, step);
}

/// Expands dropped files/folders into the markdown files they contain.
#[tauri::command]
fn list_markdown_files(paths: Vec<String>) -> Vec<MarkdownEntry> {
    docs::collect_markdown_files(&paths.iter().map(PathBuf::from).collect::<Vec<_>>())
        .into_iter()
        .map(|(path, display)| MarkdownEntry {
            path: path.to_string_lossy().into_owned(),
            display,
        })
        .collect()
}

/// Lets the webview load specific local images referenced by the current document.
#[tauri::command]
fn allow_asset_files(app: AppHandle, paths: Vec<String>) {
    let scope = app.asset_protocol_scope();
    for path in paths.iter().map(PathBuf::from) {
        if docs::is_image_path(&path) && path.is_file() {
            let _ = scope.allow_file(&path);
        }
    }
}

/// Tracks whether a window is showing a document, and updates its title.
/// With the document's `path`, tabs that share a file name are titled apart.
#[tauri::command]
fn set_document_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    open: bool,
    title: Option<String>,
    path: Option<String>,
) {
    state
        .router
        .lock()
        .unwrap()
        .set_occupied(window.label(), open);
    let path = path.filter(|p| open && !p.is_empty()).map(PathBuf::from);
    let plain_title = path.is_none().then(|| match (open, title) {
        (true, Some(t)) if !t.is_empty() => t,
        _ => "Markydowny".to_string(),
    });
    state
        .open_documents
        .lock()
        .unwrap()
        .set(window.label(), path);
    let _ = app.run_on_main_thread(move || {
        if let Some(title) = plain_title {
            let _ = window.set_title(&title);
        }
        refresh_titles(window.app_handle());
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_document_at(path: &Path) -> Result<Document, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("{} is too large to display", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut dir = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !dir.ends_with('/') {
        dir.push('/');
    }
    Ok(Document {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        dir,
        content: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Window labels, main window first, so documents fill it before new windows open.
fn window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort_by_key(|l| (l != MAIN_WINDOW, l.clone()));
    labels
}

pub(crate) fn focused_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Label of the front document window, even while the app is in the background.
fn front_window(app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
        if let Some(label) = tabs::native::front_window(&windows) {
            return Some(label);
        }
    }
    focused_window(app).map(|w| w.label().to_string())
}

/// Retitles every tab showing a document, so duplicate names stay distinguishable.
/// Call it on the main thread: there `set_title` applies at once, so titles
/// always match the latest snapshot. From a worker it only queues the change,
/// and an older snapshot's titles could land after a newer one's.
fn refresh_titles(app: &AppHandle) {
    let titles = app.state::<AppState>().open_documents.lock().unwrap().titles();
    for (label, title) in titles {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_title(&title);
        }
    }
}

/// Opens `paths` together: the first in an idle window (`preferred`, then the
/// front window, if idle), the rest as tabs after it; then selects the first.
fn route_paths(app: &AppHandle, paths: Vec<PathBuf>, preferred: Option<String>) {
    // AppKit's tab calls need the main thread; this runs inline when already on it.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || place_documents(&handle, paths, preferred));
}

fn place_documents(app: &AppHandle, paths: Vec<PathBuf>, preferred: Option<String>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_file()).collect();
    if paths.is_empty() {
        return;
    }
    let windows = window_labels(app);
    let front = preferred
        .filter(|p| windows.contains(p))
        .or_else(|| front_window(app));
    let state = app.state::<AppState>();
    let steps = tabs::plan_batch(
        &mut state.router.lock().unwrap(),
        paths,
        &windows,
        front.as_deref(),
    );
    // Create the new windows in document order (Merge All Windows orders tabs
    // by window creation), but don't show them yet.
    for (index, step) in steps.iter().enumerate() {
        match &step.placement {
            Placement::Existing(label) => {
                let _ = app.emit_to(label.as_str(), PENDING_EVENT, ());
            }
            Placement::New(label) => {
                let on_its_own = index == 0 && step.tab_after.is_none();
                if let Err(err) = build_document_window(app, label, on_its_own) {
                    eprintln!("failed to open window {label}: {err}");
                    state.router.lock().unwrap().forget(label);
                }
            }
        }
    }
    // Then add them to the tab group in `attach_order`, so the tab bar ends
    // up scrolled to the batch's start.
    for (label, anchor) in tabs::attach_order(&steps) {
        if let Some(window) = app.get_webview_window(label) {
            attach_or_show(app, &window, anchor);
        }
    }
    // Select the first document's tab and bring its window forward.
    if let Some(window) = steps.first().and_then(|s| app.get_webview_window(s.label())) {
        bring_forward(&window);
    }
}

/// Selects the window's tab, brings it to the front and activates the app.
/// `set_focus` alone does nothing to a tab that's never been selected (it
/// isn't visible yet), so the window is shown first.
fn bring_forward(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Creates a document window: a tab right after `tab_after` when that window
/// exists, otherwise a window of its own.
fn create_document_window(
    app: &AppHandle,
    label: &str,
    tab_after: Option<&str>,
) -> tauri::Result<WebviewWindow> {
    let on_its_own = tab_after.and_then(|l| app.get_webview_window(l)).is_none();
    let window = build_document_window(app, label, on_its_own)?;
    attach_or_show(app, &window, tab_after);
    Ok(window)
}

/// Builds a hidden document window. `on_its_own` cascades it off the front
/// window, for one that won't become a tab.
fn build_document_window(
    app: &AppHandle,
    label: &str,
    on_its_own: bool,
) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Markydowny")
        .inner_size(900.0, 1000.0)
        .min_inner_size(400.0, 300.0)
        // Shown once it's a tab, so it never flashes up on its own.
        .visible(false);
    #[cfg(target_os = "macos")]
    {
        builder = builder.tabbing_identifier(tabs::TABBING_IDENTIFIER);
    }

    if on_its_own {
        if let Some(front) = focused_window(app) {
            if let (Ok(pos), Ok(scale)) = (front.outer_position(), front.scale_factor()) {
                let pos: LogicalPosition<f64> = pos.to_logical(scale);
                builder = builder.position(pos.x + 28.0, pos.y + 28.0);
            }
        }
    }
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    tabs::native::prepare(&window);
    Ok(window)
}

/// Adds `window` as a tab right after `tab_after` (when that window exists),
/// then shows it. Showing a tab selects it; every tab has to be shown once, or
/// AppKit treats it as hidden and Window > Merge All Windows leaves it behind.
fn attach_or_show(app: &AppHandle, window: &WebviewWindow, tab_after: Option<&str>) {
    #[cfg(target_os = "macos")]
    if let Some(anchor) = tab_after.and_then(|l| app.get_webview_window(l)) {
        tabs::native::add_tab(&anchor, window);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, tab_after);
    let _ = window.show();
}

/// File > New Tab (⌘T) and the tab bar's + button: a tab showing the drop zone.
fn new_tab(app: &AppHandle) {
    let front = front_window(app);
    let label = app.state::<AppState>().router.lock().unwrap().next_label();
    match create_document_window(app, &label, front.as_deref()) {
        Ok(window) => bring_forward(&window),
        Err(err) => eprintln!("failed to open tab {label}: {err}"),
    }
}

fn open_with_dialog(app: &AppHandle, preferred: Option<String>) {
    let handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", docs::MARKDOWN_EXTENSIONS)
        .add_filter("All Files", &["*"])
        .pick_files(move |picked| {
            let paths: Vec<PathBuf> = picked
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .collect();
            route_paths(&handle, paths, preferred);
        });
}

/// The default macOS menu, plus File > New Tab (⌘T) and Open… (⌘O). The
/// Window menu's tab items are added natively, by `tabs::native`.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let new_tab = MenuItemBuilder::with_id(NEW_TAB_MENU_ID, "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let open = MenuItemBuilder::with_id(OPEN_MENU_ID, "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "File" {
                submenu.prepend(&new_tab)?;
                submenu.insert(&open, 1)?;
                submenu.insert(&PredefinedMenuItem::separator(app)?, 2)?;
                break;
            }
        }
    }
    let crash_menu_flag = std::env::var_os(crash_reporting::CRASH_MENU_ENV).is_some();
    if crash_reporting::crash_menu_enabled(cfg!(debug_assertions), crash_menu_flag) {
        menu.append(&crash_reporting::crash_menu(app)?)?;
    }
    Ok(menu)
}

/// Paths passed on the command line (useful in dev, and how Linux/Windows open files).
fn cli_paths() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect()
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_bugsplat::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            take_pending_document,
            read_document,
            open_documents,
            show_open_dialog,
            list_markdown_files,
            allow_asset_files,
            set_document_open,
            select_tab,
        ])
        .setup(|app| {
            let handle = app.handle();
            handle.set_menu(build_menu(handle)?)?;
            handle.on_menu_event(|app, event| {
                if event.id() == OPEN_MENU_ID {
                    let preferred = focused_window(app).map(|w| w.label().to_string());
                    open_with_dialog(app, preferred);
                } else if event.id() == NEW_TAB_MENU_ID {
                    new_tab(app);
                } else {
                    crash_reporting::handle_menu(app, event.id().as_ref());
                }
            });
            #[cfg(target_os = "macos")]
            {
                if let Some(main) = handle.get_webview_window(MAIN_WINDOW) {
                    tabs::native::prepare(&main);
                }
                let button_handle = handle.clone();
                tabs::native::install_new_tab_button(move || new_tab(&button_handle));
                tabs::native::add_window_menu_items();
            }
            // The main window exists now, so files from the launch can fill it.
            let mut paths = cli_paths();
            let queued = handle.state::<AppState>().launch.lock().unwrap().finish();
            #[cfg(debug_assertions)]
            if !queued.is_empty() {
                eprintln!("opening {} file(s) macOS sent before launch finished", queued.len());
            }
            paths.extend(queued);
            route_paths(handle, paths, Some(MAIN_WINDOW.to_string()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.router.lock().unwrap().forget(window.label());
                state.open_documents.lock().unwrap().set(window.label(), None);
                refresh_titles(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Markydowny");

    app.run(|app, event| {
        match event {
            // Finder double-click, "Open With", or dropping files on the Dock icon.
            // On a cold launch this arrives before setup has created the main
            // window, so the paths wait in the launch queue until it has.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
                let ready = app.state::<AppState>().launch.lock().unwrap().offer(paths);
                if let Some(paths) = ready {
                    route_paths(app, paths, None);
                }
            }
            // Clicking the Dock icon with no windows open brings back a blank viewer.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } if app.webview_windows().is_empty() => {
                let label = app.state::<AppState>().router.lock().unwrap().next_label();
                if let Ok(window) = create_document_window(app, &label, None) {
                    bring_forward(&window);
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_document_returns_content_name_and_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        std::fs::write(&file, "# Hello\n").unwrap();

        let doc = read_document_at(&file).unwrap();
        let canonical_dir = tmp.path().canonicalize().unwrap();
        assert_eq!(doc.name, "notes.md");
        assert_eq!(doc.content, "# Hello\n");
        assert_eq!(doc.dir, format!("{}/", canonical_dir.display()));
        assert!(doc.path.ends_with("/notes.md"));
    }

    #[test]
    fn read_document_tolerates_invalid_utf8() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("latin1.md");
        std::fs::write(&file, b"caf\xe9").unwrap();
        assert_eq!(read_document_at(&file).unwrap().content, "caf\u{FFFD}");
    }

    #[test]
    fn read_document_rejects_directories_and_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_document_at(tmp.path()).is_err());
        assert!(read_document_at(&tmp.path().join("nope.md")).is_err());
    }
}
