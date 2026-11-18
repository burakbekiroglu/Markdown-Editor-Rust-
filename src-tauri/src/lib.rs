pub mod error;
pub mod fs;
pub mod fs_ops;
pub mod paths;
pub mod perf;
#[cfg(windows)]
pub mod platform;
pub mod preview;
pub mod security;
pub mod session;
pub mod startup;
pub mod watcher;
pub mod workspace;
pub mod workspace_commands;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Event emitted when the OS asks to close the main window.
///
/// The default close is always prevented so the webview can ask the user to
/// save dirty tabs. The frontend destroys the window once it is safe to close;
/// `destroy` does not raise `CloseRequested` again, so there is no loop.
pub const CLOSE_REQUESTED_EVENT: &str = "app:close-requested";

/// Ask the frontend to run the close-confirmation flow.
///
/// Every close request for the main window is intercepted: the frontend is the
/// only place that knows whether a tab has unsaved changes.
fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != security::MAIN_WINDOW_LABEL {
            return;
        }
        api.prevent_close();
        // A dropped emit would leave the window open with no way to close it:
        // the webview never learns that the user asked to quit.
        if let Err(error) = window.emit(CLOSE_REQUESTED_EVENT, ()) {
            eprintln!("[error] kapatma isteği webview'e iletilemedi: {error}");
        }
    }
}

/// Destroy the main window on the webview's behalf.
///
/// The webview must not call `window.destroy()` itself: that is a core command
/// gated behind the `core:window:allow-destroy` ACL permission, which would
/// hand the webview a privileged teardown it otherwise never needs. Application
/// commands are not ACL-gated (see `capabilities/default.json`), so the
/// frontend asks here once it knows no tab is dirty and Rust performs the
/// teardown. `destroy` does not raise `CloseRequested` again, so the
/// `prevent_close` in [`handle_window_event`] cannot loop.
#[tauri::command]
fn app_close_window(app: tauri::AppHandle) -> error::AppResult<()> {
    let window = app
        .get_webview_window(security::MAIN_WINDOW_LABEL)
        .ok_or_else(|| error::AppError::internal("ana pencere bulunamadı"))?;
    window
        .destroy()
        .map_err(|error| error::AppError::internal(format!("pencere kapatılamadı: {error}")))
}

/// Wrap the generated command handler so a panic cannot escape it.
///
/// Tauri does not catch panics. Without this fence a panic inside a command
/// unwinds out of the IPC handler, the invoke promise is never resolved, and
/// the webview waits forever without showing an error. The cloned resolver
/// outlives the unwind, so the rejection is still delivered as the typed
/// `{ code: "Internal", message }` payload the frontend normalises.
fn fenced_handler(
    handler: impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let fallback = invoke.resolver.clone();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(invoke))) {
            Ok(handled) => handled,
            Err(payload) => {
                fallback.reject(error::panic_error(payload.as_ref()));
                true
            }
        }
    }
}

/// Test hook: when this environment variable points to a writable path, the
/// window focus performed after a second-instance launch writes an observable
/// probe JSON file there. Production runs never set it.
pub const FOCUS_PROBE_ENV: &str = "MD_EDITOR_FOCUS_PROBE";

/// Observable state of the focused window, recorded by the test hook.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusProbe {
    pub is_focused: bool,
    pub is_minimized: bool,
    pub is_visible: bool,
    /// Number of live webview windows in this process.
    pub window_count: usize,
}

/// Sample the window state with a bounded retry: `set_focus` on Windows can
/// land asynchronously, so `is_focused` is polled up to [`PROBE_SETTLE`] for
/// a true reading before the probe records the final sample.
const PROBE_SETTLE: std::time::Duration = std::time::Duration::from_millis(2000);

fn write_focus_probe(window: &tauri::WebviewWindow<tauri::Wry>, window_count: usize) {
    let Some(path) = std::env::var_os(FOCUS_PROBE_ENV) else {
        return;
    };
    let deadline = std::time::Instant::now() + PROBE_SETTLE;
    let is_focused = loop {
        match window.is_focused() {
            Ok(true) => break true,
            Ok(false) | Err(_) if std::time::Instant::now() >= deadline => {
                break window.is_focused().unwrap_or(false);
            }
            _ => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    };
    let probe = FocusProbe {
        is_focused,
        is_minimized: window.is_minimized().unwrap_or(true),
        is_visible: window.is_visible().unwrap_or(false),
        window_count,
    };
    // A probe write must never affect user-visible behaviour: the failure is
    // reported on stderr only, which tests surface in the process output.
    let payload = serde_json::to_vec(&probe).expect("focus probe serialize");
    if let Err(error) = std::fs::write(&path, payload) {
        eprintln!("focus probe yazılamadı: {error}");
    }
}

/// Bring the already-running window back to the foreground.
///
/// Called by the single-instance plugin when a second process starts: that
/// process exits immediately and this window is restored instead.
fn focus_main_window(app: &tauri::AppHandle<tauri::Wry>) {
    // The first instance has no window yet in the rare case it was closed
    // without the app exiting; rebuild it so the focus gesture has a target.
    let window = match app.get_webview_window(security::MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            if create_main_window(app).is_err() {
                return;
            }
            match app.get_webview_window(security::MAIN_WINDOW_LABEL) {
                Some(window) => window,
                None => return,
            }
        }
    };
    // Restore if minimized, show if hidden, then focus.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Raise above other windows: `set_focus` alone does not reliably lift a
    // background window on Windows, so borrow focus via a brief always-on-top
    // toggle and drop it immediately.
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);
    // Observable focus evidence for the automated single-instance test.
    write_focus_probe(&window, app.webview_windows().len());
}

/// Build the main window with the hardening handlers attached.
///
/// The window is created here rather than from `tauri.conf.json` because
/// `on_navigation` and `on_new_window` are webview-builder hooks.
fn create_main_window<M>(app: &M) -> tauri::Result<()>
where
    M: tauri::Manager<tauri::Wry>,
{
    let window = WebviewWindowBuilder::new(
        app,
        security::MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Markdown Editor")
    .inner_size(1100.0, 750.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .center()
    // Anything outside the app's own origin is refused, including links that
    // would navigate the main frame to a remote page.
    .on_navigation(security::is_allowed_navigation)
    // `window.open` never creates a second webview.
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

    // Release builds ship without devtools; debug builds keep them.
    #[cfg(not(debug_assertions))]
    let window = window.devtools(false);

    window.build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Startup timing starts before any builder work so the report covers the
    // whole process path, not just the window build.
    perf::mark_process_start();

    // Preconditions first: without a supported Windows build and the WebView2
    // Evergreen Runtime Tauri cannot create a window, so report natively and
    // end the process with a documented exit code before any builder work.
    #[cfg(windows)]
    if let Err(exit_code) = platform::preflight() {
        std::process::exit(exit_code);
    }

    let result = tauri::Builder::default()
        // Must be the first plugin: a second instance hands its argv to the
        // first one and exits before any other plugin runs.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // Editor session: versioned JSON in app-data (`session.json`).
        .plugin(tauri_plugin_store::Builder::default().build())
        // Preview images: workspace-relative, image-only, confinement-checked.
        .register_uri_scheme_protocol(preview::SCHEME, preview::handle)
        .manage(workspace::WorkspaceState::new())
        .manage(watcher::WatcherState::new())
        .manage(watcher::SelfWriteRegistry::new())
        // Startup failures that do not stop the app (a corrupt session store)
        // are queued here and pulled by the webview once it is ready.
        .manage(startup::StartupWarnings::new())
        // Every command body runs behind a panic fence. Tauri does not catch
        // panics: an uncaught one unwinds out of the IPC handler and leaves the
        // invoke promise unresolved, so the webview hangs with no message. The
        // fence replies with the typed `Internal` error instead.
        .invoke_handler(fenced_handler(tauri::generate_handler![
            fs::read::fs_read_file,
            fs::read::fs_read_document,
            fs::write::fs_write_file_atomic,
            fs::list::fs_list_dir,
            fs::index::fs_index,
            fs::metadata::fs_metadata,
            fs_ops::fs_create_file,
            fs_ops::fs_create_folder,
            fs_ops::fs_rename_entry,
            fs_ops::fs_move,
            fs_ops::fs_delete_entry,
            workspace_commands::open_workspace,
            workspace_commands::open_workspace_path,
            workspace_commands::current_workspace,
            workspace_commands::close_workspace,
            workspace_commands::list_workspace_dir,
            startup::take_startup_warnings,
            perf::report_first_paint,
            app_close_window,
        ]))
        // Close requests are intercepted so unsaved tabs can be saved first.
        .on_window_event(handle_window_event)
        .setup(|app| {
            // A store file that `tauri-plugin-store` cannot parse would make
            // every session load fail. Move it aside before the webview asks
            // the plugin for the store, so the app opens with a clean session.
            //
            // A recovery that itself fails must not be swallowed: the app
            // keeps running, so the failure is queued for the webview and
            // shown as a typed error instead of only reaching stderr (which is
            // invisible in a windowed Windows build).
            match app.path().app_data_dir() {
                Ok(directory) => {
                    if let Err(error) = session::quarantine_corrupt_store(
                        &session::session_file_in(&directory),
                    ) {
                        eprintln!("oturum dosyası kurtarılamadı: {error}");
                        app.state::<startup::StartupWarnings>().record(error);
                    }
                }
                Err(error) => {
                    let warning = error::AppError::internal(format!(
                        "oturum dizini bulunamadı: {error}"
                    ));
                    eprintln!("{warning}");
                    app.state::<startup::StartupWarnings>().record(warning);
                }
            }
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!());

    // Başlatma hatası panik değil, bildirilen ve kodla sonlanan bir hatadır;
    // `panic!` geri izi kullanıcıya anlamlı bir mesaj vermez.
    if let Err(error) = result {
        eprintln!("uygulama başlatılamadı: {error}");
        std::process::exit(1);
    }
}
