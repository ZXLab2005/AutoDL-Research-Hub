# Download and ZIP handling for the Windows portable bootstrap. No Node needed.
function Write-HubBootstrapProgress {
    param([int]$Percent, [string]$Message)
    Write-Output ('@@PROGRESS:{0}:{1}' -f ([Math]::Max(0, [Math]::Min(100, $Percent))), $Message)
}

function Test-HubDependencyFiles {
    param([string]$Root, [string[]]$RequiredFiles)
    foreach ($relative in $RequiredFiles) {
        $candidate = Join-Path $Root $relative
        $null = Assert-HubManagedPath -Root $Root -Path $candidate
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $false }
    }
    return $true
}

function Get-HubFileSha256 {
    param([string]$Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Test-HubArchiveHash {
    param([string]$Path, [string]$Sha256)
    return ((Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-HubFileSha256 -Path $Path).Equals($Sha256, [StringComparison]::OrdinalIgnoreCase))
}

function Remove-HubBootstrapLeftovers {
    param([string]$Root)
    $downloads = Join-Path $Root 'data\temp\bootstrap-downloads'
    $staging = Join-Path $Root 'data\temp\bootstrap-staging'
    foreach ($directory in @($downloads,$staging)) { $null = Assert-HubManagedPath -Root $Root -Path $directory }
    if (Test-Path -LiteralPath $downloads -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $downloads -File -Force) {
            if ($file.Name -notmatch '^[a-z]+-[A-Za-z0-9.-]+\.[a-f0-9]{32}\.part$') { continue }
            $null = Assert-HubManagedPath -Root $downloads -Path $file.FullName
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }
    if (Test-Path -LiteralPath $staging -PathType Container) {
        foreach ($directory in Get-ChildItem -LiteralPath $staging -Directory -Force) {
            if ($directory.Name -notmatch '^[a-z]+-[a-f0-9]{32}$') { continue }
            $null = Assert-HubManagedPath -Root $staging -Path $directory.FullName
            # Inspect descendants without following links before a recursive delete.
            $pending = New-Object 'Collections.Generic.Stack[string]'
            $pending.Push($directory.FullName)
            while ($pending.Count -gt 0) {
                foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Interrupted bootstrap staging contains a link. Inspect it before retrying.' }
                    if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
                }
            }
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        }
    }
}

function Test-HubEditorExtension {
    param([string]$Root, [string]$ExtensionId)
    $extensions = Join-Path $Root 'data\extensions'
    $null = Assert-HubManagedPath -Root $Root -Path $extensions
    if (-not (Test-Path -LiteralPath $extensions -PathType Container)) { return $false }
    foreach ($directory in Get-ChildItem -LiteralPath $extensions -Directory -Filter ($ExtensionId + '-*')) {
        $manifest = Join-Path $directory.FullName 'package.json'
        $null = Assert-HubManagedPath -Root $extensions -Path $manifest
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
        try { $package = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json }
        catch { continue }
        if (($package.publisher + '.' + $package.name) -ne $ExtensionId -or -not $package.version) { continue }
        if ($package.main) {
            $entryPoint = [IO.Path]::GetFullPath((Join-Path $directory.FullName $package.main))
            $null = Assert-HubManagedPath -Root $directory.FullName -Path $entryPoint
            if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf) -and (Test-Path -LiteralPath ($entryPoint + '.js') -PathType Leaf)) { $entryPoint += '.js' }
            if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { continue }
        }
        return $true
    }
    return $false
}

function Set-HubInitialProxy {
    param([string]$Root, [string]$ProxyUrl, [switch]$IsNewConnection)
    if (-not $IsNewConnection -or -not $ProxyUrl) { return }
    $connectionFile = Join-Path $Root 'data\connection.json'
    $null = Assert-HubManagedPath -Root $Root -Path $connectionFile
    $newConnection = Get-Content -LiteralPath $connectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $newConnection.useProxy = $true
    $newConnection.proxyUrl = $ProxyUrl
    $newConnection.tunnel = $false
    [IO.File]::WriteAllText($connectionFile, (($newConnection | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    Write-HubBootstrapProgress 87 'Saved the selected download proxy for this new workspace'
}

function Get-HubDependencyArchive {
    param([string]$Root, $Dependency, [string]$ProxyUrl, [int]$Progress, [ref]$ArchivePath)
    if ($Dependency.sha256 -notmatch '^[0-9a-f]{64}$' -or $Dependency.id -notmatch '^[a-z]+$' -or $Dependency.version -notmatch '^[A-Za-z0-9.-]+$') {
        throw 'Invalid pinned dependency metadata.'
    }
    $downloadUri = [Uri]$Dependency.url
    if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -notin @('nodejs.org','github.com','vscode.download.prss.microsoft.com')) {
        throw 'Dependency downloads must use a pinned official HTTPS URL.'
    }
    $downloads = Join-Path $Root 'data\bootstrap\downloads'
    $archive = Join-Path $downloads ($Dependency.id + '-' + $Dependency.version + '.zip')
    $null = Assert-HubManagedPath -Root $Root -Path $archive
    [IO.Directory]::CreateDirectory($downloads) | Out-Null
    if (Test-HubArchiveHash -Path $archive -Sha256 $Dependency.sha256) {
        Write-HubBootstrapProgress $Progress ('Using verified cache: ' + $Dependency.name)
        $ArchivePath.Value = $archive
        return
    }
    $partialDirectory = Join-Path $Root 'data\temp\bootstrap-downloads'
    $null = Assert-HubManagedPath -Root $Root -Path $partialDirectory
    [IO.Directory]::CreateDirectory($partialDirectory) | Out-Null
    $partial = Join-Path $partialDirectory ($Dependency.id + '-' + $Dependency.version + '.' + [Guid]::NewGuid().ToString('N') + '.part')
    $null = Assert-HubManagedPath -Root $Root -Path $partial
    $response = $null; $inputStream = $null; $outputStream = $null
    try {
        Write-HubBootstrapProgress $Progress ('Downloading ' + $Dependency.name + ' ' + $Dependency.version)
        $request = [Net.HttpWebRequest]::Create($downloadUri)
        $request.UserAgent = 'AutoDL-Research-Hub-Portable/1.3'
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 60000
        $request.AllowAutoRedirect = $true
        if ($ProxyUrl) { $request.Proxy = New-Object Net.WebProxy($ProxyUrl) }
        else { $request.Proxy = $null }
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 131072
        $received = [long]0; $lastReported = -10
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($clock.Elapsed.TotalMinutes -gt 20) { throw 'Dependency download exceeded 20 minutes. Retry when the connection is stable.' }
            $outputStream.Write($buffer, 0, $read); $received += $read
            if ($received -gt 1073741824) { throw 'Dependency archive exceeded the download size limit.' }
            if ($response.ContentLength -gt 0) {
                $percent = [int](100 * $received / $response.ContentLength)
                if ($percent -ge $lastReported + 10) {
                    Write-HubBootstrapProgress $Progress ($Dependency.name + ': ' + $percent + '% downloaded')
                    $lastReported = $percent
                }
            }
        }
        $outputStream.Dispose(); $outputStream = $null
        if (-not (Test-HubArchiveHash -Path $partial -Sha256 $Dependency.sha256)) { throw ('SHA256 verification failed: ' + $Dependency.name) }
        $null = Assert-HubManagedPath -Root $Root -Path $archive
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        Move-Item -LiteralPath $partial -Destination $archive
        Write-HubBootstrapProgress $Progress ('SHA256 verified: ' + $Dependency.name)
        $ArchivePath.Value = $archive
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        if (Test-Path -LiteralPath $partial) {
            $null = Assert-HubManagedPath -Root $Root -Path $partial
            Remove-Item -LiteralPath $partial -Force
        }
    }
}

function Expand-HubSafeZip {
    param([string]$Root, [string]$Archive, [string]$Destination)
    $null = Assert-HubManagedPath -Root $Root -Path $Destination
    if (Test-Path -LiteralPath $Destination) { throw 'ZIP extraction needs a new staging directory.' }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($zip.Entries.Count -gt 60000) { throw 'ZIP archive contains too many entries.' }
        $totalSize = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            if (-not $name -or $name.StartsWith('\') -or $name.Contains(':') -or $name -match '[\x00-\x1f]' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) {
                throw 'ZIP contains an absolute path, link, or invalid entry.'
            }
            $target = Join-Path $Destination $name
            $null = Assert-HubManagedPath -Root $Destination -Path $target
            $totalSize += $entry.Length
            if ($entry.Length -gt 1073741824 -or $totalSize -gt 4294967296) { throw 'ZIP expansion size limit exceeded.' }
            if ($name.EndsWith('\')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
            $inputStream = $entry.Open()
            $outputStream = $null
            try {
                $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $inputStream.CopyTo($outputStream)
            } finally {
                if ($outputStream) { $outputStream.Dispose() }
                $inputStream.Dispose()
            }
        }
    } finally { $zip.Dispose() }
}

function Install-HubDependencyArchive {
    param([string]$Root, $Dependency, [string]$Archive, [int]$Progress)
    if (-not (Test-HubArchiveHash -Path $Archive -Sha256 $Dependency.sha256)) { throw 'An unverified archive cannot be installed.' }
    $destination = Join-Path $Root $Dependency.directory
    $stage = Join-Path $Root ('data\temp\bootstrap-staging\' + $Dependency.id + '-' + [Guid]::NewGuid().ToString('N'))
    $null = Assert-HubManagedPath -Root $Root -Path $destination
    $null = Assert-HubManagedPath -Root $Root -Path $stage
    Write-HubBootstrapProgress $Progress ('Extracting ' + $Dependency.name)
    Expand-HubSafeZip -Root $Root -Archive $Archive -Destination $stage
    $source = $stage
    if ($Dependency.archiveRoot) { $source = Join-Path $stage $Dependency.archiveRoot }
    $null = Assert-HubManagedPath -Root $stage -Path $source
    if (-not (Test-HubDependencyFiles -Root $source -RequiredFiles $Dependency.requiredFiles)) {
        throw ('Downloaded archive has an unexpected layout: ' + $Dependency.name)
    }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    if (Test-Path -LiteralPath $destination) {
        $backup = $destination + '.previous-' + [Guid]::NewGuid().ToString('N')
        $null = Assert-HubManagedPath -Root $Root -Path $backup
        # Preserve an incomplete previous installation; never overwrite user data.
        Move-Item -LiteralPath $destination -Destination $backup
    }
    Move-Item -LiteralPath $source -Destination $destination
    if (Test-Path -LiteralPath $stage) {
        $null = Assert-HubManagedPath -Root $Root -Path $stage
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
    Write-HubBootstrapProgress $Progress ('Ready: ' + $Dependency.name)
}
