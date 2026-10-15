'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'data/temp/bootstrap-tests');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const library = `. ${quote(path.join(ROOT, 'scripts/Portable-Paths.ps1'))}\n. ${quote(path.join(ROOT, 'scripts/Bootstrap-Library.ps1'))}\nAdd-Type -AssemblyName System.IO.Compression\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n`;

function runFixture(t, body) {
  fs.mkdirSync(BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(BASE, "路径 space's-case-"));
  t.after(() => {
    assert.ok(fs.realpathSync(root).toLowerCase().startsWith(fs.realpathSync(BASE).toLowerCase() + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = path.join(root, 'test.ps1');
  fs.writeFileSync(script, "\ufeff$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n" + library + `$root=${quote(root)}\n` + body);
  const output = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, TEMP: root, TMP: root }
  });
  assert.equal(output.status, 0, output.stderr || output.stdout);
  return { root, output: output.stdout };
}

const makeZip = `
function New-TestZip([string]$file, [string]$name, [int]$attributes = 0) {
  $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew)
  $archive=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
  try {
    $entry=$archive.CreateEntry($name)
    if ($attributes) { $entry.ExternalAttributes=$attributes }
    $writer=New-Object IO.StreamWriter($entry.Open())
    try { $writer.Write('fixture content') } finally { $writer.Dispose() }
  } finally { $archive.Dispose(); $stream.Dispose() }
}
`;

test('bootstrap ZIP extraction accepts normal files and refuses traversal, rooted paths, device names, ADS, and links', t => {
  const result = runFixture(t, makeZip + `
    $valid=Join-Path $root 'valid.zip'
    New-TestZip $valid 'nested/file.txt'
    Expand-HubSafeZip -Root $root -Archive $valid -Destination (Join-Path $root 'valid')
    if ((Get-Content -LiteralPath (Join-Path $root 'valid/nested/file.txt') -Raw) -ne 'fixture content') { throw 'Bad content' }
    $badNames=@('../outside.txt','/outside.txt','C:/outside.txt','nested/file.txt:stream','nested/CON.txt')
    $i=0
    foreach($name in $badNames) {
      $i++; $archive=Join-Path $root ('bad'+$i+'.zip'); New-TestZip $archive $name
      $rejected=$false
      try { Expand-HubSafeZip -Root $root -Archive $archive -Destination (Join-Path $root ('bad'+$i)) } catch { $rejected=$true }
      if (-not $rejected) { throw 'Unsafe ZIP entry accepted' }
    }
    $link=Join-Path $root 'link.zip'; New-TestZip $link 'linked.txt' -1577123840
    $rejected=$false
    try { Expand-HubSafeZip -Root $root -Archive $link -Destination (Join-Path $root 'link') } catch { $rejected=$true }
    if (-not $rejected) { throw 'ZIP link accepted' }
    Write-Output 'ZIP_CASES_OK'
  `);
  assert.match(result.output, /ZIP_CASES_OK/);
  assert.equal(fs.existsSync(path.join(path.dirname(result.root), 'outside.txt')), false);
});

test('bootstrap installs only hash-verified cached ZIPs and preserves an incomplete previous directory', t => {
  const result = runFixture(t, makeZip + `
    $download=Join-Path $root 'data/bootstrap/downloads'
    [IO.Directory]::CreateDirectory($download)|Out-Null
    $archive=Join-Path $download 'test-1.0.zip'; New-TestZip $archive 'packed/tool.exe'
    $digest=Get-HubFileSha256 -Path $archive
    $dependency=[pscustomobject]@{id='test';version='1.0';name='Fixture';url='https://nodejs.org/test.zip';sha256=$digest;directory='app/test';archiveRoot='packed';requiredFiles=@('tool.exe')}
    $cached=''; Get-HubDependencyArchive -Root $root -Dependency $dependency -Progress 5 -ArchivePath ([ref]$cached)
    if ($cached -ne $archive) { throw 'Cache not reused' }
    $target=Join-Path $root 'app/test'; [IO.Directory]::CreateDirectory($target)|Out-Null
    Set-Content -LiteralPath (Join-Path $target 'preserve.txt') -Value 'existing data'
    $dependency.sha256='0'*64
    $rejected=$false
    try { Install-HubDependencyArchive -Root $root -Dependency $dependency -Archive $archive -Progress 5 } catch { $rejected=$true }
    if (-not $rejected -or -not (Test-Path -LiteralPath (Join-Path $target 'preserve.txt'))) { throw 'Hash failure altered previous install' }
    $dependency.sha256=$digest
    Install-HubDependencyArchive -Root $root -Dependency $dependency -Archive $archive -Progress 5
    if (-not (Test-HubDependencyFiles -Root $target -RequiredFiles @('tool.exe'))) { throw 'Tool was not installed' }
    $backup=@(Get-ChildItem -LiteralPath (Join-Path $root 'app') -Directory -Filter 'test.previous-*')
    if ($backup.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $backup[0].FullName 'preserve.txt'))) { throw 'Previous installation not preserved' }
    Write-Output 'CACHE_INSTALL_OK'
  `);
  assert.match(result.output, /CACHE_INSTALL_OK/);
});

test('portable dependencies use pinned HTTPS URLs and official SHA256 metadata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'launcher/dependencies.windows-x64.json'), 'utf8'));
  assert.equal(manifest.platform, 'windows-x64'); assert.equal(manifest.dependencies.length, 5);
  assert.deepEqual(manifest.dependencies.map(item => item.id), ['node', 'vscode', 'git', 'gh', 'openssh']);
  for (const item of manifest.dependencies) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const url = new URL(item.url);
    assert.equal(url.protocol, 'https:'); assert.ok(['nodejs.org', 'github.com', 'vscode.download.prss.microsoft.com'].includes(url.hostname));
    assert.ok(!item.url.includes('/latest')); assert.ok(item.url.endsWith('.zip'));
    assert.ok(item.checksumSource.startsWith('https://')); assert.ok(item.requiredFiles.length > 0);
  }
});

test('retry cleanup removes only owned interrupted downloads and staging, leaving completed caches and other files', t => {
  const result = runFixture(t, `
    $downloads=Join-Path $root 'data/temp/bootstrap-downloads'; $staging=Join-Path $root 'data/temp/bootstrap-staging'
    [IO.Directory]::CreateDirectory($downloads)|Out-Null; [IO.Directory]::CreateDirectory($staging)|Out-Null
    $ownedPart=Join-Path $downloads ('node-24.21.0.'+('a'*32)+'.part')
    $otherPart=Join-Path $downloads 'personal.part'; $cache=Join-Path $downloads 'node-24.21.0.zip'
    foreach($file in @($ownedPart,$otherPart,$cache)) { [IO.File]::WriteAllText($file,'content') }
    $ownedStage=Join-Path $staging ('node-'+('b'*32)); $otherStage=Join-Path $staging 'manual-notes'
    [IO.Directory]::CreateDirectory((Join-Path $ownedStage 'nested'))|Out-Null; [IO.Directory]::CreateDirectory($otherStage)|Out-Null
    [IO.File]::WriteAllText((Join-Path $ownedStage 'nested/test.txt'),'content')
    Remove-HubBootstrapLeftovers -Root $root
    if ((Test-Path -LiteralPath $ownedPart) -or (Test-Path -LiteralPath $ownedStage)) { throw 'Owned leftovers retained' }
    if (-not (Test-Path -LiteralPath $otherPart) -or -not (Test-Path -LiteralPath $cache) -or -not (Test-Path -LiteralPath $otherStage)) { throw 'Unrelated files removed' }
    Write-Output 'RETRY_CLEANUP_OK'
  `);
  assert.match(result.output, /RETRY_CLEANUP_OK/);
});

test('extension preparation rejects incomplete installation directories and accepts relative JavaScript entry points', t => {
  const result = runFixture(t, `
    $extension=Join-Path $root 'data/extensions/sample.tool-1.0'
    [IO.Directory]::CreateDirectory($extension)|Out-Null
    if (Test-HubEditorExtension -Root $root -ExtensionId 'sample.tool') { throw 'Empty extension accepted' }
    [IO.File]::WriteAllText((Join-Path $extension 'package.json'),'not JSON')
    if (Test-HubEditorExtension -Root $root -ExtensionId 'sample.tool') { throw 'Invalid manifest accepted' }
    [IO.File]::WriteAllText((Join-Path $extension 'package.json'),'{"publisher":"sample","name":"tool","version":"1.0","main":"./out/extension"}')
    if (Test-HubEditorExtension -Root $root -ExtensionId 'sample.tool') { throw 'Missing entry point accepted' }
    [IO.Directory]::CreateDirectory((Join-Path $extension 'out'))|Out-Null
    [IO.File]::WriteAllText((Join-Path $extension 'out/extension.js'),'module.exports={};')
    if (-not (Test-HubEditorExtension -Root $root -ExtensionId 'sample.tool')) { throw 'Complete extension rejected' }
    Write-Output 'EXTENSION_CHECK_OK'
  `);
  assert.match(result.output, /EXTENSION_CHECK_OK/);
});

test('initial explicit proxy is applied only to a newly created connection, with existing profiles preserved byte-for-byte', t => {
  const result = runFixture(t, `
    $data=Join-Path $root 'data'; [IO.Directory]::CreateDirectory($data)|Out-Null
    $config=Join-Path $data 'connection.json'
    $original='{"host":"research.example.invalid","port":24470,"proxyUrl":"http://127.0.0.1:7897","useProxy":true,"tunnel":true}'
    [IO.File]::WriteAllText($config,$original)
    Set-HubInitialProxy -Root $root -ProxyUrl 'http://127.0.0.1:7877' -IsNewConnection:$false
    if ([IO.File]::ReadAllText($config) -ne $original) { throw 'Existing connection changed' }
    Set-HubInitialProxy -Root $root -ProxyUrl '' -IsNewConnection
    if ([IO.File]::ReadAllText($config) -ne $original) { throw 'Empty proxy changed the connection' }
    Set-HubInitialProxy -Root $root -ProxyUrl 'http://127.0.0.1:7877' -IsNewConnection
    $updated=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($updated.proxyUrl -ne 'http://127.0.0.1:7877' -or -not $updated.useProxy -or $updated.tunnel -or $updated.host -ne 'research.example.invalid') { throw 'Incorrect initial proxy update' }
    Write-Output 'INITIAL_PROXY_OK'
  `);
  assert.match(result.output, /INITIAL_PROXY_OK/);
});
