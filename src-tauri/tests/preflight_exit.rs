//! Startup preflight gates the process, not only the decision function.
//!
//! `platform::startup_check` is unit-tested, but the acceptance criterion is
//! about the shipped behaviour: when WebView2 is missing (or Windows predates
//! 1809) the app must stop before Tauri builds a window and end with the
//! documented exit code. These tests run the real executable with the
//! debug-only simulation switches, so a regression that moves the preflight
//! call after the builder fails here.
//!
//! The message box is suppressed (`MD_EDITOR_SIMULATE_SILENT`) and the switches
//! only exist in debug builds, which is the profile integration tests run in.

#![cfg(windows)]

use std::process::Command;

use md_editor_lib::platform::{EXIT_UNSUPPORTED_WINDOWS, EXIT_WEBVIEW2_MISSING};

/// The executable under test, built by Cargo for this integration test.
const BIN: &str = env!("CARGO_BIN_EXE_md-editor");

/// Runs the app with `simulation` applied plus the silent switch and returns
/// the process exit code.
fn exit_code_with(simulation: &[(&str, &str)]) -> i32 {
    let mut command = Command::new(BIN);
    command.env("MD_EDITOR_SIMULATE_SILENT", "1");
    for (key, value) in simulation {
        command.env(key, value);
    }

    command
        .status()
        .expect("uygulama çalıştırılabilmeli")
        .code()
        .expect("süreç bir çıkış koduyla sonlanmalı")
}

#[test]
fn missing_webview2_stops_startup_with_the_documented_exit_code() {
    assert_eq!(
        exit_code_with(&[("MD_EDITOR_SIMULATE_WEBVIEW2", "missing")]),
        EXIT_WEBVIEW2_MISSING
    );
}

#[test]
fn windows_older_than_1809_stops_startup_with_the_documented_exit_code() {
    assert_eq!(
        exit_code_with(&[
            ("MD_EDITOR_SIMULATE_WINDOWS_BUILD", "17134"),
            ("MD_EDITOR_SIMULATE_WEBVIEW2", "157.0.4341.46"),
        ]),
        EXIT_UNSUPPORTED_WINDOWS
    );
}
