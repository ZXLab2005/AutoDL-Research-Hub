<#
.SYNOPSIS
Installs or reuses the official Linux Codex CLI, prepares authorized credentials,
then opens an interactive SSH session in connection.json's remotePath.
.DESCRIPTION
InstallOnly does not inspect or copy any auth.json. PrepareOnly can transfer the
user-authorized local auth.json when the remote saved login is absent, but never
starts login prompts or model calls. Update explicitly refreshes the release.
Default runs reuse a working remote CLI or the verified portable package cache.
#>
[CmdletBinding(DefaultParameterSetName = 'Launch')]
param(
    [Parameter(ParameterSetName = 'Install')][switch]$InstallOnly,
    [Parameter(ParameterSetName = 'Prepare')][switch]$PrepareOnly,
    [switch]$Update,
    [string]$RemoteRoot,
    [string]$AuthFile
)
$ErrorActionPreference = 'Stop'
$hubExit = 2
$hubPreviousEnv = @{}
try {
    $hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    . (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
    $hubOriginalCodexHome = $env:RESEARCH_HUB_ORIGINAL_CODEX_HOME
    if (-not $hubOriginalCodexHome) { $hubOriginalCodexHome = $env:CODEX_HOME }
    $hubOriginalProfile = $env:RESEARCH_HUB_ORIGINAL_USERPROFILE
    if (-not $hubOriginalProfile) { $hubOriginalProfile = $env:USERPROFILE }
    $hubProfileFallback = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $hubLaunch = Initialize-HubPortableRoot -Root $hubRoot
    $hubEnvironment = @{
        HOME = (Join-Path $hubRoot 'data\home')
        USERPROFILE = (Join-Path $hubRoot 'data\home')
        APPDATA = (Join-Path $hubRoot 'data\appdata\Roaming')
        LOCALAPPDATA = (Join-Path $hubRoot 'data\appdata\Local')
        TEMP = (Join-Path $hubRoot 'data\temp')
        TMP = (Join-Path $hubRoot 'data\temp')
        TMPDIR = (Join-Path $hubRoot 'data\temp')
        CODEX_HOME = (Join-Path $hubRoot 'data\codex')
        XDG_CONFIG_HOME = (Join-Path $hubRoot 'data\home\.config')
        XDG_CACHE_HOME = (Join-Path $hubRoot 'data\cache')
        HOMEDRIVE = [IO.Path]::GetPathRoot($hubRoot).TrimEnd('\')
        HOMEPATH = (Join-Path $hubRoot 'data\home').Substring(2)
    }
    foreach ($hubEntry in $hubEnvironment.GetEnumerator()) {
        $hubPreviousEnv[$hubEntry.Key] = [Environment]::GetEnvironmentVariable($hubEntry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($hubEntry.Key, $hubEntry.Value, 'Process')
    }
    $hubAction = 'launch'
    if ($InstallOnly) { $hubAction = 'install' }
    if ($PrepareOnly) { $hubAction = 'prepare' }
    $hubUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $hubArguments = @((Join-Path $PSScriptRoot 'remote-codex.js'), $hubAction)
    $hubValues = @{
        '--root-base64' = $hubRoot
        '--remote-root-base64' = $RemoteRoot
        '--auth-file-base64' = $AuthFile
        '--original-codex-home-base64' = $hubOriginalCodexHome
        '--original-profile-base64' = $hubOriginalProfile
        '--profile-fallback-base64' = $hubProfileFallback
    }
    foreach ($hubEntry in $hubValues.GetEnumerator()) {
        if ($hubEntry.Value) { $hubArguments += @($hubEntry.Key, [Convert]::ToBase64String($hubUtf8.GetBytes($hubEntry.Value))) }
    }
    if ($Update) { $hubArguments += '--update' }
    & $hubLaunch.nodeExe @hubArguments
    $hubExit = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('[Remote Codex] ' + $_.Exception.Message)
    $hubExit = 2
} finally {
    foreach ($hubEntry in $hubPreviousEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($hubEntry.Key, $hubEntry.Value, 'Process')
    }
}
exit $hubExit
