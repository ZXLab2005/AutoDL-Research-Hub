param([string]$Root = (Split-Path -Parent $PSScriptRoot), [switch]$PrepareOnly, [switch]$Offline, [string]$ProxyUrl = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
. (Join-Path $PSScriptRoot 'Bootstrap-Library.ps1')
$Root = Assert-HubManagedPath -Root $Root -Path $Root
if ([Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem -or
    $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This package supports Windows 10/11 x64 only. ARM64 and 32-bit Windows need a separate build.'
}
if ($ProxyUrl) {
    $bootstrapProxy = $null
    if (-not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$bootstrapProxy) -or
        $bootstrapProxy.Scheme -notin @('http','https') -or $bootstrapProxy.UserInfo -or
        $bootstrapProxy.Host -notin @('127.0.0.1','localhost','[::1]','::1')) {
        throw 'Download proxy must be an HTTP(S) loopback address without credentials.'
    }
}
$bootstrapDirectory = Join-Path $Root 'data\bootstrap'
$bootstrapTemp = Join-Path $Root 'data\temp\bootstrap'
foreach ($directory in @($bootstrapDirectory,$bootstrapTemp)) {
    $null = Assert-HubManagedPath -Root $Root -Path $directory
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}
$env:TEMP = $bootstrapTemp; $env:TMP = $bootstrapTemp
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$bootstrapLockPath = Join-Path $bootstrapDirectory 'prepare.lock'
$null = Assert-HubManagedPath -Root $Root -Path $bootstrapLockPath
$bootstrapLock = $null
try {
    try { $bootstrapLock = [IO.File]::Open($bootstrapLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another launcher is preparing this folder. Wait for it to finish, then retry.' }
    Remove-HubBootstrapLeftovers -Root $Root
    $manifestPath = Join-Path $Root 'launcher\dependencies.windows-x64.json'
    $null = Assert-HubManagedPath -Root $Root -Path $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.platform -ne 'windows-x64' -or $manifest.dependencies.Count -ne 5) { throw 'Unsupported dependency manifest.' }
    $index = 0
    foreach ($dependency in $manifest.dependencies) {
        $progress = [int](5 + 75 * $index / $manifest.dependencies.Count); $index++
        $target = Join-Path $Root $dependency.directory
        $null = Assert-HubManagedPath -Root $Root -Path $target
        if (Test-HubDependencyFiles -Root $target -RequiredFiles $dependency.requiredFiles) {
            Write-HubBootstrapProgress $progress ('Using bundled ' + $dependency.name)
            continue
        }
        if ($dependency.optionalWhenSystemSshExists) {
            $systemSsh = Join-Path $env:SystemRoot 'System32\OpenSSH'
            $sshFilesPresent = $true
            foreach ($sshFile in @('ssh.exe','ssh-keygen.exe','scp.exe')) {
                if (-not (Test-Path -LiteralPath (Join-Path $systemSsh $sshFile) -PathType Leaf)) { $sshFilesPresent = $false }
            }
            if ($sshFilesPresent) { Write-HubBootstrapProgress $progress 'Using the existing Windows OpenSSH client'; continue }
        }
        if ($Offline) { throw ('Offline preparation requires the bundled dependency: ' + $dependency.name) }
        $archive = ''
        Get-HubDependencyArchive -Root $Root -Dependency $dependency -ProxyUrl $ProxyUrl -Progress $progress -ArchivePath ([ref]$archive)
        Install-HubDependencyArchive -Root $Root -Dependency $dependency -Archive $archive -Progress $progress
    }
    Write-HubBootstrapProgress 85 'Rebuilding paths for this application folder'
    $node = Join-Path $Root 'app\node\node.exe'
    $portable = Join-Path $Root 'scripts\portable.js'
    if (-not (Test-Path -LiteralPath $portable -PathType Leaf)) { throw 'The portable path migration script is missing.' }
    $connectionFile = Join-Path $Root 'data\connection.json'
    $null = Assert-HubManagedPath -Root $Root -Path $connectionFile
    $firstConnectionSetup = -not (Test-Path -LiteralPath $connectionFile -PathType Leaf)
    & $node $portable $Root
    if ($LASTEXITCODE -ne 0) { throw 'Portable path migration failed.' }
    Set-HubInitialProxy -Root $Root -ProxyUrl $ProxyUrl -IsNewConnection:$firstConnectionSetup
    if ($PrepareOnly) { Write-HubBootstrapProgress 100 'Portable dependencies are ready'; return }
    $needsExtensions = $false
    foreach ($extension in @('ms-vscode-remote.remote-ssh','openai.chatgpt','ms-ceintl.vscode-language-pack-zh-hans')) {
        if (-not (Test-HubEditorExtension -Root $Root -ExtensionId $extension)) { $needsExtensions = $true }
    }
    if ($Offline -and $needsExtensions) { throw 'Offline launch needs the bundled Remote SSH, Codex and language extensions. Prepare them online once.' }
    Write-HubBootstrapProgress 90 'Opening the Research Hub'
    & (Join-Path $Root 'scripts\Start-Hub.ps1') -InstallExtensions:$needsExtensions
    Write-HubBootstrapProgress 100 'Research Hub started'
} finally { if ($bootstrapLock) { $bootstrapLock.Dispose() } }
