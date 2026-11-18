//! Workspace confinement at the public boundary.
//!
//! Every filesystem entry point takes a workspace-relative request string and
//! must resolve it inside the open root. These tests drive the public API
//! (`resolve_in_root`, the read/write commands and the tree operations) with
//! `..`, absolute, UNC and link-redirected requests, and assert that nothing
//! outside the root is ever read, written or listed.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_lib::error::AppErrorCode;
use md_editor_lib::fs::read::read_workspace_file;
use md_editor_lib::fs::write::write_workspace_file;
use md_editor_lib::fs_ops::create_file_at;
use md_editor_lib::workspace::{self, INVALID_PATH, PATH_OUTSIDE_WORKSPACE};
use tempfile::TempDir;

fn canonical(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical workspace root")
}

/// Create a directory link (`symlink` on Unix, NTFS junction on Windows).
#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).expect("create symlink");
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run mklink");
    assert!(status.success(), "junction fixture could not be created");
}

#[test]
fn rejects_parent_directory_traversal_on_every_entry_point() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let outside_dir = TempDir::new().expect("outside");
    let outside = outside_dir.path().join("gizli.md");
    fs::write(&outside, "korunacak").expect("outside fixture");

    for requested in ["../gizli.md", "notes/../../gizli.md", "./../gizli.md", ".."] {
        let error =
            workspace::resolve_in_root(&root, requested).expect_err("\"..\" must never resolve");
        assert_eq!(error.code, PATH_OUTSIDE_WORKSPACE, "{requested}");
    }

    let write_error =
        write_workspace_file(&root, "../gizli.md", "yazilmamali").expect_err("escape");
    assert_eq!(write_error.code(), AppErrorCode::PathEscape);
    let read_error = read_workspace_file(&root, "../gizli.md").expect_err("escape");
    assert_eq!(read_error.code(), AppErrorCode::PathEscape);
    let create_error = create_file_at(&root, "../", "yeni").expect_err("escape");
    assert_eq!(create_error.code, PATH_OUTSIDE_WORKSPACE);

    // The traversal attempts must not have touched the outside file.
    assert_eq!(
        fs::read_to_string(&outside).expect("outside intact"),
        "korunacak"
    );
    assert!(!outside_dir.path().join("yeni.md").exists());
}

#[test]
fn rejects_absolute_and_unc_requests() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);

    #[cfg(windows)]
    let absolute = ["C:\\Windows\\win.ini", "\\\\server\\share\\note.md"];
    #[cfg(not(windows))]
    let absolute = ["/etc/passwd", "//server/share/note.md"];

    for requested in absolute {
        let error = workspace::resolve_in_root(&root, requested)
            .expect_err("absolute request must be refused");
        assert_eq!(error.code, PATH_OUTSIDE_WORKSPACE, "{requested}");
    }
}

#[test]
fn rejects_requests_with_a_nul_byte() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);

    let error = workspace::resolve_in_root(&root, "notlar\0.md").expect_err("NUL refused");
    assert_eq!(error.code, workspace::INVALID_PATH);
}

#[test]
fn link_that_escapes_the_root_is_never_resolved_listed_or_written_through() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let outside_dir = TempDir::new().expect("outside");
    fs::write(outside_dir.path().join("gizli.md"), "disarida").expect("outside fixture");

    let link = root.join("kacis");
    link_dir(outside_dir.path(), &link);

    let error = workspace::resolve_in_root(&root, "kacis/gizli.md")
        .expect_err("link escape must be refused");
    assert_eq!(error.code, PATH_OUTSIDE_WORKSPACE);

    let read_error =
        read_workspace_file(&root, "kacis/gizli.md").expect_err("link escape must be refused");
    assert_eq!(read_error.code(), AppErrorCode::PathEscape);

    // A write through the escaping link must not reach the outside folder.
    let write_error = write_workspace_file(&root, "kacis/yeni.md", "disariya yazilmamali")
        .expect_err("link escape must be refused");
    assert_eq!(write_error.code(), AppErrorCode::PathEscape);
    assert!(!outside_dir.path().join("yeni.md").exists());

    let entries = workspace::list_in_root(&root, "").expect("list root");
    assert!(
        entries.iter().all(|entry| entry.name != "kacis"),
        "an escaping link must not be listed"
    );
    assert_eq!(
        fs::read_to_string(outside_dir.path().join("gizli.md")).expect("outside intact"),
        "disarida"
    );
}

/// Saldırı seti: her girişim çözümleme katmanında ve IPC sınırında tipli bir
/// hata kodu üretmeli; hiçbiri sessizce normalleştirilmemeli.
///
/// Kod eşlemesi `AppErrorCode::from_legacy` üzerinden doğrulanır: frontend'in
/// gördüğü ayırt edici değer budur.
#[test]
fn every_traversal_unc_and_device_attack_returns_a_typed_error() {
    use md_editor_lib::error::AppErrorCode;

    #[cfg(windows)]
    let attacks: &[(&str, &str, AppErrorCode)] = &[
        ("..", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("../gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("notes/../../gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"notes\..\..\gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"..\..\Windows\win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"C:\Windows\win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("C:/Windows/win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("C:notes", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"\\server\share\gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"\\?\C:\Windows\win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"\\.\C:\Windows\win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"\\?\UNC\server\share\gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        (r"\Windows\win.ini", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("/etc/passwd", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("notlar\0.md", INVALID_PATH, AppErrorCode::InvalidPath),
    ];
    #[cfg(not(windows))]
    let attacks: &[(&str, &str, AppErrorCode)] = &[
        ("..", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("../gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("notes/../../gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("/etc/passwd", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("//server/share/gizli.md", PATH_OUTSIDE_WORKSPACE, AppErrorCode::PathEscape),
        ("notlar\0.md", INVALID_PATH, AppErrorCode::InvalidPath),
    ];

    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    let outside_dir = TempDir::new().expect("outside");
    let outside = outside_dir.path().join("gizli.md");
    fs::write(&outside, "korunacak").expect("outside fixture");

    for (requested, workspace_code, app_code) in attacks {
        let resolve_error = workspace::resolve_in_root(&root, requested)
            .expect_err("attack must never resolve");
        assert_eq!(resolve_error.code, *workspace_code, "{requested}");
        assert_eq!(
            AppErrorCode::from_legacy(resolve_error.code),
            Some(*app_code),
            "{requested} tipli koda eşlenmeli"
        );

        let read_error = read_workspace_file(&root, requested).expect_err("read must be refused");
        assert_eq!(read_error.code(), *app_code, "read: {requested}");

        let write_error =
            write_workspace_file(&root, requested, "yazilmamali").expect_err("write must be refused");
        assert_eq!(write_error.code(), *app_code, "write: {requested}");

        // IPC sınırındaki biçim `{ code, message }` olmalı; `code` kararlı,
        // PascalCase ayırt edicidir.
        let serialized = serde_json::to_value(&read_error).expect("serialize error");
        assert_eq!(
            serialized["code"],
            serde_json::Value::String(app_code.as_str().to_string()),
            "{requested}"
        );
        assert!(serialized["message"].is_string(), "{requested}");
    }

    // Hiçbir deneme kök dışındaki dosyayı değiştirmedi.
    assert_eq!(
        fs::read_to_string(&outside).expect("outside intact"),
        "korunacak"
    );
}

#[test]
fn link_that_stays_inside_the_root_is_allowed() {
    let workspace = TempDir::new().expect("workspace");
    let root = canonical(&workspace);
    fs::create_dir(root.join("notlar")).expect("target dir");
    fs::write(root.join("notlar/a.md"), "icerde").expect("inside fixture");

    link_dir(&root.join("notlar"), &root.join("takma"));

    let resolved = workspace::resolve_in_root(&root, "takma/a.md").expect("inside link allowed");
    assert_eq!(
        resolved,
        fs::canonicalize(root.join("notlar"))
            .expect("canonical target")
            .join("a.md")
    );
    assert_eq!(
        read_workspace_file(&root, "takma/a.md").expect("read through inside link"),
        "icerde"
    );
}
