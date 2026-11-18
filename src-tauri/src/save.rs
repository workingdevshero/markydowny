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
    let requested = requested
        .canonicalize()
        .unwrap_or_else(|_| requested.to_path_buf());
    let showing = showing.map(|p| p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
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
        assert_ne!(fs::metadata(&file).unwrap().ino(), before);
        assert_eq!(entries(tmp.path()), vec!["notes.md"]);
    }

    #[test]
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
        std::os::unix::fs::symlink(&file, &link).unwrap();

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
