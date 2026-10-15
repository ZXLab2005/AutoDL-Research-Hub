[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputPath,
    [switch]$NoRuntime
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')

function Assert-PlainLocalPath([string]$Candidate) {
    $resolved = [IO.Path]::GetFullPath($Candidate)
    if ($resolved -notmatch '^[A-Za-z]:\\') { throw 'Portable export requires a local Windows drive path.' }
    $walk = $resolved
    while ($walk) {
        if (Test-Path -LiteralPath $walk) {
            if (((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Portable export does not follow symbolic links or junctions.'
            }
        }
        $parentPath = Split-Path -Parent $walk
        if ($parentPath -eq $walk) { break }
        $walk = $parentPath
    }
    return $resolved
}

$Root = Assert-PlainLocalPath $Root
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'Platform folder does not exist.' }
foreach ($required in @('AutoDL研究台.exe', 'scripts\Bootstrap-Hub.ps1', 'launcher\dependencies.windows-x64.json', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) { throw "Required distribution file is missing: $required" }
}
if (-not $OutputPath) {
    $kind = if ($NoRuntime) { 'light' } else { 'portable' }
    $OutputPath = Join-Path $Root ('data\exports\AutoDL-Research-Hub-' + $kind + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
}
$OutputPath = Assert-PlainLocalPath $OutputPath
if ([IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'OutputPath must end with .zip.' }
if (Test-Path -LiteralPath $OutputPath) { throw 'The output already exists; choose a new ZIP file name.' }
$partialPath = $OutputPath + '.partial'
if (Test-Path -LiteralPath $partialPath) { throw 'An unfinished export exists at the selected output path.' }
[IO.Directory]::CreateDirectory((Split-Path -Parent $OutputPath)) | Out-Null

# Only named project folders and runtime distributions are eligible. User data,
# sibling projects and the export destination are never recursively collected.
$sourceDirectories = @('assets', 'src', 'scripts', 'launcher', 'remote', 'workspace', 'research', 'github-sync', 'tests', '.github')
$runtimeDirectories = @('app\node', 'app\vscode', 'app\git', 'app\gh', 'app\openssh')
$rootFiles = @('.gitignore', '.gitattributes', 'AutoDL研究台.exe', 'Research.code-workspace', 'package.json', 'package-lock.json', 'launch-config.example.json', 'LICENSE', 'NOTICE')
$selected = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
$skipped = New-Object 'System.Collections.Generic.List[string]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

function Get-RelativeName([string]$FullName) {
    if (-not $FullName.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'An export candidate escaped the platform folder.' }
    return $FullName.Substring($Root.Length + 1).Replace('\', '/')
}

function Test-ExcludedName([string]$Name, [bool]$Directory) {
    if ($Directory) { return $Name -in @('.git', '.agent-sync', 'user-data', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'node_modules-private') }
    if ($Name -match '(?i)\.(pdf|lnk|log|pyc|pyo|pfx|p12|pem|key)$') { return $true }
    if ($Name -match '(?i)^(auth(?:\.[^.]+)?\.json|known_hosts(?:\.old)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.[^.]+)?|cookies(?:\.[^.]+)?|hosts\.yml|launch-config\.json)$') { return $true }
    if ($Name -match '^\.env(?:\..+)?$' -and $Name -notmatch '^\.env\.(example|sample|template)$') { return $true }
    return $false
}

function Add-ExportFile([IO.FileInfo]$File) {
    $relative = Get-RelativeName $File.FullName
    if (($File.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Test-ExcludedName $File.Name $false)) { $skipped.Add($relative); return }
    if ($File.FullName -eq $OutputPath -or $File.FullName -eq $partialPath) { return }
    if (-not $seen.Add($relative)) { throw 'Duplicate paths found in the portable export.' }
    $selected.Add($File)
}

foreach ($file in (Get-ChildItem -LiteralPath $Root -Force -File)) {
    if ($rootFiles -contains $file.Name -or $file.Extension -in @('.md', '.cmd')) { Add-ExportFile $file }
}
$includedRuntime = New-Object 'System.Collections.Generic.List[string]'
$directories = @($sourceDirectories)
if (-not $NoRuntime) {
    foreach ($runtime in $runtimeDirectories) {
        if (Test-Path -LiteralPath (Join-Path $Root $runtime) -PathType Container) { $directories += $runtime; $includedRuntime.Add($runtime.Replace('\', '/')) }
    }
}
foreach ($relativeDirectory in $directories) {
    $directory = Join-Path $Root $relativeDirectory
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($directory)
    while ($pending.Count -gt 0) {
        $current = Get-Item -LiteralPath $pending.Pop() -Force
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $skipped.Add((Get-RelativeName $current.FullName)); continue }
        foreach ($entry in (Get-ChildItem -LiteralPath $current.FullName -Force)) {
            if ((Get-RelativeName $entry.FullName) -match '^app/vscode/data(?:/|$)' -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Test-ExcludedName $entry.Name $entry.PSIsContainer)) { $skipped.Add((Get-RelativeName $entry.FullName)); continue }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) } else { Add-ExportFile $entry }
        }
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = $null
$stream = $null
$totalBytes = [long]0
try {
    $stream = [IO.File]::Open($partialPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    $fileNumber = 0
    foreach ($file in $selected) {
        $relative = Get-RelativeName $file.FullName
        $level = if ($relative.StartsWith('app/')) { [IO.Compression.CompressionLevel]::Fastest } else { [IO.Compression.CompressionLevel]::Optimal }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, ('AutoDL-Research-Hub/' + $relative), $level) | Out-Null
        $totalBytes += $file.Length
        $fileNumber++
        if ($fileNumber % 100 -eq 0) { Write-Progress -Activity 'Exporting safe portable package' -Status "$fileNumber / $($selected.Count) files" -PercentComplete ([int](100 * $fileNumber / $selected.Count)) }
    }
    $manifest = [ordered]@{
        formatVersion = 1
        packageType = 'safe-share'
        createdUtc = [DateTime]::UtcNow.ToString('o')
        platform = 'Windows'
        runtimeRequested = (-not $NoRuntime)
        includedRuntimeDirectories = @($includedRuntime.ToArray())
        sourceFileCount = $selected.Count
        uncompressedBytes = $totalBytes
        omittedUserData = @('data/', '.agent-sync/', '.git/', 'launch-config.json', '*.lnk', 'app/vscode/data/')
        skippedAdditionalFiles = @($skipped.ToArray())
        firstLaunch = 'Extract the entire folder, then run AutoDL研究台.exe. Missing runtimes require network access. Sign-ins and server data are not included.'
    } | ConvertTo-Json -Depth 5
    $manifestEntry = $archive.CreateEntry('AutoDL-Research-Hub/PORTABLE-MANIFEST.json')
    $manifestStream = $manifestEntry.Open()
    $writer = New-Object IO.StreamWriter($manifestStream, (New-Object Text.UTF8Encoding($false)))
    try { $writer.Write($manifest) } finally { $writer.Dispose() }
    $archive.Dispose(); $archive = $null
    $stream.Dispose(); $stream = $null
    Move-Item -LiteralPath $partialPath -Destination $OutputPath
    Write-Progress -Activity 'Exporting safe portable package' -Completed
    [pscustomobject]@{Path=$OutputPath;Files=$selected.Count;Bytes=(Get-Item -LiteralPath $OutputPath).Length;IncludedRuntime=@($includedRuntime.ToArray());ExcludedPrivateDirectories=$true}
} catch {
    if ($archive) { $archive.Dispose() }
    if ($stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $partialPath -PathType Leaf) { Remove-Item -LiteralPath $partialPath }
    throw
}
