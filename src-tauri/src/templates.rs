use crate::{
    config::{self, Result},
    network,
    versions::{app_parts, valid_version},
};
use node_semver::{Range, Version};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant},
};
const ERROR: &str = "远端配置格式无效，已保留现有配置。";
const RESOLVE: &str = "https://codexbei.beiapi.cn/config/v1/resolve";
const BINDINGS: [(&str, &str); 4] = [
    ("model", "$model"),
    ("model_providers.custom.base_url", "$base_url"),
    (
        "model_providers.custom.experimental_bearer_token",
        "$api_key",
    ),
    (
        "model_providers.custom.http_headers.x-openai-actor-authorization",
        "$base_url",
    ),
];
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}
fn fail<T>() -> Result<T> {
    Err(ERROR.into())
}
pub fn digest(template: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(template).unwrap())
    )
}
pub fn flatten(value: &Value, prefix: &[String]) -> Result<Vec<(Vec<String>, Value)>> {
    let object = value.as_object().ok_or_else(|| ERROR.to_string())?;
    let mut result = Vec::new();
    for (key, value) in object {
        if key.is_empty()
            || key.contains('.')
            || ["__proto__", "prototype", "constructor"].contains(&key.as_str())
        {
            return fail();
        }
        let mut path = prefix.to_vec();
        path.push(key.clone());
        if path.len() > 4 {
            return fail();
        }
        if value.is_object() {
            result.extend(flatten(value, &path)?);
        } else {
            result.push((path, value.clone()));
        }
    }
    Ok(result)
}
fn allowed(name: &str, value: &Value) -> bool {
    let s = value.as_str().unwrap_or_default();
    match name {
        "model_provider" => value == "custom",
        "model_reasoning_effort" => ["minimal", "low", "medium", "high", "xhigh"].contains(&s),
        "model_reasoning_summary" => ["auto", "concise", "detailed", "none"].contains(&s),
        "disable_response_storage" | "model_providers.custom.supports_websockets" => {
            value.is_boolean()
        }
        "preferred_auth_method" => value == "apikey",
        "model_providers.custom.name" => !s.is_empty() && s.chars().count() <= 80,
        "model_providers.custom.wire_api" => value == "responses",
        "model_providers.custom.requires_openai_auth" => value == &json!(false),
        "model_providers.custom.request_max_retries"
        | "model_providers.custom.stream_max_retries" => value.as_u64().is_some_and(|v| v <= 10),
        "model_providers.custom.stream_idle_timeout_ms" => {
            value.as_u64().is_some_and(|v| (1000..=600000).contains(&v))
        }
        _ => false,
    }
}
pub fn validate(template: &Value) -> Result<()> {
    if !exact(
        template,
        &["id", "version", "default", "targets", "set", "remove"],
    ) {
        return fail();
    }
    let id = template["id"].as_str().unwrap_or_default();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !template["version"].as_str().is_some_and(valid_version)
        || !template["default"].is_boolean()
        || regex::Regex::new("sk-[A-Za-z0-9_-]{12,}")
            .unwrap()
            .is_match(&template.to_string())
    {
        return fail();
    }
    let targets = template["targets"]
        .as_array()
        .ok_or_else(|| ERROR.to_string())?;
    if targets.len() > 10 || (template["default"] == true) != targets.is_empty() {
        return fail();
    }
    for t in targets {
        if !exact(t, &["kind", "runtimeRange", "appRange"])
            || !["cli", "desktop"].contains(&t["kind"].as_str().unwrap_or_default())
            || !t["runtimeRange"]
                .as_str()
                .is_some_and(|r| r.len() <= 100 && Range::parse(r).is_ok())
        {
            return fail();
        }
        if let Some(r) = t.get("appRange") {
            let min = r["min"].as_str().and_then(app_parts);
            let max = r["maxExclusive"].as_str().and_then(app_parts);
            if t["kind"] != "desktop"
                || !exact(r, &["min", "maxExclusive"])
                || min.is_none()
                || max.is_none()
                || min >= max
            {
                return fail();
            }
        }
    }
    let fields = flatten(&template["set"], &[])?;
    if fields.len() > 32 {
        return fail();
    }
    let names: HashSet<_> = fields.iter().map(|(p, _)| p.join(".")).collect();
    for (name, binding) in BINDINGS {
        if !names.contains(name)
            || fields.iter().find(|(p, _)| p.join(".") == name).unwrap().1 != binding
        {
            return fail();
        }
    }
    if !names.contains("model_provider") {
        return fail();
    }
    for (path, value) in fields {
        let name = path.join(".");
        if !BINDINGS.iter().any(|(n, _)| *n == name) && !allowed(&name, &value) {
            return fail();
        }
    }
    let remove = template["remove"]
        .as_array()
        .ok_or_else(|| ERROR.to_string())?;
    if !remove.is_empty() {
        return fail();
    }
    Ok(())
}
fn matches(template: &Value, request: &Value) -> bool {
    if template["default"] == true {
        return true;
    }
    let Some(targets) = request["targets"].as_array().filter(|v| !v.is_empty()) else {
        return false;
    };
    targets.iter().all(|installed| {
        let Some(version) = installed["runtimeVersion"]
            .as_str()
            .and_then(|s| Version::parse(s).ok())
        else {
            return false;
        };
        template["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| {
                if target["kind"] != installed["kind"]
                    || !Range::parse(target["runtimeRange"].as_str().unwrap())
                        .unwrap()
                        .satisfies(&version)
                {
                    return false;
                }
                match target.get("appRange") {
                    None => true,
                    Some(r) => installed["appVersion"]
                        .as_str()
                        .and_then(app_parts)
                        .is_some_and(|v| {
                            v >= app_parts(r["min"].as_str().unwrap()).unwrap()
                                && v < app_parts(r["maxExclusive"].as_str().unwrap()).unwrap()
                        }),
                }
            })
    })
}
fn validate_response(value: &Value, request: &Value) -> Result<()> {
    if !exact(value, &["schemaVersion", "release", "request", "template"])
        || value["schemaVersion"] != 1
        || !value["release"]
            .as_u64()
            .is_some_and(|v| (1..=9_007_199_254_740_991).contains(&v))
        || &value["request"] != request
        || value.get("template").is_none()
    {
        return fail();
    }
    if !value["template"].is_null() {
        validate(&value["template"])?;
        if !matches(&value["template"], request) {
            return fail();
        }
    }
    Ok(())
}
fn valid_request(request: &Value) -> bool {
    exact(request, &["targets"])
        && request["targets"].as_array().is_some_and(|v| {
            v.len() <= 20
                && v.iter().all(|t| {
                    exact(t, &["kind", "runtimeVersion", "appVersion"])
                        && ["cli", "desktop"].contains(&t["kind"].as_str().unwrap_or_default())
                        && (t["runtimeVersion"].is_null()
                            || t["runtimeVersion"].as_str().is_some_and(valid_version))
                        && t.get("appVersion").is_none_or(|v| {
                            t["kind"] == "desktop" && v.as_str().and_then(app_parts).is_some()
                        })
                })
        })
}
fn metadata(template: &Value) -> Value {
    if template.is_null() {
        Value::Null
    } else {
        json!({"id":template["id"],"version":template["version"],"digest":digest(template)})
    }
}
pub struct Service {
    pub client: reqwest::Client,
    directory: PathBuf,
    cached: Vec<Value>,
    selected: Vec<Value>,
    bootstrap: Value,
    pub offline: bool,
    checked: Option<Instant>,
}
impl Service {
    pub fn new(directory: PathBuf) -> Result<Self> {
        config::private_dir(&directory)?;
        let bootstrap: Value = serde_json::from_str(include_str!("../../templates/bootstrap.json"))
            .map_err(|_| "内置模板损坏。".to_string())?;
        for template in bootstrap["templates"]
            .as_array()
            .ok_or_else(|| "内置模板损坏。".to_string())?
        {
            validate(template)?;
        }
        let mut cached = Vec::new();
        let mut selected = Vec::new();
        if let Ok(Some(bytes)) = config::read(&directory.join("templates-v2.json")) {
            if let Ok(cache) = serde_json::from_slice::<Value>(&bytes) {
                for (name, dest) in [("cached", &mut cached), ("selected", &mut selected)] {
                    if let Some(entries) = cache[name].as_array().filter(|a| a.len() <= 20) {
                        for entry in entries {
                            if valid_request(&entry["request"])
                                && validate_response(entry, &entry["request"]).is_ok()
                                && entry["release"].as_u64() >= bootstrap["release"].as_u64()
                            {
                                dest.push(entry.clone());
                            }
                        }
                    }
                }
            }
        }
        Ok(Self {
            client: network::client()?,
            directory,
            cached,
            selected,
            bootstrap,
            offline: false,
            checked: None,
        })
    }
    fn find<'a>(entries: &'a [Value], request: &Value) -> Option<&'a Value> {
        entries.iter().find(|v| &v["request"] == request)
    }
    fn insert(entries: &mut Vec<Value>, value: Value) {
        entries.retain(|v| v["request"] != value["request"]);
        entries.push(value);
        if entries.len() > 20 {
            entries.remove(0);
        }
    }
    fn bundled(&self, request: &Value) -> Value {
        let templates = self.bootstrap["templates"].as_array().unwrap();
        let mut candidates: Vec<_> = templates
            .iter()
            .filter(|t| t["default"] != true && matches(t, request))
            .collect();
        candidates.sort_by(|a, b| {
            Version::parse(b["version"].as_str().unwrap())
                .unwrap()
                .cmp(&Version::parse(a["version"].as_str().unwrap()).unwrap())
        });
        let template =
            if candidates.len() > 1 && candidates[0]["version"] == candidates[1]["version"] {
                Value::Null
            } else {
                candidates
                    .first()
                    .copied()
                    .or_else(|| templates.iter().find(|t| t["default"] == true))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
        json!({"schemaVersion":1,"release":self.bootstrap["release"],"request":request,"template":template})
    }
    fn save(&self) -> Result<()> {
        config::atomic_write(
            &self.directory.join("templates-v2.json"),
            &serde_json::to_vec(&json!({"cached":self.cached,"selected":self.selected})).unwrap(),
            0o600,
        )
    }
    pub fn current(&self, request: &Value) -> Result<Value> {
        let latest = Self::find(&self.cached, request);
        if latest.is_some_and(|v| v["template"].is_null()) {
            return Err("没有匹配的配置模板，请选择 Codex 版本。".into());
        }
        let entry = Self::find(&self.selected, request)
            .cloned()
            .unwrap_or_else(|| latest.cloned().unwrap_or_else(|| self.bundled(request)));
        if entry["template"].is_null() {
            return Err("没有匹配的配置模板，请选择 Codex 版本。".into());
        }
        Ok(entry["template"].clone())
    }
    fn accept(&mut self, value: Value, request: &Value) -> Result<()> {
        validate_response(&value, request)?;
        if value["release"].as_u64() < self.bootstrap["release"].as_u64() {
            return fail();
        }
        for old in self
            .cached
            .iter()
            .chain(self.selected.iter())
            .filter(|v| &v["request"] == request)
        {
            if value["release"].as_u64() < old["release"].as_u64()
                || (value["release"] == old["release"] && value != *old)
            {
                return fail();
            }
        }
        for template in self.bootstrap["templates"]
            .as_array()
            .unwrap()
            .iter()
            .chain(
                self.cached
                    .iter()
                    .chain(self.selected.iter())
                    .map(|v| &v["template"]),
            )
        {
            let next = &value["template"];
            if !next.is_null()
                && !template.is_null()
                && next["id"] == template["id"]
                && next["version"] == template["version"]
                && digest(next) != digest(template)
            {
                return fail();
            }
        }
        let previous = self.cached.clone();
        Self::insert(&mut self.cached, value);
        if let Err(e) = self.save() {
            self.cached = previous;
            return Err(e);
        }
        Ok(())
    }
    pub async fn refresh(&mut self, request: &Value, force: bool, activate: bool) -> Result<Value> {
        if Self::find(&self.selected, request).is_none() {
            let value = Self::find(&self.cached, request)
                .cloned()
                .unwrap_or_else(|| self.bundled(request));
            Self::insert(&mut self.selected, value);
            self.save()?;
        }
        if force
            || self
                .checked
                .is_none_or(|t| t.elapsed() > Duration::from_secs(300))
        {
            let fetched: Result<Value> = async {
                let response = self
                    .client
                    .post(RESOLVE)
                    .header("Accept", "application/json")
                    .json(request)
                    .send()
                    .await
                    .map_err(|_| ERROR.to_string())?;
                let status = response.status().as_u16();
                if ![200, 404].contains(&status) {
                    return fail();
                }
                let value = network::bounded_json(response, 256 * 1024).await?;
                if value["template"].is_null() != (status == 404) {
                    return fail();
                }
                Ok(value)
            }
            .await;
            self.offline = match fetched {
                Ok(value) => self.accept(value, request).is_err(),
                Err(_) => true,
            };
            self.checked = Some(Instant::now());
        }
        if activate {
            if self.offline {
                return Err("无法获取最新模板，请稍后重试。".into());
            }
            let latest = Self::find(&self.cached, request)
                .filter(|v| !v["template"].is_null())
                .ok_or_else(|| "没有可用的更新模板。".to_string())?
                .clone();
            let old = self.selected.clone();
            Self::insert(&mut self.selected, latest);
            if let Err(e) = self.save() {
                self.selected = old;
                return Err(e);
            }
        }
        self.summary(request)
    }
    pub fn summary(&self, request: &Value) -> Result<Value> {
        let current = self.current(request).unwrap_or(Value::Null);
        let latest = Self::find(&self.cached, request)
            .cloned()
            .unwrap_or_else(|| self.bundled(request))["template"]
            .clone();
        let update = current["version"]
            .as_str()
            .and_then(|v| Version::parse(v).ok())
            .zip(
                latest["version"]
                    .as_str()
                    .and_then(|v| Version::parse(v).ok()),
            )
            .is_some_and(|(current, latest)| latest > current);
        Ok(
            json!({"template":metadata(&current),"latestTemplate":metadata(&latest),"templateUpdateAvailable":update,"offline":self.offline,"needsSelection":current.is_null() || latest.is_null()}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn template() -> Value {
        serde_json::from_str::<Value>(include_str!("../../templates/bootstrap.json")).unwrap()
            ["templates"][0]
            .clone()
    }
    #[test]
    fn enforces_template_allowlist_and_bindings() {
        let mut t = template();
        validate(&t).unwrap();
        let mut deletion = t.clone();
        deletion["remove"] = json!([["preferred_auth_method"]]);
        assert!(validate(&deletion).is_err());
        t["set"]["mcp_servers"] = json!({"evil":{"command":"sh"}});
        assert!(validate(&t).is_err());
        let mut t = template();
        t["set"]["model_providers"]["custom"]["requires_openai_auth"] = json!(true);
        assert!(validate(&t).is_err());
        let mut t = template();
        t["set"]["model"] = json!("remote-forced-model");
        assert!(validate(&t).is_err());
    }
    #[test]
    fn matches_npm_ranges_and_desktop_builds() {
        let mut t = template();
        t["default"] = json!(false);
        t["targets"] = json!([{"kind":"desktop","runtimeRange":"^0.153.0","appRange":{"min":"26.1.0","maxExclusive":"27.0.0"}}]);
        validate(&t).unwrap();
        assert!(matches(
            &t,
            &json!({"targets":[{"kind":"desktop","runtimeVersion":"0.153.4","appVersion":"26.3.0"}]})
        ));
        assert!(!matches(
            &t,
            &json!({"targets":[{"kind":"cli","runtimeVersion":"0.153.4"}]})
        ));
    }
    #[test]
    fn update_badge_requires_a_newer_template_version() {
        let temp = tempfile::tempdir().unwrap();
        let mut s = Service::new(temp.path().join("cache")).unwrap();
        let request = json!({"targets":[]});
        let entry = json!({"schemaVersion":1,"release":2,"request":request,"template":template()});
        Service::insert(&mut s.selected, entry.clone());
        for (version, available) in [
            ("1.0.2", false),
            ("1.0.1", false),
            ("1.0.3", true),
            ("1.10.0", true),
        ] {
            let mut latest = entry.clone();
            latest["template"]["version"] = json!(version);
            Service::insert(&mut s.cached, latest);
            assert_eq!(
                s.summary(&request).unwrap()["templateUpdateAvailable"],
                available
            );
        }
    }
    #[test]
    fn rejects_release_rollback_mutation_and_authoritative_no_match() {
        let temp = tempfile::tempdir().unwrap();
        let mut s = Service::new(temp.path().join("cache")).unwrap();
        let request = json!({"targets":[]});
        let entry = json!({"schemaVersion":1,"release":3,"request":request,"template":template()});
        s.accept(entry.clone(), &request).unwrap();
        let mut older = entry.clone();
        older["release"] = json!(2);
        assert!(s.accept(older, &request).is_err());
        let mut changed = entry.clone();
        changed["release"] = json!(4);
        changed["template"]["set"]["model_reasoning_effort"] = json!("low");
        assert!(s.accept(changed, &request).is_err());
        let mut absent = entry;
        absent["release"] = json!(4);
        absent["template"] = Value::Null;
        s.accept(absent, &request).unwrap();
        assert!(s.current(&request).is_err());
    }
    #[test]
    #[ignore = "explicit live HTTPS contract check"]
    fn live_template_resolver_contract() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let mut service = Service::new(dir.path().join("cache")).unwrap();
            let result = service
                .refresh(
                    &json!({"targets":[{"kind":"cli","runtimeVersion":"0.153.4"}]}),
                    true,
                    false,
                )
                .await
                .unwrap();
            assert_eq!(result["offline"], false);
            assert_eq!(result["needsSelection"], false);
        });
    }
}
