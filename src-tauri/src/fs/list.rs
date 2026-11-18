//! Directory listing with entry metadata.
//!
//! [`fs_list_dir`] is the metadata-rich listing used by the file tree and the
//! quick-open palette. It shares the confinement and escape filtering of
//! [`crate::workspace::list_in_root`]: entries whose symlink/junction target
//! lies outside the workspace root are never returned.
//!
//! Ordering is fixed: folders first, then case-insensitive name order. The
//! frontend can therefore render the response as-is.

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::workspace::{self, DirEntry, WorkspaceState};

/// One visible entry below the requested directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    /// Workspace-relative path using `/` separators.
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Size in bytes; `0` for folders.
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    pub modified_ms: Option<u64>,
}

impl From<DirEntry> for DirEntryInfo {
    fn from(entry: DirEntry) -> Self {
        Self {
            name: entry.name,
            relative_path: entry.relative_path,
            is_dir: entry.is_dir,
            is_symlink: entry.is_symlink,
            size: entry.size,
            modified_ms: entry.modified_ms,
        }
    }
}

/// List a directory inside `root`; `""` lists the root itself.
///
/// Kept free of Tauri types so the ordering and metadata can be tested
/// directly.
pub fn list_dir_in_root(
    root: &std::path::Path,
    requested: &str,
) -> AppResult<Vec<DirEntryInfo>> {
    let entries = workspace::list_in_root(root, requested)?;
    Ok(entries.into_iter().map(DirEntryInfo::from).collect())
}

/// List one directory below the workspace root.
///
/// `path` is workspace-relative; `""` or `None` lists the root itself.
#[tauri::command]
pub fn fs_list_dir(
    state: State<'_, WorkspaceState>,
    path: Option<String>,
) -> AppResult<Vec<DirEntryInfo>> {
    let root = state.root()?;
    list_dir_in_root(&root, &path.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lists_folders_first_then_case_insensitive_names() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::create_dir(root.join("zeta")).unwrap();
        fs::create_dir(root.join("Alpha")).unwrap();
        fs::write(root.join("beta.md"), "bb").unwrap();
        fs::write(root.join("alpha.md"), "a").unwrap();

        let names: Vec<_> = list_dir_in_root(&root, "")
            .expect("list root")
            .into_iter()
            .map(|entry| entry.name)
            .collect();

        assert_eq!(names, vec!["Alpha", "zeta", "alpha.md", "beta.md"]);
    }

    #[test]
    fn reports_size_and_modified_time_for_files() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::write(root.join("not.md"), "12345").unwrap();
        fs::create_dir(root.join("klasor")).unwrap();

        let entries = list_dir_in_root(&root, "").expect("list root");
        let file = entries.iter().find(|entry| entry.name == "not.md").unwrap();
        assert_eq!(file.size, 5);
        assert!(file.modified_ms.is_some());

        let folder = entries
            .iter()
            .find(|entry| entry.name == "klasor")
            .unwrap();
        assert!(folder.is_dir);
        assert_eq!(folder.size, 0);
    }

    #[test]
    fn rejects_a_file_as_directory_listing_target() {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        fs::write(root.join("not.md"), "x").unwrap();

        let error = list_dir_in_root(&root, "not.md").expect_err("file is not a directory");
        assert_eq!(error.code(), crate::error::AppErrorCode::InvalidPath);
    }
}
