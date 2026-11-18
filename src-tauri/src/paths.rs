//! Workspace path confinement.
//!
//! [`resolve_in_root`] turns a workspace-relative request into an absolute path
//! that is proven to live inside the canonical workspace root. It is the single
//! gate every filesystem command must pass through.
//!
//! The defences, in order:
//!
//! * `..`, absolute paths, drive-relative paths (`C:notes`) and UNC shares
//!   (`\\server\share`) are rejected before the filesystem is touched.
//! * The root is canonicalised with [`dunce::canonicalize`], which resolves
//!   junctions/symlinks and strips the Windows verbatim (`\\?\`) prefix.
//! * Every existing component is inspected with `symlink_metadata`; a symlink
//!   or NTFS reparse point (junction) is resolved and must stay inside the
//!   root, including when its target is dangling.
//! * Containment is compared component by component and, on Windows, case
//!   insensitively (ASCII folding), so `C:\Work` and `c:\work\notes` agree
//!   while the sibling `C:\Workshop` does not.
//!
//! Components that do not exist yet are appended to the deepest verified
//! ancestor, which supports creating new files/folders without allowing an
//! escape through the missing part.
//!
//! The check is a best-effort snapshot: the filesystem can change between this
//! validation and the subsequent open/write, so callers should prefer
//! `create_new`/rename semantics that fail closed on a swapped target.
//!
//! This module depends on `std` and `dunce` only, so the rules are unit-tested
//! without a Tauri runtime.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::workspace::{
    WorkspaceError, INVALID_PATH, IO_ERROR, PATH_OUTSIDE_WORKSPACE, WORKSPACE_NOT_OPEN,
};

/// A symlink or junction in the requested path resolves outside the root (or
/// cannot be resolved, e.g. dangling). Mapped to
/// [`crate::error::AppErrorCode::SymlinkEscape`].
pub const SYMLINK_ESCAPE: &str = "SYMLINK_ESCAPE";

/// Resolve `requested` (workspace-relative) to an absolute path inside `root`.
///
/// `root` is canonicalised first, so callers may pass a folder opened through a
/// junction or a path carrying the Windows `\\?\` prefix. An empty request or
/// `"."` resolves to the root itself.
///
/// Failure codes:
///
/// * [`PATH_OUTSIDE_WORKSPACE`] - `..`, an absolute path, a drive prefix or a
///   UNC share was supplied;
/// * [`SYMLINK_ESCAPE`] - a symlink/junction component points outside the root
///   or is dangling;
/// * [`INVALID_PATH`] - the request contains a NUL byte;
/// * [`WORKSPACE_NOT_OPEN`] - the root itself cannot be canonicalised;
/// * [`IO_ERROR`] - the filesystem refused an inspection.
pub fn resolve_in_root(root: &Path, requested: &str) -> Result<PathBuf, WorkspaceError> {
    let root = canonicalize_root(root)?;
    let relative = normalize_relative(requested)?;
    if relative.as_os_str().is_empty() {
        return Ok(root);
    }

    let mut resolved = root.clone();
    let mut missing: Vec<OsString> = Vec::new();

    for component in relative.components() {
        let Component::Normal(part) = component else {
            // `normalize_relative` only yields normal components.
            return Err(outside(requested));
        };
        if !missing.is_empty() {
            missing.push(part.to_os_string());
            continue;
        }

        let probe = resolved.join(part);
        match fs::symlink_metadata(&probe) {
            Ok(metadata) => {
                if is_reparse_point(&metadata) {
                    // Resolve the link before deciding; an unresolvable
                    // (dangling) link can never be proven confined.
                    let target =
                        dunce::canonicalize(&probe).map_err(|_| symlink_escape(requested))?;
                    if !path_is_within(&root, &target) {
                        return Err(symlink_escape(requested));
                    }
                    resolved = target;
                } else {
                    resolved = probe;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // Not-yet-created tail; appended after the ancestor check.
                missing.push(part.to_os_string());
            }
            Err(error) => {
                return Err(WorkspaceError::new(
                    IO_ERROR,
                    format!("cannot inspect {requested}: {error}"),
                ));
            }
        }
    }

    // Re-canonicalise the deepest existing ancestor so the returned path is
    // normalised (no `.`/links left) before the final containment check.
    let mut confined = dunce::canonicalize(&resolved).map_err(|error| {
        WorkspaceError::new(IO_ERROR, format!("cannot resolve {requested}: {error}"))
    })?;
    if !path_is_within(&root, &confined) {
        return Err(outside(requested));
    }
    for part in missing {
        confined.push(part);
    }
    Ok(confined)
}

/// True when `candidate` is `root` or a descendant of it.
///
/// Comparison is component-wise (so `/work` does not contain `/workshop`) and,
/// on Windows, ASCII case-insensitive to match NTFS lookup semantics for normal
/// names.
pub fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let mut expected = root.components();
    let mut actual = candidate.components();
    loop {
        match expected.next() {
            None => return true,
            Some(component) => match actual.next() {
                Some(part) if components_equal(component.as_os_str(), part.as_os_str()) => {}
                _ => return false,
            },
        }
    }
}

/// Canonicalise a folder and require it to be an existing directory.
///
/// The result never carries the Windows `\\?\` prefix when `dunce` can strip
/// it.
fn canonicalize_root(root: &Path) -> Result<PathBuf, WorkspaceError> {
    if root.as_os_str().is_empty() {
        return Err(WorkspaceError::new(
            WORKSPACE_NOT_OPEN,
            "no workspace root is configured",
        ));
    }
    let canonical = dunce::canonicalize(root).map_err(|error| {
        WorkspaceError::new(
            WORKSPACE_NOT_OPEN,
            format!(
                "workspace root is not reachable: {}: {error}",
                root.display()
            ),
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        WorkspaceError::new(
            WORKSPACE_NOT_OPEN,
            format!(
                "cannot inspect workspace root {}: {error}",
                canonical.display()
            ),
        )
    })?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::new(
            INVALID_PATH,
            format!("workspace root is not a directory: {}", canonical.display()),
        ));
    }
    Ok(canonical)
}

/// Parse a workspace-relative request into plain, forward-only components.
fn normalize_relative(requested: &str) -> Result<PathBuf, WorkspaceError> {
    if requested.contains('\0') {
        return Err(WorkspaceError::new(
            INVALID_PATH,
            "path contains a NUL byte",
        ));
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            // Traversal, absolute targets, drive prefixes and UNC shares are
            // escape attempts, never silently normalised away.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(outside(requested));
            }
        }
    }
    Ok(normalized)
}

/// True for a symlink or any NTFS reparse point (junction/mount point).
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT covers symlinks and junctions;
        // `FileType::is_symlink` alone would miss junctions.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn components_equal(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // Compare UTF-16 code units so unpaired surrogates stay distinct while
        // ASCII letters fold case like NTFS does for ordinary names.
        let left: Vec<u16> = left.encode_wide().collect();
        let right: Vec<u16> = right.encode_wide().collect();
        left.len() == right.len()
            && left
                .iter()
                .zip(right.iter())
                .all(|(a, b)| fold_ascii(*a) == fold_ascii(*b))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(windows)]
fn fold_ascii(unit: u16) -> u16 {
    if unit < 0x80 {
        u16::from((unit as u8).to_ascii_lowercase())
    } else {
        unit
    }
}

fn outside(requested: &str) -> WorkspaceError {
    WorkspaceError::new(
        PATH_OUTSIDE_WORKSPACE,
        format!("path resolves outside the workspace root: {requested}"),
    )
}

fn symlink_escape(requested: &str) -> WorkspaceError {
    WorkspaceError::new(
        SYMLINK_ESCAPE,
        format!("link resolves outside the workspace root: {requested}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Stdio;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, PathBuf) {
        let temp = TempDir::new().expect("temp dir");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("notes").join("drafts")).expect("create workspace");
        fs::write(root.join("notes").join("a.md"), "# a").expect("write file");
        fs::create_dir_all(temp.path().join("outside")).expect("create outside");
        fs::write(temp.path().join("outside").join("secret.md"), "secret").expect("write secret");
        let canonical = dunce::canonicalize(&root).expect("canonical root");
        (temp, canonical)
    }

    /// Create a directory link: an NTFS junction on Windows, a symlink
    /// elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("run mklink");
            assert!(status.success(), "junction fixture could not be created");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).expect("symlink fixture");
        }
    }

    fn code(result: Result<PathBuf, WorkspaceError>) -> &'static str {
        result.expect_err("expected a rejection").code
    }

    #[test]
    fn resolves_existing_files_and_the_root() {
        let (_temp, root) = fixture();

        let file = resolve_in_root(&root, "notes/a.md").expect("existing file");
        assert_eq!(file, dunce::canonicalize(root.join("notes/a.md")).unwrap());
        assert!(!file.to_string_lossy().starts_with(r"\\?"));

        assert_eq!(resolve_in_root(&root, "").unwrap(), root);
        assert_eq!(resolve_in_root(&root, ".").unwrap(), root);
        assert_eq!(resolve_in_root(&root, "notes/./a.md").unwrap(), file);
    }

    #[test]
    fn resolves_not_yet_created_paths_under_their_ancestor() {
        let (_temp, root) = fixture();

        let missing = resolve_in_root(&root, "notes/drafts/yeni.md").expect("new file");
        assert_eq!(missing, root.join("notes").join("drafts").join("yeni.md"));
        assert!(path_is_within(&root, &missing));
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_temp, root) = fixture();

        for requested in [
            "..",
            "../outside/secret.md",
            "notes/../..",
            "notes/../../outside/secret.md",
            "notes/../notes/../../outside",
        ] {
            assert_eq!(
                code(resolve_in_root(&root, requested)),
                PATH_OUTSIDE_WORKSPACE,
                "{requested}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_absolute_drive_and_unc_paths() {
        let (_temp, root) = fixture();

        for requested in [
            r"C:\Windows\win.ini",
            "C:/Windows/win.ini",
            "C:notes",
            r"\\server\share\secret.md",
            r"\\?\C:\Windows\win.ini",
            r"\Windows\win.ini",
            "/etc/passwd",
        ] {
            assert_eq!(
                code(resolve_in_root(&root, requested)),
                PATH_OUTSIDE_WORKSPACE,
                "{requested}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_device_and_verbatim_namespace_paths() {
        let (_temp, root) = fixture();

        for requested in [
            r"\\.\C:\Windows\win.ini",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\Windows\win.ini",
            r"\\?\UNC\server\share\secret.md",
        ] {
            assert_eq!(
                code(resolve_in_root(&root, requested)),
                PATH_OUTSIDE_WORKSPACE,
                "{requested}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn rejects_absolute_paths() {
        let (_temp, root) = fixture();

        for requested in ["/etc/passwd", "/tmp/../etc/passwd"] {
            assert_eq!(
                code(resolve_in_root(&root, requested)),
                PATH_OUTSIDE_WORKSPACE,
                "{requested}"
            );
        }
    }

    #[test]
    fn rejects_nul_bytes() {
        let (_temp, root) = fixture();
        assert_eq!(code(resolve_in_root(&root, "notes/a\0.md")), INVALID_PATH);
    }

    #[test]
    fn reports_an_unreachable_root() {
        let temp = TempDir::new().unwrap();
        let missing_root = temp.path().join("yok");
        assert_eq!(
            code(resolve_in_root(&missing_root, "a.md")),
            WORKSPACE_NOT_OPEN
        );
    }

    #[test]
    fn rejects_an_empty_root() {
        assert_eq!(
            code(resolve_in_root(Path::new(""), "a.md")),
            WORKSPACE_NOT_OPEN
        );
    }

    #[test]
    fn rejects_a_root_that_is_a_file() {
        let temp = TempDir::new().unwrap();
        let file_root = temp.path().join("kok.md");
        fs::write(&file_root, "# kök").expect("write root file");

        assert_eq!(code(resolve_in_root(&file_root, "a.md")), INVALID_PATH);
    }

    #[test]
    fn collapses_repeated_and_trailing_separators() {
        let (_temp, root) = fixture();

        assert_eq!(
            resolve_in_root(&root, "notes//drafts/").unwrap(),
            root.join("notes").join("drafts")
        );
        assert_eq!(
            resolve_in_root(&root, "./notes///a.md").unwrap(),
            dunce::canonicalize(root.join("notes/a.md")).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolves_requests_whose_case_differs_from_the_disk() {
        let (_temp, root) = fixture();
        let expected = dunce::canonicalize(root.join("notes/a.md")).expect("canonical file");

        // NTFS lookup is case-insensitive; the returned path must still be the
        // canonical on-disk spelling, so containment compares equal.
        let resolved = resolve_in_root(&root, "NOTES/A.MD").expect("case-folded request");
        assert_eq!(resolved, expected);
        assert!(path_is_within(&root, &resolved));
    }

    #[test]
    fn path_is_within_respects_component_boundaries() {
        let root = Path::new("/work");
        assert!(path_is_within(root, Path::new("/work")));
        assert!(path_is_within(root, Path::new("/work/notes/a.md")));
        assert!(!path_is_within(root, Path::new("/workevil")));
        assert!(!path_is_within(root, Path::new("/work-evil/a.md")));
        assert!(!path_is_within(root, Path::new("/")));
    }

    #[cfg(windows)]
    #[test]
    fn path_is_within_is_case_insensitive_on_windows() {
        assert!(path_is_within(
            Path::new(r"C:\Work"),
            Path::new(r"c:\work\notes")
        ));
        assert!(path_is_within(Path::new(r"C:\Work"), Path::new(r"C:\WORK")));
        assert!(!path_is_within(
            Path::new(r"C:\Work"),
            Path::new(r"C:\Workshop")
        ));
        assert!(!path_is_within(
            Path::new(r"C:\Work"),
            Path::new(r"D:\Work\notes")
        ));
        assert!(!path_is_within(
            Path::new(r"C:\Work"),
            Path::new(r"C:\Workstation\a")
        ));
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn rejects_links_that_point_outside_the_root() {
        let (temp, root) = fixture();
        let escape = root.join("escape");
        link_dir(&temp.path().join("outside"), &escape);

        assert_eq!(code(resolve_in_root(&root, "escape")), SYMLINK_ESCAPE);
        assert_eq!(
            code(resolve_in_root(&root, "escape/secret.md")),
            SYMLINK_ESCAPE
        );
        // The same link is rejected even when the tail is not created yet.
        assert_eq!(
            code(resolve_in_root(&root, "escape/yeni.md")),
            SYMLINK_ESCAPE
        );
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn allows_links_that_stay_inside_the_root() {
        let (_temp, root) = fixture();
        let alias = root.join("alias");
        link_dir(&root.join("notes"), &alias);

        let resolved = resolve_in_root(&root, "alias/a.md").expect("internal link");
        assert_eq!(
            resolved,
            dunce::canonicalize(root.join("notes/a.md")).unwrap()
        );
        assert!(path_is_within(&root, &resolved));
    }

    #[cfg(any(windows, unix))]
    #[test]
    fn rejects_dangling_links() {
        let (temp, root) = fixture();
        let target = root.join("gecici");
        fs::create_dir_all(&target).unwrap();
        let ghost = root.join("ghost");
        link_dir(&target, &ghost);
        // Remove the target so the link exists but cannot be resolved.
        fs::remove_dir_all(&target).unwrap();

        assert_eq!(code(resolve_in_root(&root, "ghost")), SYMLINK_ESCAPE);
        assert_eq!(
            code(resolve_in_root(&root, "ghost/note.md")),
            SYMLINK_ESCAPE
        );
        assert!(fs::symlink_metadata(&ghost).is_ok());
        drop(temp);
    }
}
