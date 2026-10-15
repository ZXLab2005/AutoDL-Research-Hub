'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASE = path.resolve(__dirname, '../.agent-sync/temp');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quoted = value => "'" + value.replaceAll("'", "''") + "'";

function fixture(t, config) {
  assert.ok(path.isAbsolute(BASE));
  fs.mkdirSync(BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(BASE, 'sync-environment-test-'));
  const scripts = path.join(root, 'github-sync');
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(root, '.agent-sync'));
  fs.copyFileSync(path.join(__dirname, 'environment.ps1'), path.join(scripts, 'environment.ps1'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '../scripts/Portable-Paths.ps1'), path.join(root, 'scripts/Portable-Paths.ps1'));
  if (config !== undefined) fs.writeFileSync(path.join(root, '.agent-sync/config.json'), JSON.stringify(config));
  t.after(() => {
    assert.ok(fs.realpathSync(root).toLowerCase().startsWith(fs.realpathSync(BASE).toLowerCase() + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(scripts, 'environment.ps1');
}

function inspect(file) {
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); . ${quoted(file)}; @{http=$env:HTTP_PROXY;https=$env:HTTPS_PROXY;all=$env:ALL_PROXY;gh=$env:GH_CONFIG_DIR;temp=$env:TEMP;root=$syncRoot;node=$syncNode;git=$syncGit;drive=$env:HOMEDRIVE} | ConvertTo-Json -Compress`;
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, TEMP: BASE, TMP: BASE, HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', ALL_PROXY: 'http://127.0.0.1:7897' }
  });
}

test('sync shell uses the configured proxy and keeps runtime files inside its portable root', t => {
  const result = inspect(fixture(t, { proxyUrl: 'http://127.0.0.1:7877' }));
  assert.equal(result.status, 0);
  const env = JSON.parse(result.stdout);
  assert.equal(env.http, 'http://127.0.0.1:7877');
  assert.equal(env.https, env.http); assert.equal(env.all, env.http);
  assert.equal(env.gh, path.join(env.root, '.agent-sync/private/gh'));
  assert.equal(env.temp, path.join(env.root, '.agent-sync/temp'));
  assert.equal(env.node, path.join(env.root, 'app/node/node.exe'));
  assert.equal(env.git, path.join(env.root, 'app/git/cmd/git.exe'));
  assert.equal(env.drive, path.parse(env.root).root.slice(0, 2));
});

test('explicit direct and unconfigured profiles do not inherit an obsolete proxy', t => {
  for (const config of [{ proxyUrl: '' }, undefined]) {
    const result = inspect(fixture(t, config));
    assert.equal(result.status, 0);
    const env = JSON.parse(result.stdout);
    assert.equal(env.http, null); assert.equal(env.https, null); assert.equal(env.all, null);
  }
});

test('sync shell rejects non-local and credential-bearing proxy configuration', t => {
  for (const proxyUrl of ['https://proxy.example.invalid:8080', 'http://user:placeholder@127.0.0.1:7877', 'socks5://127.0.0.1:7877', 7877]) {
    const result = inspect(fixture(t, { proxyUrl }));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  }
});
