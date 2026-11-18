//! Windows preflight checks that run before Tauri and WebView2 start.
//!
//! The app renders through the WebView2 Evergreen Runtime, and the window
//! stack it sits on requires Windows 10 version 1809 (build 17763) or newer.
//! When either precondition is missing there is no UI to report the problem
//! with, so this module raises a native message box and returns a stable exit
//! code instead:
//!
//! * [`EXIT_UNSUPPORTED_WINDOWS`] — the OS build predates Windows 10 1809.
//! * [`EXIT_WEBVIEW2_MISSING`] — the Evergreen Runtime is not installed.
//!
//! Runtime detection asks the WebView2 loader first (`webview2-com`) and falls
//! back to the EdgeUpdate registry keys the Evergreen installer writes, which
//! also covers installs where the loader cannot answer. A missing runtime is
//! reported with the path of the offline bootstrapper next to the executable
//! when one is shipped, and the user is offered to run it.

use std::path::{Path, PathBuf};
use std::process::Command;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_YESNO,
    MESSAGEBOX_RESULT, MESSAGEBOX_STYLE,
};

/// Exit code returned when Windows is older than version 1809.
pub const EXIT_UNSUPPORTED_WINDOWS: i32 = 2;

/// Exit code returned when the WebView2 Evergreen Runtime is missing.
pub const EXIT_WEBVIEW2_MISSING: i32 = 3;

/// Oldest Windows 10 release that can host WebView2: version 1809.
pub const MIN_WINDOWS_BUILD: u32 = 17763;

/// Offline bootstrapper shipped next to the executable, if the installer
/// bundle includes one. Used when the machine has no network access.
pub const OFFLINE_BOOTSTRAPPER: &str = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe";

/// Download page shown when no local bootstrapper is available.
pub const WEBVIEW2_DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// Title of every native message box; the app name the user launched.
const APP_NAME: &str = "Markdown Editor";

/// Holds `CurrentBuildNumber` on every release this check supports.
const WINDOWS_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

/// Name of the build number value inside [`WINDOWS_VERSION_KEY`].
const WINDOWS_BUILD_VALUE: &str = "CurrentBuildNumber";

/// Registry locations holding the installed Evergreen Runtime version (`pv`).
///
/// A machine-wide install registers under `WOW6432Node` on 64-bit Windows; a
/// per-user install lives in the current user's hive.
const WEBVIEW2_REGISTRY_KEYS: [(HKEY, &str); 3] = [
    (
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ),
    (
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ),
    (
        HKEY_CURRENT_USER,
        r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ),
];

/// The EdgeUpdate value that stores the runtime version.
const WEBVIEW2_VERSION_VALUE: &str = "pv";

/// Debug-only env var forcing the detected Windows build (`17134`, ...).
#[cfg(debug_assertions)]
const SIMULATE_BUILD_ENV: &str = "MD_EDITOR_SIMULATE_WINDOWS_BUILD";

/// Debug-only env var forcing the detected runtime version (`missing`, `0.0.0`).
#[cfg(debug_assertions)]
const SIMULATE_RUNTIME_ENV: &str = "MD_EDITOR_SIMULATE_WEBVIEW2";

/// Debug-only env var suppressing the message box for automated exit-code runs.
#[cfg(debug_assertions)]
const SIMULATE_SILENT_ENV: &str = "MD_EDITOR_SIMULATE_SILENT";

/// Outcome of the startup preconditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupCheck {
    /// The OS and the Evergreen Runtime are both usable.
    Ready,
    /// Windows predates version 1809.
    UnsupportedWindows { build: u32 },
    /// The Evergreen Runtime is not installed.
    MissingWebView2,
}

/// Decides the startup outcome from raw detection results.
///
/// Pure on purpose: the boundary cases (build 17763, the `0.0.0` marker) are
/// the ones that matter and they are exercised by unit tests. An unreadable
/// build number is not treated as an old OS — the check must never block a
/// machine whose registry we simply cannot read.
pub fn startup_check(os_build: Option<u32>, runtime_version: Option<&str>) -> StartupCheck {
    if let Some(build) = os_build {
        if build < MIN_WINDOWS_BUILD {
            return StartupCheck::UnsupportedWindows { build };
        }
    }

    match runtime_version {
        Some(version) if is_usable_runtime_version(version) => StartupCheck::Ready,
        _ => StartupCheck::MissingWebView2,
    }
}

/// Verifies the OS and WebView2 preconditions, reporting failures natively.
///
/// `Ok(())` means the app may start. `Err(code)` carries the process exit code
/// to use; by then the user has already been told what went wrong.
pub fn preflight() -> Result<(), i32> {
    let build = simulated_build().or_else(windows_build);
    let runtime = simulated_runtime().or_else(webview2_version);

    match startup_check(build, runtime.as_deref()) {
        StartupCheck::Ready => Ok(()),
        StartupCheck::UnsupportedWindows { build } => {
            if !simulation_silent() {
                show(&unsupported_windows_message(build), error_style());
            }
            Err(EXIT_UNSUPPORTED_WINDOWS)
        }
        StartupCheck::MissingWebView2 => {
            if !simulation_silent() {
                report_missing_webview2();
            }
            Err(EXIT_WEBVIEW2_MISSING)
        }
    }
}

/// Whether a detected runtime version is actually usable.
///
/// `0.0.0` / `0.0.0.0` is what the EdgeUpdate installer leaves behind when it
/// aborts, so it means "missing" despite being present in the registry.
fn is_usable_runtime_version(version: &str) -> bool {
    let version = version.trim();
    !version.is_empty()
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        && version
            .split('.')
            .any(|part| part.parse::<u32>().is_ok_and(|number| number > 0))
}

/// Debug-only override of the detected Windows build.
///
/// Keeps the "missing WebView2" / "old Windows" branches testable on a machine
/// that has neither condition; compiled out of release builds so the check
/// cannot be bypassed.
fn simulated_build() -> Option<u32> {
    #[cfg(debug_assertions)]
    {
        let raw = std::env::var(SIMULATE_BUILD_ENV).ok()?;
        parse_build_number(&raw)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// Debug-only override of the detected runtime version.
///
/// `missing` is accepted as a readable alias for the aborted-install marker.
fn simulated_runtime() -> Option<String> {
    #[cfg(debug_assertions)]
    {
        let raw = std::env::var(SIMULATE_RUNTIME_ENV).ok()?;
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        Some(if raw.eq_ignore_ascii_case("missing") {
            "0.0.0".to_string()
        } else {
            raw.to_string()
        })
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// Debug-only switch that suppresses the message box so automated runs can
/// assert the exit code without a human dismissing a dialog.
fn simulation_silent() -> bool {
    #[cfg(debug_assertions)]
    {
        std::env::var_os(SIMULATE_SILENT_ENV).is_some()
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

/// Installed Evergreen Runtime version, if any.
pub fn webview2_version() -> Option<String> {
    loader_version().or_else(registry_version)
}

/// Asks the WebView2 loader for the Evergreen version string.
///
/// The loader answers even without an installed runtime (with
/// `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`), so an error means "missing".
fn loader_version() -> Option<String> {
    let mut version = PWSTR::null();
    // SAFETY: `version` is a valid out-pointer for the duration of the call;
    // on success the loader returns a `CoTaskMemAlloc` string we take over.
    let result = unsafe {
        webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(
            PCWSTR::null(),
            &mut version,
        )
    };
    if result.is_err() || version.is_null() {
        return None;
    }

    let version = webview2_com::take_pwstr(version);
    let version = version.trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Reads the Evergreen version that the EdgeUpdate installer recorded.
fn registry_version() -> Option<String> {
    WEBVIEW2_REGISTRY_KEYS.iter().find_map(|(root, key)| {
        let version = read_registry_string(*root, key, WEBVIEW2_VERSION_VALUE)?;
        // The installer leaves `0.0.0.0` behind when it aborts; that is not a
        // usable runtime.
        (!version.is_empty() && version != "0.0.0.0").then_some(version)
    })
}

/// Reads the running OS build from the registry.
fn windows_build() -> Option<u32> {
    read_registry_string(HKEY_LOCAL_MACHINE, WINDOWS_VERSION_KEY, WINDOWS_BUILD_VALUE)
        .as_deref()
        .and_then(parse_build_number)
}

/// Parses a Windows build string, ignoring suffixes such as `19045.5`.
fn parse_build_number(text: &str) -> Option<u32> {
    let digits: String = text
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Reads a `REG_SZ` value, returning `None` when the key or value is absent.
fn read_registry_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
    let subkey = wide(subkey);
    let value = wide(value);
    let mut key = HKEY::default();

    // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the
    // call and `key` is a writable out-pointer.
    let status = unsafe { RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), None, KEY_READ, &mut key) };
    if status != ERROR_SUCCESS {
        return None;
    }

    let result = query_string_value(key, &value);
    // SAFETY: `key` was opened above and is closed exactly once here.
    unsafe {
        let _ = RegCloseKey(key);
    }
    result
}

/// Queries a string value out of an already opened key.
fn query_string_value(key: HKEY, value: &[u16]) -> Option<String> {
    let mut kind = REG_VALUE_TYPE::default();
    let mut size = 0u32;

    // SAFETY: `value` is NUL-terminated; the size query writes only `kind` and
    // `size`, which are live locals.
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS || kind != REG_SZ || size == 0 {
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    // SAFETY: the buffer is `size` bytes, exactly what the size query reported.
    let status = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value.as_ptr()),
            None,
            None,
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }

    buffer.truncate(size as usize);
    let units: Vec<u16> = buffer
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    let text = text.trim_end_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Locates the offline bootstrapper shipped next to the executable.
fn bootstrapper_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(OFFLINE_BOOTSTRAPPER);
    candidate.is_file().then_some(candidate)
}

/// Tells the user the runtime is missing and offers to install it.
fn report_missing_webview2() {
    let Some(bootstrapper) = bootstrapper_path() else {
        show(&missing_webview2_message(None, false), error_style());
        return;
    };

    if !ask_yes_no(&missing_webview2_message(Some(&bootstrapper), true)) {
        show(&missing_webview2_message(Some(&bootstrapper), false), error_style());
        return;
    }

    // The installer runs detached; it raises its own UAC prompt if it needs
    // elevation and the app exits right after so it can replace files.
    let launched = Command::new(&bootstrapper).spawn().map(|_| ());
    show(&installer_outcome_message(&bootstrapper, launched), error_style());
}

/// Text for an OS older than Windows 10 1809.
fn unsupported_windows_message(build: u32) -> String {
    format!(
        "{APP_NAME} bu Windows sürümünde çalışamaz.\n\n\
         Gerekli: Windows 10 sürüm 1809 (yapı {MIN_WINDOWS_BUILD}) veya üzeri.\n\
         Bu bilgisayar: yapı {build}.\n\n\
         Windows Update ile işletim sistemini güncelleyip uygulamayı yeniden açın.\n\n\
         Hata kodu: {EXIT_UNSUPPORTED_WINDOWS}"
    )
}

/// Text for a missing WebView2 runtime.
///
/// `bootstrapper` adds the local installer path; `offer_install` turns the
/// body into a yes/no question, so it is only set for the interactive prompt.
fn missing_webview2_message(bootstrapper: Option<&Path>, offer_install: bool) -> String {
    let mut text = format!(
        "{APP_NAME} için Microsoft Edge WebView2 Runtime gerekli, \
         ancak bu bilgisayarda kurulu değil.\n"
    );

    if let Some(bootstrapper) = bootstrapper {
        text.push_str(&format!(
            "\nÇevrimdışı kurulum dosyası:\n{}\n",
            bootstrapper.display()
        ));
    }
    text.push_str(&format!("\nÇevrimiçi indirme:\n{WEBVIEW2_DOWNLOAD_URL}\n"));

    if offer_install {
        text.push_str("\nKurulumu şimdi başlatmak ister misiniz?");
    } else {
        text.push_str(
            "\nKurulumu tamamlayıp uygulamayı yeniden açın.\n",
        );
    }

    format!("{text}\nHata kodu: {EXIT_WEBVIEW2_MISSING}")
}

/// Text shown after an attempt to start the offline installer.
fn installer_outcome_message(bootstrapper: &Path, launched: std::io::Result<()>) -> String {
    let head = match launched {
        Ok(()) => format!("WebView2 kurulumu başlatıldı:\n{}", bootstrapper.display()),
        Err(error) => format!(
            "WebView2 kurulumu başlatılamadı ({error}).\n\n\
             Kurulum dosyasını elle çalıştırın:\n{}",
            bootstrapper.display()
        ),
    };
    format!(
        "{head}\n\nKurulum tamamlandıktan sonra {APP_NAME}'u yeniden açın.\n\n\
         Hata kodu: {EXIT_WEBVIEW2_MISSING}"
    )
}

/// Style shared by every message box: modal error owned by the shell.
fn error_style() -> MESSAGEBOX_STYLE {
    MB_OK | MB_ICONERROR | MB_SETFOREGROUND
}

/// Shows a Yes/No question; `true` only when the user picked Yes.
fn ask_yes_no(text: &str) -> bool {
    let style = MB_YESNO | MB_DEFBUTTON2 | MB_ICONERROR | MB_SETFOREGROUND;
    show(text, style) == IDYES
}

/// Displays `text` in a native message box and returns the pressed button.
fn show(text: &str, style: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
    let text = wide(text);
    let caption = wide(APP_NAME);
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call;
    // a null owner window is valid before the app creates one.
    unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(caption.as_ptr()), style) }
}

/// NUL-terminated UTF-16 copy of `text` for Win32 `PCWSTR` parameters.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_build_numbers_with_and_without_suffixes() {
        assert_eq!(parse_build_number("17763"), Some(17763));
        assert_eq!(parse_build_number(" 19045.5371 \n"), Some(19045));
        assert_eq!(parse_build_number("26100"), Some(26100));
        assert_eq!(parse_build_number(""), None);
        assert_eq!(parse_build_number("yapı yok"), None);
    }

    #[test]
    fn windows_10_1809_is_the_boundary() {
        assert_eq!(MIN_WINDOWS_BUILD, 17763);
        assert_eq!(parse_build_number("17762"), Some(17762));
        assert!(parse_build_number("17762").unwrap() < MIN_WINDOWS_BUILD);
        assert!(!(parse_build_number("17763").unwrap() < MIN_WINDOWS_BUILD));
    }

    #[test]
    fn startup_check_rejects_a_missing_runtime() {
        assert_eq!(
            startup_check(Some(26200), None),
            StartupCheck::MissingWebView2
        );
        // `0.0.0`/`0.0.0.0` is the aborted-install marker, not a runtime.
        assert_eq!(
            startup_check(Some(26200), Some("0.0.0")),
            StartupCheck::MissingWebView2
        );
        assert_eq!(
            startup_check(Some(26200), Some("0.0.0.0")),
            StartupCheck::MissingWebView2
        );
        assert_eq!(
            startup_check(Some(26200), Some("   ")),
            StartupCheck::MissingWebView2
        );
    }

    #[test]
    fn startup_check_accepts_a_supported_runtime() {
        assert_eq!(
            startup_check(Some(26200), Some("157.0.4341.46")),
            StartupCheck::Ready
        );
        // An unreadable build number must not block the app.
        assert_eq!(
            startup_check(None, Some("120.0.2210.91")),
            StartupCheck::Ready
        );
    }

    #[test]
    fn startup_check_enforces_the_windows_10_1809_boundary() {
        assert_eq!(
            startup_check(Some(17134), Some("157.0.4341.46")),
            StartupCheck::UnsupportedWindows { build: 17134 }
        );
        assert_eq!(
            startup_check(Some(17763), Some("157.0.4341.46")),
            StartupCheck::Ready
        );
    }

    #[test]
    fn unsupported_os_message_names_requirement_and_exit_code() {
        let message = unsupported_windows_message(17134);
        assert!(message.contains("17763"), "{message}");
        assert!(message.contains("17134"), "{message}");
        assert!(
            message.contains(&format!("Hata kodu: {EXIT_UNSUPPORTED_WINDOWS}")),
            "{message}"
        );
    }

    #[test]
    fn missing_runtime_message_carries_download_and_exit_code() {
        let message = missing_webview2_message(None, false);
        assert!(message.contains(WEBVIEW2_DOWNLOAD_URL), "{message}");
        assert!(message.contains("WebView2"), "{message}");
        assert!(
            message.contains(&format!("Hata kodu: {EXIT_WEBVIEW2_MISSING}")),
            "{message}"
        );
        assert!(!message.contains("başlatmak ister misiniz"), "{message}");
    }

    #[test]
    fn offline_bootstrapper_path_and_prompt_are_shown_when_offered() {
        let path = Path::new(r"C:\Program Files\md-editor\MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
        let message = missing_webview2_message(Some(path), true);
        assert!(message.contains(OFFLINE_BOOTSTRAPPER), "{message}");
        assert!(message.contains("başlatmak ister misiniz"), "{message}");
        assert!(message.contains("Çevrimiçi indirme"), "{message}");
    }

    #[test]
    fn installer_outcome_reports_success_and_failure() {
        let path = Path::new(r"C:\md-editor\install.exe");
        let success = installer_outcome_message(path, Ok(()));
        assert!(success.contains("başlatıldı"), "{success}");
        assert!(success.contains("install.exe"), "{success}");

        let failure = installer_outcome_message(
            path,
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "dosya yok")),
        );
        assert!(failure.contains("başlatılamadı"), "{failure}");
        assert!(failure.contains("dosya yok"), "{failure}");
        assert!(
            failure.contains(&format!("Hata kodu: {EXIT_WEBVIEW2_MISSING}")),
            "{failure}"
        );
    }
}
