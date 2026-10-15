param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$Root = Assert-HubManagedPath -Root $Root -Path $Root
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
$source = Join-Path $Root 'launcher\HubLauncher.cs'
$manifest = Join-Path $Root 'launcher\HubLauncher.manifest'
$appName = 'AutoDL' + [char]0x7814 + [char]0x7A76 + [char]0x53F0 + '.exe'
$output = Join-Path $Root $appName
$buildTemp = Join-Path $Root 'data\temp\launcher-build'
foreach ($candidate in @($source,$manifest,$output,$buildTemp)) { $null = Assert-HubManagedPath -Root $Root -Path $candidate }
[IO.Directory]::CreateDirectory($buildTemp) | Out-Null
$previousTemp = $env:TEMP; $previousTmp = $env:TMP
try {
    $env:TEMP = $buildTemp; $env:TMP = $buildTemp
    $arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/codepage:65001',('/out:' + $output),('/win32manifest:' + $manifest),'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Core.dll')
    $icon = Join-Path $Root 'data\app\hub.ico'
    if (Test-Path -LiteralPath $icon -PathType Leaf) { $arguments += '/win32icon:' + $icon }
    & $compiler @arguments $source
    if ($LASTEXITCODE -ne 0) { throw 'The launcher build failed.' }
    Write-Output ('Built portable launcher: ' + $output)
} finally { $env:TEMP = $previousTemp; $env:TMP = $previousTmp }
