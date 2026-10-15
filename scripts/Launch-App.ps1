param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
# Windows PowerShell launched by WScript may otherwise decode Node's UTF-8
# output using the legacy console code page, garbling Chinese folder names.
$appUtf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $appUtf8
$OutputEncoding = $appUtf8
$hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$hubLaunch = Initialize-HubPortableRoot -Root $hubRoot -RequireEditor
$appDirectory = Join-Path $hubRoot 'data\app'
$launchLog = Join-Path $appDirectory 'launch.log'
& $hubLaunch.nodeExe -e 'const c=require(process.argv[1]); for (const p of process.argv.slice(3)) c.assertEPath(p,{within:process.argv[2]});' (Join-Path $hubRoot 'src\core.js') $hubRoot $appDirectory $launchLog
if ($LASTEXITCODE -ne 0) { throw 'The app output paths must resolve inside the portable folder.' }
[IO.Directory]::CreateDirectory($appDirectory) | Out-Null
# Keep only the current launch log in the platform, never in the Windows profile.
Set-Content -LiteralPath $launchLog -Value ('AutoDL Research Hub launch: ' + [DateTimeOffset]::Now.ToString('o')) -Encoding UTF8
try {
    & (Join-Path $PSScriptRoot 'Start-Hub.ps1') -NoLaunch:$NoLaunch *>&1 | Out-File -LiteralPath $launchLog -Encoding UTF8 -Append
    Add-Content -LiteralPath $launchLog -Value 'Launch completed.' -Encoding UTF8
} catch {
    Add-Content -LiteralPath $launchLog -Value $_.Exception.Message -Encoding UTF8
    exit 1
}
