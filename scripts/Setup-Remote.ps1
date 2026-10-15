$ErrorActionPreference = 'Stop'
$hubRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'Start-Hub.ps1') -NoLaunch
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$connection = Get-Content -LiteralPath (Join-Path $hubRoot 'data\connection.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if (-not $connection.host) { throw 'Save the SSH host in Research Hub first.' }
$sshConfig = Join-Path $hubRoot 'data\ssh\config'
$hubTools = Get-HubPortableTools -Root $hubRoot
& $hubTools.scpExe '-F' $sshConfig (Join-Path $hubRoot 'remote\bootstrap.sh') 'autodl-research:autodl-research-hub-bootstrap.sh'
if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Remote setup has not run.' }
$remoteCommand = 'bash ~/autodl-research-hub-bootstrap.sh --root /root/autodl-tmp/research-hub'
if ($connection.user -ne 'root') { throw 'Automatic remote setup currently supports the AutoDL root user. See REMOTE.md for other users.' }
if ($connection.tunnel) { $remoteCommand += ' --proxy-port ' + [int]$connection.remoteProxyPort }
& $hubTools.sshExe '-F' $sshConfig 'autodl-research' $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Remote setup failed; inspect the output above.' }
# connection.json has been validated by initialize.js; quote the allowed POSIX path.
& $hubTools.sshExe '-F' $sshConfig 'autodl-research' ("mkdir -p -- '" + $connection.remotePath + "'")
if ($LASTEXITCODE -ne 0) { throw 'Unable to create project directory.' }
Write-Host 'Remote environment prepared. Open the remote workspace from Research Hub.'
Read-Host 'Press Enter to close'
