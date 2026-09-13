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

// Preserve the configuration and its formatting; redact credential values only.
#[cfg(any(windows, test))]
fn report_config(bytes: &[u8]) -> Result<String> {
    crate::redact::preview(bytes)
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

#[cfg(windows)]
fn prepare_script(source: &str) -> Result<tempfile::TempPath> {
    use std::io::Write;
    let mut script = tempfile::Builder::new()
        .prefix("codexbei-diagnostics-")
        .suffix(".ps1")
        .tempfile()
        .map_err(|_| "无法准备排查脚本。".to_string())?;
    // Windows PowerShell 5.1 needs a BOM to decode Chinese source correctly.
    script
        .write_all(b"\xef\xbb\xbf")
        .and_then(|_| script.write_all(source.trim_start_matches('\u{feff}').as_bytes()))
        .map_err(|_| "无法准备排查脚本。".to_string())?;
    // PowerShell cannot open the script while a writable handle is held on
    // Windows. Close the file but retain automatic cleanup of its path.
    Ok(script.into_temp_path())
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
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;
        let source = include_str!("../../scripts/windows-diagnostics.ps1");
        let script = prepare_script(source)?;
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
            .arg(&script)
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
    #[cfg(windows)]
    #[test]
    fn native_diagnostics_returns_report_for_isolated_config() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config.toml");
        std::fs::write(&config, "model = \"diagnostic-test\"\n").unwrap();
        let report = tauri::async_runtime::block_on(run("https://api.beiapi.cn/v1", &config))
            .unwrap_or_else(|error| panic!("Native diagnostics failed: {error}"));
        assert_eq!(report.schema_version, 1);
        assert!(!report.checks.is_empty());
        assert!(report.configurations[0].content.contains("diagnostic-test"));
    }

    #[cfg(windows)]
    #[test]
    fn powershell_reads_prepared_script_and_temp_path_is_cleaned_up() {
        use std::os::windows::process::CommandExt;
        let script = prepare_script("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\nWrite-Output '排查成功'").unwrap();
        let path = script.to_path_buf();
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "PowerShell could not read the prepared script"
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "排查成功");
        drop(script);
        assert!(!path.exists());
    }

    #[test]
    fn support_config_preserves_context_and_only_redacts_credentials() {
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
        for hidden in ["sk-private-key", "private-header", "private-query", "user:password"] {
            assert!(!result.contains(hidden), "leaked {hidden}");
        }
        assert!(result.contains("gpt-5.6-sol"));
        for retained in ["private-comment", "private-note", "PRIVATE", "private-argument", "private-other", "projects", "mcp_servers"] {
            assert!(result.contains(retained), "lost diagnostic context: {retained}");
        }
        assert!(result.contains("example.com/v1"));
        assert!(result.contains("supports_websockets = false"));
        assert!(report_config(b"secret invalid TOML").is_err());
    }
}
