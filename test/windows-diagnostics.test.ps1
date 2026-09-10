# Run with Windows PowerShell 5.1 or PowerShell 7. Uses an isolated fixture only.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '../scripts/windows-diagnostics.ps1'
. $script -LibraryOnly
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
$definitions = @(Get-ProxyDefinitions "# HTTP_PROXY=ignored`r`nexport HTTPS_PROXY='http://127.0.0.1:7890'`r`nAPI_KEY=fixture-secret`r`nno_proxy=*`r`nHTTPS_PROXY=duplicate")
Assert ($definitions.Count -eq 3) 'Proxy parsing must exclude comments and credentials, preserving duplicate definitions.'
Assert ($definitions[0].name -eq 'HTTPS_PROXY') 'Expected normalized name.'
Assert ((Get-LoopbackPort "'http://127.0.0.1:7890'") -eq 7890) 'Quoted local proxy should be detected.'
Assert ($null -eq (Get-LoopbackPort 'http://user:password@example.com:7890')) 'Remote credentials must not be exposed or probed.'
Assert ($null -eq (Get-LoopbackPort 'http://127.0.0.1:99999')) 'Invalid ports must not be probed.'
Assert ($null -eq (Get-LoopbackPort '${PROXY_URL}')) 'Do not evaluate dotenv expressions.'
Assert ((Get-HttpFinding '401') -match '不代表对话认证成功') '401 must not be presented as authenticated conversation success.'
Assert ((Get-HttpFinding '000') -match '未收到 HTTP') 'Failed HTTP probe must be reported.'
Assert ((ConvertTo-NativeArgument 'a"b') -eq '"a\"b"') 'Native arguments must quote embedded quotes.'

$root = Join-Path ([IO.Path]::GetTempPath()) ('codexbei-diagnostic-test-' + [Guid]::NewGuid())
[void][IO.Directory]::CreateDirectory($root)
$names = @('CODEX_HOME', 'LOCALAPPDATA', 'SystemRoot', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:CODEX_HOME = $root
    $env:LOCALAPPDATA = $root
    $env:SystemRoot = $root
    $env:HTTPS_PROXY = 'http://private-user:fixture-password@example.invalid:8000'
    $env:HTTP_PROXY = ''
    $env:ALL_PROXY = ''
    $env:NO_PROXY = '*'
    $envPath = Join-Path $root '.env'
    $original = "API_KEY=fixture-secret`r`nHTTPS_PROXY=http://private-user:fixture-password@example.invalid:7890`r`nNO_PROXY=localhost`r`n"
    [IO.File]::WriteAllText($envPath, $original)
    $raw = & $script -BaseUrl 'https://example.invalid/v1' -ConfigPath (Join-Path $root 'config.toml')
    $report = $raw | ConvertFrom-Json
    Assert $report.hasDotEnvProxy 'The report must detect .env overrides.'
    Assert ($raw -notmatch 'fixture-secret|fixture-password|private-user|example.invalid:7890') 'Report leaked private content.'
    Assert ([IO.File]::ReadAllText($envPath) -eq $original) 'Diagnostic changed .env.'
    Assert ($env:NO_PROXY -eq '*') 'Diagnostic loaded dotenv into its own environment.'
    Assert (@($report.checks | Where-Object status -eq 'warning').Count -gt 0) 'Missing native tools must not be reported as success.'
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'Windows diagnostics script tests passed.'
