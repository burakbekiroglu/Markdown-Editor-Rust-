//! Tauri command surface for the single workspace folder.
//!
//! The frontend never receives a handle to an arbitrary absolute path: it opens
//! a folder through the native dialog and afterwards refers to files with
//! workspace-relative paths, which are confined by [`crate::workspace`].

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{catch_panic, AppError, AppResult};
use crate::watcher::{SelfWriteRegistry, WatcherState};
use crate::workspace::{self, DirEntry, WorkspaceState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Canonical root as shown to the user (without the Windows `\\?\` prefix).
    pub root: String,
    /// Display name of the root folder (its final path component).
    pub name: String,
    /// Non-fatal watcher startup failure.
    ///
    /// The folder itself opened successfully, so this is returned to the
    /// caller instead of failing the command. It cannot be emitted as an
    /// event: the watch is started before this response reaches the webview,
    /// so the frontend is not subscribed yet and would never see it.
    pub watcher_error: Option<AppError>,
}

impl WorkspaceInfo {
    fn from_root(root: &Path) -> Self {
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace::display_path(root));
        Self {
            root: workspace::display_path(root),
            name,
            watcher_error: None,
        }
    }

    fn with_watcher_error(mut self, error: AppError) -> Self {
        self.watcher_error = Some(error);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Size in bytes (0 for folders); lets the tree show metadata without a
    /// second stat round-trip.
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

/// Show the native folder picker and adopt the chosen folder as the session
/// workspace root. Returns `None` when the user cancels the dialog.
#[tauri::command]
pub async fn open_workspace(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    watcher_state: State<'_, WatcherState>,
    self_writes: State<'_, SelfWriteRegistry>,
) -> AppResult<Option<WorkspaceInfo>> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("Çalışma klasörü seç")
        .pick_folder(move |folder| {
            // The command may already have been cancelled; the folder is then
            // dropped, which is expected, but it must not vanish silently.
            if let Err(error) = sender.blocking_send(folder) {
                eprintln!("[error] seçilen klasör komuta iletilemedi: {error}");
            }
        });

    let Some(picked) = receiver.recv().await.flatten() else {
        return Ok(None);
    };
    let folder = picked
        .into_path()
        .map_err(|error| AppError::invalid_path(format!("seçilen klasör okunamadı: {error}")))?;

    // The `async` body runs on its own task, outside the synchronous handler
    // fence in `lib.rs`; the root transition is therefore fenced here as well.
    Ok(Some(catch_panic(|| {
        adopt_folder(&app, &state, &watcher_state, &self_writes, &folder)
    })?))
}

/// Re-open a folder the app already knows by absolute path.
///
/// Used by session restore, which must not show the native dialog. The path
/// still goes through the same canonicalisation and confinement gate as a
/// user-picked folder: a saved root that no longer exists is an error, not a
/// silently opened empty workspace.
#[tauri::command]
pub fn open_workspace_path(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    watcher_state: State<'_, WatcherState>,
    self_writes: State<'_, SelfWriteRegistry>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("kayıtlı çalışma kökü boş"));
    }
    adopt_folder(&app, &state, &watcher_state, &self_writes, Path::new(&path))
}

/// Adopt `folder` as the session workspace root.
///
/// One root transition at a time: `state`, the asset-protocol scope and the
/// watcher must all describe the same folder even if two opens overlap. The
/// guard is a plain `std` mutex, so callers must not hold it across an await.
fn adopt_folder(
    app: &AppHandle,
    state: &WorkspaceState,
    watcher_state: &WatcherState,
    self_writes: &SelfWriteRegistry,
    folder: &Path,
) -> AppResult<WorkspaceInfo> {
    let _transition = state.transition_guard();

    // Remembered so a failure below can put the session back the way it was:
    // opening a folder must never silently close the folder already in use.
    let previous = state.root().ok();
    let root = state.open(folder)?;

    // The asset protocol starts with an empty scope: only the folder the user
    // just picked (and its descendants) may be served to the webview.
    //
    // The runtime scope is additive and has no "un-allow" call. `forbid_*`
    // patterns are permanent for the process and take precedence over allowed
    // ones, so forbidding a previous root would also poison a later re-open of
    // the same folder (or a nested new root). Old roots therefore stay
    // readable until exit; nothing outside a user-picked folder is ever added.
    if let Err(error) = app.asset_protocol_scope().allow_directory(&root, true) {
        state.restore(previous);
        return Err(AppError::internal(format!(
            "çalışma klasörü varlık kapsamına eklenemedi: {error}"
        )));
    }

    // The watch is best-effort: a failure must not make the folder unusable.
    // The error travels back with the response because the webview subscribes
    // to watcher events only after this command resolves.
    let info = WorkspaceInfo::from_root(&root);
    Ok(
        match watcher_state.start(app.clone(), root.clone(), self_writes.clone()) {
            Ok(()) => info,
            Err(error) => info.with_watcher_error(error),
        },
    )
}

/// The workspace root currently held by this session, if any.
#[tauri::command]
pub fn current_workspace(state: State<'_, WorkspaceState>) -> AppResult<Option<WorkspaceInfo>> {
    match state.root() {
        Ok(root) => Ok(Some(WorkspaceInfo::from_root(&root))),
        Err(error) if error.code == workspace::WORKSPACE_NOT_OPEN => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Close the workspace folder, releasing the confinement target.
///
/// The runtime asset-protocol grant cannot be revoked without permanently
/// forbidding the pattern (which would break re-opening the same folder), so
/// the grant simply lapses when the process exits.
#[tauri::command]
pub fn close_workspace(
    state: State<'_, WorkspaceState>,
    watcher_state: State<'_, WatcherState>,
) -> Option<WorkspaceInfo> {
    // Serialised with `open_workspace`: closing must never race a root swap.
    let _transition = state.transition_guard();
    watcher_state.stop();
    state.close().map(|root| WorkspaceInfo::from_root(&root))
}

/// List one directory below the workspace root.
///
/// `path` is workspace-relative; `""` or `None` lists the root itself. Entries
/// that are symlinks or junctions pointing outside the root are omitted.
#[tauri::command]
pub fn list_workspace_dir(
    state: State<'_, WorkspaceState>,
    path: Option<String>,
) -> AppResult<Vec<DirEntryInfo>> {
    let requested = path.unwrap_or_default();
    let entries = state.list(&requested)?;
    Ok(entries.into_iter().map(DirEntryInfo::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(watcher_error: Option<AppError>) -> WorkspaceInfo {
        WorkspaceInfo {
            root: "C:/notlar".to_string(),
            name: "notlar".to_string(),
            watcher_error,
        }
    }

    #[test]
    fn watcher_startup_error_is_returned_with_the_workspace() {
        let value = serde_json::to_value(info(Some(AppError::watcher_failed(
            "izleyici kanalı kapandı",
        ))))
        .expect("serialize workspace info");

        assert_eq!(value["root"], "C:/notlar");
        assert_eq!(value["watcherError"]["code"], "WatcherFailed");
        assert_eq!(value["watcherError"]["message"], "izleyici kanalı kapandı");
    }

    #[test]
    fn a_healthy_workspace_reports_no_watcher_error() {
        let value = serde_json::to_value(info(None)).expect("serialize workspace info");
        assert!(value["watcherError"].is_null());
    }
}
