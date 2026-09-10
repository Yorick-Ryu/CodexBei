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
    if ($Code -eq '401') { return 'HTTP 401：接口可达；未携带密钥，这是预期结果，不代表对话认证成功。' }
    if ($Code -match '^[1-5][0-9]{2}$') { return "HTTP ${Code}：收到 HTTP 响应；不代表模型对话成功。" }
    return '未收到 HTTP 响应；检查网络、DNS、证书或代理。'
}
if ($LibraryOnly) { return }

$rows = New-Object 'System.Collections.Generic.List[object]'
function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
    $rows.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}
$ports = @{}
function Inspect-Proxy([string]$Source, [string]$Name, [string]$Value) {
    if ($Name -eq 'NO_PROXY') {
        Add-Check $Source 'info' 'NO_PROXY 绕过列表已设置（值已隐藏）；.env 中的同名变量可能覆盖终端设置。'
        return
    }
    if (-not $Value -or $Value -in @('""', "''")) {
        Add-Check $Source 'info' "$Name 为空。"
        return
    }
    $port = Get-LoopbackPort $Value
    $detail = "$Name 已设置（值已隐藏）。"
    if ($null -ne $port) {
        $cacheKey = $Value.Trim()
        if (-not $ports.ContainsKey($cacheKey)) { $ports[$cacheKey] = Test-Loopback $port $Value }
        $detail = "$Name 指向本机端口 $port；"
        if ($ports[$cacheKey]) { $detail += '端口可连接，但尚未验证代理协议。' }
        else { $detail += '端口不可连接；若 Codex 使用此代理，会导致连接失败。' }
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
        if ($definitions.Count -gt 24) { Add-Check 'Codex .env' 'warning' '代理赋值超过 24 项，仅检测前 24 项，请手动检查重复或冲突设置。' }
        if ($hasDotEnvProxy) {
            Add-Check '启动时覆盖代理' 'warning' 'Codex 启动时会读取 CODEX_HOME 下的 .env，并可能覆盖终端代理变量。请核查这些代理行；不要分享整个文件。'
        } else { Add-Check 'Codex .env' 'ok' '未发现代理变量赋值。' }
    } else { Add-Check 'Codex .env' 'info' '文件不存在。' }
} catch { Add-Check 'Codex .env' 'warning' '无法完整读取；请检查文件权限、大小和编码。' }
if ($ConfigPath) {
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { Add-Check '所选配置文件' 'ok' '文件存在；配置预览不等于内核实际加载的配置。' }
    else { Add-Check '所选配置文件' 'warning' '文件不存在。' }
    if ([IO.Path]::GetFullPath($ConfigPath) -ne [IO.Path]::GetFullPath((Join-Path $homeDir 'config.toml'))) {
        Add-Check '配置位置' 'warning' '所选文件与当前进程 CODEX_HOME 下的默认配置不同；桌面端可能使用另一份配置。.env 按 CODEX_HOME 检查。'
    }
}
foreach ($scope in @('Process', 'User', 'Machine')) {
    $count = 0
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')) {
        $value = [Environment]::GetEnvironmentVariable($name, $scope)
        if ($value) { $count++; Inspect-Proxy "环境变量：$scope" $name $value }
    }
    if (-not $count) { Add-Check "环境变量：$scope" 'info' '未设置代理变量。' }
}
try {
    $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($settings.ProxyEnable -eq 1) {
        Add-Check 'Windows 手动代理' 'warning' '已启用；请检查代理软件是否运行。'
    } else { Add-Check 'Windows 手动代理' 'info' '未启用；ProxyServer 的残留地址不代表代理已启用。' }
    if ($settings.AutoConfigURL) { Add-Check '自动代理脚本' 'warning' '已配置 PAC 地址（已隐藏）；自动代理可能与手动开关不同。' }
} catch { Add-Check 'Windows 手动代理' 'warning' '读取失败。' }
$winhttp = Invoke-Bounded (Join-Path $env:SystemRoot 'System32/netsh.exe') @('winhttp', 'show', 'proxy')
if ($winhttp.code -eq 0 -and $winhttp.text -match 'Direct access|直接访问') {
    Add-Check 'WinHTTP' 'info' '默认代理设置为直接访问；不能据此排除环境变量或 PAC。'
} else { Add-Check 'WinHTTP' 'warning' '存在代理设置或无法识别输出；请在终端运行 netsh winhttp show proxy 检查。' }

# Probe unauthenticated HTTPS only. Do not send keys, prompts, or requests to models.
try {
    $uri = [Uri]$BaseUrl
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'url' }
    $target = $uri.AbsoluteUri.TrimEnd('/') + '/models'
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    foreach ($mode in @('直连 HTTPS', 'curl 默认连接')) {
        $arguments = @('-q', '--connect-timeout', '4', '--max-time', '6', '-sS', '-o', 'NUL', '-w', '%{http_code}')
        if ($mode -eq '直连 HTTPS') { $arguments += @('--noproxy', '*') }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $probe = Invoke-Bounded $curl ($arguments + @($target)) 8
        $timer.Stop()
        $code = $probe.text.Trim()
        $status = if ($probe.code -eq 0 -and $code -match '^[1-5][0-9]{2}$') { 'ok' } else { 'warning' }
        Add-Check $mode $status ((Get-HttpFinding $code) + (" 耗时 {0} ms。" -f $timer.ElapsedMilliseconds))
    }
    Add-Check '连接测试范围' 'info' 'curl 默认连接不等于 Codex 连接；本测试不加载 .env，不验证密钥、模型、WebSocket 或完整对话；耗时不代表模型生成速度。'
} catch { Add-Check 'HTTPS 测试' 'warning' 'API 地址无效或检测不可用；只接受不含凭证、查询参数和片段的 HTTPS 地址。' }

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
} catch { Add-Check '商店版内核路径' 'info' '无法读取商店安装目录，继续检查普通安装目录。' }
$native = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($native) { $candidates.Add($native.Source) }
$found = $false
foreach ($file in @($candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 5)) {
    $result = Invoke-Bounded $file @('--version') 3
    if ($result.code -eq 0 -and $result.text -match '^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\s*$') {
        $found = $true
        Add-Check '内核版本' 'ok' "内核可启动：$($Matches[1])。版本检测成功不代表网络可用。"
        break
    }
}
if (-not $found) { Add-Check '内核版本' 'warning' '常见安装路径中未找到可读取版本的内核；可手动运行 codex.exe --version。' }
Add-Check '下一步' 'info' '修正代理后，完全退出并重新打开 Codex，再新建对话。若仍失败，关闭 WebSocket 和无限重试做对照；技能描述缩短提示不属于连接故障。'
[pscustomobject]@{
    schemaVersion = 1
    hasDotEnvProxy = $hasDotEnvProxy
    checks = @($rows.ToArray())
} | ConvertTo-Json -Depth 5
