param()
$ErrorActionPreference = 'Stop'
$hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$hubLaunch = Get-HubPortableTools -Root $hubRoot
$hubManifest = Get-Content -LiteralPath (Join-Path $hubRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($hubManifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version.' }
$hubOutDir = Join-Path $hubRoot 'data\packages'
& $hubLaunch.nodeExe -e 'require(process.argv[1]).assertEPath(process.argv[2],{within:process.argv[3]})' (Join-Path $hubRoot 'src\core.js') $hubOutDir $hubRoot
if ($LASTEXITCODE -ne 0) { throw 'The package path must resolve inside the portable folder.' }
[IO.Directory]::CreateDirectory($hubOutDir) | Out-Null
$hubOutput = Join-Path $hubOutDir ('autodl-research-hub-' + $hubManifest.version + '.vsix')
$hubPartial = $hubOutput + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
Add-Type -AssemblyName System.IO.Compression
$hubUtf8 = New-Object Text.UTF8Encoding($false)
$hubArchiveFile = [IO.File]::Open($hubPartial, [IO.FileMode]::CreateNew)
$hubArchive = New-Object IO.Compression.ZipArchive($hubArchiveFile, [IO.Compression.ZipArchiveMode]::Create, $false)
function Add-HubEntry([string]$Name, [byte[]]$Bytes) {
    $hubEntry = $hubArchive.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
    $hubEntryStream = $hubEntry.Open()
    try { $hubEntryStream.Write($Bytes, 0, $Bytes.Length) } finally { $hubEntryStream.Dispose() }
}
try {
    $hubVersionXml = [Security.SecurityElement]::Escape($hubManifest.version)
    $hubNameXml = [Security.SecurityElement]::Escape($hubManifest.displayName)
    $hubDescriptionXml = [Security.SecurityElement]::Escape($hubManifest.description)
    $hubEngineXml = [Security.SecurityElement]::Escape($hubManifest.engines.vscode)
    $hubVsixXml = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="autodl-research-hub" Version="$hubVersionXml" Publisher="local-research" />
    <DisplayName>$hubNameXml</DisplayName>
    <Description xml:space="preserve">$hubDescriptionXml</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$hubEngineXml" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
"@
    $hubTypesXml = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
    Add-HubEntry 'extension.vsixmanifest' ($hubUtf8.GetBytes($hubVsixXml))
    Add-HubEntry '[Content_Types].xml' ($hubUtf8.GetBytes($hubTypesXml))
    Add-HubEntry 'extension/package.json' ([IO.File]::ReadAllBytes((Join-Path $hubRoot 'package.json')))
    foreach ($hubFile in Get-ChildItem -LiteralPath (Join-Path $hubRoot 'src') -File -Filter '*.js') {
        Add-HubEntry ('extension/src/' + $hubFile.Name) ([IO.File]::ReadAllBytes($hubFile.FullName))
    }
} finally {
    $hubArchive.Dispose()
    $hubArchiveFile.Dispose()
}
[IO.File]::Copy($hubPartial, $hubOutput, $true)
[IO.File]::Delete($hubPartial)
Write-Output $hubOutput
