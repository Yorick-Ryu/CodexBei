use crate::config::{self, Connection, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mapping {
    pub opus: Option<String>,
    pub sonnet: Option<String>,
    pub haiku: Option<String>,
}

pub fn endpoint(value: &str) -> Result<String> {
    // Share HTTP(S)/credential/query validation with Codex, then remove its API suffix.
    let value = config::endpoint(value)?;
    Ok(value.strip_suffix("/v1").unwrap_or(&value).to_owned())
}
fn document(bytes: Option<&[u8]>) -> Result<Value> {
    let value: Value = match bytes {
        Some(bytes) => serde_json::from_slice(bytes)
            .map_err(|_| "配置不是有效的 JSON，未修改任何配置。".to_string())?,
        None => json!({}),
    };
    if !value.is_object() || value.get("env").is_some_and(|v| !v.is_object()) {
        return Err("settings.json 和 env 必须是 JSON 对象。".into());
    }
    Ok(value)
}
fn encoded(value: &Value) -> Result<Vec<u8>> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "无法生成 JSON 配置。".to_string())?;
    bytes.push(b'\n');
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("生成的配置超过 2 MB，已保留原文件。".into());
    }
    Ok(bytes)
}
fn patch(mut doc: Value, connection: &Connection, mapping: &Mapping) -> Result<Value> {
    if doc.get("env").is_none() {
        doc["env"] = json!({});
    }
    doc["env"]["ANTHROPIC_BASE_URL"] = json!(endpoint(&connection.base_url)?);
    doc["env"]["ANTHROPIC_AUTH_TOKEN"] = json!(connection.api_key);
    doc["env"]["ANTHROPIC_MODEL"] = json!(config::model(&connection.model)?);
    for (name, value) in [
        ("OPUS", &mapping.opus),
        ("SONNET", &mapping.sonnet),
        ("HAIKU", &mapping.haiku),
    ] {
        doc["env"][format!("ANTHROPIC_DEFAULT_{name}_MODEL")] = json!(config::model(
            value.as_deref().unwrap_or(&connection.model)
        )?);
    }
    Ok(doc)
}
// A strict allowlist prevents arbitrary existing settings (hooks, env, headers) leaking in previews.
fn preview_document(doc: &Value) -> Value {
    let mut shown = json!({"env": {}});
    for key in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Some(value) = doc["env"][key].as_str() {
            let valid = if key == "ANTHROPIC_BASE_URL" {
                endpoint(value)
            } else {
                config::model(value)
            };
            if let Ok(value) = valid {
                shown["env"][key] = json!(value);
            }
        }
    }
    if doc["env"].get("ANTHROPIC_AUTH_TOKEN").is_some() {
        shown["env"]["ANTHROPIC_AUTH_TOKEN"] = json!("（已隐藏）");
    }
    shown
}

#[derive(Serialize, Deserialize)]
struct Backup {
    id: String,
    file: PathBuf,
    created: String,
    kind: String,
    existed: bool,
    hash: String,
}
pub struct Store {
    root: PathBuf,
    pub selected: PathBuf,
    default_file: PathBuf,
}
impl Store {
    pub fn new(root: PathBuf, file: PathBuf) -> Result<Self> {
        if !file.is_absolute() {
            return Err("Claude 配置目录必须使用绝对路径。".into());
        }
        config::private_dir(&root)?;
        let root = root
            .canonicalize()
            .map_err(|_| "无法定位备份目录。".to_string())?;
        // Resolve an existing ancestor while allowing a first-time .claude directory.
        let mut ancestor = file.parent().ok_or("配置路径无效。")?;
        let mut suffix = Vec::new();
        while !ancestor.exists() {
            suffix.push(ancestor.file_name().ok_or("配置路径无效。")?.to_owned());
            ancestor = ancestor.parent().ok_or("配置路径无效。")?;
        }
        let mut parent = ancestor
            .canonicalize()
            .map_err(|_| "配置路径无效。".to_string())?;
        for part in suffix.into_iter().rev() {
            parent.push(part);
        }
        let file = parent.join("settings.json");
        Ok(Self {
            root,
            selected: file.clone(),
            default_file: file,
        })
    }
    fn target(&self, file: &Path) -> Result<PathBuf> {
        if !file.is_absolute() || file.file_name().and_then(|v| v.to_str()) != Some("settings.json")
        {
            return Err("请选择 settings.json 文件。".into());
        }
        let parent = file.parent().ok_or("配置路径无效。")?;
        let target = if parent.exists() {
            parent
                .canonicalize()
                .map_err(|_| "配置路径无效。".to_string())?
                .join("settings.json")
        } else if file == self.default_file {
            file.to_owned()
        } else {
            return Err("配置目录不存在。".into());
        };
        config::read(&target)?;
        Ok(target)
    }
    pub fn choose(&mut self, file: PathBuf) -> Result<()> {
        self.selected = self.target(&file)?;
        Ok(())
    }
    pub fn file_for_editor(&self) -> Result<PathBuf> {
        let file = self.target(&self.selected)?;
        if !file.is_file() {
            return Err("配置文件尚未创建，请先完成配置。".into());
        }
        Ok(file)
    }
    pub fn inspect(&self) -> Result<Value> {
        let file = self.target(&self.selected)?;
        let bytes = config::read(&file)?;
        let doc = document(bytes.as_deref())?;
        let env = &doc["env"];
        let base = env["ANTHROPIC_BASE_URL"]
            .as_str()
            .and_then(|v| endpoint(v).ok());
        let key = env["ANTHROPIC_AUTH_TOKEN"]
            .as_str()
            .and_then(|v| config::key(v).ok())
            .unwrap_or_default();
        Ok(
            json!({"file":file,"revision":config::digest(bytes.as_deref()),"baseUrl":base,"apiKey":key,"hasKey":!key.is_empty(),"model":env["ANTHROPIC_MODEL"],
            "mapping":{"opus":env["ANTHROPIC_DEFAULT_OPUS_MODEL"],"sonnet":env["ANTHROPIC_DEFAULT_SONNET_MODEL"],"haiku":env["ANTHROPIC_DEFAULT_HAIKU_MODEL"]},
            "keepOfficialLogin":false,"modelChannel":"api","platform":std::env::consts::OS}),
        )
    }
    pub fn credentials(&self, key: &str, base: &str) -> Result<Connection> {
        let base_url = endpoint(base)?;
        let saved = self.inspect()?;
        let api_key = if key.is_empty() {
            if saved["baseUrl"].as_str() != Some(&base_url) {
                return Err("请输入此地址对应的密钥。".into());
            }
            config::key(saved["apiKey"].as_str().unwrap_or_default())?
        } else {
            config::key(key)?
        };
        Ok(Connection {
            base_url,
            api_key,
            model: String::new(),
        })
    }
    pub fn preview(&self, base: &str, model: &str, mapping: &Mapping) -> Result<String> {
        let doc = document(config::read(&self.target(&self.selected)?)?.as_deref())?;
        let doc = patch(
            doc,
            &Connection {
                base_url: base.into(),
                api_key: "（已隐藏）".into(),
                model: model.into(),
            },
            mapping,
        )?;
        String::from_utf8(encoded(&preview_document(&doc))?).map_err(|_| "预览无效。".into())
    }
    fn snapshot(&self, file: &Path, before: Option<&[u8]>, kind: &str) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let folder = self.root.join(&id);
        config::private_dir(&folder)?;
        if let Some(bytes) = before {
            config::atomic_write(&folder.join("settings.json"), bytes, 0o600)?;
        }
        let meta = Backup {
            id: id.clone(),
            file: file.into(),
            created: chrono::Utc::now().to_rfc3339(),
            kind: kind.into(),
            existed: before.is_some(),
            hash: config::digest(before),
        };
        config::atomic_write(
            &folder.join("metadata.json"),
            &serde_json::to_vec(&meta).map_err(|_| "备份失败。".to_string())?,
            0o600,
        )?;
        Ok(id)
    }
    fn write(
        &self,
        file: &Path,
        before: Option<&[u8]>,
        after: Option<&[u8]>,
        kind: &str,
    ) -> Result<Value> {
        let expected = config::digest(before);
        if config::digest(config::read(file)?.as_deref()) != expected {
            return Err("配置文件已发生变化，请重新操作。".into());
        }
        if !file.parent().unwrap().exists() {
            config::private_dir(file.parent().unwrap())?;
        }
        if self.target(file)? != file {
            return Err("配置目录已改变。".into());
        }
        let id = self.snapshot(file, before, kind)?;
        if config::digest(config::read(file)?.as_deref()) != expected {
            return Err("配置文件已发生变化，请重新操作。".into());
        }
        if let Some(bytes) = after {
            config::atomic_write(file, bytes, 0o600)?;
        } else if before.is_some() {
            fs::remove_file(file).map_err(|_| "无法还原配置文件。".to_string())?;
        }
        if config::digest(config::read(file)?.as_deref()) != config::digest(after) {
            return Err("写入后校验失败，请检查备份。".into());
        }
        let mut result = json!({"file":file,"backupId":id});
        if self.prune(&id).is_err() {
            result["warning"] = json!("配置已保存，但旧备份清理失败。");
        }
        Ok(result)
    }
    pub fn update_connection(&self, update: config::ConnectionUpdate) -> Result<Value> {
        let file = self.target(&self.selected)?;
        let before = config::read(&file)?;
        if update.file != file || update.revision != config::digest(before.as_deref()) {
            return Err("配置在操作期间已变化，请重新读取后重试。".into());
        }
        let base = endpoint(&update.base_url)?;
        let key = config::key(&update.api_key)?;
        let mut doc = document(before.as_deref())?;
        doc["env"]["ANTHROPIC_BASE_URL"] = json!(base);
        doc["env"]["ANTHROPIC_AUTH_TOKEN"] = json!(key);
        let after = encoded(&doc)?;
        if before.as_deref() == Some(after.as_slice()) {
            return Ok(json!({"file":file,"changed":false}));
        }
        self.write(&file, before.as_deref(), Some(&after), "configure")
    }
    pub fn configure(&self, connection: Connection, mapping: &Mapping) -> Result<Value> {
        let mut resolved = self.credentials(&connection.api_key, &connection.base_url)?;
        resolved.model = config::model(&connection.model)?;
        let file = self.target(&self.selected)?;
        let before = config::read(&file)?;
        let after = encoded(&patch(document(before.as_deref())?, &resolved, mapping)?)?;
        self.write(&file, before.as_deref(), Some(&after), "configure")
    }
    fn load(&self, id: &str) -> Result<(Backup, Option<Vec<u8>>)> {
        if Uuid::parse_str(id).ok().map(|u| u.to_string()).as_deref() != Some(id) {
            return Err("备份编号无效。".into());
        }
        let folder = self.root.join(id);
        for path in [&self.root, &folder] {
            let meta = fs::symlink_metadata(path).map_err(|_| "备份不存在。".to_string())?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("备份目录无效。".into());
            }
        }
        let meta: Backup = serde_json::from_slice(
            &config::read(&folder.join("metadata.json"))?.ok_or("备份不存在。")?,
        )
        .map_err(|_| "备份记录损坏。".to_string())?;
        if meta.id != id || !["configure", "restore"].contains(&meta.kind.as_str()) {
            return Err("备份记录损坏。".into());
        }
        let bytes = if meta.existed {
            Some(config::read(&folder.join("settings.json"))?.ok_or("备份内容丢失。")?)
        } else {
            None
        };
        if config::digest(bytes.as_deref()) != meta.hash {
            return Err("备份校验失败。".into());
        }
        Ok((meta, bytes))
    }
    pub fn backup_preview(&self, id: &str) -> Result<Value> {
        let (meta, bytes) = self.load(id)?;
        let shown = preview_document(&document(bytes.as_deref())?);
        Ok(
            json!({"id":id,"file":meta.file,"created":meta.created,"kind":meta.kind,"existed":meta.existed,"baseUrl":shown["env"]["ANTHROPIC_BASE_URL"],"model":shown["env"]["ANTHROPIC_MODEL"],"keepOfficialLogin":false,
            "content": if bytes.is_some() { Some(String::from_utf8(encoded(&shown)?).map_err(|_| "预览无效。".to_string())?) } else { None }}),
        )
    }
    pub fn list(&self) -> Result<Vec<Value>> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|_| "无法读取备份。".to_string())? {
            let entry = entry.map_err(|_| "无法读取备份。".to_string())?;
            if let Some(id) = entry.file_name().to_str() {
                if let Ok(mut v) = self.backup_preview(id) {
                    v.as_object_mut().unwrap().remove("content");
                    result.push(v);
                }
            }
        }
        result.sort_by(|a, b| b["created"].as_str().cmp(&a["created"].as_str()));
        Ok(result)
    }
    pub fn restore_state(&self, id: &str) -> Result<(PathBuf, String)> {
        let (meta, _) = self.load(id)?;
        let file = self.target(&meta.file)?;
        if file != meta.file {
            return Err("备份对应目录已改变，已停止还原。".into());
        }
        Ok((
            file.clone(),
            config::digest(config::read(&file)?.as_deref()),
        ))
    }
    pub fn restore(&self, id: &str, expected: &str) -> Result<Value> {
        let (_, after) = self.load(id)?;
        let (file, current) = self.restore_state(id)?;
        if current != expected {
            return Err("配置文件已发生变化，请重新操作。".into());
        }
        let before = config::read(&file)?;
        self.write(&file, before.as_deref(), after.as_deref(), "restore")
    }
    pub fn validate_backup(&self, id: &str) -> Result<()> {
        self.load(id).map(|_| ())
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        self.validate_backup(id)?;
        trash::delete(self.root.join(id)).map_err(|_| "无法移至废纸篓，备份已保留。".into())
    }
    fn prune(&self, newest: &str) -> Result<()> {
        let mut count = 1;
        for backup in self.list()? {
            let id = backup["id"].as_str().unwrap();
            if id == newest {
                continue;
            }
            if count < 10 {
                count += 1;
            } else {
                self.delete(id)?;
            }
        }
        Ok(())
    }
}

pub async fn check() -> Value {
    let mut installations = Vec::new();
    // Version detection is read-only and also runs with isolated preview configuration.
    let binary = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = vec![PathBuf::from(binary)];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin").join(binary));
    }
    if !cfg!(windows) {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ]);
    }
    for path in candidates {
        if let Ok(output) = crate::versions::command(&path, &["--version"]).await {
            if let Some(version) = output
                .trim()
                .strip_suffix(" (Claude Code)")
                .filter(|v| crate::versions::valid_version(v))
            {
                installations
                    .push(json!({"id":"claude-cli","kind":"claude","runtimeVersion":version}));
                break;
            }
        }
    }
    // The mapping does not depend on an installed version; allow configuring before installation.
    json!({"installations":installations,"selection":{"mode":"auto"},"template":{"id":"claude-builtin","version":"1.0.0","digest":"claude-v1"},"latestTemplate":null,"templateUpdateAvailable":false,"offline":false,"needsSelection":false,"modelClientVersion":"claude"})
}

pub async fn models(connection: Connection) -> Result<Vec<String>> {
    let response = crate::network::api_client()?
        .get(format!("{}/v1/models", endpoint(&connection.base_url)?))
        .header("x-api-key", config::key(&connection.api_key)?)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|_| "模型列表获取失败，请稍后重试。".to_string())?;
    if !response.status().is_success() {
        return Err("无法获取模型，请检查密钥及访问权限。".into());
    }
    let value = crate::network::bounded_json(response, 1024 * 1024).await?;
    let rows = value["data"]
        .as_array()
        .filter(|v| v.len() <= 5000)
        .ok_or("模型列表格式无效。")?;
    let mut models = Vec::new();
    for row in rows {
        let id = config::model(row["id"].as_str().unwrap_or_default())?;
        if !models.contains(&id) {
            models.push(id);
        }
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(
            dir.path().join("backups"),
            dir.path().join(".claude/settings.json"),
        )
        .unwrap();
        let connection = Connection {
            base_url: "https://example.com/gateway/v1/".into(),
            api_key: "sk-claude-test-fixture-only".into(),
            model: "claude-test-model".into(),
        };
        (dir, store, connection)
    }
    #[test]
    fn connection_hot_update_preserves_other_env_and_rejects_stale_edits() {
        let (_dir, store, connection) = fixture();
        store.configure(connection, &Mapping::default()).unwrap();
        let before = config::read(&store.selected).unwrap().unwrap();
        let update = config::ConnectionUpdate {
            file: store.selected.clone(),
            revision: config::digest(Some(&before)),
            base_url: "http://127.0.0.1:8080/v1".into(),
            api_key: "sk-claude-hot-update-fixture".into(),
        };
        store.update_connection(update.clone()).unwrap();
        let mut expected = document(Some(&before)).unwrap();
        expected["env"]["ANTHROPIC_BASE_URL"] = json!("http://127.0.0.1:8080");
        expected["env"]["ANTHROPIC_AUTH_TOKEN"] = json!(update.api_key);
        let after = config::read(&store.selected).unwrap().unwrap();
        assert_eq!(document(Some(&after)).unwrap(), expected);
        assert!(store.update_connection(update).is_err());
        assert_eq!(config::read(&store.selected).unwrap().unwrap(), after);
    }
    #[test]
    fn merges_only_managed_env_and_restores_exact_original() {
        let (_dir, store, connection) = fixture();
        config::private_dir(store.selected.parent().unwrap()).unwrap();
        let original = br#"{ "permissions": {"defaultMode":"default"}, "env":{"OTHER_SECRET":"private-fixture","ANTHROPIC_AUTH_TOKEN":"sk-old-test-fixture-only"}, "hooks": {"private":"hidden-hook-value"}, "theme":"dark" }"#;
        fs::write(&store.selected, original).unwrap();
        let mapping = Mapping {
            opus: Some("claude-other".into()),
            ..Default::default()
        };
        let outcome = store.configure(connection.clone(), &mapping).unwrap();
        let written = document(config::read(&store.selected).unwrap().as_deref()).unwrap();
        assert_eq!(written["permissions"]["defaultMode"], "default");
        assert_eq!(written["env"]["OTHER_SECRET"], "private-fixture");
        assert_eq!(
            written["env"]["ANTHROPIC_BASE_URL"],
            "https://example.com/gateway"
        );
        assert_eq!(
            written["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"],
            "claude-other"
        );
        assert_eq!(
            written["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
            connection.model
        );
        assert_eq!(
            written["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
            connection.model
        );
        let preview = store
            .preview(&connection.base_url, &connection.model, &mapping)
            .unwrap();
        for secret in [&connection.api_key, "private-fixture", "hidden-hook-value"] {
            assert!(!preview.contains(secret));
        }
        let id = outcome["backupId"].as_str().unwrap();
        let preview = store.backup_preview(id).unwrap().to_string();
        assert!(!preview.contains("sk-old-test-fixture-only"));
        assert!(!preview.contains("private-fixture"));
        let (_, hash) = store.restore_state(id).unwrap();
        store.restore(id, &hash).unwrap();
        assert_eq!(fs::read(&store.selected).unwrap(), original);
        assert_eq!(store.list().unwrap().len(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store.selected).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn first_configuration_can_be_undone_and_rejects_stale_restore() {
        let (_dir, store, connection) = fixture();
        let outcome = store.configure(connection, &Mapping::default()).unwrap();
        let id = outcome["backupId"].as_str().unwrap();
        let (_, hash) = store.restore_state(id).unwrap();
        fs::write(&store.selected, b"{}").unwrap();
        assert!(store.restore(id, &hash).is_err());
        let (_, hash) = store.restore_state(id).unwrap();
        store.restore(id, &hash).unwrap();
        assert!(!store.selected.exists());
        assert!(store.backup_preview("../bad").is_err());
    }
    #[test]
    fn invalid_json_and_wrong_gateway_never_reuse_credentials() {
        let (_dir, store, connection) = fixture();
        store
            .configure(connection.clone(), &Mapping::default())
            .unwrap();
        assert!(store.credentials("", "https://other.example.com").is_err());
        assert_eq!(
            store.credentials("", &connection.base_url).unwrap().api_key,
            connection.api_key
        );
        let large = encoded(&json!({"custom": "x".repeat(2 * 1024 * 1024 - 64)})).unwrap();
        fs::write(&store.selected, &large).unwrap();
        assert!(store
            .configure(connection.clone(), &Mapping::default())
            .is_err());
        assert!(fs::read(&store.selected).unwrap() == large);
        for bytes in ["{broken", "[]", "{\"env\":null}"] {
            fs::write(&store.selected, bytes).unwrap();
            assert!(store
                .configure(connection.clone(), &Mapping::default())
                .is_err());
            assert_eq!(fs::read_to_string(&store.selected).unwrap(), bytes);
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_hardlinks_and_tampered_backups() {
        let (dir, store, connection) = fixture();
        let outcome = store
            .configure(connection.clone(), &Mapping::default())
            .unwrap();
        let target = dir.path().join("other.json");
        fs::rename(&store.selected, &target).unwrap();
        std::os::unix::fs::symlink(&target, &store.selected).unwrap();
        assert!(store
            .configure(connection.clone(), &Mapping::default())
            .is_err());
        fs::remove_file(&store.selected).unwrap();
        fs::hard_link(&target, &store.selected).unwrap();
        assert!(store.configure(connection, &Mapping::default()).is_err());
        let id = outcome["backupId"].as_str().unwrap();
        fs::write(store.root.join(id).join("metadata.json"), b"{}").unwrap();
        assert!(store.restore_state(id).is_err());
    }
    #[test]
    fn link_routes_by_tool_and_requires_matching_preset() {
        let base = "codexbei://configure/claude?base_url=https%3A%2F%2Fexample.com%2Fv1&api_key=sk-claude-test-fixture-only&model=claude-test-model&preset=claude-v1";
        let (tool, connection) = config::parse_tool_link(base).unwrap().unwrap();
        assert!(tool == config::Tool::Claude);
        assert_eq!(connection.base_url, "https://example.com");
        assert!(config::parse_tool_link(&base.replace("claude-v1", "codexbei-v1")).is_err());
        assert!(config::parse_tool_link(&format!("{base}&model=duplicate")).is_err());
        assert_eq!(
            endpoint("http://example.com/v1/").unwrap(),
            "http://example.com"
        );
        assert!(endpoint("https://example.com?secret=value").is_err());
        let codex = base
            .replace("/claude?", "/codex?")
            .replace("claude-v1", "codexbei-v1");
        let (tool, connection) = config::parse_tool_link(&codex).unwrap().unwrap();
        assert!(tool == config::Tool::Codex);
        assert_eq!(connection.base_url, "https://example.com/v1");
    }
}
