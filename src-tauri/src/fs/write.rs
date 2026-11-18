//! Tauri command boundary for saving a workspace document.
//!
//! The command only resolves and validates the workspace-relative path; the
//! actual replacement is delegated to [`super::atomic`], which guarantees that
//! the target file is never left half written.
//!
//! Two invariants live here rather than in the editor:
//!
//! * **Format preservation.** The existing target bytes are inspected before
//!   writing so a UTF-8 BOM and the dominant CRLF/LF ending are re-applied. The
//!   editor may hand us LF-only text; the file keeps its original shape.
//! * **Optimistic concurrency.** When the caller supplies `expectedHash`, the
//!   current on-disk bytes must hash to that value. A mismatch (or a file that
//!   disappeared) refuses the write with `ConflictDetected` and leaves the
//!   disk untouched. A successful save returns the new content hash so the
//!   caller can save again without a redundant conflict check.

use std::io::{self, ErrorKind};
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::watcher::SelfWriteRegistry;
use crate::workspace::WorkspaceState;

use super::atomic::atomic_write;
use super::encoding;
use super::read::{read_bounded, MAX_DOCUMENT_BYTES};

/// Result of a successful save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// Hash of the exact bytes written, suitable as the next `expectedHash`.
    pub hash: String,
}

/// Outcome of [`save_document`], including the encoded bytes for the caller
/// that records them in the self-write registry.
#[derive(Debug)]
struct SavedDocument {
    result: SaveResult,
    bytes: Vec<u8>,
}

/// Atomically write `contents` to `relative_path` inside the open workspace.
///
/// Kept free of Tauri types so the save path can be exercised directly. No
/// `expectedHash` is supplied, so this is an unconditional save.
pub fn write_workspace_file(
    root: &Path,
    relative_path: &str,
    contents: &str,
) -> AppResult<SaveResult> {
    let workspace = WorkspaceState::new();
    workspace.open(root)?;
    let absolute = workspace.resolve(relative_path)?;
    save_document(&absolute, contents, None).map(|saved| saved.result)
}

/// Save a document. On failure the target file is unchanged, so the caller can
/// keep the tab dirty and show the typed error code in the toast.
///
/// `expected_hash` is the hash returned by a previous read or save. When it is
/// present and the disk no longer matches, nothing is written.
#[tauri::command]
pub fn fs_write_file_atomic(
    path: String,
    contents: String,
    expected_hash: Option<String>,
    workspace: State<'_, WorkspaceState>,
    self_writes: State<'_, SelfWriteRegistry>,
) -> AppResult<SaveResult> {
    let absolute = workspace.resolve(&path)?;
    let saved = save_document(&absolute, &contents, expected_hash.as_deref())?;
    // Remember the exact bytes written so the watcher does not echo this save
    // back as an external change. Recorded after a successful replacement only.
    self_writes.record(&path, &saved.bytes);
    Ok(saved.result)
}

/// Reads, conflict-checks, encodes and atomically writes one document.
fn save_document(
    absolute: &Path,
    contents: &str,
    expected_hash: Option<&str>,
) -> AppResult<SavedDocument> {
    // Bound the write buffer up front so a pathological payload is rejected
    // before encoding allocates a second full copy of it.
    if contents.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(AppError::too_large(format!(
            "kayıt için çok büyük: {} bayt (sınır {} bayt)",
            contents.len(),
            MAX_DOCUMENT_BYTES
        )));
    }
    let existing = read_existing(absolute)?;

    if let Some(expected) = expected_hash {
        let current = existing.as_deref().map(encoding::content_hash_hex);
        if current.as_deref() != Some(expected) {
            return Err(AppError::conflict(format!(
                "{} diskteki sürüm beklenen içerikle eşleşmiyor",
                absolute.display()
            )));
        }
    }

    let format = existing
        .as_deref()
        .map(encoding::detect_format)
        .unwrap_or_default();
    let bytes = encoding::encode(contents, format);

    // CRLF re-application can grow the payload past the cap; reject before
    // staging the temporary file rather than truncating a document.
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(AppError::too_large(format!(
            "kodlanmış kayıt çok büyük: {} bayt (sınır {} bayt)",
            bytes.len(),
            MAX_DOCUMENT_BYTES
        )));
    }

    atomic_write(absolute, &bytes)?;
    let result = SaveResult {
        hash: encoding::content_hash_hex(&bytes),
    };
    Ok(SavedDocument { result, bytes })
}

/// Current bytes of the target, or `None` when it does not exist yet.
fn read_existing(absolute: &Path) -> AppResult<Option<Vec<u8>>> {
    match read_bounded(absolute, MAX_DOCUMENT_BYTES) {
        Ok(bytes) if bytes.len() as u64 > MAX_DOCUMENT_BYTES => Err(AppError::too_large(
            format!(
                "hedef kayıt için çok büyük: {} (sınır {} bayt)",
                absolute.display(),
                MAX_DOCUMENT_BYTES
            ),
        )),
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(absolute, &error)),
    }
}

fn io_error(path: &Path, error: &io::Error) -> AppError {
    let message = format!("{}: {error}", path.display());
    match error.kind() {
        ErrorKind::NotFound => AppError::not_found(message),
        ErrorKind::PermissionDenied => AppError::permission_denied(message),
        _ => AppError::internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::read::UTF8_BOM;
    use std::fs;
    use tempfile::TempDir;

    fn workspace_with(name: &str, initial: &[u8]) -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join(name);
        fs::write(&file, initial).expect("başlangıç dosyası");
        (dir, file)
    }

    fn read_back(path: &Path) -> Vec<u8> {
        fs::read(path).expect("dosya okunmalı")
    }

    #[test]
    fn preserves_a_utf8_bom_across_a_save() {
        let mut initial = UTF8_BOM.to_vec();
        initial.extend_from_slice(b"baslik\r\nsatir\r\n");
        let (_dir, file) = workspace_with("bom.md", &initial);

        // The editor sends LF-only text with no BOM, as it always does.
        let saved = save_document(&file, "baslik\nsatir\nyeni\n", None).expect("kaydet");

        let bytes = read_back(&file);
        assert!(bytes.starts_with(&UTF8_BOM), "BOM korunmalı");
        assert_eq!(&bytes[UTF8_BOM.len()..], b"baslik\r\nsatir\r\nyeni\r\n");
        assert_eq!(saved.result.hash, encoding::content_hash_hex(&bytes));
    }

    #[test]
    fn does_not_add_a_bom_to_a_bomless_file() {
        let (_dir, file) = workspace_with("plain.md", b"a\nb\n");

        save_document(&file, "a\nb\nc\n", None).expect("kaydet");

        let bytes = read_back(&file);
        assert!(!bytes.starts_with(&UTF8_BOM), "BOM eklenmemeli");
        assert_eq!(bytes, b"a\nb\nc\n");
    }

    #[test]
    fn normalises_mixed_line_endings_to_the_majority() {
        let (_dir, file) = workspace_with("mixed.md", b"a\r\nb\r\nc\n");

        save_document(&file, "a\nb\nc\nd\n", None).expect("kaydet");

        let bytes = read_back(&file);
        assert_eq!(bytes, b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn a_line_ending_tie_becomes_lf() {
        let (_dir, file) = workspace_with("tie.md", b"a\r\nb\n");

        save_document(&file, "a\nb\n", None).expect("kaydet");

        assert_eq!(read_back(&file), b"a\nb\n");
    }

    #[test]
    fn a_new_file_defaults_to_lf_without_a_bom() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join("yeni.md");

        save_document(&file, "bir\r\niki\n", None).expect("kaydet");

        assert_eq!(read_back(&file), b"bir\niki\n");
    }

    #[test]
    fn matching_expected_hash_writes_and_returns_the_new_hash() {
        let (_dir, file) = workspace_with("note.md", b"eski\n");
        let expected = encoding::content_hash_hex(&read_back(&file));

        let saved = save_document(&file, "yeni\n", Some(&expected)).expect("kaydet");

        let bytes = read_back(&file);
        assert_eq!(bytes, b"yeni\n");
        assert_eq!(saved.result.hash, encoding::content_hash_hex(&bytes));
        assert_ne!(saved.result.hash, expected);
    }

    #[test]
    fn mismatched_expected_hash_refuses_and_leaves_the_file_untouched() {
        let (_dir, file) = workspace_with("note.md", b"diskteki\n");

        let error = save_document(&file, "benimki\n", Some("0000000000000000")).unwrap_err();

        assert_eq!(error.code(), crate::error::AppErrorCode::ConflictDetected);
        assert_eq!(read_back(&file), b"diskteki\n");
    }

    #[test]
    fn expected_hash_for_a_missing_file_is_a_conflict() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join("silinmis.md");
        let expected = encoding::content_hash_hex(b"eskiden vardi\n");

        let error = save_document(&file, "içerik\n", Some(&expected)).unwrap_err();

        assert_eq!(error.code(), crate::error::AppErrorCode::ConflictDetected);
        assert!(!file.exists());
    }

    #[test]
    fn rejects_oversize_payloads_before_writing() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join("dev.md");
        let oversized = "a".repeat((MAX_DOCUMENT_BYTES as usize) + 1);

        let error = save_document(&file, &oversized, None).unwrap_err();

        assert_eq!(error.code(), crate::error::AppErrorCode::TooLarge);
        assert!(!file.exists(), "aşan içerik yazılmamalı");
    }

    #[test]
    fn rejects_encoding_that_grows_past_the_cap() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join("crlf-dev.md");
        // Pre-existing CRLF format makes encoding grow the payload: each LF
        // becomes CRLF, pushing the encoded bytes past MAX_DOCUMENT_BYTES.
        fs::write(&file, b"a\r\nb\r\n").expect("başlangıç");
        let payload = format!("{}\n\n", "a".repeat(MAX_DOCUMENT_BYTES as usize - 2));

        let error = save_document(&file, &payload, None).unwrap_err();

        assert_eq!(error.code(), crate::error::AppErrorCode::TooLarge);
    }

    #[test]
    fn bom_and_crlf_survive_a_read_edit_save_round_trip() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        let file = dir.path().join("gunluk.md");
        let mut original = UTF8_BOM.to_vec();
        original.extend_from_slice(b"# Baslik\r\n\r\nilk satir\r\n");
        fs::write(&file, original).expect("başlangıç");

        let document = crate::fs::read::read_workspace_document(dir.path(), "gunluk.md")
            .expect("okuma başarılı");
        assert_eq!(document.contents, "# Baslik\r\n\r\nilk satir\r\n");
        assert!(
            !document.contents.starts_with('\u{feff}'),
            "BOM metne sızmamalı"
        );

        let edited = format!("{}ikinci satir\n", document.contents);
        let saved = write_workspace_file(dir.path(), "gunluk.md", &edited).expect("kaydet");

        let bytes = read_back(&file);
        assert!(bytes.starts_with(&UTF8_BOM), "BOM geri yazılmalı");
        assert_eq!(
            &bytes[UTF8_BOM.len()..],
            b"# Baslik\r\n\r\nilk satir\r\nikinci satir\r\n"
        );
        assert_eq!(saved.hash, encoding::content_hash_hex(&bytes));

        let reloaded = crate::fs::read::read_workspace_document(dir.path(), "gunluk.md")
            .expect("yeniden okuma");
        assert_eq!(
            reloaded.contents,
            "# Baslik\r\n\r\nilk satir\r\nikinci satir\r\n"
        );
        assert_eq!(reloaded.hash, saved.hash, "round-trip hash'i korunmalı");
    }

    #[test]
    fn write_workspace_file_round_trips_the_content() {
        let dir = TempDir::new().expect("geçici çalışma alanı");
        fs::write(dir.path().join("notlar.md"), UTF8_BOM).expect("başlangıç");

        let saved = write_workspace_file(dir.path(), "notlar.md", "# başlık\r\n").expect("kaydet");

        let bytes = read_back(&dir.path().join("notlar.md"));
        let mut expected = UTF8_BOM.to_vec();
        expected.extend_from_slice("# başlık\n".as_bytes());
        assert_eq!(bytes, expected);
        assert_eq!(saved.hash, encoding::content_hash_hex(&bytes));
    }
}
