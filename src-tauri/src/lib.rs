mod claude;
mod config;
mod diagnostics;
mod editor;
mod matching;
mod network;
mod official_auth;
mod providers;
mod redact;
mod templates;
mod versions;
use config::{Connection, Result, Store, Tool};
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
async fn open_config_file(tool: Option<Tool>, state: State<'_, AppState>) -> Result<()> {
    let file = if tool == Some(Tool::Claude) {
        lock(&state.claude)?.file_for_editor()?
    } else {
        lock(&state.store)?.file_for_editor()?
    };
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
        use std::os::windows::process::CommandExt;

        std::process::Command::new("cmd")
            .creation_flags(0x08000000)
            .args([
                "/C",
                "start",
                "",
                "ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS",
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

#[tauri::command]
fn open_claude_installer() -> Result<()> {
    let url = "https://code.claude.com/docs/en/setup";
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        command
            .creation_flags(0x08000000)
            .args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg(url);
        command
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map_err(|_| "无法打开 Claude Code 安装指南。".to_string())?;
    Ok(())
}

struct Incoming {
    pending: Option<Result<(Tool, Connection)>>,
    last: Option<(String, Instant)>,
    revision: u64,
}
struct AppState {
    store: Mutex<Store>,
    claude: Mutex<claude::Store>,
    incoming: Mutex<Incoming>,
    service: tokio::sync::Mutex<matching::Service>,
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
        incoming.pending = match config::parse_tool_link(text) {
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
fn has_official_login(state: State<AppState>) -> Result<bool> {
    Ok(official_auth::detected(&lock(&state.store)?.selected))
}

#[tauri::command]
fn inspect(tool: Option<Tool>, state: State<AppState>) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        let mut value = lock(&state.claude)?.inspect()?;
        value["testMode"] = json!(state.test_mode);
        return Ok(value);
    }
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
    tool: Option<Tool>,
    selection: Option<versions::Selection>,
    force: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        return Ok(claude::check().await);
    }
    state
        .service
        .lock()
        .await
        .refresh(selection, force, false)
        .await
}
#[tauri::command]
async fn update_template(tool: Option<Tool>, state: State<'_, AppState>) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        return Err("Claude Code 使用内置映射。".into());
    }
    state.service.lock().await.refresh(None, true, true).await
}
#[tauri::command]
async fn choose(
    tool: Option<Tool>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter(
            if tool == Some(Tool::Claude) {
                "Claude 配置"
            } else {
                "Codex 配置"
            },
            if tool == Some(Tool::Claude) {
                &["json"]
            } else {
                &["toml"]
            },
        )
        .pick_file(move |path| {
            let _ = send.send(path);
        });
    let path = receive.await.map_err(|_| "文件选择未完成。".to_string())?;
    if let Some(path) = path {
        let path = path
            .into_path()
            .map_err(|_| "请选择本地配置文件。".to_string())?;
        if tool == Some(Tool::Claude) {
            lock(&state.claude)?.choose(path)?;
        } else {
            lock(&state.store)?.choose(path)?;
        }
    }
    inspect(tool, state)
}
#[tauri::command]
async fn preview(
    tool: Option<Tool>,
    mapping: Option<claude::Mapping>,
    base_url: String,
    model: String,
    keep_official_login: bool,
    model_channel: String,
    state: State<'_, AppState>,
) -> Result<String> {
    if tool == Some(Tool::Claude) {
        return lock(&state.claude)?.preview(&base_url, &model, &mapping.unwrap_or_default());
    }
    let template = state.service.lock().await.current()?;
    lock(&state.store)?.preview(
        &base_url,
        &model,
        keep_official_login,
        &model_channel,
        &template,
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
    tool: Option<Tool>,
    mapping: Option<claude::Mapping>,
    connection: Connection,
    keep_official_login: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        let _incoming = lock(&state.incoming)?;
        return lock(&state.claude)?.configure(connection, &mapping.unwrap_or_default());
    }
    let revision = lock(&state.incoming)?.revision;
    let mut service = state.service.lock().await;
    service.refresh(None, true, false).await?;
    let (revision_before, mut resolved) = {
        let store = lock(&state.store)?;
        (
            store.revision()?,
            store.credentials(&connection.api_key, &connection.base_url)?,
        )
    };
    resolved.model = connection.model.clone();
    let version = versions::client_version(&service.targets()?)
        .ok_or_else(|| "未识别到内核版本，请先选择 Codex 版本。".to_string())?;
    let template = service.current()?;
    let catalog = if templates::native_catalog(&template) {
        None
    } else {
        Some(network::catalog(service.client(), resolved.clone(), &version).await?)
    };
    let incoming = lock(&state.incoming)?;
    if incoming.revision != revision {
        return Err("收到新的配置链接，请等待新配置完成。".into());
    }
    let mut store = lock(&state.store)?;
    store.check_revision(&revision_before)?;
    let plan = store.prepare(connection, keep_official_login, &template)?;
    if let Some(catalog) = catalog {
        store.attach_catalog(&plan, &resolved, &catalog)?;
    } else {
        store.attach_native_catalog(&plan, &resolved)?;
    }
    let result = store.apply(&plan)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
fn switch_transport(
    tool: Option<Tool>,
    supports_websockets: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        return Err("Claude Code 不支持此传输协议切换。".into());
    }
    lock(&state.store)?.switch_transport(supports_websockets)
}
#[tauri::command]
async fn switch_channel(
    tool: Option<Tool>,
    channel: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        return Err("Claude Code 不支持此通道切换。".into());
    }
    let (result, pending) = {
        let mut store = lock(&state.store)?;
        let result = store.switch_channel(&channel)?;
        let pending = if channel == "api" {
            Some((store.api_connection()?, store.revision()?))
        } else {
            None
        };
        (result, pending)
    };
    if let Some((connection, revision)) = pending {
        tauri::async_runtime::spawn(async move {
            let _ = sync_catalog(app.state::<AppState>(), connection, revision, false).await;
        });
    }
    Ok(result)
}
#[tauri::command]
async fn incoming(
    tool: Option<Tool>,
    keep_official_login: bool,
    state: State<'_, AppState>,
) -> Result<Value> {
    let (connection, revision) = {
        let mut pending = lock(&state.incoming)?;
        if pending.pending.as_ref().is_some_and(|v| {
            v.as_ref()
                .is_ok_and(|(target, _)| *target != tool.unwrap_or_default())
        }) {
            return Ok(Value::Null);
        }
        (pending.pending.take(), pending.revision)
    };
    let Some(connection) = connection else {
        return Ok(Value::Null);
    };
    let (target, connection) = connection?;
    if target == Tool::Claude {
        let current = lock(&state.incoming)?;
        if current.revision != revision {
            return Ok(Value::Null);
        }
        return lock(&state.claude)?.configure(connection, &claude::Mapping::default());
    }
    let mut service = state.service.lock().await;
    service.refresh(None, true, false).await?;
    let revision_before = lock(&state.store)?.revision()?;
    let version = versions::client_version(&service.targets()?)
        .ok_or_else(|| "未识别到内核版本，请先选择 Codex 版本。".to_string())?;
    let template = service.current()?;
    let catalog = if templates::native_catalog(&template) {
        None
    } else {
        Some(network::catalog(service.client(), connection.clone(), &version).await?)
    };
    let current = lock(&state.incoming)?;
    if current.revision != revision {
        return Ok(Value::Null);
    }
    let mut store = lock(&state.store)?;
    store.check_revision(&revision_before)?;
    let plan = store.prepare(connection.clone(), keep_official_login, &template)?;
    if let Some(catalog) = catalog {
        store.attach_catalog(&plan, &connection, &catalog)?;
    } else {
        store.attach_native_catalog(&plan, &connection)?;
    }
    let result = store.apply(&plan)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
fn incoming_tool(state: State<AppState>) -> Result<Option<Tool>> {
    Ok(lock(&state.incoming)?
        .pending
        .as_ref()
        .and_then(|v| v.as_ref().ok().map(|(tool, _)| *tool)))
}
async fn sync_catalog(
    state: State<'_, AppState>,
    connection: Connection,
    revision: (PathBuf, String),
    create_backup: bool,
) -> Result<Value> {
    let (client, version, native, request) = {
        let service = state.service.lock().await;
        (
            service.client().clone(),
            versions::client_version(&service.targets()?)
                .ok_or_else(|| "未识别到内核版本，请先选择 Codex 版本。".to_string())?,
            templates::native_catalog(&service.current()?),
            versions::request(&service.targets()?),
        )
    };
    if native {
        let mut store = lock(&state.store)?;
        store.check_revision(&revision)?;
        let plan = store.prepare_api_switch()?;
        if !store.attach_native_catalog(&plan, &connection)? {
            return Ok(json!({"changed":false,"native":true}));
        }
        let mut result = store.apply_with_backup(&plan, create_backup)?;
        result["changed"] = json!(true);
        result["native"] = json!(true);
        return Ok(prune_result(&store, result));
    }
    let catalog = network::catalog(&client, connection.clone(), &version).await?;
    // Changing the selected runtimes does not change config.toml; guard that race separately.
    let service = state.service.lock().await;
    if versions::request(&service.targets()?) != request
        || templates::native_catalog(&service.current()?)
    {
        return Err("所选 Codex 版本已变化，请重新刷新。".into());
    }
    let mut store = lock(&state.store)?;
    store.check_revision(&revision)?;
    if store.catalog_matches(&catalog)? {
        return Ok(json!({"changed":false}));
    }
    let plan = store.prepare_api_switch()?;
    store.attach_catalog(&plan, &connection, &catalog)?;
    let mut result = store.apply_with_backup(&plan, create_backup)?;
    result["changed"] = json!(true);
    Ok(prune_result(&store, result))
}
#[tauri::command]
async fn models(
    tool: Option<Tool>,
    api_key: String,
    base_url: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    if tool == Some(Tool::Claude) {
        let connection = lock(&state.claude)?.credentials(&api_key, &base_url)?;
        return claude::models(connection).await;
    }
    let (client, version) = {
        let service = state.service.lock().await;
        (
            service.client().clone(),
            versions::client_version(&service.targets()?)
                .ok_or_else(|| "未识别到内核版本，请先选择 Codex 版本。".to_string())?,
        )
    };
    let connection = lock(&state.store)?.credentials(&api_key, &base_url)?;
    network::models(&client, connection, &version).await
}
#[tauri::command]
fn backups(tool: Option<Tool>, state: State<AppState>) -> Result<Vec<Value>> {
    if tool == Some(Tool::Claude) {
        return lock(&state.claude)?.list();
    }
    lock(&state.store)?.list()
}
#[tauri::command]
fn backup_preview(id: String, tool: Option<Tool>, state: State<AppState>) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        return lock(&state.claude)?.backup_preview(&id);
    }
    lock(&state.store)?.backup_preview(&id)
}
#[tauri::command]
async fn restore(
    tool: Option<Tool>,
    id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    let (file, hash) = if tool == Some(Tool::Claude) {
        lock(&state.claude)?.restore_state(&id)?
    } else {
        lock(&state.store)?.restore_state(&id)?
    };
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
    if tool == Some(Tool::Claude) {
        return lock(&state.claude)?.restore(&id, &hash);
    }
    let mut store = lock(&state.store)?;
    let result = store.restore(&id, &hash)?;
    Ok(prune_result(&store, result))
}
#[tauri::command]
async fn delete_backup(
    tool: Option<Tool>,
    id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value> {
    if tool == Some(Tool::Claude) {
        lock(&state.claude)?.validate_backup(&id)?;
    } else {
        lock(&state.store)?.validate_backup(&id)?;
    }
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
    if tool == Some(Tool::Claude) {
        lock(&state.claude)?.delete(&id)?;
    } else {
        lock(&state.store)?.delete(&id)?;
    }
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
                matching::Service::new(root.join("cache")).map_err(std::io::Error::other)?;
            let claude_file = if test_mode {
                root.join("claude/settings.json")
            } else {
                std::env::var_os("CLAUDE_CONFIG_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| dirs::home_dir().unwrap().join(".claude"))
                    .join("settings.json")
            };
            let claude = claude::Store::new(root.join("claude-backups"), claude_file)
                .map_err(std::io::Error::other)?;
            let store = Store::new(root, file).map_err(std::io::Error::other)?;
            app.manage(AppState {
                store: Mutex::new(store),
                claude: Mutex::new(claude),
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
            has_official_login,
            check,
            update_template,
            choose,
            open_config_file,
            preview,
            configure,
            switch_channel,
            switch_transport,
            incoming,
            incoming_tool,
            models,
            backups,
            backup_preview,
            restore,
            delete_backup,
            open_chatgpt_installer,
            open_claude_installer,
            windows_diagnostics
        ])
        .run(tauri::generate_context!())
        .expect("CodexBei failed to start");
}
