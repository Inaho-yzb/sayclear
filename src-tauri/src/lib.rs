mod ai;
pub mod cli;
mod component_catalog;
mod data_directory;
mod diagram;
mod export;
mod git;
mod graph_commands;
mod graph_service;
mod legacy_storage;
mod model;
mod storage;

#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("The e2e feature must never be included in a release build");

use data_directory::WorkspaceManager;
use model::Workspace;
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use storage::{atomic_write, export_filename};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

struct CliBridgeState {
    bridge: Mutex<Option<cli::Bridge>>,
    ready: AtomicBool,
}

impl CliBridgeState {
    fn pause(&self) -> Result<(), String> {
        if let Some(bridge) = self.bridge.lock().map_err(|e| e.to_string())?.as_ref() {
            bridge.ready(false);
        }
        Ok(())
    }

    fn restore_readiness(&self) -> Result<(), String> {
        if let Some(bridge) = self.bridge.lock().map_err(|e| e.to_string())?.as_ref() {
            bridge.ready(self.ready.load(Ordering::SeqCst));
        }
        Ok(())
    }

    fn rebind(&self, app: tauri::AppHandle, directory: PathBuf) -> Result<(), String> {
        let next = cli::start_bridge(app, directory)?;
        let mut bridge = self.bridge.lock().map_err(|e| e.to_string())?;
        *bridge = Some(next);
        bridge
            .as_ref()
            .expect("bridge just installed")
            .ready(self.ready.load(Ordering::SeqCst));
        Ok(())
    }
}

#[tauri::command]
async fn execute_graph_command(
    workspace: Workspace,
    request: graph_commands::GraphRequest,
) -> Result<graph_commands::GraphOutcome, graph_commands::CommandError> {
    tauri::async_runtime::spawn_blocking(move || graph_commands::execute(&workspace, &request))
        .await
        .map_err(|error| graph_commands::CommandError {
            code: "INTERNAL_ERROR".into(),
            message: error.to_string(),
        })?
}

#[tauri::command]
fn set_cli_ready(ready: bool, state: State<'_, CliBridgeState>) -> Result<(), String> {
    state.ready.store(ready, Ordering::SeqCst);
    if let Some(bridge) = state.bridge.lock().map_err(|e| e.to_string())?.as_ref() {
        bridge.ready(ready);
    }
    Ok(())
}

#[tauri::command]
fn complete_cli_request(
    request_id: String,
    result: Option<serde_json::Value>,
    error: Option<graph_commands::CommandError>,
    state: State<'_, CliBridgeState>,
) -> Result<(), String> {
    let response = match (result, error) {
        (Some(result), None) => Ok(result),
        (None, Some(error)) => Err(error),
        _ => return Err("命令完成必须包含结果或错误".into()),
    };
    state
        .bridge
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .ok_or("CLI 服务尚未启动")?
        .complete(&request_id, response)
}

#[tauri::command]
fn load_ai_settings(ai: State<'_, Arc<ai::AiManager>>) -> Result<ai::AiSettings, String> {
    ai.load()
}

#[tauri::command]
fn save_ai_settings(
    settings: ai::AiSettings,
    ai: State<'_, Arc<ai::AiManager>>,
) -> Result<(), String> {
    ai.save(&settings)
}

#[tauri::command]
async fn check_ai_tool(settings: ai::AiSettings) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ai::check(&settings))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_ai_turn(
    request: ai::AiRequest,
    on_progress: tauri::ipc::Channel<ai::AiProgress>,
    ai: State<'_, Arc<ai::AiManager>>,
) -> Result<ai::AiResponse, String> {
    let cancelled = ai.register(&request.request_id)?;
    let ai = Arc::clone(ai.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ai.run(request, cancelled, |progress| {
            let _ = on_progress.send(progress);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_ai_turn(request_id: String, ai: State<'_, Arc<ai::AiManager>>) -> Result<(), String> {
    ai.cancel(&request_id)
}

#[tauri::command]
async fn load_workspace(
    app: tauri::AppHandle,
    store: State<'_, Arc<WorkspaceManager>>,
    bridge: State<'_, CliBridgeState>,
) -> Result<Option<Workspace>, String> {
    let store = Arc::clone(store.inner());
    let loader = Arc::clone(&store);
    let workspace = tauri::async_runtime::spawn_blocking(move || loader.load())
        .await
        .map_err(|e| e.to_string())??;
    let needs_bridge = bridge.bridge.lock().map_err(|e| e.to_string())?.is_none();
    if needs_bridge {
        bridge.rebind(app, store.directory()?)?;
    }
    Ok(workspace)
}

#[tauri::command]
async fn save_workspace(
    workspace: Workspace,
    store: State<'_, Arc<WorkspaceManager>>,
) -> Result<Vec<storage::SavedHistory>, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.save_with_index(&workspace))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn inspect_git_repository(path: String) -> Result<git::RepositoryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git::inspect(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resolve_git_repository(
    address: String,
    app: tauri::AppHandle,
) -> Result<git::RepositoryInfo, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("git-repositories");
    tauri::async_runtime::spawn_blocking(move || git::resolve(&address, &directory))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn choose_git_repository(
    app: tauri::AppHandle,
) -> Result<Option<git::RepositoryInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(feature = "e2e", debug_assertions))]
        if let Some(path) = std::env::var_os("SAY_CLEAR_PICK_GIT_DIRECTORY") {
            return git::inspect(&path.to_string_lossy()).map(Some);
        }
        let selected = app
            .dialog()
            .file()
            .set_title("关联本地 Git 仓库")
            .blocking_pick_folder();
        selected
            .map(|path| {
                let path = path.into_path().map_err(|e| e.to_string())?;
                git::inspect(&path.to_string_lossy())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_git_iteration(
    workspace: Workspace,
    board_id: String,
    branch: String,
    base_branch: String,
    store: State<'_, Arc<WorkspaceManager>>,
) -> Result<Workspace, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.create_git_iteration(workspace, &board_id, &branch, &base_branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_history(
    board_id: String,
    version_id: String,
    store: State<'_, Arc<WorkspaceManager>>,
) -> Result<diagram::GraphSnapshot, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.load_history(&board_id, &version_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn validate_catalog(
    catalog: component_catalog::ComponentCatalog,
    store: State<'_, Arc<WorkspaceManager>>,
) -> Result<(), String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.validate_catalog(&catalog))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_system(
    system_id: String,
    store: State<'_, Arc<WorkspaceManager>>,
) -> Result<Workspace, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.delete_system(&system_id))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
struct ExportDocument {
    name: String,
    content: String,
}

#[tauri::command]
async fn get_data_directory(store: State<'_, Arc<WorkspaceManager>>) -> Result<PathBuf, String> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.directory())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn choose_data_directory(
    app: tauri::AppHandle,
    store: State<'_, Arc<WorkspaceManager>>,
    bridge: State<'_, CliBridgeState>,
) -> Result<Option<PathBuf>, String> {
    bridge.pause()?;
    let store = Arc::clone(store.inner());
    let handle = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(feature = "e2e", debug_assertions))]
        if let Some(path) = std::env::var_os("SAY_CLEAR_PICK_DIRECTORY") {
            return store
                .change_directory(std::path::Path::new(&path))
                .map(Some);
        }
        let selected = app
            .dialog()
            .file()
            .set_title("选择空文件夹作为数据目录")
            .set_directory(store.directory()?)
            .blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        store.change_directory(&path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    match selected {
        Ok(Some(path)) => {
            bridge.rebind(handle, path.clone())?;
            Ok(Some(path))
        }
        result => {
            bridge.restore_readiness()?;
            result
        }
    }
}

#[tauri::command]
async fn export_markdown(app: tauri::AppHandle, document: ExportDocument) -> Result<bool, String> {
    let filename = export_filename(&document.name, &document.content)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(feature = "e2e", debug_assertions))]
        if let Some(path) = std::env::var_os("SAY_CLEAR_EXPORT_PATH") {
            atomic_write(std::path::Path::new(&path), document.content.as_bytes())?;
            return Ok(true);
        }
        let selected = app
            .dialog()
            .file()
            .set_title("导出需求文档")
            .set_file_name(&filename)
            .add_filter("Markdown", &["md"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        atomic_write(&path, document.content.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_bundle(
    app: tauri::AppHandle,
    bundle: export::ExportBundle,
    format: export::ExportFormat,
) -> Result<Option<PathBuf>, String> {
    bundle.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(feature = "e2e", debug_assertions))]
        if let Some(path) = std::env::var_os("SAY_CLEAR_EXPORT_BUNDLE_PATH") {
            let path = std::path::Path::new(&path);
            return match format {
                export::ExportFormat::Folder => export::write_folder(path, &bundle),
                export::ExportFormat::Zip => export::write_zip(path, &bundle),
            }
            .map(Some);
        }
        match format {
            export::ExportFormat::Folder => {
                let selected = app
                    .dialog()
                    .file()
                    .set_title("选择导出文件夹的位置")
                    .blocking_pick_folder();
                selected
                    .map(|path| {
                        let parent = path.into_path().map_err(|error| error.to_string())?;
                        export::write_folder(&parent, &bundle)
                    })
                    .transpose()
            }
            export::ExportFormat::Zip => {
                let selected = app
                    .dialog()
                    .file()
                    .set_title("导出图交付包")
                    .set_file_name(format!("{}.zip", bundle.name))
                    .add_filter("ZIP", &["zip"])
                    .blocking_save_file();
                selected
                    .map(|path| {
                        let path = path.into_path().map_err(|error| error.to_string())?;
                        export::write_zip(&path, &bundle)
                    })
                    .transpose()
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if !model::within_limit(&text, 1_000_000) {
        return Err("复制内容超出长度限制".into());
    }
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_platform() -> &'static str {
    std::env::consts::OS
}

fn workspace_paths(
    app: &tauri::AppHandle,
) -> Result<(PathBuf, Option<PathBuf>), Box<dyn std::error::Error>> {
    // Test data overrides are intentionally unavailable in release builds.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SAY_CLEAR_DATA_DIR") {
        let legacy = std::env::var_os("SAY_CLEAR_LEGACY_DIR")
            .map(|p| PathBuf::from(p).join("workspace.json"));
        return Ok((PathBuf::from(path), legacy));
    }
    let path = app.path().app_data_dir()?;
    let legacy = app.path().config_dir()?.join("Say Clear/workspace.json");
    Ok((path, Some(legacy)))
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let (path, legacy) = workspace_paths(app.handle())?;
            app.manage(Arc::new(ai::AiManager::new(path.clone())));
            let store = Arc::new(WorkspaceManager::new_locked(path, legacy));
            let directory = store.directory();
            app.manage(store);
            let bridge = CliBridgeState {
                bridge: Mutex::new(None),
                ready: AtomicBool::new(false),
            };
            if let Ok(directory) = directory {
                bridge.rebind(app.handle().clone(), directory)?;
            }
            app.manage(bridge);
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?;
            // Unbundled macOS test binaries otherwise share the default WebKit store.
            // Keep one isolated store across the restart phases of a desktop regression.
            #[cfg(all(feature = "e2e", debug_assertions, target_os = "macos"))]
            let window = match std::env::var("SAY_CLEAR_E2E_WEBVIEW_STORE_ID") {
                Ok(value) => {
                    window.data_store_identifier(serde_json::from_str::<[u8; 16]>(&value)?)
                }
                Err(std::env::VarError::NotPresent) => window,
                Err(error) => return Err(error.into()),
            };
            window
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(5173))
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_ai_settings,
            save_ai_settings,
            check_ai_tool,
            run_ai_turn,
            cancel_ai_turn,
            execute_graph_command,
            set_cli_ready,
            complete_cli_request,
            load_workspace,
            save_workspace,
            inspect_git_repository,
            resolve_git_repository,
            choose_git_repository,
            create_git_iteration,
            load_history,
            validate_catalog,
            delete_system,
            get_data_directory,
            choose_data_directory,
            export_markdown,
            export_bundle,
            copy_text,
            app_platform
        ]);

    #[cfg(all(feature = "e2e", debug_assertions))]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .build(tauri::generate_context!())
        .expect("无法启动 Say Clear")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<ai::AiManager>>().cancel_all();
                let state = app.state::<CliBridgeState>();
                state.ready.store(false, Ordering::SeqCst);
                if let Ok(mut bridge) = state.bridge.lock() {
                    // The worker holds an AppHandle; close it explicitly to break that lifetime.
                    bridge.take();
                };
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    // Route Quit through the same frontend flush as the window close button.
                    let _ = window.close();
                }
            }
        });
}
