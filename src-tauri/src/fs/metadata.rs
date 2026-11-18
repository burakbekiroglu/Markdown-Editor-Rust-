//! File metadata command.
//!
//! Metadata is resolved through the same workspace confinement as every other
//! filesystem command. A symlink/junction that leaves the root is rejected by
//! the resolver, so callers never learn anything about out-of-root targets.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::workspace::{self, WorkspaceState};

/// Serialisable metadata for one workspace entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_file: bool,
    /// True when the entry itself is a symlink or an NTFS junction.
    pub is_symlink: bool,
    /// True when the Windows hidden attribute is set (always false elsewhere).
    pub is_hidden: bool,
    /// Filesystem read-only flag (not the effective ACL permission).
    pub read_only: bool,
    /// Size in bytes; `0` for folders.
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub created_ms: Option<u64>,
}

fn timestamp_ms(metadata: &fs::Metadata, created: bool) -> Option<u64> {
    let time = if created {
        metadata.created().ok()
    } else {
        metadata.modified().ok()
    }?;
    let elapsed = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(elapsed.as_millis()).ok()
}

fn is_hidden(metadata: &fs::Metadata, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
        metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn relative_name(root: &Path, path: &Path) -> (String, String) {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    (name, relative)
}

/// Read metadata for a workspace-relative path.
pub fn metadata_in_root(root: &Path, requested: &str) -> AppResult<FileMetadata> {
    let absolute = workspace::resolve_in_root(root, requested)?;
    let link_metadata = fs::symlink_metadata(&absolute).map_err(|error| match error.kind() {
        ErrorKind::NotFound => AppError::not_found(requested.to_string()),
        ErrorKind::PermissionDenied => AppError::permission_denied(requested.to_string()),
        _ => AppError::internal(format!("{requested}: {error}")),
    })?;
    let is_symlink = workspace::is_link_like(&absolute).unwrap_or(false);
    // Follow the link only after the resolver proved the target stays inside
    // the root. `symlink_metadata` above carries the link's own attributes.
    let metadata = fs::metadata(&absolute).map_err(|error| match error.kind() {
        ErrorKind::NotFound => AppError::not_found(requested.to_string()),
        ErrorKind::PermissionDenied => AppError::permission_denied(requested.to_string()),
        _ => AppError::internal(format!("{requested}: {error}")),
    })?;
    let (name, relative_path) = relative_name(root, &absolute);
    let is_dir = metadata.is_dir();
    let hidden = is_hidden(&link_metadata, &relative_path);

    Ok(FileMetadata {
        name,
        relative_path,
        is_dir,
        is_file: metadata.is_file(),
        is_symlink,
        is_hidden: hidden,
        read_only: metadata.permissions().readonly(),
        size: if is_dir { 0 } else { metadata.len() },
        modified_ms: timestamp_ms(&metadata, false),
        created_ms: timestamp_ms(&metadata, true),
    })
}

/// Return metadata for one workspace entry.
#[tauri::command]
pub fn fs_metadata(state: State<'_, WorkspaceState>, path: String) -> AppResult<FileMetadata> {
    let root = state.root()?;
    metadata_in_root(&root, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reports_file_metadata_inside_the_workspace() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::write(root.join("not.md"), "merhaba").unwrap();

        let metadata = metadata_in_root(&root, "not.md").expect("metadata");

        assert_eq!(metadata.name, "not.md");
        assert_eq!(metadata.relative_path, "not.md");
        assert!(metadata.is_file);
        assert!(!metadata.is_dir);
        assert!(!metadata.is_symlink);
        assert_eq!(metadata.size, 7);
        assert!(metadata.modified_ms.is_some());
    }

    #[test]
    fn reports_folder_metadata_and_hidden_dot_names() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::create_dir(root.join(".gizli")).unwrap();

        let metadata = metadata_in_root(&root, ".gizli").expect("metadata");

        assert!(metadata.is_dir);
        assert!(metadata.is_hidden);
        assert_eq!(metadata.size, 0);
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");

        let error = metadata_in_root(&root, "../gizli.md").expect_err("escape");

        assert_eq!(error.code(), crate::error::AppErrorCode::PathEscape);
    }

    #[test]
    fn reports_missing_entries_as_not_found() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");

        let error = metadata_in_root(&root, "yok.md").expect_err("missing");

        assert_eq!(error.code(), crate::error::AppErrorCode::NotFound);
    }
}
