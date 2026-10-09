param(
  [Parameter(Mandatory=$true)][ValidateSet('x86_64-pc-windows-msvc','aarch64-pc-windows-msvc')][string]$Target,
  [switch]$SkipUi
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CodexBeiNativeWindow { public IntPtr Handle; public string Title; }
public static class CodexBeiWindowProbe {
  private delegate bool Callback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder title, int length);
  public static CodexBeiNativeWindow[] Read(int process) {
    var result = new List<CodexBeiNativeWindow>();
    EnumWindows((handle, parameter) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner == (uint)process && IsWindowVisible(handle)) {
        var title = new StringBuilder(512); GetWindowText(handle, title, title.Capacity);
        result.Add(new CodexBeiNativeWindow { Handle=handle, Title=title.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$installer = @(Get-ChildItem "src-tauri/target/$Target/release/bundle/nsis/*.exe")
if ($installer.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
$destination = Join-Path $env:RUNNER_TEMP 'CodexBei-package-test'
if (Test-Path $destination) { throw 'Install test directory already exists' }
$install = Start-Process -FilePath $installer[0].FullName -ArgumentList '/S', "/D=$destination" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
$executable = Join-Path $destination 'codexbei-desktop.exe'
if (!(Test-Path $executable)) { throw 'Installed executable missing' }
$bytes = [IO.File]::ReadAllBytes($executable)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$expected = if ($Target -eq 'aarch64-pc-windows-msvc') { 0xAA64 } else { 0x8664 }
if ($machine -ne $expected) { throw 'Wrong executable architecture' }
if ($SkipUi) {
  $version = (Get-Item $executable).VersionInfo.ProductVersion
  $expectedVersion = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
  if ($version -ne $expectedVersion -and $version -ne "$expectedVersion.0") { throw 'Installed application version mismatch' }
  New-Item -ItemType Directory -Path artifacts -Force | Out-Null
  @{ target=$Target; installer=$installer[0].Name; installExitCode=$install.ExitCode; machine=$machine;
    verificationMode='package-only'; appVersion=$version; source=$env:GITHUB_SHA;
    binarySha256=(Get-FileHash $executable -Algorithm SHA256).Hash;
    installerSha256=(Get-FileHash $installer[0].FullName -Algorithm SHA256).Hash
  } | ConvertTo-Json | Set-Content "artifacts/windows-package-$Target.json"
  Write-Host 'Silent installation, version and architecture verified; UI checks skipped.'
  return
}
if (Test-Path (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex/config.toml')) {
  throw 'Package smoke test requires a clean disposable runner profile'
}
$application = Start-Process -FilePath $executable -PassThru
try {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Seconds 1
    $application.Refresh()
    if ($application.HasExited) { throw "Application exited unexpectedly: $($application.ExitCode)" }
    $windows = @([CodexBeiWindowProbe]::Read($application.Id))
    $mainWindow = @($windows | Where-Object { $_.Title -eq 'CodexBei' })
  } while ($mainWindow.Count -eq 0 -and (Get-Date) -lt $deadline)
  if ($mainWindow.Count -eq 0) {
    Write-Host "Observed window title: $($application.MainWindowTitle)"
    $windows | Select-Object Handle, Title | Format-Table | Out-String | Write-Host
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object ProcessName, MainWindowTitle | Format-Table | Out-String | Write-Host
    throw 'Application did not finish opening its main window within 45 seconds'
  }
  New-Item -ItemType Directory -Path artifacts -Force | Out-Null
  @{ target=$Target; installer=$installer[0].Name; installExitCode=$install.ExitCode; machine=$machine;
    windowTitle=$mainWindow[0].Title; source=$env:GITHUB_SHA;
    binarySha256=(Get-FileHash $executable -Algorithm SHA256).Hash;
    installerSha256=(Get-FileHash $installer[0].FullName -Algorithm SHA256).Hash
  } | ConvertTo-Json | Set-Content "artifacts/windows-package-$Target.json"
} finally {
  if (!$application.HasExited) { $application.CloseMainWindow() | Out-Null; if (!$application.WaitForExit(5000)) { $application.Kill() } }
}
