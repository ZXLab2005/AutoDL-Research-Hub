param([switch]$NoPause)
$ErrorActionPreference = 'Stop'
$hubRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'Start-Hub.ps1') -NoLaunch
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$connection = Get-Content -LiteralPath (Join-Path $hubRoot 'data\connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $connection.host) { throw 'Save an SSH host first.' }
$sshExe = (Get-HubPortableTools -Root $hubRoot).sshExe
$sshConfig = Join-Path $hubRoot 'data\ssh\config'
# Read only the public companion file; do not derive or expose private-key data.
if (-not $connection.identityFile) { throw 'Select the portable private key before verifying key authentication.' }
$publicKeyFile = $connection.identityFile + '.pub'
$publicKeyParts = ((Get-Content -LiteralPath $publicKeyFile -Raw -Encoding UTF8).Trim() -split '\s+')
if ($publicKeyParts.Count -lt 2) { throw 'The selected key has no valid public companion file.' }
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $verifiedFingerprint = 'SHA256:' + [Convert]::ToBase64String($sha256.ComputeHash([Convert]::FromBase64String($publicKeyParts[1]))).TrimEnd('=')
} finally { $sha256.Dispose() }
$verification = & $sshExe '-F' $sshConfig '-o' 'BatchMode=yes' '-o' 'PasswordAuthentication=no' '-o' 'KbdInteractiveAuthentication=no' '-o' 'PreferredAuthentications=publickey' '-o' 'StrictHostKeyChecking=accept-new' '-o' 'ConnectTimeout=15' '-o' 'ConnectionAttempts=1' 'autodl-research' 'printf "AUTODL_KEY_AUTH_OK\n"; whoami; hostname; pwd'
$sshExit = $LASTEXITCODE
$verification | Write-Output
$verification | Set-Content -LiteralPath (Join-Path $hubRoot 'data\logs\ssh-verification.txt') -Encoding UTF8
if ($sshExit -ne 0 -or $verification -notcontains 'AUTODL_KEY_AUTH_OK') {
    throw 'Public-key-only authentication failed. No password fallback was attempted.'
}
$recordPath = Join-Path $hubRoot 'data\setup-state.json'
$record = [PSCustomObject]@{}
if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $record -or $record -isnot [PSCustomObject]) { throw 'The setup-state record must be a JSON object.' }
}
$record | Add-Member -NotePropertyName sshVerified -NotePropertyValue $true -Force
$record | Add-Member -NotePropertyName verifiedFingerprint -NotePropertyValue $verifiedFingerprint -Force
$record | Add-Member -NotePropertyName verifiedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
$record | Add-Member -NotePropertyName verifiedConnection -NotePropertyValue @{host=$connection.host;port=$connection.port;user=$connection.user;identityFile=$connection.identityFile} -Force
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordPath -Encoding UTF8
Write-Output 'PASS: passwordless SSH authentication was verified without password fallback.'
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
