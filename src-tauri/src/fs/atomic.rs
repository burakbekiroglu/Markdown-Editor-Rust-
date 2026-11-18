//! Atomic file replacement.
//!
//! Saves never write directly into the target file. The new contents are
//! written to a temporary file in the *same directory* (same volume), flushed
//! and `sync_all`-ed, and only then renamed over the target. A crash before
//! the rename leaves the old file byte-for-byte intact; a crash after the
//! rename leaves the completely written new file. There is no intermediate
//! state visible to readers.
//!
//! On Windows the rename can transiently fail with `ERROR_SHARING_VIOLATION`
//! (32), `ERROR_LOCK_VIOLATION` (33) or `ERROR_ACCESS_DENIED` (5) because an
//! antivirus scanner or the search indexer has the freshly written temporary
//! file (or the target) open. Those errors are retried with a bounded
//! exponential backoff (at least [`DEFAULT_MAX_ATTEMPTS`] attempts by default).
//! Any other failure is reported immediately and the temporary file is
//! removed on a best-effort basis.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

/// Total rename attempts (initial try included).
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
/// First backoff delay between rename attempts.
pub const DEFAULT_BASE_DELAY_MS: u64 = 25;
/// Upper bound for a single backoff delay.
pub const DEFAULT_MAX_DELAY_MS: u64 = 250;

/// Prefix of the sibling temporary file. The rest of the name contains the
/// original file name, the process id and a monotonic counter, so concurrent
/// saves of different files (or different tabs) never collide.
pub const TEMP_PREFIX: &str = ".md-editor-save-";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Bounded retry policy for the rename step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            base_delay_ms: DEFAULT_BASE_DELAY_MS,
            max_delay_ms: DEFAULT_MAX_DELAY_MS,
        }
    }
}

impl RetryPolicy {
    /// Normalises user supplied values so a policy can never loop forever or
    /// sleep arbitrarily long.
    fn bounded(self) -> Self {
        Self {
            max_attempts: self.max_attempts.max(1),
            base_delay_ms: self.base_delay_ms.min(5_000),
            max_delay_ms: self.max_delay_ms.max(self.base_delay_ms).min(5_000),
        }
    }

    fn delay_for_attempt(&self, completed_attempts: u32) -> Duration {
        let shift = completed_attempts.saturating_sub(1).min(16);
        let millis = self
            .base_delay_ms
            .saturating_mul(1_u64 << shift)
            .min(self.max_delay_ms);
        Duration::from_millis(millis)
    }
}

/// Failure modes of an atomic save.
#[derive(Debug, thiserror::Error)]
pub enum AtomicWriteError {
    #[error("hedefin mevcut bir üst klasörü yok: {0}")]
    MissingParent(PathBuf),

    #[error("{target} yanında geçici dosya oluşturulamadı: {source}")]
    TempCreate {
        target: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("geçici dosya yazılamadı {path}: {source}")]
    TempWrite {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("geçici dosya diske aktarılamadı {path}: {source}")]
    TempFlush {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("geçici dosya senkronize edilemedi {path}: {source}")]
    TempSync {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error(
        "hedef {target} {attempts} denemeden sonra hâlâ kilitli (paylaşım ihlali): {source}"
    )]
    SharingViolation {
        target: PathBuf,
        attempts: u32,
        #[source]
        source: io::Error,
    },

    #[error("{target} değiştirilemedi: {source}")]
    Rename {
        target: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl AtomicWriteError {
    /// Stable identifier the frontend can map to a user-facing message.
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingParent(_) => "SaveParentMissing",
            Self::TempCreate { .. } => "SaveTempCreateFailed",
            Self::TempWrite { .. } => "SaveTempWriteFailed",
            Self::TempFlush { .. } => "SaveTempFlushFailed",
            Self::TempSync { .. } => "SaveTempSyncFailed",
            Self::SharingViolation { .. } => "SaveFileLocked",
            Self::Rename { .. } => "SaveFailed",
        }
    }
}

/// Atomically replaces `target` with `contents` using the default retry policy.
pub fn atomic_write(target: &Path, contents: &[u8]) -> Result<(), AtomicWriteError> {
    atomic_write_with_policy(target, contents, RetryPolicy::default())
}

/// Atomically replaces `target` with `contents`.
///
/// The temporary file is created in the target's directory, fully written,
/// flushed and synced before it is renamed over the target.
pub fn atomic_write_with_policy(
    target: &Path,
    contents: &[u8],
    policy: RetryPolicy,
) -> Result<(), AtomicWriteError> {
    let policy = policy.bounded();
    let temp = stage_temp_file(target, contents)?;

    match replace_with_retry(&temp, target, policy) {
        Ok(()) => Ok(()),
        Err(failure) => {
            remove_temp_file(&temp);
            Err(failure.into_error(target))
        }
    }
}

/// Writes `contents` to a sibling temporary file and closes it.
///
/// The temporary file is complete and durable when this returns. Separating
/// this step makes the crash window testable: killing the process after this
/// function but before the rename leaves the target untouched.
fn stage_temp_file(target: &Path, contents: &[u8]) -> Result<PathBuf, AtomicWriteError> {
    let parent = parent_directory(target)?;
    let (temp_path, mut file) = create_temp_file(&parent, target)?;

    if let Err(source) = write_and_sync(&mut file, contents) {
        drop(file);
        remove_temp_file(&temp_path);
        return Err(match source {
            StageError::Write(source) => AtomicWriteError::TempWrite {
                path: temp_path,
                source,
            },
            StageError::Flush(source) => AtomicWriteError::TempFlush {
                path: temp_path,
                source,
            },
            StageError::Sync(source) => AtomicWriteError::TempSync {
                path: temp_path,
                source,
            },
        });
    }

    // Windows refuses to rename a file while our own handle is open.
    drop(file);
    Ok(temp_path)
}

fn parent_directory(target: &Path) -> Result<PathBuf, AtomicWriteError> {
    let parent = match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(AtomicWriteError::MissingParent(parent.to_path_buf()));
    }
    Ok(parent.to_path_buf())
}

fn create_temp_file(parent: &Path, target: &Path) -> Result<(PathBuf, File), AtomicWriteError> {
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".to_string());

    let mut last_error = None;
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            "{TEMP_PREFIX}{file_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                last_error = Some(source);
            }
            Err(source) => {
                return Err(AtomicWriteError::TempCreate {
                    target: target.to_path_buf(),
                    source,
                });
            }
        }
    }

    Err(AtomicWriteError::TempCreate {
        target: target.to_path_buf(),
        source: last_error.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "no unique temporary file name available",
            )
        }),
    })
}

enum StageError {
    Write(io::Error),
    Flush(io::Error),
    Sync(io::Error),
}

fn write_and_sync(file: &mut File, contents: &[u8]) -> Result<(), StageError> {
    file.write_all(contents).map_err(StageError::Write)?;
    file.flush().map_err(StageError::Flush)?;
    file.sync_all().map_err(StageError::Sync)?;
    Ok(())
}

#[derive(Debug)]
enum ReplaceFailure {
    /// The target (or our temporary file) stayed locked by another process.
    Locked { attempts: u32, source: io::Error },
    /// Rename failed for a reason retrying cannot fix.
    Other { source: io::Error },
}

impl ReplaceFailure {
    fn into_error(self, target: &Path) -> AtomicWriteError {
        match self {
            Self::Locked { attempts, source } => AtomicWriteError::SharingViolation {
                target: target.to_path_buf(),
                attempts,
                source,
            },
            Self::Other { source } => AtomicWriteError::Rename {
                target: target.to_path_buf(),
                source,
            },
        }
    }
}

fn replace_with_retry(
    temp: &Path,
    target: &Path,
    policy: RetryPolicy,
) -> Result<(), ReplaceFailure> {
    let mut attempt: u32 = 1;
    loop {
        match fs::rename(temp, target) {
            Ok(()) => return Ok(()),
            Err(source) => {
                if !is_transient_lock_error(&source) {
                    return Err(ReplaceFailure::Other { source });
                }
                if attempt >= policy.max_attempts {
                    return Err(ReplaceFailure::Locked {
                        attempts: attempt,
                        source,
                    });
                }
                thread::sleep(policy.delay_for_attempt(attempt));
                attempt += 1;
            }
        }
    }
}

/// Errors Windows returns when an antivirus scanner, the search indexer or
/// another editor temporarily holds the file open.
#[cfg(windows)]
fn is_transient_lock_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// On Unix an open file does not prevent a rename, so no transient lock error
/// is expected here.
#[cfg(not(windows))]
fn is_transient_lock_error(_error: &io::Error) -> bool {
    false
}

/// Removes a temporary file, ignoring errors: the original failure is more
/// important than a leftover hidden file. A crash can leave one behind; it is
/// never read and never replaces the target.
fn remove_temp_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::tempdir;

    fn temp_files_in(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .expect("read dir")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().starts_with(TEMP_PREFIX))
                    .unwrap_or(false)
            })
            .collect()
    }

    #[test]
    fn creates_new_file_and_leaves_no_temp_behind() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");

        atomic_write(&target, b"# hello\n").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"# hello\n");
        assert!(temp_files_in(dir.path()).is_empty());
    }

    #[test]
    fn replaces_existing_file_as_a_whole() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, b"old contents that are much longer").unwrap();

        atomic_write(&target, b"new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(temp_files_in(dir.path()).is_empty());
    }

    #[test]
    fn interrupted_before_rename_leaves_target_untouched() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, b"old").unwrap();

        // Simulates a forced kill after the temporary file was fully written
        // and synced but before the rename happened.
        let staged = stage_temp_file(&target, b"completely new contents").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(fs::read(&staged).unwrap(), b"completely new contents");
        fs::remove_file(&staged).unwrap();
    }

    #[test]
    fn completes_staged_file_then_renames_it() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");

        let staged = stage_temp_file(&target, b"payload").unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"payload");
        assert!(!target.exists());

        replace_with_retry(&staged, &target, RetryPolicy::default()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"payload");
        assert!(!staged.exists());
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        let policy = RetryPolicy {
            max_attempts: 10,
            base_delay_ms: 25,
            max_delay_ms: 250,
        };
        assert_eq!(policy.delay_for_attempt(1), Duration::from_millis(25));
        assert_eq!(policy.delay_for_attempt(2), Duration::from_millis(50));
        assert_eq!(policy.delay_for_attempt(3), Duration::from_millis(100));
        assert_eq!(policy.delay_for_attempt(4), Duration::from_millis(200));
        assert_eq!(policy.delay_for_attempt(5), Duration::from_millis(250));
        assert_eq!(policy.delay_for_attempt(60), Duration::from_millis(250));
    }

    #[test]
    fn normalises_unbounded_policies() {
        let policy = RetryPolicy {
            max_attempts: 0,
            base_delay_ms: 50_000,
            max_delay_ms: 1,
        }
        .bounded();
        assert_eq!(policy.max_attempts, 1);
        assert_eq!(policy.base_delay_ms, 5_000);
        assert_eq!(policy.max_delay_ms, 5_000);
    }

    #[test]
    fn missing_parent_is_reported_and_nothing_is_written() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("missing").join("note.md");

        let error = atomic_write(&target, b"data").unwrap_err();
        assert!(matches!(error, AtomicWriteError::MissingParent(_)));
        assert_eq!(error.code(), "SaveParentMissing");
        assert!(!target.exists());
    }

    #[cfg(windows)]
    mod windows_locking {
        use super::*;
        use std::os::windows::fs::OpenOptionsExt;
        use std::sync::mpsc;
        use std::time::Instant;

        const FILE_SHARE_NONE: u32 = 0;

        fn lock_exclusively(path: &Path) -> File {
            OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_NONE)
                .open(path)
                .expect("lock target")
        }

        #[test]
        fn persistent_sharing_violation_retries_three_times_and_keeps_old_content() {
            let dir = tempdir().unwrap();
            let target = dir.path().join("note.md");
            fs::write(&target, b"old").unwrap();
            let _lock = lock_exclusively(&target);

            let policy = RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 5,
                max_delay_ms: 10,
            };
            let started = Instant::now();
            let error = atomic_write_with_policy(&target, b"new", policy).unwrap_err();
            let elapsed = started.elapsed();

            match &error {
                AtomicWriteError::SharingViolation { attempts, .. } => {
                    assert_eq!(*attempts, 3, "must attempt at least three times");
                }
                other => panic!("expected sharing violation, got {other:?}"),
            }
            assert_eq!(error.code(), "SaveFileLocked");

            // Three attempts means two backoff sleeps: 5 ms + 10 ms.
            assert!(
                elapsed >= Duration::from_millis(15),
                "backoff was not applied: {elapsed:?}"
            );

            drop(_lock);
            assert_eq!(fs::read(&target).unwrap(), b"old");
            assert!(
                temp_files_in(dir.path()).is_empty(),
                "failed save must clean its temporary file"
            );
        }

        #[test]
        fn transient_sharing_violation_succeeds_after_backoff() {
            let dir = tempdir().unwrap();
            let target = dir.path().join("note.md");
            fs::write(&target, b"old").unwrap();

            let lock = lock_exclusively(&target);
            let (done_tx, done_rx) = mpsc::channel();
            let releaser = thread::spawn(move || {
                thread::sleep(Duration::from_millis(60));
                drop(lock);
                done_tx.send(()).unwrap();
            });

            let policy = RetryPolicy {
                max_attempts: 8,
                base_delay_ms: 20,
                max_delay_ms: 40,
            };
            let result = atomic_write_with_policy(&target, b"new contents", policy);

            done_rx.recv().unwrap();
            releaser.join().unwrap();
            result.expect("save should succeed once the lock is released");
            assert_eq!(fs::read(&target).unwrap(), b"new contents");
            assert!(temp_files_in(dir.path()).is_empty());
        }

        #[test]
        fn failed_save_leaves_target_readable_with_old_bytes() {
            let dir = tempdir().unwrap();
            let target = dir.path().join("note.md");
            fs::write(&target, b"old bytes").unwrap();
            let _lock = lock_exclusively(&target);

            let policy = RetryPolicy {
                max_attempts: 1,
                base_delay_ms: 1,
                max_delay_ms: 1,
            };
            assert!(atomic_write_with_policy(&target, b"new bytes", policy).is_err());

            // The save UI must keep the tab dirty and surface `code()`; the
            // file on disk is still the complete old revision.
            drop(_lock);
            let mut on_disk = Vec::new();
            File::open(&target)
                .unwrap()
                .read_to_end(&mut on_disk)
                .unwrap();
            assert_eq!(on_disk, b"old bytes");
        }
    }

    #[cfg(unix)]
    #[test]
    fn replaces_symlink_target_file_atomically() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("note.md");
        let link = dir.path().join("link.md");
        fs::write(&target, b"old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        atomic_write(&link, b"new").unwrap();

        // The link itself is replaced; the original target is untouched.
        assert_eq!(fs::read(&link).unwrap(), b"new");
        assert_eq!(fs::read(&target).unwrap(), b"old");
    }
}
