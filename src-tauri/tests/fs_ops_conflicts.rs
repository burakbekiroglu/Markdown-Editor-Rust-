//! Rename, move and delete collision rules from the tree context menu.
//!
//! The backend is the authority: an existing entry is never overwritten, a
//! folder never moves inside itself, and deletion goes through the Recycle Bin
//! for the resolved entry only.

use std::fs;
use std::path::PathBuf;

use md_editor_lib::error::AppErrorCode;
use md_editor_lib::fs_ops::{
    create_file_at, create_folder_at, delete_entry_at, move_entry_at, rename_entry_at,
    ENTRY_EXISTS, INVALID_TARGET, NOT_FOUND,
};
use tempfile::TempDir;

use md_editor_lib::workspace::PATH_OUTSIDE_WORKSPACE;

fn root_of(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical root")
}

#[test]
fn rename_onto_an_existing_sibling_is_refused_and_both_files_survive() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::write(root.join("a.md"), "A").expect("fixture a");
    fs::write(root.join("b.md"), "B").expect("fixture b");

    let error = rename_entry_at(&root, "a.md", "b.md").expect_err("collision");
    assert_eq!(error.code, ENTRY_EXISTS);
    assert_eq!(
        fs::read_to_string(root.join("a.md")).expect("a intact"),
        "A"
    );
    assert_eq!(
        fs::read_to_string(root.join("b.md")).expect("b intact"),
        "B"
    );
}

#[test]
fn rename_of_the_same_entry_to_a_different_case_is_allowed() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::write(root.join("not.md"), "icerik").expect("fixture");

    let renamed = rename_entry_at(&root, "not.md", "NOT.md").expect("case-only rename");

    assert_eq!(renamed.name, "NOT.md");
    assert_eq!(
        fs::read_to_string(root.join("NOT.md")).expect("renamed file"),
        "icerik"
    );
}

#[test]
fn rename_reports_a_missing_entry_and_an_invalid_name() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::write(root.join("a.md"), "A").expect("fixture");

    assert_eq!(
        rename_entry_at(&root, "yok.md", "yeni")
            .expect_err("missing")
            .code,
        NOT_FOUND
    );
    assert_eq!(
        rename_entry_at(&root, "a.md", "kotu|ad")
            .expect_err("invalid")
            .code,
        md_editor_lib::fs_ops::INVALID_NAME
    );
}

#[test]
fn move_onto_an_existing_name_is_refused_and_both_entries_survive() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::create_dir(root.join("arsiv")).expect("folder");
    fs::write(root.join("not.md"), "kaynak").expect("source");
    fs::write(root.join("arsiv/not.md"), "hedef").expect("target");

    let error = move_entry_at(&root, "not.md", "arsiv").expect_err("collision");
    assert_eq!(error.code, ENTRY_EXISTS);
    assert_eq!(
        fs::read_to_string(root.join("not.md")).expect("source intact"),
        "kaynak"
    );
    assert_eq!(
        fs::read_to_string(root.join("arsiv/not.md")).expect("target intact"),
        "hedef"
    );
}

#[test]
fn move_of_a_folder_into_its_own_subtree_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::create_dir(root.join("ust")).expect("folder");
    fs::create_dir(root.join("ust/alt")).expect("subfolder");

    let error = move_entry_at(&root, "ust", "ust/alt").expect_err("descendant move");
    assert_eq!(error.code, INVALID_TARGET);
    assert!(
        root.join("ust/alt").is_dir(),
        "the subtree must stay intact"
    );
}

#[test]
fn move_within_the_same_folder_is_a_noop() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::create_dir(root.join("arsiv")).expect("folder");
    fs::write(root.join("arsiv/not.md"), "icerik").expect("fixture");

    let moved = move_entry_at(&root, "arsiv/not.md", "arsiv").expect("noop");
    assert_eq!(moved.relative_path, "arsiv/not.md");
    assert_eq!(
        fs::read_to_string(root.join("arsiv/not.md")).expect("file intact"),
        "icerik"
    );
}

#[test]
fn move_of_a_folder_onto_an_existing_folder_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::create_dir(root.join("arsiv")).expect("folder");
    fs::create_dir(root.join("ust")).expect("source folder");
    fs::create_dir(root.join("arsiv/ust")).expect("target folder");
    fs::write(root.join("ust/ic.md"), "kaynak").expect("source content");
    fs::write(root.join("arsiv/ust/hedef.md"), "hedef").expect("target content");

    let error = move_entry_at(&root, "ust", "arsiv").expect_err("collision");
    assert_eq!(error.code, ENTRY_EXISTS);
    assert_eq!(
        fs::read_to_string(root.join("ust/ic.md")).expect("source intact"),
        "kaynak"
    );
    assert_eq!(
        fs::read_to_string(root.join("arsiv/ust/hedef.md")).expect("target intact"),
        "hedef"
    );
}

#[test]
fn create_never_overwrites_an_existing_file_or_folder() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::write(root.join("notlar.md"), "korunacak").expect("fixture");

    let error = create_file_at(&root, "", "notlar").expect_err("collision");
    assert_eq!(error.code, ENTRY_EXISTS);
    assert_eq!(
        fs::read_to_string(root.join("notlar.md")).expect("file intact"),
        "korunacak"
    );

    create_folder_at(&root, "", "arsiv").expect("folder created");
    assert_eq!(
        create_folder_at(&root, "", "arsiv")
            .expect_err("collision")
            .code,
        ENTRY_EXISTS
    );
}

#[test]
fn delete_sends_only_the_resolved_entry_to_the_recycle_bin() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::create_dir(root.join("arsiv")).expect("folder");
    fs::write(root.join("arsiv/sil.md"), "silinecek").expect("target");
    fs::write(root.join("arsiv/kal.md"), "kalacak").expect("sibling");
    fs::write(root.join("kok.md"), "kokte kalacak").expect("root sibling");

    delete_entry_at(&root, "arsiv/sil.md").expect("delete");

    assert!(
        !root.join("arsiv/sil.md").exists(),
        "the resolved entry must be gone"
    );
    assert_eq!(
        fs::read_to_string(root.join("arsiv/kal.md")).expect("sibling intact"),
        "kalacak"
    );
    assert_eq!(
        fs::read_to_string(root.join("kok.md")).expect("root sibling intact"),
        "kokte kalacak"
    );
    assert!(
        root.join("arsiv").is_dir(),
        "the parent folder must survive"
    );
}

#[test]
fn delete_refuses_traversal_and_the_workspace_root() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let outside_dir = TempDir::new().expect("outside");
    let outside = outside_dir.path().join("gizli.md");
    fs::write(&outside, "korunacak").expect("outside fixture");

    let error = delete_entry_at(&root, "../gizli.md").expect_err("traversal");
    assert_eq!(error.code, PATH_OUTSIDE_WORKSPACE);
    assert_eq!(
        fs::read_to_string(&outside).expect("outside intact"),
        "korunacak"
    );

    let error = delete_entry_at(&root, "").expect_err("root is protected");
    assert_eq!(error.code, md_editor_lib::fs_ops::INVALID_NAME);
    assert!(root.is_dir());
}

#[test]
fn delete_maps_a_missing_entry_to_not_found() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);

    let error = delete_entry_at(&root, "yok.md").expect_err("missing");
    assert_eq!(error.code, NOT_FOUND);
}

#[test]
fn tree_operation_errors_map_onto_the_shared_app_error_codes() {
    // The frontend switches on one enum, so the internal codes must translate.
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    fs::write(root.join("a.md"), "A").expect("fixture");
    fs::write(root.join("b.md"), "B").expect("fixture");

    let error = rename_entry_at(&root, "a.md", "b.md").expect_err("collision");
    let mapped = md_editor_lib::error::AppError::from(error);
    assert_eq!(mapped.code(), AppErrorCode::ConflictDetected);
}
