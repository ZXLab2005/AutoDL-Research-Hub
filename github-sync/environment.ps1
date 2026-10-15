$ErrorActionPreference = 'Stop'
$syncRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $syncRoot 'scripts\Portable-Paths.ps1')
function Assert-SyncLocalPath([string]$Target) {
    Assert-HubManagedPath -Root $syncRoot -Path $Target | Out-Null
}
Assert-SyncLocalPath $syncRoot
$syncRuntime = Join-Path $syncRoot '.agent-sync'
$syncEnv = @{
    GH_CONFIG_DIR = (Join-Path $syncRuntime 'private\gh')
    GIT_CONFIG_GLOBAL = (Join-Path $syncRuntime 'private\gitconfig')
    HOME = (Join-Path $syncRuntime 'home')
    USERPROFILE = (Join-Path $syncRuntime 'home')
    APPDATA = (Join-Path $syncRuntime 'appdata\Roaming')
    LOCALAPPDATA = (Join-Path $syncRuntime 'appdata\Local')
    TEMP = (Join-Path $syncRuntime 'temp')
    TMP = (Join-Path $syncRuntime 'temp')
    XDG_CONFIG_HOME = (Join-Path $syncRuntime 'home\.config')
    XDG_CACHE_HOME = (Join-Path $syncRuntime 'cache')
}
foreach ($entry in $syncEnv.GetEnumerator()) {
    Assert-SyncLocalPath $entry.Value
    if ($entry.Key -ne 'GIT_CONFIG_GLOBAL') { [IO.Directory]::CreateDirectory($entry.Value) | Out-Null }
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
}
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($syncRoot).TrimEnd('\')
$env:HOMEPATH = $syncEnv.USERPROFILE.Substring(2)
$env:GH_NO_UPDATE_NOTIFIER = '1'
$env:GH_NO_EXTENSION_UPDATE_NOTIFIER = '1'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
$env:GIT_CONFIG_NOSYSTEM = '1'
# The sync profile owns its network choice; never override it with a stale port.
$syncConfigFile = Join-Path $syncRuntime 'config.json'
Assert-SyncLocalPath $syncConfigFile
$syncProxyUrl = ''
if (Test-Path -LiteralPath $syncConfigFile -PathType Leaf) {
    $syncLocalConfig = Get-Content -LiteralPath $syncConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $syncLocalConfig.proxyUrl) {
        if ($syncLocalConfig.proxyUrl -isnot [string]) { throw 'Sync proxyUrl must be a string.' }
        $syncProxyUrl = $syncLocalConfig.proxyUrl
    }
}
if ($syncProxyUrl) {
    $syncProxy = $null
    if (-not [Uri]::TryCreate($syncProxyUrl, [UriKind]::Absolute, [ref]$syncProxy) -or
        $syncProxy.Scheme -notin @('http','https') -or
        $syncProxy.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $syncProxy.UserInfo) {
        throw 'Sync proxy must be an HTTP(S) loopback address without credentials.'
    }
}
foreach ($proxyVariable in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {
    [Environment]::SetEnvironmentVariable($proxyVariable, $null, 'Process')
}
if ($syncProxyUrl) {
    $env:HTTP_PROXY = $syncProxyUrl
    $env:HTTPS_PROXY = $syncProxyUrl
    $env:ALL_PROXY = $syncProxyUrl
}
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$syncTools = Get-HubPortableTools -Root $syncRoot
$syncGit = $syncTools.gitExe
$syncGh = $syncTools.ghExe
$syncNode = $syncTools.nodeExe
$env:PATH = (Split-Path -Parent $syncGit) + ';' + (Split-Path -Parent $syncGh) + ';' + $env:PATH
