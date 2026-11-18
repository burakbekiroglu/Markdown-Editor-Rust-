//! Canonical application error model shared by every Tauri command.
//!
//! [`AppErrorCode`] is the *only* error discriminator crossing the IPC
//! boundary. It serialises as a PascalCase string (`"InvalidPath"`,
//! `"PathEscape"`, ...) and is mirrored one-to-one by the TypeScript union in
//! `src/lib/ipc/types.ts`; the two must always change together.
//!
//! [`AppError`] is a `thiserror` enum whose serde representation is always
//! `{ "code": <AppErrorCode>, "message": <string> }`. `message` is meant for
//! logs and toast bodies; `code` is the stable value program logic switches
//! on. Existing module-level error types (`WorkspaceError`, `FsOpsError`,
//! `AtomicWriteError`) convert into `AppError` so commands can migrate without
//! losing their original messages.

use std::fmt;
use std::io::{self, ErrorKind};

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::fs::atomic::AtomicWriteError;
use crate::fs_ops::FsOpsError;
use crate::workspace::WorkspaceError;

/// Stable error discriminator for the whole IPC surface.
///
/// Serialised form is exactly the variant name (`InvalidPath`), which the
/// frontend mirrors as a string literal union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum AppErrorCode {
    /// The requested path is syntactically unusable, empty, or not a directory.
    InvalidPath,
    /// `..`, an absolute path, a drive change, or a UNC path leaves the root.
    PathEscape,
    /// A symlink or junction resolves outside the workspace root.
    SymlinkEscape,
    /// The requested entry does not exist.
    NotFound,
    /// The OS refused access to the target.
    PermissionDenied,
    /// The file is binary and cannot be edited as text.
    BinaryFile,
    /// The file cannot be decoded as UTF-8, so the editor refuses to open it.
    OpenUnsupported,
    /// The file exceeds the editor's size limit.
    TooLarge,
    /// The target already exists; nothing was overwritten.
    ConflictDetected,
    /// Writing the document failed; the file on disk is unchanged.
    SaveFailed,
    /// The filesystem watcher could not be started or delivered an event.
    WatcherFailed,
    /// Anything unexpected; the message carries the original detail.
    Internal,
}

impl AppErrorCode {
    /// Every code, in a stable order. Used by parity tests and docs.
    pub const ALL: [AppErrorCode; 12] = [
        AppErrorCode::InvalidPath,
        AppErrorCode::PathEscape,
        AppErrorCode::SymlinkEscape,
        AppErrorCode::NotFound,
        AppErrorCode::PermissionDenied,
        AppErrorCode::BinaryFile,
        AppErrorCode::OpenUnsupported,
        AppErrorCode::TooLarge,
        AppErrorCode::ConflictDetected,
        AppErrorCode::SaveFailed,
        AppErrorCode::WatcherFailed,
        AppErrorCode::Internal,
    ];

    /// The exact string sent over IPC (and compared in TypeScript).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "InvalidPath",
            Self::PathEscape => "PathEscape",
            Self::SymlinkEscape => "SymlinkEscape",
            Self::NotFound => "NotFound",
            Self::PermissionDenied => "PermissionDenied",
            Self::BinaryFile => "BinaryFile",
            Self::OpenUnsupported => "OpenUnsupported",
            Self::TooLarge => "TooLarge",
            Self::ConflictDetected => "ConflictDetected",
            Self::SaveFailed => "SaveFailed",
            Self::WatcherFailed => "WatcherFailed",
            Self::Internal => "Internal",
        }
    }

    /// Parses the canonical PascalCase name.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == name)
    }

    /// Maps the legacy per-module string codes (`INVALID_NAME`,
    /// `ENTRY_EXISTS`, `SaveFileLocked`, ...) onto the typed model.
    ///
    /// Canonical names are accepted as well, so a value that already crossed
    /// the new boundary can be parsed idempotently.
    ///
    /// `PATH_OUTSIDE_WORKSPACE` cannot distinguish traversal from a symlink
    /// redirect at this layer; it maps to [`AppErrorCode::PathEscape`]. Code
    /// that *knows* a link caused the escape should construct
    /// [`AppErrorCode::SymlinkEscape`] directly.
    pub fn from_legacy(code: &str) -> Option<Self> {
        if let Some(canonical) = Self::from_name(code) {
            return Some(canonical);
        }
        Some(match code {
            "INVALID_NAME" | "INVALID_PATH" | "NOT_A_DIRECTORY" | "INVALID_WORKSPACE"
            | "WORKSPACE_NOT_OPEN" => Self::InvalidPath,
            "ENTRY_EXISTS" | "OverwriteBlocked" | "OVERWRITE_BLOCKED" | "ENTRY_ALREADY_EXISTS" => {
                Self::ConflictDetected
            }
            "NOT_FOUND" => Self::NotFound,
            // A move into the entry's own subtree is not a bad *name*; it is
            // rejected before the filesystem is touched.
            "INVALID_TARGET" => Self::InvalidPath,
            "PATH_OUTSIDE_WORKSPACE" | "CROSS_DRIVE" => Self::PathEscape,
            "SYMLINK_ESCAPE" => Self::SymlinkEscape,
            "OPEN_UNSUPPORTED" => Self::OpenUnsupported,
            "PERMISSION_DENIED" => Self::PermissionDenied,
            "IO_ERROR" => Self::Internal,
            "SaveParentMissing"
            | "SaveTempCreateFailed"
            | "SaveTempWriteFailed"
            | "SaveTempFlushFailed"
            | "SaveTempSyncFailed"
            | "SaveFileLocked" => Self::SaveFailed,
            _ => return None,
        })
    }

    /// Maps an [`io::ErrorKind`] to the closest typed code.
    pub fn from_io_kind(kind: ErrorKind) -> Self {
        match kind {
            ErrorKind::NotFound => Self::NotFound,
            ErrorKind::PermissionDenied => Self::PermissionDenied,
            _ => Self::Internal,
        }
    }
}

impl fmt::Display for AppErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Typed command error. Every variant carries a human-readable detail string;
/// the code is derived from the variant, never passed alongside it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("geçersiz yol: {0}")]
    InvalidPath(String),

    #[error("çalışma kökü dışına çıkan yol reddedildi: {0}")]
    PathEscape(String),

    #[error("çalışma kökü dışına işaret eden bağlantı reddedildi: {0}")]
    SymlinkEscape(String),

    #[error("öğe bulunamadı: {0}")]
    NotFound(String),

    #[error("erişim reddedildi: {0}")]
    PermissionDenied(String),

    #[error("ikili dosya metin olarak açılamaz: {0}")]
    BinaryFile(String),

    #[error("dosya UTF-8 olarak açılamıyor: {0}")]
    OpenUnsupported(String),

    #[error("dosya düzenleyici için çok büyük: {0}")]
    TooLarge(String),

    #[error("çakışma: {0}")]
    ConflictDetected(String),

    #[error("kaydetme başarısız: {0}")]
    SaveFailed(String),

    #[error("dosya izleyici hatası: {0}")]
    WatcherFailed(String),

    #[error("beklenmeyen hata: {0}")]
    Internal(String),
}

/// Convenience alias for command signatures.
pub type AppResult<T> = Result<T, AppError>;

/// Turns a caught panic payload into the typed [`AppError::Internal`] reply.
///
/// The payload is whatever the panicking code passed to `panic!`: usually a
/// `&'static str` or a `String`. A payload of any other type still produces a
/// user-visible message, so a panic is never reported as an empty failure.
pub fn panic_error(payload: &(dyn std::any::Any + Send)) -> AppError {
    let detail = payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "sebep bildirilmedi".to_string());
    eprintln!("[error] yakalanan panic: {detail}");
    AppError::internal(format!("beklenmeyen iç hata: {detail}"))
}

/// Runs a command body and converts a panic into a typed rejection.
///
/// Tauri does not catch panics: without this fence a panic inside a command
/// unwinds out of the IPC handler and leaves the invoke promise unresolved, so
/// the webview silently hangs instead of showing a message. With the fence
/// every failure reaches the user as `{ "code": "Internal", "message": … }`.
pub fn catch_panic<T>(body: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => Err(panic_error(payload.as_ref())),
    }
}

impl AppError {
    /// Builds an error from a code and its detail message.
    pub fn from_code(code: AppErrorCode, message: impl Into<String>) -> Self {
        let message = message.into();
        match code {
            AppErrorCode::InvalidPath => Self::InvalidPath(message),
            AppErrorCode::PathEscape => Self::PathEscape(message),
            AppErrorCode::SymlinkEscape => Self::SymlinkEscape(message),
            AppErrorCode::NotFound => Self::NotFound(message),
            AppErrorCode::PermissionDenied => Self::PermissionDenied(message),
            AppErrorCode::BinaryFile => Self::BinaryFile(message),
            AppErrorCode::OpenUnsupported => Self::OpenUnsupported(message),
            AppErrorCode::TooLarge => Self::TooLarge(message),
            AppErrorCode::ConflictDetected => Self::ConflictDetected(message),
            AppErrorCode::SaveFailed => Self::SaveFailed(message),
            AppErrorCode::WatcherFailed => Self::WatcherFailed(message),
            AppErrorCode::Internal => Self::Internal(message),
        }
    }

    /// Converts a legacy module error (`{ code, message }`) into the typed
    /// model, keeping the original message. Unknown codes become
    /// [`AppErrorCode::Internal`].
    pub fn from_legacy_code(code: &str, message: impl Into<String>) -> Self {
        Self::from_code(
            AppErrorCode::from_legacy(code).unwrap_or(AppErrorCode::Internal),
            message,
        )
    }

    /// The stable code sent over IPC.
    pub fn code(&self) -> AppErrorCode {
        match self {
            Self::InvalidPath(_) => AppErrorCode::InvalidPath,
            Self::PathEscape(_) => AppErrorCode::PathEscape,
            Self::SymlinkEscape(_) => AppErrorCode::SymlinkEscape,
            Self::NotFound(_) => AppErrorCode::NotFound,
            Self::PermissionDenied(_) => AppErrorCode::PermissionDenied,
            Self::BinaryFile(_) => AppErrorCode::BinaryFile,
            Self::OpenUnsupported(_) => AppErrorCode::OpenUnsupported,
            Self::TooLarge(_) => AppErrorCode::TooLarge,
            Self::ConflictDetected(_) => AppErrorCode::ConflictDetected,
            Self::SaveFailed(_) => AppErrorCode::SaveFailed,
            Self::WatcherFailed(_) => AppErrorCode::WatcherFailed,
            Self::Internal(_) => AppErrorCode::Internal,
        }
    }

    /// The detail string without the Turkish variant prefix.
    pub fn detail(&self) -> &str {
        match self {
            Self::InvalidPath(message)
            | Self::PathEscape(message)
            | Self::SymlinkEscape(message)
            | Self::NotFound(message)
            | Self::PermissionDenied(message)
            | Self::BinaryFile(message)
            | Self::OpenUnsupported(message)
            | Self::TooLarge(message)
            | Self::ConflictDetected(message)
            | Self::SaveFailed(message)
            | Self::WatcherFailed(message)
            | Self::Internal(message) => message,
        }
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::InvalidPath(message.into())
    }

    pub fn path_escape(message: impl Into<String>) -> Self {
        Self::PathEscape(message.into())
    }

    pub fn symlink_escape(message: impl Into<String>) -> Self {
        Self::SymlinkEscape(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::PermissionDenied(message.into())
    }

    pub fn binary_file(message: impl Into<String>) -> Self {
        Self::BinaryFile(message.into())
    }

    pub fn open_unsupported(message: impl Into<String>) -> Self {
        Self::OpenUnsupported(message.into())
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::TooLarge(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::ConflictDetected(message.into())
    }

    pub fn save_failed(message: impl Into<String>) -> Self {
        Self::SaveFailed(message.into())
    }

    pub fn watcher_failed(message: impl Into<String>) -> Self {
        Self::WatcherFailed(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }
}

/// Serde shape: `{ "code": "PathEscape", "message": "<detail>" }`.
///
/// The payload carries the raw detail (without the Turkish `Display` prefix);
/// callers add the code-specific heading themselves.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", &self.code())?;
        state.serialize_field("message", self.detail())?;
        state.end()
    }
}

impl From<WorkspaceError> for AppError {
    fn from(error: WorkspaceError) -> Self {
        Self::from_legacy_code(error.code, error.message)
    }
}

impl From<FsOpsError> for AppError {
    fn from(error: FsOpsError) -> Self {
        Self::from_legacy_code(error.code, error.message)
    }
}

impl From<AtomicWriteError> for AppError {
    fn from(error: AtomicWriteError) -> Self {
        Self::SaveFailed(error.to_string())
    }
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self::from_code(AppErrorCode::from_io_kind(error.kind()), error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn codes_serialize_as_their_pascal_case_names() {
        for code in AppErrorCode::ALL {
            let json = serde_json::to_string(&code).expect("serialize code");
            assert_eq!(json, format!("\"{}\"", code.as_str()), "{code:?}");
            assert_eq!(AppErrorCode::from_name(code.as_str()), Some(code));
        }
        assert_eq!(
            serde_json::to_string(&AppErrorCode::ConflictDetected).unwrap(),
            "\"ConflictDetected\""
        );
    }

    #[test]
    fn the_code_list_matches_the_frontend_union() {
        // Keep in sync with APP_ERROR_CODES in src/lib/ipc/types.ts.
        let expected = [
            "InvalidPath",
            "PathEscape",
            "SymlinkEscape",
            "NotFound",
            "PermissionDenied",
            "BinaryFile",
            "OpenUnsupported",
            "TooLarge",
            "ConflictDetected",
            "SaveFailed",
            "WatcherFailed",
            "Internal",
        ];
        let actual = AppErrorCode::ALL.map(AppErrorCode::as_str);
        assert_eq!(actual, expected);
    }

    #[test]
    fn serializes_as_code_and_message_object() {
        let error = AppError::path_escape("../gizli.md");
        let value = serde_json::to_value(&error).expect("serialize error");

        assert_eq!(value["code"], "PathEscape");
        let message = value["message"].as_str().expect("message string");
        assert!(message.contains("../gizli.md"), "{message}");
        assert_eq!(error.code(), AppErrorCode::PathEscape);
        assert_eq!(error.detail(), "../gizli.md");
    }

    #[test]
    fn every_variant_round_trips_through_its_code() {
        for code in AppErrorCode::ALL {
            let error = AppError::from_code(code, "ayrıntı");
            assert_eq!(error.code(), code);
            assert_eq!(error.detail(), "ayrıntı");
            let value = serde_json::to_value(&error).unwrap();
            assert_eq!(value["code"], code.as_str());
        }
    }

    #[test]
    fn legacy_codes_map_to_typed_codes() {
        let cases = [
            ("INVALID_NAME", AppErrorCode::InvalidPath),
            ("INVALID_PATH", AppErrorCode::InvalidPath),
            ("INVALID_WORKSPACE", AppErrorCode::InvalidPath),
            ("WORKSPACE_NOT_OPEN", AppErrorCode::InvalidPath),
            ("NOT_A_DIRECTORY", AppErrorCode::InvalidPath),
            ("ENTRY_EXISTS", AppErrorCode::ConflictDetected),
            ("OverwriteBlocked", AppErrorCode::ConflictDetected),
            ("NOT_FOUND", AppErrorCode::NotFound),
            ("INVALID_TARGET", AppErrorCode::InvalidPath),
            ("PATH_OUTSIDE_WORKSPACE", AppErrorCode::PathEscape),
            ("CROSS_DRIVE", AppErrorCode::PathEscape),
            ("PERMISSION_DENIED", AppErrorCode::PermissionDenied),
            ("IO_ERROR", AppErrorCode::Internal),
            ("SaveFileLocked", AppErrorCode::SaveFailed),
            ("SaveParentMissing", AppErrorCode::SaveFailed),
            ("SaveTempSyncFailed", AppErrorCode::SaveFailed),
        ];
        for (legacy, expected) in cases {
            assert_eq!(
                AppErrorCode::from_legacy(legacy),
                Some(expected),
                "{legacy}"
            );
        }
        assert_eq!(AppErrorCode::from_legacy("kanun"), None);
        // Canonical names are accepted too.
        assert_eq!(
            AppErrorCode::from_legacy("SymlinkEscape"),
            Some(AppErrorCode::SymlinkEscape)
        );
    }

    #[test]
    fn workspace_errors_keep_their_message_and_code() {
        let workspace = WorkspaceError::new(
            crate::workspace::PATH_OUTSIDE_WORKSPACE,
            "path resolves outside the workspace root: ../x",
        );
        let error = AppError::from(workspace);
        assert_eq!(error.code(), AppErrorCode::PathEscape);
        assert!(error.detail().contains("../x"));

        let missing = WorkspaceError::new(crate::workspace::WORKSPACE_NOT_OPEN, "no root");
        assert_eq!(AppError::from(missing).code(), AppErrorCode::InvalidPath);
    }

    #[test]
    fn fs_ops_errors_map_collisions_to_conflict_detected() {
        let collision = FsOpsError::new(crate::fs_ops::ENTRY_EXISTS, "bu adda bir öğe zaten var");
        let error = AppError::from(collision);
        assert_eq!(error.code(), AppErrorCode::ConflictDetected);
        assert_eq!(error.detail(), "bu adda bir öğe zaten var");
    }

    #[test]
    fn save_errors_become_save_failed() {
        let atomic = AtomicWriteError::Rename {
            target: PathBuf::from("notes/a.md"),
            source: io::Error::other("rename failed"),
        };
        let error = AppError::from(atomic);
        assert_eq!(error.code(), AppErrorCode::SaveFailed);
        assert!(error.detail().contains("rename failed"));
    }

    #[test]
    fn io_errors_map_by_kind() {
        let cases = [
            (ErrorKind::NotFound, AppErrorCode::NotFound),
            (ErrorKind::PermissionDenied, AppErrorCode::PermissionDenied),
            (ErrorKind::InvalidData, AppErrorCode::Internal),
            (ErrorKind::Other, AppErrorCode::Internal),
        ];
        for (kind, expected) in cases {
            let error = AppError::from(io::Error::new(kind, "io"));
            assert_eq!(error.code(), expected, "{kind:?}");
        }
    }

    #[test]
    fn catch_panic_converts_a_panic_into_a_typed_internal_error() {
        let error = catch_panic::<()>(|| panic!("dizin sınırı aşıldı")).unwrap_err();

        assert_eq!(error.code(), AppErrorCode::Internal);
        assert!(error.detail().contains("dizin sınırı aşıldı"), "{error}");
        // Payload, serde temsiliyle aynı kullanıcı sözleşmesini taşır.
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "Internal");
        assert!(value["message"]
            .as_str()
            .unwrap()
            .starts_with("beklenmeyen iç hata"));
    }

    #[test]
    fn catch_panic_keeps_a_non_string_payload_user_visible() {
        let error = catch_panic::<()>(|| std::panic::panic_any(42_u32)).unwrap_err();

        assert_eq!(error.code(), AppErrorCode::Internal);
        assert!(error.detail().contains("sebep bildirilmedi"), "{error}");
    }

    #[test]
    fn catch_panic_leaves_successful_results_untouched() {
        assert_eq!(catch_panic(|| Ok::<i32, AppError>(7)).unwrap(), 7);

        let error = catch_panic(|| Err::<(), AppError>(AppError::path_escape("../x"))).unwrap_err();
        assert_eq!(error.code(), AppErrorCode::PathEscape);
        assert_eq!(error.detail(), "../x");
    }

    #[test]
    fn display_prefixes_the_detail_but_the_payload_does_not() {
        let error = AppError::too_large("4 MB sınırı aşıldı");
        assert_eq!(
            error.to_string(),
            "dosya düzenleyici için çok büyük: 4 MB sınırı aşıldı"
        );
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["message"], "4 MB sınırı aşıldı");
    }
}
