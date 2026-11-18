//! Single-instance behaviour is verified against the real executable.
//!
//! The acceptance criterion is OS-level: starting a second instance must not
//! open a second window. The single-instance plugin (registered first in
//! `lib.rs`) makes the second process hand its argv to the first one and exit
//! immediately, while the first window is focused via `focus_main_window`.
//! This test reproduces that scenario: the second launch must terminate on
//! its own within a bounded deadline while the first keeps running.
//!
//! The focus part (`unminimize`/`show`/`set_focus`) is asserted automatically
//! through the [`md_editor_lib::FOCUS_PROBE_ENV`] hook: when the environment
//! variable points to a file, the first process records the sampled window
//! state (`isFocused`, `isMinimized`, `isVisible`, `windowCount`) there right
//! after the second-instance gesture completes.

#![cfg(windows)]

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The executable under test, built by Cargo for this integration test.
const BIN: &str = env!("CARGO_BIN_EXE_md-editor");

/// Deadline for the second instance to exit on its own. The single-instance
/// plugin exits before any window is built, so this is generous, not tight.
const SECOND_INSTANCE_DEADLINE: Duration = Duration::from_secs(15);

/// Grace period so the first instance can acquire the OS-level single-instance
/// mutex before the second launch starts.
const FIRST_INSTANCE_GRACE: Duration = Duration::from_secs(2);

/// Deadlock guard: both tests launch real processes that compete for the
/// app-wide single-instance mutex, so they must never run concurrently. A
/// poisoned guard after a failed test still allows the next test to run.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Deadline for the first instance to write the focus probe file.
const PROBE_DEADLINE: Duration = Duration::from_secs(30);

fn start_instance() -> Child {
    Command::new(BIN)
        // The plugin callback is not exercised through stdio; keep pipes
        // detached so a windowed process is not blocked on an unread stdout.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("uygulama başlatılabilmeli")
}

/// Spawn the app with the focus probe enabled at `probe_path`.
fn start_instance_with_probe(probe_path: &std::path::Path) -> Child {
    Command::new(BIN)
        .env(md_editor_lib::FOCUS_PROBE_ENV, probe_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("uygulama başlatılabilmeli")
}

/// Wait until the probe file exists and parses, or fail at the deadline.
fn wait_for_probe(probe_path: &std::path::Path) -> md_editor_lib::FocusProbe {
    let deadline = Instant::now() + PROBE_DEADLINE;
    loop {
        if let Ok(json) = std::fs::read(probe_path) {
            match serde_json::from_slice::<md_editor_lib::FocusProbe>(&json) {
                Ok(probe) => return probe,
                Err(error) => panic!("odak probe dosyası okunamadı: {error}"),
            }
        }
        assert!(
            Instant::now() < deadline,
            "odak probe {PROBE_DEADLINE:?} içinde yazılmadı: {}",
            probe_path.display()
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn second_instance_exits_immediately_and_leaves_a_single_window() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut first = start_instance();

    // If the first instance is not stable after the grace period, the test
    // environment (not the plugin) is broken; fail with context instead of
    // misattributing it.
    std::thread::sleep(FIRST_INSTANCE_GRACE);
    let _ = first
        .try_wait()
        .expect("ilk süreç durumu okunabilmeli")
        .map(|status| {
            panic!("ilk örnek süreci {FIRST_INSTANCE_GRACE:?} içinde kapandı: {status}");
        });

    let mut second = start_instance();
    let deadline = Instant::now() + SECOND_INSTANCE_DEADLINE;
    let exited = loop {
        match second.try_wait().expect("ikinci süreç durumu okunabilmeli") {
            Some(status) => break Some(status),
            None if Instant::now() >= deadline => break None,
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };

    // Cleanup runs even when the assertion fails below.
    let _ = first.kill();
    let _ = first.wait();
    let _ = second.kill();
    let _ = second.wait();

    match exited {
        Some(_) => {}
        None => panic!("ikinci örnek {SECOND_INSTANCE_DEADLINE:?} içinde sonlanmadı"),
    }
}

#[test]
fn focus_after_second_instance_is_automatically_verifiable() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let workspace = tempfile::tempdir().expect("geçici dizin oluşturulabilmeli");
    let probe_path = workspace.path().join("focus-probe.json");

    let mut first = start_instance_with_probe(&probe_path);
    std::thread::sleep(FIRST_INSTANCE_GRACE);
    let _ = first
        .try_wait()
        .expect("ilk süreç durumu okunabilmeli")
        .map(|status| {
            panic!("ilk örnek süreci {FIRST_INSTANCE_GRACE:?} içinde kapandı: {status}");
        });

    // The probe file must not exist before the second launch: it is written
    // only by the single-instance callback, so this proves the probe records
    // the *focus gesture*, not the window's initial creation.
    assert!(
        !probe_path.exists(),
        "odak probe ikinci başlatmadan önce yazılmamalıydı"
    );

    let mut second = start_instance();
    let deadline = Instant::now() + SECOND_INSTANCE_DEADLINE;
    let exited = loop {
        match second.try_wait().expect("ikinci süreç durumu okunabilmeli") {
            Some(status) => break Some(status),
            None if Instant::now() >= deadline => break None,
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };

    let probe = wait_for_probe(&probe_path);

    // Cleanup runs even when the assertions below fail.
    let _ = first.kill();
    let _ = first.wait();
    let _ = second.kill();
    let _ = second.wait();

    match exited {
        Some(_) => {}
        None => panic!("ikinci örnek {SECOND_INSTANCE_DEADLINE:?} içinde sonlanmadı"),
    }
    assert_eq!(
        probe.window_count, 1,
        "ikinci başlatma yeni bir pencere açmamalıydı"
    );
    assert!(
        probe.is_focused,
        "mevcut pencere ikinci başlatmadan sonra odaklanmalıydı"
    );
    assert!(
        !probe.is_minimized,
        "odaklanılan pencere simge durumunda olmamalıydı"
    );
    assert!(probe.is_visible, "odaklanılan pencere görünür olmalıydı");
}
