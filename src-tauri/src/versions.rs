use crate::config::Result;
use node_semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub kind: String,
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum Selection {
    #[default]
    Auto,
    Installed {
        id: String,
    },
    Manual {
        kind: String,
        #[serde(rename = "runtimeVersion")]
        runtime_version: String,
        #[serde(rename = "appVersion", default)]
        app_version: Option<String>,
    },
}
pub fn valid_version(value: &str) -> bool {
    value.len() <= 100 && Version::parse(value).is_ok_and(|v| v.to_string() == value)
}
pub fn app_parts(value: &str) -> Option<Vec<u64>> {
    if value.len() > 64 {
        return None;
    }
    let parts: Vec<_> = value.split('.').collect();
    if !(3..=4).contains(&parts.len())
        || parts.iter().any(|p| {
            p.is_empty()
                || !p.bytes().all(|b| b.is_ascii_digit())
                || (p.len() > 1 && p.starts_with('0'))
        })
    {
        return None;
    }
    let mut result: Vec<u64> = parts
        .into_iter()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    if result.iter().any(|v| *v > 9_007_199_254_740_991) {
        return None;
    }
    result.resize(4, 0);
    Some(result)
}
pub fn parse_version(output: &str) -> Option<String> {
    let mut parts = output.split_whitespace();
    if !["codex", "codex-cli"].contains(&parts.next()?) {
        return None;
    }
    let value = parts.next()?;
    valid_version(value).then(|| value.to_owned())
}
async fn command(executable: &Path, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "无法读取版本。".to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(4), async {
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
        String::from_utf8(bytes).map_err(|_| ())
    })
    .await;
    result
        .map_err(|_| "读取版本超时。".to_string())?
        .map_err(|_| "无法读取版本。".into())
}
pub async fn detect() -> Vec<Installation> {
    #[cfg(debug_assertions)]
    if std::env::var_os("CODEXBEI_PREVIEW_NO_CHATGPT").is_some() {
        return Vec::new();
    }
    #[cfg(not(windows))]
    let home = dirs::home_dir().unwrap_or_default();
    let mut cli = Vec::<PathBuf>::new();
    let mut apps = Vec::<(PathBuf, Option<String>)>::new();
    if let Some(path) = std::env::var_os("PATH") {
        cli.extend(
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(if cfg!(windows) { "codex.exe" } else { "codex" })),
        );
    }
    #[cfg(not(windows))]
    cli.extend([
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        home.join(".local/bin/codex"),
    ]);
    #[cfg(target_os = "macos")]
    {
        let found = command(
            Path::new("/usr/bin/mdfind"),
            &["kMDItemCFBundleIdentifier == \"com.openai.codex\" || kMDItemCFBundleIdentifier == \"com.openai.chatgpt\""],
        )
        .await
        .unwrap_or_default();
        let mut bundles: Vec<PathBuf> = found
            .lines()
            .filter(|p| p.starts_with('/') && p.ends_with(".app"))
            .map(PathBuf::from)
            .collect();
        for base in [PathBuf::from("/Applications"), home.join("Applications")] {
            for name in ["Codex.app", "ChatGPT.app"] {
                let path = base.join(name);
                if !bundles.contains(&path) {
                    bundles.push(path);
                }
            }
        }
        for bundle in bundles.into_iter().take(20) {
            let info = bundle.join("Contents/Info.plist");
            if !info.is_file() {
                continue;
            }
            if let Ok(raw) = command(
                Path::new("/usr/bin/plutil"),
                &["-convert", "json", "-o", "-", &info.to_string_lossy()],
            )
            .await
            {
                if let Ok(info) = serde_json::from_str::<Value>(&raw) {
                    let bundle_id = info["CFBundleIdentifier"].as_str().unwrap_or_default();
                    // The current ChatGPT app contains the Codex runtime but
                    // may use a ChatGPT bundle identifier rather than the
                    // legacy Codex identifier. The embedded runtime is the
                    // capability we need to detect.
                    if bundle_id.starts_with("com.openai.")
                        && bundle.join("Contents/Resources/codex").is_file()
                    {
                        let version = info["CFBundleShortVersionString"]
                            .as_str()
                            .filter(|v| app_parts(v).is_some())
                            .map(str::to_owned);
                        apps.push((bundle.join("Contents/Resources/codex"), version));
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(base) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(base).join("npm");
            cli.push(base.join("codex.exe"));
            let package = base.join("node_modules/@openai/codex");
            for triplet in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
                cli.push(package.join(format!("vendor/{triplet}/codex/codex.exe")));
                for name in ["codex-win32-x64", "codex-win32-arm64"] {
                    cli.push(package.join(format!(
                        "node_modules/@openai/{name}/vendor/{triplet}/codex/codex.exe"
                    )));
                }
            }
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(base);
            cli.push(base.join("Microsoft/WinGet/Links/codex.exe"));
            for name in ["Codex", "ChatGPT"] {
                apps.push((
                    base.join(format!("Programs/{name}/resources/codex.exe")),
                    None,
                ));
            }
        }
        let query = "@(Get-AppxPackage | Where-Object { $_.Name -in @('OpenAI.Codex','OpenAI.ChatGPT') } | Select-Object InstallLocation,Version) | ConvertTo-Json -Compress";
        if let Ok(raw) = command(
            Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", query],
        )
        .await
        {
            if let Ok(values) = serde_json::from_str::<Value>(&raw) {
                let packages = values.as_array().cloned().unwrap_or_else(|| vec![values]);
                for package in packages {
                    if let Some(location) = package["InstallLocation"].as_str() {
                        let version = package["Version"]
                            .as_str()
                            .filter(|v| app_parts(v).is_some())
                            .map(str::to_owned);
                        for sub in ["app/resources/codex.exe", "resources/codex.exe"] {
                            apps.push((PathBuf::from(location).join(sub), version.clone()));
                        }
                    }
                }
            }
        }
    }
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut unknown = None;
    for file in cli {
        if !file.is_file() || !seen.insert(file.clone()) || apps.iter().any(|(p, _)| *p == file) {
            continue;
        }
        unknown.get_or_insert(file.clone());
        if let Some(version) = command(&file, &["--version"])
            .await
            .ok()
            .and_then(|s| parse_version(&s))
        {
            result.push(Installation {
                id: "cli".into(),
                kind: "cli".into(),
                runtime_version: Some(version),
                app_version: None,
            });
            break;
        }
    }
    if result.is_empty() && unknown.is_some() {
        result.push(Installation {
            id: "cli".into(),
            kind: "cli".into(),
            runtime_version: None,
            app_version: None,
        });
    }
    let mut seen = std::collections::HashSet::new();
    for (file, app_version) in apps {
        if !file.is_file() || !seen.insert(file.clone()) {
            continue;
        }
        let runtime_version = command(&file, &["--version"])
            .await
            .ok()
            .and_then(|s| parse_version(&s));
        result.push(Installation {
            id: {
                use sha2::{Digest, Sha256};
                format!(
                    "desktop:{:x}",
                    Sha256::digest(file.to_string_lossy().as_bytes())
                )
            },
            kind: "desktop".into(),
            runtime_version,
            app_version,
        });
    }
    result
}
pub fn select(all: &[Installation], selection: &Selection) -> Result<Vec<Installation>> {
    match selection {
        Selection::Auto => Ok(all.to_vec()),
        Selection::Installed { id } => all
            .iter()
            .find(|v| v.id == *id)
            .cloned()
            .map(|v| vec![v])
            .ok_or_else(|| "请选择有效的已安装版本。".into()),
        Selection::Manual {
            kind,
            runtime_version,
            app_version,
        } if ["cli", "desktop"].contains(&kind.as_str())
            && valid_version(runtime_version)
            && app_version
                .as_ref()
                .is_none_or(|v| v.is_empty() || (kind == "desktop" && app_parts(v).is_some())) =>
        {
            Ok(vec![Installation {
                id: "manual".into(),
                kind: kind.clone(),
                runtime_version: Some(runtime_version.clone()),
                app_version: app_version.clone().filter(|v| !v.is_empty()),
            }])
        }
        Selection::Manual { kind, .. } if kind == "cli" => Err("请输入有效的 CLI 版本。".into()),
        _ => Err("请输入有效的内核版本及应用版本。".into()),
    }
}
pub fn request(all: &[Installation]) -> Value {
    let mut targets: Vec<String> = all
        .iter()
        .map(|v| {
            let mut target = json!({ "kind": v.kind, "runtimeVersion": v.runtime_version });
            if v.kind == "desktop" {
                if let Some(app) = &v.app_version {
                    target["appVersion"] = json!(app);
                }
            }
            target.to_string()
        })
        .collect();
    targets.sort();
    targets.dedup();
    json!({ "targets": targets.iter().map(|v| serde_json::from_str::<Value>(v).unwrap()).collect::<Vec<_>>() })
}
pub fn client_version(all: &[Installation]) -> Option<String> {
    all.iter()
        .find(|v| v.kind == "cli" && v.runtime_version.is_some())
        .or_else(|| all.iter().find(|v| v.runtime_version.is_some()))
        .and_then(|v| v.runtime_version.clone())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_runtime_and_app_versions() {
        assert_eq!(parse_version("codex-cli 0.153.4\n"), Some("0.153.4".into()));
        assert!(parse_version("anything 1.2.3").is_none());
        assert!(!valid_version("26.1.2.3"));
        assert!(app_parts("26.1.2.3").is_some());
        assert!(app_parts("26.01.2").is_none());
    }
    #[test]
    fn sends_only_sorted_version_identifiers() {
        let i = Installation {
            id: "private/path".into(),
            kind: "cli".into(),
            runtime_version: Some("0.153.4".into()),
            app_version: None,
        };
        let value = request(&[i.clone(), i]);
        assert_eq!(
            value,
            json!({"targets":[{"kind":"cli","runtimeVersion":"0.153.4"}]})
        );
    }
    #[test]
    fn validates_manual_selection() {
        assert!(select(
            &[],
            &Selection::Manual {
                kind: "cli".into(),
                runtime_version: "invalid".into(),
                app_version: None
            }
        )
        .is_err());
    }
}
