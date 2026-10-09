use crate::providers;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};
use toml_edit::{DocumentMut, Item, Table, Value};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: u64 = 2 * 1024 * 1024;
const CHANGED: &str = "配置文件已发生变化，请重新操作。";
fn err(message: &str) -> String {
    message.into()
}
fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| err("无法读写文件，请检查目录和权限。"))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelChannel {
    Api,
    Official,
}
impl ModelChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Official => "official",
        }
    }
}

fn configuration_channel(doc: &DocumentMut, selected: Option<ModelChannel>) -> ModelChannel {
    if let Some(channel) = selected {
        return channel;
    }
    // Reading an existing official config is not an explicit choice to stay official.
    let configured = providers::base(doc, "custom").is_some()
        && item(
            doc,
            &["model_providers", "custom", "experimental_bearer_token"],
        )
        .and_then(Item::as_str)
        .is_some_and(|value| key(value).is_ok());
    if configured
        && doc
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai")
            == "openai"
    {
        ModelChannel::Official
    } else {
        ModelChannel::Api
    }
}

pub fn endpoint(input: &str) -> Result<String> {
    if input.len() > 2048 {
        return Err(err("请输入有效的 HTTPS API 地址。"));
    }
    let mut url =
        url::Url::parse(input.trim()).map_err(|_| err("请输入有效的 HTTPS API 地址。"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(err(
            "API 地址必须使用 HTTPS，且不能包含账号、密码、查询参数或片段。",
        ));
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/v1") {
        path.to_owned()
    } else {
        format!("{path}/v1")
    };
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}
pub fn key(input: &str) -> Result<String> {
    let input = input.trim();
    let value = input.strip_prefix("sk-").unwrap_or("");
    if !(12..=512).contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || input == "sk-your-api-key"
    {
        return Err(err("请提供有效的 API 密钥"));
    }
    Ok(input.to_owned())
}
pub fn model(input: &str) -> Result<String> {
    if input.is_empty()
        || input.len() > 200
        || !input.as_bytes()[0].is_ascii_alphanumeric()
        || !input
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
    {
        return Err(err("请选择有效的模型。"));
    }
    Ok(input.into())
}
#[cfg(test)]
pub fn parse_link(input: &str) -> Result<Option<Connection>> {
    parse_tool_link(input).map(|value| value.map(|(_, connection)| connection))
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    #[default]
    Codex,
    Claude,
}

pub fn parse_tool_link(input: &str) -> Result<Option<(Tool, Connection)>> {
    let invalid = || err("配置链接无效，请从网站重新打开。");
    if input.len() > 8192 {
        return Err(invalid());
    }
    let u = url::Url::parse(input).map_err(|_| invalid())?;
    if u.scheme() != "codexbei"
        || u.host_str() != Some("configure")
        || !["/codex", "/claude"].contains(&u.path())
        || u.port().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(invalid());
    }
    let tool = if u.path() == "/claude" {
        Tool::Claude
    } else {
        Tool::Codex
    };
    let preset = if tool == Tool::Claude {
        "claude-v1"
    } else {
        "codexbei-v1"
    };
    let pairs: Vec<_> = u.query_pairs().collect();
    if pairs.is_empty() {
        return Ok(None);
    }
    let mut fields = std::collections::HashMap::new();
    for (name, value) in pairs {
        if fields
            .insert(name.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(invalid());
        }
    }
    if fields.len() != 4 || fields.get("preset").map(String::as_str) != Some(preset) {
        return Err(invalid());
    }
    let base = fields.get("base_url").ok_or_else(invalid)?;
    Ok(Some((
        tool,
        Connection {
            base_url: if tool == Tool::Claude {
                crate::claude::endpoint(base)?
            } else {
                endpoint(base)?
            },
            api_key: key(fields.get("api_key").ok_or_else(invalid)?)?,
            model: model(fields.get("model").ok_or_else(invalid)?)?,
        },
    )))
}

pub fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return io(Err(e)),
    };
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(err("配置必须是普通文件，不支持符号链接。"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(err("不支持硬链接配置文件。"));
        }
    }
    if meta.len() > LIMIT {
        return Err(err("配置文件超过 2 MB，请手动检查。"));
    }
    Ok(Some(io(fs::read(path))?))
}
fn document(bytes: Option<&[u8]>) -> Result<DocumentMut> {
    let text = std::str::from_utf8(bytes.unwrap_or_default())
        .map_err(|_| err("配置不是有效的 UTF-8 TOML。"))?;
    text.parse()
        .map_err(|_| err("配置不是有效的 TOML，未修改任何配置。"))
}
pub fn digest(bytes: Option<&[u8]>) -> String {
    let mut hash = Sha256::new();
    if let Some(bytes) = bytes {
        hash.update(b"file:");
        hash.update(bytes);
    } else {
        hash.update(b"missing");
    }
    format!("{:x}", hash.finalize())
}
pub(crate) fn private_dir(path: &Path) -> Result<()> {
    io(fs::create_dir_all(path))?;
    let meta = io(fs::symlink_metadata(path))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(err("数据目录必须是普通目录。"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        io(fs::set_permissions(path, fs::Permissions::from_mode(0o700)))?;
    }
    Ok(())
}
pub(crate) fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or_else(|| err("配置路径无效。"))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".codexbei-")
        .tempfile_in(parent)
        .map_err(|_| err("无法创建临时配置文件。"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        io(temp
            .as_file()
            .set_permissions(fs::Permissions::from_mode(mode & 0o777)))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    io(temp.write_all(bytes))?;
    io(temp.as_file().sync_all())?;
    temp.persist(path)
        .map_err(|_| err("无法原子写入配置文件，已保留原文件。"))?;
    Ok(())
}
fn item<'a>(doc: &'a DocumentMut, path: &[&str]) -> Option<&'a Item> {
    let mut current = doc.as_item();
    for part in path {
        current = current.as_table_like()?.get(part)?;
    }
    Some(current)
}
fn backup_summary(bytes: Option<&[u8]>) -> Json {
    let Ok(doc) = document(bytes) else {
        return json!({"baseUrl": null, "model": null, "keepOfficialLogin": false});
    };
    let provider = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .unwrap_or("custom");
    let base = item(&doc, &["model_providers", provider, "base_url"])
        .and_then(Item::as_str)
        .and_then(|v| endpoint(v).ok());
    let selected_model = doc
        .get("model")
        .and_then(Item::as_str)
        .and_then(|v| model(v).ok());
    let keep = item(&doc, &["model_providers", provider, "requires_openai_auth"])
        .and_then(Item::as_bool)
        .unwrap_or(false);
    json!({"baseUrl": base, "model": selected_model, "keepOfficialLogin": keep})
}
fn merge(destination: &mut Item, source: &Json) -> Result<()> {
    if let Some(fields) = source.as_object() {
        if destination.is_none() {
            *destination = Item::Table(Table::new());
        }
        let inline = destination.is_inline_table();
        let table = destination
            .as_table_like_mut()
            .ok_or_else(|| err("配置字段类型冲突，请先检查原文件。"))?;
        for (name, value) in fields {
            if table.get(name).is_none() {
                table.insert(
                    name,
                    if value.is_object() {
                        if inline || name == "http_headers" {
                            Item::Value(Value::InlineTable(Default::default()))
                        } else {
                            let mut table = Table::new();
                            table.set_implicit(true);
                            Item::Table(table)
                        }
                    } else {
                        Item::Value(Value::from(""))
                    },
                );
            }
            merge(table.get_mut(name).unwrap(), value)?;
        }
    } else {
        let mut new_value = match source {
            Json::String(s) => Value::from(s.clone()),
            Json::Bool(b) => Value::from(*b),
            Json::Number(n) => Value::from(n.as_i64().ok_or_else(|| err("模板数值无效。"))?),
            _ => return Err(err("模板字段无效。")),
        };
        if let Some(old) = destination.as_value() {
            *new_value.decor_mut() = old.decor().clone();
        }
        *destination = Item::Value(new_value);
    }
    Ok(())
}
fn preset(
    connection: &Connection,
    keep: bool,
    template: &Json,
    provider: &str,
    channel: ModelChannel,
) -> Json {
    let mut fields = template["set"].clone();
    fields["model"] = json!(connection.model);
    let custom = &mut fields["model_providers"]["custom"];
    custom["base_url"] = json!(connection.base_url);
    custom["experimental_bearer_token"] = json!(connection.api_key);
    custom["http_headers"]["x-openai-actor-authorization"] = json!(connection.base_url);
    custom["requires_openai_auth"] = json!(keep);
    if crate::templates::native_catalog(template) && channel == ModelChannel::Api {
        custom["model_catalog_url"] = json!(format!("{}/models", connection.base_url));
    } else if channel == ModelChannel::Official {
        custom.as_object_mut().unwrap().remove("model_catalog_url");
    }
    let provider_fields = custom.take();
    fields["model_providers"] = json!({ provider: provider_fields });
    fields["model_provider"] = json!(if channel == ModelChannel::Official {
        "openai"
    } else {
        provider
    });
    if channel == ModelChannel::Official {
        if let Some(features) = fields.get_mut("features").and_then(Json::as_object_mut) {
            features.remove("api_key_model_discovery");
            if features.is_empty() {
                fields.as_object_mut().unwrap().remove("features");
            }
        }
    }
    fields
}
pub fn preview(
    base_url: &str,
    selected_model: &str,
    keep: bool,
    channel: &str,
    template: &Json,
) -> Result<String> {
    let c = Connection {
        base_url: endpoint(base_url)?,
        model: model(selected_model)?,
        api_key: "（已隐藏）".into(),
    };
    let mut doc = DocumentMut::new();
    let provider_id = providers::for_write(&DocumentMut::new(), &c.base_url)?;
    let channel = match channel {
        "api" => ModelChannel::Api,
        "official" => ModelChannel::Official,
        _ => return Err(err("未知的模型通道。")),
    };
    merge(
        doc.as_item_mut(),
        &preset(&c, keep, template, &provider_id, channel),
    )?;
    Ok(doc.to_string())
}
fn patch(
    before: Option<&[u8]>,
    c: &Connection,
    keep: bool,
    template: &Json,
    channel: ModelChannel,
) -> Result<Vec<u8>> {
    crate::templates::validate(template)?;
    let mut doc = document(before)?;
    if doc.get("profile").is_some() {
        return Err(err("检测到默认 profile，请选择对应的 .config.toml 文件。"));
    }
    if let Some(custom) = doc
        .get_mut("model_providers")
        .and_then(Item::as_table_like_mut)
        .and_then(|t| t.get_mut("custom"))
    {
        let custom = custom
            .as_table_like_mut()
            .ok_or_else(|| err("custom 必须是 TOML 表。"))?;
        custom.remove("env_key");
        custom.remove("env_key_instructions");
        custom.remove("auth");
        for section in ["http_headers", "env_http_headers"] {
            if let Some(headers) = custom.get_mut(section) {
                let table = headers
                    .as_table_like_mut()
                    .ok_or_else(|| err("请求头必须是 TOML 表。"))?;
                let names: Vec<String> = table
                    .iter()
                    .filter(|(k, _)| {
                        k.eq_ignore_ascii_case("authorization")
                            || (k.eq_ignore_ascii_case("x-openai-actor-authorization")
                                && (section == "env_http_headers"
                                    || *k != "x-openai-actor-authorization"))
                    })
                    .map(|(k, _)| k.to_owned())
                    .collect();
                for name in names {
                    table.remove(&name);
                }
            }
        }
    }
    let provider = providers::for_write(&doc, &c.base_url)?;
    let transport =
        item(&doc, &["model_providers", &provider, "supports_websockets"]).and_then(Item::as_bool);
    let mut fields = preset(c, keep, template, &provider, channel);
    if let Some(enabled) = transport {
        fields["model_providers"][&provider]["supports_websockets"] = json!(enabled);
    }
    merge(doc.as_item_mut(), &fields)?;
    let after = doc.to_string().into_bytes();
    document(Some(&after))?;
    Ok(after)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: String,
    pub target: PathBuf,
    pub kind: String,
    pub created: String,
    pub existed: bool,
    pub before_hash: String,
    pub after_hash: String,
    pub mode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<Json>,
}
struct Plan {
    file: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    created: Instant,
    template: Json,
    catalog: Option<(PathBuf, Vec<u8>, Vec<u8>)>,
    native: Option<(PathBuf, Vec<u8>)>,
}
#[derive(Serialize, Deserialize)]
struct NativeCatalogState {
    provider: String,
    url: String,
    previous_url: Option<String>,
    previous_feature: Option<bool>,
    previous_catalog: Option<String>,
}
pub struct Store {
    pub root: PathBuf,
    pub selected: PathBuf,
    default_file: PathBuf,
    plans: std::collections::HashMap<String, Plan>,
}
impl Store {
    pub fn prepare_api_switch(&mut self) -> Result<String> {
        let file = self.target(&self.selected)?;
        let before = read(&file)?;
        let mut doc = document(before.as_deref())?;
        if doc.get("profile").is_some() {
            return Err(err("请先选择对应的 profile 配置文件。"));
        }
        let provider = self
            .api_provider(&doc)?
            .ok_or_else(|| err("请先完成 API 密钥配置。"))?;
        doc["model_provider"] = toml_edit::value(provider);
        let id = Uuid::new_v4().to_string();
        self.plans.clear();
        self.plans.insert(
            id.clone(),
            Plan {
                file,
                before,
                after: doc.to_string().into_bytes(),
                created: Instant::now(),
                template: Json::Null,
                catalog: None,
                native: None,
            },
        );
        Ok(id)
    }
    pub fn revision(&self) -> Result<(PathBuf, String)> {
        Ok((
            self.selected.clone(),
            digest(read(&self.target(&self.selected)?)?.as_deref()),
        ))
    }
    pub fn check_revision(&self, revision: &(PathBuf, String)) -> Result<()> {
        if &self.revision()? != revision {
            return Err(err(CHANGED));
        }
        Ok(())
    }
    pub fn api_connection(&self) -> Result<Connection> {
        let doc = document(read(&self.target(&self.selected)?)?.as_deref())?;
        let provider = self
            .api_provider(&doc)?
            .ok_or_else(|| err("请先完成 API 密钥配置。"))?;
        let base = item(&doc, &["model_providers", &provider, "base_url"])
            .and_then(Item::as_str)
            .ok_or_else(|| err("API 地址无效。"))?;
        self.credentials("", base)
    }
    fn catalog_path(&self) -> Result<PathBuf> {
        Ok(self
            .target(&self.selected)?
            .parent()
            .ok_or_else(|| err("配置路径无效。"))?
            .join("models_cache_bei.json"))
    }
    fn native_state_path(&self) -> Result<PathBuf> {
        // Profile files can share a directory; recovery state must belong to the selected file.
        Ok(self
            .target(&self.selected)?
            .with_extension("native.previous.json"))
    }
    fn native_state(&self) -> Result<Option<NativeCatalogState>> {
        read(&self.native_state_path()?)?
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|_| err("原生模型目录恢复信息无效。"))
            })
            .transpose()
    }
    fn restore_native(&self, doc: &mut DocumentMut) -> Result<()> {
        let Some(saved) = self.native_state()? else {
            return Ok(());
        };
        if item(
            doc,
            &["model_providers", &saved.provider, "model_catalog_url"],
        )
        .and_then(Item::as_str)
            != Some(saved.url.as_str())
        {
            return Ok(());
        }
        let provider = doc["model_providers"][&saved.provider]
            .as_table_like_mut()
            .ok_or_else(|| err("模型提供商配置无效。"))?;
        provider.remove("model_catalog_url");
        if let Some(value) = saved.previous_url {
            provider.insert("model_catalog_url", toml_edit::value(value));
        }
        if item(doc, &["features", "api_key_model_discovery"]).and_then(Item::as_bool) == Some(true)
        {
            let features = doc["features"]
                .as_table_like_mut()
                .ok_or_else(|| err("功能配置无效。"))?;
            features.remove("api_key_model_discovery");
            if let Some(value) = saved.previous_feature {
                features.insert("api_key_model_discovery", toml_edit::value(value));
            }
        }
        if doc.get("model_catalog_json").is_none() {
            if let Some(value) = saved.previous_catalog {
                doc["model_catalog_json"] = toml_edit::value(value);
            }
        }
        Ok(())
    }
    fn restore_official_catalog(&self, doc: &mut DocumentMut) -> Result<()> {
        self.restore_native(doc)?;
        if doc
            .get("model_catalog_json")
            .and_then(Item::as_str)
            .is_some_and(|path| self.managed_catalog(Path::new(path)))
        {
            let previous = self.original_catalog(doc)?;
            doc.remove("model_catalog_json");
            if let Some(previous) = previous {
                doc["model_catalog_json"] = toml_edit::value(previous);
            }
        }
        Ok(())
    }
    pub fn attach_native_catalog(&mut self, id: &str, connection: &Connection) -> Result<bool> {
        let plan = self.plans.get(id).ok_or_else(|| err("配置预览已过期。"))?;
        // Read originals from the pre-template document, not values already materialized by prepare.
        let before_doc = document(plan.before.as_deref())?;
        let mut original = before_doc.clone();
        self.restore_native(&mut original)?;
        let mut doc = document(Some(&plan.after))?;
        let provider = doc
            .get("model_provider")
            .and_then(Item::as_str)
            .filter(|p| *p != "openai")
            .ok_or_else(|| err("当前未使用 API 通道。"))?
            .to_owned();
        let current = original.get("model_catalog_json").and_then(Item::as_str);
        // Never silently take over a user-owned static catalog.
        let already_native = self.native_state()?.is_some_and(|s| {
            item(
                &before_doc,
                &["model_providers", &s.provider, "model_catalog_url"],
            )
            .and_then(Item::as_str)
                == Some(s.url.as_str())
        });
        if current.is_some_and(|p| !self.managed_catalog(Path::new(p))) && !already_native {
            return Err(err(
                "检测到自定义 model_catalog_json，请先移除该设置后使用原生模型发现。",
            ));
        }
        let saved = NativeCatalogState {
            provider: provider.clone(),
            url: format!("{}/models", endpoint(&connection.base_url)?),
            previous_url: item(
                &original,
                &["model_providers", &provider, "model_catalog_url"],
            )
            .and_then(Item::as_str)
            .map(str::to_owned),
            previous_feature: item(&original, &["features", "api_key_model_discovery"])
                .and_then(Item::as_bool),
            previous_catalog: self.original_catalog(&original)?,
        };
        // A static override wins over discovery, so only the managed override is suspended.
        if let Some(path) = doc.get("model_catalog_json").and_then(Item::as_str) {
            if !self.managed_catalog(Path::new(path)) {
                return Err(err(
                    "检测到自定义 model_catalog_json，请先移除该设置后使用原生模型发现。",
                ));
            }
        }
        doc.remove("model_catalog_json");
        merge(
            doc.as_item_mut(),
            &json!({"model_providers":{&provider:{"model_catalog_url":saved.url}},"features":{"api_key_model_discovery":true}}),
        )?;
        let after = doc.to_string().into_bytes();
        let changed = plan.before.as_deref() != Some(after.as_slice());
        let state_path = self.native_state_path()?;
        let plan = self.plans.get_mut(id).unwrap();
        plan.after = after;
        plan.native = Some((state_path, serde_json::to_vec(&saved).unwrap()));
        Ok(changed)
    }
    pub fn catalog_matches(&self, catalog: &Json) -> Result<bool> {
        let doc = document(read(&self.target(&self.selected)?)?.as_deref())?;
        if self.native_state()?.is_some_and(|saved| {
            item(
                &doc,
                &["model_providers", &saved.provider, "model_catalog_url"],
            )
            .and_then(Item::as_str)
                == Some(saved.url.as_str())
        }) {
            return Ok(false);
        }
        let path = self.catalog_path()?;
        if doc.get("model_catalog_json").and_then(Item::as_str) != path.to_str() {
            return Ok(false);
        }
        Ok(read(&path)?
            .and_then(|b| serde_json::from_slice::<Json>(&b).ok())
            .as_ref()
            == Some(catalog))
    }
    fn managed_catalog(&self, path: &Path) -> bool {
        if self.catalog_path().ok().as_deref() == Some(path) {
            return path.with_extension("previous.json").is_file();
        }
        let legacy = path.parent() == Some(self.root.join("catalogs").as_path());
        let current = self.catalog_path().ok().is_some_and(|file| {
            path.parent() == Some(file.parent().unwrap().join("catalogs").as_path())
        });
        let stem = path
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        let hash = if legacy {
            Some(stem)
        } else if current {
            stem.strip_prefix("catalog-")
        } else {
            None
        };
        path.extension().is_some_and(|v| v == "json")
            && hash.is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            && path.with_extension("previous.json").is_file()
    }
    fn original_catalog(&self, doc: &DocumentMut) -> Result<Option<String>> {
        let current = doc.get("model_catalog_json").and_then(Item::as_str);
        if let Some(path) = current {
            let path = Path::new(path);
            if self.managed_catalog(path) {
                let bytes = read(&path.with_extension("previous.json"))?
                    .ok_or_else(|| err("模型目录恢复信息缺失，已保留配置。"))?;
                return serde_json::from_slice(&bytes).map_err(|_| err("模型目录恢复信息无效。"));
            }
        }
        Ok(current.map(str::to_owned))
    }
    pub fn attach_catalog(
        &mut self,
        id: &str,
        _connection: &Connection,
        catalog: &Json,
    ) -> Result<()> {
        if crate::network::model_list(catalog)?.is_empty() {
            return Err(err("没有可用模型。"));
        }
        let plan = self.plans.get(id).ok_or_else(|| err("配置预览已过期。"))?;
        let mut doc = document(Some(&plan.after))?;
        self.restore_native(&mut doc)?;
        let previous = self.original_catalog(&doc)?;
        let bytes = serde_json::to_vec(catalog).map_err(|_| err("模型目录无效。"))?;
        let previous_bytes = serde_json::to_vec(&previous).unwrap();
        let path = self.catalog_path()?;
        doc["model_catalog_json"] =
            toml_edit::value(path.to_str().ok_or_else(|| err("模型目录路径无效。"))?);
        self.plans.get_mut(id).unwrap().after = doc.to_string().into_bytes();
        self.plans.get_mut(id).unwrap().catalog = Some((path, bytes, previous_bytes));
        Ok(())
    }
    pub fn new(root: PathBuf, default_file: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        let root = io(root.canonicalize())?;
        // Canonicalize the existing ancestor before creating a missing Codex directory.
        // macOS temporary/home paths may have /var -> /private/var aliases.
        let mut ancestor = default_file.parent().ok_or_else(|| err("配置路径无效。"))?;
        let mut suffix = Vec::new();
        while !ancestor.exists() {
            suffix.push(
                ancestor
                    .file_name()
                    .ok_or_else(|| err("配置路径无效。"))?
                    .to_owned(),
            );
            ancestor = ancestor.parent().ok_or_else(|| err("配置路径无效。"))?;
        }
        let mut parent = io(ancestor.canonicalize())?;
        for part in suffix.into_iter().rev() {
            parent.push(part);
        }
        let default_file = parent.join(
            default_file
                .file_name()
                .ok_or_else(|| err("配置路径无效。"))?,
        );
        private_dir(&root.join("backups"))?;
        Ok(Self {
            selected: default_file.clone(),
            default_file,
            root,
            plans: Default::default(),
        })
    }
    fn target(&self, file: &Path) -> Result<PathBuf> {
        let name = file
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| err("配置路径无效。"))?;
        let archive = name.strip_suffix(".config.toml").is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        });
        if !file.is_absolute() || (name != "config.toml" && !archive) {
            return Err(err("请选择 config.toml 或 *.config.toml 文件。"));
        }
        let parent = file.parent().unwrap();
        let parent = if parent.exists() {
            io(parent.canonicalize())?
        } else if file == self.default_file {
            let ancestor = parent.parent().ok_or_else(|| err("配置目录无效。"))?;
            io(ancestor.canonicalize())?.join(parent.file_name().unwrap())
        } else {
            return Err(err("选择的配置目录不存在。"));
        };
        let target = parent.join(name);
        read(&target)?;
        Ok(target)
    }
    pub fn choose(&mut self, path: PathBuf) -> Result<()> {
        self.selected = self.target(&path)?;
        self.plans.clear();
        Ok(())
    }
    pub fn file_for_editor(&self) -> Result<PathBuf> {
        let file = self.target(&self.selected)?;
        if !file.is_file() {
            return Err(err("配置文件尚未创建，请先完成配置。"));
        }
        Ok(file)
    }
    fn api_provider(&self, doc: &DocumentMut) -> Result<Option<String>> {
        Ok(providers::base(doc, "custom").map(|_| "custom".into()))
    }
    fn saved_provider(&self, doc: &DocumentMut, base_url: &str) -> Result<Option<String>> {
        if let Some(provider) = self.api_provider(doc)? {
            if providers::base(doc, &provider).as_deref() == Some(base_url) {
                return Ok(Some(provider));
            }
        }
        Ok(providers::for_read(doc, base_url))
    }
    pub fn preview(
        &self,
        base_url: &str,
        model: &str,
        keep: bool,
        channel: Option<ModelChannel>,
        template: &Json,
    ) -> Result<String> {
        let doc = document(read(&self.target(&self.selected)?)?.as_deref())?;
        let channel = configuration_channel(&doc, channel);
        let base_url = endpoint(base_url)?;
        let provider = providers::for_write(&doc, &base_url)?;
        let shown = preview(&base_url, model, keep, channel.as_str(), template)?;
        let mut value: Json = toml_edit::de::from_str(&shown).map_err(|_| err("配置预览无效。"))?;
        let fields = value["model_providers"]["custom"].take();
        value["model_providers"] = json!({ &provider: fields });
        if let Some(enabled) = item(&doc, &["model_providers", &provider, "supports_websockets"])
            .and_then(Item::as_bool)
        {
            value["model_providers"][&provider]["supports_websockets"] = json!(enabled);
        }
        if channel == ModelChannel::Api {
            value["model_provider"] = json!(provider);
        }
        let mut result = DocumentMut::new();
        merge(result.as_item_mut(), &value)?;
        Ok(result.to_string())
    }
    pub fn inspect(&self) -> Result<Json> {
        let file = self.target(&self.selected)?;
        let bytes = read(&file)?;
        let doc = document(bytes.as_deref())?;
        let provider = self.api_provider(&doc)?;
        let custom = ["model_providers", provider.as_deref().unwrap_or("")];
        let base = item(&doc, &[custom[0], custom[1], "base_url"])
            .and_then(Item::as_str)
            .and_then(|v| endpoint(v).ok());
        let selected_model = doc
            .get("model")
            .and_then(Item::as_str)
            .and_then(|v| model(v).ok());
        let has_key = item(&doc, &[custom[0], custom[1], "experimental_bearer_token"])
            .and_then(Item::as_str)
            .is_some_and(|v| key(v).is_ok());
        let model_channel = if doc.is_empty()
            || (provider.is_some()
                && doc.get("model_provider").and_then(Item::as_str) == provider.as_deref())
        {
            "api"
        } else {
            "official"
        };
        Ok(
            json!({ "file": file, "baseUrl": base, "model": selected_model, "hasKey": has_key, "modelChannel": model_channel, "supportsWebsockets": item(&doc, &[custom[0], custom[1], "supports_websockets"]).and_then(Item::as_bool).unwrap_or(false), "keepOfficialLogin": item(&doc, &[custom[0], custom[1], "requires_openai_auth"]).and_then(Item::as_bool).unwrap_or(false), "platform": std::env::consts::OS }),
        )
    }
    pub fn configuration_channel(&self, selected: Option<ModelChannel>) -> Result<ModelChannel> {
        let doc = document(read(&self.target(&self.selected)?)?.as_deref())?;
        Ok(configuration_channel(&doc, selected))
    }
    pub fn prepare(
        &mut self,
        mut c: Connection,
        keep: bool,
        template: &Json,
        channel: Option<ModelChannel>,
    ) -> Result<String> {
        c.base_url = endpoint(&c.base_url)?;
        c.model = model(&c.model)?;
        let file = self.target(&self.selected)?;
        let before = read(&file)?;
        let mut doc = document(before.as_deref())?;
        let channel = configuration_channel(&doc, channel);
        if c.api_key.is_empty() {
            let provider = self
                .saved_provider(&doc, &c.base_url)?
                .ok_or_else(|| err("API 地址已更改或没有可复用密钥，请填写对应密钥。"))?;
            let saved = item(&doc, &["model_providers", &provider, "base_url"])
                .and_then(Item::as_str)
                .and_then(|v| endpoint(v).ok());
            if saved.as_deref() != Some(c.base_url.as_str()) {
                return Err(err("API 地址已更改或没有可复用密钥，请填写对应密钥。"));
            }
            c.api_key = item(
                &doc,
                &["model_providers", &provider, "experimental_bearer_token"],
            )
            .and_then(Item::as_str)
            .unwrap_or_default()
            .into();
        }
        c.api_key = key(&c.api_key)?;
        if channel == ModelChannel::Official {
            self.restore_official_catalog(&mut doc)?;
        }
        let after = patch(
            Some(doc.to_string().as_bytes()),
            &c,
            keep,
            template,
            channel,
        )?;
        let id = Uuid::new_v4().to_string();
        self.plans.clear();
        self.plans.insert(
            id.clone(),
            Plan {
                file,
                before,
                after,
                created: Instant::now(),
                template: json!({"id":template["id"],"version":template["version"],"digest":crate::templates::digest(template)}),
                catalog: None,
                native: None,
            },
        );
        Ok(id)
    }
    fn snapshot(
        &self,
        target: &Path,
        before: Option<&[u8]>,
        after: Option<&[u8]>,
        kind: &str,
        template: Option<Json>,
    ) -> Result<Metadata> {
        let backup_dir = self.root.join("backups");
        private_dir(&backup_dir)?;
        let id = Uuid::new_v4().to_string();
        let folder = backup_dir.join(&id);
        private_dir(&folder)?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(target)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0o600)
        };
        #[cfg(not(unix))]
        let mode = 0o600;
        let metadata = Metadata {
            id,
            target: target.into(),
            kind: kind.into(),
            created: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            existed: before.is_some(),
            before_hash: digest(before),
            after_hash: digest(after),
            mode,
            template,
        };
        if let Some(bytes) = before {
            atomic_write(&folder.join("config.toml"), bytes, 0o600)?;
        }
        atomic_write(
            &folder.join("metadata.json"),
            &serde_json::to_vec(&metadata).unwrap(),
            0o600,
        )?;
        Ok(metadata)
    }
    pub fn apply(&mut self, id: &str) -> Result<Json> {
        self.apply_with_backup(id, true)
    }
    pub fn apply_with_backup(&mut self, id: &str, create_backup: bool) -> Result<Json> {
        let plan = self
            .plans
            .remove(id)
            .ok_or_else(|| err("配置预览已过期，请重新操作。"))?;
        if plan.created.elapsed().as_secs() > 600
            || self.target(&plan.file)? != plan.file
            || digest(read(&plan.file)?.as_deref()) != digest(plan.before.as_deref())
        {
            return Err(err(CHANGED));
        }
        if !self.selected.parent().unwrap().exists() && self.selected == self.default_file {
            private_dir(self.selected.parent().unwrap())?;
        }
        let backup = if create_backup {
            Some(self.snapshot(
                &plan.file,
                plan.before.as_deref(),
                Some(&plan.after),
                "configure",
                Some(plan.template),
            )?)
        } else {
            None
        };
        if digest(read(&plan.file)?.as_deref()) != digest(plan.before.as_deref()) {
            return Err(err(CHANGED));
        }
        let mut writes = Vec::new();
        if let Some((path, bytes, previous)) = &plan.catalog {
            writes.push((path.with_extension("previous.json"), previous));
            writes.push((path.clone(), bytes));
        }
        if let Some((path, bytes)) = &plan.native {
            writes.push((path.clone(), bytes));
        }
        if !writes.is_empty() {
            let old: Vec<_> = writes
                .iter()
                .map(|(path, _)| read(path).map(|bytes| (path, bytes)))
                .collect::<Result<_>>()?;
            let result = (|| {
                for (path, bytes) in &writes {
                    atomic_write(path, bytes, 0o600)?;
                }
                atomic_write(&plan.file, &plan.after, 0o600)
            })();
            if let Err(error) = result {
                for (file, saved) in old {
                    if let Some(saved) = saved {
                        atomic_write(file, &saved, 0o600)?;
                    } else if file.exists() {
                        io(fs::remove_file(file))?;
                    }
                }
                return Err(error);
            }
        } else {
            atomic_write(&plan.file, &plan.after, 0o600)?;
        }
        if digest(read(&plan.file)?.as_deref()) != digest(Some(&plan.after)) {
            return Err(err("写入后校验失败，请从备份还原。"));
        }
        let mut result = json!({ "file": plan.file });
        if let Some(backup) = backup {
            result["backupId"] = json!(backup.id);
        }
        Ok(result)
    }
    pub fn switch_transport(&mut self, supports_websockets: bool) -> Result<Json> {
        let file = self.target(&self.selected)?;
        let before = read(&file)?;
        let mut doc = document(before.as_deref())?;
        if doc.get("profile").is_some() {
            return Err(err("检测到默认 profile，请选择对应的 .config.toml 文件。"));
        }
        let provider = self
            .api_provider(&doc)?
            .ok_or_else(|| err("请先完成 API 密钥配置。"))?;
        if item(&doc, &["model_providers", &provider, "supports_websockets"])
            .and_then(Item::as_bool)
            == Some(supports_websockets)
        {
            return Ok(json!({ "file": file, "changed": false }));
        }
        merge(
            doc.as_item_mut(),
            &json!({ "model_providers": { &provider: { "supports_websockets": supports_websockets } } }),
        )?;
        let after = doc.to_string().into_bytes();
        document(Some(&after))?;
        if digest(read(&file)?.as_deref()) != digest(before.as_deref()) {
            return Err(err(CHANGED));
        }
        atomic_write(&file, &after, 0o600)?;
        if digest(read(&file)?.as_deref()) != digest(Some(&after)) {
            return Err(err("传输协议写入后校验失败，请重新读取配置后重试。"));
        }
        self.plans.clear();
        Ok(json!({ "file": file, "changed": true }))
    }
    pub fn switch_channel(&mut self, channel: &str) -> Result<Json> {
        let file = self.target(&self.selected)?;
        let before = read(&file)?;
        let mut doc = document(before.as_deref())?;
        let api_provider = self.api_provider(&doc)?;
        let provider = match channel {
            "api" => api_provider
                .as_deref()
                .ok_or_else(|| err("请先完成 API 密钥配置。"))?,
            "official" => "openai",
            _ => return Err(err("模型通道无效。")),
        };
        if doc.get("profile").is_some() {
            return Err(err("检测到默认 profile，请选择对应的 .config.toml 文件。"));
        }
        if channel == "api" {
            let valid_base = item(&doc, &["model_providers", provider, "base_url"])
                .and_then(Item::as_str)
                .is_some_and(|value| endpoint(value).is_ok());
            let valid_key = item(
                &doc,
                &["model_providers", provider, "experimental_bearer_token"],
            )
            .and_then(Item::as_str)
            .is_some_and(|value| key(value).is_ok());
            if !valid_base || !valid_key {
                return Err(err("请先完成 API 密钥配置。"));
            }
        }
        let current = doc
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai")
            .to_owned();
        if channel == "official" {
            self.restore_official_catalog(&mut doc)?;
        }
        if current == provider
            && doc.to_string().as_bytes() == before.as_deref().unwrap_or_default()
        {
            return Ok(json!({ "file": file, "changed": false }));
        }
        merge(doc.as_item_mut(), &json!({ "model_provider": provider }))?;
        let after = doc.to_string().into_bytes();
        document(Some(&after))?;
        if !file.parent().unwrap().exists() && file == self.default_file {
            private_dir(file.parent().unwrap())?;
        }
        if digest(read(&file)?.as_deref()) != digest(before.as_deref()) {
            return Err(err(CHANGED));
        }
        atomic_write(&file, &after, 0o600)?;
        if digest(read(&file)?.as_deref()) != digest(Some(&after)) {
            return Err(err("通道写入后校验失败，请重新读取配置后重试。"));
        }
        self.plans.clear();
        Ok(json!({ "file": file, "changed": true }))
    }
    fn load(&self, id: &str) -> Result<(Metadata, Option<Vec<u8>>)> {
        if Uuid::parse_str(id).ok().map(|u| u.to_string()).as_deref() != Some(id) {
            return Err(err("备份编号无效。"));
        }
        let root = self.root.join("backups");
        let folder = root.join(id);
        for path in [&root, &folder] {
            let m = io(fs::symlink_metadata(path))?;
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(err("备份目录无效。"));
            }
        }
        let data = read(&folder.join("metadata.json"))?.ok_or_else(|| err("备份记录不存在。"))?;
        let meta: Metadata = serde_json::from_slice(&data).map_err(|_| err("备份记录损坏。"))?;
        if meta.id != id
            || !["configure", "restore", "switch", "switch-channel"].contains(&meta.kind.as_str())
        {
            return Err(err("备份记录损坏。"));
        }
        let bytes = if meta.existed {
            Some(read(&folder.join("config.toml"))?.ok_or_else(|| err("备份内容丢失。"))?)
        } else {
            None
        };
        if digest(bytes.as_deref()) != meta.before_hash {
            return Err(err("备份校验失败，已停止操作。"));
        }
        Ok((meta, bytes))
    }
    pub fn list(&self) -> Result<Vec<Json>> {
        let mut results = Vec::new();
        for entry in io(fs::read_dir(self.root.join("backups")))? {
            let entry = io(entry)?;
            if let Some(id) = entry.file_name().to_str() {
                if let Ok((m, bytes)) = self.load(id) {
                    let summary = backup_summary(bytes.as_deref());
                    results.push(json!({"id": m.id, "file": m.target, "created": m.created, "kind": m.kind, "existed": m.existed, "baseUrl": summary["baseUrl"], "keepOfficialLogin": summary["keepOfficialLogin"]}));
                }
            }
        }
        results.sort_by(|a, b| b["created"].as_str().cmp(&a["created"].as_str()));
        Ok(results)
    }
    pub fn backup_preview(&self, id: &str) -> Result<Json> {
        let (meta, bytes) = self.load(id)?;
        // Only allowlisted metadata and redacted TOML cross IPC.
        let summary = backup_summary(bytes.as_deref());
        Ok(
            json!({"id": meta.id, "file": meta.target, "created": meta.created, "kind": meta.kind, "existed": meta.existed, "baseUrl": summary["baseUrl"], "keepOfficialLogin": summary["keepOfficialLogin"], "model": summary["model"], "content": bytes.as_deref().map(crate::redact::preview).transpose()?}),
        )
    }
    pub fn restore_state(&self, id: &str) -> Result<(PathBuf, String)> {
        let (meta, _) = self.load(id)?;
        let file = self.target(&meta.target)?;
        if file != meta.target {
            return Err(err("备份对应目录已改变，已停止还原。"));
        }
        Ok((file.clone(), digest(read(&file)?.as_deref())))
    }
    pub fn restore(&mut self, id: &str, expected: &str) -> Result<Json> {
        let (meta, after) = self.load(id)?;
        let (file, current) = self.restore_state(id)?;
        if current != expected {
            return Err(err(CHANGED));
        }
        let before = read(&file)?;
        if !file.parent().unwrap().exists() && file == self.default_file {
            private_dir(file.parent().unwrap())?;
        }
        let backup = self.snapshot(&file, before.as_deref(), after.as_deref(), "restore", None)?;
        if digest(read(&file)?.as_deref()) != current {
            return Err(err(CHANGED));
        }
        if let Some(bytes) = &after {
            atomic_write(&file, bytes, meta.mode)?;
        } else if before.is_some() {
            io(fs::remove_file(&file))?;
        }
        if digest(read(&file)?.as_deref()) != meta.before_hash {
            return Err(err("还原后校验失败，请检查备份。"));
        }
        self.plans.clear();
        Ok(json!({ "file": file, "backupId": backup.id }))
    }
    pub fn credentials(&self, api_key: &str, base_url: &str) -> Result<Connection> {
        let base_url = endpoint(base_url)?;
        let api_key = if api_key.is_empty() {
            let doc = document(read(&self.target(&self.selected)?)?.as_deref())?;
            let provider = self
                .saved_provider(&doc, &base_url)?
                .ok_or_else(|| err("请输入此地址对应的密钥。"))?;
            if item(&doc, &["model_providers", &provider, "base_url"])
                .and_then(Item::as_str)
                .and_then(|v| endpoint(v).ok())
                .as_deref()
                != Some(base_url.as_str())
            {
                return Err(err("请输入此地址对应的密钥。"));
            }
            key(item(
                &doc,
                &["model_providers", &provider, "experimental_bearer_token"],
            )
            .and_then(Item::as_str)
            .unwrap_or_default())?
        } else {
            key(api_key)?
        };
        Ok(Connection {
            base_url,
            api_key,
            model: String::new(),
        })
    }
    pub fn validate_backup(&self, id: &str) -> Result<()> {
        self.load(id).map(|_| ())
    }
    pub fn prune(&self, newest: &str) -> Result<()> {
        let mut retained = std::collections::HashSet::from([newest.to_string()]);
        for backup in self.list()? {
            let id = backup["id"].as_str().unwrap();
            if retained.contains(id) {
                continue;
            }
            if retained.len() < 10 {
                retained.insert(id.to_string());
            } else {
                self.delete(id)?;
            }
        }
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        self.load(id)?;
        trash::delete(self.root.join("backups").join(id))
            .map_err(|_| err("无法移至废纸篓，备份已保留。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        Connection {
            api_key: "sk-trial-fixture-0123456789".into(),
            base_url: "https://example.com/v1".into(),
            model: "gpt-6-astra".into(),
        }
    }
    fn template() -> Json {
        serde_json::from_str::<Json>(include_str!("../../templates/bootstrap.json")).unwrap()
            ["templates"][0]
            .clone()
    }
    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::new(dir.path().join("data"), dir.path().join("config.toml")).unwrap();
        (dir, s)
    }
    #[test]
    fn first_configuration_uses_api_even_when_existing_config_is_official() {
        for before in [
            None,
            Some("model = 'old'\n"),
            Some("model_provider = 'openai'\n"),
            Some("model_provider = 'openai'\n[model_providers.custom]\nbase_url = 'https://example.com/v1'\n"),
            Some("model_provider = 'openai'\n[model_providers.custom]\nbase_url = 'https://example.com/v1'\nexperimental_bearer_token = 'invalid'\n"),
        ] {
            let (_dir, mut s) = store();
            if let Some(before) = before {
                fs::write(&s.selected, before).unwrap();
            }
            let c = connection();
            assert_eq!(s.configuration_channel(None).unwrap(), ModelChannel::Api);
            let shown = s.preview(&c.base_url, &c.model, true, None, &template()).unwrap();
            assert_eq!(shown.parse::<DocumentMut>().unwrap()["model_provider"].as_str(), Some("custom"));
            let id = s.prepare(c, true, &template(), None).unwrap();
            s.apply(&id).unwrap();
            assert_eq!(s.inspect().unwrap()["modelChannel"], "api");
        }
    }

    #[test]
    fn reconfiguration_preserves_current_channel_after_reopening_and_updates_api() {
        for channel in ["api", "official"] {
            for native in [false, true] {
                let (_dir, mut s) = store();
                let mut c = connection();
                let id = s.prepare(c.clone(), true, &template(), None).unwrap();
                s.apply(&id).unwrap();
                s.switch_channel(channel).unwrap();
                // No in-memory first-run flag or UI selection is needed after restart.
                let mut s = Store::new(s.root.clone(), s.selected.clone()).unwrap();
                let template = if native {
                    serde_json::from_str::<Json>(include_str!("../../templates/bootstrap.json"))
                        .unwrap()["templates"][1]
                        .clone()
                } else {
                    template()
                };
                c.base_url = "https://updated.example/v1".into();
                c.api_key = "sk-updated-fixture-0123456789".into();
                let shown = s
                    .preview(&c.base_url, &c.model, false, None, &template)
                    .unwrap();
                let id = s.prepare(c.clone(), false, &template, None).unwrap();
                s.apply(&id).unwrap();
                let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
                assert_eq!(s.inspect().unwrap()["modelChannel"], channel);
                assert_eq!(
                    doc["model_providers"]["custom"]["base_url"].as_str(),
                    Some(c.base_url.as_str())
                );
                assert_eq!(
                    doc["model_providers"]["custom"]["experimental_bearer_token"].as_str(),
                    Some(c.api_key.as_str())
                );
                assert_eq!(
                    doc["model_provider"].as_str(),
                    shown.parse::<DocumentMut>().unwrap()["model_provider"].as_str()
                );
                if channel == "official" {
                    assert!(item(&doc, &["features", "api_key_model_discovery"]).is_none());
                    assert!(
                        item(&doc, &["model_providers", "custom", "model_catalog_url"]).is_none()
                    );
                    assert!(doc.get("model_catalog_json").is_none());
                }
            }
        }
    }

    #[test]
    fn explicit_channel_overrides_first_setup_and_website_links_activate_api() {
        let (_dir, mut s) = store();
        let c = connection();
        let id = s
            .prepare(c.clone(), true, &template(), Some(ModelChannel::Official))
            .unwrap();
        s.apply(&id).unwrap();
        assert_eq!(s.inspect().unwrap()["modelChannel"], "official");
        let link = format!(
            "codexbei://configure/codex?base_url={}&api_key={}&model={}&preset=codexbei-v1",
            c.base_url, c.api_key, c.model
        );
        let (_, incoming) = parse_tool_link(&link).unwrap().unwrap();
        let id = s
            .prepare(incoming, true, &template(), Some(ModelChannel::Api))
            .unwrap();
        s.apply(&id).unwrap();
        assert_eq!(s.inspect().unwrap()["modelChannel"], "api");

        // A different selected file gets its own first-setup decision.
        let other = s.selected.with_file_name("other.config.toml");
        fs::write(&other, "model_provider = 'openai'\n").unwrap();
        s.choose(other).unwrap();
        assert_eq!(s.configuration_channel(None).unwrap(), ModelChannel::Api);
    }

    #[test]
    fn saving_official_preserves_original_catalog_settings_for_both_templates() {
        for native in [false, true] {
            let (_dir, mut s) = store();
            fs::write(&s.selected, "model_catalog_json = '/original/models.json'\n[features]\napi_key_model_discovery = false\nother_feature = true\n").unwrap();
            let c = connection();
            let t = template();
            let id = s.prepare(c.clone(), true, &t, None).unwrap();
            let catalog = json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
            s.attach_catalog(&id, &c, &catalog).unwrap();
            s.apply(&id).unwrap();
            let t = if native {
                let id = s.prepare_api_switch().unwrap();
                s.attach_native_catalog(&id, &c).unwrap();
                s.apply(&id).unwrap();
                serde_json::from_str::<Json>(include_str!("../../templates/bootstrap.json"))
                    .unwrap()["templates"][1]
                    .clone()
            } else {
                t
            };
            s.switch_channel("official").unwrap();
            let catalog_bytes = fs::read(s.catalog_path().unwrap()).unwrap();
            let id = s.prepare(c, true, &t, None).unwrap();
            s.apply(&id).unwrap();
            let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
            assert_eq!(doc["model_provider"].as_str(), Some("openai"));
            assert_eq!(
                doc["model_catalog_json"].as_str(),
                Some("/original/models.json")
            );
            assert_eq!(
                doc["features"]["api_key_model_discovery"].as_bool(),
                Some(false)
            );
            assert_eq!(doc["features"]["other_feature"].as_bool(), Some(true));
            assert_eq!(fs::read(s.catalog_path().unwrap()).unwrap(), catalog_bytes);
        }
    }
    #[test]
    fn channel_switch_catalog_sync_does_not_create_backups() {
        for native in [false, true] {
            let (_dir, mut s) = store();
            let c = connection();
            let plan = s.prepare(c.clone(), false, &template(), None).unwrap();
            s.apply(&plan).unwrap();
            let backups = fs::read_dir(s.root.join("backups")).unwrap().count();
            s.switch_channel("official").unwrap();
            s.switch_channel("api").unwrap();
            let plan = s.prepare_api_switch().unwrap();
            if native {
                assert!(s.attach_native_catalog(&plan, &c).unwrap());
            } else {
                let catalog = json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
                s.attach_catalog(&plan, &c, &catalog).unwrap();
            }
            assert!(s
                .apply_with_backup(&plan, false)
                .unwrap()
                .get("backupId")
                .is_none());
            s.switch_channel("official").unwrap();
            assert_eq!(s.inspect().unwrap()["modelChannel"], "official");
            assert_eq!(
                fs::read_dir(s.root.join("backups")).unwrap().count(),
                backups
            );
        }
    }
    #[test]
    fn native_catalog_migrates_and_restores_original_settings() {
        let (_dir, mut s) = store();
        fs::write(&s.selected, "model_catalog_json = '/original/models.json'\n[features]\napi_key_model_discovery = false\nother_feature = true\n").unwrap();
        let c = connection();
        let catalog =
            json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
        let plan = s.prepare(c.clone(), false, &template(), None).unwrap();
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.apply(&plan).unwrap();
        let bytes = fs::read(s.catalog_path().unwrap()).unwrap();
        let plan = s.prepare_api_switch().unwrap();
        assert!(s.attach_native_catalog(&plan, &c).unwrap());
        s.apply(&plan).unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert!(doc.get("model_catalog_json").is_none());
        assert_eq!(
            doc["model_providers"]["custom"]["model_catalog_url"].as_str(),
            Some("https://example.com/v1/models")
        );
        assert_eq!(
            doc["features"]["api_key_model_discovery"].as_bool(),
            Some(true)
        );
        assert_eq!(fs::read(s.catalog_path().unwrap()).unwrap(), bytes);
        let plan = s.prepare_api_switch().unwrap();
        assert!(!s.attach_native_catalog(&plan, &c).unwrap());
        let backups = fs::read_dir(s.root.join("backups")).unwrap().count();
        s.switch_channel("official").unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/original/models.json")
        );
        assert_eq!(
            doc["features"]["api_key_model_discovery"].as_bool(),
            Some(false)
        );
        assert_eq!(doc["features"]["other_feature"].as_bool(), Some(true));
        assert!(doc["model_providers"]["custom"]
            .get("model_catalog_url")
            .is_none());
        s.switch_channel("api").unwrap();
        assert_eq!(
            fs::read_dir(s.root.join("backups")).unwrap().count(),
            backups
        );
    }
    #[test]
    fn native_configure_downgrade_and_user_override_are_safe() {
        let (_dir, mut s) = store();
        let native = serde_json::from_str::<Json>(include_str!("../../templates/bootstrap.json"))
            .unwrap()["templates"][1]
            .clone();
        let c = connection();
        let plan = s.prepare(c.clone(), true, &native, None).unwrap();
        s.attach_native_catalog(&plan, &c).unwrap();
        s.apply(&plan).unwrap();
        assert!(!s.catalog_path().unwrap().exists());
        let catalog =
            json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
        let plan = s.prepare_api_switch().unwrap();
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.apply(&plan).unwrap();
        assert!(s.catalog_matches(&catalog).unwrap());
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert!(item(&doc, &["features", "api_key_model_discovery"]).is_none());
        assert!(item(&doc, &["model_providers", "custom", "model_catalog_url"]).is_none());
        let plan = s.prepare_api_switch().unwrap();
        s.attach_native_catalog(&plan, &c).unwrap();
        s.apply(&plan).unwrap();
        let mut doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        doc["model_catalog_json"] = toml_edit::value("/user/override.json");
        fs::write(&s.selected, doc.to_string()).unwrap();
        let before = fs::read(&s.selected).unwrap();
        let plan = s.prepare_api_switch().unwrap();
        assert!(s.attach_native_catalog(&plan, &c).is_err());
        assert_eq!(fs::read(&s.selected).unwrap(), before);
        s.switch_channel("official").unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/user/override.json")
        );
    }
    #[test]
    fn late_native_plan_cannot_overwrite_switch_or_edits() {
        let (_dir, mut s) = store();
        let c = connection();
        let plan = s.prepare(c.clone(), false, &template(), None).unwrap();
        s.apply(&plan).unwrap();
        let plan = s.prepare_api_switch().unwrap();
        s.attach_native_catalog(&plan, &c).unwrap();
        s.switch_channel("official").unwrap();
        assert!(s.apply(&plan).is_err());
        assert!(!s.native_state_path().unwrap().exists());
    }
    #[test]
    fn late_catalog_does_not_write_after_switching_to_official() {
        let (_dir, mut s) = store();
        let c = connection();
        let plan = s.prepare(c.clone(), true, &template(), None).unwrap();
        s.apply(&plan).unwrap();
        let revision = s.revision().unwrap();
        let plan = s.prepare_api_switch().unwrap();
        let catalog =
            json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.switch_channel("official").unwrap();
        assert!(s.check_revision(&revision).is_err());
        assert!(s.apply(&plan).is_err());
        assert!(!s.catalog_path().unwrap().exists());
        assert_eq!(s.inspect().unwrap()["modelChannel"], "official");
    }
    #[test]
    fn upgrade_from_config_without_catalog_preserves_settings() {
        let (_dir, mut s) = store();
        let c = connection();
        let plan = s.prepare(c.clone(), true, &template(), None).unwrap();
        s.apply(&plan).unwrap();
        let before = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert!(before.get("model_catalog_json").is_none());
        let catalog =
            json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true}]});
        assert!(!s.catalog_matches(&catalog).unwrap());
        let plan = s.prepare_api_switch().unwrap();
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.apply(&plan).unwrap();
        assert!(s.catalog_matches(&catalog).unwrap());
        let mut after = document(read(&s.selected).unwrap().as_deref()).unwrap();
        after.remove("model_catalog_json");
        assert_eq!(after.to_string(), before.to_string());
        s.switch_channel("official").unwrap();
        assert!(!s.catalog_matches(&catalog).unwrap());
    }
    #[test]
    fn official_removes_only_managed_catalog_and_revision_detects_changes() {
        let (_dir, mut s) = store();
        let c = connection();
        let catalog =
            json!({"models":[{"slug":"gpt-6-luna","visibility":"list","supported_in_api":true}]});
        let plan = s.prepare(c.clone(), false, &template(), None).unwrap();
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.apply(&plan).unwrap();
        let backups = fs::read_dir(s.root.join("backups")).unwrap().count();
        s.switch_channel("official").unwrap();
        assert_eq!(
            fs::read_dir(s.root.join("backups")).unwrap().count(),
            backups
        );
        let mut doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert!(doc.get("model_catalog_json").is_none());
        let revision = s.revision().unwrap();
        doc["model_catalog_json"] = toml_edit::value("/user/catalog.json");
        fs::write(&s.selected, doc.to_string()).unwrap();
        assert!(s.check_revision(&revision).is_err());
        s.switch_channel("official").unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/user/catalog.json")
        );
    }
    #[test]
    fn catalog_switch_preserves_original_and_replaces_fixed_file() {
        let (_dir, mut s) = store();
        fs::write(
            &s.selected,
            "model_catalog_json = '/original/models.json'\n",
        )
        .unwrap();
        let catalog = json!({"models":[{"slug":"gpt-6-sol","visibility":"list","supported_in_api":true,"base_instructions":"preserve me"}]});
        let c = connection();
        let plan = s.prepare(c.clone(), false, &template(), None).unwrap();
        s.attach_catalog(&plan, &c, &catalog).unwrap();
        s.apply(&plan).unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        let first = doc["model_catalog_json"].as_str().unwrap().to_owned();
        assert_eq!(Path::new(&first).parent(), s.selected.parent());
        assert!(Path::new(&first)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .eq("models_cache_bei.json"));
        assert_eq!(
            serde_json::from_slice::<Json>(&fs::read(&first).unwrap()).unwrap(),
            catalog
        );
        let plan = s.prepare_api_switch().unwrap();
        let mut other = c.clone();
        other.api_key.push('x');
        let updated =
            json!({"models":[{"slug":"gpt-6-luna","visibility":"list","supported_in_api":true}]});
        s.attach_catalog(&plan, &other, &updated).unwrap();
        assert_eq!(
            serde_json::from_slice::<Json>(&fs::read(&first).unwrap()).unwrap(),
            catalog
        );
        s.apply(&plan).unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert_eq!(doc["model_catalog_json"].as_str().unwrap(), first);
        assert_eq!(
            serde_json::from_slice::<Json>(&fs::read(&first).unwrap()).unwrap(),
            updated
        );
        let before = fs::read(&s.selected).unwrap();
        let plan = s.prepare_api_switch().unwrap();
        assert!(s.attach_catalog(&plan, &c, &json!({"models":[]})).is_err());
        assert_eq!(fs::read(&s.selected).unwrap(), before);
        assert_eq!(
            serde_json::from_slice::<Json>(&fs::read(&first).unwrap()).unwrap(),
            updated
        );
        s.switch_channel("official").unwrap();
        let doc = document(read(&s.selected).unwrap().as_deref()).unwrap();
        assert_eq!(
            doc["model_catalog_json"].as_str(),
            Some("/original/models.json")
        );
        assert!(Path::new(&first).exists());
    }
    #[test]
    fn editor_uses_selected_existing_file_without_requiring_valid_toml() {
        let (dir, mut s) = store();
        assert!(s.file_for_editor().is_err());
        assert!(!s.selected.exists());
        let path = dir
            .path()
            .join("User With Spaces")
            .join("custom.config.toml");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"invalid [toml").unwrap();
        s.choose(path.clone()).unwrap();
        assert_eq!(s.file_for_editor().unwrap(), path.canonicalize().unwrap());
        assert!(s.inspect().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid [toml");
        fs::remove_file(path).unwrap();
        assert!(s.file_for_editor().is_err());
    }
    #[test]
    fn preserves_configuration_semantics_and_template_digest() {
        let fixture: Json =
            serde_json::from_str(include_str!("../fixtures/config-parity.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let after = patch(
                Some(case["before"].as_str().unwrap().as_bytes()),
                &connection(),
                false,
                &template(),
                ModelChannel::Api,
            )
            .unwrap();
            let actual: Json =
                toml_edit::de::from_str(std::str::from_utf8(&after).unwrap()).unwrap();
            assert_eq!(actual, case["expected"]);
        }
        let manifest: Json =
            serde_json::from_str(include_str!("../../templates/bootstrap.json")).unwrap();
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&manifest["templates"][0]).unwrap())
        );
        assert_eq!(hash, fixture["templateDigest"].as_str().unwrap());
    }
    #[test]
    fn link_validation_and_normalization() {
        assert_eq!(
            endpoint("https://example.com///").unwrap(),
            "https://example.com/v1"
        );
        for u in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com?key=a",
            "https://example.com/#test",
        ] {
            assert!(endpoint(u).is_err());
        }
        let link = "codexbei://configure/codex?base_url=https%3A%2F%2Fexample.com&api_key=sk-trial-fixture-0123456789&model=gpt-6-astra&preset=codexbei-v1";
        assert!(parse_link(link).unwrap().is_some());
        assert!(parse_link(&format!("{link}&model=another")).is_err());
        assert!(parse_link("codexbei://configure/codex").unwrap().is_none());
    }
    #[test]
    fn preserves_other_settings_comments_and_inline_tables() {
        let source = b"# User settings\nmodel = 'old' # chosen\n[mcp_servers.demo]\ncommand = 'node'\nenv = { SECRET = 'private-test-value' }\n[model_providers.custom]\nbase_url = 'https://old.example/v1'\nhttp_headers = { Authorization = 'old', X-Other = 'preserve' }\nenv_key = 'OLD_KEY'\n";
        let result = patch(
            Some(source),
            &connection(),
            true,
            &template(),
            ModelChannel::Api,
        )
        .unwrap();
        let text = String::from_utf8(result.clone()).unwrap();
        assert!(text.contains("# User settings") && text.contains("# chosen"));
        let doc = document(Some(&result)).unwrap();
        assert_eq!(
            item(&doc, &["mcp_servers", "demo", "env", "SECRET"]).and_then(Item::as_str),
            Some("private-test-value")
        );
        assert_eq!(
            item(
                &doc,
                &["model_providers", "custom", "http_headers", "X-Other"]
            )
            .and_then(Item::as_str),
            Some("preserve")
        );
        assert!(item(
            &doc,
            &["model_providers", "custom", "http_headers", "Authorization"]
        )
        .is_none());
        assert!(item(&doc, &["model_providers", "custom", "env_key"]).is_none());
        assert_eq!(
            item(&doc, &["model_providers", "custom", "requires_openai_auth"])
                .and_then(Item::as_bool),
            Some(true)
        );
    }
    #[test]
    fn snapshots_restore_exact_bytes_and_missing_file() {
        let (_dir, mut s) = store();
        let id = s.prepare(connection(), false, &template(), None).unwrap();
        let first = s.apply(&id).unwrap();
        assert!(s.apply(&id).is_err());
        let before = read(&s.selected).unwrap().unwrap();
        let bid = first["backupId"].as_str().unwrap();
        let (_, hash) = s.restore_state(bid).unwrap();
        let restored = s.restore(bid, &hash).unwrap();
        assert!(!s.selected.exists());
        let undo = restored["backupId"].as_str().unwrap();
        let (_, hash) = s.restore_state(undo).unwrap();
        s.restore(undo, &hash).unwrap();
        assert_eq!(read(&s.selected).unwrap().unwrap(), before);
    }
    #[test]
    fn detects_edits_and_corrupted_backups() {
        let (_dir, mut s) = store();
        let id = s.prepare(connection(), false, &template(), None).unwrap();
        fs::write(&s.selected, "model = 'external'\n").unwrap();
        assert!(s.apply(&id).is_err());
        let id = s.prepare(connection(), false, &template(), None).unwrap();
        let result = s.apply(&id).unwrap();
        let bid = result["backupId"].as_str().unwrap();
        let (_, hash) = s.restore_state(bid).unwrap();
        fs::write(&s.selected, "model = 'changed'\n").unwrap();
        assert!(s.restore(bid, &hash).is_err());
        fs::write(
            s.root.join("backups").join(bid).join("config.toml"),
            "corrupt",
        )
        .unwrap();
        assert!(s.backup_preview(bid).is_err());
    }
    #[test]
    fn preview_reflects_selected_channel_and_retains_masked_custom_provider() {
        for (channel, provider) in [("api", "custom"), ("official", "openai")] {
            let shown = preview(
                "https://example.com/v1",
                "gpt-6-astra",
                true,
                channel,
                &template(),
            )
            .unwrap();
            let doc = shown.parse::<DocumentMut>().unwrap();
            assert_eq!(doc["model_provider"].as_str(), Some(provider));
            assert_eq!(
                item(
                    &doc,
                    &["model_providers", "custom", "experimental_bearer_token"]
                )
                .and_then(Item::as_str),
                Some("（已隐藏）")
            );
            assert_eq!(
                item(&doc, &["model_providers", "custom", "requires_openai_auth"])
                    .and_then(Item::as_bool),
                Some(true)
            );
        }
        assert!(preview(
            "https://example.com/v1",
            "gpt-6-astra",
            true,
            "invalid",
            &template()
        )
        .is_err());
    }

    #[test]
    fn preview_and_new_configuration_keep_headers_inline() {
        let shown = preview(
            "https://example.com/v1",
            "gpt-6-astra",
            false,
            "api",
            &template(),
        )
        .unwrap();
        assert!(shown.contains("http_headers = {"));
        assert!(!shown.contains("[model_providers.custom.http_headers]"));
        assert!(!shown.contains("[model_providers]\n"));
        let saved = String::from_utf8(
            patch(None, &connection(), false, &template(), ModelChannel::Api).unwrap(),
        )
        .unwrap();
        assert!(saved.contains("http_headers = {"));
        assert!(!saved.contains("[model_providers.custom.http_headers]"));
        let summary = crate::redact::preview(saved.as_bytes()).unwrap();
        assert!(summary.contains("http_headers = {"));
        assert!(!summary.contains(&connection().api_key));
    }
    #[test]
    fn backup_summary_describes_saved_state_without_credentials() {
        let (_dir, mut s) = store();
        let id = s.prepare(connection(), true, &template(), None).unwrap();
        s.apply(&id).unwrap();
        let mut next = connection();
        next.base_url = "https://next.example/v1".into();
        let id = s.prepare(next, false, &template(), None).unwrap();
        let result = s.apply(&id).unwrap();
        let id = result["backupId"].as_str().unwrap();
        let rows = s.list().unwrap();
        let row = rows.iter().find(|r| r["id"] == id).unwrap();
        let preview = s.backup_preview(id).unwrap();
        for summary in [row, &preview] {
            assert_eq!(summary["baseUrl"], "https://example.com/v1");
            assert_eq!(summary["keepOfficialLogin"], true);
            assert!(!summary.to_string().contains(&connection().api_key));
        }
        assert!(rows.iter().any(|r| r["existed"] == false
            && r["baseUrl"].is_null()
            && r["keepOfficialLogin"] == false));
    }
    #[test]
    fn keys_never_leave_inspection_and_cannot_cross_gateway() {
        let (_dir, mut s) = store();
        let c = connection();
        let id = s.prepare(c.clone(), false, &template(), None).unwrap();
        let result = s.apply(&id).unwrap();
        assert!(!s.inspect().unwrap().to_string().contains(&c.api_key));
        assert!(!s
            .backup_preview(result["backupId"].as_str().unwrap())
            .unwrap()
            .to_string()
            .contains(&c.api_key));
        let mut changed = c;
        changed.api_key.clear();
        changed.base_url = "https://another.example/v1".into();
        assert!(s.prepare(changed, false, &template(), None).is_err());
        assert!(!preview(
            "https://example.com",
            "gpt-6-astra",
            false,
            "api",
            &template()
        )
        .unwrap()
        .contains("sk-"));
    }
    #[test]
    fn switches_transport_without_backups_and_preserves_selection_on_configure() {
        let (_dir, mut s) = store();
        let initial = s.inspect().unwrap();
        assert_eq!(initial["modelChannel"], "api");
        assert_eq!(initial["supportsWebsockets"], false);
        let c = connection();
        let plan = s.prepare(c.clone(), true, &template(), None).unwrap();
        s.apply_with_backup(&plan, false).unwrap();
        assert_eq!(s.inspect().unwrap()["supportsWebsockets"], true);
        let initial = fs::read(&s.selected).unwrap();
        let stale = s.prepare(c.clone(), true, &template(), None).unwrap();
        let result = s.switch_transport(false).unwrap();
        assert_eq!(result["changed"], true);
        assert!(result.get("backupId").is_none());
        assert!(s.apply_with_backup(&stale, false).is_err());
        assert_eq!(s.inspect().unwrap()["supportsWebsockets"], false);
        assert_eq!(s.credentials("", &c.base_url).unwrap().api_key, c.api_key);
        assert_eq!(s.inspect().unwrap()["modelChannel"], "api");
        let preview = s
            .preview(
                &c.base_url,
                &c.model,
                true,
                Some(ModelChannel::Api),
                &template(),
            )
            .unwrap();
        assert!(preview.contains("supports_websockets = false"));
        let saved = fs::read(&s.selected).unwrap();
        assert_eq!(s.switch_transport(false).unwrap()["changed"], false);
        assert_eq!(fs::read(&s.selected).unwrap(), saved);
        let plan = s.prepare(c, true, &template(), None).unwrap();
        s.apply_with_backup(&plan, false).unwrap();
        assert_eq!(s.inspect().unwrap()["supportsWebsockets"], false);
        s.switch_transport(true).unwrap();
        assert_eq!(fs::read(&s.selected).unwrap(), initial);
        s.switch_channel("official").unwrap();
        s.switch_transport(false).unwrap();
        assert_eq!(s.inspect().unwrap()["modelChannel"], "official");
        assert_eq!(s.inspect().unwrap()["supportsWebsockets"], false);
        assert_eq!(fs::read_dir(s.root.join("backups")).unwrap().count(), 0);
    }
    #[test]
    fn transport_switch_rejects_unconfigured_invalid_and_profile_files() {
        let (_dir, mut s) = store();
        assert!(s.switch_transport(true).is_err());
        assert!(!s.selected.exists());
        for content in ["not TOML", "profile = 'work'", "model_providers = 'wrong'"] {
            fs::write(&s.selected, content).unwrap();
            assert!(s.switch_transport(false).is_err());
            assert_eq!(fs::read_to_string(&s.selected).unwrap(), content);
        }
        assert_eq!(fs::read_dir(s.root.join("backups")).unwrap().count(), 0);
    }
    #[test]
    fn switches_model_channel_immediately_without_backups_or_losing_credentials() {
        let (_dir, mut s) = store();
        let c = connection();
        let id = s.prepare(c.clone(), true, &template(), None).unwrap();
        s.apply(&id).unwrap();
        let initial = s.inspect().unwrap();
        assert_eq!(initial["modelChannel"], "api");
        assert_eq!(initial["hasKey"], true);

        let backups = fs::read_dir(s.root.join("backups")).unwrap().count();
        let initial_file = fs::read(&s.selected).unwrap();
        let switched = s.switch_channel("official").unwrap();
        assert_eq!(switched["changed"], true);
        assert!(switched.get("backupId").is_none());
        assert_eq!(
            fs::read_dir(s.root.join("backups")).unwrap().count(),
            backups
        );
        let official = s.inspect().unwrap();
        assert_eq!(official["modelChannel"], "official");
        assert_eq!(official["hasKey"], true);
        assert_eq!(official["keepOfficialLogin"], true);
        assert_eq!(s.credentials("", &c.base_url).unwrap().api_key, c.api_key);

        let text = fs::read_to_string(&s.selected).unwrap();
        assert!(text.contains("model_provider = \"openai\""));
        assert!(text.contains("experimental_bearer_token"));
        assert!(text.contains("requires_openai_auth = true"));

        s.switch_channel("api").unwrap();
        assert_eq!(s.inspect().unwrap()["modelChannel"], "api");
        assert_eq!(fs::read(&s.selected).unwrap(), initial_file);
        assert_eq!(s.switch_channel("api").unwrap()["changed"], false);
        assert!(s.switch_channel("invalid").is_err());
        assert_eq!(
            fs::read_dir(s.root.join("backups")).unwrap().count(),
            backups
        );
    }
    #[test]
    fn rejects_invalid_toml_profile_and_paths() {
        let (_dir, mut s) = store();
        for content in ["not TOML", "profile = 'work'", "model_providers = 'wrong'"] {
            fs::write(&s.selected, content).unwrap();
            assert!(s.prepare(connection(), false, &template(), None).is_err());
            assert_eq!(fs::read_to_string(&s.selected).unwrap(), content);
        }
        assert!(s.choose(s.root.join("auth.json")).is_err());
        assert!(s.choose(PathBuf::from("config.toml")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_links_and_keeps_files_private() {
        use std::os::unix::{
            fs::MetadataExt,
            fs::{symlink, PermissionsExt},
        };
        let (_dir, mut s) = store();
        let id = s.prepare(connection(), false, &template(), None).unwrap();
        s.apply(&id).unwrap();
        assert_eq!(
            fs::metadata(&s.selected).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let other = s.root.join("linked.config.toml");
        fs::hard_link(&s.selected, &other).unwrap();
        assert!(fs::metadata(&s.selected).unwrap().nlink() > 1);
        assert!(s.inspect().is_err());
        fs::remove_file(other).unwrap();
        let link = s.root.join("link.config.toml");
        symlink(&s.selected, &link).unwrap();
        assert!(s.choose(link).is_err());
    }
    #[test]
    fn creates_only_default_directory_and_rejects_structural_removals() {
        let root = tempfile::tempdir().unwrap();
        let default = root.path().join("codex/config.toml");
        let mut store = Store::new(root.path().join("data"), default.clone()).unwrap();
        let id = store
            .prepare(connection(), false, &template(), None)
            .unwrap();
        store.apply(&id).unwrap();
        assert!(default.is_file());
        assert!(store
            .choose(root.path().join("unknown/config.toml"))
            .is_err());
        let mut t = template();
        t["set"]
            .as_object_mut()
            .unwrap()
            .remove("model_reasoning_effort");
        t["remove"] = json!([["model_reasoning_effort"]]);
        assert!(patch(
            Some(b"[model_reasoning_effort]\nimportant='keep'\n"),
            &connection(),
            false,
            &t,
            ModelChannel::Api,
        )
        .is_err());
    }

    #[test]
    fn custom_provider_is_stable_and_preserves_other_providers() {
        let (_dir, mut store) = store();
        let original = "# Keep all providers\n[model_providers.custom]\nenv_key = 'OLD_KEY'\nauth = { command = 'old-auth' }\n[model_providers.example]\nbase_url = 'https://another.com/v1'\nhttp_headers = { Authorization = 'existing' }\n[model_providers.example-2]\nbase_url = 'https://example.com/v1'\nenv_key = 'OTHER_KEY'\n";
        fs::write(&store.selected, original).unwrap();
        let before = document(Some(original.as_bytes())).unwrap();
        let shown = store
            .preview(
                &connection().base_url,
                &connection().model,
                true,
                Some(ModelChannel::Api),
                &template(),
            )
            .unwrap();
        let shown = document(Some(shown.as_bytes())).unwrap();
        assert_eq!(shown["model_provider"].as_str(), Some("custom"));
        assert_eq!(
            shown["model_providers"]["custom"]["name"].as_str(),
            Some("OpenAI")
        );
        let id = store
            .prepare(connection(), true, &template(), None)
            .unwrap();
        store.apply(&id).unwrap();
        let after = document(read(&store.selected).unwrap().as_deref()).unwrap();
        for provider in ["example", "example-2"] {
            assert_eq!(
                before["model_providers"][provider].to_string(),
                after["model_providers"][provider].to_string()
            );
        }
        assert_eq!(after["model_provider"].as_str(), Some("custom"));
        assert_eq!(
            after["model_providers"]["custom"]["name"].as_str(),
            Some("OpenAI")
        );
        let id = store
            .prepare(connection(), true, &template(), None)
            .unwrap();
        store.apply(&id).unwrap();
        store.switch_channel("official").unwrap();
        let mut reopened = Store::new(store.root.clone(), store.selected.clone()).unwrap();
        assert_eq!(
            reopened.inspect().unwrap()["baseUrl"],
            connection().base_url
        );
        assert_eq!(
            reopened
                .credentials("", &connection().base_url)
                .unwrap()
                .api_key,
            connection().api_key
        );
        reopened.switch_channel("api").unwrap();
        let result = document(read(&reopened.selected).unwrap().as_deref()).unwrap();
        assert_eq!(result["model_provider"].as_str(), Some("custom"));
        assert!(result["model_providers"].get("example-4").is_none());
    }
}
