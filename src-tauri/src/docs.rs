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

/// Where a document should be displayed.
#[derive(Debug, PartialEq, Eq)]
pub enum Placement {
    /// An already-open window that is idle (showing the drop zone).
    Existing(String),
    /// A window that has to be created with this label.
    New(String),
}

/// Assigns opened documents to windows. A window is "occupied" while it shows
/// a document; idle windows are reused before new ones are created.
#[derive(Default, Debug)]
pub struct DocumentRouter {
    pending: HashMap<String, PathBuf>,
    occupied: HashSet<String>,
    next_id: u64,
}

impl DocumentRouter {
    /// Picks a window for `path` and queues the path for it.
    /// `windows` lists open window labels in order of preference.
    pub fn route(&mut self, path: PathBuf, windows: &[String], preferred: Option<&str>) -> Placement {
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
            Placement::Existing(l) | Placement::New(l) => l.clone(),
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
        }
    }

    /// Drops all state for a closed window.
    pub fn forget(&mut self, label: &str) {
        self.pending.remove(label);
        self.occupied.remove(label);
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
