# Windows PowerShell 5.1 / PowerShell 7. Read-only; never loads .env into the process.
[CmdletBinding()]
param(
    [string]$BaseUrl = 'https://api.beiapi.cn/v1',
    [string]$ConfigPath = '',
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-ProxyDefinitions([string]$Text) {
    # Report names only. Values are never copied into the report.
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*(?:export\s+)?((?:HTTP|HTTPS|ALL|NO)_PROXY)\s*=(.*)$') {
            [pscustomobject]@{ name = $Matches[1].ToUpperInvariant(); value = $Matches[2].Trim() }
        }
    }
}
function Get-LoopbackPort([string]$Value) {
    $candidate = $Value.Trim().Trim('"', "'")
    # Only inspect literal loopback addresses. Never resolve or connect to arbitrary proxy hosts.
    if ($candidate -match '^(?:(?:https?|socks5h?)://)?(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})/?$') {
        $port = [int]$Matches[1]
        if ($port -gt 0 -and $port -le 65535) { return $port }
    }
    return $null
}
function ConvertTo-NativeArgument([string]$Value) {
    # Windows CommandLineToArgvW-compatible quoting; no shell evaluation.
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Invoke-Bounded([string]$File, [string[]]$Arguments, [int]$Seconds = 4) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $File
    $start.Arguments = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Seconds * 1000)) {
            $process.Kill()
            return [pscustomobject]@{ code = -1; text = '' }
        }
        # Never return stderr: it can include proxy credentials or other private values.
        return [pscustomobject]@{ code = $process.ExitCode; text = $stdout.GetAwaiter().GetResult() }
    } catch { return [pscustomobject]@{ code = -1; text = '' } }
    finally { $process.Dispose() }
}
function Test-Loopback([int]$Port, [string]$Value) {
    $addresses = if ($Value -match 'localhost') { @('127.0.0.1', '::1') } elseif ($Value -match '\[::1\]') { @('::1') } else { @('127.0.0.1') }
    foreach ($address in $addresses) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $task = $client.ConnectAsync($address, $Port)
            if ($task.Wait(350) -and $client.Connected) { return $true }
        } catch { } finally { $client.Dispose() }
    }
    return $false
}
function Get-HttpFinding([string]$Code) {
    if ($Code -match '^[1-5][0-9]{2}$') { return "HTTP $Code" }
    return 'HTTP 000'
}
function Format-HttpResult([string]$Text, [int]$ExitCode, [long]$Elapsed) {
    $parts = $Text.Trim() -split '\|'
    if ($parts.Count -eq 7 -and $parts[0] -match '^\d{3}$' -and $parts[1] -match '^[0-9a-fA-F:.]*$' -and @($parts[2..6] | Where-Object { $_ -notmatch '^\d+(?:\.\d+)?$' }).Count -eq 0) {
        return "$(Get-HttpFinding $parts[0]); curl_exit=$ExitCode; ip=$($parts[1]); dns=$($parts[2])s; connect=$($parts[3])s; tls=$($parts[4])s; first_byte=$($parts[5])s; total=$($parts[6])s"
    }
    return "HTTP 000; curl_exit=$ExitCode; elapsed=${Elapsed}ms"
}
function Get-ProxyDisplay([string]$Value) {
    $safe = $Value -replace '(?i)(://)[^/@\s]+@', '$1REDACTED@'
    $safe = $safe -replace '(?i)([?&](?:api[_-]?key|token|password|secret)=)[^&#\s]+', '$1REDACTED'
    $safe = $safe -replace '\bsk-[A-Za-z0-9_-]+', 'REDACTED'
    return $safe
}
if ($LibraryOnly) { return }

$rows = New-Object 'System.Collections.Generic.List[object]'
function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
    $rows.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}
$ports = @{}
function Inspect-Proxy([string]$Source, [string]$Name, [string]$Value) {
    if ($Name -eq 'NO_PROXY') {
        Add-Check $Source 'info' "NO_PROXY=$(Get-ProxyDisplay $Value)"
        return
    }
    if (-not $Value -or $Value -in @('""', "''")) {
        Add-Check $Source 'info' "$Name=EMPTY"
        return
    }
    $port = Get-LoopbackPort $Value
    $detail = "$Name=$(Get-ProxyDisplay $Value)"
    if ($null -ne $port) {
        $cacheKey = $Value.Trim()
        if (-not $ports.ContainsKey($cacheKey)) { $ports[$cacheKey] = Test-Loopback $port $Value }
        $detail = "$Name=$(Get-ProxyDisplay $Value); port=$port; "
        if ($ports[$cacheKey]) { $detail += 'tcp=CONNECTED' }
        else { $detail += 'tcp=UNREACHABLE' }
    }
    Add-Check $Source 'warning' $detail
}

$homeDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$dotEnv = Join-Path $homeDir '.env'
$hasDotEnvProxy = $false
try {
    if (Test-Path -LiteralPath $dotEnv -PathType Leaf) {
        if ((Get-Item -LiteralPath $dotEnv -Force).Length -gt 1048576) { throw 'size' }
        $definitions = @(Get-ProxyDefinitions ([IO.File]::ReadAllText($dotEnv)))
        $hasDotEnvProxy = $definitions.Count -gt 0
        foreach ($entry in ($definitions | Select-Object -First 24)) { Inspect-Proxy 'Codex .env' $entry.name $entry.value }
        if ($definitions.Count -gt 24) { Add-Check 'Codex .env' 'warning' 'entries>24; scanned=24' }
        if (-not $hasDotEnvProxy) { Add-Check 'Codex .env' 'ok' 'proxy_entries=0' }
    } else { Add-Check 'Codex .env' 'info' 'NOT_FOUND' }
} catch { Add-Check 'Codex .env' 'warning' 'READ_FAILED' }
if ($ConfigPath) {
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { Add-Check '所选配置文件' 'ok' 'EXISTS' }
    else { Add-Check '所选配置文件' 'warning' 'NOT_FOUND' }
    if ([IO.Path]::GetFullPath($ConfigPath) -ne [IO.Path]::GetFullPath((Join-Path $homeDir 'config.toml'))) {
        Add-Check '配置位置' 'warning' "selected=$ConfigPath; default=$(Join-Path $homeDir 'config.toml')"
    }
}
foreach ($scope in @('Process', 'User', 'Machine')) {
    $count = 0
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        $value = [Environment]::GetEnvironmentVariable($name, $scope)
        if ($value) { $count++; Inspect-Proxy "环境变量：$scope" $name $value }
    }
    if (-not $count) { Add-Check "环境变量：$scope" 'info' 'HTTP_PROXY=UNSET; HTTPS_PROXY=UNSET; ALL_PROXY=UNSET; NO_PROXY=UNSET' }
}
try {
    $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($settings.ProxyEnable -eq 1) {
        Add-Check 'Windows 手动代理' 'warning' "ProxyEnable=1; ProxyServer=$(Get-ProxyDisplay $settings.ProxyServer)"
    } else { Add-Check 'Windows 手动代理' 'info' "ProxyEnable=0; ProxyServer=$(Get-ProxyDisplay $settings.ProxyServer)" }
    if ($settings.AutoConfigURL) { Add-Check '自动代理脚本' 'warning' "AutoConfigURL=$(Get-ProxyDisplay $settings.AutoConfigURL)" }
} catch { Add-Check 'Windows 手动代理' 'warning' 'READ_FAILED' }
$winhttp = Invoke-Bounded (Join-Path $env:SystemRoot 'System32/netsh.exe') @('winhttp', 'show', 'proxy')
if ($winhttp.code -eq 0 -and $winhttp.text -match 'Direct access|直接访问') {
    Add-Check 'WinHTTP' 'info' 'mode=DIRECT; exit=0'
} else { Add-Check 'WinHTTP' 'warning' "mode=PROXY_OR_UNKNOWN; exit=$($winhttp.code)" }

# Probe unauthenticated HTTPS only. Do not send keys, prompts, or requests to models.
try {
    $uri = [Uri]$BaseUrl
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'url' }
    $target = $uri.AbsoluteUri.TrimEnd('/') + '/models'
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    foreach ($mode in @('直连 HTTPS', 'curl 默认连接')) {
        $arguments = @('-q', '--connect-timeout', '4', '--max-time', '6', '-sS', '-o', 'NUL', '-w', '%{http_code}|%{remote_ip}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}')
        if ($mode -eq '直连 HTTPS') { $arguments += @('--noproxy', '*') }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $probe = Invoke-Bounded $curl ($arguments + @($target)) 8
        $timer.Stop()
        $code = ($probe.text.Trim() -split '\|')[0]
        $status = if ($probe.code -eq 0 -and $code -match '^[1-5][0-9]{2}$') { 'ok' } else { 'warning' }
        Add-Check $mode $status ("GET $target; auth=NONE; " + (Format-HttpResult $probe.text $probe.code $timer.ElapsedMilliseconds))
    }
} catch { Add-Check 'HTTPS 测试' 'warning' 'INVALID_URL_OR_PROBE_FAILED' }

$candidates = New-Object 'System.Collections.Generic.List[string]'
if ($env:LOCALAPPDATA) {
    foreach ($name in @('Codex', 'ChatGPT')) {
        $root = Join-Path $env:LOCALAPPDATA "OpenAI/$name/bin"
        if (Test-Path -LiteralPath $root) {
            Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 3 |
                ForEach-Object { $candidates.Add((Join-Path $_.FullName 'codex.exe')) }
        }
        $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs/$name/resources/codex.exe"))
    }
}
try {
    Get-AppxPackage -ErrorAction Stop | Where-Object { $_.Name -in @('OpenAI.Codex', 'OpenAI.ChatGPT') } |
        ForEach-Object {
            $candidates.Add((Join-Path $_.InstallLocation 'app/resources/codex.exe'))
            $candidates.Add((Join-Path $_.InstallLocation 'resources/codex.exe'))
        }
} catch { Add-Check '商店版内核路径' 'info' 'APPX_QUERY_FAILED' }
$native = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($native) { $candidates.Add($native.Source) }
$found = $false
foreach ($file in @($candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 5)) {
    $result = Invoke-Bounded $file @('--version') 3
    if ($result.code -eq 0 -and $result.text -match '^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\s*$') {
        $found = $true
        Add-Check '内核版本' 'ok' "path=$file; version=$($Matches[1]); exit=$($result.code)"
        break
    }
}
if (-not $found) { Add-Check '内核版本' 'warning' 'NO_READABLE_VERSION' }
[pscustomobject]@{
    schemaVersion = 1
    hasDotEnvProxy = $hasDotEnvProxy
    checks = @($rows.ToArray())
} | ConvertTo-Json -Depth 5
