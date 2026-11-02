//! BugSplat crash reporting: native crashes and Rust panics (the `bugsplat` crate) and webview
//! JavaScript errors (`tauri-plugin-bugsplat`).
//!
//! The BugSplat database comes from `BUGSPLAT_DATABASE` at build time. It is kept out of the
//! repository because it is hard to rotate; builds without it run without crash reporting.

use tauri::menu::{MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime};

pub const DATABASE: Option<&str> = option_env!("BUGSPLAT_DATABASE");
pub const APPLICATION: &str = "Markydowny";

/// Upload without the crash dialog (automated testing).
pub const QUIET_ENV: &str = "MARKYDOWNY_BUGSPLAT_QUIET";
/// Show the Crash Test menu in release builds (symbolicated end-to-end testing).
pub const CRASH_MENU_ENV: &str = "MARKYDOWNY_CRASH_MENU";

pub const CRASH_SEGFAULT_ID: &str = "crash-test-segfault";
pub const CRASH_PANIC_ID: &str = "crash-test-panic";
pub const CRASH_JS_ID: &str = "crash-test-js";

/// Starts crash reporting. A failure (e.g. helpers missing from a broken install) is logged and
/// the app runs without crash reporting rather than refusing to open documents.
pub fn start() -> Option<bugsplat::Guard> {
    let quiet = std::env::var_os(QUIET_ENV).is_some();
    let Some(options) = options(DATABASE, quiet) else {
        eprintln!("Crash reporting disabled: built without BUGSPLAT_DATABASE");
        return None;
    };
    match bugsplat::init(options) {
        Ok(guard) => Some(guard),
        Err(err) => {
            eprintln!("Crash reporting disabled: {err}");
            None
        }
    }
}

/// BugSplat options for `database`, or `None` when no database was configured at build time.
pub fn options(database: Option<&str>, quiet: bool) -> Option<bugsplat::Options> {
    let database = database.map(str::trim).filter(|d| !d.is_empty())?;
    Some(
        bugsplat::Options::new(database, APPLICATION, env!("CARGO_PKG_VERSION"))
            .upload_policy(if quiet { bugsplat::UploadPolicy::Quiet } else { bugsplat::UploadPolicy::Dialog })
            .open_support_url(!quiet),
    )
}

pub fn crash_menu_enabled(debug_build: bool, env_flag: bool) -> bool {
    debug_build || env_flag
}

pub fn crash_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Crash Test")
        .item(&MenuItemBuilder::with_id(CRASH_SEGFAULT_ID, "Native Crash (segfault)").build(app)?)
        .item(&MenuItemBuilder::with_id(CRASH_PANIC_ID, "Rust Panic").build(app)?)
        .item(&MenuItemBuilder::with_id(CRASH_JS_ID, "JavaScript Error").build(app)?)
        .build()
}

/// Runs a Crash Test menu item. Returns false for ids that are not crash tests.
pub fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    match id {
        CRASH_SEGFAULT_ID => segfault(),
        CRASH_PANIC_ID => rust_panic(),
        CRASH_JS_ID => {
            // A named function so the report's stack shows where it came from.
            let script = "setTimeout(function markydownyCrashTest() { \
                throw new TypeError('Crash Test: JavaScript error'); })";
            if let Some(window) = crate::focused_window(app).or_else(|| app.webview_windows().into_values().next()) {
                let _ = window.eval(script);
            }
        }
        _ => return false,
    }
    true
}

#[inline(never)]
fn segfault() {
    let p: *mut u32 = std::hint::black_box(std::ptr::null_mut());
    unsafe { p.write_volatile(0xdead) };
}

/// Panics inside the menu event handler, i.e. inside an Objective-C callback on macOS, where the
/// unwind cannot continue and Rust aborts: the case `bugsplat`'s panic hook deduplicates.
#[inline(never)]
fn rust_panic() {
    let documents: Vec<&str> = std::hint::black_box(Vec::new());
    let first = documents.first().expect("Crash Test: Rust panic (no documents open)");
    println!("{first}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_database_means_no_crash_reporting() {
        assert!(options(None, false).is_none());
        assert!(options(Some(""), false).is_none());
        assert!(options(Some("  "), true).is_none());
    }

    #[test]
    fn options_use_the_configured_database_and_app_version() {
        let o = options(Some("some-db"), true).unwrap();
        assert_eq!(o.database(), "some-db");
        assert_eq!(o.application(), APPLICATION);
        assert_eq!(o.version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn crash_menu_only_in_debug_or_when_requested() {
        assert!(crash_menu_enabled(true, false));
        assert!(crash_menu_enabled(false, true));
        assert!(!crash_menu_enabled(false, false));
    }

    #[test]
    fn version_matches_the_bundle_version_used_for_symbols() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(conf["productName"], APPLICATION);
    }
}
