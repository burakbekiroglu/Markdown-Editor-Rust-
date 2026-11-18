//! Webview security policy.
//!
//! The main window is created in Rust (not from `tauri.conf.json`) so that the
//! navigation allow-list and the `window.open` denial can be attached to the
//! webview itself. Everything here is pure so the policy can be unit-tested
//! without a Tauri runtime.

use tauri::Url;

/// Label of the single application window.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Port of the Vite dev server declared as `build.devUrl` in `tauri.conf.json`.
pub const DEV_SERVER_PORT: u16 = 1420;

/// Host used by the Tauri custom protocol on Windows.
pub const WINDOWS_APP_HOST: &str = "tauri.localhost";

/// Decide whether the main webview may navigate to `url`.
///
/// Only the app's own origin is permitted:
///
/// * `tauri://localhost` - custom protocol origin on macOS and Linux;
/// * `http://tauri.localhost` - custom protocol origin on Windows;
/// * `http://localhost:1420` - the Vite dev server, debug builds only.
///
/// Every other target is refused: remote pages, other ports, `file:`, `data:`,
/// `javascript:`, `blob:` and unknown schemes.
pub fn is_allowed_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => {
            url.host_str() == Some("localhost")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        }
        "http" | "https" => {
            let Some(host) = url.host_str() else {
                return false;
            };
            if host.eq_ignore_ascii_case(WINDOWS_APP_HOST) {
                return url.port().is_none()
                    && url.username().is_empty()
                    && url.password().is_none();
            }
            url.scheme() == "http"
                && cfg!(debug_assertions)
                && host.eq_ignore_ascii_case("localhost")
                && url.port() == Some(DEV_SERVER_PORT)
                && url.username().is_empty()
                && url.password().is_none()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(raw: &str) -> bool {
        is_allowed_navigation(&Url::parse(raw).expect(raw))
    }

    #[test]
    fn allows_the_application_origins() {
        assert!(allowed("tauri://localhost"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost"));
        assert!(allowed("https://tauri.localhost"));
        assert!(allowed("http://tauri.localhost/index.html"));
        // The dev server is reachable in debug builds (tests always run in debug).
        assert!(allowed("http://localhost:1420"));
        assert!(allowed("http://localhost:1420/index.html"));
    }

    #[test]
    fn blocks_remote_and_lookalike_hosts() {
        for raw in [
            "https://example.com",
            "https://tauri.localhost.evil.com",
            "http://tauri.localhost.evil.com/",
            "https://localhost:1420",
            "http://localhost:1421",
            "http://localhost",
            "http://127.0.0.1:1420",
            "http://user:pass@tauri.localhost",
            "http://tauri.localhost:8080",
            "https://localhost:1420/path",
        ] {
            assert!(!allowed(raw), "{raw} must not be navigable");
        }
    }

    #[test]
    fn blocks_non_web_schemes() {
        for raw in [
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<h1>hi</h1>",
            "javascript:alert(1)",
            "blob:http://tauri.localhost/1234",
            "asset://localhost/secret.png",
            "ftp://example.com/file",
        ] {
            assert!(!allowed(raw), "{raw} must not be navigable");
        }
    }
}
