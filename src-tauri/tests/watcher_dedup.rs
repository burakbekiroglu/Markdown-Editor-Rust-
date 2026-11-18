//! Watcher batching rules that are observable from outside the crate: the
//! debounce window, the two-second self-write dedup window, and the path
//! confinement applied to every raw event.
//!
//! The folding rule itself (`FsChangeKind::merge`, create+modify -> create,
//! remove+create -> modify) is private and covered by the in-module unit tests
//! `merges_repeated_paths_inside_one_window` and
//! `a_file_recreated_inside_the_window_is_a_modify_not_a_remove`.

use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use md_editor_lib::watcher::{
    content_hash, relative_within, SelfWriteRegistry, DEBOUNCE, SELF_WRITE_CAPACITY, SELF_WRITE_TTL,
};
use tempfile::TempDir;

fn root_of(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical root")
}

#[test]
fn the_published_windows_are_pinned() {
    assert_eq!(DEBOUNCE, Duration::from_millis(150));
    assert_eq!(SELF_WRITE_TTL, Duration::from_secs(2));
}

#[test]
fn a_fresh_self_write_matches_its_own_path_and_hash() {
    let registry = SelfWriteRegistry::new();
    let payload = b"# kaydedildi\n";
    registry.record("notes/a.md", payload);

    assert!(registry.matches("notes/a.md", content_hash(payload)));
    // Path separators are normalised, so a Windows path form still matches.
    assert!(registry.matches("notes\\a.md", content_hash(payload)));
    // Different content or a different path is not our own echo.
    assert!(!registry.matches("notes/a.md", content_hash(b"baska icerik")));
    assert!(!registry.matches("notes/b.md", content_hash(payload)));
}

#[test]
fn a_self_write_record_expires_after_the_two_second_window() {
    let registry = SelfWriteRegistry::new();
    let payload = b"# kaydedildi\n";
    let hash = content_hash(payload);
    registry.record("a.md", payload);

    assert!(registry.matches("a.md", hash), "immediately after the save");
    thread::sleep(Duration::from_millis(1_500));
    assert!(registry.matches("a.md", hash), "still inside the window");

    thread::sleep(Duration::from_millis(700));
    assert!(
        !registry.matches("a.md", hash),
        "a write older than two seconds must not suppress a genuine change"
    );
}

#[test]
fn the_self_write_queue_is_bounded() {
    let registry = SelfWriteRegistry::new();
    let payload = b"ayni icerik";
    let hash = content_hash(payload);

    for index in 0..(SELF_WRITE_CAPACITY + 5) {
        registry.record(&format!("f{index}.md"), payload);
    }

    let last = SELF_WRITE_CAPACITY + 4;
    assert!(
        registry.matches(&format!("f{last}.md"), hash),
        "the newest record must be kept"
    );
    assert!(
        !registry.matches("f0.md", hash),
        "the oldest record must have been evicted"
    );
}

#[test]
fn an_empty_path_is_never_recorded() {
    let registry = SelfWriteRegistry::new();
    registry.record("", b"x");
    registry.record("/", b"x");

    assert!(!registry.matches("", content_hash(b"x")));
}

#[test]
fn raw_events_are_confined_to_the_workspace_root() {
    let inside = TempDir::new().expect("workspace");
    let outside = TempDir::new().expect("outside");
    let root = root_of(&inside);
    fs::create_dir_all(root.join("notes")).expect("subfolder");
    fs::write(root.join("notes/a.md"), "x").expect("fixture");

    assert_eq!(
        relative_within(&root, &root.join("notes/a.md")).as_deref(),
        Some("notes/a.md")
    );
    // The root itself is not a document path.
    assert_eq!(relative_within(&root, &root), None);
    // Outside the root, and any climbing component, are dropped.
    assert_eq!(relative_within(&root, &outside.path().join("x.md")), None);
    assert_eq!(relative_within(&root, &root.join("..").join("x.md")), None);
}

#[test]
fn a_file_that_appears_externally_is_still_hashable_for_dedup() {
    let dir = TempDir::new().expect("workspace");
    let root = root_of(&dir);
    let file = root.join("dis.md");
    fs::write(&file, "disaridan").expect("fixture");

    let hash = content_hash(b"disaridan");
    let registry = SelfWriteRegistry::new();
    registry.record("baska.md", b"disaridan");

    // The same bytes at a different path must not be treated as our echo.
    assert!(!registry.matches("dis.md", hash));
    assert_eq!(fs::read(&file).expect("file intact"), b"disaridan");
}
