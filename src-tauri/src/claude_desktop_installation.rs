use crate::config::Result;
#[cfg(any(target_os = "macos", windows))]
use crate::versions;
use serde_json::{json, Value};
use std::path::Path;

#[cfg(any(target_os = "macos", test))]
fn macos_bundle_installed(bundle: &Path) -> bool {
    bundle.join("Contents/Info.plist").is_file() && bundle.join("Contents/MacOS/Claude").is_file()
}

#[cfg(any(windows, test))]
fn windows_directory_installed(directory: &Path) -> bool {
    let executable_exists =
        |path: &Path| path.join("Claude.exe").is_file() || path.join("claude.exe").is_file();
    if executable_exists(directory) {
        return true;
    }
    // Squirrel installs keep the application in a versioned child directory.
    std::fs::read_dir(directory).is_ok_and(|entries| {
        entries.filter_map(std::result::Result::ok).any(|entry| {
            entry.file_name().to_string_lossy().starts_with("app-")
                && executable_exists(&entry.path())
        })
    })
}

#[cfg(target_os = "macos")]
async fn installed() -> Result<bool> {
    let home = dirs::home_dir().ok_or("无法定位用户目录。")?;
    if [
        std::path::PathBuf::from("/Applications"),
        home.join("Applications"),
    ]
    .iter()
    .any(|root| macos_bundle_installed(&root.join("Claude.app")))
    {
        return Ok(true);
    }
    let found = versions::command(
        Path::new("/usr/bin/mdfind"),
        &["kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'"],
    )
    .await?;
    Ok(found
        .lines()
        .filter(|path| path.starts_with('/'))
        .take(50)
        .any(|path| {
            // A downloaded copy still on a mounted installer is not an installation.
            !path.starts_with("/Volumes/") && macos_bundle_installed(Path::new(path))
        }))
}

#[cfg(windows)]
async fn installed() -> Result<bool> {
    use std::path::PathBuf;
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        roots.extend([
            local.join("AnthropicClaude"),
            local.join("Claude"),
            local.join("Programs/Claude"),
        ]);
    }
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            roots.push(PathBuf::from(root).join("Claude"));
        }
    }
    if roots.iter().any(|root| windows_directory_installed(root)) {
        return Ok(true);
    }
    let powershell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or("无法定位 Windows 系统目录。")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script = r#"
$ErrorActionPreference = 'Stop'
try {
    foreach ($package in @(Get-AppxPackage -Name '*Claude*')) {
        if ($package.Status -ne 'Ok' -or -not $package.InstallLocation) { continue }
        $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
        foreach ($app in @($manifest.Package.Applications.Application)) {
            if ($app.Executable -and (Test-Path -LiteralPath (Join-Path $package.InstallLocation $app.Executable) -PathType Leaf)) {
                Write-Output 'installed'
                exit 0
            }
        }
    }
    Write-Output 'missing'
} catch { exit 1 }
"#;
    let output = versions::command(
        &powershell,
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
    .await
    .map_err(|_| "无法检测 Claude 桌面版安装状态，请点击重新检测。".to_string())?;
    match output.trim() {
        "installed" => Ok(true),
        "missing" => Ok(false),
        _ => Err("无法检测 Claude 桌面版安装状态，请点击重新检测。".into()),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn installed() -> Result<bool> {
    Err("Claude 桌面版配置暂支持 macOS 和 Windows。".into())
}

pub async fn inspect(test_root: Option<&Path>) -> Result<Value> {
    let detected = if let Some(root) = test_root {
        root.join("claude-desktop-installed").is_file()
    } else {
        installed().await?
    };
    Ok(json!({"installed": detected, "platform": std::env::consts::OS}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_directories_do_not_count_as_installed_apps() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude_desktop_config.json"), b"{}").unwrap();
        assert!(!macos_bundle_installed(dir.path()));
        assert!(!windows_directory_installed(dir.path()));
        let bundle = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("Claude"), b"fixture").unwrap();
        assert!(!macos_bundle_installed(dir.path()));
        std::fs::write(dir.path().join("Contents/Info.plist"), b"fixture").unwrap();
        assert!(macos_bundle_installed(dir.path()));
    }

    #[test]
    fn windows_detects_classic_and_versioned_installations() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Update.exe"), b"fixture").unwrap();
        assert!(!windows_directory_installed(dir.path()));
        let app = dir.path().join("app-1.0");
        std::fs::create_dir(&app).unwrap();
        std::fs::write(app.join("claude.exe"), b"fixture").unwrap();
        assert!(windows_directory_installed(dir.path()));
        std::fs::remove_dir_all(&app).unwrap();
        std::fs::write(dir.path().join("Claude.exe"), b"fixture").unwrap();
        assert!(windows_directory_installed(dir.path()));
    }
}
