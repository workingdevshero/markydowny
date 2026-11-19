//! File > Open Recent: the files and folders opened most recently, newest first. Kept free
//! of Tauri types so it can be unit tested; `lib.rs` builds the submenu from it.
//!
//! The list is ours rather than AppKit's (`NSDocumentController`): AppKit opens a picked
//! entry with `openDocumentWithContentsOfURL:`, which needs an `NSDocument` class this app
//! doesn't have, instead of going through the open path every other open takes. Owning it
//! also gives Linux the same menu.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How many entries the menu shows.
pub const MAX_RECENT: usize = 10;

/// Most recent first; one entry per file or folder.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentList {
    paths: Vec<PathBuf>,
}

impl RecentList {
    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    /// Puts `path` at the top, moving it there if it's already listed, and drops the oldest
    /// entry past [`MAX_RECENT`]. Returns whether the list changed.
    pub fn add(&mut self, path: &Path) -> bool {
        let path = canonical(path);
        if self.paths.first() == Some(&path) {
            return false;
        }
        self.paths.retain(|p| *p != path);
        self.paths.insert(0, path);
        self.paths.truncate(MAX_RECENT);
        true
    }

    /// Takes `path` off the list. Returns whether it was on it.
    pub fn remove(&mut self, path: &Path) -> bool {
        let before = self.paths.len();
        self.paths.retain(|p| p != path);
        self.paths.len() != before
    }

    pub fn clear(&mut self) {
        self.paths.clear();
    }

    /// Where a new document's Save panel starts: the folder of the newest entry that's still
    /// there (a folder entry is its own folder).
    pub fn last_folder(&self) -> Option<PathBuf> {
        self.paths.iter().find_map(|path| {
            let folder = if path.is_dir() { path } else { path.parent()? };
            (path.exists() && folder.is_dir()).then(|| folder.to_path_buf())
        })
    }

    /// Menu titles, in list order: each entry's name, plus as many parent folders as it takes
    /// to tell apart entries that share a name (`README.md — markydowny`), as tab titles do.
    pub fn titles(&self) -> Vec<(PathBuf, String)> {
        let keys: Vec<String> = (0..self.paths.len()).map(|i| format!("{i:04}")).collect();
        let titles = crate::tabs::tab_titles(
            keys.iter()
                .map(String::as_str)
                .zip(self.paths.iter().map(PathBuf::as_path)),
        );
        self.paths
            .iter()
            .cloned()
            .zip(titles.into_values())
            .collect()
    }

    /// Reads a list saved by [`Self::save`]. A missing or unreadable file is an empty list.
    pub fn load(file: &Path) -> Self {
        let mut list: Self = std::fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        list.paths.truncate(MAX_RECENT);
        list
    }

    /// Writes the list to `file` (creating its folder), replacing it whole.
    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, file)
    }
}

/// `path` with symlinks and `.`/`..` resolved, so one file is listed once however it was named.
fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(paths: &[&str]) -> RecentList {
        let mut list = RecentList::default();
        for p in paths.iter().rev() {
            list.add(Path::new(p));
        }
        list
    }

    fn paths(list: &RecentList) -> Vec<&str> {
        list.paths().iter().map(|p| p.to_str().unwrap()).collect()
    }

    #[test]
    fn adding_puts_the_newest_first() {
        let mut list = RecentList::default();
        assert!(list.add(Path::new("/a.md")));
        assert!(list.add(Path::new("/b.md")));
        assert_eq!(paths(&list), ["/b.md", "/a.md"]);
    }

    #[test]
    fn adding_a_listed_entry_moves_it_to_the_top_without_a_duplicate() {
        let mut list = list(&["/a.md", "/b.md", "/c.md"]);
        assert!(list.add(Path::new("/c.md")));
        assert_eq!(paths(&list), ["/c.md", "/a.md", "/b.md"]);
        assert!(!list.add(Path::new("/c.md")), "already on top: no change");
        assert_eq!(paths(&list), ["/c.md", "/a.md", "/b.md"]);
    }

    #[test]
    fn different_names_for_one_file_are_one_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("docs");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("notes.md");
        std::fs::write(&file, "").unwrap();
        let link = tmp.path().join("link.md");
        crate::test_support::symlink(&file, &link);

        let mut list = RecentList::default();
        list.add(&file);
        list.add(&dir);
        list.add(&link);
        list.add(&dir.join("../docs/./notes.md"));
        assert_eq!(
            list.paths(),
            [
                dunce::canonicalize(&file).unwrap(),
                dunce::canonicalize(&dir).unwrap()
            ]
        );
    }

    #[test]
    fn the_list_is_capped_at_ten() {
        let mut list = RecentList::default();
        for i in 0..15 {
            list.add(&PathBuf::from(format!("/{i}.md")));
        }
        assert_eq!(list.paths().len(), MAX_RECENT);
        assert_eq!(list.paths()[0], PathBuf::from("/14.md"));
        assert_eq!(list.paths()[9], PathBuf::from("/5.md"));
    }

    #[test]
    fn titles_are_names_with_parent_folders_only_where_names_clash() {
        let list = list(&[
            "/src/markydowny/README.md",
            "/notes.md",
            "/src/other/README.md",
            "/src/docs",
        ]);
        let titles: Vec<String> = list.titles().into_iter().map(|(_, t)| t).collect();
        assert_eq!(
            titles,
            [
                "README.md — markydowny",
                "notes.md",
                "README.md — other",
                "docs"
            ]
        );
        assert_eq!(list.titles()[1].0, PathBuf::from("/notes.md"));
    }

    #[test]
    fn titles_keep_the_list_order() {
        let list = list(&["/z.md", "/a.md", "/m.md"]);
        let titles: Vec<String> = list.titles().into_iter().map(|(_, t)| t).collect();
        assert_eq!(titles, ["z.md", "a.md", "m.md"]);
    }

    #[test]
    fn saved_lists_load_back() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("config/recent.json");
        let list = list(&["/b.md", "/docs", "/a.md"]);
        list.save(&file).unwrap();
        assert_eq!(RecentList::load(&file), list);
        assert!(!tmp.path().join("config/recent.json.tmp").exists());

        RecentList::default().save(&file).unwrap();
        assert_eq!(RecentList::load(&file), RecentList::default());
    }

    #[test]
    fn a_missing_or_damaged_file_loads_as_an_empty_list() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("recent.json");
        assert_eq!(RecentList::load(&file), RecentList::default());
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(RecentList::load(&file), RecentList::default());
    }

    #[test]
    fn a_missing_entry_is_removed() {
        let mut list = list(&["/a.md", "/gone.md", "/b.md"]);
        assert!(list.remove(Path::new("/gone.md")));
        assert_eq!(paths(&list), ["/a.md", "/b.md"]);
        assert!(!list.remove(Path::new("/gone.md")));
    }

    #[test]
    fn clearing_empties_the_list() {
        let mut list = list(&["/a.md", "/b.md"]);
        list.clear();
        assert!(list.paths().is_empty());
        assert!(list.titles().is_empty());
    }

    #[test]
    fn the_save_panel_starts_in_the_folder_of_the_last_opened_file() {
        let tmp = tempfile::tempdir().unwrap();
        let docs = tmp.path().join("docs");
        std::fs::create_dir(&docs).unwrap();
        let file = docs.join("a.md");
        std::fs::write(&file, "a").unwrap();
        let folder = tmp.path().join("notes");
        std::fs::create_dir(&folder).unwrap();

        let mut list = RecentList::default();
        assert_eq!(list.last_folder(), None);
        list.add(&folder);
        list.add(&file);
        assert_eq!(list.last_folder(), Some(canonical(&docs)));

        // A file that's gone is skipped; a folder entry is its own folder.
        list.add(&tmp.path().join("gone.md"));
        std::fs::remove_file(&file).unwrap();
        assert_eq!(list.last_folder(), Some(canonical(&folder)));
    }
}
