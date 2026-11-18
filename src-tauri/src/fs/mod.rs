//! Filesystem primitives.
//!
//! [`atomic`] is the only place writes to user documents happen: it guarantees
//! that a save either fully replaces the target or leaves it untouched.
//!
//! Read/listing/index commands share the workspace confinement gate
//! ([`crate::workspace`]) and expose typed errors; none of them accepts an
//! absolute path from the webview.

pub mod atomic;
pub mod encoding;
pub mod index;
pub mod list;
pub mod metadata;
pub mod read;
pub mod write;

pub use atomic::{atomic_write, atomic_write_with_policy, AtomicWriteError, RetryPolicy};
pub use encoding::{detect_format, encode, LineEnding, TextFormat};
pub use index::{
    fs_index, index_in_root, IndexEntry, IndexLimits, IndexResult, MAX_INDEX_DEPTH,
    MAX_INDEX_ENTRIES, MAX_INDEX_FILE_BYTES,
};
pub use list::{fs_list_dir, list_dir_in_root, DirEntryInfo};
pub use metadata::{fs_metadata, metadata_in_root, FileMetadata};
pub use read::{
    decode_text, fs_read_document, fs_read_file, read_workspace_document, read_workspace_file,
    DocumentText, MAX_DOCUMENT_BYTES, UTF8_BOM,
};
pub use write::{fs_write_file_atomic, write_workspace_file, SaveResult};
