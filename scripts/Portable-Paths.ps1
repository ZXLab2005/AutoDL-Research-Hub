# Shared by the portable entry points. This file only defines functions.
function Assert-HubManagedPath {
    param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Path)
    foreach ($hubCandidate in @($Root, $Path)) {
        if ($hubCandidate -notmatch '^[A-Za-z]:[\\/]' -or $hubCandidate.Substring(2).Contains(':') -or $hubCandidate -match '[\x00-\x1f<>"|?*]') {
            throw 'A local Windows absolute path is required.'
        }
        foreach ($hubSegment in ($hubCandidate.Substring(3) -split '[\\/]')) {
            if ($hubSegment -in @('.', '..') -or $hubSegment -match '[ .]$' -or $hubSegment -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') {
                throw 'Portable paths cannot contain traversal or Windows device names.'
            }
        }
    }
    $hubBoundary = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    if ($hubBoundary.Length -le 2) { throw 'Use a dedicated application folder, not a drive root.' }
    $hubTarget = [IO.Path]::GetFullPath($Path).TrimEnd('\','/')
    if (-not $hubTarget.Equals($hubBoundary, [StringComparison]::OrdinalIgnoreCase) -and
        -not $hubTarget.StartsWith($hubBoundary + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Managed files must remain inside the application folder.'
    }
    $hubAncestor = $hubTarget
    while ($hubAncestor) {
        if (Test-Path -LiteralPath $hubAncestor) {
            if (((Get-Item -LiteralPath $hubAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Portable paths cannot contain junctions or symbolic links.'
            }
        }
        $hubParent = Split-Path -Parent $hubAncestor
        if ($hubParent -eq $hubAncestor) { break }
        $hubAncestor = $hubParent
    }
    return $hubTarget
}

function Get-HubPortableTools {
    param([Parameter(Mandatory=$true)][string]$Root)
    $hubBase = Assert-HubManagedPath -Root $Root -Path $Root
    $hubTools = [PSCustomObject]@{
        nodeExe = (Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase 'app\node\node.exe'))
        codeExe = (Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase 'app\vscode\Code.exe'))
        gitExe = (Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase 'app\git\cmd\git.exe'))
        ghExe = (Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase 'app\gh\bin\gh.exe'))
    }
    foreach ($hubTool in @(@('sshExe','ssh'), @('scpExe','scp'), @('keygenExe','ssh-keygen'))) {
        $hubBundled = Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase ('app\openssh\' + $hubTool[1] + '.exe'))
        $hubGitFallback = Assert-HubManagedPath -Root $hubBase -Path (Join-Path $hubBase ('app\git\usr\bin\' + $hubTool[1] + '.exe'))
        $hubSystem = Join-Path $env:SystemRoot ('System32\OpenSSH\' + $hubTool[1] + '.exe')
        $hubSelected = @($hubBundled, $hubSystem, $hubGitFallback) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if (-not $hubSelected) { $hubSelected = $hubBundled }
        $hubTools | Add-Member -NotePropertyName $hubTool[0] -NotePropertyValue $hubSelected
    }
    return $hubTools
}

function Initialize-HubPortableRoot {
    param([Parameter(Mandatory=$true)][string]$Root, [switch]$RequireEditor)
    # Preserve read-only discovery locations before a first-run bootstrap can
    # redirect HOME/USERPROFILE into the portable folder.
    if (-not $env:RESEARCH_HUB_ORIGINAL_CODEX_HOME -and $env:CODEX_HOME) { $env:RESEARCH_HUB_ORIGINAL_CODEX_HOME = $env:CODEX_HOME }
    if (-not $env:RESEARCH_HUB_ORIGINAL_USERPROFILE -and $env:USERPROFILE) { $env:RESEARCH_HUB_ORIGINAL_USERPROFILE = $env:USERPROFILE }
    $hubTools = Get-HubPortableTools -Root $Root
    if (@($hubTools.nodeExe, $hubTools.codeExe, $hubTools.gitExe, $hubTools.ghExe | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
        $hubBootstrap = Assert-HubManagedPath -Root $Root -Path (Join-Path $Root 'scripts\Bootstrap-Hub.ps1')
        if (-not (Test-Path -LiteralPath $hubBootstrap -PathType Leaf)) { throw 'Bundled runtime is missing. Restore scripts\Bootstrap-Hub.ps1 and launch the application again.' }
        & $hubBootstrap -Root $Root -PrepareOnly
    }
    if (-not (Test-Path -LiteralPath $hubTools.nodeExe -PathType Leaf)) { throw 'The bundled Node runtime is not available.' }
    $hubPortableScript = Assert-HubManagedPath -Root $Root -Path (Join-Path $Root 'scripts\portable.js')
    & $hubTools.nodeExe $hubPortableScript $Root | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Portable path configuration failed. Existing user data was preserved.' }
    return (Get-HubPortableTools -Root $Root)
}
