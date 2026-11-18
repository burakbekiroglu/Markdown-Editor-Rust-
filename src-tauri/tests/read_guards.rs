//! Guards that stop a load from handing the editor a document it must not
//! save back: oversize files, binary content and non-UTF-8 encodings.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_lib::error::AppErrorCode;
use md_editor_lib::fs::read::{
    decode_text, read_workspace_document, read_workspace_file, MAX_DOCUMENT_BYTES, UTF8_BOM,
};
use tempfile::TempDir;

fn root_of(dir: &TempDir) -> PathBuf {
    fs::canonicalize(dir.path()).expect("canonical root")
}

fn write(root: &Path, name: &str, bytes: &[u8]) {
    fs::write(root.join(name), bytes).expect("fixture write");
}

#[test]
fn rejects_a_document_above_the_size_limit_instead_of_truncating_it() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("buyuk.md");
    let handle = fs::File::create(&file).expect("create");
    handle.set_len(MAX_DOCUMENT_BYTES + 1).expect("set length");
    drop(handle);

    let error = read_workspace_file(&root, "buyuk.md").expect_err("too large");
    assert_eq!(error.code(), AppErrorCode::TooLarge);

    let error = read_workspace_document(&root, "buyuk.md").expect_err("too large");
    assert_eq!(error.code(), AppErrorCode::TooLarge);
}

#[test]
fn a_file_exactly_at_the_limit_is_not_rejected_for_size() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("sinir.md");
    let handle = fs::File::create(&file).expect("create");
    handle.set_len(MAX_DOCUMENT_BYTES).expect("set length");
    drop(handle);

    // The sparse file reads back as zeros, so it is binary, but the size gate
    // must not be what rejects it.
    let error = read_workspace_file(&root, "sinir.md").expect_err("sparse zeros");
    assert_ne!(error.code(), AppErrorCode::TooLarge);
    assert_eq!(error.code(), AppErrorCode::BinaryFile);
}

#[test]
fn rejects_nul_bytes_and_control_heavy_payloads_as_binary() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    write(&root, "nul.bin", b"metin\0ikili");
    write(&root, "kontrol.bin", &[0x01u8; 64]);

    for name in ["nul.bin", "kontrol.bin"] {
        let error = read_workspace_file(&root, name).expect_err("binary payload");
        assert_eq!(error.code(), AppErrorCode::BinaryFile, "{name}");
    }
}

#[test]
fn rejects_utf16_and_utf32_documents_as_binary() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    write(&root, "utf16.md", &[0xFF, 0xFE, b'a', 0]);
    write(&root, "utf32.md", &[0xFF, 0xFE, 0x00, 0x00, b'a', 0, 0, 0]);

    for name in ["utf16.md", "utf32.md"] {
        let error = read_workspace_file(&root, name).expect_err("non-UTF-8 encoding");
        assert_eq!(error.code(), AppErrorCode::BinaryFile, "{name}");
    }
}

#[test]
fn rejects_invalid_utf8_as_binary() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    write(&root, "bozuk.md", &[0x61, 0xC3, 0x28, 0x62]);

    let error = read_workspace_file(&root, "bozuk.md").expect_err("invalid UTF-8");
    assert_eq!(error.code(), AppErrorCode::BinaryFile);
}

#[test]
fn strips_the_utf8_bom_and_preserves_crlf_in_the_buffer() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let mut bytes = UTF8_BOM.to_vec();
    bytes.extend_from_slice(b"# Baslik\r\nmetin\r\n");
    write(&root, "bom.md", &bytes);

    let document = read_workspace_document(&root, "bom.md").expect("read");
    assert_eq!(document.contents, "# Baslik\r\nmetin\r\n");
    assert!(!document.contents.starts_with('\u{feff}'));
    assert_eq!(document.hash.len(), 16, "hash is a 16 hex character digest");
}

#[test]
fn decode_text_accepts_plain_utf8_and_rejects_a_bare_utf16_bom() {
    let path = PathBuf::from("bellek.md");
    assert_eq!(
        decode_text("duz metin".as_bytes().to_vec(), &path).expect("utf-8"),
        "duz metin"
    );

    let error = decode_text(vec![0xFE, 0xFF, 0x00, b'a'], &path).expect_err("utf-16 big endian");
    assert_eq!(error.code(), AppErrorCode::BinaryFile);
}

#[test]
fn missing_files_are_reported_as_not_found() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);

    let error = read_workspace_file(&root, "yok.md").expect_err("missing");
    assert_eq!(error.code(), AppErrorCode::NotFound);
}
