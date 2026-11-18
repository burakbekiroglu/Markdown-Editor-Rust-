//! Workspace root confinement.
//!
//! The editor works on exactly one folder, chosen through a native folder
//! dialog. Every filesystem request is expressed as a path relative to that
//! root and must resolve *inside* it. `..`, absolute paths, drive changes,
//! UNC paths, and symlink/junction redirections that leave the root are all
//! rejected with [`PATH_OUTSIDE_WORKSPACE`].
//!
//! This module intentionally depends on `std` only so the confinement rules
//! can be unit-tested without a Tauri runtime.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Error code returned whenever a request resolves outside the workspace root.
pub const PATH_OUTSIDE_WORKSPACE: &str = "PATH_OUTSIDE_WORKSPACE";
/// No workspace folder has been opened in this session yet.
pub const WORKSPACE_NOT_OPEN: &str = "WORKSPACE_NOT_OPEN";
/// The selected folder is empty, missing, or not a directory.
pub const INVALID_WORKSPACE: &str = "INVALID_WORKSPACE";
/// The requested path exists but is not a directory (directory listing only).
pub const NOT_A_DIRECTORY: &str = "NOT_A_DIRECTORY";
/// The request is syntactically unusable (e.g. no relative path was supplied).
pub const INVALID_PATH: &str = "INVALID_PATH";
/// An underlying filesystem call failed.
pub const IO_ERROR: &str = "IO_ERROR";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceError {
    pub code: &'static str,
    pub message: String,
}

impl WorkspaceError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn outside(requested: &str) -> Self {
        Self::new(
            PATH_OUTSIDE_WORKSPACE,
            format!("yol Ã§alÄ±ÅŸma kÃ¶kÃ¼nÃ¼n dÄ±ÅŸÄ±na Ã§Ä±kÄ±yor: {requested}"),
        )
    }

    fn io(context: &str, error: io::Error) -> Self {
        Self::new(IO_ERROR, format!("{context}: {error}"))
    }
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceError {}

/// Canonicalise a folder picked by the user and verify it is a directory.
pub fn canonicalize_workspace_root(selected: &Path) -> Result<PathBuf, WorkspaceError> {
    if selected.as_os_str().is_empty() {
        return Err(WorkspaceError::new(
            INVALID_WORKSPACE,
            "Ã§alÄ±ÅŸma klasÃ¶rÃ¼ seÃ§ilmedi",
        ));
    }
    let canonical = fs::canonicalize(selected).map_err(|error| {
        WorkspaceError::new(
            INVALID_WORKSPACE,
            format!(
                "Ã§alÄ±ÅŸma klasÃ¶rÃ¼ aÃ§Ä±lamadÄ±: {}: {error}",
                selected.display()
            ),
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        WorkspaceError::new(
            INVALID_WORKSPACE,
            format!(
                "Ã§alÄ±ÅŸma klasÃ¶rÃ¼ incelenemedi: {}: {error}",
                canonical.display()
            ),
        )
    })?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::new(
            INVALID_WORKSPACE,
            format!("Ã§alÄ±ÅŸma kÃ¶kÃ¼ bir klasÃ¶r deÄŸil: {}", canonical.display()),
        ));
    }
    Ok(canonical)
}

/// Session-scoped workspace root. One session edits one folder.
#[derive(Debug, Default)]
pub struct WorkspaceState {
    root: Mutex<Option<PathBuf>>,
    /// Serialises root transitions. Adopting a new root touches the stored
    /// root, the asset-protocol scope and the watcher; without this lock two
    /// overlapping opens could leave the stored root and the watcher pointing
    /// at different folders.
    transition: Mutex<()>,
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonicalise `selected`, remember it for the session, and return it.
    pub fn open(&self, selected: &Path) -> Result<PathBuf, WorkspaceError> {
        let root = canonicalize_workspace_root(selected)?;
        let mut guard = self.lock();
        *guard = Some(root.clone());
        Ok(root)
    }

    /// Forget the current root, returning the folder that was open.
    pub fn close(&self) -> Option<PathBuf> {
        self.lock().take()
    }

    /// Put back a root that [`WorkspaceState::open`] returned earlier.
    ///
    /// Used to roll back a failed open: the caller restores the root that was
    /// active before the attempt, so a rejected folder never costs the user
    /// the workspace that was already open.
    pub(crate) fn restore(&self, root: Option<PathBuf>) {
        *self.lock() = root;
    }

    /// Hold this for the whole "adopt a new root" sequence.
    ///
    /// The guard is a plain `std` mutex on purpose: it must be taken after the
    /// last `await` of a command, so the command future stays `Send`.
    pub(crate) fn transition_guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn root(&self) -> Result<PathBuf, WorkspaceError> {
        self.lock()
            .clone()
            .ok_or_else(|| WorkspaceError::new(WORKSPACE_NOT_OPEN, "aÃ§Ä±k bir Ã§alÄ±ÅŸma klasÃ¶rÃ¼ yok"))
    }

    /// Resolve a workspace-relative request against the current root.
    pub fn resolve(&self, requested: &str) -> Result<PathBuf, WorkspaceError> {
        resolve_in_root(&self.root()?, requested)
    }

    /// List one directory below the current root.
    pub fn list(&self, requested: &str) -> Result<Vec<DirEntry>, WorkspaceError> {
        list_in_root(&self.root()?, requested)
    }

    // A poisoned lock only means another thread panicked while holding it; the
    // stored root is still a valid PathBuf, so recovery is safe here.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<PathBuf>> {
        self.root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One visible directory entry. Symlinks and junctions that point outside the
/// root are never listed and can never be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Size of the entry in bytes (0 for directories).
    pub size: u64,
    /// Last modification time in milliseconds since the Unix epoch.
    ///
    /// `None` when the platform cannot report it or the timestamp predates the
    /// epoch; callers must not render a fake date.
    pub modified_ms: Option<u64>,
}

/// Resolve `requested` (workspace-relative) to an absolute path inside `root`.
///
/// Both existing and not-yet-created paths are supported: the deepest existing
/// ancestor is canonicalised, which resolves junctions and symlinks before the
/// containment check, and the remaining plain name components are appended.
pub fn resolve_in_root(root: &Path, requested: &str) -> Result<PathBuf, WorkspaceError> {
    let relative = normalize_relative(requested)?;
    let candidate = root.join(&relative);
    ensure_confined(root, &candidate, requested)
}

/// List a directory below `root`, skipping any entry that escapes the root.
pub fn list_in_root(root: &Path, requested: &str) -> Result<Vec<DirEntry>, WorkspaceError> {
    let directory = resolve_in_root(root, requested)?;
    let metadata = fs::metadata(&directory)
        .map_err(|error| WorkspaceError::io(&format!("okunamadÄ±: {requested}"), error))?;
    if !metadata.is_dir() {
        return Err(WorkspaceError::new(
            NOT_A_DIRECTORY,
            format!("klasÃ¶r deÄŸil: {requested}"),
        ));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&directory)
        .map_err(|error| WorkspaceError::io(&format!("listelenemedi: {requested}"), error))?;
    for entry in read_dir {
        let entry =
            entry.map_err(|error| WorkspaceError::io("dizin girdisi okunamadÄ±", error))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        // `symlink_metadata` never follows a link, so reparse points are
        // detected before their target is touched.
        let link_like = is_link_like(&path)
            .map_err(|error| WorkspaceError::io(&format!("incelenemedi: {name}"), error))?;

        // Canonicalising the entry resolves junctions/symlinks. An entry whose
        // target is missing or outside the root is dropped entirely: it is
        // neither listed nor reachable through `resolve_in_root`.
        let resolved = match fs::canonicalize(&path) {
            Ok(resolved) if resolved == root || resolved.starts_with(root) => resolved,
            _ => continue,
        };
        let target_metadata = fs::metadata(&resolved)
            .map_err(|error| WorkspaceError::io(&format!("incelenemedi: {name}"), error))?;

        let relative_path = directory
            .join(&name)
            .strip_prefix(root)
            .map(|relative| relative.to_path_buf())
            .unwrap_or_else(|_| PathBuf::from(&name));

        entries.push(DirEntry {
            name,
            relative_path: to_forward_slashes(&relative_path),
            is_dir: target_metadata.is_dir(),
            is_symlink: link_like,
            size: if target_metadata.is_dir() {
                0
            } else {
                target_metadata.len()
            },
            modified_ms: modified_ms(&target_metadata),
        });
    }

    // Folders first, then case-insensitive name order. The case-sensitive
    // tiebreaker keeps the order deterministic for names that differ only in
    // case (NTFS allows both to coexist).
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// Last modification time as milliseconds since the Unix epoch.
pub(crate) fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(elapsed.as_millis()).ok()
}

/// True when `path` itself is a symlink or an NTFS reparse point (junction).
pub(crate) fn is_link_like(path: &Path) -> io::Result<bool> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT covers symlinks and mount-point junctions;
        // `FileType::is_symlink` alone would miss junctions.
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(metadata.file_type().is_symlink())
    }
}

/// Render a root path without the Windows verbatim (`\\?\`) prefix.
pub fn display_path(path: &Path) -> String {
    let rendered = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = rendered.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    rendered.into_owned()
}

fn normalize_relative(requested: &str) -> Result<PathBuf, WorkspaceError> {
    if requested.contains('\0') {
        return Err(WorkspaceError::new(
            INVALID_PATH,
            "yol NUL baytÄ± iÃ§eriyor",
        ));
    }
    let mut normalized = PathBuf::new();
    for component in Path::new(requested).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            // `..`, absolute targets, drive prefixes and UNC shares are all
            // treated as escape attempts, never normalised away.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::outside(requested));
            }
        }
    }
    Ok(normalized)
}

fn ensure_confined(
    root: &Path,
    candidate: &Path,
    requested: &str,
) -> Result<PathBuf, WorkspaceError> {
    let mut probe = candidate.to_path_buf();
    let mut suffix: Vec<OsString> = Vec::new();

    loop {
        match fs::canonicalize(&probe) {
            Ok(resolved) => {
                let mut confined = confine(root, &resolved, requested)?;
                for part in suffix.iter().rev() {
                    confined.push(part);
                }
                return Ok(confined);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // A dangling symlink/junction still exists as a directory
                // entry, but its target cannot be canonicalised, so
                // containment cannot be proven. Such a component is never
                // treated as a plain not-yet-created name.
                if is_link_like(&probe).unwrap_or(false) {
                    return Err(WorkspaceError::outside(requested));
                }
                let Some(parent) = probe.parent() else {
                    return Err(WorkspaceError::outside(requested));
                };
                if probe == root || parent == probe {
                    // The root itself always exists; a missing root is an
                    // invalid workspace rather than an escape attempt.
                    return Err(WorkspaceError::new(
                        WORKSPACE_NOT_OPEN,
                        format!("Ã§alÄ±ÅŸma kÃ¶kÃ¼ne ulaÅŸÄ±lamÄ±yor: {}", root.display()),
                    ));
                }
                match probe.file_name() {
                    Some(name) => suffix.push(name.to_os_string()),
                    None => return Err(WorkspaceError::outside(requested)),
                }
                probe = parent.to_path_buf();
            }
            Err(error) => {
                return Err(WorkspaceError::io(
                    &format!("yol Ã§Ã¶zÃ¼mlenemedi: {requested}"),
                    error,
                ));
            }
        }
    }
}

fn confine(root: &Path, resolved: &Path, requested: &str) -> Result<PathBuf, WorkspaceError> {
    if resolved == root || resolved.starts_with(root) {
        Ok(resolved.to_path_buf())
    } else {
        Err(WorkspaceError::outside(requested))
    }
}

fn to_forward_slashes(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Minimal self-cleaning temp directory (keeps this module dependency-free).
    struct TempTree {
        path: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "md-editor-workspace-{tag}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp tree");
            Self { path }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn fixture() -> (TempTree, PathBuf) {
        let tree = TempTree::new("confine");
        let root = tree.path.join("workspace");
        fs::create_dir_all(root.join("notes").join("drafts")).expect("create workspace");
        fs::write(root.join("notes").join("a.md"), "# a").expect("write file");
        fs::create_dir_all(tree.path.join("outside")).expect("create outside");
        fs::write(tree.path.join("outside").join("secret.md"), "secret").expect("write secret");
        (tree, root)
    }

    #[test]
    fn root_is_canonicalized_and_session_scoped() {
        let (tree, root) = fixture();
        let messy = root.join("notes").join("..");
        let state = WorkspaceState::new();

        assert_eq!(state.root().unwrap_err().code, WORKSPACE_NOT_OPEN);
        let opened = state.open(&messy).expect("open workspace");

        assert_eq!(opened, fs::canonicalize(&root).unwrap());
        assert!(opened.is_absolute());
        assert_eq!(state.root().unwrap(), opened);
        assert_eq!(state.close(), Some(opened));
        assert_eq!(state.root().unwrap_err().code, WORKSPACE_NOT_OPEN);
        drop(tree);
    }

    #[test]
    fn opening_another_folder_replaces_the_root() {
        let (tree, root) = fixture();
        let other = tree.path.join("outside");
        let state = WorkspaceState::new();

        let first = state.open(&root).expect("open first workspace");
        assert_eq!(state.root().unwrap(), first);

        let second = state.open(&other).expect("open second workspace");
        assert_ne!(first, second, "a new folder must become the root");
        assert_eq!(state.root().unwrap(), second);

        assert_eq!(state.close(), Some(second));
        assert_eq!(state.close(), None);
        drop(tree);
    }

    #[test]
    fn a_rejected_folder_keeps_the_previous_root() {
        let (tree, root) = fixture();
        let state = WorkspaceState::new();
        let opened = state.open(&root).expect("open workspace");

        // A folder that cannot be canonicalised never reaches the state.
        let previous = state.root().ok();
        assert!(state.open(&tree.path.join("missing")).is_err());
        assert_eq!(state.root().unwrap(), opened);

        // An open that already swapped the root is rolled back explicitly.
        state
            .open(&tree.path.join("outside"))
            .expect("open other workspace");
        state.restore(previous);
        assert_eq!(state.root().unwrap(), opened);
        drop(tree);
    }

    #[test]
    fn opening_a_file_is_not_a_workspace() {
        let (tree, root) = fixture();
        let file = root.join("notes").join("a.md");
        assert_eq!(
            canonicalize_workspace_root(&file).unwrap_err().code,
            INVALID_WORKSPACE
        );
        assert_eq!(
            canonicalize_workspace_root(&tree.path.join("missing"))
                .unwrap_err()
                .code,
            INVALID_WORKSPACE
        );
        drop(tree);
    }

    #[test]
    fn accepts_paths_inside_root() {
        let (tree, root) = fixture();
        let canonical_root = fs::canonicalize(&root).unwrap();

        assert_eq!(
            resolve_in_root(&canonical_root, "").unwrap(),
            canonical_root
        );
        assert_eq!(
            resolve_in_root(&canonical_root, "notes").unwrap(),
            canonical_root.join("notes")
        );
        assert_eq!(
            resolve_in_root(&canonical_root, "./notes/a.md").unwrap(),
            canonical_root.join("notes").join("a.md")
        );
        // Not-yet-created files resolve below the root.
        let new_file = resolve_in_root(&canonical_root, "notes/new/deep.md").unwrap();
        assert_eq!(
            new_file,
            canonical_root.join("notes").join("new").join("deep.md")
        );
        assert!(new_file.starts_with(&canonical_root));
        drop(tree);
    }

    #[test]
    fn rejects_traversal_and_absolute_requests() {
        let (tree, root) = fixture();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let absolute = tree
            .path
            .join("outside")
            .join("secret.md")
            .to_string_lossy()
            .to_string();
        let requests = [
            "..",
            "../outside/secret.md",
            "notes/../../outside/secret.md",
            r"..\outside\secret.md",
            absolute.as_str(),
            r"C:\Windows\System32",
            r"C:relative-drive-path",
            r"\\server\share\file.md",
            r"\\?\C:\Windows",
            "/etc/passwd",
        ];

        for request in requests {
            let error = resolve_in_root(&canonical_root, request)
                .expect_err(&format!("request should be rejected: {request}"));
            assert_eq!(
                error.code, PATH_OUTSIDE_WORKSPACE,
                "unexpected error code for {request}"
            );
        }
        drop(tree);
    }

    #[test]
    fn rejects_empty_state_requests() {
        let state = WorkspaceState::new();
        assert_eq!(state.resolve("notes").unwrap_err().code, WORKSPACE_NOT_OPEN);
        assert_eq!(state.list("").unwrap_err().code, WORKSPACE_NOT_OPEN);
    }

    #[test]
    fn lists_entries_below_root_only() {
        let (tree, root) = fixture();
        let state = WorkspaceState::new();
        state.open(&root).unwrap();

        let entries = state.list("").expect("list root");
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["notes"]);

        let notes = state.list("notes").expect("list notes");
        let a_md = notes
            .iter()
            .find(|entry| entry.name == "a.md")
            .expect("markdown file is listed");
        assert_eq!(a_md.relative_path, "notes/a.md");
        assert!(!a_md.is_dir);
        assert!(notes
            .iter()
            .any(|entry| entry.name == "drafts" && entry.is_dir));

        assert_eq!(state.list("notes/a.md").unwrap_err().code, NOT_A_DIRECTORY);
        drop(tree);
    }

    #[cfg(windows)]
    #[test]
    fn junction_out_of_root_is_invisible_and_unreachable() {
        let (tree, root) = fixture();
        let outside = tree.path.join("outside");
        let junction = root.join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run mklink");
        assert!(status.success(), "junction fixture could not be created");

        let state = WorkspaceState::new();
        state.open(&root).unwrap();

        let error = state
            .resolve("escape/secret.md")
            .expect_err("junction must be rejected");
        assert_eq!(error.code, PATH_OUTSIDE_WORKSPACE);
        assert_eq!(
            state.resolve("escape").unwrap_err().code,
            PATH_OUTSIDE_WORKSPACE
        );

        let root_entries = state.list("").expect("list root");
        assert!(
            root_entries.iter().all(|entry| entry.name != "escape"),
            "escaping junction must not be listed"
        );
        drop(tree);
    }

    #[cfg(windows)]
    #[test]
    fn dangling_junction_is_never_resolved_or_listed() {
        let (tree, root) = fixture();
        let outside = tree.path.join("outside");
        let junction = root.join("ghost");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run mklink");
        assert!(status.success(), "junction fixture could not be created");

        // Removing the target leaves the junction behind as a dangling
        // reparse point: it exists, but its destination cannot be verified.
        fs::remove_dir_all(&outside).expect("remove junction target");
        assert!(
            fs::symlink_metadata(&junction).is_ok(),
            "junction must still exist as an entry"
        );
        assert!(
            fs::canonicalize(&junction).is_err(),
            "dangling junction cannot be canonicalised"
        );

        let state = WorkspaceState::new();
        state.open(&root).unwrap();

        assert_eq!(
            state.resolve("ghost").unwrap_err().code,
            PATH_OUTSIDE_WORKSPACE
        );
        assert_eq!(
            state.resolve("ghost/note.md").unwrap_err().code,
            PATH_OUTSIDE_WORKSPACE
        );
        assert_eq!(
            state.list("ghost").unwrap_err().code,
            PATH_OUTSIDE_WORKSPACE
        );
        assert!(
            state
                .list("")
                .expect("list root")
                .iter()
                .all(|entry| entry.name != "ghost"),
            "dangling junction must not be listed"
        );
        drop(tree);
    }

    #[cfg(windows)]
    #[test]
    fn junction_inside_root_is_allowed() {
        let (tree, root) = fixture();
        let target = root.join("notes");
        let junction = root.join("alias");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run mklink");
        assert!(status.success(), "junction fixture could not be created");

        let state = WorkspaceState::new();
        state.open(&root).unwrap();

        let resolved = state
            .resolve("alias/a.md")
            .expect("internal junction is allowed");
        assert_eq!(
            resolved,
            fs::canonicalize(root.join("notes")).unwrap().join("a.md")
        );

        let entries = state.list("").expect("list root");
        let alias = entries
            .iter()
            .find(|entry| entry.name == "alias")
            .expect("internal junction is listed");
        assert!(alias.is_symlink);
        assert!(alias.is_dir);
        drop(tree);
    }
}

