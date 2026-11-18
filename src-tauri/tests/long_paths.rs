//! Long path support (beyond the 260-character `MAX_PATH` limit).
//!
//! The editor must open and save documents whose absolute path exceeds the
//! classic Windows `MAX_PATH` boundary. Rust's `std::fs` converts absolute
//! paths to the verbatim (`\\?\`) form internally, so the guarantee holds as
//! long as nothing in the workspace gate truncates or rejects a long path.
//!
//! These tests build a workspace nested deep enough that the full document
//! path is past 260 characters, then drive the public read/write/list/
//! metadata boundary and assert the document round-trips. A separate test
//! proves a root supplied in verbatim form is accepted.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_lib::fs::list::list_dir_in_root;
use md_editor_lib::fs::metadata::metadata_in_root;
use md_editor_lib::fs::read::read_workspace_file;
use md_editor_lib::fs::write::write_workspace_file;
use md_editor_lib::workspace;
use tempfile::TempDir;

/// The historical Windows path limit this test must exceed.
const MAX_PATH: usize = 260;

/// Characters per generated directory name.
const SEGMENT_LENGTH: usize = 40;

/// How many nested directories to create (well past `MAX_PATH` with the
/// temp-directory prefix).
const DEPTH: usize = 8;

/// Builds a nested workspace-relative directory path longer than 260 chars on
/// its own, so the document path is comfortably past the limit.
fn deep_relative_dir() -> String {
    (0..DEPTH)
        .map(|index| {
            let prefix = format!("{index:02}-");
            format!("{prefix}{}", "a".repeat(SEGMENT_LENGTH - prefix.len()))
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Creates the temp workspace plus the nested directories and returns
/// `(tempdir, canonical root, workspace-relative directory)`.
fn deep_workspace() -> (TempDir, PathBuf, String) {
    let workspace = TempDir::new().expect("workspace");
    let root = fs::canonicalize(workspace.path()).expect("canonical root");
    let relative = deep_relative_dir();
    fs::create_dir_all(root.join(&relative)).expect("create nested directories");
    (workspace, root, relative)
}

/// Absolute bytes must be measured in the platform's own encoding; on Windows
/// `OsStr::len` counts the WTF-8 bytes, which is enough to prove the boundary.
fn absolute_len(path: &Path) -> usize {
    path.as_os_str().len()
}

#[test]
fn documents_beyond_max_path_are_written_read_and_listed() {
    let (_workspace, root, relative_dir) = deep_workspace();
    let relative = format!("{relative_dir}/kayit.md");

    let absolute = workspace::resolve_in_root(&root, &relative).expect("resolve long path");
    assert!(
        absolute_len(&absolute) > MAX_PATH,
        "fixture must exceed MAX_PATH, got {} ({})",
        absolute_len(&absolute),
        absolute.display()
    );

    write_workspace_file(&root, &relative, "# uzun yol\n").expect("write long path");
    assert_eq!(
        read_workspace_file(&root, &relative).expect("read long path"),
        "# uzun yol\n"
    );

    let metadata = metadata_in_root(&root, &relative).expect("metadata long path");
    assert!(metadata.is_file, "{}", metadata.relative_path);
    assert_eq!(metadata.relative_path, relative);
    assert_eq!(metadata.size, "# uzun yol\n".len() as u64);

    // The deepest directory must list the document with its full relative path.
    let entries = list_dir_in_root(&root, &relative_dir).expect("list long directory");
    assert_eq!(entries.len(), 1, "unexpected entries: {entries:?}");
    assert_eq!(entries[0].name, "kayit.md");
    assert_eq!(entries[0].relative_path, relative);
    assert!(!entries[0].is_dir);
}

#[test]
fn creating_a_new_document_beyond_max_path_works() {
    let (_workspace, root, relative_dir) = deep_workspace();
    let relative = format!("{relative_dir}/yeni.md");

    fs::write(
        root.join(&relative),
        "diskte var".as_bytes(),
    )
    .expect("seed long-path document");

    let contents = read_workspace_file(&root, &relative).expect("read seeded document");
    assert_eq!(contents, "diskte var");

    write_workspace_file(&root, &relative, "guncellendi")
        .expect("overwrite long-path document");
    assert_eq!(
        fs::read_to_string(root.join(&relative)).expect("read back"),
        "guncellendi"
    );
}

#[cfg(windows)]
#[test]
fn a_verbatim_root_is_accepted_for_long_paths() {
    let (_workspace, root, relative_dir) = deep_workspace();
    let relative = format!("{relative_dir}/verbatim.md");

    // `fs::canonicalize` already returns a verbatim (`\\?\`) path on Windows,
    // so strip any existing prefix before adding one; otherwise the fixture
    // would be the invalid doubled `\\?\\\?\C:\...` spelling.
    let canonical_root = root.display().to_string();
    let plain_root = canonical_root.strip_prefix(r"\\?\").unwrap_or(&canonical_root);
    let verbatim_root = PathBuf::from(format!(r"\\?\{plain_root}"));
    assert!(
        verbatim_root.as_os_str().to_string_lossy().starts_with(r"\\?\"),
        "fixture root must carry the verbatim prefix"
    );
    assert!(
        !verbatim_root.as_os_str().to_string_lossy().starts_with(r"\\?\\"),
        "fixture root must not carry a doubled verbatim prefix: {}",
        verbatim_root.display()
    );

    write_workspace_file(&verbatim_root, &relative, "verbatim kok")
        .expect("write through verbatim root");
    assert_eq!(
        read_workspace_file(&verbatim_root, &relative).expect("read through verbatim root"),
        "verbatim kok"
    );

    // Moving between the plain and the verbatim spelling of the same root must
    // address the same document.
    assert_eq!(
        read_workspace_file(&root, &relative).expect("read through plain root"),
        "verbatim kok"
    );

    let resolved = workspace::resolve_in_root(&verbatim_root, &relative)
        .expect("resolve through verbatim root");
    assert!(absolute_len(&resolved) > MAX_PATH);
}
