//! Insert image: where a picked image goes.
//!
//! Kept free of Tauri types, like `docs.rs`, so it can be tested on a temporary directory. An
//! image in the document's folder (or a folder under it) is linked where it is; one from
//! elsewhere can be copied next to the document, under a name nothing there has yet.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// Most numbered names tried for a copy ("photo-1.png", "photo-2.png", ...).
const MAX_NUMBERED: u32 = 999;

/// Whether `image` is in `dir` or a folder under it. Both are canonical.
pub fn is_inside(dir: &Path, image: &Path) -> bool {
    image != dir && image.starts_with(dir)
}

/// `name` with `-n` before its extension: ("photo.png", 2) is "photo-2.png".
pub fn numbered_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}-{n}{}", &name[..dot], &name[dot..]),
        _ => format!("{name}-{n}"),
    }
}

/// Copies `image` into `dir` and returns the copy's path. It keeps its name unless `dir` already
/// has a file by that name: one with the same bytes is used as it is, otherwise the copy is
/// numbered. Nothing in `dir` is ever overwritten.
pub fn copy_into(image: &Path, dir: &Path) -> io::Result<PathBuf> {
    let name = image
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the image has no file name"))?;
    for n in 0..=MAX_NUMBERED {
        let candidate = dir.join(if n == 0 {
            name.to_string()
        } else {
            numbered_name(name, n)
        });
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                let copied = File::open(image)
                    .and_then(|mut source| io::copy(&mut source, &mut file))
                    .and_then(|_| file.sync_all());
                if let Err(e) = copied {
                    let _ = fs::remove_file(&candidate);
                    return Err(e);
                }
                return Ok(candidate);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if same_content(image, &candidate)? {
                    return Ok(candidate);
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "too many files by that name",
    ))
}

fn same_content(a: &Path, b: &Path) -> io::Result<bool> {
    let other = fs::metadata(b)?;
    if !other.is_file() || fs::metadata(a)?.len() != other.len() {
        return Ok(false);
    }
    Ok(fs::read(a)? == fs::read(b)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn numbers_go_before_the_extension() {
        assert_eq!(numbered_name("photo.png", 1), "photo-1.png");
        assert_eq!(numbered_name("my.photo.jpeg", 12), "my.photo-12.jpeg");
        assert_eq!(numbered_name("README", 2), "README-2");
        assert_eq!(numbered_name(".hidden", 3), ".hidden-3");
    }

    #[test]
    fn inside_means_the_folder_or_below() {
        let dir = Path::new("/docs/guide");
        assert!(is_inside(dir, Path::new("/docs/guide/a.png")));
        assert!(is_inside(dir, Path::new("/docs/guide/img/a.png")));
        assert!(!is_inside(dir, Path::new("/docs/a.png")));
        assert!(!is_inside(dir, Path::new("/docs/guidebook/a.png")));
        assert!(!is_inside(dir, Path::new("/docs/guide")));
    }

    #[test]
    fn copies_under_the_same_name() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let image = from.path().join("shot.png");
        fs::write(&image, b"png bytes").unwrap();
        let copy = copy_into(&image, to.path()).unwrap();
        assert_eq!(copy, to.path().join("shot.png"));
        assert_eq!(fs::read(&copy).unwrap(), b"png bytes");
        assert_eq!(fs::read(&image).unwrap(), b"png bytes");
    }

    #[test]
    fn never_overwrites_another_file_by_that_name() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let image = from.path().join("shot.png");
        fs::write(&image, b"new").unwrap();
        fs::write(to.path().join("shot.png"), b"old").unwrap();
        fs::write(to.path().join("shot-1.png"), b"older").unwrap();
        let copy = copy_into(&image, to.path()).unwrap();
        assert_eq!(copy, to.path().join("shot-2.png"));
        assert_eq!(fs::read(to.path().join("shot.png")).unwrap(), b"old");
        assert_eq!(fs::read(to.path().join("shot-1.png")).unwrap(), b"older");
        assert_eq!(fs::read(&copy).unwrap(), b"new");
    }

    #[test]
    fn reuses_a_copy_already_there() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let image = from.path().join("shot.png");
        fs::write(&image, b"same").unwrap();
        fs::write(to.path().join("shot.png"), b"same").unwrap();
        assert_eq!(
            copy_into(&image, to.path()).unwrap(),
            to.path().join("shot.png")
        );
        assert_eq!(names(to.path()), vec!["shot.png"]);
    }

    #[test]
    fn a_failed_copy_leaves_nothing_behind() {
        let to = tempfile::tempdir().unwrap();
        let missing = to.path().join("elsewhere").join("gone.png");
        assert!(copy_into(&missing, to.path()).is_err());
        assert!(names(to.path()).is_empty());
    }
}
