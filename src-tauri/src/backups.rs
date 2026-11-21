//! Unsaved work kept across quits and crashes ("hot exit"): a backup of every document with
//! unsaved changes, untitled ones included, in a `backups` folder of the app's own. The next
//! launch reopens each one, still unsaved. Only Save ever writes to the reader's files.
//!
//! Kept free of Tauri types, like `save.rs`, so it can be tested on a temporary directory.
//!
//! * One file per document window (`<id>.json`), so two windows editing one file keep a backup
//!   each. The page picks the id; it's checked to be a plain file name.
//! * Written atomically: a temporary file in the same folder, moved over the old backup, so a
//!   crash mid-write leaves the previous backup whole.
//! * A backup records the fingerprint of the file's content when editing started, so a restore
//!   can tell whether the file changed on disk since ([`status`]).
//! * A backup that can't be read is skipped (and logged), never in the way of the others.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// The longest id the page may give a backup.
const MAX_ID_LEN: usize = 64;

/// One document's unsaved work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    /// The editor's text.
    pub text: String,
    /// The document's file, or `None` for an untitled document.
    pub path: Option<PathBuf>,
    pub title: String,
    /// [`fingerprint`] of the file's content when editing started (`None` when untitled).
    pub fingerprint: Option<String>,
    /// When it was written, in milliseconds since the Unix epoch.
    pub saved_at: u64,
}

/// What a backup's file is like now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// The document never had a file.
    Untitled,
    /// The file still holds what editing started from.
    Unchanged,
    /// The file changed on disk since editing started.
    Changed,
    /// The file was moved or deleted (or can't be read).
    Missing,
}

/// A short fingerprint of `text`: its length in UTF-8 bytes and its 32-bit FNV-1a hash, as
/// `<length>:<hash in hex>`. `js/core.js` computes the same (`fingerprint`).
pub fn fingerprint(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{}:{hash:08x}", text.len())
}

/// Whether `backup`'s file still holds what editing started from. `read` reads the file as the
/// app shows it; a file it can't read counts as missing.
pub fn status<R>(backup: &Backup, read: R) -> Status
where
    R: Fn(&Path) -> Result<String, String>,
{
    let Some(path) = &backup.path else {
        return Status::Untitled;
    };
    match read(path) {
        Ok(content) if backup.fingerprint.as_deref() == Some(fingerprint(&content).as_str()) => {
            Status::Unchanged
        }
        Ok(_) => Status::Changed,
        Err(_) => Status::Missing,
    }
}

/// The backups folder.
pub struct BackupStore {
    dir: PathBuf,
}

impl BackupStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Writes `backup`, replacing the one with its id, through a temporary file.
    pub fn write(&self, backup: &Backup) -> io::Result<()> {
        let file = self.file_for(&backup.id)?;
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_vec(backup).map_err(io::Error::other)?;
        let (tmp, mut out) = self.create_temp(&backup.id)?;
        let written = out
            .write_all(&json)
            .and_then(|()| out.sync_all())
            .and_then(|()| {
                drop(out);
                fs::rename(&tmp, &file)
            });
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written
    }

    /// Removes the backup with `id`. One that isn't there is already removed.
    pub fn remove(&self, id: &str) -> io::Result<()> {
        match fs::remove_file(self.file_for(id)?) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Reads the backup with `id`.
    pub fn load(&self, id: &str) -> io::Result<Backup> {
        read_backup(&self.file_for(id)?)
    }

    /// Every backup, oldest first. One that can't be read is skipped and logged.
    pub fn list(&self) -> Vec<Backup> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    eprintln!("can't list backups in {}: {e}", self.dir.display());
                }
                return Vec::new();
            }
        };
        let mut backups: Vec<Backup> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|e| e == "json"))
            .filter_map(|path| match read_backup(&path) {
                // Restoring and removing go by id, so it has to be the file's own.
                Ok(backup) if path.file_stem().is_some_and(|s| *s == *backup.id) => Some(backup),
                Ok(backup) => {
                    eprintln!(
                        "skipping backup {}: its id is {:?}",
                        path.display(),
                        backup.id
                    );
                    None
                }
                Err(e) => {
                    eprintln!("skipping backup {}: {e}", path.display());
                    None
                }
            })
            .collect();
        backups.sort_by(|a, b| a.saved_at.cmp(&b.saved_at).then(a.id.cmp(&b.id)));
        backups
    }

    /// The file of the backup with `id`, refusing an id that isn't a plain name.
    fn file_for(&self, id: &str) -> io::Result<PathBuf> {
        let plain = !id.is_empty()
            && id.len() <= MAX_ID_LEN
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !plain {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{id:?} isn't a backup id"),
            ));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    /// A new, empty temporary file in the backups folder, readable by the reader alone (a
    /// backup can hold anything they typed). Not named `.json`, so it's never listed.
    fn create_temp(&self, id: &str) -> io::Result<(PathBuf, fs::File)> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let tmp = self
                .dir
                .join(format!(".{id}.{}-{n}.tmp", std::process::id()));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&tmp) {
                Ok(file) => return Ok((tmp, file)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

fn read_backup(file: &Path) -> io::Result<Backup> {
    let bytes = fs::read(file)?;
    serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Milliseconds since the Unix epoch, for [`Backup::saved_at`].
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|e| e.to_string())
    }

    fn backup(id: &str, path: Option<&Path>, base: &str, saved_at: u64) -> Backup {
        Backup {
            id: id.into(),
            text: format!("edited {id}"),
            path: path.map(Path::to_path_buf),
            title: id.into(),
            fingerprint: path.map(|_| fingerprint(base)),
            saved_at,
        }
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
    fn fingerprints_match_the_pages() {
        // The same values tests/core.test.js expects of js/core.js.
        assert_eq!(fingerprint(""), "0:811c9dc5");
        assert_eq!(fingerprint("a"), "1:e40c292c");
        assert_eq!(fingerprint("foobar"), "6:bf9cf968");
        assert_eq!(fingerprint("café"), "5:a82b5049");
        assert_ne!(fingerprint("# Notes\n"), fingerprint("# Notes\r\n"));
    }

    #[test]
    fn writing_replaces_the_backup_through_a_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().join("backups"));
        let mut first = backup("one", None, "", 1);
        store.write(&first).unwrap();
        #[cfg(unix)]
        let before = {
            use std::os::unix::fs::MetadataExt;
            fs::metadata(tmp.path().join("backups/one.json"))
                .unwrap()
                .ino()
        };

        first.text = "typed more".into();
        store.write(&first).unwrap();

        assert_eq!(store.load("one").unwrap(), first);
        // A new file was moved into place, rather than the old one rewritten in place.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let after = fs::metadata(tmp.path().join("backups/one.json"))
                .unwrap()
                .ino();
            assert_ne!(after, before);
        }
        assert_eq!(entries(&tmp.path().join("backups")), vec!["one.json"]);
    }

    #[test]
    #[cfg(unix)]
    fn backups_are_readable_by_their_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().to_path_buf());
        store.write(&backup("one", None, "", 1)).unwrap();
        let mode = fs::metadata(tmp.path().join("one.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn every_backup_is_listed_back_oldest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().to_path_buf());
        let file = tmp.path().join("notes.md");
        let newer = backup("b", Some(&file), "base", 20);
        let older = backup("a", None, "", 10);
        store.write(&newer).unwrap();
        store.write(&older).unwrap();
        assert_eq!(store.list(), vec![older, newer]);
    }

    #[test]
    fn no_folder_is_no_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().join("never-made"));
        assert!(store.list().is_empty());
    }

    #[test]
    fn a_backup_is_removed_on_save_and_on_discard() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().to_path_buf());
        store.write(&backup("saved", None, "", 1)).unwrap();
        store.write(&backup("discarded", None, "", 2)).unwrap();
        store.write(&backup("kept", None, "", 3)).unwrap();

        store.remove("saved").unwrap();
        store.remove("discarded").unwrap();
        // Removing one that's already gone is fine.
        store.remove("saved").unwrap();

        let ids: Vec<String> = store.list().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, ["kept"]);
    }

    #[test]
    fn a_corrupt_or_unreadable_backup_is_skipped_and_the_others_still_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().to_path_buf());
        store.write(&backup("good", None, "", 1)).unwrap();
        fs::write(tmp.path().join("corrupt.json"), "{ not json").unwrap();
        fs::write(tmp.path().join("truncated.json"), "").unwrap();
        // A folder where a backup should be can't be read as one.
        fs::create_dir(tmp.path().join("folder.json")).unwrap();
        // One renamed by hand can't be removed by its id.
        fs::copy(
            tmp.path().join("good.json"),
            tmp.path().join("renamed.json"),
        )
        .unwrap();
        // Temporary files from a write that never finished aren't backups.
        fs::write(tmp.path().join(".good.1-0.tmp"), "{").unwrap();

        let ids: Vec<String> = store.list().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, ["good"]);
        assert!(store.load("corrupt").is_err());
    }

    #[test]
    fn ids_that_arent_plain_names_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let store = BackupStore::new(tmp.path().join("backups"));
        for id in ["", "../escape", "a/b", "a.b", &"x".repeat(MAX_ID_LEN + 1)] {
            assert!(
                store.write(&backup(id, None, "", 1)).is_err(),
                "{id:?} was accepted"
            );
            assert!(store.remove(id).is_err());
        }
        assert!(!tmp.path().join("escape.json").exists());
        store
            .write(&backup("0f2c-Ab_9", None, "", 1))
            .expect("a plain id is fine");
    }

    #[test]
    fn an_untitled_backup_has_no_file_to_check() {
        let untitled = backup("u", None, "", 1);
        assert_eq!(status(&untitled, read), Status::Untitled);
    }

    #[test]
    fn a_backup_whose_file_is_unchanged_is_reported_as_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "# Notes\r\n").unwrap();
        let b = backup("f", Some(&file), "# Notes\r\n", 1);
        assert_eq!(status(&b, read), Status::Unchanged);
    }

    #[test]
    fn a_backup_whose_file_is_missing_is_reported_as_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("gone.md");
        let b = backup("f", Some(&file), "base", 1);
        assert_eq!(status(&b, read), Status::Missing);
    }

    #[test]
    fn a_fingerprint_mismatch_is_reported_as_changed_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.md");
        fs::write(&file, "changed elsewhere").unwrap();
        let b = backup("f", Some(&file), "what editing started from", 1);
        assert_eq!(status(&b, read), Status::Changed);
    }

    #[test]
    fn status_serializes_for_the_webview() {
        assert_eq!(
            serde_json::to_value(Status::Changed).unwrap(),
            serde_json::json!("changed")
        );
        let json = serde_json::to_value(backup("x", None, "", 5)).unwrap();
        assert_eq!(json["savedAt"], 5);
        assert_eq!(json["path"], serde_json::Value::Null);
    }
}
