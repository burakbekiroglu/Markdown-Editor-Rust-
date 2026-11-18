//! Encoding and line-ending preservation for document saves.
//!
//! The editor works on decoded text, so the bytes it receives back on save no
//! longer carry the on-disk encoding details. This module recovers them:
//!
//! * a leading UTF-8 BOM is remembered and written back only when the original
//!   file had one;
//! * the dominant line ending is detected (CRLF vs LF) and re-applied, so a
//!   CRLF document stays CRLF and a LF document gets no stray `\r`;
//! * mixed files are normalised to whichever ending is in the majority; a tie
//!   resolves to LF, the editor's native ending.
//!
//! [`detect_format`] describes existing bytes and [`encode`] produces the
//! bytes for the same format. The two are inverses for any canonical input,
//! which is what makes a read → edit → save round trip byte-stable.

use serde::Serialize;

use super::read::UTF8_BOM;

/// Dominant line ending of a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    /// `\n` only; the default for a new file and the tie-breaker.
    #[default]
    Lf,
    /// `\r\n`, the Windows convention.
    Crlf,
}

impl LineEnding {
    /// The bytes this ending writes for one line break.
    const fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::Crlf => "\r\n",
        }
    }
}

/// Byte-level description of a document's original format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    /// Whether the file started with a UTF-8 BOM.
    pub bom: bool,
    /// Line ending to write back.
    pub line_ending: LineEnding,
}

/// Describes the raw bytes of an existing document.
pub fn detect_format(bytes: &[u8]) -> TextFormat {
    TextFormat {
        bom: bytes.starts_with(&UTF8_BOM),
        line_ending: dominant_line_ending(bytes),
    }
}

/// Counts CRLF pairs against bare LF bytes and returns the majority.
///
/// A lone `\r` is not a line ending on any platform this editor targets and is
/// left to [`encode`] to normalise. Ties resolve to [`LineEnding::Lf`].
pub fn dominant_line_ending(bytes: &[u8]) -> LineEnding {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => {
                crlf += 1;
                index += 2;
            }
            b'\n' => {
                lf += 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

/// Encodes `text` for `format`: normalises every line break to the detected
/// ending and prepends the UTF-8 BOM when the original file had one.
///
/// `\r\n`, `\n` and a bare `\r` in the input all count as one line break, so
/// the result is canonical regardless of what the editor sends.
pub fn encode(text: &str, format: TextFormat) -> Vec<u8> {
    let ending = format.line_ending.as_str();
    // Worst case one extra byte per line break for CRLF; a small over-reserve
    // avoids repeated growth on large documents.
    let mut out = Vec::with_capacity(text.len() + text.len() / 16 + if format.bom { 3 } else { 0 });
    if format.bom {
        out.extend_from_slice(&UTF8_BOM);
    }

    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                // Collapse a CRLF pair into a single break.
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.extend_from_slice(ending.as_bytes());
            }
            '\n' => out.extend_from_slice(ending.as_bytes()),
            other => {
                let mut buffer = [0u8; 4];
                out.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out
}

/// Stable content hash of raw bytes as a lowercase hex string.
///
/// Reuses the watcher's deterministic hash so the value returned after a save
/// is exactly the one recorded in the self-write registry, which is what keeps
/// a save from being echoed back as an external change.
pub fn content_hash_hex(bytes: &[u8]) -> String {
    format!("{:016x}", crate::watcher::content_hash(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRLF: TextFormat = TextFormat {
        bom: false,
        line_ending: LineEnding::Crlf,
    };

    const LF: TextFormat = TextFormat {
        bom: false,
        line_ending: LineEnding::Lf,
    };

    #[test]
    fn detects_a_utf8_bom() {
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(b"baslik\r\n");
        let format = detect_format(&bytes);
        assert!(format.bom);
        assert_eq!(format.line_ending, LineEnding::Crlf);
    }

    #[test]
    fn detects_the_dominant_ending() {
        assert_eq!(dominant_line_ending(b"a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(dominant_line_ending(b"a\nb\nc\r\n"), LineEnding::Lf);
    }

    #[test]
    fn a_tie_resolves_to_lf() {
        assert_eq!(dominant_line_ending(b"a\r\nb\n"), LineEnding::Lf);
        assert_eq!(dominant_line_ending(b""), LineEnding::Lf);
    }

    #[test]
    fn writes_crlf_and_bom_verbatim() {
        let format = TextFormat {
            bom: true,
            line_ending: LineEnding::Crlf,
        };
        let bytes = encode("a\nb\r\nc", format);
        assert!(bytes.starts_with(&UTF8_BOM));
        assert_eq!(&bytes[UTF8_BOM.len()..], b"a\r\nb\r\nc");
    }

    #[test]
    fn writes_lf_without_a_bom() {
        let bytes = encode("a\r\nb\rc\n", LF);
        assert_eq!(bytes, b"a\nb\nc\n");
        assert!(!bytes.starts_with(&UTF8_BOM));
    }

    #[test]
    fn encoding_then_detection_round_trips_the_format() {
        for format in [
            CRLF,
            LF,
            TextFormat {
                bom: true,
                line_ending: LineEnding::Crlf,
            },
        ] {
            let bytes = encode("bir\r\niki\nüç", format);
            assert_eq!(detect_format(&bytes), format);
        }
    }

    #[test]
    fn hash_is_stable_and_content_sensitive() {
        assert_eq!(content_hash_hex(b"abc"), content_hash_hex(b"abc"));
        assert_ne!(content_hash_hex(b"abc"), content_hash_hex(b"abd"));
        assert_eq!(content_hash_hex(b"abc").len(), 16);
    }
}
