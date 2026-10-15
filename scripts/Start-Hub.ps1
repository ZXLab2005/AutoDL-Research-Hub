param([switch]$InstallExtensions, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
# Preserve only original paths for the user-authorized remote Codex login flow.
# Do not copy credentials or replace an original path with a portable override.
if (-not $env:RESEARCH_HUB_ORIGINAL_CODEX_HOME -and $env:CODEX_HOME) {
    $env:RESEARCH_HUB_ORIGINAL_CODEX_HOME = $env:CODEX_HOME
}
if (-not $env:RESEARCH_HUB_ORIGINAL_USERPROFILE -and $env:USERPROFILE) {
    $env:RESEARCH_HUB_ORIGINAL_USERPROFILE = $env:USERPROFILE
}
$launch = Initialize-HubPortableRoot -Root $hubRoot -RequireEditor
# Every environment change is process-local. No registry/global settings are modified.
$hubEnv = @{
    RESEARCH_HUB_ROOT=$hubRoot
    TEMP=(Join-Path $hubRoot 'data\temp')
    TMP=(Join-Path $hubRoot 'data\temp')
    HOME=(Join-Path $hubRoot 'data\home')
    USERPROFILE=(Join-Path $hubRoot 'data\home')
    APPDATA=(Join-Path $hubRoot 'data\appdata\Roaming')
    LOCALAPPDATA=(Join-Path $hubRoot 'data\appdata\Local')
    CODEX_HOME=(Join-Path $hubRoot 'data\codex')
    XDG_CACHE_HOME=(Join-Path $hubRoot 'data\cache')
    XDG_CONFIG_HOME=(Join-Path $hubRoot 'data\home\.config')
    XDG_DATA_HOME=(Join-Path $hubRoot 'data\home\.local\share')
    npm_config_cache=(Join-Path $hubRoot 'data\cache\npm')
    PIP_CACHE_DIR=(Join-Path $hubRoot 'data\cache\pip')
    PYTHONPYCACHEPREFIX=(Join-Path $hubRoot 'data\cache\pycache')
    JUPYTER_CONFIG_DIR=(Join-Path $hubRoot 'data\home\.jupyter')
    JUPYTER_DATA_DIR=(Join-Path $hubRoot 'data\home\.local\share\jupyter')
    JUPYTER_RUNTIME_DIR=(Join-Path $hubRoot 'data\temp\jupyter')
    HF_HOME=(Join-Path $hubRoot 'data\cache\huggingface')
    TORCH_HOME=(Join-Path $hubRoot 'data\cache\torch')
    MPLCONFIGDIR=(Join-Path $hubRoot 'data\cache\matplotlib')
    GRADLE_USER_HOME=(Join-Path $hubRoot 'data\cache\gradle')
    CARGO_HOME=(Join-Path $hubRoot 'data\home\.cargo')
    RUSTUP_HOME=(Join-Path $hubRoot 'data\home\.rustup')
}
foreach ($item in $hubEnv.GetEnumerator()) {
    Assert-HubManagedPath -Root $hubRoot -Path $item.Value | Out-Null
    [IO.Directory]::CreateDirectory($item.Value) | Out-Null
    [Environment]::SetEnvironmentVariable($item.Key, $item.Value, 'Process')
}
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($hubRoot).TrimEnd('\')
$env:HOMEPATH = $hubEnv.USERPROFILE.Substring(2)
# Terminals and Codex child processes prefer this folder's tools as well.
$hubToolDirectories = @((Split-Path -Parent $launch.nodeExe), (Split-Path -Parent $launch.gitExe), (Split-Path -Parent $launch.ghExe), (Split-Path -Parent $launch.sshExe))
$env:PATH = ($hubToolDirectories -join ';') + ';' + $env:PATH
# Do not inherit an unrelated VS Code instance's IPC endpoint or portable profile.
foreach ($envName in @('VSCODE_IPC_HOOK_CLI','VSCODE_PORTABLE','ELECTRON_RUN_AS_NODE')) {
    [Environment]::SetEnvironmentVariable($envName, $null, 'Process')
}
& $launch.nodeExe (Join-Path $hubRoot 'scripts\initialize.js') $hubRoot
if ($LASTEXITCODE -ne 0) { throw 'Workspace initialization failed.' }
$appEntryInstaller = Join-Path $PSScriptRoot 'Install-AppEntry.ps1'
if (Test-Path -LiteralPath $appEntryInstaller -PathType Leaf) {
    # The App entry and icon are written only inside this portable folder.
    & $appEntryInstaller
}
$connection = Get-Content -LiteralPath (Join-Path $hubRoot 'data\connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($envName in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) {
    [Environment]::SetEnvironmentVariable($envName, $null, 'Process')
}
if ($connection.useProxy) {
    $env:HTTP_PROXY = $connection.proxyUrl
    $env:HTTPS_PROXY = $connection.proxyUrl
    $env:http_proxy = $connection.proxyUrl
    $env:https_proxy = $connection.proxyUrl
}
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:no_proxy = $env:NO_PROXY
$codeDir = Split-Path -Parent $launch.codeExe
$cliPath = Join-Path $codeDir 'resources\app\out\cli.js'
if (-not (Test-Path -LiteralPath $cliPath)) {
    $cmdText = Get-Content -LiteralPath (Join-Path $codeDir 'bin\code.cmd') -Raw
    if ($cmdText -match '\.\.\\([^"\r\n]+\\resources\\app\\out\\cli\.js)') {
        $cliPath = Join-Path $codeDir $Matches[1]
    }
}
if (-not (Test-Path -LiteralPath $cliPath)) { throw 'The bundled VS Code installation is incomplete. Restore app/vscode from a complete portable package.' }
$cliArgs = @('--user-data-dir',(Join-Path $hubRoot 'data\vscode-user'),'--extensions-dir',(Join-Path $hubRoot 'data\extensions'))
$env:ELECTRON_RUN_AS_NODE = '1'
try {
    if ($InstallExtensions) {
        foreach ($extensionId in @('ms-vscode-remote.remote-ssh','openai.chatgpt','ms-ceintl.vscode-language-pack-zh-hans')) {
            & $launch.nodeExe (Join-Path $PSScriptRoot 'run-vscode-cli.js') $launch.codeExe $cliPath @cliArgs '--install-extension' $extensionId
            if ($LASTEXITCODE -ne 0) { throw "Extension installation failed: $extensionId. Check Clash port and retry." }
        }
    }
    if (-not $NoLaunch) {
        # A file signal also reaches an already-running research window. It
        # resets only the home UI, never credentials, backups or research files.
        & $launch.nodeExe (Join-Path $PSScriptRoot 'fresh-start.js') $hubRoot
        if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare a fresh research session.' }
        # Open the local Codex control workspace so its AGENTS.md is in scope.
        # VS Code keeps its normal workspace trust prompt; no trust is bypassed.
        & $launch.nodeExe (Join-Path $PSScriptRoot 'run-vscode-cli.js') $launch.codeExe $cliPath @cliArgs '--new-window' '--locale' 'zh-cn' (Join-Path $hubRoot 'Research.code-workspace')
        if ($LASTEXITCODE -ne 0) { throw 'VS Code launch failed.' }
    }
} finally {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
}
if (-not $NoLaunch) {
    $syncControl = Join-Path $hubRoot 'github-sync\control.ps1'
    if ((Test-Path -LiteralPath $syncControl) -and (Test-Path -LiteralPath (Join-Path $hubRoot '.agent-sync\config.json'))) {
        # Separate process preserves the research window's portable environment.
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $syncControl + '"'),'-Action','start') -WindowStyle Hidden | Out-Null
    }
}
