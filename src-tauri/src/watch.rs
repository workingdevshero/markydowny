//! Live reload: watching a document (or a folder of documents) for changes on disk.
//!
//! Kept free of Tauri types, like `docs.rs`, so it can be tested on a temporary directory. The
//! app passes in how to read a file and what to do with each [`Change`].
//!
//! * A single document is watched through its **parent directory**, matching events by file name.
//!   Editors and agents often save by writing a temporary file and renaming it over the original;
//!   a watch on the file itself goes quiet after the first such save. Watching the folder also
//!   sees the file being deleted and created again.
//! * Events are debounced: the file is re-read once things have been quiet for [`QUIET`] (or
//!   [`MAX_WAIT`] into a continuous stream of writes, so a long burst still shows progress).
//! * Re-read content is compared with the last content seen, so a `touch` or a save without
//!   changes sends nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// How long the file system has to be quiet before a changed file is re-read.
pub const QUIET: Duration = Duration::from_millis(100);
/// The longest a continuous stream of events can delay a re-read.
pub const MAX_WAIT: Duration = Duration::from_millis(1000);
/// How often an idle worker checks whether it has been stopped.
const IDLE_TICK: Duration = Duration::from_millis(500);

/// What a watch covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// One file. Its parent directory is watched, non-recursively.
    File(PathBuf),
}

impl Scope {
    /// A file scope with the parent directory canonicalized (file system events report real
    /// paths, e.g. `/private/var/...` for `/var/...`). The file itself need not exist.
    pub fn file(path: &Path) -> Scope {
        let canonical =
            path.canonicalize()
                .unwrap_or_else(|_| match (path.parent(), path.file_name()) {
                    (Some(dir), Some(name)) => dir
                        .canonicalize()
                        .map(|d| d.join(name))
                        .unwrap_or_else(|_| path.to_path_buf()),
                    _ => path.to_path_buf(),
                });
        Scope::File(canonical)
    }

    /// Whether a file system event about `path` concerns this scope.
    pub fn matches(&self, path: &Path) -> bool {
        match self {
            Scope::File(file) => {
                path.file_name() == file.file_name() && path.parent() == file.parent()
            }
        }
    }

    fn watch_target(&self) -> (&Path, RecursiveMode) {
        match self {
            Scope::File(file) => (
                file.parent().unwrap_or(Path::new("/")),
                RecursiveMode::NonRecursive,
            ),
        }
    }

    /// The files whose content is recorded when the watch starts.
    fn initial_files(&self) -> Vec<PathBuf> {
        match self {
            Scope::File(file) => vec![file.clone()],
        }
    }
}

/// Something worth telling the window about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// `path` has new content. `previous` is the content last seen, if any.
    Changed {
        path: PathBuf,
        content: String,
        previous: Option<String>,
    },
    /// `path` was deleted or moved away.
    Missing(PathBuf),
}

/// Collapses bursts of events into one re-read: due once events have stopped for `quiet`, or
/// `max_wait` after the first event of a burst, whichever comes first.
#[derive(Debug)]
pub struct Debouncer {
    quiet: Duration,
    max_wait: Duration,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Debouncer {
    pub fn new(quiet: Duration, max_wait: Duration) -> Self {
        Debouncer {
            quiet,
            max_wait,
            first: None,
            last: None,
        }
    }

    pub fn event(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// When the pending burst is due, or `None` if nothing is pending.
    pub fn deadline(&self) -> Option<Instant> {
        match (self.first, self.last) {
            (Some(first), Some(last)) => Some((last + self.quiet).min(first + self.max_wait)),
            _ => None,
        }
    }

    /// True (once) when the pending burst is due.
    pub fn take_due(&mut self, now: Instant) -> bool {
        match self.deadline() {
            Some(deadline) if deadline <= now => {
                self.first = None;
                self.last = None;
                true
            }
            _ => false,
        }
    }
}

/// The last content seen for each file, to skip saves that change nothing.
#[derive(Debug, Default)]
pub struct Tracker {
    contents: HashMap<PathBuf, String>,
}

impl Tracker {
    pub fn record(&mut self, path: PathBuf, content: String) {
        self.contents.insert(path, content);
    }

    /// Takes the result of re-reading `path` (`None` if it couldn't be read) and whether the
    /// file still exists, and decides what, if anything, changed.
    pub fn update(&mut self, path: &Path, read: Option<String>, exists: bool) -> Option<Change> {
        match read {
            Some(content) => {
                if self.contents.get(path) == Some(&content) {
                    return None;
                }
                let previous = self.contents.insert(path.to_path_buf(), content.clone());
                Some(Change::Changed {
                    path: path.to_path_buf(),
                    content,
                    previous,
                })
            }
            // Gone: report it once. Coming back reads as new content.
            None if !exists => self
                .contents
                .remove(path)
                .map(|_| Change::Missing(path.to_path_buf())),
            // Still there but unreadable (mid-write, permissions): wait for the next event.
            None => None,
        }
    }
}

/// Re-reads the files touched during a burst (oldest first) and reports what changed: every
/// file that went missing, and only the **latest** changed file, so a window following a folder
/// lands on the most recent edit.
pub fn flush<R>(tracker: &mut Tracker, touched: &[PathBuf], read: &R) -> Vec<Change>
where
    R: Fn(&Path) -> Option<String>,
{
    let mut changes = Vec::new();
    let mut latest = None;
    for path in touched.iter().rev() {
        let content = read(path);
        let exists = content.is_some() || path.exists();
        match tracker.update(path, content, exists) {
            Some(missing @ Change::Missing(_)) => changes.push(missing),
            Some(changed) if latest.is_none() => latest = Some(changed),
            _ => {}
        }
    }
    changes.extend(latest);
    changes
}

enum Message {
    Touched(Vec<PathBuf>),
    Stop,
}

/// A running watch. Dropping it stops the watch.
pub struct Watch {
    stopped: Arc<AtomicBool>,
    tx: Sender<Message>,
    #[cfg_attr(not(test), allow(dead_code))]
    worker: Option<JoinHandle<()>>,
    // Dropped (and its file system stream stopped) with the Watch.
    _watcher: RecommendedWatcher,
}

/// What was on disk when the watch started: the content of each file in scope that could be
/// read. Callers use it to make sure the window shows the current content (closing the gap
/// between reading a document and starting to watch it).
pub type Seeded = Vec<(PathBuf, String)>;

impl Watch {
    /// Starts watching `scope`. `read` loads a file's content (`None` if it can't); `sink`
    /// receives each change, on a background thread.
    pub fn start<R, S>(scope: Scope, read: R, sink: S) -> notify::Result<(Watch, Seeded)>
    where
        R: Fn(&Path) -> Option<String> + Send + 'static,
        S: Fn(Change) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        let events = tx.clone();
        let filter = scope.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let touched: Vec<PathBuf> = event
                    .paths
                    .into_iter()
                    .filter(|p| filter.matches(p))
                    .collect();
                if !touched.is_empty() {
                    let _ = events.send(Message::Touched(touched));
                }
            })?;
        let (dir, mode) = scope.watch_target();
        watcher.watch(dir, mode)?;

        // Record what's there only once the watch is live, so no change can slip between.
        let mut tracker = Tracker::default();
        let mut seeded = Vec::new();
        for path in scope.initial_files() {
            if let Some(content) = read(&path) {
                tracker.record(path.clone(), content.clone());
                seeded.push((path, content));
            }
        }

        let stopped = Arc::new(AtomicBool::new(false));
        let stop_flag = stopped.clone();
        let worker = std::thread::Builder::new()
            .name("markydowny-watch".into())
            .spawn(move || {
                let mut debouncer = Debouncer::new(QUIET, MAX_WAIT);
                let mut touched: Vec<PathBuf> = Vec::new();
                loop {
                    let timeout = debouncer
                        .deadline()
                        .map(|d| d.saturating_duration_since(Instant::now()))
                        .unwrap_or(IDLE_TICK);
                    match rx.recv_timeout(timeout) {
                        Ok(Message::Touched(paths)) => {
                            for path in paths {
                                touched.retain(|p| p != &path);
                                touched.push(path);
                            }
                            debouncer.event(Instant::now());
                        }
                        Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    if stop_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    if debouncer.take_due(Instant::now()) {
                        let batch = std::mem::take(&mut touched);
                        for change in flush(&mut tracker, &batch, &read) {
                            if stop_flag.load(Ordering::SeqCst) {
                                return;
                            }
                            sink(change);
                        }
                    }
                }
            })
            .map_err(|e| notify::Error::generic(&e.to_string()))?;

        Ok((
            Watch {
                stopped,
                tx,
                worker: Some(worker),
                _watcher: watcher,
            },
            seeded,
        ))
    }

    /// Stops the watch and waits for its worker thread to finish.
    #[cfg(test)]
    pub fn shutdown(mut self) {
        self.signal_stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    fn signal_stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Message::Stop);
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // The worker exits on its own; nothing is sent after this point.
        self.signal_stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    fn read(path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    // ---- pure parts ------------------------------------------------------

    #[test]
    fn file_scope_matches_the_file_by_name_in_its_folder() {
        let scope = Scope::File(PathBuf::from("/docs/notes.md"));
        assert!(scope.matches(Path::new("/docs/notes.md")));
        assert!(!scope.matches(Path::new("/docs/notes.md.tmp")));
        assert!(!scope.matches(Path::new("/docs/other.md")));
        assert!(!scope.matches(Path::new("/docs/sub/notes.md")));
        assert!(!scope.matches(Path::new("/elsewhere/notes.md")));
    }

    #[test]
    fn debouncer_waits_for_quiet() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(100), ms(1000));
        assert_eq!(d.deadline(), None);
        assert!(!d.take_due(t0));
        d.event(t0);
        d.event(t0 + ms(50));
        assert!(!d.take_due(t0 + ms(100)));
        assert!(d.take_due(t0 + ms(150)));
        assert!(!d.take_due(t0 + ms(400)), "fires once per burst");
    }

    #[test]
    fn debouncer_caps_a_continuous_stream() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(100), ms(1000));
        let mut fired = 0;
        for i in 0..40 {
            let now = t0 + ms(i * 50);
            d.event(now);
            if d.take_due(now) {
                fired += 1;
            }
        }
        assert_eq!(fired, 1, "a 2 s stream reloads at the 1 s mark");
    }

    #[test]
    fn tracker_skips_identical_content_and_reports_missing_once() {
        let p = Path::new("/a.md");
        let mut t = Tracker::default();
        t.record(p.into(), "one".into());
        assert_eq!(t.update(p, Some("one".into()), true), None);
        assert_eq!(
            t.update(p, Some("two".into()), true),
            Some(Change::Changed {
                path: p.into(),
                content: "two".into(),
                previous: Some("one".into())
            })
        );
        assert_eq!(
            t.update(p, None, true),
            None,
            "unreadable but present: wait"
        );
        assert_eq!(t.update(p, None, false), Some(Change::Missing(p.into())));
        assert_eq!(t.update(p, None, false), None);
        assert_eq!(
            t.update(p, Some("two".into()), true),
            Some(Change::Changed {
                path: p.into(),
                content: "two".into(),
                previous: None
            }),
            "re-created file reloads even with the old content"
        );
    }

    #[test]
    fn flush_reports_only_the_latest_changed_file() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.md");
        let b = tmp.path().join("b.md");
        let gone = tmp.path().join("gone.md");
        std::fs::write(&a, "a2").unwrap();
        std::fs::write(&b, "b2").unwrap();
        let mut t = Tracker::default();
        t.record(a.clone(), "a1".into());
        t.record(b.clone(), "b1".into());
        t.record(gone.clone(), "x".into());

        let changes = flush(&mut t, &[gone.clone(), b.clone(), a.clone()], &read);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0], Change::Missing(gone));
        assert!(matches!(&changes[1], Change::Changed { path, .. } if path == &a));
        // b's new content was recorded too, so it doesn't fire later.
        assert_eq!(flush(&mut t, &[b], &read), vec![]);
    }

    // ---- against the real file system -------------------------------------

    struct Harness {
        watch: Option<Watch>,
        rx: Receiver<Change>,
    }

    fn watch(scope: Scope) -> (Harness, Seeded) {
        let (tx, rx) = mpsc::channel();
        let (watch, seeded) = Watch::start(scope, read, move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        // FSEvents can take a moment to start delivering.
        std::thread::sleep(ms(300));
        (
            Harness {
                watch: Some(watch),
                rx,
            },
            seeded,
        )
    }

    impl Harness {
        fn next(&self) -> Option<Change> {
            self.rx.recv_timeout(Duration::from_secs(5)).ok()
        }
        /// Everything that arrives within `wait`.
        fn drain(&self, wait: Duration) -> Vec<Change> {
            let deadline = Instant::now() + wait;
            let mut out = Vec::new();
            while let Ok(c) = self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                out.push(c);
            }
            out
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            if let Some(w) = self.watch.take() {
                w.shutdown();
            }
        }
    }

    fn content_of(change: Option<Change>) -> String {
        match change {
            Some(Change::Changed { content, .. }) => content,
            other => panic!("expected a change, got {other:?}"),
        }
    }

    fn setup(content: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("doc.md");
        std::fs::write(&file, content).unwrap();
        (tmp, file)
    }

    #[test]
    fn seeds_with_current_content() {
        let (_tmp, file) = setup("# one\n");
        let (_h, seeded) = watch(Scope::file(&file));
        assert_eq!(seeded.len(), 1);
        assert_eq!(seeded[0].1, "# one\n");
    }

    #[test]
    fn in_place_write_reloads() {
        let (_tmp, file) = setup("# one\n");
        let (h, _) = watch(Scope::file(&file));
        std::fs::write(&file, "# two\n").unwrap();
        assert_eq!(content_of(h.next()), "# two\n");
    }

    #[test]
    fn rename_over_the_file_reloads_every_time() {
        let (tmp, file) = setup("# one\n");
        let (h, _) = watch(Scope::file(&file));
        for n in 2..5 {
            let temp = tmp.path().join("doc.md.tmp");
            std::fs::write(&temp, format!("# v{n}\n")).unwrap();
            std::fs::rename(&temp, &file).unwrap();
            assert_eq!(content_of(h.next()), format!("# v{n}\n"));
        }
    }

    #[test]
    fn delete_reports_missing_and_recreate_reloads() {
        let (_tmp, file) = setup("# one\n");
        let (h, _) = watch(Scope::file(&file));
        std::fs::remove_file(&file).unwrap();
        assert!(matches!(h.next(), Some(Change::Missing(p)) if p.ends_with("doc.md")));
        std::fs::write(&file, "# back\n").unwrap();
        assert_eq!(content_of(h.next()), "# back\n");
    }

    #[test]
    fn sibling_changes_are_ignored() {
        let (tmp, file) = setup("# one\n");
        let (h, _) = watch(Scope::file(&file));
        std::fs::write(tmp.path().join("other.md"), "x").unwrap();
        std::fs::write(tmp.path().join("doc.md.bak"), "x").unwrap();
        assert_eq!(h.drain(ms(800)), vec![]);
        let _ = file;
    }

    #[test]
    fn a_burst_of_writes_reloads_once() {
        let (_tmp, file) = setup("# start\n");
        let (h, _) = watch(Scope::file(&file));
        for n in 0..10 {
            std::fs::write(&file, format!("# burst {n}\n")).unwrap();
            std::thread::sleep(ms(15));
        }
        let changes = h.drain(ms(1500));
        assert!(
            !changes.is_empty() && changes.len() <= 2,
            "expected one or two reloads, got {changes:?}"
        );
        assert_eq!(content_of(changes.last().cloned()), "# burst 9\n");
    }

    #[test]
    fn identical_content_sends_nothing() {
        let (_tmp, file) = setup("# same\n");
        let (h, _) = watch(Scope::file(&file));
        std::fs::write(&file, "# same\n").unwrap();
        assert_eq!(h.drain(ms(800)), vec![]);
    }

    #[test]
    fn stopping_releases_the_worker_and_sends_nothing_more() {
        let (_tmp, file) = setup("# one\n");
        for _ in 0..5 {
            let token = Arc::new(());
            let held = token.clone();
            let (tx, rx) = mpsc::channel();
            let (watch, _) = Watch::start(Scope::file(&file), read, move |c| {
                let _ = &held;
                let _ = tx.send(c);
            })
            .unwrap();
            drop(watch);
            std::fs::write(&file, format!("# {:?}\n", Instant::now())).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Arc::strong_count(&token) > 1 && Instant::now() < deadline {
                std::thread::sleep(ms(20));
            }
            assert_eq!(
                Arc::strong_count(&token),
                1,
                "worker and sink were released"
            );
            assert!(rx.try_recv().is_err());
        }
    }
}
