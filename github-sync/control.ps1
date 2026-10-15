param([ValidateSet('start','status','stop','once')][string]$Action = 'status')
. (Join-Path $PSScriptRoot 'environment.ps1')
$syncScript = Join-Path $PSScriptRoot 'sync.js'
if ($Action -in @('start','once')) {
    # Rebase an existing, explicitly configured sync profile after a folder move.
    # The migration does not create a repository or grant publishing access.
    $syncTools = Initialize-HubPortableRoot -Root $syncRoot
    $syncNode = $syncTools.nodeExe
}
if ($Action -eq 'start') {
    if (-not (Test-Path -LiteralPath (Join-Path $syncRuntime 'config.json'))) { throw 'GitHub sync is not configured yet.' }
    $current = & $syncNode $syncScript status | ConvertFrom-Json
    if ($current.running) { $current | ConvertTo-Json -Depth 6; exit 0 }
    Start-Process -FilePath $syncNode -ArgumentList @(('"' + $syncScript + '"'), 'watch') -WorkingDirectory $syncRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $syncRuntime 'watch.stdout.log') -RedirectStandardError (Join-Path $syncRuntime 'watch.stderr.log') | Out-Null
    Write-Host 'Agent GitHub sync started. Use the status launcher to inspect progress.'
} else {
    & $syncNode $syncScript $Action
    exit $LASTEXITCODE
}
