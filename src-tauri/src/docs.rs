//! Platform-independent document logic: which window shows which file, and
//! finding markdown files inside dropped folders. Kept free of Tauri types so
//! it can be unit tested.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn"];
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif", "tif", "tiff", "heic",
];
const SKIPPED_DIRS: &[&str] = &["node_modules", "target"];
const MAX_DEPTH: usize = 12;
const MAX_FILES: usize = 1000;

fn has_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

pub fn is_markdown_path(path: &Path) -> bool {
    has_extension(path, MARKDOWN_EXTENSIONS)
}

pub fn is_image_path(path: &Path) -> bool {
    has_extension(path, IMAGE_EXTENSIONS)
}

/// Whether a watched folder (`root`) should react to a change at `path`: a markdown file
/// under it that [`collect_markdown_files`] would list (no hidden files or folders, no
/// `node_modules` or `target`, within the depth limit).
pub fn is_watchable(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let names: Vec<&str> = relative
        .components()
        .map(|c| c.as_os_str().to_str().unwrap_or("."))
        .collect();
    let Some((file, dirs)) = names.split_last() else {
        return false;
    };
    dirs.len() <= MAX_DEPTH
        && !file.starts_with('.')
        && dirs
            .iter()
            .all(|d| !d.starts_with('.') && !SKIPPED_DIRS.contains(d))
        && is_markdown_path(path)
}

/// `path` with symlinks and `.`/`..` resolved, so one file has one key however it was named.
/// Paths that don't exist are kept as given.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Where a document should be displayed.
#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    /// An already-open window that is idle (showing the drop zone).
    Existing(String),
    /// A window that has to be created with this label.
    New(String),
    /// Already on screen in this window (or about to be). Nothing is queued: its live reload
    /// keeps it current.
    Showing(String),
    /// Inside the folder this window is following. The file is queued for it, and the window
    /// switches to it without leaving the folder.
    InFolder(String),
}

/// Assigns opened documents to windows. A window is "occupied" while it shows
/// a document; idle windows are reused before new ones are created. The router also
/// remembers which file (or followed folder) each window shows, so opening it again reuses
/// that window.
#[derive(Default, Debug)]
pub struct DocumentRouter {
    pending: HashMap<String, PathBuf>,
    occupied: HashSet<String>,
    /// Canonical path of the document each window shows.
    showing: HashMap<String, PathBuf>,
    /// Canonical root of the folder each window follows.
    folders: HashMap<String, PathBuf>,
    next_id: u64,
}

impl DocumentRouter {
    /// Picks a window for `path` and, unless it's already showing, queues the path for it.
    /// `windows` lists open window labels in order of preference.
    pub fn route(&mut self, path: PathBuf, windows: &[String], preferred: Option<&str>) -> Placement {
        let path = canonical(&path);
        let open = windows.iter().find(|w| {
            self.showing.get(*w) == Some(&path)
                || self.pending.get(*w) == Some(&path)
                || self.folders.get(*w) == Some(&path)
        });
        if let Some(label) = open {
            return Placement::Showing(label.clone());
        }
        let folder = windows.iter().find(|w| {
            self.folders
                .get(*w)
                .is_some_and(|root| is_watchable(root, &path))
        });
        if let Some(label) = folder {
            self.pending.insert(label.clone(), path);
            return Placement::InFolder(label.clone());
        }

        let idle = |label: &str| !self.occupied.contains(label);
        let existing = preferred
            .filter(|p| windows.iter().any(|w| w == p) && idle(p))
            .map(str::to_string)
            .or_else(|| windows.iter().find(|w| idle(w)).cloned());

        let placement = match existing {
            Some(label) => Placement::Existing(label),
            None => Placement::New(self.next_label()),
        };
        let label = match &placement {
            Placement::Existing(l)
            | Placement::New(l)
            | Placement::Showing(l)
            | Placement::InFolder(l) => l.clone(),
        };
        self.occupied.insert(label.clone());
        self.pending.insert(label, path);
        placement
    }

    /// Removes and returns the document queued for `label`.
    pub fn take_pending(&mut self, label: &str) -> Option<PathBuf> {
        self.pending.remove(label)
    }

    pub fn set_occupied(&mut self, label: &str, occupied: bool) {
        if occupied {
            self.occupied.insert(label.to_string());
        } else {
            self.occupied.remove(label);
            self.showing.remove(label);
            self.folders.remove(label);
        }
    }

    /// Records the document a window shows (`None`: none). Showing a single document ends
    /// following a folder.
    pub fn set_showing(&mut self, label: &str, path: Option<&Path>) {
        match path {
            Some(path) => {
                self.showing.insert(label.to_string(), canonical(path));
                self.folders.remove(label);
            }
            None => {
                self.showing.remove(label);
            }
        }
    }

    /// Records the folder a window follows (`None`: none).
    pub fn set_folder(&mut self, label: &str, root: Option<&Path>) {
        match root {
            Some(root) => {
                self.folders.insert(label.to_string(), canonical(root));
                self.showing.remove(label);
            }
            None => {
                self.folders.remove(label);
            }
        }
    }

    /// Drops all state for a closed window.
    pub fn forget(&mut self, label: &str) {
        self.pending.remove(label);
        self.occupied.remove(label);
        self.showing.remove(label);
        self.folders.remove(label);
    }

    pub fn next_label(&mut self) -> String {
        self.next_id += 1;
        format!("doc-{}", self.next_id)
    }
}

/// Expands dropped paths into `(markdown file, display path)` pairs. Files are
/// kept if they're markdown; folders are searched recursively, skipping hidden
/// and dependency directories. Display paths include the dropped folder's name.
pub fn collect_markdown_files(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for path in paths {
        if path.is_dir() {
            let base = path.parent().unwrap_or(path);
            walk(path, base, 0, &mut found);
        } else if path.is_file() && is_markdown_path(path) {
            let display = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            found.push((path.clone(), display));
        }
        if found.len() >= MAX_FILES {
            found.truncate(MAX_FILES);
            break;
        }
    }
    found
}

fn walk(dir: &Path, base: &Path, depth: usize, found: &mut Vec<(PathBuf, String)>) {
    if depth > MAX_DEPTH || found.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();

    for path in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if !SKIPPED_DIRS.contains(&name) {
                walk(&path, base, depth + 1, found);
            }
        } else if is_markdown_path(&path) {
            let display = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            found.push((path, display));
        }
        if found.len() >= MAX_FILES {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn first_document_goes_to_idle_main_window() {
        let mut router = DocumentRouter::default();
        let placement = router.route("/a.md".into(), &labels(&["main"]), None);
        assert_eq!(placement, Placement::Existing("main".into()));
        assert_eq!(router.take_pending("main"), Some(PathBuf::from("/a.md")));
        assert_eq!(router.take_pending("main"), None);
    }

    #[test]
    fn busy_windows_cause_new_windows() {
        let mut router = DocumentRouter::default();
        router.route("/a.md".into(), &labels(&["main"]), None);
        assert_eq!(
            router.route("/b.md".into(), &labels(&["main"]), None),
            Placement::New("doc-1".into())
        );
        assert_eq!(
            router.route("/c.md".into(), &labels(&["main", "doc-1"]), None),
            Placement::New("doc-2".into())
        );
        assert_eq!(router.take_pending("doc-1"), Some(PathBuf::from("/b.md")));
    }

    #[test]
    fn idle_windows_are_reused() {
        let mut router = DocumentRouter::default();
        router.route("/a.md".into(), &labels(&["main"]), None);
        router.set_occupied("main", false);
        assert_eq!(
            router.route("/b.md".into(), &labels(&["main"]), None),
            Placement::Existing("main".into())
        );
    }

    #[test]
    fn preferred_window_wins_when_idle() {
        let mut router = DocumentRouter::default();
        let windows = labels(&["main", "doc-1"]);
        assert_eq!(
            router.route("/a.md".into(), &windows, Some("doc-1")),
            Placement::Existing("doc-1".into())
        );
        // doc-1 is now busy, so the preference is ignored.
        assert_eq!(
            router.route("/b.md".into(), &windows, Some("doc-1")),
            Placement::Existing("main".into())
        );
    }

    #[test]
    fn preferred_window_must_exist() {
        let mut router = DocumentRouter::default();
        assert_eq!(
            router.route("/a.md".into(), &labels(&["main"]), Some("gone")),
            Placement::Existing("main".into())
        );
    }

    #[test]
    fn forget_frees_closed_windows() {
        let mut router = DocumentRouter::default();
        router.route("/a.md".into(), &labels(&["main"]), None);
        router.forget("main");
        assert_eq!(router.take_pending("main"), None);
        assert_eq!(
            router.route("/b.md".into(), &labels(&["main"]), None),
            Placement::Existing("main".into())
        );
    }

    #[test]
    fn the_same_file_routes_to_the_window_showing_it() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        std::fs::write(&file, "").unwrap();
        let windows = labels(&["main", "doc-1"]);
        let mut router = DocumentRouter::default();

        assert_eq!(
            router.route(file.clone(), &windows, None),
            Placement::Existing("main".into())
        );
        // Opened again before the window has even read it: still that window, nothing queued.
        assert_eq!(
            router.route(file.clone(), &windows, None),
            Placement::Showing("main".into())
        );
        assert!(router.take_pending("main").is_some());
        router.set_showing("main", Some(&file));
        assert_eq!(
            router.route(file.clone(), &windows, None),
            Placement::Showing("main".into())
        );
        assert_eq!(router.take_pending("main"), None, "no re-read is queued");
    }

    #[test]
    fn different_names_for_one_file_are_recognised() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("docs");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("notes.md");
        std::fs::write(&file, "").unwrap();
        let link = tmp.path().join("link.md");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let windows = labels(&["main"]);
        let mut router = DocumentRouter::default();
        router.route(file.clone(), &windows, None);
        router.set_showing("main", Some(&file));

        for alias in [
            link,
            dir.join("./notes.md"),
            dir.join("../docs/notes.md"),
            tmp.path().join("docs/./notes.md"),
        ] {
            assert_eq!(
                router.route(alias.clone(), &windows, None),
                Placement::Showing("main".into()),
                "{}",
                alias.display()
            );
        }
    }

    #[test]
    fn closing_a_window_frees_its_path() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a.md");
        std::fs::write(&file, "").unwrap();
        let mut router = DocumentRouter::default();
        router.route(file.clone(), &labels(&["main"]), None);
        router.set_showing("main", Some(&file));
        router.forget("main");
        assert_eq!(
            router.route(file.clone(), &labels(&["doc-5"]), None),
            Placement::Existing("doc-5".into())
        );

        // Going back to the drop zone frees it too.
        router.set_showing("doc-5", Some(&file));
        router.set_occupied("doc-5", false);
        router.take_pending("doc-5");
        assert_eq!(
            router.route(file, &labels(&["doc-5"]), None),
            Placement::Existing("doc-5".into())
        );
    }

    #[test]
    fn files_in_a_followed_folder_go_to_its_window() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        let inside = root.join("docs/guide.md");
        let ignored = root.join("node_modules/x/README.md");
        let outside = tmp.path().join("other.md");
        for f in [&inside, &ignored, &outside] {
            std::fs::write(f, "").unwrap();
        }
        let windows = labels(&["main", "w2"]);
        let mut router = DocumentRouter::default();
        router.set_occupied("main", true);
        router.set_folder("main", Some(&root));

        assert_eq!(
            router.route(inside.clone(), &windows, None),
            Placement::InFolder("main".into())
        );
        assert_eq!(
            router.take_pending("main"),
            Some(inside.canonicalize().unwrap())
        );
        assert_eq!(
            router.route(root.clone(), &windows, None),
            Placement::Showing("main".into())
        );
        assert_eq!(
            router.route(ignored, &windows, None),
            Placement::Existing("w2".into())
        );
        assert_eq!(
            router.route(outside, &windows, None),
            Placement::New("doc-1".into())
        );

        // Pinning a file stops the folder claiming files.
        router.set_showing("main", Some(&inside));
        assert_eq!(
            router.route(root.join("docs/../docs/guide.md"), &windows, None),
            Placement::Showing("main".into())
        );
        let new = root.join("new.md");
        std::fs::write(&new, "").unwrap();
        assert!(matches!(
            router.route(new, &windows, None),
            Placement::New(_)
        ));
    }

    #[test]
    fn watchable_paths_follow_the_collection_rules() {
        let root = Path::new("/repo");
        assert!(is_watchable(root, Path::new("/repo/README.md")));
        assert!(is_watchable(root, Path::new("/repo/a/b/c.MARKDOWN")));
        assert!(!is_watchable(root, Path::new("/repo/src/lib.rs")));
        assert!(!is_watchable(root, Path::new("/repo/.git/x.md")));
        assert!(!is_watchable(root, Path::new("/repo/docs/.drafts/x.md")));
        assert!(!is_watchable(root, Path::new("/repo/.notes.md")));
        assert!(!is_watchable(
            root,
            Path::new("/repo/node_modules/p/README.md")
        ));
        assert!(!is_watchable(root, Path::new("/repo/sub/target/x.md")));
        assert!(!is_watchable(root, Path::new("/elsewhere/x.md")));
        assert!(!is_watchable(root, Path::new("/repo")));
        let deep: PathBuf = std::iter::once("/repo".to_string())
            .chain((0..=MAX_DEPTH).map(|i| format!("d{i}")))
            .chain(std::iter::once("x.md".to_string()))
            .collect();
        assert!(
            !is_watchable(root, &deep),
            "deeper than collect_markdown_files goes"
        );
        let ok: PathBuf = std::iter::once("/repo".to_string())
            .chain((0..MAX_DEPTH).map(|i| format!("d{i}")))
            .chain(std::iter::once("x.md".to_string()))
            .collect();
        assert!(is_watchable(root, &ok));
    }

    #[test]
    fn extension_checks_are_case_insensitive() {
        assert!(is_markdown_path(Path::new("/x/README.MD")));
        assert!(is_markdown_path(Path::new("a.markdown")));
        assert!(!is_markdown_path(Path::new("a.txt")));
        assert!(is_image_path(Path::new("a.PNG")));
        assert!(!is_image_path(Path::new("secrets.env")));
        assert!(!is_image_path(Path::new("noext")));
    }

    #[test]
    fn collects_markdown_from_folders_and_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("docs");
        std::fs::create_dir_all(root.join("guide")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("guide/intro.markdown"), "").unwrap();
        std::fs::write(root.join("guide/pic.png"), "").unwrap();
        std::fs::write(root.join(".git/HEAD.md"), "").unwrap();
        std::fs::write(root.join("node_modules/pkg/README.md"), "").unwrap();
        let loose = tmp.path().join("loose.md");
        std::fs::write(&loose, "").unwrap();
        let not_md = tmp.path().join("notes.txt");
        std::fs::write(&not_md, "").unwrap();

        let found = collect_markdown_files(&[root.clone(), loose.clone(), not_md]);
        let displays: Vec<&str> = found.iter().map(|(_, d)| d.as_str()).collect();
        assert_eq!(displays, vec!["docs/README.md", "docs/guide/intro.markdown", "loose.md"]);
        assert_eq!(found[2].0, loose);
    }
}
