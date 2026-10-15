<#
.SYNOPSIS
Executes UTF-8 Bash research commands on the saved AutoDL instance via key-only SSH.
.DESCRIPTION
Command and ScriptPath are mutually exclusive. Each invocation changes to the
validated connection.remotePath on AutoDL before executing the supplied script.
No research command is evaluated by Windows PowerShell. ScriptPath must be a
UTF-8 file inside this portable application. SSH never asks for a password.
TimeoutSeconds=0 waits indefinitely. A timeout closes SSH and returns 124;
a remote job may continue. Use tmux/nohup explicitly for persistent remote jobs.
The SSH/remote exit code is returned unchanged unless local validation fails (2),
SSH cannot start (127), the operation times out (124), or it is interrupted (130).
Label is an optional short action title for the live dashboard. Never put command
text, passwords or tokens in Label. The journal excludes command/script contents.
.EXAMPLE
.\Invoke-AutoDL.ps1 -Command 'pwd; hostname; nvidia-smi'
.EXAMPLE
.\Invoke-AutoDL.ps1 -ScriptPath (Join-Path $PSScriptRoot '..\workspace\experiment.sh') -TimeoutSeconds 600
#>
[CmdletBinding(DefaultParameterSetName = 'Command')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Command', Position = 0)]
    [AllowEmptyString()]
    [string]$Command,
    [Parameter(Mandatory = $true, ParameterSetName = 'Script')]
    [string]$ScriptPath,
    [ValidateRange(0, 2147483)]
    [int]$TimeoutSeconds = 0,
    [ValidateRange(1, 300)]
    [int]$ConnectTimeoutSeconds = 15,
    [ValidateLength(1, 120)]
    [ValidatePattern('^[^\x00-\x1f\x7f-\x9f\u2028\u2029]+$')]
    [string]$Label
)
$ErrorActionPreference = 'Stop'
$hubExit = 2
$hubPreviousEnv = @{}
try {
    $hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    . (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
    $hubLaunch = Initialize-HubPortableRoot -Root $hubRoot
    $hubEnvironment = @{
        HOME = (Join-Path $hubRoot 'data\home')
        USERPROFILE = (Join-Path $hubRoot 'data\home')
        APPDATA = (Join-Path $hubRoot 'data\appdata\Roaming')
        LOCALAPPDATA = (Join-Path $hubRoot 'data\appdata\Local')
        TEMP = (Join-Path $hubRoot 'data\temp')
        TMP = (Join-Path $hubRoot 'data\temp')
        TMPDIR = (Join-Path $hubRoot 'data\temp')
        XDG_CONFIG_HOME = (Join-Path $hubRoot 'data\home\.config')
        XDG_CACHE_HOME = (Join-Path $hubRoot 'data\cache')
        HOMEDRIVE = [IO.Path]::GetPathRoot($hubRoot).TrimEnd('\')
        HOMEPATH = (Join-Path $hubRoot 'data\home').Substring(2)
    }
    foreach ($hubEntry in $hubEnvironment.GetEnumerator()) {
        $hubPreviousEnv[$hubEntry.Key] = [Environment]::GetEnvironmentVariable($hubEntry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($hubEntry.Key, $hubEntry.Value, 'Process')
    }
    # Base64 makes Unicode, nested quotes and multiline text safe across PS 5.1's native argv boundary.
    $hubUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $hubArguments = @(
        (Join-Path $PSScriptRoot 'invoke-autodl.js'),
        '--root-base64', [Convert]::ToBase64String($hubUtf8.GetBytes($hubRoot)),
        '--timeout-seconds', $TimeoutSeconds.ToString([Globalization.CultureInfo]::InvariantCulture),
        '--connect-timeout-seconds', $ConnectTimeoutSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)
    )
    if ($PSCmdlet.ParameterSetName -eq 'Command') {
        $hubArguments += @('--command-base64', [Convert]::ToBase64String($hubUtf8.GetBytes($Command)))
    } else {
        $hubArguments += @('--script-base64', [Convert]::ToBase64String($hubUtf8.GetBytes($ScriptPath)))
    }
    if ($PSBoundParameters.ContainsKey('Label')) {
        $hubArguments += @('--label-base64', [Convert]::ToBase64String($hubUtf8.GetBytes($Label)))
    }
    & $hubLaunch.nodeExe @hubArguments
    $hubExit = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine('[AutoDL] ' + $_.Exception.Message)
    $hubExit = 2
} finally {
    foreach ($hubEntry in $hubPreviousEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($hubEntry.Key, $hubEntry.Value, 'Process')
    }
}
exit $hubExit
