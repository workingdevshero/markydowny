//! Documents as macOS window tabs.
//!
//! Every document window is still its own window with its own webview; AppKit
//! groups windows that share a tabbing identifier into one tabbed window. This
//! module holds the pure logic (where a batch of documents goes, tab titles,
//! files that arrive before launch finishes) plus the few AppKit calls Tauri
//! doesn't expose.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::docs::{DocumentRouter, Placement};

/// Shared by every document window, including `main` in `tauri.conf.json`.
pub const TABBING_IDENTIFIER: &str = "markydowny-document";

/// Separates a document name from the folder that tells it apart.
const TITLE_SEPARATOR: &str = " — ";

// ---------------------------------------------------------------------------
// Placement of a batch of documents
// ---------------------------------------------------------------------------

/// Where one document of a batch goes.
#[derive(Debug, PartialEq, Eq)]
pub struct Step {
    pub placement: Placement,
    /// For a new window: the window whose tab it goes right after. `None`
    /// means it becomes a window of its own (there's nothing to join).
    pub tab_after: Option<String>,
}

impl Step {
    pub fn label(&self) -> &str {
        match &self.placement {
            Placement::Existing(l) | Placement::New(l) => l,
        }
    }
}

/// Plans where each of `paths`, opened together, goes, and queues them on
/// `router`. The first document may reuse an idle window (the front one if
/// it's idle); the rest open as new tabs in order right after it, so a batch
/// always ends up in one tab group. A first document that needs a new window
/// goes in a tab beside `front`.
///
/// `windows` lists open window labels in order of preference.
pub fn plan_batch(
    router: &mut DocumentRouter,
    paths: Vec<PathBuf>,
    windows: &[String],
    front: Option<&str>,
) -> Vec<Step> {
    let front = front
        .filter(|f| windows.iter().any(|w| w == f))
        .or_else(|| windows.first().map(String::as_str));
    let mut steps: Vec<Step> = Vec::new();
    for path in paths {
        let previous = steps.last().map(|s| s.label().to_string());
        // Only the first document reuses an idle window, so later ones can't
        // scatter into idle windows elsewhere.
        let placement = match previous {
            None => router.route(path, windows, front),
            Some(_) => router.route(path, &[], None),
        };
        let tab_after = match placement {
            Placement::New(_) => previous.or_else(|| front.map(str::to_string)),
            Placement::Existing(_) => None,
        };
        steps.push(Step {
            placement,
            tab_after,
        });
    }
    steps
}

/// How to add a batch's new windows to the tab group: `(window, insert right
/// after this one)`, in the order to do it. The first document's window goes
/// beside its `tab_after`; the rest are each inserted right after the first
/// document's window, last to first, which puts them in document order.
///
/// Why not first to last, each after the previous one: when the tabs don't fit
/// the tab bar, AppKit keeps the most recently added tab in view and squeezes
/// the ones scrolled past into slivers. Added first to last, the bar stayed
/// scrolled to the batch's end, and selecting the first document then left
/// the tabs between it and the visible ones as slivers (e.g. 4.md, then 5.md
/// and 6.md as slivers, then 7.md to 12.md). Last to first, the last tab added
/// sits right after the first document, so the bar stays at the start and
/// only the tabs at its far end are squeezed, as in Safari.
///
/// The windows themselves are still created in document order, because
/// Window > Merge All Windows orders tabs by when their windows were created.
pub fn attach_order(steps: &[Step]) -> Vec<(&str, Option<&str>)> {
    let Some(first) = steps.first() else {
        return Vec::new();
    };
    let lead = match first.placement {
        Placement::New(_) => Some((first.label(), first.tab_after.as_deref())),
        Placement::Existing(_) => None,
    };
    let rest = steps[1..]
        .iter()
        .rev()
        .filter(|s| matches!(s.placement, Placement::New(_)))
        .map(|s| (s.label(), Some(first.label())));
    lead.into_iter().chain(rest).collect()
}

// ---------------------------------------------------------------------------
// Files opened before launch finishes
// ---------------------------------------------------------------------------

/// macOS delivers the files a cold launch was asked to open
/// (`application:openURLs:`) before `applicationDidFinishLaunching:`, i.e.
/// before Tauri's setup has created the main window. Routing them right away
/// opened every file in a new window and then left `main` empty, so they're
/// held here until setup is done.
#[derive(Debug, Default)]
pub struct LaunchQueue {
    ready: bool,
    queued: Vec<PathBuf>,
}

impl LaunchQueue {
    /// Returns the paths to open now, or holds them until [`Self::finish`].
    pub fn offer(&mut self, paths: Vec<PathBuf>) -> Option<Vec<PathBuf>> {
        if self.ready {
            Some(paths)
        } else {
            self.queued.extend(paths);
            None
        }
    }

    /// Marks launch as finished and returns everything that was held.
    pub fn finish(&mut self) -> Vec<PathBuf> {
        self.ready = true;
        std::mem::take(&mut self.queued)
    }
}

// ---------------------------------------------------------------------------
// Tab titles
// ---------------------------------------------------------------------------

/// The documents shown in each window, for titling tabs.
#[derive(Debug, Default)]
pub struct OpenDocuments {
    paths: HashMap<String, PathBuf>,
}

impl OpenDocuments {
    /// Records what `label` shows: a document, or nothing (`None`).
    pub fn set(&mut self, label: &str, path: Option<PathBuf>) {
        match path {
            Some(path) => self.paths.insert(label.to_string(), path),
            None => self.paths.remove(label),
        };
    }

    /// Title for every window showing a document.
    pub fn titles(&self) -> BTreeMap<String, String> {
        tab_titles(self.paths.iter().map(|(l, p)| (l.as_str(), p.as_path())))
    }
}

/// Window titles for open documents: the file name, plus as many parent
/// folders as it takes to tell apart different files that share a name, e.g.
/// "README.md — docs" and "README.md — src".
pub fn tab_titles<'a>(
    docs: impl IntoIterator<Item = (&'a str, &'a Path)>,
) -> BTreeMap<String, String> {
    let docs: Vec<(&str, &Path)> = docs.into_iter().collect();
    let mut by_name: HashMap<String, Vec<&Path>> = HashMap::new();
    for (_, path) in &docs {
        let group = by_name.entry(file_name(path)).or_default();
        if !group.contains(path) {
            group.push(path);
        }
    }

    // How many parent folders each clashing name needs.
    let depths: HashMap<&String, usize> = by_name
        .iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(name, paths)| (name, distinguishing_depth(paths)))
        .collect();

    docs.iter()
        .map(|(label, path)| {
            let name = file_name(path);
            let title = match depths.get(&name) {
                Some(&depth) => format!("{name}{TITLE_SEPARATOR}{}", parent_suffix(path, depth)),
                None => name,
            };
            (label.to_string(), title)
        })
        .collect()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn parent_components(path: &Path) -> Vec<String> {
    path.parent()
        .map(|p| {
            p.iter()
                .map(|c| c.to_string_lossy().into_owned())
                .filter(|c| c != "/")
                .collect()
        })
        .unwrap_or_default()
}

/// The last `depth` parent folders, e.g. "docs" or "api/docs"; "/" at the root.
fn parent_suffix(path: &Path, depth: usize) -> String {
    let parents = parent_components(path);
    let start = parents.len().saturating_sub(depth);
    let suffix = parents[start..].join("/");
    if suffix.is_empty() {
        "/".to_string()
    } else {
        suffix
    }
}

/// Smallest number of parent folders that makes every path's suffix unique.
fn distinguishing_depth(paths: &[&Path]) -> usize {
    let deepest = paths
        .iter()
        .map(|p| parent_components(p).len())
        .max()
        .unwrap_or(0);
    (1..=deepest.max(1))
        .find(|&depth| {
            let mut seen = HashSet::new();
            paths.iter().all(|p| seen.insert(parent_suffix(p, depth)))
        })
        .unwrap_or(deepest.max(1))
}

// ---------------------------------------------------------------------------
// AppKit
// ---------------------------------------------------------------------------

/// Which neighbouring tab ⌃Tab / ⌃⇧Tab selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabStep {
    Next,
    Previous,
}

impl TabStep {
    pub fn parse(direction: &str) -> Option<Self> {
        match direction {
            "next" => Some(Self::Next),
            "previous" => Some(Self::Previous),
            _ => None,
        }
    }
}

/// A Window menu command that AppKit routes to the key window.
pub struct TabMenuItem {
    pub title: &'static str,
    /// NSWindow action selector.
    pub action: &'static std::ffi::CStr,
    /// Key equivalent, pressed with ⌘⇧; empty for none.
    pub key: &'static str,
}

/// Window menu items for tabs, named and bound as in Safari and Finder.
/// (⌃Tab can't be a menu shortcut: the webview takes it first. The page
/// forwards it with the `select_tab` command instead.)
pub const WINDOW_MENU_TAB_ITEMS: &[TabMenuItem] = &[
    TabMenuItem {
        title: "Show Previous Tab",
        action: c"selectPreviousTab:",
        key: "[",
    },
    TabMenuItem {
        title: "Show Next Tab",
        action: c"selectNextTab:",
        key: "]",
    },
    TabMenuItem {
        title: "Move Tab to New Window",
        action: c"moveTabToNewWindow:",
        key: "",
    },
    TabMenuItem {
        title: "Merge All Windows",
        action: c"mergeAllWindows:",
        key: "",
    },
];

#[cfg(target_os = "macos")]
pub mod native {
    //! The AppKit side of tabs. Everything here must run on the main thread;
    //! calls made elsewhere do nothing.

    use std::ffi::c_void;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{sel, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSEventModifierFlags, NSMenuItem, NSWindow, NSWindowOrderingMode,
        NSWindowTabbingMode,
    };
    use objc2_foundation::NSString;
    use tauri::{Runtime, WebviewWindow};

    use super::{TabStep, WINDOW_MENU_TAB_ITEMS};

    static NEW_TAB: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    fn ns_window<R: Runtime>(window: &WebviewWindow<R>) -> Option<&NSWindow> {
        MainThreadMarker::new()?;
        let ptr = window.ns_window().ok()?;
        // SAFETY: tao owns the NSWindow for as long as `window` is alive, and
        // we're on the main thread.
        unsafe { (ptr as *const NSWindow).as_ref() }
    }

    /// Makes a document window open new documents as tabs (overriding the
    /// "Prefer tabs" system setting) and keeps AppKit's tab menu items on.
    pub fn prepare<R: Runtime>(window: &WebviewWindow<R>) {
        let (Some(ns), Some(mtm)) = (ns_window(window), MainThreadMarker::new()) else {
            return;
        };
        ns.setTabbingMode(NSWindowTabbingMode::Preferred);
        // A window built without a tabbing identifier turns this off for the
        // whole app, which hides Window > Merge All Windows and friends.
        NSWindow::setAllowsAutomaticWindowTabbing(true, mtm);
    }

    /// Adds `window` as a tab right after `anchor`'s tab.
    pub fn add_tab<R: Runtime>(anchor: &WebviewWindow<R>, window: &WebviewWindow<R>) {
        if let (Some(anchor), Some(window)) = (ns_window(anchor), ns_window(window)) {
            anchor.addTabbedWindow_ordered(window, NSWindowOrderingMode::Above);
        }
    }

    /// Selects the tab next to `window`'s, wrapping around like ⌘⇧].
    pub fn select_tab<R: Runtime>(window: &WebviewWindow<R>, step: TabStep) {
        if let Some(ns) = ns_window(window) {
            match step {
                TabStep::Next => ns.selectNextTab(None),
                TabStep::Previous => ns.selectPreviousTab(None),
            }
        }
    }

    /// Label of the frontmost visible window among `windows` (z-order, which
    /// works even while the app is in the background).
    pub fn front_window<R: Runtime>(windows: &[WebviewWindow<R>]) -> Option<String> {
        let mtm = MainThreadMarker::new()?;
        let ordered = NSApp(mtm).orderedWindows();
        ordered.iter().filter(|w| w.isVisible()).find_map(|ns| {
            windows
                .iter()
                .find(|w| w.ns_window().ok() == Some(Retained::as_ptr(&ns) as *mut c_void))
                .map(|w| w.label().to_string())
        })
    }

    /// Adds the tab commands to the Window menu. AppKit adds Show Tab Bar and
    /// Show All Tabs to the View menu by itself, but (as of macOS 26) not
    /// these. They go to the key window through the responder chain.
    ///
    /// By now AppKit has appended Bring All to Front and the window list, so
    /// they're inserted right after Close Window, in a section of their own;
    /// the separator AppKit put after Close Window then follows them.
    pub fn add_window_menu_items() {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(menu) = NSApp(mtm).windowsMenu() else {
            return;
        };
        let count = menu.numberOfItems();
        let close = sel!(performClose:);
        let at = (0..count)
            .find(|&i| menu.itemAtIndex(i).and_then(|item| item.action()) == Some(close))
            .map_or(count, |i| i + 1);
        menu.insertItem_atIndex(&NSMenuItem::separatorItem(mtm), at);
        for (index, item) in (at + 1..).zip(WINDOW_MENU_TAB_ITEMS) {
            // SAFETY: the selectors are NSWindow's tab action methods.
            let menu_item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &NSString::from_str(item.title),
                    Some(Sel::register(item.action)),
                    &NSString::from_str(item.key),
                )
            };
            if !item.key.is_empty() {
                menu_item.setKeyEquivalentModifierMask(
                    NSEventModifierFlags::Command | NSEventModifierFlags::Shift,
                );
            }
            menu.insertItem_atIndex(&menu_item, index);
        }
        // muda turns auto-enabling off for every menu it builds; with it back
        // on, AppKit asks the key window, which disables Show Next Tab and
        // friends while there's only one tab.
        menu.setAutoenablesItems(true);
    }

    /// Shows the tab bar's + button by answering `newWindowForTab:` (AppKit
    /// shows it when something in the responder chain does), calling `action`.
    pub fn install_new_tab_button(action: impl Fn() + Send + Sync + 'static) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if NEW_TAB.set(Box::new(action)).is_err() {
            return;
        }

        unsafe extern "C-unwind" fn new_window_for_tab(
            _: *mut AnyObject,
            _: Sel,
            _: *mut AnyObject,
        ) {
            if let Some(action) = NEW_TAB.get() {
                action();
            }
        }

        let app = NSApp(mtm);
        let class: &AnyClass = app.class();
        // SAFETY: the function matches the `v@:@` signature of an action
        // method, and NSApp's class lives for the whole process.
        unsafe {
            let imp: Imp = std::mem::transmute(
                new_window_for_tab
                    as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
            );
            objc2::ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(newWindowForTab:),
                imp,
                c"v@:@".as_ptr(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    fn new_tab(label: &str, after: Option<&str>) -> Step {
        Step {
            placement: Placement::New(label.into()),
            tab_after: after.map(str::to_string),
        }
    }

    fn existing(label: &str) -> Step {
        Step {
            placement: Placement::Existing(label.into()),
            tab_after: None,
        }
    }

    #[test]
    fn batch_fills_idle_front_window_then_tabs_in_order() {
        // Cold launch with several files: main is idle and in front.
        let mut router = DocumentRouter::default();
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md", "/b.md", "/c.md"]),
            &labels(&["main"]),
            Some("main"),
        );
        assert_eq!(
            steps,
            vec![
                existing("main"),
                new_tab("doc-1", Some("main")),
                new_tab("doc-2", Some("doc-1")),
            ]
        );
        assert_eq!(router.take_pending("main"), Some(PathBuf::from("/a.md")));
        assert_eq!(router.take_pending("doc-1"), Some(PathBuf::from("/b.md")));
        assert_eq!(router.take_pending("doc-2"), Some(PathBuf::from("/c.md")));
    }

    #[test]
    fn busy_front_window_gets_new_tabs_beside_it() {
        let mut router = DocumentRouter::default();
        router.set_occupied("main", true);
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md", "/b.md"]),
            &labels(&["main"]),
            Some("main"),
        );
        assert_eq!(
            steps,
            vec![
                new_tab("doc-1", Some("main")),
                new_tab("doc-2", Some("doc-1"))
            ]
        );
    }

    #[test]
    fn single_document_beside_busy_front_window() {
        let mut router = DocumentRouter::default();
        router.set_occupied("main", true);
        router.set_occupied("doc-7", true);
        let windows = labels(&["main", "doc-7"]);
        let steps = plan_batch(&mut router, paths(&["/a.md"]), &windows, Some("doc-7"));
        assert_eq!(steps, vec![new_tab("doc-1", Some("doc-7"))]);
    }

    #[test]
    fn only_the_first_document_reuses_an_idle_window() {
        // Two idle windows: the batch must not split between them.
        let mut router = DocumentRouter::default();
        let windows = labels(&["main", "doc-9"]);
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md", "/b.md"]),
            &windows,
            Some("doc-9"),
        );
        assert_eq!(
            steps,
            vec![existing("doc-9"), new_tab("doc-1", Some("doc-9"))]
        );
    }

    #[test]
    fn batch_with_no_windows_starts_a_window_and_tabs_onto_it() {
        let mut router = DocumentRouter::default();
        let steps = plan_batch(&mut router, paths(&["/a.md", "/b.md"]), &[], None);
        assert_eq!(
            steps,
            vec![new_tab("doc-1", None), new_tab("doc-2", Some("doc-1"))]
        );
    }

    #[test]
    fn unknown_front_window_falls_back_to_the_first_window() {
        let mut router = DocumentRouter::default();
        router.set_occupied("main", true);
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md"]),
            &labels(&["main"]),
            Some("gone"),
        );
        assert_eq!(steps, vec![new_tab("doc-1", Some("main"))]);
    }

    /// Carries out `attach_order(steps)` the way AppKit's
    /// `addTabbedWindow:ordered:` would, on a tab bar holding `bar`. Returns
    /// the final tab order and the order the tabs were added in.
    fn attach(bar: &[&str], steps: &[Step]) -> (Vec<String>, Vec<String>) {
        let mut tabs = labels(bar);
        let mut added = Vec::new();
        for (label, anchor) in attach_order(steps) {
            match anchor {
                Some(anchor) => {
                    let at = tabs
                        .iter()
                        .position(|t| t == anchor)
                        .expect("anchor exists");
                    tabs.insert(at + 1, label.to_string());
                }
                None => tabs.push(label.to_string()),
            }
            added.push(label.to_string());
        }
        (tabs, added)
    }

    #[test]
    fn cold_launch_batch_is_added_in_document_order_ending_at_the_start() {
        // 9 files: main takes the first, 8 new tabs follow.
        let names: Vec<String> = (1..=9).map(|n| format!("/{n}.md")).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut router = DocumentRouter::default();
        let steps = plan_batch(&mut router, paths(&names), &labels(&["main"]), Some("main"));
        let in_document_order: Vec<String> = steps.iter().map(|s| s.label().to_string()).collect();
        let (tabs, added) = attach(&["main"], &steps);
        assert_eq!(tabs, in_document_order);
        // Added last to first: the last tab added is the one right after main,
        // so the tab bar isn't left scrolled to the end when main is selected.
        let expected: Vec<String> = (1..=8).rev().map(|n| format!("doc-{n}")).collect();
        assert_eq!(added, expected);
    }

    #[test]
    fn batch_beside_a_busy_front_tab_is_added_in_document_order() {
        // `open -a` with three files into a window whose front tab, "x", sits
        // between "w" and "y". The first file's tab goes in first, beside "x".
        let mut router = DocumentRouter::default();
        for label in ["w", "x", "y"] {
            router.set_occupied(label, true);
        }
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md", "/b.md", "/c.md"]),
            &labels(&["w", "x", "y"]),
            Some("x"),
        );
        let (tabs, added) = attach(&["w", "x", "y"], &steps);
        assert_eq!(tabs, labels(&["w", "x", "doc-1", "doc-2", "doc-3", "y"]));
        assert_eq!(added, labels(&["doc-1", "doc-3", "doc-2"]));
    }

    #[test]
    fn batch_with_no_windows_starts_a_window_then_adds_tabs() {
        let mut router = DocumentRouter::default();
        let steps = plan_batch(&mut router, paths(&["/a.md", "/b.md", "/c.md"]), &[], None);
        assert_eq!(
            attach_order(&steps),
            [
                ("doc-1", None),
                ("doc-3", Some("doc-1")),
                ("doc-2", Some("doc-1"))
            ]
        );
        assert_eq!(attach(&[], &steps).0, labels(&["doc-1", "doc-2", "doc-3"]));
    }

    #[test]
    fn single_document_into_an_idle_window_adds_no_tabs() {
        let mut router = DocumentRouter::default();
        let steps = plan_batch(
            &mut router,
            paths(&["/a.md"]),
            &labels(&["main"]),
            Some("main"),
        );
        assert!(attach_order(&steps).is_empty());
    }

    #[test]
    fn launch_queue_holds_paths_until_setup_finishes() {
        let mut queue = LaunchQueue::default();
        assert_eq!(queue.offer(paths(&["/a.md", "/b.md"])), None);
        assert_eq!(queue.offer(paths(&["/c.md"])), None);
        assert_eq!(queue.finish(), paths(&["/a.md", "/b.md", "/c.md"]));
        assert_eq!(queue.offer(paths(&["/d.md"])), Some(paths(&["/d.md"])));
        assert_eq!(queue.finish(), Vec::<PathBuf>::new());
    }

    fn titles(docs: &[(&str, &str)]) -> Vec<(String, String)> {
        tab_titles(docs.iter().map(|(l, p)| (*l, Path::new(*p))))
            .into_iter()
            .collect()
    }

    fn expect(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(l, t)| (l.to_string(), t.to_string()))
            .collect()
    }

    #[test]
    fn unique_names_are_plain_titles() {
        assert_eq!(
            titles(&[("main", "/p/docs/README.md"), ("doc-1", "/p/CHANGELOG.md")]),
            expect(&[("doc-1", "CHANGELOG.md"), ("main", "README.md")])
        );
    }

    #[test]
    fn duplicate_names_get_their_parent_folder() {
        assert_eq!(
            titles(&[
                ("main", "/p/docs/README.md"),
                ("doc-1", "/p/src/README.md"),
                ("doc-2", "/p/notes.md"),
            ]),
            expect(&[
                ("doc-1", "README.md — src"),
                ("doc-2", "notes.md"),
                ("main", "README.md — docs"),
            ])
        );
    }

    #[test]
    fn duplicate_names_use_as_many_folders_as_needed() {
        assert_eq!(
            titles(&[
                ("main", "/x/api/docs/README.md"),
                ("doc-1", "/x/web/docs/README.md"),
                ("doc-2", "/x/README.md"),
            ]),
            expect(&[
                ("doc-1", "README.md — web/docs"),
                ("doc-2", "README.md — x"),
                ("main", "README.md — api/docs"),
            ])
        );
    }

    #[test]
    fn same_file_in_two_tabs_keeps_the_plain_name() {
        assert_eq!(
            titles(&[("main", "/p/README.md"), ("doc-1", "/p/README.md")]),
            expect(&[("doc-1", "README.md"), ("main", "README.md")])
        );
    }

    #[test]
    fn file_at_the_root_is_labelled_with_a_slash() {
        assert_eq!(
            titles(&[("main", "/README.md"), ("doc-1", "/p/README.md")]),
            expect(&[("doc-1", "README.md — p"), ("main", "README.md — /")])
        );
    }

    #[test]
    fn closing_a_duplicate_restores_the_plain_title() {
        let mut open = OpenDocuments::default();
        open.set("main", Some("/p/docs/README.md".into()));
        open.set("doc-1", Some("/p/src/README.md".into()));
        assert_eq!(open.titles()["main"], "README.md — docs");
        open.set("doc-1", None);
        assert_eq!(
            open.titles().into_iter().collect::<Vec<_>>(),
            expect(&[("main", "README.md")])
        );
    }

    #[test]
    fn window_menu_tab_items_are_window_actions() {
        let items: Vec<(&str, &str)> = WINDOW_MENU_TAB_ITEMS
            .iter()
            .map(|i| (i.title, i.key))
            .collect();
        assert_eq!(
            items,
            [
                // ⌘⇧[ and ⌘⇧], as in Safari and Finder.
                ("Show Previous Tab", "["),
                ("Show Next Tab", "]"),
                ("Move Tab to New Window", ""),
                ("Merge All Windows", ""),
            ]
        );
        for item in WINDOW_MENU_TAB_ITEMS {
            let action = item.action.to_str().unwrap();
            assert!(action.ends_with(':') && !action.contains(' '), "{action}");
        }
    }

    #[test]
    fn tab_steps_parse_from_the_frontend() {
        assert_eq!(TabStep::parse("next"), Some(TabStep::Next));
        assert_eq!(TabStep::parse("previous"), Some(TabStep::Previous));
        assert_eq!(TabStep::parse("sideways"), None);
    }

    #[test]
    fn main_window_config_uses_the_shared_tabbing_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty());
        for window in windows {
            assert_eq!(window["tabbingIdentifier"], TABBING_IDENTIFIER, "{window}");
        }
    }
}
