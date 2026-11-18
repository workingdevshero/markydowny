use std::path::{Path, PathBuf};

#[path = "src/bundled_helpers.rs"]
mod bundled_helpers;

fn main() {
    stage_bugsplat_helpers();
    tauri_build::build()
}

/// Copies BugSplatMonitor and BugSplatReporter (built by bugsplat-sys, exported by
/// tauri-plugin-bugsplat) to bugsplat-helpers/, where tauri.conf.json's bundle.macOS.files
/// picks them up into Markydowny.app/Contents/Helpers, bundle.linux's deb and appimage files
/// put them next to the executable in /usr/bin, and tauri.windows.conf.json's bundle.resources
/// put them (and the reporter's theme folder) next to markydowny.exe in the install folder.
fn stage_bugsplat_helpers() {
    let dest = PathBuf::from(bundled_helpers::STAGING_DIR);
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    for key in ["MONITOR", "REPORTER"] {
        let var = format!("DEP_TAURI_PLUGIN_BUGSPLAT_{key}");
        println!("cargo:rerun-if-env-changed={var}");
        let Ok(built) = std::env::var(&var) else {
            println!("cargo:warning={var} not set; BugSplat helpers will not be bundled");
            continue;
        };
        for (src, name) in bundled_helpers::staged_files(&target_os, Path::new(&built)) {
            let target = dest.join(name);
            let _ = std::fs::remove_dir_all(&target);
            let _ = std::fs::remove_file(&target);
            copy_recursive(&src, &target)
                .unwrap_or_else(|e| panic!("staging {}: {e}", src.display()));
        }
    }
}

fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dest)?;
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest).map(|_| ())
}
