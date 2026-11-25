//! Saving an edited document.
//!
//! Kept free of Tauri types, like `docs.rs`, so it can be tested on a temporary directory.
//!
//! * A window may only write the document it shows: the path it asks for has to be that one.
//! * The write is refused if the file no longer holds the content the editor started from, so
//!   a change made elsewhere is never silently overwritten. The file is checked again once the
//!   new content is on disk, just before the rename, so a change landing while it's written
//!   (and synced) is caught too; only the rename itself is left unguarded.
//! * The new content goes to a temporary file in the same folder, which is then renamed over the
//!   document: a reader (or a crash) sees the old file or the new one, never half of each. The
//!   document's permissions carry over.
//! * A new document's first save (`save_new`) writes where the Save panel said. It replaces a
//!   file only when the panel asked about replacing that file; otherwise it creates the file,
//!   and refuses if one is there.
//! * Save As (`save_as`) writes where the Save panel said, as a new document's first save does,
//!   and never touches the file the window showed, unless the panel picked that very file: then
//!   it's an ordinary save, checked like any other.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// Why a save didn't happen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveError {
    /// The file changed since the editor read it; `content` is what it holds now.
    Conflict { content: String },
    /// The path isn't the document the calling window shows.
    Refused { message: String },
    /// Reading or writing failed.
    Failed { message: String },
}

/// Saves `content` to `requested`, which has to be `showing` (the document the calling window
/// shows), and only if the file still holds `base`. `read` reads the file as the app shows it.
pub fn save_document<R>(
    showing: Option<&Path>,
    requested: &Path,
    base: &str,
    content: &str,
    read: R,
) -> Result<(), SaveError>
where
    R: Fn(&Path) -> Result<String, String>,
{
    let requested = dunce::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
    let showing = showing.map(|p| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()));
    if showing.as_deref() != Some(requested.as_path()) {
        return Err(SaveError::Refused {
            message: format!(
                "{} isn't the document this window shows",
                requested.display()
            ),
        });
    }
    let current = read(&requested).map_err(|message| SaveError::Failed { message })?;
    if current != base {
        return Err(SaveError::Conflict { content: current });
    }
    write_atomically(&requested, content.as_bytes(), || {
        // Writing and syncing take a while: a save from elsewhere meanwhile still wins.
        let now = read(&requested).map_err(|message| SaveError::Failed { message })?;
        if now == base {
            Ok(())
        } else {
            Err(SaveError::Conflict { content: now })
        }
    })
}

/// Where a new document picked in the Save panel is written: the picked path, with `.md` added
/// when the name has no extension at all (GTK's panel doesn't add one), and whether it was added.
pub fn markdown_save_path(picked: &Path) -> (PathBuf, bool) {
    if picked.extension().is_some() {
        return (picked.to_path_buf(), false);
    }
    let mut name = picked.file_name().unwrap_or_default().to_os_string();
    name.push(".md");
    (picked.with_file_name(name), true)
}

/// What the Save panel suggests for a document with the file `file` (`None` while untitled): the
/// file's name and its folder, or `untitled` and `last_folder` (the folder of the last opened
/// file, asked only when it's needed).
pub fn save_panel_start(
    file: Option<&Path>,
    untitled: &str,
    last_folder: impl FnOnce() -> Option<PathBuf>,
) -> (String, Option<PathBuf>) {
    let name = file
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| untitled.to_string());
    let folder = match file.and_then(Path::parent) {
        Some(dir) if !dir.as_os_str().is_empty() => Some(dir.to_path_buf()),
        _ => last_folder(),
    };
    (name, folder)
}

/// Saves a new document as `path`. An existing file there is replaced only when `replace` (the
/// Save panel asked about replacing that very file); otherwise the file is created, and the
/// save is refused if something is already there.
pub fn save_new(path: &Path, content: &str, replace: bool) -> Result<(), SaveError> {
    let failed = |e: io::Error| SaveError::Failed {
        message: format!("Can't save {}: {e}", path.display()),
    };
    match fs::metadata(path) {
        Ok(meta) if !meta.is_file() => {
            return Err(SaveError::Failed {
                message: format!("{} is not a file", path.display()),
            })
        }
        Ok(_) if replace => return write_atomically(path, content.as_bytes(), || Ok(())),
        _ => {}
    }
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            return Err(SaveError::Refused {
                message: format!("{} already exists", path.display()),
            })
        }
        Err(e) => return Err(failed(e)),
    };
    let written = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all());
    if let Err(e) = written {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(failed(e));
    }
    Ok(())
}

/// Save As: saves `content` as `path`, picked in the Save panel (`replace`: the panel asked
/// about replacing that very file). When `path` is `showing` (the document the calling window
/// shows), that's an ordinary save, refused unless the file still holds `base`; otherwise it's
/// like a new document's first save (`save_new`), and `showing` is left as it is.
pub fn save_as<R>(
    showing: Option<&Path>,
    path: &Path,
    replace: bool,
    base: &str,
    content: &str,
    read: R,
) -> Result<(), SaveError>
where
    R: Fn(&Path) -> Result<String, String>,
{
    let canonical = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if showing.is_some_and(|shown| canonical(shown) == canonical(path)) {
        return save_document(showing, path, base, content, read);
    }
    save_new(path, content, replace)
}

/// Replaces the file at `path` with `content` through a temporary file in the same folder,
/// keeping the file's permissions. `before_rename` runs once the content is on disk; an error
/// from it leaves the file as it is.
pub fn write_atomically<C>(path: &Path, content: &[u8], before_rename: C) -> Result<(), SaveError>
where
    C: FnOnce() -> Result<(), SaveError>,
{
    let failed = |e: io::Error| SaveError::Failed {
        message: format!("Can't save {}: {e}", path.display()),
    };
    let permissions = fs::metadata(path).map_err(failed)?.permissions();
    let (tmp, mut file) = create_temp_beside(path).map_err(failed)?;
    let written = (|| {
        file.write_all(content).map_err(failed)?;
        file.sync_all().map_err(failed)?;
        drop(file);
        fs::set_permissions(&tmp, permissions).map_err(failed)?;
        before_rename()?;
        fs::rename(&tmp, path).map_err(failed)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// A new, empty file next to `path`, hidden and not named like markdown, so neither a folder
/// listing nor a watch takes it for a document.
fn create_temp_beside(path: &Path) -> io::Result<(PathBuf, File)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    loop {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{name}.markydowny-{}-{n}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn read(path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|e| e.to_string())
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn saves_through_a_rename_and_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "# Old\r\n\r\nText\r\n").unwrap();
        #[cfg(unix)]
        let before = fs::metadata(&file).unwrap().ino();

        save_document(
            Some(&file),
            &file,
            "# Old\r\n\r\nText\r\n",
            "# New\r\n\r\nText\r\n",
            read,
        )
        .unwrap();

        assert_eq!(fs::read(&file).unwrap(), b"# New\r\n\r\nText\r\n");
        // A new file was renamed into place, rather than the old one rewritten in place.
        #[cfg(unix)]
        assert_ne!(fs::metadata(&file).unwrap().ino(), before);
        assert_eq!(entries(tmp.path()), vec!["notes.md"]);
    }

    #[test]
    #[cfg(unix)]
    fn keeps_the_documents_permissions() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "a").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();

        save_document(Some(&file), &file, "a", "b", read).unwrap();

        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        assert_eq!(fs::read_to_string(&file).unwrap(), "b");
    }

    #[test]
    fn refuses_a_path_other_than_the_windows_document() {
        let tmp = tempfile::tempdir().unwrap();
        let shown = tmp.path().join("shown.md");
        let other = tmp.path().join("other.md");
        fs::write(&shown, "a").unwrap();
        fs::write(&other, "a").unwrap();

        let result = save_document(Some(&shown), &other, "a", "b", read);
        assert!(
            matches!(result, Err(SaveError::Refused { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read_to_string(&other).unwrap(), "a");

        // A window showing nothing can't write anything.
        let result = save_document(None, &shown, "a", "b", read);
        assert!(
            matches!(result, Err(SaveError::Refused { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read_to_string(&shown).unwrap(), "a");
    }

    #[test]
    fn another_name_for_the_same_file_is_that_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "a").unwrap();
        let link = tmp.path().join("link.md");
        crate::test_support::symlink(&file, &link);

        save_document(Some(&link), &tmp.path().join("./notes.md"), "a", "b", read).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "b");
        // The link still points at the document; the document itself was replaced.
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&link).unwrap(), "b");
    }

    #[test]
    fn refuses_a_stale_base_and_reports_the_files_content() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "changed elsewhere").unwrap();

        let result = save_document(Some(&file), &file, "what the editor read", "mine", read);
        assert_eq!(
            result,
            Err(SaveError::Conflict {
                content: "changed elsewhere".into()
            })
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "changed elsewhere");
        assert_eq!(entries(tmp.path()), vec!["notes.md"]);
    }

    #[test]
    fn refuses_a_change_that_lands_while_the_content_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "a").unwrap();
        let reads = std::cell::Cell::new(0);
        // The first read (the check before writing) sees "a"; another editor saves before the
        // second (just before the rename).
        let racing_read = |path: &Path| {
            reads.set(reads.get() + 1);
            if reads.get() == 2 {
                fs::write(path, "changed elsewhere").unwrap();
            }
            read(path)
        };

        let result = save_document(Some(&file), &file, "a", "mine", racing_read);
        assert_eq!(
            result,
            Err(SaveError::Conflict {
                content: "changed elsewhere".into()
            })
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "changed elsewhere");
        assert_eq!(entries(tmp.path()), vec!["notes.md"]);
    }

    #[test]
    fn a_missing_document_is_a_failure_not_a_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("gone.md");
        let result = save_document(Some(&file), &file, "a", "b", read);
        assert!(
            matches!(result, Err(SaveError::Failed { .. })),
            "{result:?}"
        );
        assert!(!file.exists());
    }

    #[test]
    fn a_new_document_is_written_where_the_panel_said_and_nowhere_else() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Untitled.md");

        save_new(&file, "# New\n\nTyped.\n", false).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "# New\n\nTyped.\n");
        assert_eq!(entries(tmp.path()), vec!["Untitled.md"]);
    }

    #[test]
    fn a_new_document_replaces_a_file_only_when_the_panel_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "old").unwrap();

        // A name the panel didn't ask about (".md" added afterwards) is left alone.
        let result = save_new(&file, "new", false);
        assert!(
            matches!(result, Err(SaveError::Refused { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "old");

        // The reader confirmed "Replace" in the panel.
        save_new(&file, "new", true).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(entries(tmp.path()), vec!["notes.md"]);
    }

    #[test]
    fn a_new_document_never_replaces_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("notes.md");
        fs::create_dir(&folder).unwrap();
        let result = save_new(&folder, "new", true);
        assert!(
            matches!(result, Err(SaveError::Failed { .. })),
            "{result:?}"
        );
        assert!(folder.is_dir());
    }

    #[test]
    fn save_as_writes_the_new_file_and_leaves_the_original_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("b.md");
        fs::write(&a, b"# A\r\n\r\nOriginal\r\n").unwrap();

        save_as(
            Some(&a),
            &b,
            false,
            "# A\r\n\r\nOriginal\r\n",
            "# A\r\n\r\nEdited\r\n",
            read,
        )
        .unwrap();

        assert_eq!(fs::read(&b).unwrap(), b"# A\r\n\r\nEdited\r\n");
        assert_eq!(fs::read(&a).unwrap(), b"# A\r\n\r\nOriginal\r\n");
        assert_eq!(entries(tmp.path()), vec!["a.md", "b.md"]);
    }

    #[test]
    fn save_as_ignores_a_stale_base_for_another_file() {
        // The original changed on disk since the editor read it: that's the original's business,
        // not the new file's.
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("b.md");
        fs::write(&a, "changed elsewhere").unwrap();

        save_as(Some(&a), &b, false, "what the editor read", "mine", read).unwrap();

        assert_eq!(fs::read_to_string(&b).unwrap(), "mine");
        assert_eq!(fs::read_to_string(&a).unwrap(), "changed elsewhere");
    }

    #[test]
    fn save_as_replaces_another_file_only_when_the_panel_asked() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("b.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "old b").unwrap();

        let result = save_as(Some(&a), &b, false, "a", "new", read);
        assert!(
            matches!(result, Err(SaveError::Refused { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read_to_string(&b).unwrap(), "old b");

        save_as(Some(&a), &b, true, "a", "new", read).unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "new");
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(entries(tmp.path()), vec!["a.md", "b.md"]);
    }

    #[test]
    fn save_as_the_file_already_shown_is_an_ordinary_save() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        fs::write(&a, "a").unwrap();

        save_as(Some(&a), &a, true, "a", "edited", read).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "edited");

        // Checked like any save: a change made elsewhere isn't overwritten, even though the
        // panel asked about replacing the file.
        fs::write(&a, "changed elsewhere").unwrap();
        let result = save_as(Some(&a), &a, true, "edited", "mine", read);
        assert_eq!(
            result,
            Err(SaveError::Conflict {
                content: "changed elsewhere".into()
            })
        );
        assert_eq!(fs::read_to_string(&a).unwrap(), "changed elsewhere");
        assert_eq!(entries(tmp.path()), vec!["a.md"]);
    }

    #[test]
    fn save_as_another_name_for_the_shown_file_is_that_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "a").unwrap();
        let link = tmp.path().join("link.md");
        crate::test_support::symlink(&file, &link);

        // Picking the link is picking the document: checked, and the link is kept.
        let result = save_as(Some(&file), &link, true, "stale", "b", read);
        assert!(
            matches!(result, Err(SaveError::Conflict { .. })),
            "{result:?}"
        );
        save_as(Some(&file), &link, true, "a", "b", read).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "b");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn save_as_from_an_untitled_document_is_its_first_save() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Untitled.md");

        save_as(None, &file, false, "", "# New\n", read).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "# New\n");

        // Like save_new, an existing file needs the panel's say-so.
        let result = save_as(None, &file, false, "", "again", read);
        assert!(
            matches!(result, Err(SaveError::Refused { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "# New\n");
    }

    #[test]
    fn the_save_panel_suggests_the_documents_name_in_its_folder() {
        let docs = Path::new("docs");
        let last = || Some(PathBuf::from("recent"));
        assert_eq!(
            save_panel_start(Some(&docs.join("a.md")), "Untitled.md", || {
                panic!("the document's own folder is used")
            }),
            ("a.md".to_string(), Some(docs.to_path_buf()))
        );
        // Untitled: Untitled.md, in the folder of the last opened file (if there is one).
        assert_eq!(
            save_panel_start(None, "Untitled.md", last),
            ("Untitled.md".to_string(), Some(PathBuf::from("recent")))
        );
        assert_eq!(
            save_panel_start(None, "Untitled.md", || None),
            ("Untitled.md".to_string(), None)
        );
    }

    #[test]
    fn a_name_without_an_extension_gets_md() {
        let dir = Path::new("docs");
        assert_eq!(
            markdown_save_path(&dir.join("notes")),
            (dir.join("notes.md"), true)
        );
        assert_eq!(
            markdown_save_path(&dir.join("notes.markdown")),
            (dir.join("notes.markdown"), false)
        );
        // Any extension is the reader's choice.
        assert_eq!(
            markdown_save_path(&dir.join("notes.txt")),
            (dir.join("notes.txt"), false)
        );
    }

    #[test]
    fn errors_serialize_for_the_webview() {
        let json = serde_json::to_value(SaveError::Conflict {
            content: "x".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "conflict", "content": "x" })
        );
    }
}
