mod config;
mod diagnostics;
mod editor;
mod network;
mod redact;
mod templates;
mod versions;
use config::{Connection, Result, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
async fn open_config_file(state: State<'_, AppState>) -> Result<()> {
    let file = lock(&state.store)?.file_for_editor()?;
    editor::open(&file).await
}

#[tauri::command]
async fn windows_diagnostics(
    base_url: String,
    state: State<'_, AppState>,
) -> Result<diagnostics::Report> {
    let file = lock(&state.store)?.selected.clone();
    diagnostics::run(&base_url, &file).await
}

#[tauri::command]
fn open_chatgpt_installer() -> Result<()> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "ms-windows-store://pdp/?ProductId=9NT1R1C2HH7J",
            ])
            .spawn()
            .map_err(|_| "无法打开 Microsoft Store。".to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        let installer = "https://codexbei.beiapi.cn/mirror/arm64/ChatGPT_aarch64.dmg";
        #[cfg(target_arch = "x86_64")]
        let installer = "https://codexbei.beiapi.cn/mirror/x64/ChatGPT_x64.dmg";
        std::process::Command::new("open")
            .arg(installer)
            .spawn()
            .map_err(|_| "无法打开 ChatGPT 下载页面。".to_string())?;
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        return Err("当前系统暂不支持 ChatGPT 桌面版安装。".into());
    }
    Ok(())
}

struct Incoming {
    pending: Option<Result<Connection>>,
    last: Option<(String, Instant)>,
    revision: u64,
}
struct AppState {
    store: Mutex<Store>,
    incoming: Mutex<Incoming>,
    service: tokio::sync::Mutex<templates::Service>,
    test_mode: bool,
}
fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| "操作未完成，请重新打开应用。".into())
}
fn receive(app: &tauri::AppHandle, text: &str) {
    let state = app.state::<AppState>();
    #[cfg(debug_assertions)]
    let normalized = if state.test_mode {
        text.replacen("codexbei-test:", "codexbei:", 1)
    } else {
        text.to_owned()
    };
    #[cfg(debug_assertions)]
    let text = normalized.as_str();
    if let Ok(mut incoming) = state.incoming.lock() {
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        if incoming
            .last
            .as_ref()
            .is_some_and(|(h, t)| *h == hash && t.elapsed() < Duration::from_secs(2))
        {
            return;
        }
        incoming.last = Some((hash, Instant::now()));
        incoming.revision += 1;
        incoming.pending = match config::parse_link(text) {
            Ok(Some(c)) => Some(Ok(c)),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        };
    }
    let _ = app.emit("incoming-changed", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
#[tauri::command]
fn inspect(state: State<AppState>) -> Result<Value> {
    let store = lock(&state.store)?;
    let mut value = store.inspect()?;
    // The local credential input explicitly loads the saved key; previews stay redacted.
    let saved_key = match (value["hasKey"].as_bool(), value["baseUrl"].as_str()) {
        (Some(true), Some(base_url)) => store.credentials("", base_url)?.api_key,
        _ => String::new(),
    };
    value["apiKey"] = json!(saved_key);
    value["testMode"] = json!(state.test_mode);
    Ok(value)
}
#[tauri::command]
async fn check(
    selection: Option<versions::Selection>,
    force: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    state
        .service
        .lock()
        .await
        .refresh(selection, force, false)
        .await
}
#[tauri::command]
async fn update_template(state: State<'_, AppState>) -> Result<Value> {
    state.service.lock().await.refresh(None, true, true).await
}
#[tauri::command]
async fn choose(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("Codex 配置", &["toml"])
        .pick_file(move |path| {
            let _ = send.send(path);
        });
    let path = receive.await.map_err(|_| "文件选择未完成。".to_string())?;
    if let Some(path) = path {
        lock(&state.store)?.choose(
            path.into_path()
                .map_err(|_| "请选择本地配置文件。".to_string())?,
        )?;
    }
    inspect(state)
}
#[tauri::command]
async fn preview(
    base_url: String,
    model: String,
    keep_official_login: bool,
    model_channel: String,
    state: State<'_, AppState>,
) -> Result<String> {
    config::preview(
        &base_url,
        &model,
        keep_official_login,
        &model_channel,
        &state.service.lock().await.current()?,
    )
}
fn prune_result(store: &Store, mut result: Value) -> Value {
    if let Some(id) = result["backupId"].as_str() {
        if store.prune(id).is_err() {
            result["warning"] = json!("配置已完成，但旧备份清理失败，请到历史备份中检查。");
        }
    }
    result
}
#[tauri::command]
async fn configure(
    connection: Connection,
    keep_official_login: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    let revision = lock(&state.incoming)?.revision;
    let mut service = state.service.lock().await;
    service.refresh(None, true, false).await?;
    let incoming = lock(&state.incoming)?;
    if incoming.revision != revision {
        return Err("收到新的配置链接，请等待新配置完成。".into());
    }
    let mut store = lock(&state.store)?;
    let plan = store.prepare(connection, keep_official_login, &service.current()?)?;
    let result = store.apply(&plan)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
fn switch_channel(channel: String, state: State<AppState>) -> Result<Value> {
    let mut store = lock(&state.store)?;
    store.switch_channel(&channel)
}
#[tauri::command]
async fn incoming(keep_official_login: bool, state: State<'_, AppState>) -> Result<Value> {
    let (connection, revision) = {
        let mut pending = lock(&state.incoming)?;
        (pending.pending.take(), pending.revision)
    };
    let Some(connection) = connection else {
        return Ok(Value::Null);
    };
    let connection = connection?;
    let mut service = state.service.lock().await;
    service.refresh(None, true, false).await?;
    let current = lock(&state.incoming)?;
    if current.revision != revision {
        return Ok(Value::Null);
    }
    let mut store = lock(&state.store)?;
    let plan = store.prepare(connection, keep_official_login, &service.current()?)?;
    let result = store.apply(&plan)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
async fn models(
    api_key: String,
    base_url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let (client, version) = {
        let service = state.service.lock().await;
        (
            service.client.clone(),
            versions::client_version(&service.targets()?)
                .ok_or_else(|| "未识别到内核版本，请先选择 Codex 版本。".to_string())?,
        )
    };
    let connection = lock(&state.store)?.credentials(&api_key, &base_url)?;
    network::models(&client, connection, &version).await
}
#[tauri::command]
fn backups(state: State<AppState>) -> Result<Vec<Value>> {
    lock(&state.store)?.list()
}
#[tauri::command]
fn backup_preview(id: String, state: State<AppState>) -> Result<Value> {
    lock(&state.store)?.backup_preview(&id)
}
#[tauri::command]
async fn restore(
    id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    let (file, hash) = lock(&state.store)?.restore_state(&id)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!("还原 {}？当前配置会先备份。", file.display()))
        .parent(&window)
        .title("还原配置")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "还原".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            let _ = send.send(confirmed);
        });
    if !receive.await.map_err(|_| "确认操作未完成。".to_string())? {
        return Ok(json!({"canceled": true}));
    }
    let mut store = lock(&state.store)?;
    let result = store.restore(&id, &hash)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
async fn delete_backup(
    id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    lock(&state.store)?.validate_backup(&id)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("将此备份移至废纸篓或回收站？")
        .parent(&window)
        .title("删除备份")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "移至废纸篓".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            let _ = send.send(confirmed);
        });
    if !receive.await.map_err(|_| "确认操作未完成。".to_string())? {
        return Ok(json!({"canceled": true}));
    }
    lock(&state.store)?.delete(&id)?;
    Ok(json!({"id": id}))
}
fn data_paths() -> Result<(PathBuf, PathBuf, bool)> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("CODEXBEI_TEST_ROOT") {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err("测试目录必须使用绝对路径。".into());
        }
        config::private_dir(&root)?;
        return Ok((root.join("data"), root.join("config.toml"), true));
    }
    let data = dirs::data_local_dir()
        .ok_or_else(|| "无法定位应用数据目录。".to_string())?
        .join("CodexBei");
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_string())?;
    let folder = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    if !folder.is_absolute() {
        return Err("CODEX_HOME 必须使用绝对路径。".into());
    }
    Ok((data, folder.join("config.toml"), false))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let (root, file, test_mode) = data_paths().map_err(std::io::Error::other)?;
            if app.config().identifier.ends_with(".test") && !test_mode {
                return Err(std::io::Error::other(
                    "测试应用必须设置 CODEXBEI_TEST_ROOT 隔离目录。",
                )
                .into());
            }
            let service =
                templates::Service::new(root.join("cache")).map_err(std::io::Error::other)?;
            let store = Store::new(root, file).map_err(std::io::Error::other)?;
            app.manage(AppState {
                store: Mutex::new(store),
                incoming: Mutex::new(Incoming {
                    pending: None,
                    last: None,
                    revision: 0,
                }),
                service: tokio::sync::Mutex::new(service),
                test_mode,
            });
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    receive(&handle, url.as_str());
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    receive(app.handle(), url.as_str());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect,
            check,
            update_template,
            choose,
            open_config_file,
            preview,
            configure,
            switch_channel,
            incoming,
            models,
            backups,
            backup_preview,
            restore,
            delete_backup,
            open_chatgpt_installer,
            windows_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("CodexBei failed to start");
}
