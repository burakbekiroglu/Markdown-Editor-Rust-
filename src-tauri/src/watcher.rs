//! Live workspace filesystem watcher.
//!
//! `notify` watches the canonical workspace root recursively. Raw events are
//! confined to that root and folded into a path-keyed batch over a 150 ms
//! window; exactly one `fs:changed` event is emitted per window.
//!
//! Two hash-based rules keep the pipeline quiet:
//!
//! * Content written by this application through [`crate::fs::write`] is
//!   recorded in [`SelfWriteRegistry`] for two seconds. A watcher event whose
//!   current content hash matches that record is our own echo and is skipped;
//!   the same path with a different hash is a genuine external change.
//! * The last hash published for a path is remembered. An event that would
//!   publish the same content again is skipped as well.
//!
//! Watcher failures are forwarded to the frontend as an `AppError`
//! (`WatcherFailed`) on `fs:watcher-error`; the watch is then re-created up to
//! [`MAX_RESTARTS`] times with a linear backoff.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::fs::read::read_bounded;

/// Event carrying one debounced [`FsChanged`] batch.
pub const FS_CHANGED_EVENT: &str = "fs:changed";
/// Event carrying a serialised `AppError` when the watch cannot run.
pub const WATCHER_ERROR_EVENT: &str = "fs:watcher-error";

/// How long raw events are collected before one batch is published.
pub const DEBOUNCE: Duration = Duration::from_millis(150);
/// How long a self-write record suppresses the matching watcher echo.
pub const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
/// Maximum number of self-write records kept.
pub const SELF_WRITE_CAPACITY: usize = 64;
/// Restart attempts after a watcher failure.
pub const MAX_RESTARTS: usize = 3;
/// Base delay between restart attempts (multiplied by the attempt number).
pub const RESTART_BACKOFF: Duration = Duration::from_millis(500);
/// Files above this size are never hashed; their events are always published.
const MAX_HASH_BYTES: u64 = 8 * 1024 * 1024;
/// How often the worker checks the stop flag while waiting for events.
const POLL_SLICE: Duration = Duration::from_millis(50);

/// Internal result of waiting for a debounce window.
enum Window {
    /// Events collected before the window closed.
    Events(Vec<notify::Result<Event>>),
    /// A stop was requested while waiting.
    Stopped,
    /// The watcher disappeared; the watch must be re-created.
    Closed,
}

/// What happened to one workspace-relative path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsChangeKind {
    Create,
    Modify,
    Remove,
}

impl FsChangeKind {
    /// Merge two observations of the same path inside one debounce window.
    ///
    /// A create followed by a modify is still a create; a replacement
    /// (remove + create) is reported as a modify because the path exists
    /// again. The final existence check in [`Batch::flush`] corrects the
    /// remaining edge cases.
    fn merge(self, next: Self) -> Self {
        match (self, next) {
            (Self::Create, Self::Modify) | (Self::Modify, Self::Create) => Self::Create,
            (Self::Remove, Self::Create) => Self::Modify,
            (Self::Create, Self::Remove) | (Self::Remove, Self::Modify) => Self::Modify,
            _ => next,
        }
    }
}

/// One path in a published batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// Workspace-relative path, always `/` separated.
    pub path: String,
    pub kind: FsChangeKind,
}

/// Payload of [`FS_CHANGED_EVENT`]: one entry per changed path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChanged {
    pub changes: Vec<FsChange>,
}

/// Deterministic content hash used for echo suppression.
pub fn content_hash(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

/// One self-write record.
#[derive(Debug, Clone)]
struct SelfWrite {
    path: String,
    hash: u64,
    at: Instant,
}

/// Records successful application writes so the watcher can ignore its echo.
///
/// Cloning is cheap: all clones share the same queue. The queue is an LRU with
/// a two-second lifetime and a bounded capacity, so expired records cannot
/// accumulate.
#[derive(Debug, Clone, Default)]
pub struct SelfWriteRegistry {
    entries: Arc<Mutex<VecDeque<SelfWrite>>>,
}

impl SelfWriteRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that `contents` were just written to `relative_path`.
    pub fn record(&self, relative_path: &str, contents: &[u8]) {
        self.record_at(relative_path, content_hash(contents), Instant::now());
    }

    fn record_at(&self, relative_path: &str, hash: u64, at: Instant) {
        let path = normalize_relative(relative_path);
        if path.is_empty() {
            return;
        }
        let mut entries = self.lock();
        prune(&mut entries, at);
        entries.retain(|entry| entry.path != path);
        entries.push_back(SelfWrite { path, hash, at });
        while entries.len() > SELF_WRITE_CAPACITY {
            entries.pop_front();
        }
    }

    /// Whether `hash` for `relative_path` is a recent application write.
    pub fn matches(&self, relative_path: &str, hash: u64) -> bool {
        self.matches_at(relative_path, hash, Instant::now())
    }

    fn matches_at(&self, relative_path: &str, hash: u64, at: Instant) -> bool {
        let path = normalize_relative(relative_path);
        let mut entries = self.lock();
        prune(&mut entries, at);
        entries
            .iter()
            .any(|entry| entry.path == path && entry.hash == hash)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<SelfWrite>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn prune(entries: &mut VecDeque<SelfWrite>, now: Instant) {
    while let Some(front) = entries.front() {
        if now.saturating_duration_since(front.at) >= SELF_WRITE_TTL {
            entries.pop_front();
        } else {
            break;
        }
    }
}

fn normalize_relative(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

/// Path-keyed accumulator for one debounce window.
#[derive(Debug, Default)]
struct Batch {
    order: Vec<String>,
    kinds: HashMap<String, FsChangeKind>,
}

impl Batch {
    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn push(&mut self, path: String, kind: FsChangeKind) {
        match self.kinds.get_mut(&path) {
            Some(existing) => *existing = existing.merge(kind),
            None => {
                self.order.push(path.clone());
                self.kinds.insert(path, kind);
            }
        }
    }

    /// Convert the accumulator into the published payload, dropping echoes and
    /// unchanged content. `published` tracks the last hash per path.
    fn flush(
        self,
        root: &Path,
        self_writes: &SelfWriteRegistry,
        published: &mut HashMap<String, Option<u64>>,
    ) -> Option<FsChanged> {
        let mut changes = Vec::with_capacity(self.order.len());
        for path in self.order {
            let Some(&kind) = self.kinds.get(&path) else {
                continue;
            };
            let hash = file_hash(root, &path);
            let exists = root.join(&path).symlink_metadata().is_ok();
            // The filesystem at flush time is authoritative: a rename reports
            // the old path as Modify, but only its disappearance matters.
            let kind = match (kind, exists) {
                (_, false) => FsChangeKind::Remove,
                (FsChangeKind::Remove, true) => FsChangeKind::Modify,
                (FsChangeKind::Create, true) => FsChangeKind::Create,
                _ => FsChangeKind::Modify,
            };

            match (kind, hash) {
                (FsChangeKind::Remove, _) => {
                    if published.get(&path) == Some(&None) {
                        continue;
                    }
                    published.insert(path.clone(), None);
                }
                (_, Some(hash)) => {
                    if self_writes.matches(&path, hash) {
                        published.insert(path.clone(), Some(hash));
                        continue;
                    }
                    if published.get(&path) == Some(&Some(hash)) {
                        continue;
                    }
                    published.insert(path.clone(), Some(hash));
                }
                (_, None) => {
                    // Directories and oversized/unreadable files have no hash;
                    // publish them without a dedup comparison.
                }
            }

            changes.push(FsChange { path, kind });
        }

        if changes.is_empty() {
            None
        } else {
            Some(FsChanged { changes })
        }
    }
}

/// Hash of a regular file below the root, or `None` for directories, missing
/// files and files above [`MAX_HASH_BYTES`].
fn file_hash(root: &Path, relative: &str) -> Option<u64> {
    let path = root.join(relative);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_HASH_BYTES {
        return None;
    }
    // The read itself is capped: a file can grow between the metadata check
    // and the read, and the watcher must never allocate past the hash limit.
    let bytes = read_bounded(&path, MAX_HASH_BYTES).ok()?;
    if bytes.len() as u64 > MAX_HASH_BYTES {
        return None;
    }
    Some(content_hash(&bytes))
}

/// Convert an absolute watcher path into a workspace-relative `/` path.
///
/// Returns `None` when the path is outside the root, is the root itself, or
/// contains a component that could climb out (`..`, drive change, UNC prefix).
/// Existing paths are additionally verified through `canonicalize`, which
/// catches symlink/junction redirections that leave the root.
pub fn relative_within(root: &Path, path: &Path) -> Option<String> {
    let root = strip_verbatim(root);
    let path = strip_verbatim(path);
    let relative = path.strip_prefix(&root).ok()?;

    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }

    if path.exists() {
        let canonical_root = fs::canonicalize(&root).ok()?;
        let canonical_path = fs::canonicalize(&path).ok()?;
        canonical_path.strip_prefix(&canonical_root).ok()?;
    }

    Some(parts.join("/"))
}

/// Remove the Windows verbatim prefix so `strip_prefix` sees the same shape
/// for the canonical root and the paths reported by `notify`.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else if let Some(rest) = text.strip_prefix(r"\\.\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Map one raw watcher event onto workspace-relative observations.
///
/// Sibling temporary files created by atomic saves are skipped: their whole
/// life cycle belongs to one save and must not flicker the tree.
fn observations(root: &Path, event: &Event) -> Vec<(String, FsChangeKind)> {
    let kind = match event.kind {
        EventKind::Access(_) => return Vec::new(),
        EventKind::Create(_) => FsChangeKind::Create,
        EventKind::Remove(_) => FsChangeKind::Remove,
        EventKind::Modify(_) | EventKind::Any | EventKind::Other => FsChangeKind::Modify,
    };
    event
        .paths
        .iter()
        .filter(|path| {
            path.file_name()
                .map(|name| {
                    !name
                        .to_string_lossy()
                        .starts_with(crate::fs::atomic::TEMP_PREFIX)
                })
                .unwrap_or(true)
        })
        .filter_map(|path| relative_within(root, path).map(|relative| (relative, kind)))
        .collect()
}

/// Upper bound for events collected in one debounce window.
///
/// Reaching the cap ends the window early instead of letting the in-memory
/// buffer grow without limit during an event flood; no event is dropped —
/// the leftovers stay queued in the channel and surface in the next window.
const MAX_WINDOW_EVENTS: usize = 1024;

/// Collect the first event plus everything arriving inside one window.
///
/// The first wait is sliced so a stop request is honoured even when the
/// workspace is completely idle; a full `recv` would block the join in
/// [`WatcherState::stop`] until the next external change.
fn collect_window(
    receiver: &Receiver<notify::Result<Event>>,
    window: Duration,
    stop: &AtomicBool,
) -> Window {
    let first = loop {
        if stop.load(Ordering::SeqCst) {
            return Window::Stopped;
        }
        match receiver.recv_timeout(POLL_SLICE) {
            Ok(event) => break event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Window::Closed,
        }
    };

    let deadline = Instant::now() + window;
    let mut events = vec![first];
    loop {
        if stop.load(Ordering::SeqCst) {
            return Window::Stopped;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || events.len() >= MAX_WINDOW_EVENTS {
            return Window::Events(events);
        }
        match receiver.recv_timeout(remaining.min(POLL_SLICE)) {
            Ok(event) => events.push(event),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Window::Closed,
        }
    }
}

/// Owns the worker thread and its stop flag.
struct Runtime {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Managed state holding the active workspace watch, if any.
#[derive(Default)]
pub struct WatcherState {
    slot: Mutex<Option<Runtime>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start watching `root`, replacing any previous watch.
    ///
    /// Blocks until the initial recursive watch is registered. On failure the
    /// error is returned so the command can surface it; no execution-time
    /// error escapes this call.
    pub fn start(
        &self,
        app: AppHandle,
        root: PathBuf,
        self_writes: SelfWriteRegistry,
    ) -> Result<(), AppError> {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Dropping the previous runtime joins its worker outside the new one.
        *slot = None;

        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_stop = Arc::clone(&stop);
        let join = thread::Builder::new()
            .name("workspace-watcher".into())
            .spawn(move || run(app, root, self_writes, worker_stop, ready_tx))
            .map_err(|error| {
                AppError::watcher_failed(format!("izleyici iş parçacığı başlatılamadı: {error}"))
            })?;

        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                *slot = Some(Runtime {
                    stop,
                    join: Some(join),
                });
                Ok(())
            }
            Ok(Err(message)) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                Err(AppError::watcher_failed(message))
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                let _ = join.join();
                Err(AppError::watcher_failed(
                    "izleyici zamanında başlatılamadı".to_string(),
                ))
            }
        }
    }

    /// Stop watching and wait for the worker to exit.
    pub fn stop(&self) {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = None;
    }
}

type ReadySender = mpsc::Sender<Result<(), String>>;

/// Worker entry point: create the watcher, survive transient failures, and
/// publish batches until stopped.
fn run(
    app: AppHandle,
    root: PathBuf,
    self_writes: SelfWriteRegistry,
    stop: Arc<AtomicBool>,
    ready: ReadySender,
) {
    let mut ready_sent = false;
    let mut restarts = 0usize;

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }

        let (sender, receiver) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |result| {
            let _ = sender.send(result);
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                if !retry(
                    &app,
                    &ready,
                    ready_sent,
                    &stop,
                    &mut restarts,
                    &error.to_string(),
                ) {
                    return;
                }
                continue;
            }
        };

        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
            if !retry(
                &app,
                &ready,
                ready_sent,
                &stop,
                &mut restarts,
                &error.to_string(),
            ) {
                return;
            }
            continue;
        }

        if !ready_sent {
            let _ = ready.send(Ok(()));
            ready_sent = true;
        }
        restarts = 0;

        let mut published: HashMap<String, Option<u64>> = HashMap::new();
        let mut batch = Batch::default();
        let mut failure: Option<String> = None;

        while !stop.load(Ordering::SeqCst) {
            let mut events = match collect_window(&receiver, DEBOUNCE, &stop) {
                Window::Events(events) => events,
                Window::Stopped => return,
                Window::Closed => {
                    failure = Some("izleyici kanalı kapandı".to_string());
                    break;
                }
            };
            // While the first event waits in `collect_window`, the stop flag is
            // not checked. The window itself is short, so this is bounded.
            let mut error_message: Option<String> = None;
            for result in events.drain(..) {
                match result {
                    Ok(event) => {
                        for (path, kind) in observations(&root, &event) {
                            batch.push(path, kind);
                        }
                    }
                    Err(error) => {
                        error_message.get_or_insert_with(|| error.to_string());
                    }
                }
            }

            if let Some(message) = error_message {
                failure = Some(message);
                break;
            }

            if !batch.is_empty() {
                let ready_batch = std::mem::take(&mut batch);
                if let Some(payload) = ready_batch.flush(&root, &self_writes, &mut published) {
                    // The UI only refreshes from this event; a dropped one must
                    // at least leave a trace instead of failing silently.
                    if let Err(error) = app.emit(FS_CHANGED_EVENT, payload) {
                        eprintln!("[error] {FS_CHANGED_EVENT} olayı yayınlanamadı: {error}");
                    }
                }
            }
        }

        if stop.load(Ordering::SeqCst) {
            return;
        }

        let message = failure.unwrap_or_else(|| "izleyici durdu".to_string());
        if !retry(&app, &ready, true, &stop, &mut restarts, &message) {
            return;
        }
    }
}

/// Emit a `WatcherFailed` error and decide whether to retry.
///
/// Returns `true` when the caller should attempt another watch. If the initial
/// watch never started, the error is also sent back to [`WatcherState::start`]
/// once retries are exhausted.
fn retry(
    app: &AppHandle,
    ready: &ReadySender,
    ready_sent: bool,
    stop: &AtomicBool,
    restarts: &mut usize,
    message: &str,
) -> bool {
    if stop.load(Ordering::SeqCst) {
        return false;
    }
    // Before the initial watch is ready the caller surfaces the failure
    // through `WatcherState::start`; emitting here as well would double-toast.
    if ready_sent {
        if let Err(error) = app.emit(
            WATCHER_ERROR_EVENT,
            AppError::watcher_failed(message.to_string()),
        ) {
            eprintln!("[error] {WATCHER_ERROR_EVENT} olayı yayınlanamadı: {error}");
        }
    }
    *restarts += 1;
    if *restarts > MAX_RESTARTS {
        if !ready_sent {
            let _ = ready.send(Err(message.to_string()));
        }
        return false;
    }
    let backoff = RESTART_BACKOFF * *restarts as u32;
    if !sleep_unless_stopped(stop, backoff) {
        return false;
    }
    true
}

/// Sleep in short slices so [`WatcherState::stop`] does not wait for a full
/// backoff. Returns `false` when a stop was requested.
fn sleep_unless_stopped(stop: &AtomicBool, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    loop {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        thread::sleep(remaining.min(POLL_SLICE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::CreateKind;
    use std::sync::mpsc::channel;
    use tempfile::TempDir;

    fn root_of(temp: &TempDir) -> PathBuf {
        fs::canonicalize(temp.path()).expect("canonical root")
    }

    #[test]
    fn debounce_window_is_150ms() {
        assert_eq!(DEBOUNCE, Duration::from_millis(150));
    }

    #[test]
    fn filters_paths_outside_the_root_and_the_root_itself() {
        let inside = TempDir::new().expect("inside");
        let outside = TempDir::new().expect("outside");
        let root = root_of(&inside);
        let note = root.join("notes").join("a.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "x").unwrap();

        assert_eq!(relative_within(&root, &note).as_deref(), Some("notes/a.md"));
        assert_eq!(relative_within(&root, &root), None);
        assert_eq!(relative_within(&root, &outside.path().join("x.md")), None);
        assert_eq!(relative_within(&root, &root.join("..").join("x.md")), None);
    }

    #[test]
    fn maps_event_kinds_and_ignores_access_events() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let path = root.join("a.md");
        fs::write(&path, "x").unwrap();

        let create = Event::new(EventKind::Create(CreateKind::File)).add_path(path.clone());
        assert_eq!(
            observations(&root, &create),
            vec![("a.md".to_string(), FsChangeKind::Create)]
        );

        let access =
            Event::new(EventKind::Access(notify::event::AccessKind::Read)).add_path(path.clone());
        assert!(observations(&root, &access).is_empty());

        let outside = Event::new(EventKind::Remove(notify::event::RemoveKind::File))
            .add_path(TempDir::new().unwrap().path().join("b.md"));
        assert!(observations(&root, &outside).is_empty());
    }

    #[test]
    fn merges_repeated_paths_inside_one_window() {
        let mut batch = Batch::default();
        batch.push("a.md".into(), FsChangeKind::Create);
        batch.push("a.md".into(), FsChangeKind::Modify);
        batch.push("b.md".into(), FsChangeKind::Remove);

        assert_eq!(batch.order, vec!["a.md", "b.md"]);
        assert_eq!(batch.kinds["a.md"], FsChangeKind::Create);
        assert_eq!(batch.kinds["b.md"], FsChangeKind::Remove);
    }

    #[test]
    fn collects_events_arriving_inside_the_window() {
        let (sender, receiver) = channel();
        let base = TempDir::new().unwrap();
        sender
            .send(Ok(
                Event::new(EventKind::Any).add_path(base.path().join("a"))
            ))
            .unwrap();
        sender
            .send(Ok(
                Event::new(EventKind::Any).add_path(base.path().join("b"))
            ))
            .unwrap();

        let events = collect_window(
            &receiver,
            Duration::from_millis(40),
            &AtomicBool::new(false),
        );
        let Window::Events(events) = events else {
            panic!("expected collected events");
        };
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn stop_interrupts_an_idle_window() {
        let (_sender, receiver) = channel();
        let stop = AtomicBool::new(true);
        assert!(matches!(
            collect_window(&receiver, DEBOUNCE, &stop),
            Window::Stopped
        ));
    }

    #[test]
    fn window_buffer_is_capped_and_leftovers_surface_later() {
        let (sender, receiver) = channel();
        let base = TempDir::new().unwrap();
        for index in 0..MAX_WINDOW_EVENTS + 5 {
            sender
                .send(Ok(Event::new(EventKind::Any).add_path(
                    base.path().join(format!("f{}.md", index)),
                )))
                .unwrap();
        }
        let stop = AtomicBool::new(false);

        let Window::Events(first) = collect_window(&receiver, DEBOUNCE, &stop) else {
            panic!("expected collected events");
        };
        assert_eq!(
            first.len(),
            MAX_WINDOW_EVENTS,
            "pencere tamponu üst sınırla kesilmeli"
        );

        let Window::Events(second) = collect_window(&receiver, DEBOUNCE, &stop) else {
            panic!("expected collected events");
        };
        assert_eq!(
            second.len(),
            5,
            "sınırı aşan olaylar bir sonraki pencerede teslim edilmeli"
        );
    }

    #[test]
    fn skips_atomic_save_temporary_files() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let path = root.join(format!("{}123-a.md", crate::fs::atomic::TEMP_PREFIX));
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(path);
        assert!(observations(&root, &event).is_empty());
    }

    #[test]
    fn real_notify_events_are_confined_and_observed() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let (sender, receiver) = channel();
        let mut watcher = notify::recommended_watcher(sender).expect("watcher");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch root");

        fs::write(root.join("canli.md"), "dışarıdan").expect("write");
        let stop = AtomicBool::new(false);
        let mut observed = Vec::new();
        for _ in 0..8 {
            match collect_window(&receiver, DEBOUNCE, &stop) {
                Window::Events(events) => {
                    for event in events.into_iter().flatten() {
                        for (path, _) in observations(&root, &event) {
                            if path == "canli.md" {
                                observed.push(path);
                            }
                        }
                    }
                }
                Window::Closed => break,
                Window::Stopped => unreachable!("stop flag is never set"),
            }
            if !observed.is_empty() {
                break;
            }
        }
        assert_eq!(observed.first().map(String::as_str), Some("canli.md"));
    }

    #[test]
    fn external_change_is_published_within_300ms() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let (sender, receiver) = channel();
        let mut watcher = notify::recommended_watcher(sender).expect("watcher");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch root");

        let started = Instant::now();
        fs::write(root.join("hizli.md"), "dışarıdan").expect("write");
        let stop = AtomicBool::new(false);
        let mut published = false;
        for _ in 0..4 {
            match collect_window(&receiver, DEBOUNCE, &stop) {
                Window::Events(events) => {
                    let hit = events.into_iter().flatten().any(|event| {
                        observations(&root, &event)
                            .iter()
                            .any(|(path, _)| path == "hizli.md")
                    });
                    if hit {
                        published = true;
                        break;
                    }
                }
                Window::Closed => break,
                Window::Stopped => unreachable!("stop flag is never set"),
            }
        }
        let elapsed = started.elapsed();
        assert!(published, "değişiklik hiç yayınlanmadı");
        assert!(
            elapsed < Duration::from_millis(300),
            "150 ms debounce bütçesi aşıldı: {elapsed:?}"
        );
    }

    #[test]
    fn self_write_records_expire_after_two_seconds() {
        assert_eq!(SELF_WRITE_TTL, Duration::from_secs(2));
        let registry = SelfWriteRegistry::new();
        let at = Instant::now();
        registry.record_at("notes\\a.md", 42, at);

        assert!(registry.matches_at("notes/a.md", 42, at + Duration::from_millis(500)));
        assert!(registry.matches_at("notes/a.md", 42, at + Duration::from_millis(1500)));
        assert!(!registry.matches_at("notes/a.md", 42, at + SELF_WRITE_TTL));
        assert!(!registry.matches_at("notes/a.md", 7, at));
        assert!(!registry.matches_at("notes/b.md", 42, at));
    }

    #[test]
    fn expired_self_write_records_are_removed_from_memory() {
        let registry = SelfWriteRegistry::new();
        let at = Instant::now();
        for index in 0..5 {
            registry.record_at(&format!("f{index}.md"), index as u64, at);
        }
        assert_eq!(registry.lock().len(), 5);

        // A lookup after the TTL prunes every expired record instead of merely
        // marking it unmatched, so the queue cannot grow without bound.
        assert!(!registry.matches_at("f0.md", 0, at + SELF_WRITE_TTL));
        assert!(registry.lock().is_empty());
    }

    #[test]
    fn a_different_hash_inside_the_self_write_window_is_external() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        fs::write(root.join("a.md"), "diskten").unwrap();
        let registry = SelfWriteRegistry::new();
        registry.record("a.md", "editorden".as_bytes());
        let mut published = HashMap::new();

        let mut batch = Batch::default();
        batch.push("a.md".into(), FsChangeKind::Modify);
        let payload = batch
            .flush(&root, &registry, &mut published)
            .expect("external change is published");
        assert_eq!(payload.changes[0].kind, FsChangeKind::Modify);
        assert_eq!(payload.changes[0].path, "a.md");
    }

    #[test]
    fn self_write_registry_is_bounded() {
        let registry = SelfWriteRegistry::new();
        let at = Instant::now();
        for index in 0..(SELF_WRITE_CAPACITY + 10) {
            registry.record_at(&format!("f{index}.md"), index as u64, at);
        }
        assert_eq!(registry.lock().len(), SELF_WRITE_CAPACITY);
    }

    #[test]
    fn publishes_a_change_once_per_content_hash() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        fs::write(root.join("a.md"), "içerik").unwrap();
        let mut published = HashMap::new();
        let registry = SelfWriteRegistry::new();

        let mut first = Batch::default();
        first.push("a.md".into(), FsChangeKind::Modify);
        let payload = first
            .flush(&root, &registry, &mut published)
            .expect("first");
        assert_eq!(payload.changes[0].kind, FsChangeKind::Modify);

        let mut second = Batch::default();
        second.push("a.md".into(), FsChangeKind::Modify);
        assert!(second.flush(&root, &registry, &mut published).is_none());

        fs::write(root.join("a.md"), "değişti").unwrap();
        let mut third = Batch::default();
        third.push("a.md".into(), FsChangeKind::Modify);
        assert!(third.flush(&root, &registry, &mut published).is_some());
    }

    #[test]
    fn suppresses_our_own_write_echo() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        fs::write(root.join("a.md"), "kaydedildi").unwrap();
        let registry = SelfWriteRegistry::new();
        registry.record("a.md", "kaydedildi".as_bytes());
        let mut published = HashMap::new();

        let mut batch = Batch::default();
        batch.push("a.md".into(), FsChangeKind::Modify);
        assert!(batch.flush(&root, &registry, &mut published).is_none());
        assert_eq!(
            published.get("a.md"),
            Some(&Some(content_hash(b"kaydedildi")))
        );
    }

    #[test]
    fn removed_file_is_published_and_repeated_removal_is_deduped() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let mut published = HashMap::new();
        let registry = SelfWriteRegistry::new();

        let mut first = Batch::default();
        first.push("gone.md".into(), FsChangeKind::Remove);
        let payload = first
            .flush(&root, &registry, &mut published)
            .expect("first");
        assert_eq!(payload.changes[0].kind, FsChangeKind::Remove);

        let mut second = Batch::default();
        second.push("gone.md".into(), FsChangeKind::Remove);
        assert!(second.flush(&root, &registry, &mut published).is_none());
    }

    #[test]
    fn a_file_recreated_inside_the_window_is_a_modify_not_a_remove() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        fs::write(root.join("a.md"), "yeni").unwrap();
        let mut published = HashMap::new();

        let mut batch = Batch::default();
        batch.push("a.md".into(), FsChangeKind::Remove);
        let payload = batch
            .flush(&root, &SelfWriteRegistry::new(), &mut published)
            .expect("published");
        assert_eq!(payload.changes[0].kind, FsChangeKind::Modify);
    }

    #[test]
    fn a_renamed_away_path_is_reported_as_remove() {
        let temp = TempDir::new().expect("temp");
        let root = root_of(&temp);
        let mut published = HashMap::new();

        let mut batch = Batch::default();
        batch.push("eski.md".into(), FsChangeKind::Modify);
        let payload = batch
            .flush(&root, &SelfWriteRegistry::new(), &mut published)
            .expect("published");
        assert_eq!(payload.changes[0].kind, FsChangeKind::Remove);
    }
}
