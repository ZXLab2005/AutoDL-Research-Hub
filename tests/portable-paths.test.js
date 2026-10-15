'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../src/core');
const root = path.resolve(__dirname, '..');
const base = core.assertLocalPath(path.join(root, 'data', 'temp'), { within: root });
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = text => "'" + text.replaceAll("'", "''") + "'";
const helper = path.join(root, 'scripts/Portable-Paths.ps1');

function run(command) {
  fs.mkdirSync(base, { recursive: true });
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${quote(helper)}; ${command}`], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, TEMP: base, TMP: base },
  });
}

test('portable PowerShell paths accept local drives without creating files there', () => {
  for (const target of ['D:\\Research Hub', 'E:\\Research Hub']) {
    const result = run(`Assert-HubManagedPath -Root ${quote(target)} -Path ${quote(target + '\\data\\temp')}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target + '\\data\\temp');
  }
});

test('portable validation refuses roots, traversal, network shares and sibling escape', () => {
  for (const [boundary, target] of [
    ['E:\\', 'E:\\data'], ['E:relative', 'E:relative'],
    ['\\\\server\\share\\hub', '\\\\server\\share\\hub\\data'],
    [root, path.dirname(root)], [root, root + '-sibling\\data'],
    [root, root + '\\..\\outside'], [root, root + '\\data:stream'],
  ]) {
    const result = run(`Assert-HubManagedPath -Root ${quote(boundary)} -Path ${quote(target)}`);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  }
});

test('portable path validation rejects linked descendants before a write', t => {
  fs.mkdirSync(base, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(base, 'portable-paths-'));
  const target = path.join(fixture, 'real');
  const linked = path.join(fixture, 'linked');
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked, 'junction');
  t.after(() => {
    fs.unlinkSync(linked);
    core.assertLocalPath(fixture, { within: base });
    fs.rmSync(fixture, { recursive: true });
  });
  const result = run(`Assert-HubManagedPath -Root ${quote(fixture)} -Path ${quote(path.join(linked, 'new.txt'))}`);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(target, 'new.txt')), false);
});

test('portable tool lookup ignores stale launch-config and finds only bundled apps or system OpenSSH', () => {
  const result = run(`Get-HubPortableTools -Root ${quote(root)} | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stderr);
  const tools = JSON.parse(result.stdout);
  for (const [key, relative] of [['nodeExe', 'app/node/node.exe'], ['codeExe', 'app/vscode/Code.exe'], ['gitExe', 'app/git/cmd/git.exe'], ['ghExe', 'app/gh/bin/gh.exe']]) {
    assert.equal(tools[key], path.join(root, relative));
  }
  assert.equal(tools.sshExe, path.join(root, 'app/openssh/ssh.exe'));
});
