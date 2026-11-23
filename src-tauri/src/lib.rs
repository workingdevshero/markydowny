//! Markydowny desktop shell.
//!
//! The UI is the same static web app that powers markydowny.com. This crate
//! adds what a native document viewer needs on top of it:
//!
//! * opening `.md` files from Finder (double-click / "Open With"), the Dock,
//!   File > Open… or the command line, one window per document;
//! * grouping those windows as native macOS tabs (see `tabs`);
//! * reading files and folders by path, so relative images resolve;
//! * scoped access to local images through Tauri's asset protocol;
//! * live reload: each window watches the document it shows (`watch.rs`);
//! * saving an edited document, checked and atomic, and saving a new one, or one under another
//!   name (Save As), with the Save panel (`save.rs`);
//! * inserting an image picked from disk, copied next to the document if asked (`images.rs`);
//! * File > Open Recent, kept across launches (`recent.rs`);
//! * unsaved work kept across quits and crashes, and reopened at the next launch (`backups.rs`);
//! * `markydowny markychecky task|end`, markychecky's hook, run before any of the above starts
//!   (`markychecky.rs`).

mod backups;
#[cfg(test)]
mod bundled_helpers;
mod crash_reporting;
mod docs;
mod images;
#[cfg(unix)]
pub mod markychecky;
mod recent;
mod save;
mod tabs;
mod watch;

pub use crash_reporting::start as start_crash_reporting;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use docs::{DocumentRouter, Placement};
use recent::RecentList;
use serde::Serialize;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const MAIN_WINDOW: &str = "main";
const OPEN_MENU_ID: &str = "open-document";
const NEW_DOCUMENT_MENU_ID: &str = "new-document";
/// The name a new document's Save panel suggests.
const UNTITLED_FILE_NAME: &str = "Untitled.md";
const NEW_TAB_MENU_ID: &str = "new-tab";
/// File > Save As… (⇧⌘S), handled by the front window's page (`SAVE_AS_EVENT`).
const SAVE_AS_MENU_ID: &str = "save-as";
const SAVE_AS_EVENT: &str = "save-as";
/// Open Recent entries are this prefix followed by the entry's index in the list.
const RECENT_MENU_PREFIX: &str = "open-recent:";
const CLEAR_RECENT_MENU_ID: &str = "clear-recent";
const RECENT_FILE: &str = "recent.json";
/// Where unsaved work is kept, beside `RECENT_FILE`.
const BACKUPS_DIR: &str = "backups";
/// Quit (⌘Q), which writes every window's unsaved work to its backup first.
const QUIT_MENU_ID: &str = "quit";
/// Asks every window to write its unsaved work to its backup now.
const FLUSH_EVENT: &str = "flush-backups";
/// How long Quit waits for the windows to write their backups.
const QUIT_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);
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
    /// The generation of the newest watch request each window has committed. Every request
    /// (`watch_document`, `watch_folder`, going back to the drop zone) carries a generation
    /// that grows with each request the window makes, so one that finishes after a newer one
    /// changes nothing, and a replaced watch stops reporting.
    generations: Mutex<HashMap<String, u64>>,
    /// Files macOS asked us to open before setup finished.
    launch: Mutex<tabs::LaunchQueue>,
    /// Which document each window shows, for tab titles.
    open_documents: Mutex<tabs::OpenDocuments>,
    /// File > Open Recent, and the submenu that shows it.
    recent: Mutex<RecentList>,
    recent_menu: Mutex<Option<Submenu<tauri::Wry>>>,
    /// While quitting: the windows still writing their backups.
    flushing: Mutex<Option<HashSet<String>>>,
}

/// Returned by a watch request that a newer one replaced before it finished.
const SUPERSEDED: &str = "superseded";

impl AppState {
    /// Installs a window's watch (or with `None`, stops it) and updates the router, unless the
    /// window has already committed a newer request. Returns whether it was committed.
    fn commit_watch(
        &self,
        label: &str,
        generation: u64,
        watch: Option<watch::Watch>,
        update: impl FnOnce(&mut DocumentRouter),
    ) -> bool {
        let old = {
            let mut generations = self.generations.lock().unwrap();
            if generations.get(label).is_some_and(|g| *g > generation) {
                Err(watch)
            } else {
                generations.insert(label.to_string(), generation);
                let mut watches = self.watches.lock().unwrap();
                let old = match watch {
                    Some(w) => watches.insert(label.to_string(), w),
                    None => watches.remove(label),
                };
                update(&mut self.router.lock().unwrap());
                Ok(old)
            }
        };
        // Watches are dropped outside the locks.
        old.is_ok()
    }

    /// Whether a newer request has replaced the watch of `generation`.
    fn is_retired(&self, label: &str, generation: u64) -> bool {
        self.generations
            .lock()
            .unwrap()
            .get(label)
            .is_some_and(|g| *g > generation)
    }

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
    /// Parent directory with a trailing separator (`\` on Windows), used to resolve relative
    /// links.
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

/// What `take_pending_document` hands a window: a document, a folder to choose from, a new,
/// untitled document to start (File > New), or unsaved work to reopen.
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Pending {
    Document(Document),
    Folder { folder: String },
    Untitled { untitled: bool },
    Restore { restore: Restore },
}

/// A backup of unsaved work to reopen: the backup, whether its file changed on disk since
/// editing started, and the file as it is now (when it's still there).
#[derive(Debug, Serialize)]
struct Restore {
    #[serde(flatten)]
    backup: backups::Backup,
    status: backups::Status,
    document: Option<Document>,
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
    let (pending, restore) = {
        let mut router = state.router.lock().unwrap();
        if router.take_untitled(window.label()) {
            return Ok(Some(Pending::Untitled { untitled: true }));
        }
        (
            router.take_pending(window.label()),
            router.take_restore(window.label()),
        )
    };
    if let Some(id) = restore {
        let store = backup_store(window.app_handle()).ok_or("No backups folder")?;
        let backup = store
            .load(&id)
            .map_err(|e| format!("Can't reopen unsaved work: {e}"))?;
        let status = backups::status(&backup, read_text);
        let document = match (&backup.path, status) {
            (Some(path), backups::Status::Unchanged | backups::Status::Changed) => {
                read_document_at(path).ok()
            }
            _ => None,
        };
        return Ok(Some(Pending::Restore {
            restore: Restore {
                backup,
                status,
                document,
            },
        }));
    }
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
            // Canonical, like `Document::path`, so the list can find the file on screen.
            path: dunce::canonicalize(&path)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned(),
            display,
        })
        .collect()
}

/// Adds files and folders dropped on a window to File > Open Recent (other opens are added by
/// `place_documents`). Only what can show markdown: folders and markdown files.
#[tauri::command]
fn add_recent_documents(app: AppHandle, paths: Vec<String>) {
    let paths = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_dir() || (p.is_file() && docs::is_markdown_path(p)))
        .collect();
    note_recent(&app, paths);
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

/// Tracks whether a window is showing a document, and updates its title. With the document's
/// `path`, tabs that share a file name are titled apart; `edited` marks unsaved changes.
/// Returning to the drop zone (which carries a watch `generation`) stops the window's live
/// reload.
#[tauri::command]
fn set_document_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    open: bool,
    title: Option<String>,
    path: Option<String>,
    generation: Option<u64>,
    edited: Option<bool>,
) {
    let label = window.label();
    let edited = open && edited.unwrap_or(false);
    if open {
        state.router.lock().unwrap().set_occupied(label, true);
    } else if let Some(generation) = generation {
        state.commit_watch(label, generation, None, |router| {
            router.set_occupied(label, false)
        });
    } else {
        state.router.lock().unwrap().set_occupied(label, false);
        state.set_watch(label, None);
    }
    let path = path.filter(|p| open && !p.is_empty()).map(PathBuf::from);
    let plain_title = path.is_none().then(|| match (open, title) {
        (true, Some(t)) if !t.is_empty() => tabs::edited_title(&t, edited),
        _ => "Markydowny".to_string(),
    });
    {
        let mut open_documents = state.open_documents.lock().unwrap();
        open_documents.set(window.label(), path);
        open_documents.set_edited(window.label(), edited);
    }
    let _ = app.run_on_main_thread(move || {
        if let Some(title) = plain_title {
            let _ = window.set_title(&title);
        }
        refresh_titles(window.app_handle());
    });
}

/// Live reload: watches `path` for the calling window, replacing whatever it watched before.
/// Changes arrive as `document-changed` / `document-missing` events. Returns the document as
/// it is now (`None` if it's gone), so the window can catch up with anything that changed
/// between reading it and starting the watch. If the watch can't start, the window still
/// counts as showing `path` (it just won't reload) and the error is returned.
#[tauri::command]
fn watch_document(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    generation: u64,
) -> Result<Option<Document>, String> {
    let label = window.label().to_string();
    let started = watch::Watch::start(
        watch::Scope::file(Path::new(&path)),
        |p| read_text(p).ok(),
        change_sink(app, label.clone(), generation),
    );
    let (watch, seeded) = match started {
        Ok((watch, seeded)) => (Some(watch), Ok(seeded)),
        Err(e) => (None, Err(format!("Can't watch {path}: {e}"))),
    };
    let committed = state.commit_watch(&label, generation, watch, |router| {
        router.set_showing(&label, Some(Path::new(&path)))
    });
    if !committed {
        return Err(SUPERSEDED.to_string());
    }
    Ok(seeded?
        .into_iter()
        .next()
        .map(|(path, content)| document_for(&path, content)))
}

/// Saves the calling window's document: `path` has to be the document it shows, and the file
/// must still hold `base` (the content the editor started from), or the save is refused with
/// the file's current content. See `save.rs`.
#[tauri::command(async)]
fn write_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
    base: String,
    content: String,
) -> Result<(), save::SaveError> {
    let showing = state
        .router
        .lock()
        .unwrap()
        .showing(window.label())
        .map(Path::to_path_buf);
    save::save_document(
        showing.as_deref(),
        Path::new(&path),
        &base,
        &content,
        read_text,
    )
}

/// Save As (File > Save As…), and a new, untitled document's first save: shows the Save panel
/// (markdown files, named like the calling window's document, starting in its folder; for an
/// untitled one, `Untitled.md` in the folder of the last opened file) and saves `content` where
/// it says. The file the window showed (`path`; `None` while untitled) is never written, unless
/// it's the one picked: then it's an ordinary save, refused unless the file still holds `base`.
/// From then on the window shows the saved file, which goes on File > Open Recent. A file
/// another window shows (or is opening) is refused, as opening it would bring that window
/// forward rather than show it twice: the reader is told, and nothing is written. Returns the
/// saved document (its path canonical), or `None` when the panel was cancelled. See
/// `save::save_as`.
#[tauri::command(async)]
fn save_document_as(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: Option<String>,
    base: String,
    content: String,
) -> Result<Option<Document>, save::SaveError> {
    let file = path.filter(|p| !p.is_empty()).map(PathBuf::from);
    let label = window.label();
    // Only a document with a file can be the file picked: an untitled one may be in a window
    // that showed a file before.
    let showing = match file {
        Some(_) => state.router.lock().unwrap().showing(label).map(Path::to_path_buf),
        None => None,
    };
    let (name, start) = save::save_panel_start(file.as_deref(), UNTITLED_FILE_NAME, || {
        state.recent.lock().unwrap().last_folder()
    });
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", docs::MARKDOWN_EXTENSIONS)
        .set_file_name(name);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let picked = picked.into_path().map_err(|e| save::SaveError::Failed {
        message: e.to_string(),
    })?;
    // The panel asked about replacing the name it showed, not one with ".md" added after it.
    let (path, added) = save::markdown_save_path(&picked);
    if state
        .router
        .lock()
        .unwrap()
        .shown_elsewhere(label, &path)
        .is_some()
    {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        return Err(save::SaveError::Refused {
            message: format!(
                "{name} is open in another window. Save under another name, or close it there \
                 first."
            ),
        });
    }
    save::save_as(showing.as_deref(), &path, !added, &base, &content, read_text)?;
    let path = dunce::canonicalize(&path).unwrap_or(path);
    state.router.lock().unwrap().set_showing(label, Some(&path));
    note_recent(&app, vec![path.clone()]);
    Ok(Some(document_for(&path, content)))
}

/// Asks whether to throw away unsaved changes (closing the window, leaving the editor).
/// Returns true to discard them.
#[tauri::command(async)]
fn confirm_discard(app: AppHandle, name: Option<String>) -> bool {
    let message = match name {
        Some(name) if !name.is_empty() => {
            format!("Discard your unsaved changes to {name}?")
        }
        _ => "Discard your unsaved changes?".to_string(),
    };
    app.dialog()
        .message(message)
        .title("Unsaved changes")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Discard".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show()
}

/// Keeps the calling window's unsaved work in its backup `id`, replacing what was kept before:
/// the editor's `text`, the document's file (`None` while untitled), the fingerprint of what
/// the file held when editing started, and whether it's untitled because its file went
/// (`missing`). Never writes the document itself.
#[tauri::command(async)]
fn write_backup(
    app: AppHandle,
    id: String,
    text: String,
    path: Option<String>,
    title: String,
    fingerprint: Option<String>,
    missing: Option<bool>,
) -> Result<(), String> {
    let store = backup_store(&app).ok_or("No backups folder")?;
    let backup = backups::Backup {
        id,
        text,
        path: path.filter(|p| !p.is_empty()).map(PathBuf::from),
        title,
        fingerprint,
        missing: missing.unwrap_or(false),
        saved_at: backups::now_millis(),
    };
    store.write(&backup).map_err(|e| {
        let message = format!("Can't keep unsaved work: {e}");
        eprintln!("{message}");
        message
    })
}

/// Removes the backup `id`: its document has nothing unsaved any more.
#[tauri::command(async)]
fn remove_backup(app: AppHandle, id: String) -> Result<(), String> {
    let store = backup_store(&app).ok_or("No backups folder")?;
    store.remove(&id).map_err(|e| {
        let message = format!("Can't remove unsaved work: {e}");
        eprintln!("{message}");
        message
    })
}

/// Quitting: the calling window has written its backup (`FLUSH_EVENT`).
#[tauri::command]
fn backups_flushed(window: WebviewWindow, state: State<'_, AppState>) {
    if let Some(waiting) = state.flushing.lock().unwrap().as_mut() {
        waiting.remove(window.label());
    }
}

/// Insert image: picks an image with the Open panel, starting in the folder of the calling
/// window's document. One from outside that folder can be copied next to the document (the
/// reader is asked). Returns the image's canonical path, or `None` when nothing was picked.
#[tauri::command(async)]
fn choose_image(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let document = state
        .router
        .lock()
        .unwrap()
        .showing(window.label())
        .map(Path::to_path_buf)
        .ok_or_else(|| "No document is open".to_string())?;
    let document = dunce::canonicalize(&document).unwrap_or(document);
    let dir = document
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("{} isn't in a folder", document.display()))?;
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Images", docs::IMAGE_EXTENSIONS)
        .set_directory(&dir)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let image = picked.into_path().map_err(|e| e.to_string())?;
    // Canonical, as the document's path is, so the page can work out the relative link.
    let image =
        dunce::canonicalize(&image).map_err(|e| format!("Can't open {}: {e}", image.display()))?;
    if images::is_inside(&dir, &image) {
        return Ok(Some(image.to_string_lossy().into_owned()));
    }
    let name = image
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    const COPY: &str = "Copy";
    const LINK: &str = "Link Where It Is";
    let choice = app
        .dialog()
        .message(format!(
            "{name} isn't in the document's folder. Copy it next to the document, so the link \
             keeps working if the folder moves?"
        ))
        .title("Insert image")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            COPY.to_string(),
            LINK.to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show_with_result();
    // Cancel, Escape or closing the dialog inserts nothing.
    match choice {
        MessageDialogResult::Yes => {}
        MessageDialogResult::Custom(label) if label == COPY => {}
        MessageDialogResult::No => return Ok(Some(image.to_string_lossy().into_owned())),
        MessageDialogResult::Custom(label) if label == LINK => {
            return Ok(Some(image.to_string_lossy().into_owned()))
        }
        _ => return Ok(None),
    }
    let copied = images::copy_into(&image, &dir).map_err(|e| format!("Can't copy {name}: {e}"))?;
    let copied = dunce::canonicalize(&copied).unwrap_or(copied);
    Ok(Some(copied.to_string_lossy().into_owned()))
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
    generation: u64,
) -> Result<FolderWatch, String> {
    let label = window.label().to_string();
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let (watch, seeded) = watch::Watch::start(
        watch::Scope::folder(root),
        |p| read_text(p).ok(),
        change_sink(app, label.clone(), generation),
    )
    .map_err(|e| format!("Can't watch {path}: {e}"))?;
    let committed = state.commit_watch(&label, generation, Some(watch), |router| {
        router.set_folder(&label, Some(root))
    });
    if !committed {
        return Err(SUPERSEDED.to_string());
    }

    let latest = seeded
        .into_iter()
        .max_by_key(|(p, _)| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    Ok(FolderWatch {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
        root: root.to_string_lossy().into_owned(),
        document: latest.map(|(path, content)| document_for(&path, content)),
    })
}

/// Forwards a watch's changes to one window, until a newer request replaces the watch.
fn change_sink(
    app: AppHandle,
    label: String,
    generation: u64,
) -> impl Fn(watch::Change) + Send + 'static {
    move |change| {
        if app.state::<AppState>().is_retired(&label, generation) {
            return;
        }
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
    let meta =
        std::fs::metadata(path).map_err(|e| format!("Can't open {}: {e}", path.display()))?;
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
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut dir = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !dir.ends_with(std::path::MAIN_SEPARATOR) {
        dir.push(std::path::MAIN_SEPARATOR);
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

pub(crate) fn focused_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<WebviewWindow<R>> {
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
    let titles = app
        .state::<AppState>()
        .open_documents
        .lock()
        .unwrap()
        .titles();
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
    // Folders too: a folder opened from Finder shows its file list.
    let paths: Vec<PathBuf> = paths
        .into_iter()
        .filter(|p| p.is_file() || p.is_dir())
        .collect();
    if paths.is_empty() {
        return;
    }
    note_recent(app, paths.clone());
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
            Placement::Existing(label) | Placement::InFolder(label) => {
                let _ = app.emit_to(label.as_str(), PENDING_EVENT, ());
            }
            // Already on screen: live reload keeps it current.
            Placement::Showing(_) => {}
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
    // Select the first document's tab and bring its window forward. When every document
    // was already open, only if Markydowny is active; see `focus_if_active`.
    let Some(first) = steps.first() else {
        return;
    };
    if steps.iter().all(tabs::Step::already_open) {
        focus_if_active(app, first.label());
    } else if let Some(window) = app.get_webview_window(first.label()) {
        bring_forward(&window);
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
            bring_forward(&window);
        }
    });
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

/// File > New (⌘N): a new, untitled document in the editor. In the front window if it shows
/// the drop zone, otherwise in a new tab (a new window off macOS).
fn new_document(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let windows = window_labels(&handle);
        let front = front_window(&handle);
        let state = handle.state::<AppState>();
        let placement = state
            .router
            .lock()
            .unwrap()
            .route_untitled(&windows, front.as_deref());
        match placement {
            Placement::Existing(label) => {
                let _ = handle.emit_to(label.as_str(), PENDING_EVENT, ());
                if let Some(window) = handle.get_webview_window(&label) {
                    bring_forward(&window);
                }
            }
            Placement::New(label) => {
                match create_document_window(&handle, &label, front.as_deref()) {
                    Ok(window) => bring_forward(&window),
                    Err(err) => {
                        eprintln!("failed to open window {label}: {err}");
                        state.router.lock().unwrap().forget(&label);
                    }
                }
            }
            Placement::Showing(_) | Placement::InFolder(_) => {}
        }
    });
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

/// Where File > Open Recent is kept between launches.
fn recent_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(RECENT_FILE))
}

/// Where unsaved work is kept: beside File > Open Recent's list.
fn backup_store(app: &AppHandle) -> Option<backups::BackupStore> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| backups::BackupStore::new(dir.join(BACKUPS_DIR)))
}

/// At launch: reopens every backup of unsaved work, oldest first, each in a window (tab) of its
/// own: the main window while it's idle, then new tabs beside it.
fn restore_backups(app: &AppHandle) {
    let Some(store) = backup_store(app) else {
        return;
    };
    let ids: Vec<String> = store.list().into_iter().map(|b| b.id).collect();
    if ids.is_empty() {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        let mut previous = front_window(&handle);
        let mut first = None;
        for id in ids {
            let windows = window_labels(&handle);
            let placement =
                state
                    .router
                    .lock()
                    .unwrap()
                    .route_restore(&id, &windows, Some(MAIN_WINDOW));
            let label = match placement {
                Placement::Existing(label) => {
                    let _ = handle.emit_to(label.as_str(), PENDING_EVENT, ());
                    label
                }
                Placement::New(label) => {
                    if let Err(err) = create_document_window(&handle, &label, previous.as_deref()) {
                        eprintln!("failed to open window {label}: {err}");
                        state.router.lock().unwrap().forget(&label);
                        continue;
                    }
                    label
                }
                Placement::Showing(_) | Placement::InFolder(_) => continue,
            };
            first.get_or_insert_with(|| label.clone());
            previous = Some(label);
        }
        if let Some(window) = first.and_then(|l| handle.get_webview_window(&l)) {
            bring_forward(&window);
        }
    });
}

/// Quit (⌘Q): asks every window to write its unsaved work to its backup, waits until they have
/// (or [`QUIT_FLUSH_TIMEOUT`]), then quits. Nothing asks about unsaved changes: they come back
/// at the next launch.
fn quit(app: &AppHandle) {
    flush_backups(app, |handle| handle.exit(0));
}

/// Asks every window to write its unsaved work to its backup, then calls `then` once they all
/// have, or after [`QUIT_FLUSH_TIMEOUT`]. Returns false, and does nothing, while a flush is
/// already under way.
fn flush_backups(app: &AppHandle, then: impl FnOnce(&AppHandle) + Send + 'static) -> bool {
    let state = app.state::<AppState>();
    {
        let mut flushing = state.flushing.lock().unwrap();
        if flushing.is_some() {
            return false;
        }
        *flushing = Some(app.webview_windows().keys().cloned().collect());
    }
    let _ = app.emit(FLUSH_EVENT, ());
    let handle = app.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while started.elapsed() < QUIT_FLUSH_TIMEOUT {
            let done = handle
                .state::<AppState>()
                .flushing
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(HashSet::is_empty);
            if done {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        *handle.state::<AppState>().flushing.lock().unwrap() = None;
        then(&handle);
    });
    true
}

/// Quitting through AppKit rather than our ⌘Q (the Dock's Quit, logging out, restarting): AppKit
/// waits while the windows write their backups, as Quit does, then terminates.
#[cfg(target_os = "macos")]
fn install_terminate_handler(app: &AppHandle) {
    let handle = app.clone();
    app_terminate::install(move || {
        flush_backups(&handle, |handle| {
            let _ = handle.run_on_main_thread(app_terminate::reply);
        })
    });
}

#[cfg(target_os = "macos")]
mod app_terminate {
    //! `applicationShouldTerminate:` on tao's app delegate, which doesn't answer it. Main thread
    //! only.

    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSApplicationTerminateReply};

    type ShouldTerminate = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
    ) -> NSApplicationTerminateReply;

    /// Starts what has to happen before terminating; false: terminate now.
    static ON_TERMINATE: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();

    /// Answers AppKit's "should the app terminate?" with "later" while `action` (returning true)
    /// finishes; it then calls [`reply`].
    pub fn install(action: impl Fn() -> bool + Send + Sync + 'static) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if ON_TERMINATE.set(Box::new(action)).is_err() {
            return;
        }

        unsafe extern "C-unwind" fn should_terminate(
            _: *mut AnyObject,
            _: Sel,
            _: *mut AnyObject,
        ) -> NSApplicationTerminateReply {
            match ON_TERMINATE.get() {
                Some(action) if action() => NSApplicationTerminateReply::TerminateLater,
                _ => NSApplicationTerminateReply::TerminateNow,
            }
        }

        let Some(delegate) = NSApp(mtm).delegate() else {
            return;
        };
        let object: &AnyObject = AsRef::<AnyObject>::as_ref(&*delegate);
        let class: &AnyClass = object.class();
        // SAFETY: the function matches `applicationShouldTerminate:`'s `Q@:@` signature
        // (NSApplicationTerminateReply is an NSUInteger), and the delegate's class lives for the
        // whole process. class_addMethod leaves a class that already answers it alone.
        unsafe {
            let imp: Imp = std::mem::transmute(should_terminate as ShouldTerminate);
            objc2::ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
        }
    }

    /// The windows have kept their unsaved work: AppKit can terminate.
    pub fn reply() {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApp(mtm).replyToApplicationShouldTerminate(true);
        }
    }
}

/// Puts `paths` at the top of File > Open Recent, the first one topmost.
fn note_recent(app: &AppHandle, paths: Vec<PathBuf>) {
    update_recent(app, move |list| {
        paths
            .iter()
            .rev()
            .fold(false, |changed, path| list.add(path) | changed)
    });
}

/// Changes the recent list with `update` and, if it says the list changed, saves it and
/// rebuilds the submenu. All on the main thread (inline when already on it), so changes are
/// applied, saved and shown in order, and a menu click always finds the list its menu shows.
fn update_recent(app: &AppHandle, update: impl FnOnce(&mut RecentList) -> bool + Send + 'static) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        let list = {
            let mut list = state.recent.lock().unwrap();
            if !update(&mut list) {
                return;
            }
            list.clone()
        };
        if let Some(file) = recent_file(&handle) {
            if let Err(err) = list.save(&file) {
                eprintln!("failed to save {}: {err}", file.display());
            }
        }
        let menu = state.recent_menu.lock().unwrap().clone();
        if let Some(menu) = menu {
            if let Err(err) = fill_recent_menu(&handle, &menu, &list) {
                eprintln!("failed to update Open Recent: {err}");
            }
        }
    });
}

/// Replaces the items of the Open Recent submenu: an entry per file or folder (its id is
/// [`RECENT_MENU_PREFIX`] and its index in `list`), then Clear Menu, disabled when there are
/// none.
fn fill_recent_menu(
    app: &AppHandle,
    menu: &Submenu<tauri::Wry>,
    list: &RecentList,
) -> tauri::Result<()> {
    while menu.remove_at(0)?.is_some() {}
    let titles = list.titles();
    for (index, (_, title)) in titles.iter().enumerate() {
        let id = format!("{RECENT_MENU_PREFIX}{index}");
        menu.append(&MenuItemBuilder::with_id(id, menu_label(title)).build(app)?)?;
    }
    if !titles.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    let clear = MenuItemBuilder::with_id(CLEAR_RECENT_MENU_ID, "Clear Menu")
        .enabled(!titles.is_empty())
        .build(app)?;
    menu.append(&clear)
}

/// `title` as a menu item shows it: muda reads `&` as a mnemonic marker (dropped on macOS,
/// an underline on Linux), and `&&` as a literal `&`.
fn menu_label(title: &str) -> String {
    title.replace('&', "&&")
}

/// File > Open Recent > an entry: opens it like File > Open…. One that's gone is taken off
/// the list, with a message saying so.
fn open_recent(app: &AppHandle, index: usize) {
    let path = {
        let state = app.state::<AppState>();
        let list = state.recent.lock().unwrap();
        list.paths().get(index).cloned()
    };
    let Some(path) = path else {
        return;
    };
    if path.is_file() || path.is_dir() {
        let preferred = focused_window(app).map(|w| w.label().to_string());
        route_paths(app, vec![path], preferred);
        return;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    update_recent(app, move |list| list.remove(&path));
    app.dialog()
        .message(format!("{name} was moved or deleted."))
        .title("Can't open")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// The default macOS menu, plus File > New (⌘N), New Tab (⌘T), Open… (⌘O), Open Recent and Save
/// As… (⇧⌘S). The
/// Window menu's tab items are added natively, by `tabs::native`. Windows' default menu has a
/// File menu too, where New Tab opens a window of its own.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let new_document = MenuItemBuilder::with_id(NEW_DOCUMENT_MENU_ID, "New")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id(NEW_TAB_MENU_ID, "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let open = MenuItemBuilder::with_id(OPEN_MENU_ID, "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let recent = Submenu::new(app, "Open Recent", true)?;
    let save_as = MenuItemBuilder::with_id(SAVE_AS_MENU_ID, "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {}", app.package_info().name))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let state = app.state::<AppState>();
    let list = state.recent.lock().unwrap().clone();
    fill_recent_menu(app, &recent, &list)?;
    *state.recent_menu.lock().unwrap() = Some(recent.clone());
    // The app menu's Quit (its last item, after Hide Others) is ours, so it can keep unsaved
    // work before quitting.
    #[cfg(target_os = "macos")]
    {
        if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
            let items = app_menu.items()?;
            if let Some(MenuItemKind::Predefined(_)) = items.last() {
                app_menu.remove_at(items.len() - 1)?;
                app_menu.append(&quit)?;
            }
        }
    }
    let mut has_file_menu = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "File" {
                submenu.prepend(&new_tab)?;
                submenu.prepend(&new_document)?;
                submenu.insert(&open, 2)?;
                submenu.insert(&recent, 3)?;
                submenu.insert(&PredefinedMenuItem::separator(app)?, 4)?;
                submenu.insert(&save_as, 5)?;
                submenu.insert(&PredefinedMenuItem::separator(app)?, 6)?;
                has_file_menu = true;
                break;
            }
        }
    }
    // Tauri's default menu has no File menu on Linux, so New (Ctrl+N), Open… (Ctrl+O), Open
    // Recent, Save As… (Ctrl+Shift+S) and Quit (Ctrl+Q) get one of their own there. No New Tab: tabs are native macOS tabs.
    if !has_file_menu {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &new_document,
                &open,
                &recent,
                &PredefinedMenuItem::separator(app)?,
                &save_as,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, None)?,
                &quit,
            ],
        )?;
        menu.insert(&file, 0)?;
    }
    let crash_menu_flag = std::env::var_os(crash_reporting::CRASH_MENU_ENV).is_some();
    if crash_reporting::crash_menu_enabled(cfg!(debug_assertions), crash_menu_flag) {
        menu.append(&crash_reporting::crash_menu(app)?)?;
    }
    Ok(menu)
}

/// Whether to stay running when an exit is requested with `code`. Like other Mac document
/// apps, Markydowny keeps running after its last window closes: the Dock icon, File > Open…
/// and Finder bring a window back. Only an exit the user didn't ask for by quitting reaches
/// here without a code (the last window closing), and an exit the app asks for itself
/// (`AppHandle::exit`, which has a code: Quit, once the windows have kept their unsaved work)
/// still goes through. Quitting from the Dock or logging out terminates through AppKit, which
/// waits for the windows' backups too (`install_terminate_handler`).
fn keep_running_without_windows(on_macos: bool, code: Option<i32>) -> bool {
    on_macos && code.is_none()
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
            add_recent_documents,
            allow_asset_files,
            set_document_open,
            watch_document,
            watch_folder,
            write_document,
            save_document_as,
            confirm_discard,
            write_backup,
            remove_backup,
            backups_flushed,
            choose_image,
            select_tab,
        ])
        .setup(|app| {
            let handle = app.handle();
            if let Some(file) = recent_file(handle) {
                *handle.state::<AppState>().recent.lock().unwrap() = RecentList::load(&file);
            }
            handle.set_menu(build_menu(handle)?)?;
            handle.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                let recent = id
                    .strip_prefix(RECENT_MENU_PREFIX)
                    .and_then(|i| i.parse().ok());
                if id == OPEN_MENU_ID {
                    let preferred = focused_window(app).map(|w| w.label().to_string());
                    open_with_dialog(app, preferred);
                } else if id == NEW_DOCUMENT_MENU_ID {
                    new_document(app);
                } else if id == SAVE_AS_MENU_ID {
                    if let Some(label) = front_window(app) {
                        let _ = app.emit_to(label.as_str(), SAVE_AS_EVENT, ());
                    }
                } else if id == QUIT_MENU_ID {
                    quit(app);
                } else if id == NEW_TAB_MENU_ID {
                    new_tab(app);
                } else if let Some(index) = recent {
                    open_recent(app, index);
                } else if id == CLEAR_RECENT_MENU_ID {
                    update_recent(app, |list| {
                        let had_entries = !list.paths().is_empty();
                        list.clear();
                        had_entries
                    });
                } else {
                    crash_reporting::handle_menu(app, id);
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
                install_terminate_handler(handle);
            }
            // The main window exists now, so files from the launch can fill it.
            let mut paths = cli_paths();
            let queued = handle.state::<AppState>().launch.lock().unwrap().finish();
            #[cfg(debug_assertions)]
            if !queued.is_empty() {
                eprintln!(
                    "opening {} file(s) macOS sent before launch finished",
                    queued.len()
                );
            }
            paths.extend(queued);
            route_paths(handle, paths, Some(MAIN_WINDOW.to_string()));
            // After the files above (both run on the main thread, in order), so a file opened at
            // launch takes the main window and unsaved work reopens beside it.
            restore_backups(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                state.router.lock().unwrap().forget(window.label());
                state.set_watch(window.label(), None);
                state.generations.lock().unwrap().remove(window.label());
                state
                    .open_documents
                    .lock()
                    .unwrap()
                    .set(window.label(), None);
                refresh_titles(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Markydowny");

    app.run(|app, event| {
        // Every arm that uses `app` is macOS-only.
        #[cfg(not(target_os = "macos"))]
        let _ = app;
        match event {
            // Finder double-click, "Open With", or dropping files on the Dock icon.
            // On a cold launch this arrives before setup has created the main
            // window, so the paths wait in the launch queue until it has.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .collect();
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
            RunEvent::ExitRequested { code, api, .. }
                if keep_running_without_windows(cfg!(target_os = "macos"), code) =>
            {
                api.prevent_exit();
            }
            _ => {}
        }
    });
}

/// Helpers for the tests of every module.
#[cfg(test)]
mod test_support {
    use std::path::Path;

    /// Makes `link` a symbolic link to the file `target`. On Windows that takes an administrator
    /// (as on GitHub's runners) or Developer Mode.
    pub fn symlink(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
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
        let canonical_dir = dunce::canonicalize(tmp.path()).unwrap();
        assert_eq!(doc.name, "notes.md");
        assert_eq!(doc.content, "# Hello\n");
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(doc.dir, format!("{}{sep}", canonical_dir.display()));
        assert!(doc.path.ends_with(&format!("{sep}notes.md")));
    }

    #[test]
    fn menu_labels_keep_ampersands_literal() {
        assert_eq!(menu_label("R&D.md"), "R&&D.md");
        assert_eq!(menu_label("a&&b.md — x&y"), "a&&&&b.md — x&&y");
        assert_eq!(menu_label("notes.md"), "notes.md");
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

    #[test]
    fn closing_the_last_window_keeps_the_app_running_on_macos_only() {
        // The last window closing (no exit code) on macOS: stay in the Dock.
        assert!(keep_running_without_windows(true, None));
        // Elsewhere there's no Dock icon to bring a window back, so exit.
        assert!(!keep_running_without_windows(false, None));
        // An exit the app asks for (`AppHandle::exit`) always goes through.
        assert!(!keep_running_without_windows(true, Some(0)));
        assert!(!keep_running_without_windows(true, Some(1)));
    }
}
