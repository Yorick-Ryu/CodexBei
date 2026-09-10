use crate::config::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    schema_version: u32,
    has_dot_env_proxy: bool,
    checks: Vec<Check>,
    #[serde(default)]
    configurations: Vec<Configuration>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    source: String,
    content: String,
}

// Support reports are stricter than the local backup preview: comments, arbitrary
// strings, paths, headers and command arguments must never leave the backend.
#[cfg(any(windows, test))]
fn report_config(bytes: &[u8]) -> Result<String> {
    use serde_json::Value;
    let safe = crate::redact::preview(bytes)?;
    let mut config: Value =
        toml_edit::de::from_str(&safe).map_err(|_| "配置无法解析，未附加原文。".to_string())?;
    fn scrub(value: &mut Value, key: &str) {
        if [
            "projects",
            "mcp_servers",
            "marketplaces",
            "plugins",
            "http_headers",
            "env_http_headers",
            "auth",
            "shell_environment_policy",
        ]
        .contains(&key)
        {
            *value = Value::String("（已隐藏：路径、凭证或自定义内容）".into());
            return;
        }
        match value {
            Value::Object(map) => {
                let mut cleaned = serde_json::Map::new();
                for (name, mut child) in std::mem::take(map) {
                    if !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                        || name.starts_with("sk-")
                        || name.len() > 80
                    {
                        cleaned.insert(
                            format!("hidden_entry_{}", cleaned.len()),
                            Value::String("（已隐藏）".into()),
                        );
                    } else {
                        scrub(&mut child, &name);
                        cleaned.insert(name, child);
                    }
                }
                *map = cleaned;
            }
            Value::String(text) if key == "base_url" => {
                *text = url::Url::parse(text)
                    .ok()
                    .filter(|u| u.scheme() == "https" || u.scheme() == "http")
                    .map(|u| {
                        let path = if matches!(u.path(), "" | "/" | "/v1" | "/v1/") {
                            u.path()
                        } else {
                            "/（路径已隐藏）"
                        };
                        format!("{}{path}", u.origin().ascii_serialization())
                    })
                    .unwrap_or_else(|| "（已隐藏或地址无效）".into());
            }
            Value::String(text)
                if [
                    "model",
                    "model_provider",
                    "model_reasoning_effort",
                    "model_reasoning_summary",
                    "model_verbosity",
                    "wire_api",
                    "preferred_auth_method",
                    "sandbox",
                    "sandbox_mode",
                    "approval_policy",
                    "localeOverride",
                    "followUpQueueMode",
                ]
                .contains(&key)
                    && text.len() < 100
                    && !text.starts_with("sk-")
                    && text
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) => {}
            Value::Bool(_) | Value::Number(_) => {}
            _ => *value = Value::String("（已隐藏）".into()),
        }
    }
    scrub(&mut config, "");
    toml_edit::ser::to_string_pretty(&config).map_err(|_| "无法生成脱敏配置，未附加原文。".into())
}

#[cfg(windows)]
fn configuration_snapshot(path: &Path, source: &str) -> Configuration {
    let content = (|| {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "配置文件不存在或无法读取，未附加原文。".to_string())?
            .take(1048577)
            .read_to_end(&mut bytes)
            .map_err(|_| "配置读取失败，未附加原文。".to_string())?;
        if bytes.len() > 1048576 {
            return Err("配置超过 1 MB，未附加原文。".into());
        }
        report_config(&bytes)
    })()
    .unwrap_or_else(|_| "配置无法读取或解析，未附加原文。".into());
    Configuration {
        source: source.into(),
        content,
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Check {
    name: String,
    status: String,
    detail: String,
}

pub async fn run(base_url: &str, config_path: &Path) -> Result<Report> {
    let base_url = crate::config::endpoint(base_url)?;
    #[cfg(not(windows))]
    {
        let _ = (base_url, config_path);
        Err("快速排查仅支持 Windows。".into())
    }
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;
        let mut script = tempfile::Builder::new()
            .prefix("codexbei-diagnostics-")
            .suffix(".ps1")
            .tempfile()
            .map_err(|_| "无法准备排查脚本。".to_string())?;
        let source = include_str!("../../scripts/windows-diagnostics.ps1");
        // Windows PowerShell 5.1 needs a BOM to decode Chinese source correctly.
        script
            .write_all(b"\xef\xbb\xbf")
            .and_then(|_| script.write_all(source.trim_start_matches('\u{feff}').as_bytes()))
            .map_err(|_| "无法准备排查脚本。".to_string())?;
        let powershell = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut child = tokio::process::Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script.path())
            .arg("-BaseUrl")
            .arg(base_url)
            .arg("-ConfigPath")
            .arg(config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| {
                "无法启动 Windows 排查；请检查 PowerShell 是否被系统策略禁用。".to_string()
            })?;
        let output = tokio::time::timeout(std::time::Duration::from_secs(55), async {
            let mut bytes = Vec::new();
            child
                .stdout
                .take()
                .ok_or(())?
                .take(131073)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| ())?;
            if bytes.len() > 131072 || !child.wait().await.map_err(|_| ())?.success() {
                return Err(());
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| "排查超过 55 秒，已停止；请检查 PowerShell 或安全软件限制。".to_string())?
        .map_err(|_| "排查未完成；请检查 PowerShell 或安全软件限制。".to_string())?;
        let mut report: Report =
            serde_json::from_slice(&output).map_err(|_| "无法读取排查报告。".to_string())?;
        report.configurations.push(configuration_snapshot(
            config_path,
            "CodexBei 当前选择的已保存配置",
        ));
        let default_path = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
            .map(|p| p.join("config.toml"));
        if let Some(path) = default_path.filter(|p| p != config_path) {
            report.configurations.push(configuration_snapshot(
                &path,
                "当前进程 CODEX_HOME 下的默认配置（可能与所选配置相同）",
            ));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn support_config_preserves_settings_but_removes_secrets_and_paths() {
        let input = br#"# private-comment
model = "gpt-5.6-sol"
model_provider = "custom"
custom_note = "private-note"
[model_providers.custom]
base_url = "https://user:password@example.com/v1?token=private-query"
experimental_bearer_token = "sk-private-key"
wire_api = "responses"
supports_websockets = false
http_headers = { Authorization = "private-header", other = "private-other" }
[projects.'C:\Users\PRIVATE\work']
trust_level = "trusted"
[mcp_servers.private_server]
args = ["private-argument"]
"#;
        let result = report_config(input).unwrap();
        for hidden in ["private-", "PRIVATE", "password", "user:"] {
            assert!(!result.contains(hidden), "leaked {hidden}");
        }
        assert!(result.contains("gpt-5.6-sol"));
        assert!(result.contains("https://example.com/v1"));
        assert!(result.contains("supports_websockets = false"));
        assert!(report_config(b"secret invalid TOML").is_err());
    }
}
