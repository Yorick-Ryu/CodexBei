use crate::{
    claude,
    config::{self, Connection, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

// A separate profile leaves CC Switch and user-created profiles untouched.
const PROFILE: &str = "8a6b4459-8b93-4dc2-a094-b734be1a9190";
const CONFIG: &str = "claude_desktop_config.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub model_discovery: bool,
    pub context_1m: bool,
    #[serde(default)]
    pub allow_all_websites: bool,
    pub models: Vec<String>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            model_discovery: true,
            context_1m: true,
            allow_all_websites: false,
            models: Vec::new(),
        }
    }
}

pub struct Store {
    normal: PathBuf,
    third_party: PathBuf,
    backup: PathBuf,
}

#[derive(Serialize)]
struct Snapshot {
    paths: Vec<PathBuf>,
    before: Vec<Option<Vec<u8>>>,
    after: Vec<Vec<u8>>,
}

fn document(bytes: Option<&[u8]>) -> Result<Value> {
    let value = bytes
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|_| "Claude 桌面版配置不是有效的 JSON，未修改任何文件。")?
        .unwrap_or_else(|| json!({}));
    if !value.is_object() {
        return Err("Claude 桌面版配置必须是 JSON 对象。".into());
    }
    Ok(value)
}

fn encoded(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法生成 Claude 桌面版配置。")?;
    bytes.push(b'\n');
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Claude 桌面版配置超过 2 MB。".into());
    }
    Ok(bytes)
}

fn model_spec(input: &str) -> Result<Value> {
    let (name, supports_1m) = if input.to_ascii_lowercase().ends_with("[1m]") {
        (&input[..input.len() - 4], true)
    } else {
        (input, false)
    };
    let name = config::model(name)?;
    let canonical = name.strip_prefix("anthropic/").unwrap_or(&name);
    if !["sonnet", "opus", "haiku", "fable", "mythos"]
        .iter()
        .any(|tier| {
            canonical
                .strip_prefix(&format!("claude-{tier}-"))
                .is_some_and(|version| version.starts_with(|c: char| c.is_ascii_digit()))
        })
    {
        return Err("Claude 桌面版直连需要完整的 Claude 模型名称（如 claude-sonnet-4-6）；当前模型需要额外的模型映射网关。".into());
    }
    let mut spec = json!({"name": name});
    if supports_1m {
        spec["supports1m"] = json!(true);
    }
    Ok(spec)
}

pub(crate) fn native_model(input: &str) -> bool {
    model_spec(input).is_ok()
}

fn profile(connection: &Connection, options: &Options) -> Result<Value> {
    let mut models = vec![model_spec(&connection.model)?];
    for name in &options.models {
        let spec = model_spec(name)?;
        if !models.iter().any(|item| item["name"] == spec["name"]) {
            models.push(spec);
        }
    }
    // A stable catalog order must not depend on the selected model.
    let model_order = |spec: &Value| {
        let name = spec["name"].as_str().unwrap_or_default();
        let canonical = name.strip_prefix("anthropic/").unwrap_or(name);
        let mut parts = canonical.split('-').skip(1);
        let family = parts.next().unwrap_or_default();
        let rank = ["fable", "opus", "sonnet", "haiku", "mythos"]
            .iter()
            .position(|tier| *tier == family)
            .unwrap_or(5);
        let version: Vec<u32> = parts.filter_map(|part| part.parse().ok()).collect();
        (rank, std::cmp::Reverse(version), name.to_owned())
    };
    models.sort_by_key(model_order);
    if models.len() > 200 {
        return Err("桌面版模型列表最多支持 200 个模型。".into());
    }
    if options.context_1m {
        for model in &mut models {
            model["supports1m"] = json!(true);
        }
    }
    Ok(json!({
        "inferenceProvider": "gateway",
        "inferenceCredentialKind": "static",
        "inferenceGatewayBaseUrl": claude::endpoint(&connection.base_url)?,
        "inferenceGatewayApiKey": if connection.api_key.trim().is_empty() { Value::Null } else { json!(config::key(&connection.api_key)?) },
        "inferenceGatewayAuthScheme": "bearer",
        "inferenceModels": models,
        "modelDiscoveryEnabled": options.model_discovery,
        "modelPrefer1mContext": options.context_1m,
        "coworkEgressAllowedHosts": if options.allow_all_websites { json!(["*"]) } else { json!([]) },
        "builtinBrowserEnabled": true,
        "builtinBrowserBlockedDomains": [],
        "builtinBrowserDefaultDomainPolicy": if options.allow_all_websites { "allow" } else { "block" }
    }))
}

// Modern Windows builds store data in LOCALAPPDATA, including suffixed build names.
// Never choose arbitrarily if multiple installations could own the configuration.
fn windows_directory(root: &Path, third_party: bool) -> Result<PathBuf> {
    let name = if third_party { "Claude-3p" } else { "Claude" };
    let exact = root.join(name);
    if exact.is_dir() {
        return Ok(exact);
    }
    let mut candidates = Vec::new();
    if root.exists() {
        for entry in fs::read_dir(root).map_err(|_| "无法读取 Windows 应用数据目录。")? {
            let entry = entry.map_err(|_| "无法读取 Windows 应用数据目录。")?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("Claude")
                && name.contains("-3p") == third_party
                && entry.path().is_dir()
                && entry.path().join(CONFIG).is_file()
            {
                candidates.push(entry.path());
            }
        }
    }
    match candidates.len() {
        0 => Ok(exact),
        1 => Ok(candidates.remove(0)),
        _ => {
            Err("检测到多个 Claude 桌面版数据目录，请先在 Claude 中确认当前使用的安装版本。".into())
        }
    }
}

impl Store {
    pub fn new(backup: PathBuf, test_root: Option<&Path>) -> Result<Self> {
        let (normal, third_party) = if let Some(root) = test_root {
            (root.join("Claude"), root.join("Claude-3p"))
        } else if cfg!(target_os = "macos") {
            let root = dirs::home_dir()
                .ok_or("无法定位用户目录。")?
                .join("Library/Application Support");
            (root.join("Claude"), root.join("Claude-3p"))
        } else if cfg!(windows) {
            let root = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or("无法定位 LOCALAPPDATA。")?;
            (
                windows_directory(&root, false)?,
                windows_directory(&root, true)?,
            )
        } else {
            return Err("Claude 桌面版配置暂支持 macOS 和 Windows。".into());
        };
        Ok(Self {
            normal,
            third_party,
            backup,
        })
    }

    fn paths(&self) -> Vec<PathBuf> {
        let library = self.third_party.join("configLibrary");
        // Activate the new profile only after its contents have been written.
        vec![
            library.join(format!("{PROFILE}.json")),
            library.join("_meta.json"),
            self.third_party.join(CONFIG),
            self.normal.join(CONFIG),
        ]
    }

    pub fn inspect(&self) -> Result<Value> {
        let paths = self.paths();
        let profile = document(config::read(&paths[0])?.as_deref())?;
        let meta = document(config::read(&paths[1])?.as_deref())?;
        let normal = document(config::read(&paths[3])?.as_deref())?;
        Ok(
            json!({"profilePath": paths[0], "configured": meta["appliedId"] == PROFILE && normal["deploymentMode"] == "3p",
            "models": profile["inferenceModels"].as_array().map(|models| models.iter().filter_map(|model| model["name"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
            "baseUrl": profile["inferenceGatewayBaseUrl"].as_str().and_then(|v| claude::endpoint(v).ok()),
            "model": profile["inferenceModels"][0]["name"].as_str(),
            "hasKey": profile["inferenceGatewayApiKey"].as_str().is_some_and(|key| !key.is_empty()),
            "modelDiscovery": profile["modelDiscoveryEnabled"].as_bool().unwrap_or(true),
            "context1m": profile["modelPrefer1mContext"].as_bool().unwrap_or(true),
            "allowAllWebsites": profile["coworkEgressAllowedHosts"].as_array().is_some_and(|hosts| hosts.iter().any(|host| host == "*"))
                && profile["builtinBrowserDefaultDomainPolicy"].as_str().unwrap_or("allow") == "allow"
                && profile["builtinBrowserEnabled"].as_bool().unwrap_or(false)}),
        )
    }

    pub fn apply(&self, connection: &Connection, options: &Options) -> Result<()> {
        let mut settings = profile(connection, options)?;
        let paths = self.paths();
        let before: Vec<_> = paths
            .iter()
            .map(|p| config::read(p))
            .collect::<Result<_>>()?;
        let mut docs: Vec<_> = before
            .iter()
            .map(|b| document(b.as_deref()))
            .collect::<Result<_>>()?;
        if settings["inferenceGatewayApiKey"].is_null() {
            let saved_key = docs[0]["inferenceGatewayApiKey"]
                .as_str()
                .filter(|key| !key.is_empty());
            if saved_key.is_none() {
                return Err("请输入 API 密钥。".into());
            }
            // Claude may encrypt the stored value. Preserve it verbatim on this device.
            settings["inferenceGatewayApiKey"] = docs[0]["inferenceGatewayApiKey"].clone();
        }
        for (key, value) in settings.as_object().ok_or("无法生成配置。")? {
            docs[0][key] = value.clone();
        }
        // Preserve unrelated settings, including MCP, permissions and other profiles.
        let meta = docs[1].as_object_mut().ok_or("配置索引无效。")?;
        let entries = meta
            .entry("entries")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("Claude 配置索引 entries 必须是数组。")?;
        if let Some(entry) = entries.iter_mut().find(|entry| entry["id"] == PROFILE) {
            entry["name"] = json!("CodexBei");
        } else {
            entries.push(json!({"id": PROFILE, "name": "CodexBei"}));
        }
        meta.insert("appliedId".into(), json!(PROFILE));
        docs[2]["deploymentMode"] = json!("3p");
        docs[3]["deploymentMode"] = json!("3p");
        let after = docs.iter().map(encoded).collect::<Result<Vec<_>>>()?;
        let snapshot = Snapshot {
            paths,
            before,
            after,
        };
        config::private_dir(&self.backup)?;
        // Preserve the pre-write state if an interrupted write needs recovery.
        let record = serde_json::to_vec(&snapshot).map_err(|_| "无法生成桌面配置备份。")?;
        config::atomic_write(
            &self.backup.join(format!("{}.json", uuid::Uuid::new_v4())),
            &record,
            0o600,
        )?;
        for (index, path) in snapshot.paths.iter().enumerate() {
            let result = (|| {
                if config::read(path)? != snapshot.before[index] {
                    return Err("Claude 配置已被其他程序修改，请关闭 Claude 后重试。".into());
                }
                fs::create_dir_all(path.parent().ok_or("配置路径无效。")?)
                    .map_err(|_| "无法创建 Claude 配置目录。")?;
                config::atomic_write(path, &snapshot.after[index], 0o600)
            })();
            if let Err(error) = result {
                // Only revert bytes still owned by this operation.
                let mut restored = true;
                for previous in (0..index).rev() {
                    restored &= restore_one(&snapshot, previous).is_ok();
                }
                return Err(if restored {
                    error
                } else {
                    "配置未完成，部分文件无法自动还原；原始备份已保留。".into()
                });
            }
        }
        Ok(())
    }
}

fn restore_one(snapshot: &Snapshot, index: usize) -> Result<()> {
    let path = &snapshot.paths[index];
    let current = config::read(path)?;
    if current == snapshot.before[index] {
        return Ok(());
    }
    if current.as_deref() != Some(snapshot.after[index].as_slice()) {
        return Err("Claude 配置已改变，已保留当前文件及备份。".into());
    }
    match &snapshot.before[index] {
        Some(bytes) => config::atomic_write(path, bytes, 0o600),
        None => fs::remove_file(path).map_err(|_| "无法撤销新建的 Claude 配置文件。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn website_links_route_to_desktop_and_reject_cli_presets_or_aliases() {
        let link = "codexbei://configure/claude-desktop?base_url=https%3A%2F%2Fexample.com%2Fv1&api_key=sk-test-placeholder&model=claude-fable-5-2&preset=claude-desktop-v1";
        let (target, connection) = config::parse_tool_link(link).unwrap().unwrap();
        assert!(target == config::SetupTarget::ClaudeDesktop);
        assert_eq!(connection.base_url, "https://example.com");
        assert!(config::parse_tool_link(&link.replace("claude-desktop-v1", "claude-v1")).is_err());
        assert!(
            config::parse_tool_link(&link.replace("claude-fable-5-2", "deepseek-flash")).is_err()
        );
        assert!(config::parse_tool_link(&format!("{link}&model=duplicate")).is_err());
    }
    fn connection() -> Connection {
        Connection {
            base_url: "https://example.com/v1".into(),
            api_key: "sk-test-placeholder".into(),
            model: "claude-sonnet-4-6".into(),
        }
    }
    #[test]
    fn model_selection_does_not_change_catalog_order() {
        let options = Options {
            models: vec![
                "claude-sonnet-5-5".into(),
                "claude-fable-5-2".into(),
                "claude-opus-5-5".into(),
            ],
            ..Options::default()
        };
        let mut connection = connection();
        connection.model = "claude-sonnet-5-5".into();
        let first = profile(&connection, &options).unwrap();
        connection.model = "claude-opus-5-5".into();
        let second = profile(&connection, &options).unwrap();
        assert_eq!(first["inferenceModels"], second["inferenceModels"]);
        assert_eq!(first["inferenceModels"][0]["name"], "claude-fable-5-2");
    }

    #[test]
    fn reuses_saved_encrypted_key_when_the_endpoint_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("backup"), Some(dir.path())).unwrap();
        let mut connection = connection();
        store.apply(&connection, &Options::default()).unwrap();
        let path = &store.paths()[0];
        let mut doc = document(config::read(path).unwrap().as_deref()).unwrap();
        doc["inferenceGatewayApiKey"] = json!("encrypted-local-fixture");
        fs::write(path, encoded(&doc).unwrap()).unwrap();
        connection.api_key.clear();
        store.apply(&connection, &Options::default()).unwrap();
        let after = config::read(path).unwrap();
        assert_eq!(
            document(after.as_deref()).unwrap()["inferenceGatewayApiKey"],
            "encrypted-local-fixture"
        );
        connection.base_url = "https://different.example".into();
        store.apply(&connection, &Options::default()).unwrap();
        let updated = document(config::read(path).unwrap().as_deref()).unwrap();
        assert_eq!(
            updated["inferenceGatewayBaseUrl"],
            "https://different.example"
        );
        assert_eq!(updated["inferenceGatewayApiKey"], "encrypted-local-fixture");
    }

    #[test]
    fn preserves_existing_profiles_and_unrelated_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("backup"), Some(dir.path())).unwrap();
        let paths = store.paths();
        fs::create_dir_all(paths[1].parent().unwrap()).unwrap();
        fs::create_dir_all(paths[3].parent().unwrap()).unwrap();
        let meta = br#"{"entries":[{"id":"another","name":"Existing"}],"appliedId":"another","extra":true}"#;
        fs::write(&paths[1], meta).unwrap();
        let normal = b"{\n  \"mcpServers\": {}, \"deploymentMode\": \"1p\"\n}";
        fs::write(&paths[3], normal).unwrap();
        store.apply(&connection(), &Options::default()).unwrap();
        let updated = document(config::read(&paths[1]).unwrap().as_deref()).unwrap();
        assert_eq!(updated["entries"].as_array().unwrap().len(), 2);
        assert_eq!(updated["extra"], true);
        assert!(store.inspect().unwrap()["configured"].as_bool().unwrap());
        assert_eq!(
            document(config::read(&paths[3]).unwrap().as_deref()).unwrap()["mcpServers"],
            json!({})
        );
        assert_eq!(
            store.inspect().unwrap()["models"],
            json!(["claude-sonnet-4-6"])
        );
    }
    #[test]
    fn malformed_metadata_never_changes_any_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("backup"), Some(dir.path())).unwrap();
        let paths = store.paths();
        fs::create_dir_all(paths[1].parent().unwrap()).unwrap();
        fs::write(&paths[1], br#"{"entries":{}}"#).unwrap();
        assert!(store.apply(&connection(), &Options::default()).is_err());
        assert!(!paths[0].exists());
        assert!(!paths[3].exists());
    }
    #[test]
    fn windows_paths_handle_suffix_and_ambiguity() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            windows_directory(dir.path(), false).unwrap(),
            dir.path().join("Claude")
        );
        for name in ["Claude-build-a", "Claude-3p-build-a"] {
            fs::create_dir(dir.path().join(name)).unwrap();
            fs::write(dir.path().join(name).join(CONFIG), b"{}").unwrap();
        }
        assert_eq!(
            windows_directory(dir.path(), false).unwrap(),
            dir.path().join("Claude-build-a")
        );
        assert_eq!(
            windows_directory(dir.path(), true).unwrap(),
            dir.path().join("Claude-3p-build-a")
        );
        fs::create_dir(dir.path().join("Claude-build-b")).unwrap();
        fs::write(dir.path().join("Claude-build-b").join(CONFIG), b"{}").unwrap();
        assert!(windows_directory(dir.path(), false).is_err());
    }
    #[test]
    fn desktop_defaults_enable_discovery_and_one_million_context() {
        let options = Options {
            models: vec!["claude-fable-5-2".into(), "claude-sonnet-4-6".into()],
            ..Options::default()
        };
        let settings = profile(&connection(), &options).unwrap();
        assert_eq!(settings["modelDiscoveryEnabled"], true);
        assert_eq!(settings["modelPrefer1mContext"], true);
        assert_eq!(settings["inferenceModels"].as_array().unwrap().len(), 2);
        assert!(settings["inferenceModels"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["supports1m"] == true));
        let settings = profile(
            &connection(),
            &Options {
                model_discovery: false,
                context_1m: false,
                allow_all_websites: false,
                models: vec![],
            },
        )
        .unwrap();
        assert_eq!(settings["modelDiscoveryEnabled"], false);
        assert_eq!(settings["modelPrefer1mContext"], false);
    }

    #[test]
    fn desktop_network_access_round_trips_and_can_be_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("backup"), Some(dir.path())).unwrap();
        assert_eq!(store.inspect().unwrap()["allowAllWebsites"], false);
        let mut options = Options {
            allow_all_websites: true,
            ..Options::default()
        };
        store.apply(&connection(), &options).unwrap();
        let settings = document(config::read(&store.paths()[0]).unwrap().as_deref()).unwrap();
        assert_eq!(settings["coworkEgressAllowedHosts"], json!(["*"]));
        assert_eq!(settings["builtinBrowserEnabled"], true);
        assert_eq!(settings["builtinBrowserDefaultDomainPolicy"], "allow");
        assert_eq!(store.inspect().unwrap()["allowAllWebsites"], true);
        options.allow_all_websites = false;
        store.apply(&connection(), &options).unwrap();
        let settings = document(config::read(&store.paths()[0]).unwrap().as_deref()).unwrap();
        assert_eq!(settings["coworkEgressAllowedHosts"], json!([]));
        assert_eq!(settings["builtinBrowserDefaultDomainPolicy"], "block");
        assert_eq!(store.inspect().unwrap()["allowAllWebsites"], false);
    }

    #[test]
    fn native_models_translate_context_suffix_and_reject_unsupported_aliases() {
        assert_eq!(
            model_spec("claude-sonnet-4-6[1M]").unwrap(),
            json!({"name":"claude-sonnet-4-6","supports1m":true})
        );
        for name in [
            "sonnet",
            "gpt-6-astra",
            "deepseek-chat",
            "claude-3-5-sonnet",
        ] {
            assert!(model_spec(name).is_err());
        }
        let result = profile(&connection(), &Options::default()).unwrap();
        assert_eq!(result["inferenceGatewayBaseUrl"], "https://example.com");
        assert!(result.get("env").is_none());
    }
}
