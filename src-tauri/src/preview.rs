//! `mdasset` custom protocol: workspace-relative images for the live preview.
//!
//! The webview may only ask for a path relative to the open workspace. The
//! request goes through [`WorkspaceState::resolve`], so `..`, absolute paths
//! and junctions outside the root are rejected exactly like every other
//! filesystem access. Only image extensions are served; the response is marked
//! `nosniff` and never cached.

use std::fs;
use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

use crate::fs::read::read_bounded;
use crate::workspace::WorkspaceState;

/// URI scheme registered on the Tauri builder.
pub const SCHEME: &str = "mdasset";

/// Largest image served to the preview (16 MiB).
pub const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;

/// Handle one `mdasset://` request.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some(relative) = decode_request_path(request.uri().path()) else {
        return error_response(StatusCode::BAD_REQUEST);
    };
    let Some(content_type) = image_content_type(&relative) else {
        return error_response(StatusCode::NOT_FOUND);
    };

    let workspace = ctx.app_handle().state::<WorkspaceState>();
    let Ok(absolute) = workspace.resolve(&relative) else {
        return error_response(StatusCode::NOT_FOUND);
    };
    serve_file(&absolute, content_type)
}

fn serve_file(path: &Path, content_type: &'static str) -> Response<Vec<u8>> {
    let Ok(metadata) = fs::metadata(path) else {
        return error_response(StatusCode::NOT_FOUND);
    };
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return error_response(StatusCode::NOT_FOUND);
    }
    // The read is capped so a file that grows between the metadata check and
    // the read can never be served (or allocated) past the size limit.
    let bytes = match read_bounded(path, MAX_IMAGE_BYTES) {
        Ok(bytes) if bytes.len() as u64 <= MAX_IMAGE_BYTES => bytes,
        _ => return error_response(StatusCode::NOT_FOUND),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(bytes)
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Extract a workspace-relative path from the request URI path.
///
/// Returns `None` for empty paths, absolute paths and anything carrying a
/// colon (drive letter or URL-shaped input). Percent escapes are decoded
/// before the workspace confinement check.
pub fn decode_request_path(raw_path: &str) -> Option<String> {
    // A leading `//` is a protocol-relative target, not a workspace path.
    if raw_path.starts_with("//") {
        return None;
    }
    let trimmed = raw_path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let decoded = percent_decode_str(trimmed).decode_utf8().ok()?;
    let normalized = decoded.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    Some(normalized)
}

/// Content type for a preview image, or `None` if the extension is not served.
pub fn image_content_type(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn decodes_percent_escaped_relative_paths() {
        assert_eq!(
            decode_request_path("/notlar/g%C3%B6rsel%20bir.png"),
            Some("notlar/görsel bir.png".to_string())
        );
        assert_eq!(
            decode_request_path("/resimler%5Calt%5Ca.png"),
            Some("resimler/alt/a.png".to_string())
        );
    }

    #[test]
    fn rejects_empty_absolute_and_scheme_like_paths() {
        assert_eq!(decode_request_path("/"), None);
        assert_eq!(decode_request_path(""), None);
        assert_eq!(decode_request_path("//sunucu/a.png"), None);
        assert_eq!(decode_request_path("/C:/Windows/a.png"), None);
        assert_eq!(decode_request_path("/https://example.com/a.png"), None);
        assert_eq!(decode_request_path("/%FF.png"), None);
    }

    #[test]
    fn percent_encoded_traversal_is_stopped_by_the_workspace_gate() {
        // `decode_request_path` only decodes; the `..` sequence is neutralised
        // by `WorkspaceState::resolve`, so the composed request must be refused
        // with a typed escape error rather than reaching the file.
        let dir = tempfile::tempdir().expect("temporary directory");
        let state = WorkspaceState::new();
        state.open(dir.path()).expect("open workspace");
        std::fs::write(dir.path().join("secret.png"), [0x89, b'P', b'N', b'G'])
            .expect("write file");

        for raw in ["/..%2fsecret.png", "/%2e%2e/secret.png", "/notes/%2e%2e/%2e%2e/secret.png"] {
            let relative = decode_request_path(raw).expect("decoder yields a relative path");
            let error = state.resolve(&relative).expect_err("traversal must be rejected");
            assert_eq!(
                error.code,
                crate::workspace::PATH_OUTSIDE_WORKSPACE,
                "{raw} -> {relative}"
            );
        }
    }

    #[test]
    fn serves_only_image_extensions() {
        assert_eq!(image_content_type("a/b/resim.PNG"), Some("image/png"));
        assert_eq!(image_content_type("a/foto.jpeg"), Some("image/jpeg"));
        assert_eq!(image_content_type("a/vektor.svg"), Some("image/svg+xml"));
        assert_eq!(image_content_type("a/not.html"), None);
        assert_eq!(image_content_type("a/betik.js"), None);
        assert_eq!(image_content_type("a/uzantisiz"), None);
    }

    #[test]
    fn serves_image_bytes_with_safe_headers() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let image = dir.path().join("resim.png");
        let mut handle = fs::File::create(&image).expect("create image");
        handle.write_all(&[0x89, b'P', b'N', b'G']).expect("write");

        let response = serve_file(&image, "image/png");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        assert_eq!(response.body(), &[0x89, b'P', b'N', b'G']);
    }

    #[test]
    fn refuses_missing_directories_and_oversized_files() {
        let dir = tempfile::tempdir().expect("temporary directory");

        let missing = serve_file(&dir.path().join("yok.png"), "image/png");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let directory = serve_file(dir.path(), "image/png");
        assert_eq!(directory.status(), StatusCode::NOT_FOUND);

        let oversized = dir.path().join("buyuk.png");
        let file = fs::File::create(&oversized).expect("create oversized");
        file.set_len(MAX_IMAGE_BYTES + 1).expect("sparse file");
        let response = serve_file(&oversized, "image/png");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
