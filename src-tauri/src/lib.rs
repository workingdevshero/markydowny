//! Markydowny desktop shell.
//!
//! The UI is the same static web app that powers markydowny.com. This crate
//! adds what a native document viewer needs on top of it:
//!
//! * opening `.md` files from Finder (double-click / "Open With"), the Dock,
//!   File > Open… or the command line, one window per document;
//! * reading files and folders by path, so relative images resolve;
//! * scoped access to local images through Tauri's asset protocol;
//! * live reload: each window watches the document it shows (`watch.rs`).

mod crash_reporting;
mod docs;
mod watch;

pub use crash_reporting::start as start_crash_reporting;

use std::collections::HashMap;
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
const PENDING_EVENT: &str = "document-pending";
const CHANGED_EVENT: &str = "document-changed";
const MISSING_EVENT: &str = "document-missing";
const MAX_DOCUMENT_BYTES: u64 = 25 * 1024 * 1024;
/// How long to wait before deciding whether re-opening an open document should focus it.
const FOCUS_SETTLE: std::time::Duration = std::time::Duration::from_millis(250);

#[derive(Default)]
struct AppState {
    router: Mutex<DocumentRouter>,
    /// At most one live-reload watch per window, keyed by window label.
    watches: Mutex<HashMap<String, watch::Watch>>,
}

impl AppState {
    /// Replaces (or with `None`, stops) a window's watch. The old watch is dropped outside the
    /// lock.
    fn set_watch(&self, label: &str, watch: Option<watch::Watch>) {
        let old = {
            let mut watches = self.watches.lock().unwrap();
            match watch {
                Some(w) => watches.insert(label.to_string(), w),
                None => watches.remove(label),
            }
        };
        drop(old);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Document {
    path: String,
    name: String,
    /// Parent directory with a trailing `/`, used to resolve relative links.
    dir: String,
    content: String,
}

/// Payload of `document-changed`: the new document, and the content it had before (if known).
#[derive(Debug, Clone, Serialize)]
struct ChangedPayload {
    #[serde(flatten)]
    document: Document,
    previous: Option<String>,
}

/// Payload of `document-missing`.
#[derive(Debug, Clone, Serialize)]
struct MissingPayload {
    path: String,
}

/// What `take_pending_document` hands a window: a document, or a folder to choose from.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Pending {
    Document(Document),
    Folder { folder: String },
}

/// Result of `watch_folder`.
#[derive(Debug, Serialize)]
struct FolderWatch {
    root: String,
    name: String,
    /// The most recently modified markdown file, shown first.
    document: Option<Document>,
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
) -> Result<Option<Pending>, String> {
    let pending = state.router.lock().unwrap().take_pending(window.label());
    match pending {
        Some(path) if path.is_dir() => Ok(Some(Pending::Folder {
            folder: path.to_string_lossy().into_owned(),
        })),
        Some(path) => read_document_at(&path).map(|d| Some(Pending::Document(d))),
        None => Ok(None),
    }
}

/// Reads a document for display in the calling window.
#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
    read_document_at(Path::new(&path))
}

/// Opens documents in idle windows (or new ones), like double-clicking in Finder.
#[tauri::command]
fn open_documents(app: AppHandle, paths: Vec<String>) {
    route_paths(&app, paths.into_iter().map(PathBuf::from).collect(), None);
}

/// Shows the native Open panel; picked files open in the calling window if it's idle.
#[tauri::command]
fn show_open_dialog(app: AppHandle, window: WebviewWindow) {
    open_with_dialog(&app, Some(window.label().to_string()));
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

/// Tracks whether a window is showing a document, and updates its title. Returning to the
/// drop zone stops the window's live reload.
#[tauri::command]
fn set_document_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    open: bool,
    title: Option<String>,
) {
    state
        .router
        .lock()
        .unwrap()
        .set_occupied(window.label(), open);
    if !open {
        state.set_watch(window.label(), None);
    }
    let title = match (open, title) {
        (true, Some(t)) if !t.is_empty() => t,
        _ => "Markydowny".to_string(),
    };
    let _ = window.set_title(&title);
}

/// Live reload: watches `path` for the calling window, replacing whatever it watched before.
/// Changes arrive as `document-changed` / `document-missing` events. Returns the document as
/// it is now (`None` if it's gone), so the window can catch up with anything that changed
/// between reading it and starting the watch.
#[tauri::command]
fn watch_document(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<Document>, String> {
    let label = window.label().to_string();
    let (watch, seeded) = watch::Watch::start(
        watch::Scope::file(Path::new(&path)),
        |p| read_text(p).ok(),
        change_sink(app, label.clone()),
    )
    .map_err(|e| format!("Can't watch {path}: {e}"))?;
    state.set_watch(&label, Some(watch));
    state
        .router
        .lock()
        .unwrap()
        .set_showing(&label, Some(Path::new(&path)));
    Ok(seeded
        .into_iter()
        .next()
        .map(|(path, content)| document_for(&path, content)))
}

/// Follows a folder in the calling window: watches every markdown file under it (the same
/// files the drop list shows) and reports whichever changes, as `document-changed` events with
/// the file's previous content. Replaces the window's watch. Returns the most recently
/// modified file to show first.
#[tauri::command(async)]
fn watch_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<FolderWatch, String> {
    let label = window.label().to_string();
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let (watch, seeded) = watch::Watch::start(
        watch::Scope::folder(root),
        |p| read_text(p).ok(),
        change_sink(app, label.clone()),
    )
    .map_err(|e| format!("Can't watch {path}: {e}"))?;
    state.set_watch(&label, Some(watch));
    state.router.lock().unwrap().set_folder(&label, Some(root));

    let latest = seeded
        .into_iter()
        .max_by_key(|(p, _)| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    Ok(FolderWatch {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        root: root.to_string_lossy().into_owned(),
        document: latest.map(|(path, content)| document_for(&path, content)),
    })
}

/// Forwards a watch's changes to one window.
fn change_sink(app: AppHandle, label: String) -> impl Fn(watch::Change) + Send + 'static {
    move |change| {
        let _ = match change {
            watch::Change::Changed {
                path,
                content,
                previous,
            } => app.emit_to(
                label.as_str(),
                CHANGED_EVENT,
                ChangedPayload {
                    document: document_for(&path, content),
                    previous,
                },
            ),
            watch::Change::Missing(path) => app.emit_to(
                label.as_str(),
                MISSING_EVENT,
                MissingPayload {
                    path: path.to_string_lossy().into_owned(),
                },
            ),
        };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_document_at(path: &Path) -> Result<Document, String> {
    let content = read_text(path)?;
    Ok(document_for(path, content))
}

/// A document's text, with the same checks as opening it (a file, not too large). Invalid
/// UTF-8 is replaced rather than refused.
fn read_text(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("{} is too large to display", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn document_for(path: &Path, content: String) -> Document {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut dir = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !dir.ends_with('/') {
        dir.push('/');
    }
    Document {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        dir,
        content,
    }
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

fn route_paths(app: &AppHandle, paths: Vec<PathBuf>, preferred: Option<String>) {
    let state = app.state::<AppState>();
    for path in paths.into_iter().filter(|p| p.is_file() || p.is_dir()) {
        let labels = window_labels(app);
        let placement = state
            .router
            .lock()
            .unwrap()
            .route(path, &labels, preferred.as_deref());
        match placement {
            Placement::Existing(label) => {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = app.emit_to(label.as_str(), PENDING_EVENT, ());
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            Placement::New(label) => {
                if let Err(err) = create_document_window(app, &label) {
                    eprintln!("failed to open window {label}: {err}");
                    state.router.lock().unwrap().forget(&label);
                }
            }
            // Already open (or in a followed folder). Live reload keeps it current, so this
            // only decides about focus; see `focus_if_active`.
            Placement::Showing(label) => focus_if_active(app, &label),
            Placement::InFolder(label) => {
                let _ = app.emit_to(label.as_str(), PENDING_EVENT, ());
                focus_if_active(app, &label);
            }
        }
    }
}

/// Re-opening an open document brings its window forward only if Markydowny is (or is
/// becoming) the active app: true for a Finder double-click, `open -a` and File > Open…, but
/// not for `open -g`. A Claude Code hook re-opens a file after every edit with `open -g`, and
/// that mustn't pull focus away from the terminal. The check waits briefly because Launch
/// Services activates the app around the same time it delivers the open request.
fn focus_if_active(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(FOCUS_SETTLE);
        if focused_window(&app).is_none() {
            return;
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

fn create_document_window(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Markydowny")
        .inner_size(900.0, 1000.0)
        .min_inner_size(400.0, 300.0);

    // Cascade new windows off whichever one is in front.
    if let Some(anchor) = focused_window(app) {
        if let (Ok(pos), Ok(scale)) = (anchor.outer_position(), anchor.scale_factor()) {
            let pos: LogicalPosition<f64> = pos.to_logical(scale);
            builder = builder.position(pos.x + 28.0, pos.y + 28.0);
        }
    }
    let window = builder.build()?;
    let _ = window.set_focus();
    Ok(window)
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

/// The default macOS menu, plus File > Open… (⌘O).
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let open = MenuItemBuilder::with_id(OPEN_MENU_ID, "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "File" {
                submenu.prepend(&open)?;
                submenu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
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
        .filter(|p| p.is_file() || p.is_dir())
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
            watch_document,
            watch_folder,
        ])
        .setup(|app| {
            let handle = app.handle();
            handle.set_menu(build_menu(handle)?)?;
            handle.on_menu_event(|app, event| {
                if event.id() == OPEN_MENU_ID {
                    let preferred = focused_window(app).map(|w| w.label().to_string());
                    open_with_dialog(app, preferred);
                } else {
                    crash_reporting::handle_menu(app, event.id().as_ref());
                }
            });
            route_paths(handle, cli_paths(), Some(MAIN_WINDOW.to_string()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.router.lock().unwrap().forget(window.label());
                state.set_watch(window.label(), None);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Markydowny");

    app.run(|app, event| {
        match event {
            // Finder double-click, "Open With", or dropping files on the Dock icon.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
                route_paths(app, paths, None);
            }
            // Clicking the Dock icon with no windows open brings back a blank viewer.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if app.webview_windows().is_empty() {
                    let label = app.state::<AppState>().router.lock().unwrap().next_label();
                    let _ = create_document_window(app, &label);
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
