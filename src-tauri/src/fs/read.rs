//! Tauri command boundary for loading a workspace document.
//!
//! Reads are confined to the open workspace exactly like writes. Callers
//! receive either the complete text or a typed rejection, never a partial
//! document:
//!
//! * files above [`MAX_DOCUMENT_BYTES`] fail with `TooLarge` instead of being
//!   truncated, because a truncated buffer must never be saved back over the
//!   original; the `truncated` flag lives on the index/listing commands where
//!   dropping entries is safe;
//! * a UTF-8 BOM is stripped so the editor does not show a stray `\u{feff}`;
//! * UTF-16/UTF-32 BOMs, NUL bytes, and control-character-heavy payloads are
//!   classified as binary and rejected with `BinaryFile`;
//! * invalid UTF-8 is rejected with `OpenUnsupported` rather than decoded
//!   lossily.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::workspace::WorkspaceState;

use super::encoding;

/// Largest document the editor will load (5 MiB).
pub const MAX_DOCUMENT_BYTES: u64 = 5 * 1024 * 1024;

/// UTF-8 byte-order mark, stripped from loaded documents.
pub const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// How many leading bytes are inspected for binary content.
const BINARY_SNIFF_BYTES: usize = 8192;

/// One in ten control characters is already implausible in Markdown.
const CONTROL_CHAR_LIMIT: usize = 10;

/// Read `relative_path` from `root` as UTF-8 text.
///
/// Kept free of Tauri types so the read path can be exercised directly.
pub fn read_workspace_file(root: &Path, relative_path: &str) -> AppResult<String> {
    let workspace = WorkspaceState::new();
    workspace.open(root)?;
    let absolute = workspace.resolve(relative_path)?;
    read_text_file(&absolute)
}

/// A document together with the hash of its exact on-disk bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    /// Decoded text: BOM stripped, binary and oversize inputs rejected.
    pub contents: String,
    /// Hash of the raw bytes, to be passed back as `expectedHash` on save.
    pub hash: String,
}

/// Read `relative_path` from `root` as text plus its content hash.
pub fn read_workspace_document(root: &Path, relative_path: &str) -> AppResult<DocumentText> {
    let workspace = WorkspaceState::new();
    workspace.open(root)?;
    let absolute = workspace.resolve(relative_path)?;
    read_document_file(&absolute)
}

/// Load a document. A failure leaves the caller's editor contents untouched;
/// the typed error is shown next to the tab instead of an empty buffer.
#[tauri::command]
pub fn fs_read_file(path: String, workspace: State<'_, WorkspaceState>) -> AppResult<String> {
    let absolute = workspace.resolve(&path)?;
    read_text_file(&absolute)
}

/// Load a document with the content hash needed for optimistic save conflict
/// detection. Otherwise behaves exactly like [`fs_read_file`].
#[tauri::command]
pub fn fs_read_document(
    path: String,
    workspace: State<'_, WorkspaceState>,
) -> AppResult<DocumentText> {
    let absolute = workspace.resolve(&path)?;
    read_document_file(&absolute)
}

fn read_text_file(absolute: &Path) -> AppResult<String> {
    let bytes = read_bytes(absolute)?;
    decode_text(bytes, absolute)
}

fn read_document_file(absolute: &Path) -> AppResult<DocumentText> {
    let bytes = read_bytes(absolute)?;
    let hash = encoding::content_hash_hex(&bytes);
    let contents = decode_text(bytes, absolute)?;
    Ok(DocumentText { contents, hash })
}

fn read_bytes(absolute: &Path) -> AppResult<Vec<u8>> {
    let metadata = fs::metadata(absolute).map_err(|error| io_error(absolute, &error))?;
    if !metadata.is_file() {
        return Err(AppError::invalid_path(format!(
            "{} bir dosya değil",
            absolute.display()
        )));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::too_large(format!(
            "{}: {} bayt (sınır {} bayt)",
            absolute.display(),
            metadata.len(),
            MAX_DOCUMENT_BYTES
        )));
    }

    // The metadata check and the read are not atomic: a file can grow between
    // the two, so the read itself is capped and an oversize result is still
    // rejected instead of being allocated in full.
    let bytes =
        read_bounded(absolute, MAX_DOCUMENT_BYTES).map_err(|error| io_error(absolute, &error))?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(AppError::too_large(format!(
            "{}: sınırı ({MAX_DOCUMENT_BYTES} bayt) aştı",
            absolute.display()
        )));
    }
    Ok(bytes)
}

/// Read at most `max + 1` bytes of `path`.
///
/// The extra byte exists only to distinguish an exactly-`max` file from one
/// that grew past the cap; it is never returned to callers that compare
/// against `max`. Bounds the allocation even when a racing writer grows the
/// file between a metadata check and this read.
pub fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>, std::io::Error> {
    use std::io::Read;

    let mut file = fs::File::open(path)?;
    let mut buffer = Vec::new();
    (&mut file).take(max + 1).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Decode document bytes, handling BOMs and binary sniffing.
///
/// Exposed for tests; the command path always reads from disk first.
pub fn decode_text(bytes: Vec<u8>, absolute: &Path) -> AppResult<String> {
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
    {
        return Err(AppError::binary_file(format!(
            "{} UTF-32 kodlamalı; düzenleyici UTF-8 bekliyor",
            absolute.display()
        )));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::binary_file(format!(
            "{} UTF-16 kodlamalı; düzenleyici UTF-8 bekliyor",
            absolute.display()
        )));
    }

    // A UTF-8 BOM is metadata, not content: strip it before decoding so the
    // first character of the document is what the user typed.
    let bytes = match bytes.strip_prefix(&UTF8_BOM) {
        Some(stripped) => stripped.to_vec(),
        None => bytes,
    };

    if looks_binary(&bytes) {
        return Err(AppError::binary_file(format!(
            "{} ikili veri içeriyor",
            absolute.display()
        )));
    }

    String::from_utf8(bytes).map_err(|_| {
        AppError::open_unsupported(format!("{} geçerli UTF-8 metin değil", absolute.display()))
    })
}

/// Cheap binary sniff: NUL bytes or a control-character density no text file
/// reaches. Tab, newline, carriage return and form feed are legitimate text.
fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if sample.contains(&0) {
        return true;
    }
    let controls = sample
        .iter()
        .filter(|byte| {
            matches!(**byte, 0x00..=0x08 | 0x0B | 0x0E..=0x1F | 0x7F)
        })
        .count();
    controls * CONTROL_CHAR_LIMIT > sample.len()
}

fn io_error(path: &Path, error: &std::io::Error) -> AppError {
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
    use std::io::Write;

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().expect("geçici dizin")
    }

    #[test]
    fn reads_utf8_text_inside_the_workspace() {
        let dir = scratch();
        let file = dir.path().join("notlar.md");
        let mut handle = fs::File::create(&file).expect("dosya oluştur");
        handle.write_all("başlık\r\nsatır".as_bytes()).expect("yaz");

        let contents = read_workspace_file(dir.path(), "notlar.md").expect("okuma başarılı");

        assert_eq!(contents, "başlık\r\nsatır");
    }

    #[test]
    fn strips_a_utf8_bom() {
        let dir = scratch();
        let file = dir.path().join("bom.md");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice("başlık".as_bytes());
        fs::write(&file, bytes).expect("yaz");

        let contents = read_workspace_file(dir.path(), "bom.md").expect("okuma başarılı");

        assert_eq!(contents, "başlık");
    }

    #[test]
    fn rejects_utf16_and_utf32_documents_as_binary() {
        let dir = scratch();
        fs::write(dir.path().join("utf16.md"), [0xFF, 0xFE, b'a', 0]).expect("yaz");
        fs::write(
            dir.path().join("utf32.md"),
            [0xFF, 0xFE, 0x00, 0x00, b'a', 0, 0, 0],
        )
        .expect("yaz");

        for name in ["utf16.md", "utf32.md"] {
            let error = read_workspace_file(dir.path(), name).expect_err("ikili reddedilmeli");
            assert_eq!(error.code(), crate::error::AppErrorCode::BinaryFile, "{name}");
        }
    }

    #[test]
    fn rejects_nul_bytes_as_binary() {
        let dir = scratch();
        fs::write(dir.path().join("ikili.bin"), b"metin\0ikili").expect("yaz");

        let error = read_workspace_file(dir.path(), "ikili.bin").expect_err("ikili reddedilmeli");

        assert_eq!(error.code(), crate::error::AppErrorCode::BinaryFile);
    }

    #[test]
    fn rejects_control_character_heavy_payloads_as_binary() {
        let dir = scratch();
        fs::write(dir.path().join("kontrol.bin"), vec![0x01u8; 64]).expect("yaz");

        let error = read_workspace_file(dir.path(), "kontrol.bin").expect_err("ikili reddedilmeli");

        assert_eq!(error.code(), crate::error::AppErrorCode::BinaryFile);
    }

    #[test]
    fn rejects_files_outside_the_workspace() {
        let dir = scratch();
        let error = read_workspace_file(dir.path(), "../gizli.md").expect_err("yol reddedilmeli");

        assert_eq!(error.code(), crate::error::AppErrorCode::PathEscape);
    }

    #[test]
    fn rejects_invalid_utf8_as_unsupported() {
        let dir = scratch();
        fs::write(dir.path().join("ikili.md"), [0xC3, 0x28, 0xE2]).expect("yaz");

        let error = read_workspace_file(dir.path(), "ikili.md").expect_err("geçersiz UTF-8");

        assert_eq!(error.code(), crate::error::AppErrorCode::OpenUnsupported);
    }

    #[test]
    fn rejects_documents_above_the_size_limit() {
        let dir = scratch();
        let file = dir.path().join("buyuk.md");
        let handle = fs::File::create(&file).expect("dosya oluştur");
        handle
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .expect("boyut ayarla");

        let error = read_workspace_file(dir.path(), "buyuk.md").expect_err("çok büyük");

        assert_eq!(error.code(), crate::error::AppErrorCode::TooLarge);
    }

    #[test]
    fn bounded_read_returns_at_most_cap_plus_one_byte() {
        let dir = scratch();
        fs::write(dir.path().join("buyuk.bin"), vec![0x41u8; 64]).expect("yaz");

        let bytes = read_bounded(&dir.path().join("buyuk.bin"), 16).expect("okuma başarılı");

        assert_eq!(bytes.len(), 17, "sınır + 1 bayt okunmalı");
    }

    #[test]
    fn reports_missing_files_as_not_found() {
        let dir = scratch();
        let error = read_workspace_file(dir.path(), "yok.md").expect_err("eksik dosya");

        assert_eq!(error.code(), crate::error::AppErrorCode::NotFound);
    }
}
