//! Which BugSplat helper files go into bugsplat-helpers/, where the bundler picks them up:
//! tauri.conf.json's bundle.macOS and bundle.linux files, and tauri.windows.conf.json's
//! bundle.resources. build.rs includes this file as a module too, so it uses nothing but std.

use std::path::{Path, PathBuf};

/// Where build.rs stages the helpers, relative to src-tauri/.
pub const STAGING_DIR: &str = "bugsplat-helpers";

/// What to stage for a helper bugsplat-sys built at `built`, building for `target_os`: (source,
/// path under [`STAGING_DIR`]) pairs. On Windows, BugSplatReporter.exe reads its dialog's theme
/// and strings from the theme folder beside it, which bugsplat-native's build copies there.
pub fn staged_files(target_os: &str, built: &Path) -> Vec<(PathBuf, PathBuf)> {
    let Some(name) = built.file_name() else {
        return Vec::new();
    };
    let mut files = vec![(built.to_path_buf(), PathBuf::from(name))];
    if target_os == "windows" && name == "BugSplatReporter.exe" {
        if let Some(dir) = built.parent() {
            files.push((dir.join("theme"), PathBuf::from("theme")));
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staged(target_os: &str, built: &str) -> Vec<(PathBuf, PathBuf)> {
        staged_files(target_os, Path::new(built))
    }

    fn pair(src: &str, dest: &str) -> (PathBuf, PathBuf) {
        (PathBuf::from(src), PathBuf::from(dest))
    }

    #[test]
    fn windows_stages_the_reporter_with_its_theme() {
        assert_eq!(
            staged("windows", "out/build/reporter/BugSplatReporter.exe"),
            [
                pair(
                    "out/build/reporter/BugSplatReporter.exe",
                    "BugSplatReporter.exe"
                ),
                pair("out/build/reporter/theme", "theme"),
            ]
        );
        assert_eq!(
            staged("windows", "out/build/monitor/BugSplatMonitor.exe"),
            [pair(
                "out/build/monitor/BugSplatMonitor.exe",
                "BugSplatMonitor.exe"
            )]
        );
    }

    #[test]
    fn macos_and_linux_stage_each_helper_alone() {
        // The Mac reporter is an app bundle with its theme inside.
        assert_eq!(
            staged("macos", "out/build/reporter/BugSplatReporter.app"),
            [pair(
                "out/build/reporter/BugSplatReporter.app",
                "BugSplatReporter.app"
            )]
        );
        assert_eq!(
            staged("linux", "out/build/reporter/BugSplatReporter"),
            [pair(
                "out/build/reporter/BugSplatReporter",
                "BugSplatReporter"
            )]
        );
        assert_eq!(
            staged("linux", "out/build/monitor/BugSplatMonitor"),
            [pair("out/build/monitor/BugSplatMonitor", "BugSplatMonitor")]
        );
    }

    /// Windows installers put bundle.resources in the install folder, beside markydowny.exe,
    /// where the bugsplat crate looks for the helpers. Every staged file has to be listed, and
    /// nothing else: the bundler fails on a resource that doesn't exist.
    #[test]
    fn windows_installers_carry_every_staged_file_beside_the_executable() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
        let resources = conf["bundle"]["resources"].as_object().unwrap();
        let mut expected: Vec<(String, String)> = ["BugSplatMonitor.exe", "BugSplatReporter.exe"]
            .iter()
            .flat_map(|helper| staged("windows", &format!("out/{helper}")))
            .map(|(_, dest)| {
                let dest = dest.to_str().unwrap().to_string();
                (format!("{STAGING_DIR}/{dest}"), dest)
            })
            .collect();
        expected.sort();
        let mut actual: Vec<(String, String)> = resources
            .iter()
            .map(|(src, dest)| (src.clone(), dest.as_str().unwrap().to_string()))
            .collect();
        actual.sort();
        assert_eq!(actual, expected);
    }
}
