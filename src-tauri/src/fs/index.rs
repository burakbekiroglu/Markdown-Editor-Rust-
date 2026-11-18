//! Recursive workspace index for quick-open / workspace search.
//!
//! [`fs_index`] walks the open workspace and returns one flat list of entries.
//! The walk never follows symlinks or NTFS junctions, so a link that points
//! outside the root cannot enumerate foreign files. The remaining rules are:
//!
//! * hidden entries (dot-prefixed names, or the Windows hidden attribute) are
//!   skipped;
//! * well-known build/VCS directories (`node_modules`, `target`, `dist`, ...)
//!   are skipped;
//! * files larger than [`MAX_INDEX_FILE_BYTES`] are skipped and counted in
//!   `skippedLarge` instead of being silently dropped;
//! * the walk stops at [`MAX_INDEX_ENTRIES`] / [`MAX_INDEX_DEPTH`] and sets
//!   `truncated`, so a pathological tree can never hang the editor.
//!
//! Ordering is folders-first then case-insensitive name order, matching
//! [`super::list::fs_list_dir`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::workspace::{self, WorkspaceState};

/// Maximum number of entries returned by one index request.
pub const MAX_INDEX_ENTRIES: usize = 10_000;
/// Maximum directory nesting the walk descends into.
pub const MAX_INDEX_DEPTH: usize = 24;
/// Files above this size are excluded from the index (2 MiB).
pub const MAX_INDEX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Directories that never carry editable documents worth indexing.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
    "coverage",
];

/// Files that are OS housekeeping noise.
const IGNORED_FILES: &[&str] = &["Thumbs.db", "desktop.ini"];

/// One indexed entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub name: String,
    /// Workspace-relative path using `/` separators.
    pub relative_path: String,
    pub is_dir: bool,
    /// Size in bytes; `0` for folders.
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    pub modified_ms: Option<u64>,
}

/// Result of one index request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    /// Display form of the indexed root.
    pub root: String,
    pub entries: Vec<IndexEntry>,
    /// True when the entry cap, depth cap, or an unreadable subtree stopped the
    /// walk before it was complete.
    pub truncated: bool,
    pub skipped_hidden: usize,
    pub skipped_large: usize,
    pub skipped_symlinks: usize,
    pub skipped_unreadable: usize,
}

/// Tunable walk limits; [`Default`] matches the public command behaviour.
#[derive(Debug, Clone, Copy)]
pub struct IndexLimits {
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_file_bytes: u64,
}

impl Default for IndexLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_INDEX_ENTRIES,
            max_depth: MAX_INDEX_DEPTH,
            max_file_bytes: MAX_INDEX_FILE_BYTES,
        }
    }
}

struct WalkState<'a> {
    root: &'a Path,
    limits: IndexLimits,
    result: IndexResult,
}

impl WalkState<'_> {
    fn is_full(&self) -> bool {
        self.result.entries.len() >= self.limits.max_entries
    }

    fn push(&mut self, entry: IndexEntry) {
        if self.is_full() {
            self.result.truncated = true;
            return;
        }
        self.result.entries.push(entry);
        if self.is_full() {
            self.result.truncated = true;
        }
    }
}

/// Index `requested` (workspace-relative, `""` for the root) under `root`.
pub fn index_in_root(root: &Path, requested: &str) -> AppResult<IndexResult> {
    index_with_limits(root, requested, IndexLimits::default())
}

/// Index with explicit limits; used by tests and by callers that need a
/// smaller preview pass.
pub fn index_with_limits(
    root: &Path,
    requested: &str,
    limits: IndexLimits,
) -> AppResult<IndexResult> {
    let start = workspace::resolve_in_root(root, requested)?;
    let metadata = fs::metadata(&start).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => AppError::not_found(requested.to_string()),
        io::ErrorKind::PermissionDenied => AppError::permission_denied(requested.to_string()),
        _ => AppError::internal(format!("{requested}: {error}")),
    })?;
    if !metadata.is_dir() {
        return Err(AppError::invalid_path(format!(
            "{requested} bir klasör değil"
        )));
    }

    let mut state = WalkState {
        root,
        limits,
        result: IndexResult {
            root: workspace::display_path(root),
            entries: Vec::new(),
            truncated: false,
            skipped_hidden: 0,
            skipped_large: 0,
            skipped_symlinks: 0,
            skipped_unreadable: 0,
        },
    };

    // The root itself was validated above, so an unreadable root is a real
    // error rather than a skip.
    let read_dir = fs::read_dir(&start)
        .map_err(|error| AppError::internal(format!("{requested}: {error}")))?;
    walk_dir(read_dir, 0, &mut state);

    Ok(state.result)
}

fn walk_dir(read_dir: fs::ReadDir, depth: usize, state: &mut WalkState<'_>) {
    if depth > state.limits.max_depth {
        state.result.truncated = true;
        return;
    }

    let mut children: Vec<(String, PathBuf, fs::Metadata, bool)> = Vec::new();
    for entry in read_dir {
        if state.is_full() {
            state.result.truncated = true;
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                state.result.skipped_unreadable += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();

        // Never follow links: a junction can point anywhere on the machine.
        let link_like = match workspace::is_link_like(&path) {
            Ok(is_link) => is_link,
            Err(_) => {
                state.result.skipped_unreadable += 1;
                continue;
            }
        };
        if link_like {
            state.result.skipped_symlinks += 1;
            continue;
        }

        // `metadata` follows nothing now that links are ruled out; the entry is
        // a plain file or folder inside the canonical root.
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                state.result.skipped_unreadable += 1;
                continue;
            }
        };
        let is_dir = metadata.is_dir();

        if is_hidden(&name, &metadata) || is_ignored(&name, is_dir) {
            state.result.skipped_hidden += 1;
            continue;
        }
        if !is_dir && metadata.len() > state.limits.max_file_bytes {
            state.result.skipped_large += 1;
            continue;
        }
        children.push((name, path, metadata, is_dir));
    }

    children.sort_by(
        |(left_name, _, _, left_dir), (right_name, _, _, right_dir)| {
            right_dir
                .cmp(left_dir)
                .then_with(|| left_name.to_lowercase().cmp(&right_name.to_lowercase()))
                .then_with(|| left_name.cmp(right_name))
        },
    );

    for (name, path, metadata, is_dir) in children {
        state.push(IndexEntry {
            name,
            relative_path: relative_path(state.root, &path),
            is_dir,
            size: if is_dir { 0 } else { metadata.len() },
            modified_ms: workspace::modified_ms(&metadata),
        });
        if is_dir {
            if state.is_full() {
                state.result.truncated = true;
                return;
            }
            match fs::read_dir(&path) {
                Ok(nested) => walk_dir(nested, depth + 1, state),
                Err(_) => state.result.skipped_unreadable += 1,
            }
        }
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_hidden(name: &str, metadata: &fs::Metadata) -> bool {
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

fn is_ignored(name: &str, is_dir: bool) -> bool {
    if is_dir {
        IGNORED_DIRS
            .iter()
            .any(|ignored| ignored.eq_ignore_ascii_case(name))
    } else {
        IGNORED_FILES
            .iter()
            .any(|ignored| ignored.eq_ignore_ascii_case(name))
    }
}

/// Index the open workspace (or one folder inside it).
#[tauri::command]
pub fn fs_index(
    state: State<'_, WorkspaceState>,
    path: Option<String>,
) -> AppResult<IndexResult> {
    let root = state.root()?;
    index_in_root(&root, &path.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("temp workspace");
        let root = fs::canonicalize(dir.path()).expect("canonical root");
        (dir, root)
    }

    fn entry<'a>(result: &'a IndexResult, name: &str) -> &'a IndexEntry {
        result
            .entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("{name} must be indexed"))
    }

    #[test]
    fn indexes_nested_files_folders_first() {
        let (_dir, root) = workspace();
        fs::create_dir(root.join("notlar")).unwrap();
        fs::write(root.join("notlar/ic.md"), "içerik").unwrap();
        fs::write(root.join("a.md"), "a").unwrap();
        fs::create_dir(root.join("Beta")).unwrap();

        let result = index_in_root(&root, "").expect("index");
        let names: Vec<_> = result.entries.iter().map(|entry| entry.name.as_str()).collect();

        // Depth-first pre-order: each folder is followed by its subtree, then
        // the sibling files of the parent folder.
        assert_eq!(names, vec!["Beta", "notlar", "ic.md", "a.md"]);
        assert!(!result.truncated);
        assert_eq!(entry(&result, "ic.md").relative_path, "notlar/ic.md");
        assert_eq!(entry(&result, "ic.md").size, "içerik".len() as u64);
    }

    #[test]
    fn skips_hidden_entries_and_ignored_directories() {
        let (_dir, root) = workspace();
        fs::write(root.join(".gizli.md"), "x").unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "x").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg.js"), "x").unwrap();
        fs::write(root.join("Thumbs.db"), "x").unwrap();
        fs::write(root.join("not.md"), "x").unwrap();

        let result = index_in_root(&root, "").expect("index");
        let names: Vec<_> = result.entries.iter().map(|entry| entry.name.as_str()).collect();

        assert_eq!(names, vec!["not.md"]);
        assert_eq!(result.skipped_hidden, 4);
    }

    #[test]
    fn skips_files_above_the_size_limit_and_reports_it() {
        let (_dir, root) = workspace();
        fs::write(root.join("buyuk.md"), "0123456789").unwrap();
        fs::write(root.join("kucuk.md"), "0123").unwrap();

        let limits = IndexLimits {
            max_file_bytes: 5,
            ..IndexLimits::default()
        };
        let result = index_with_limits(&root, "", limits).expect("index");

        assert_eq!(
            result.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["kucuk.md"]
        );
        assert_eq!(result.skipped_large, 1);
    }

    #[test]
    fn truncates_at_the_entry_cap() {
        let (_dir, root) = workspace();
        for index in 0..5 {
            fs::write(root.join(format!("not-{index}.md")), "x").unwrap();
        }

        let limits = IndexLimits {
            max_entries: 2,
            ..IndexLimits::default()
        };
        let result = index_with_limits(&root, "", limits).expect("index");

        assert_eq!(result.entries.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn rejects_files_and_outside_paths() {
        let (_dir, root) = workspace();
        fs::write(root.join("not.md"), "x").unwrap();

        assert_eq!(
            index_in_root(&root, "not.md").unwrap_err().code(),
            crate::error::AppErrorCode::InvalidPath
        );
        assert_eq!(
            index_in_root(&root, "../kacis").unwrap_err().code(),
            crate::error::AppErrorCode::PathEscape
        );
    }

    #[test]
    fn indexes_only_the_requested_subfolder() {
        let (_dir, root) = workspace();
        fs::create_dir(root.join("bir")).unwrap();
        fs::create_dir(root.join("iki")).unwrap();
        fs::write(root.join("bir/a.md"), "x").unwrap();
        fs::write(root.join("iki/b.md"), "x").unwrap();

        let result = index_in_root(&root, "bir").expect("index");

        assert_eq!(
            result.entries.iter().map(|e| e.relative_path.as_str()).collect::<Vec<_>>(),
            vec!["bir/a.md"]
        );
    }
}
