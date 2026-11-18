//! Atomic save guarantee.
//!
//! A save must either fully replace the target or leave it byte-for-byte
//! untouched, must never leave a sibling temporary file behind, and must
//! survive the transient Windows sharing violations an antivirus scanner or
//! the search indexer produces.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_lib::fs::atomic::TEMP_PREFIX;
use md_editor_lib::fs::{atomic_write, atomic_write_with_policy, AtomicWriteError, RetryPolicy};
use tempfile::TempDir;

fn temporary_files_in(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().starts_with(TEMP_PREFIX))
                .unwrap_or(false)
        })
        .collect()
}

#[test]
fn creates_a_new_file_without_leaving_a_temporary_file() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("note.md");

    atomic_write(&target, b"# merhaba\n").expect("atomic write");

    assert_eq!(fs::read(&target).expect("target exists"), b"# merhaba\n");
    assert!(
        temporary_files_in(dir.path()).is_empty(),
        "successful save must clean its staging file"
    );
}

#[test]
fn rename_replaces_the_existing_target_as_a_whole() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("note.md");
    let old = b"onceki surum cok daha uzun bir icerik tasiyor".to_vec();
    fs::write(&target, &old).expect("seed target");

    atomic_write(&target, b"yeni").expect("atomic write");

    assert_eq!(fs::read(&target).expect("target exists"), b"yeni");
    assert!(
        temporary_files_in(dir.path()).is_empty(),
        "rename-over must not leave a staging file"
    );

    // A second save over the freshly renamed file must work the same way: the
    // rename target being a file produced by us is not special-cased.
    atomic_write(&target, b"ucuncu").expect("second atomic write");
    assert_eq!(fs::read(&target).expect("target exists"), b"ucuncu");
    assert!(temporary_files_in(dir.path()).is_empty());
}

#[test]
fn missing_parent_is_reported_and_nothing_is_created() {
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("yok").join("note.md");

    let error = atomic_write(&target, b"data").expect_err("missing parent");
    assert!(matches!(error, AtomicWriteError::MissingParent(_)));
    assert_eq!(error.code(), "SaveParentMissing");
    assert!(!target.exists());
    assert!(temporary_files_in(dir.path()).is_empty());
}

#[test]
fn failed_replace_keeps_the_old_bytes_and_cleans_up() {
    let dir = TempDir::new().expect("temp dir");
    // A directory at the target location cannot be replaced by `rename` on any
    // supported platform, which exercises the failure path deterministically.
    let target = dir.path().join("dolu");
    fs::create_dir(&target).expect("directory target");

    let error = atomic_write(&target, b"data").expect_err("replace must fail");
    assert!(!matches!(error, AtomicWriteError::MissingParent(_)));
    assert!(
        target.is_dir(),
        "the original directory target must survive a failed save"
    );
    assert!(
        temporary_files_in(dir.path()).is_empty(),
        "a failed save must not leave its staging file"
    );
}

#[cfg(windows)]
mod windows_sharing_violation {
    use super::*;
    use std::fs::File;
    use std::os::windows::fs::OpenOptionsExt;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    /// Exclusive lock: no other handle may open the file, which makes the
    /// rename fail with `ERROR_SHARING_VIOLATION` (32).
    const FILE_SHARE_NONE: u32 = 0;

    fn lock_exclusively(path: &Path) -> File {
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_NONE)
            .open(path)
            .expect("lock target")
    }

    #[test]
    fn persistent_lock_is_retried_then_reported_as_save_file_locked() {
        let dir = TempDir::new().expect("temp dir");
        let target = dir.path().join("note.md");
        fs::write(&target, b"eski").expect("seed target");
        let lock = lock_exclusively(&target);

        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 5,
            max_delay_ms: 10,
        };
        let started = Instant::now();
        let error = atomic_write_with_policy(&target, b"yeni", policy).expect_err("still locked");
        let elapsed = started.elapsed();

        match &error {
            AtomicWriteError::SharingViolation { attempts, .. } => {
                assert_eq!(*attempts, 3, "the bounded policy must be exhausted");
            }
            other => panic!("expected a sharing violation, got {other:?}"),
        }
        assert_eq!(error.code(), "SaveFileLocked");
        // Two backoff sleeps of 5 ms and 10 ms must have happened.
        assert!(
            elapsed >= Duration::from_millis(15),
            "backoff was not applied: {elapsed:?}"
        );

        drop(lock);
        assert_eq!(fs::read(&target).expect("target intact"), b"eski");
        assert!(
            temporary_files_in(dir.path()).is_empty(),
            "a retried-then-failed save must not leave a staging file"
        );
    }

    #[test]
    fn a_lock_released_during_the_backoff_lets_the_save_succeed() {
        let dir = TempDir::new().expect("temp dir");
        let target = dir.path().join("note.md");
        fs::write(&target, b"eski").expect("seed target");

        let lock = lock_exclusively(&target);
        let (released_tx, released_rx) = mpsc::channel();
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            drop(lock);
            released_tx.send(()).expect("signal release");
        });

        let policy = RetryPolicy {
            max_attempts: 8,
            base_delay_ms: 20,
            max_delay_ms: 40,
        };
        let result = atomic_write_with_policy(&target, b"yeni icerik", policy);

        released_rx.recv().expect("release signal");
        releaser.join().expect("releaser thread");

        result.expect("save must succeed once the lock is gone");
        assert_eq!(fs::read(&target).expect("target exists"), b"yeni icerik");
        assert!(temporary_files_in(dir.path()).is_empty());
    }
}

#[test]
fn retry_policy_is_bounded() {
    // A policy with zero attempts and huge delays must be normalised so a save
    // can neither loop forever nor sleep for minutes.
    let dir = TempDir::new().expect("temp dir");
    let target = dir.path().join("note.md");
    fs::write(&target, b"eski").expect("seed target");

    let policy = RetryPolicy {
        max_attempts: 0,
        base_delay_ms: 60_000,
        max_delay_ms: 1,
    };
    // The target is writable here, so the single bounded attempt must succeed.
    atomic_write_with_policy(&target, b"yeni", policy).expect("one attempt is enough");
    assert_eq!(fs::read(&target).expect("target exists"), b"yeni");
}
