//! Read/write round trip of the on-disk text format.
//!
//! The editor works on decoded text. Saving must restore the UTF-8 BOM and the
//! dominant line ending of the original file, so an untouched document is
//! byte-stable across a read -> edit -> save cycle.

use std::fs;
use std::path::Path;

use md_editor_lib::fs::encoding::{content_hash_hex, detect_format, dominant_line_ending};
use md_editor_lib::fs::read::{read_workspace_document, UTF8_BOM};
use md_editor_lib::fs::write::write_workspace_file;
use tempfile::TempDir;

fn root_of(dir: &TempDir) -> std::path::PathBuf {
    fs::canonicalize(dir.path()).expect("canonical root")
}

fn read_back(path: &Path) -> Vec<u8> {
    fs::read(path).expect("file must exist")
}

#[test]
fn bom_and_crlf_survive_a_read_edit_save_round_trip() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("gunluk.md");

    let mut original = UTF8_BOM.to_vec();
    original.extend_from_slice(b"# Baslik\r\n\r\nilk satir\r\n");
    fs::write(&file, &original).expect("seed document");

    let document = read_workspace_document(&root, "gunluk.md").expect("read");
    assert_eq!(document.contents, "# Baslik\r\n\r\nilk satir\r\n");
    assert!(
        !document.contents.starts_with('\u{feff}'),
        "the BOM is metadata and must never reach the editor buffer"
    );
    assert_eq!(
        document.hash,
        content_hash_hex(&original),
        "the hash must describe the raw on-disk bytes"
    );

    // The editor always hands LF-only text back.
    let edited = format!("{}ikinci satir\n", document.contents);
    let saved = write_workspace_file(&root, "gunluk.md", &edited).expect("save");

    let bytes = read_back(&file);
    assert!(bytes.starts_with(&UTF8_BOM), "the BOM must be restored");
    assert_eq!(
        &bytes[UTF8_BOM.len()..],
        b"# Baslik\r\n\r\nilk satir\r\nikinci satir\r\n".as_slice()
    );
    assert_eq!(saved.hash, content_hash_hex(&bytes));

    let reloaded = read_workspace_document(&root, "gunluk.md").expect("re-read");
    assert_eq!(
        reloaded.contents,
        "# Baslik\r\n\r\nilk satir\r\nikinci satir\r\n"
    );
    assert_eq!(reloaded.hash, saved.hash, "round trip must be byte-stable");
}

#[test]
fn a_bomless_lf_document_stays_bomless_and_lf() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("duz.md");
    fs::write(&file, b"a\nb\n").expect("seed document");

    write_workspace_file(&root, "duz.md", "a\nb\nc\n").expect("save");

    let bytes = read_back(&file);
    assert!(!bytes.starts_with(&UTF8_BOM), "no BOM may be added");
    assert_eq!(bytes, b"a\nb\nc\n");
}

#[test]
fn a_mixed_document_is_normalised_to_its_majority_ending() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("karisik.md");
    fs::write(&file, b"a\r\nb\r\nc\n").expect("seed document");

    write_workspace_file(&root, "karisik.md", "a\nb\nc\nd\n").expect("save");

    assert_eq!(read_back(&file), b"a\r\nb\r\nc\r\nd\r\n");
}

#[test]
fn a_line_ending_tie_resolves_to_lf() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("berabere.md");
    fs::write(&file, b"a\r\nb\n").expect("seed document");

    write_workspace_file(&root, "berabere.md", "a\nb\n").expect("save");

    assert_eq!(read_back(&file), b"a\nb\n");
}

#[test]
fn a_new_file_defaults_to_lf_without_a_bom() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);

    // The editor may send CRLF even for a new document; the on-disk default
    // for a file with no previous format is LF without a BOM.
    write_workspace_file(&root, "yeni.md", "bir\r\niki\n").expect("save");

    assert_eq!(read_back(&root.join("yeni.md")), b"bir\niki\n");
}

#[test]
fn detection_and_encoding_are_inverses_for_canonical_documents() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);

    for (name, seed) in [
        ("bom-crlf.md", {
            let mut bytes = UTF8_BOM.to_vec();
            bytes.extend_from_slice(b"bir\r\niki\r\n");
            bytes
        }),
        ("crlf.md", b"bir\r\niki\r\n".to_vec()),
        ("lf.md", b"bir\niki\n".to_vec()),
    ] {
        let file = root.join(name);
        fs::write(&file, &seed).expect("seed document");

        let format = detect_format(&seed);
        let edited = "bir\niki\nuc\n";
        write_workspace_file(&root, name, edited).expect("save");
        let saved = read_back(&file);

        assert_eq!(
            detect_format(&saved),
            format,
            "{name}: the format must be preserved"
        );
        assert_eq!(dominant_line_ending(&saved), format.line_ending, "{name}");
        assert_eq!(saved.starts_with(&UTF8_BOM), format.bom, "{name}");
    }
}

#[test]
fn saving_without_changes_reproduces_the_original_bytes() {
    let dir = TempDir::new().expect("temp dir");
    let root = root_of(&dir);
    let file = root.join("ayni.md");

    let mut original = UTF8_BOM.to_vec();
    original.extend_from_slice(b"# Baslik\r\n\r\nmetin\r\n");
    fs::write(&file, &original).expect("seed document");

    let document = read_workspace_document(&root, "ayni.md").expect("read");
    let saved = write_workspace_file(&root, "ayni.md", &document.contents).expect("save");

    assert_eq!(read_back(&file), original, "an unedited save is stable");
    assert_eq!(saved.hash, document.hash);
}
