//! Tree context-menu filesystem operations.
//!
//! Every operation resolves its target through
//! [`workspace::resolve_in_root`], so requests can never escape the session
//! workspace root (no `..`, absolute paths, UNC shares or junction escapes).
//!
//! Two rules are enforced here and mirrored in the frontend for instant
//! feedback (the backend remains the authority):
//!
//! * Windows-invalid names are rejected with `INVALID_NAME`.
//! * Existing entries are never overwritten: a collision returns
//!   `ENTRY_EXISTS` and leaves the original untouched.
//!
//! Deletion goes through the platform trash (Windows Recycle Bin), never a
//! permanent unlink.

use crate::error::{AppError, AppResult};
use crate::workspace::{self, WorkspaceState};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::State;

/// The supplied name is not a legal Windows file/folder name.
pub const INVALID_NAME: &str = "INVALID_NAME";
/// An entry with that name already exists; nothing was overwritten.
pub const ENTRY_EXISTS: &str = "ENTRY_EXISTS";
/// The requested entry does not exist.
pub const NOT_FOUND: &str = "NOT_FOUND";
/// The move destination is inside the entry being moved (or the entry itself).
pub const INVALID_TARGET: &str = "INVALID_TARGET";
/// The name is reserved by Windows (`CON`, `NUL`, `COM1`, ...).
pub const RESERVED_NAME: &str = "INVALID_NAME";
/// Filesystem call failed.
pub const IO_ERROR: &str = "IO_ERROR";
/// The source and destination live on different volumes; a move is refused.
pub const CROSS_DRIVE: &str = "CROSS_DRIVE";

/// Markdown files created from the tree always get this extension.
pub const MD_EXTENSION: &str = "md";
/// NTFS name limit, in UTF-16 code units (approximated by chars here).
pub const MAX_NAME_LENGTH: usize = 255;

const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
    "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsOpsError {
    pub code: &'static str,
    pub message: String,
}

impl FsOpsError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_name(message: impl Into<String>) -> Self {
        Self::new(INVALID_NAME, message)
    }

    fn entry_exists(name: &str) -> Self {
        Self::new(ENTRY_EXISTS, format!("bu adda bir öğe zaten var: {name}"))
    }

    fn not_found(relative: &str) -> Self {
        let shown = if relative.is_empty() { "." } else { relative };
        Self::new(NOT_FOUND, format!("öğe bulunamadı: {shown}"))
    }

    fn io(context: impl Into<String>, error: io::Error) -> Self {
        Self::new(IO_ERROR, format!("{}: {error}", context.into()))
    }
}

impl std::fmt::Display for FsOpsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FsOpsError {}

impl From<workspace::WorkspaceError> for FsOpsError {
    fn from(error: workspace::WorkspaceError) -> Self {
        Self::new(error.code, error.message)
    }
}

/// Serialisable description of a created or renamed entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// Validate one Windows file/folder name and return it trimmed.
///
/// Rejects forbidden characters, control characters, reserved device names,
/// trailing dots/spaces, empty names and over-long names.
pub fn validate_name(raw: &str) -> Result<String, FsOpsError> {
    if raw.is_empty() {
        return Err(FsOpsError::invalid_name("ad boş olamaz"));
    }
    if raw.trim().is_empty() {
        return Err(FsOpsError::invalid_name("ad yalnızca boşluktan oluşamaz"));
    }
    if raw != raw.trim() {
        return Err(FsOpsError::invalid_name(
            "ad başında veya sonunda boşluk olamaz",
        ));
    }
    if raw.ends_with('.') {
        return Err(FsOpsError::invalid_name("ad nokta ile bitemez"));
    }
    if raw == "." || raw == ".." {
        return Err(FsOpsError::invalid_name(
            "\".\" ve \"..\" ad olarak kullanılamaz",
        ));
    }
    if raw.chars().count() > MAX_NAME_LENGTH {
        return Err(FsOpsError::invalid_name(format!(
            "ad en fazla {MAX_NAME_LENGTH} karakter olabilir"
        )));
    }
    if let Some(found) = raw.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(FsOpsError::invalid_name(format!(
            "ad içinde \"{found}\" karakteri kullanılamaz"
        )));
    }
    if raw.chars().any(char::is_control) {
        return Err(FsOpsError::invalid_name("ad kontrol karakteri içeremez"));
    }

    let base = raw.split('.').next().unwrap_or_default().to_uppercase();
    if RESERVED_NAMES.contains(&base.as_str()) {
        return Err(FsOpsError::new(
            RESERVED_NAME,
            format!("\"{base}\" Windows tarafından ayrılmış bir addır"),
        ));
    }

    Ok(raw.to_string())
}

/// New-file rule: a name without an extension gets `.md` appended.
pub fn normalize_file_name(raw: &str) -> Result<String, FsOpsError> {
    let name = validate_name(raw)?;
    if Path::new(&name).extension().is_none() {
        Ok(format!("{name}.{MD_EXTENSION}"))
    } else {
        Ok(name)
    }
}

/// Renames keep folder names untouched; file names follow the `.md` rule.
pub fn normalize_entry_name(raw: &str, is_dir: bool) -> Result<String, FsOpsError> {
    if is_dir {
        validate_name(raw)
    } else {
        normalize_file_name(raw)
    }
}

fn resolve_dir(root: &Path, relative: &str) -> Result<PathBuf, FsOpsError> {
    let directory = workspace::resolve_in_root(root, relative)?;
    let metadata = fs::metadata(&directory).map_err(|error| match error.kind() {
        ErrorKind::NotFound => FsOpsError::not_found(relative),
        _ => FsOpsError::io(format!("klasör okunamadı: {relative}"), error),
    })?;
    if !metadata.is_dir() {
        return Err(FsOpsError::new(
            workspace::NOT_A_DIRECTORY,
            format!("hedef bir klasör değil: {relative}"),
        ));
    }
    Ok(directory)
}

fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, FsOpsError> {
    if relative.trim().is_empty() {
        return Err(FsOpsError::invalid_name(
            "çalışma kökü bu işlem için hedef olamaz",
        ));
    }
    let path = workspace::resolve_in_root(root, relative)?;
    fs::metadata(&path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => FsOpsError::not_found(relative),
        _ => FsOpsError::io(format!("öğe okunamadı: {relative}"), error),
    })?;
    Ok(path)
}

fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn entry_info(root: &Path, path: &Path, is_dir: bool) -> EntryInfo {
    EntryInfo {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        relative_path: relative_path(root, path),
        is_dir,
        is_symlink: false,
    }
}

fn is_same_entry(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Create an empty file below `parent_relative`, appending `.md` when the name
/// has no extension. Never overwrites: an existing entry yields `ENTRY_EXISTS`.
pub fn create_file_at(
    root: &Path,
    parent_relative: &str,
    raw_name: &str,
) -> Result<EntryInfo, FsOpsError> {
    let name = normalize_file_name(raw_name)?;
    let parent = resolve_dir(root, parent_relative)?;
    let target = parent.join(&name);

    // `create_new` is the authoritative collision check: it cannot race with a
    // concurrent create and never truncates an existing file.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(_) => Ok(entry_info(root, &target, false)),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Err(FsOpsError::entry_exists(&name))
        }
        Err(error) => Err(FsOpsError::io(
            format!("dosya oluşturulamadı: {name}"),
            error,
        )),
    }
}

/// Create a folder below `parent_relative`.
pub fn create_folder_at(
    root: &Path,
    parent_relative: &str,
    raw_name: &str,
) -> Result<EntryInfo, FsOpsError> {
    let name = validate_name(raw_name)?;
    let parent = resolve_dir(root, parent_relative)?;
    let target = parent.join(&name);

    match fs::create_dir(&target) {
        Ok(()) => Ok(entry_info(root, &target, true)),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            Err(FsOpsError::entry_exists(&name))
        }
        Err(error) => Err(FsOpsError::io(
            format!("klasör oluşturulamadı: {name}"),
            error,
        )),
    }
}

/// Renames `source` to `target` without ever replacing an existing entry.
///
/// The collision check *is* the filesystem call, so there is no check-then-act
/// window: a target created after the caller's validation is still refused
/// instead of being overwritten. On Windows this calls `MoveFileExW` **without**
/// `MOVEFILE_REPLACE_EXISTING`, which fails with `ERROR_FILE_EXISTS` /
/// `ERROR_ALREADY_EXISTS` when the target appears. `std::fs::rename` cannot be
/// used: it passes `MOVEFILE_REPLACE_EXISTING` on Windows (and `rename(2)`
/// replaces on Unix), so a racing target would be silently destroyed.
///
/// `name` is the display name used in the `ENTRY_EXISTS` message; `context` is
/// the operation label used for I/O failures.
fn rename_no_overwrite(
    source: &Path,
    target: &Path,
    name: &str,
    context: &str,
) -> Result<(), FsOpsError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

        /// `ERROR_FILE_EXISTS` and `ERROR_ALREADY_EXISTS` (Win32).
        const FILE_EXISTS: i32 = 80;
        const ALREADY_EXISTS: i32 = 183;

        fn wide(path: &Path) -> Vec<u16> {
            path.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        let from = wide(source);
        let to = wide(target);
        // `MOVE_FILE_FLAGS(0)` deliberately omits `MOVEFILE_REPLACE_EXISTING`.
        let outcome = unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVE_FILE_FLAGS(0),
            )
        };
        match outcome {
            Ok(()) => Ok(()),
            Err(error) => {
                // `windows` surfaces Win32 failures as `HRESULT_FROM_WIN32`, so
                // the low word is the original system error code.
                let os_code = error.code().0 & 0xFFFF;
                if os_code == FILE_EXISTS || os_code == ALREADY_EXISTS {
                    return Err(FsOpsError::entry_exists(name));
                }
                let os_error = io::Error::from_raw_os_error(os_code);
                if is_cross_device_error(&os_error) {
                    return Err(FsOpsError::new(
                        CROSS_DRIVE,
                        format!("çapraz sürücü taşıma desteklenmiyor: {context}"),
                    ));
                }
                Err(FsOpsError::new(IO_ERROR, format!("{context}: {error}")))
            }
        }
    }

    // Non-Windows builds only (the shipped product is Windows-only): `rename(2)`
    // has no no-overwrite flag in std, so the existence check stays separate.
    #[cfg(not(windows))]
    {
        match fs::symlink_metadata(target) {
            Ok(_) => Err(FsOpsError::entry_exists(name)),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::rename(source, target).map_err(|error| {
                    if is_cross_device_error(&error) {
                        return FsOpsError::new(
                            CROSS_DRIVE,
                            format!("çapraz sürücü taşıma desteklenmiyor: {context}"),
                        );
                    }
                    FsOpsError::new(IO_ERROR, format!("{context}: {error}"))
                })
            }
            Err(error) => Err(FsOpsError::new(IO_ERROR, format!("{context}: {error}"))),
        }
    }
}

/// Rename an existing entry in place (its parent folder never changes).
///
/// Collisions are refused by the filesystem call itself, so a sibling with the
/// target name is never replaced — not even one created concurrently. A
/// case-only rename of the same entry stays allowed.
pub fn rename_entry_at(
    root: &Path,
    relative: &str,
    raw_name: &str,
) -> Result<EntryInfo, FsOpsError> {
    let source = resolve_existing(root, relative)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| FsOpsError::io(format!("öğe okunamadı: {relative}"), error))?;
    let is_dir = metadata.is_dir();
    let name = normalize_entry_name(raw_name, is_dir)?;

    let parent = source
        .parent()
        .ok_or_else(|| FsOpsError::invalid_name("öğenin üst klasörü yok"))?;
    let target = parent.join(&name);

    if target != source {
        let same_entry = is_same_entry(&source, &target);
        match fs::symlink_metadata(&target) {
            Ok(_) if same_entry => {}
            Ok(_) => return Err(FsOpsError::entry_exists(&name)),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(FsOpsError::io(
                    format!("hedef ad kontrol edilemedi: {name}"),
                    error,
                ))
            }
        }
        if same_entry {
            // Yalnızca harf büyüklüğü değişiyor: hedef kaynağın kendisidir, bu
            // yüzden onu "değiştirmek" veri kaybı değil, adın yeni yazımıdır.
            fs::rename(&source, &target).map_err(|error| {
                FsOpsError::io(format!("yeniden adlandırılamadı: {relative}"), error)
            })?;
        } else {
            rename_no_overwrite(
                &source,
                &target,
                &name,
                &format!("yeniden adlandırılamadı: {relative}"),
            )?;
        }
    }

    Ok(entry_info(root, &target, is_dir))
}

/// Volume prefix of an absolute path (`C:` on Windows, `None` elsewhere).
fn volume_prefix(path: &Path) -> Option<std::ffi::OsString> {
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => Some(prefix.as_os_str().to_os_string()),
        _ => None,
    }
}

/// OS error reported by a rename that crosses volumes: Windows
/// `ERROR_NOT_SAME_DEVICE` (17), Unix `EXDEV` (18).
#[cfg(windows)]
const CROSS_DEVICE_ERRNO: i32 = 17;
#[cfg(not(windows))]
const CROSS_DEVICE_ERRNO: i32 = 18;

fn is_cross_device_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(CROSS_DEVICE_ERRNO)
}

/// Reject a move whose endpoints live on different volumes.
fn ensure_same_volume(source: &Path, target_dir: &Path) -> Result<(), FsOpsError> {
    if let (Some(from), Some(to)) = (volume_prefix(source), volume_prefix(target_dir)) {
        if from != to {
            return Err(FsOpsError::new(
                CROSS_DRIVE,
                format!(
                    "çapraz sürücü taşıma desteklenmiyor: {} -> {}",
                    source.display(),
                    target_dir.display()
                ),
            ));
        }
    }
    Ok(())
}

/// Move an entry into another folder inside the workspace, keeping its name.
///
/// The destination folder never receives a same-named entry: a collision is
/// refused atomically with `ENTRY_EXISTS` and both entries stay untouched.
/// Moving an entry into its current folder is a no-op, and a move across
/// volumes is refused with `CROSS_DRIVE` before the filesystem is touched.
pub fn move_entry_at(
    root: &Path,
    relative: &str,
    target_dir_relative: &str,
) -> Result<EntryInfo, FsOpsError> {
    let source = resolve_existing(root, relative)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| FsOpsError::io(format!("öğe okunamadı: {relative}"), error))?;
    let is_dir = metadata.is_dir();
    let name = source
        .file_name()
        .ok_or_else(|| FsOpsError::invalid_name("öğenin adı yok"))?
        .to_os_string();
    let display_name = name.to_string_lossy().into_owned();

    let target_dir = resolve_dir(root, target_dir_relative)?;
    ensure_same_volume(&source, &target_dir)?;

    let target = target_dir.join(&name);
    // A move that would not change the entry's location is a no-op.
    if target == source {
        return Ok(entry_info(root, &target, is_dir));
    }
    if is_dir && target_dir.starts_with(&source) {
        return Err(FsOpsError::new(
            INVALID_TARGET,
            "bir klasör kendi alt klasörüne taşınamaz",
        ));
    }

    match fs::symlink_metadata(&target) {
        Ok(_) if is_same_entry(&source, &target) => return Ok(entry_info(root, &target, is_dir)),
        Ok(_) => return Err(FsOpsError::entry_exists(&display_name)),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(FsOpsError::io(
                format!("hedef kontrol edilemedi: {}", target.display()),
                error,
            ))
        }
    }

    rename_no_overwrite(
        &source,
        &target,
        &display_name,
        &format!("taşınamadı: {relative}"),
    )?;

    Ok(entry_info(root, &target, is_dir))
}

/// Move an entry to the Recycle Bin. The workspace root itself is protected.
///
/// Platform sözleşmesi açıktır ve **hiçbir koşulda kalıcı silmeye (unlink)
/// düşmez**: Windows'ta (ürünün hedef platformu) öğe kabuğun Geri Dönüşüm
/// Kutusu'na gider ve kullanıcı tarafından geri yüklenebilir; Windows dışında
/// `trash::delete` o platformun yerel çöp kutusuna çözümlenir (freedesktop
/// trash, macOS `NSFileManager`), yani mevcut davranış korunur — işlem
/// başarısız olursa öğe yerinde kalır ve tipli `IO_ERROR` döner.
pub fn delete_entry_at(root: &Path, relative: &str) -> Result<(), FsOpsError> {
    let target = resolve_existing(root, relative)?;
    if target == root {
        return Err(FsOpsError::invalid_name("çalışma kökü silinemez"));
    }
    trash::delete(&target).map_err(|error| {
        FsOpsError::new(
            IO_ERROR,
            format!("Geri Dönüşüm Kutusu'na taşınamadı: {error}"),
        )
    })
}

#[tauri::command]
pub fn fs_create_file(
    state: State<'_, WorkspaceState>,
    parent_rel: Option<String>,
    name: String,
) -> AppResult<EntryInfo> {
    let root = state.root()?;
    Ok(create_file_at(
        &root,
        &parent_rel.unwrap_or_default(),
        &name,
    )?)
}

#[tauri::command]
pub fn fs_create_folder(
    state: State<'_, WorkspaceState>,
    parent_rel: Option<String>,
    name: String,
) -> AppResult<EntryInfo> {
    let root = state.root()?;
    Ok(create_folder_at(
        &root,
        &parent_rel.unwrap_or_default(),
        &name,
    )?)
}

#[tauri::command]
pub fn fs_rename_entry(
    state: State<'_, WorkspaceState>,
    rel: String,
    new_name: String,
) -> AppResult<EntryInfo> {
    let root = state.root()?;
    Ok(rename_entry_at(&root, &rel, &new_name)?)
}

#[tauri::command]
pub fn fs_move(
    state: State<'_, WorkspaceState>,
    rel: String,
    target_dir_rel: Option<String>,
) -> AppResult<EntryInfo> {
    let root = state.root()?;
    Ok(move_entry_at(
        &root,
        &rel,
        &target_dir_rel.unwrap_or_default(),
    )?)
}

/// Moves `rel` to the Recycle Bin.
///
/// `trash::delete` drives the Windows shell file-operation COM API, which
/// blocks until the shell reports back. A synchronous command body runs on the
/// main thread, where the shell's STA work has no message pump to return
/// through, so the call never returned and `invoke('fs_delete_entry')` never
/// settled — the confirmation dialog stayed locked on "İşleniyor…" and the
/// pending-task watcher timed out. The blocking call is therefore offloaded to
/// the async runtime's blocking pool: the IPC promise now settles with success
/// or with a typed error in every case. (Adapter/edge pattern: the platform
/// call is isolated from the domain checks in `delete_entry_at`.)
#[tauri::command]
pub async fn fs_delete_entry(state: State<'_, WorkspaceState>, rel: String) -> AppResult<()> {
    let root = state.root()?;
    // Blocking havuzundaki iş sınırlı süre beklenir: shell çağrısı dönmese bile
    // `invoke('fs_delete_entry')` resolve/reject ile sonlanır. Bir panic
    // `JoinError`'a, sınır aşımı tipli `Internal` hatasına dönüşür.
    tauri::async_runtime::spawn_blocking(move || delete_entry_at_bounded(root, rel))
        .await
        .map_err(|error| AppError::internal(format!("silme görevi tamamlanamadı: {error}")))?
}

/// `delete_entry_at`'i ayrı bir iş parçacığında çalıştırır ve
/// `DELETE_TIMEOUT` kadar bekler; süre dolarsa tipli hata döner.
fn delete_entry_at_bounded(root: PathBuf, relative: String) -> AppResult<()> {
    let deleted = run_blocking_bounded(move || delete_entry_at(&root, &relative), DELETE_TIMEOUT)?;
    Ok(deleted?)
}

/// Recycle Bin işleminin komutu bekletebileceği üst sınır.
///
/// Windows shell dosya işlemi COM API'si, çağıran iş parçacığında bir mesaj
/// pompası bulamazsa hiç dönmeyebilir. Bu durumda komutun promise'ı sonsuza
/// kadar askıda kalmamalıdır; sınır dolunca tipli hata döner ve diyalog
/// "İşleniyor…" durumunda kilitlenmez.
const DELETE_TIMEOUT: Duration = Duration::from_secs(60);

/// `work` işini ayrı bir iş parçacığında çalıştırır ve en fazla `timeout`
/// bekler.
///
/// Dönüş **her koşulda** gerçekleşir: iş biterse sonucu, süre dolarsa zaman
/// aşımı hatası, iş parçacığı panik yaparsa (gönderici düşer) tipli iç hata.
/// Askıda kalan iş parçacığı arka planda terk edilir; IPC sözleşmesi bundan
/// etkilenmez.
fn run_blocking_bounded<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    timeout: Duration,
) -> AppResult<T> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("fs-delete".into())
        .spawn(move || {
            // Alıcı zaman aşımına düşmüş olabilir; gönderim hatası yutulur.
            let _ = sender.send(work());
        })
        .map_err(|error| {
            AppError::internal(format!("silme iş parçacığı başlatılamadı: {error}"))
        })?;
    match receiver.recv_timeout(timeout) {
        Ok(value) => Ok(value),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(AppError::internal(format!(
            "Geri Dönüşüm Kutusu işlemi {timeout:?} içinde tamamlanmadı"
        ))),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(AppError::internal(
            "silme işi beklenmedik şekilde sona erdi",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        TempDir::new().expect("temp workspace")
    }

    fn root_of(workspace: &TempDir) -> PathBuf {
        fs::canonicalize(workspace.path()).expect("canonical root")
    }

    #[test]
    fn bounded_wait_returns_the_work_result() {
        let outcome = run_blocking_bounded(|| 7_u8, Duration::from_secs(5)).expect("sonuç");
        assert_eq!(outcome, 7);
    }

    #[test]
    fn bounded_wait_settles_when_the_work_never_returns() {
        // Hiç kapanmayan bir alıcı: iş parçacığı sonsuza kadar bekler ve kanal
        // açık kalır. Bu, dönmeyen shell/COM çağrısının eşdeğeridir.
        let (_sender, receiver) = std::sync::mpsc::channel::<()>();
        let started = std::time::Instant::now();
        let outcome: AppResult<()> = run_blocking_bounded(
            move || {
                let _ = receiver.recv();
            },
            Duration::from_millis(50),
        );
        let error = outcome.expect_err("zaman aşımı tipli hata döndürmeli");
        assert_eq!(error.code(), crate::error::AppErrorCode::Internal);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "sınır aşıldığında hemen dönmeli"
        );
    }

    #[test]
    fn bounded_wait_settles_when_the_work_panics() {
        let error =
            run_blocking_bounded::<()>(|| panic!("silme sırasında panic"), Duration::from_secs(5))
                .expect_err("panik tipli hataya dönüşmeli");
        assert_eq!(error.code(), crate::error::AppErrorCode::Internal);
    }

    #[test]
    fn rejects_forbidden_characters() {
        for name in [
            "a<b.md", "a>b", "a:b", "a\"b", "a/b.md", "a\\b", "a|b", "a?b", "a*b",
        ] {
            let error = validate_name(name).expect_err(name);
            assert_eq!(error.code, INVALID_NAME, "{name}");
        }
    }

    #[test]
    fn rejects_reserved_device_names() {
        for name in ["CON", "con", "nul.txt", "COM1", "lpt9.md", "CON.md", "aux"] {
            let error = validate_name(name).expect_err(name);
            assert_eq!(error.code, INVALID_NAME, "{name}");
        }
        assert!(validate_name("CONSOLE.md").is_ok());
    }

    #[test]
    fn rejects_trailing_dot_or_space_and_empty_names() {
        for name in ["rapor.", "rapor ", " ", "", ".", "..", " rapor"] {
            let error = validate_name(name).expect_err(name);
            assert_eq!(error.code, INVALID_NAME, "{name}");
        }
    }

    #[test]
    fn rejects_control_characters_and_overlong_names() {
        assert_eq!(validate_name("a\u{1}b").unwrap_err().code, INVALID_NAME);
        let long = "a".repeat(MAX_NAME_LENGTH + 1);
        assert_eq!(validate_name(&long).unwrap_err().code, INVALID_NAME);
    }

    #[test]
    fn appends_markdown_extension_only_when_missing() {
        assert_eq!(normalize_file_name("notlar").unwrap(), "notlar.md");
        assert_eq!(normalize_file_name("notlar.md").unwrap(), "notlar.md");
        assert_eq!(normalize_file_name("notlar.txt").unwrap(), "notlar.txt");
        assert_eq!(normalize_entry_name("notlar", true).unwrap(), "notlar");
        assert_eq!(normalize_entry_name("notlar", false).unwrap(), "notlar.md");
    }

    #[test]
    fn creates_markdown_file_in_nested_folder() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("gunluk")).unwrap();

        let created = create_file_at(&root, "gunluk", "notlar").expect("created");
        assert_eq!(created.name, "notlar.md");
        assert_eq!(created.relative_path, "gunluk/notlar.md");
        assert!(!created.is_dir);
        assert!(root.join("gunluk/notlar.md").is_file());
    }

    #[test]
    fn refuses_to_overwrite_existing_file() {
        let workspace = workspace();
        let root = root_of(&workspace);
        let existing = root.join("notlar.md");
        fs::write(&existing, "korunacak içerik").unwrap();

        let error = create_file_at(&root, "", "notlar").expect_err("collision");
        assert_eq!(error.code, ENTRY_EXISTS);
        assert_eq!(fs::read_to_string(&existing).unwrap(), "korunacak içerik");
    }

    #[test]
    fn create_folder_reports_existing_folder() {
        let workspace = workspace();
        let root = root_of(&workspace);
        create_folder_at(&root, "", "arsiv").expect("created");
        assert!(root.join("arsiv").is_dir());

        let error = create_folder_at(&root, "", "arsiv").expect_err("collision");
        assert_eq!(error.code, ENTRY_EXISTS);
    }

    #[test]
    fn rejects_invalid_name_on_create() {
        let workspace = workspace();
        let root = root_of(&workspace);
        let error = create_file_at(&root, "", "kötü:ad").expect_err("invalid");
        assert_eq!(error.code, INVALID_NAME);
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let workspace = workspace();
        let root = root_of(&workspace);
        let error = create_file_at(&root, "../kacis", "notlar").expect_err("escape");
        assert_eq!(error.code, workspace::PATH_OUTSIDE_WORKSPACE);
    }

    #[test]
    fn renames_file_and_keeps_content() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::write(root.join("eski.md"), "içerik").unwrap();

        let renamed = rename_entry_at(&root, "eski.md", "yeni").expect("renamed");
        assert_eq!(renamed.name, "yeni.md");
        assert_eq!(renamed.relative_path, "yeni.md");
        assert!(!root.join("eski.md").exists());
        assert_eq!(fs::read_to_string(root.join("yeni.md")).unwrap(), "içerik");
    }

    #[test]
    fn rename_collision_does_not_overwrite() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::write(root.join("a.md"), "A").unwrap();
        fs::write(root.join("b.md"), "B").unwrap();

        let error = rename_entry_at(&root, "a.md", "b.md").expect_err("collision");
        assert_eq!(error.code, ENTRY_EXISTS);
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "A");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "B");
    }

    #[test]
    fn rename_rejects_invalid_name_and_missing_entry() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::write(root.join("a.md"), "A").unwrap();

        assert_eq!(
            rename_entry_at(&root, "a.md", "kötü|ad").unwrap_err().code,
            INVALID_NAME
        );
        assert_eq!(
            rename_entry_at(&root, "yok.md", "yeni").unwrap_err().code,
            NOT_FOUND
        );
    }

    #[test]
    fn renames_folder_and_reports_new_relative_path() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("eskiklasor")).unwrap();
        fs::write(root.join("eskiklasor/not.md"), "x").unwrap();

        let renamed = rename_entry_at(&root, "eskiklasor", "yeniklasor").expect("renamed");
        assert!(renamed.is_dir);
        assert_eq!(renamed.relative_path, "yeniklasor");
        assert!(root.join("yeniklasor/not.md").is_file());
    }

    #[test]
    fn moves_file_into_a_folder_and_reports_new_path() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("arsiv")).unwrap();
        fs::write(root.join("not.md"), "içerik").unwrap();

        let moved = move_entry_at(&root, "not.md", "arsiv").expect("moved");
        assert_eq!(moved.name, "not.md");
        assert_eq!(moved.relative_path, "arsiv/not.md");
        assert!(!moved.is_dir);
        assert!(!root.join("not.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("arsiv/not.md")).unwrap(),
            "içerik"
        );
    }

    #[test]
    fn move_to_the_same_folder_is_a_noop() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("arsiv")).unwrap();
        fs::write(root.join("arsiv/not.md"), "içerik").unwrap();

        let moved = move_entry_at(&root, "arsiv/not.md", "arsiv").expect("noop");
        assert_eq!(moved.relative_path, "arsiv/not.md");
        assert_eq!(
            fs::read_to_string(root.join("arsiv/not.md")).unwrap(),
            "içerik"
        );
    }

    #[test]
    fn move_collision_does_not_overwrite() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("arsiv")).unwrap();
        fs::write(root.join("not.md"), "kaynak").unwrap();
        fs::write(root.join("arsiv/not.md"), "hedef").unwrap();

        let error = move_entry_at(&root, "not.md", "arsiv").expect_err("collision");
        assert_eq!(error.code, ENTRY_EXISTS);
        assert_eq!(fs::read_to_string(root.join("not.md")).unwrap(), "kaynak");
        assert_eq!(
            fs::read_to_string(root.join("arsiv/not.md")).unwrap(),
            "hedef"
        );
    }

    #[test]
    fn move_refuses_a_folder_inside_itself() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("ust")).unwrap();
        fs::create_dir(root.join("ust/alt")).unwrap();

        let error = move_entry_at(&root, "ust", "ust/alt").expect_err("descendant");
        assert_eq!(error.code, INVALID_TARGET);
        assert!(root.join("ust/alt").is_dir());
    }

    #[test]
    fn recognises_the_os_cross_device_error() {
        let cross = io::Error::from_raw_os_error(CROSS_DEVICE_ERRNO);
        assert!(is_cross_device_error(&cross));
        assert!(!is_cross_device_error(&io::Error::from(ErrorKind::NotFound)));
    }

    #[cfg(windows)]
    #[test]
    fn move_rejects_a_target_on_another_drive() {
        let error = ensure_same_volume(
            Path::new(r"C:\workspace\not.md"),
            Path::new(r"D:\arsiv"),
        )
        .expect_err("cross drive");
        assert_eq!(error.code, CROSS_DRIVE);
        assert!(ensure_same_volume(
            Path::new(r"C:\workspace\not.md"),
            Path::new(r"C:\workspace\arsiv")
        )
        .is_ok());
    }

    #[test]
    fn atomic_rename_refuses_an_existing_target_without_touching_either_entry() {
        // Doğrudan çağrı: ön kontrol yok. Reddi veren şey dosya sistemi
        // çağrısının kendisidir, yani yarış penceresi kapalıdır.
        let workspace = workspace();
        let root = root_of(&workspace);
        let source = root.join("kaynak.md");
        let target = root.join("hedef.md");
        fs::write(&source, "kaynak").unwrap();
        fs::write(&target, "hedef").unwrap();

        let error = rename_no_overwrite(&source, &target, "hedef.md", "taşınamadı: kaynak.md")
            .expect_err("çakışma reddedilmeli");
        assert_eq!(error.code, ENTRY_EXISTS);
        assert_eq!(fs::read_to_string(&source).unwrap(), "kaynak");
        assert_eq!(fs::read_to_string(&target).unwrap(), "hedef");
    }

    #[test]
    fn atomic_rename_moves_the_entry_when_the_target_is_free() {
        let workspace = workspace();
        let root = root_of(&workspace);
        let source = root.join("kaynak.md");
        let target = root.join("hedef.md");
        fs::write(&source, "içerik").unwrap();

        rename_no_overwrite(&source, &target, "hedef.md", "taşınamadı: kaynak.md")
            .expect("serbest hedefe taşınmalı");
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "içerik");
    }

    #[test]
    fn delete_moves_entry_to_trash() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::write(root.join("sil.md"), "x").unwrap();

        delete_entry_at(&root, "sil.md").expect("deleted");
        assert!(!root.join("sil.md").exists());
    }

    #[test]
    fn delete_targets_only_the_resolved_entry() {
        let workspace = workspace();
        let root = root_of(&workspace);
        fs::create_dir(root.join("arsiv")).unwrap();
        fs::write(root.join("arsiv/sil.md"), "silinecek").unwrap();
        fs::write(root.join("arsiv/kal.md"), "kalacak").unwrap();

        delete_entry_at(&root, "arsiv/sil.md").expect("deleted");

        assert!(!root.join("arsiv/sil.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("arsiv/kal.md")).unwrap(),
            "kalacak"
        );
    }

    #[test]
    fn delete_refuses_traversal_and_leaves_the_outside_file_intact() {
        let workspace = workspace();
        let root = root_of(&workspace);
        let outside_dir = TempDir::new().expect("outside");
        let outside = outside_dir.path().join("gizli.md");
        fs::write(&outside, "korunacak").unwrap();

        let error = delete_entry_at(&root, "../gizli.md").expect_err("traversal");
        assert_eq!(error.code, workspace::PATH_OUTSIDE_WORKSPACE);
        assert_eq!(fs::read_to_string(&outside).unwrap(), "korunacak");
    }

    #[test]
    fn delete_refuses_root_and_missing_entries() {
        let workspace = workspace();
        let root = root_of(&workspace);

        assert_eq!(delete_entry_at(&root, "").unwrap_err().code, INVALID_NAME);
        assert_eq!(
            delete_entry_at(&root, "yok.md").unwrap_err().code,
            NOT_FOUND
        );
    }
}
