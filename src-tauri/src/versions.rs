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
pub fn supports_native_catalog(targets: &[Installation]) -> bool {
    let minimum = Version::parse("0.156.0").unwrap();
    !targets.is_empty()
        && targets.iter().all(|target| {
            target
                .runtime_version
                .as_deref()
                .and_then(|s| Version::parse(s).ok())
                .is_some_and(|version| version >= minimum)
        })
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
pub(crate) async fn command(executable: &Path, args: &[&str]) -> Result<String> {
    command_with_timeout(executable, args, Duration::from_secs(4)).await
}
async fn command_with_timeout(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String> {
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
    let result = tokio::time::timeout(timeout, async {
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
#[cfg(target_os = "macos")]
fn macos_runtime(bundle: &Path) -> Option<PathBuf> {
    // Newer desktop apps package the runtime as a nested app. Prefer it
    // when both layouts exist, while retaining the legacy standalone binary.
    [
        "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "Contents/Resources/codex",
    ]
    .into_iter()
    .map(|relative| bundle.join(relative))
    .find(|path| path.is_file())
}
#[cfg(any(windows, test))]
fn windows_npm_candidates(prefix: &Path) -> Vec<PathBuf> {
    let package = prefix.join("node_modules/@openai/codex");
    let mut candidates = vec![prefix.join("codex.exe")];
    for triplet in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
        for directory in ["codex", "bin"] {
            candidates.push(package.join(format!("vendor/{triplet}/{directory}/codex.exe")));
            for name in ["codex-win32-x64", "codex-win32-arm64"] {
                candidates.push(package.join(format!(
                    "node_modules/@openai/{name}/vendor/{triplet}/{directory}/codex.exe"
                )));
                candidates.push(prefix.join(format!(
                    "node_modules/@openai/{name}/vendor/{triplet}/{directory}/codex.exe"
                )));
            }
        }
    }
    candidates
}

// The Windows desktop app can download its runtime outside the app package.
// Hash directory names are not versions: prefer running runtimes, otherwise
// retain all candidates so the user can select when the cache is ambiguous.
#[cfg(any(windows, test))]
fn windows_runtime_candidates(base: &Path, running: &[PathBuf]) -> Vec<PathBuf> {
    let root = base.join("OpenAI/Codex/bin");
    let mut candidates: Vec<_> = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path().join("codex.exe"))
        .filter(|path| path.is_file())
        .collect();
    candidates.sort();
    let active: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            running.iter().any(|path| {
                path.to_string_lossy()
                    .replace('\\', "/")
                    .eq_ignore_ascii_case(&candidate.to_string_lossy().replace('\\', "/"))
            })
        })
        .cloned()
        .collect();
    if active.is_empty() {
        candidates
    } else {
        active
    }
}

#[cfg(any(windows, test))]
fn merge_windows_runtimes(result: &mut Vec<Installation>, runtimes: Vec<Installation>) {
    if !result.iter().any(|item| item.kind == "desktop") {
        return;
    }
    if runtimes.len() == 1 {
        // Only associate a detached runtime with a package when unambiguous.
        let desktops: Vec<_> = result
            .iter_mut()
            .filter(|item| item.kind == "desktop")
            .collect();
        if desktops.len() == 1 {
            let desktop = desktops.into_iter().next().unwrap();
            if desktop.runtime_version.is_none() {
                desktop.runtime_version = runtimes[0].runtime_version.clone();
                return;
            }
            if desktop.runtime_version == runtimes[0].runtime_version {
                return;
            }
        }
    }
    result.extend(runtimes);
}

async fn detect() -> Result<Vec<Installation>> {
    #[cfg(debug_assertions)]
    if std::env::var_os("CODEXBEI_PREVIEW_NO_CHATGPT").is_some() {
        return Ok(Vec::new());
    }
    #[cfg(not(windows))]
    let home = dirs::home_dir().unwrap_or_default();
    let mut cli = Vec::<PathBuf>::new();
    #[cfg(not(windows))]
    let mut apps = Vec::<(PathBuf, Option<String>)>::new();
    #[cfg(windows)]
    let apps = Vec::<(PathBuf, Option<String>)>::new();
    #[cfg(windows)]
    let mut registered_apps = Vec::new();
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
                    if bundle_id.starts_with("com.openai.") {
                        let Some(runtime) = macos_runtime(&bundle) else {
                            continue;
                        };
                        let version = info["CFBundleShortVersionString"]
                            .as_str()
                            .filter(|v| app_parts(v).is_some())
                            .map(str::to_owned);
                        apps.push((runtime, version));
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("PATH") {
            for prefix in std::env::split_paths(&path).filter(|p| p.is_absolute()) {
                if prefix.join("codex.cmd").is_file() || prefix.join("codex.ps1").is_file() {
                    cli.extend(windows_npm_candidates(&prefix));
                }
            }
        }
        if let Some(base) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(base).join("npm");
            cli.extend(windows_npm_candidates(&base));
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(base);
            cli.push(base.join("Microsoft/WinGet/Links/codex.exe"));
            for name in ["Codex", "ChatGPT"] {
                let directory = base.join(format!("Programs/{name}"));
                if directory.join(format!("{name}.exe")).is_file() {
                    let runtime = directory.join("resources/codex.exe");
                    registered_apps.push(Installation {
                        id: format!("desktop:{}", directory.to_string_lossy()),
                        kind: "desktop".into(),
                        runtime_version: command(&runtime, &["--version"])
                            .await
                            .ok()
                            .and_then(|s| parse_version(&s)),
                        app_version: None,
                    });
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
    #[cfg(windows)]
    {
        let package_result: Result<()> = async {
        let query = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @(Get-AppxPackage -ErrorAction Stop | Where-Object { $_.Name -in @('OpenAI.Codex','OpenAI.ChatGPT') } | Select-Object PackageFamilyName,InstallLocation,Version,@{Name='Status';Expression={$_.Status.ToString()}}) -Compress";
        let raw = command_with_timeout(
            Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", query],
            Duration::from_secs(5),
        )
        .await
        .map_err(|_| "无法检测 Windows 应用安装状态，请重试。".to_string())?;
        let packages: Vec<Value> = serde_json::from_str(&raw)
            .map_err(|_| "无法读取 Windows 应用安装列表，请重试。".to_string())?;
        for package in packages {
            if package["Status"].as_str() != Some("Ok") {
                return Err("ChatGPT 应用安装状态异常，请检查 Windows 应用设置。".into());
            }
            let location = package["InstallLocation"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("无法读取 ChatGPT 安装位置。")?;
            let family = package["PackageFamilyName"]
                .as_str()
                .ok_or("无法读取 ChatGPT 应用标识。")?;
            let mut runtime_version = None;
            for sub in ["app/resources/codex.exe", "resources/codex.exe"] {
                let path = PathBuf::from(location).join(sub);
                if path.is_file() {
                    runtime_version = command(&path, &["--version"])
                        .await
                        .ok()
                        .and_then(|s| parse_version(&s));
                    if runtime_version.is_some() {
                        break;
                    }
                }
            }
            registered_apps.push(Installation {
                id: format!("desktop:{family}"),
                kind: "desktop".into(),
                runtime_version,
                app_version: package["Version"]
                    .as_str()
                    .filter(|v| app_parts(v).is_some())
                    .map(str::to_owned),
            });
        }
            Ok(())
        }.await;
        if let Err(error) = package_result {
            if result.is_empty() && registered_apps.is_empty() {
                return Err(error);
            }
        }
    }
    #[cfg(windows)]
    result.extend(registered_apps);
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
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let query = "Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Select-Object -ExpandProperty ExecutablePath";
        let running = command(
            Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", query],
        )
        .await
        .unwrap_or_default();
        let running: Vec<_> = running
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect();
        let mut runtimes = Vec::new();
        for file in windows_runtime_candidates(Path::new(&base), &running)
            .into_iter()
            .take(20)
        {
            let Some(version) = command(&file, &["--version"])
                .await
                .ok()
                .and_then(|s| parse_version(&s))
            else {
                continue;
            };
            use sha2::{Digest, Sha256};
            runtimes.push(Installation {
                id: format!(
                    "desktop:{:x}",
                    Sha256::digest(file.to_string_lossy().as_bytes())
                ),
                kind: "desktop".into(),
                runtime_version: Some(version),
                app_version: None,
            });
        }
        merge_windows_runtimes(&mut result, runtimes);
    }
    Ok(result)
}
#[derive(Default)]
pub struct Detector {
    pub installations: Vec<Installation>,
    pub selection: Selection,
    detected: bool,
}

impl Detector {
    pub fn targets(&self) -> Result<Vec<Installation>> {
        select(&self.installations, &self.selection)
    }

    pub async fn refresh(&mut self, selection: Option<Selection>, force: bool) -> Result<bool> {
        let mut changed = false;
        if self.needs_detection(selection.as_ref(), force) {
            let installations = detect().await?;
            changed = self.accept_detection(installations);
        }
        Ok(self.select_version(selection)? || changed)
    }

    fn needs_detection(&self, selection: Option<&Selection>, force: bool) -> bool {
        !self.detected || (force && selection.is_none() && self.installations.is_empty())
    }

    fn accept_detection(&mut self, installations: Vec<Installation>) -> bool {
        self.installations = installations;
        self.detected = true;
        if matches!(&self.selection, Selection::Installed { id } if !self.installations.iter().any(|item| &item.id == id))
        {
            self.selection = Selection::Auto;
            return true;
        }
        false
    }

    fn select_version(&mut self, selection: Option<Selection>) -> Result<bool> {
        let mut changed = false;
        if let Some(selection) = selection {
            select(&self.installations, &selection)?;
            self.selection = selection;
            changed = true;
        }
        if matches!(self.selection, Selection::Auto) {
            if let Some(installation) = self
                .installations
                .iter()
                .find(|v| v.kind == "desktop" && v.runtime_version.is_some())
                .or_else(|| {
                    self.installations
                        .iter()
                        .find(|v| v.runtime_version.is_some())
                })
            {
                self.selection = Selection::Installed {
                    id: installation.id.clone(),
                };
                changed = true;
            }
        }
        Ok(changed)
    }
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
        Selection::Manual { kind, .. } if kind == "cli" => {
            Err("请输入有效的 Codex CLI 版本。".into())
        }
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
    json!({ "clientVersion": env!("CARGO_PKG_VERSION"), "targets": targets.iter().map(|v| serde_json::from_str::<Value>(v).unwrap()).collect::<Vec<_>>() })
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
    fn native_catalog_uses_the_lowest_selected_runtime() {
        for (values, expected) in [
            (vec![Some("0.156.0")], true),
            (vec![Some("0.156.1"), Some("0.156.0")], true),
            (vec![Some("0.156.0"), Some("0.155.1")], false),
            (vec![Some("0.155.1"), Some("0.156.0")], false),
            (vec![Some("0.156.0"), None], false),
            (vec![Some("0.156.0-alpha.16")], false),
            (vec![Some("0.162.0-alpha.17.2")], true),
            (vec![Some("0.162.1"), Some("0.162.0-alpha.17.2")], true),
            (vec![], false),
        ] {
            let targets: Vec<_> = values
                .into_iter()
                .enumerate()
                .map(|(i, version)| Installation {
                    id: i.to_string(),
                    kind: if i == 0 { "cli" } else { "desktop" }.into(),
                    runtime_version: version.map(str::to_owned),
                    app_version: Some("99.999.999".into()),
                })
                .collect();
            assert_eq!(supports_native_catalog(&targets), expected);
        }
    }
    #[test]
    fn finds_modern_npm_binary_in_custom_prefix() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root.path().join("custom Node directory");
        let binary = prefix.join("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"fixture").unwrap();
        let found: Vec<_> = windows_npm_candidates(&prefix)
            .into_iter()
            .filter(|p| p.is_file())
            .collect();
        assert_eq!(found, vec![binary]);
    }
    #[test]
    fn detector_only_rechecks_while_no_application_is_installed() {
        let mut detector = Detector::default();
        assert!(detector.needs_detection(None, false));
        detector.accept_detection(vec![]);
        assert!(detector.needs_detection(None, true));
        assert!(!detector.needs_detection(None, false));
        for kind in ["cli", "desktop"] {
            detector.accept_detection(vec![Installation {
                id: kind.into(),
                kind: kind.into(),
                runtime_version: Some("0.153.4".into()),
                app_version: None,
            }]);
            assert!(!detector.needs_detection(None, true));
            tauri::async_runtime::block_on(detector.refresh(None, true)).unwrap();
            assert_eq!(detector.targets().unwrap()[0].kind, kind);
        }
    }

    #[test]
    fn detector_updates_selection_after_uninstall_and_prefers_desktop() {
        let mut detector = Detector::default();
        let cli = Installation {
            id: "cli".into(),
            kind: "cli".into(),
            runtime_version: Some("0.153.4".into()),
            app_version: None,
        };
        let desktop = Installation {
            id: "desktop".into(),
            kind: "desktop".into(),
            runtime_version: Some("0.153.4".into()),
            app_version: Some("26.3.0".into()),
        };
        detector.accept_detection(vec![cli.clone(), desktop]);
        assert!(detector.select_version(None).unwrap());
        assert_eq!(detector.targets().unwrap()[0].id, "desktop");
        assert!(detector.accept_detection(vec![cli]));
        assert!(detector.select_version(None).unwrap());
        assert_eq!(detector.targets().unwrap()[0].id, "cli");
        assert!(detector.accept_detection(vec![]));
        assert!(!detector.select_version(None).unwrap());
        assert!(detector.targets().unwrap().is_empty());
    }

    #[test]
    fn detector_retains_manual_selection_and_rejects_missing_installation() {
        let mut detector = Detector::default();
        detector
            .select_version(Some(Selection::Manual {
                kind: "cli".into(),
                runtime_version: "0.153.4".into(),
                app_version: None,
            }))
            .unwrap();
        assert!(!detector.accept_detection(vec![]));
        assert!(!detector.select_version(None).unwrap());
        assert!(detector
            .select_version(Some(Selection::Installed {
                id: "missing".into()
            }))
            .is_err());
        assert_eq!(
            detector.targets().unwrap()[0].runtime_version.as_deref(),
            Some("0.153.4")
        );
    }
    #[test]
    fn detects_detached_windows_runtimes_and_prefers_running_path() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("User With Spaces/AppData/Local");
        assert!(windows_runtime_candidates(&base, &[]).is_empty());
        let first = base.join("OpenAI/Codex/bin/fd4c151a749f3ab4/codex.exe");
        let second = base.join("OpenAI/Codex/bin/aaaaaaaa/codex.exe");
        for file in [&first, &second] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"fixture").unwrap();
        }
        std::fs::create_dir_all(base.join("OpenAI/Codex/bin/incomplete")).unwrap();
        let all = windows_runtime_candidates(&base, &[]);
        assert_eq!(all.len(), 2);
        assert!(all.contains(&first) && all.contains(&second));
        assert_eq!(
            windows_runtime_candidates(&base, std::slice::from_ref(&first)),
            vec![first.clone()]
        );
        let running = PathBuf::from(first.to_string_lossy().replace('/', "\\").to_uppercase());
        assert_eq!(windows_runtime_candidates(&base, &[running]), vec![first]);
        assert_eq!(
            windows_runtime_candidates(&base, &[temp.path().join("unrelated/codex.exe")]),
            all
        );
    }

    #[test]
    fn detached_runtime_fills_unknown_package_without_losing_app_version() {
        let package = Installation {
            id: "package".into(),
            kind: "desktop".into(),
            runtime_version: None,
            app_version: Some("26.903.8094.0".into()),
        };
        let runtime = Installation {
            id: "cache".into(),
            kind: "desktop".into(),
            runtime_version: Some("0.153.4".into()),
            app_version: None,
        };
        let mut result = vec![package.clone()];
        merge_windows_runtimes(&mut result, vec![runtime.clone()]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].runtime_version.as_deref(), Some("0.153.4"));
        assert_eq!(result[0].app_version, package.app_version);
        let mut ambiguous = vec![package];
        let mut older = runtime.clone();
        older.id = "older".into();
        older.runtime_version = Some("0.152.0".into());
        merge_windows_runtimes(&mut ambiguous, vec![runtime.clone(), older]);
        assert_eq!(ambiguous.len(), 3);
        assert!(ambiguous[0].runtime_version.is_none());
        let mut standalone = Vec::new();
        merge_windows_runtimes(&mut standalone, vec![runtime]);
        assert!(
            standalone.is_empty(),
            "Detached runtime cache cannot prove the app is installed"
        );
    }

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
            json!({"clientVersion":env!("CARGO_PKG_VERSION"),"targets":[{"kind":"cli","runtimeVersion":"0.153.4"}]})
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
