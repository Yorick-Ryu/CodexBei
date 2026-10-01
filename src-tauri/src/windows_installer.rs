use crate::{config::Result, versions};
use std::path::PathBuf;

const DOWNLOAD: &str =
    "https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi";
const STORE: &str = "ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS";

fn system_file(relative: &str) -> Option<PathBuf> {
    std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join(relative))
}

async fn store_available() -> bool {
    let Some(powershell) = system_file("System32/WindowsPowerShell/v1.0/powershell.exe") else {
        return false;
    };
    // Check the current user's registration, not packages provisioned for other users.
    // Errors/timeouts are inconclusive: use the HTTPS installer in that case.
    let script = r#"
$ErrorActionPreference = 'Stop'
try {
    $store = Get-AppxPackage -Name Microsoft.WindowsStore
    if (-not $store -or $store.Status -ne 'Ok') { exit 0 }
    if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\ms-windows-store')) { exit 0 }
    foreach ($key in @('HKCU:\SOFTWARE\Policies\Microsoft\WindowsStore', 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore')) {
        if (Test-Path $key) {
            $policy = Get-ItemProperty $key
            if ($policy.RemoveWindowsStore -eq 1 -or $policy.DisableStoreApps -eq 1) { exit 0 }
        }
    }
    Write-Output 'available'
} catch { exit 1 }
"#;
    versions::command(
        &powershell,
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
    .await
    .is_ok_and(|output| output.trim() == "available")
}

async fn open_url(url: &str) -> Result<()> {
    let cmd =
        system_file("System32/cmd.exe").ok_or_else(|| "无法定位 Windows 系统目录。".to_string())?;
    // URLs are fixed constants; no user input is passed to the command shell.
    versions::command(&cmd, &["/D", "/C", "start", "", url])
        .await
        .map(|_| ())
        .map_err(|_| "无法打开安装入口，请用浏览器访问 https://get.microsoft.com/installer/download/9PLM9XGG6VKS?cid=website_cta_psi".to_string())
}

pub(crate) async fn open(direct_download: bool) -> Result<()> {
    if !direct_download && store_available().await && open_url(STORE).await.is_ok() {
        return Ok(());
    }
    open_url(DOWNLOAD).await
}
