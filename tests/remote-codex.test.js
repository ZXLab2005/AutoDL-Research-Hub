'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const backend = require('../scripts/remote-codex');
const core = require('../src/core');
const root = path.resolve(__dirname, '..');
const target = 'x86_64-unknown-linux-musl';
const version = '1.2.3';
const packageName = 'codex-package-' + target + '.tar.gz';
const fixtureBytes = Buffer.from('fake package for offline checksum tests');
const packageHash = backend.digest(fixtureBytes);
const sums = packageHash + '  ' + packageName + '\n';
const url = name => 'https://releases.openai.com/codex/releases/' + version + '/' + name;
const metadata = { tag_name: 'rust-v' + version, assets: [
  { name: packageName, digest: 'sha256:' + packageHash, browser_download_url: url(packageName) },
  { name: 'codex-package_SHA256SUMS', digest: 'sha256:' + backend.digest(Buffer.from(sums)), browser_download_url: url('codex-package_SHA256SUMS') }
]};
function fixture() {
  const directory = core.assertEPath(path.join(root, 'data', 'test-runs', 'remote-codex-' + crypto.randomBytes(8).toString('hex')), { within: root });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
function clean(directory) { core.assertEPath(directory, { within: root }); fs.rmSync(directory, { recursive: true, force: true }); }

test('select only the requested Linux full package and verify unique official digest metadata', () => {
  const chosen = backend.selectRelease(metadata, target);
  assert.equal(chosen.package.name, packageName);
  assert.equal(chosen.sums.sha256, backend.digest(Buffer.from(sums)));
  assert.equal(backend.checksumFor(sums, packageName), packageHash);
  assert.throws(() => backend.selectRelease(metadata, 'windows-x64'));
  assert.throws(() => backend.selectRelease({ ...metadata, assets: [] }, target));
  assert.throws(() => backend.selectRelease({ ...metadata, assets: [...metadata.assets, metadata.assets[0]] }, target));
  assert.throws(() => backend.checksumFor(sums + sums, packageName));
  assert.throws(() => backend.validateReleaseUrl('http://example.com/package', version, packageName));
});

test('portable cache reuses a verified target without network and repairs corruption at its pinned version', async () => {
  const directory = fixture();
  let reads = [], downloads = 0;
  const dependencies = {
    fetchText: async address => { reads.push(address); return address.endsWith('SHA256SUMS') ? sums : JSON.stringify(metadata); },
    download: async (address, file) => { downloads++; assert.equal(address, url(packageName)); fs.writeFileSync(file, fixtureBytes); }
  };
  try {
    const first = await backend.ensurePackage(directory, core.defaultConfig, target, false, dependencies);
    assert.equal(downloads, 1);
    assert.equal(first.sha256, packageHash);
    reads = [];
    const reused = await backend.ensurePackage(directory, core.defaultConfig, target, false, dependencies);
    assert.equal(reused.fromCache, true); assert.deepEqual(reads, []); assert.equal(downloads, 1);
    fs.writeFileSync(first.file, 'corrupt');
    await backend.ensurePackage(directory, core.defaultConfig, target, false, dependencies);
    assert.equal(reads[0], 'https://releases.openai.com/codex/releases/' + version + '/release.json');
    assert.equal(downloads, 2);
    assert.equal(await backend.hashFile(first.file), packageHash);
  } finally { clean(directory); }
});

test('download digest failure never publishes a package pointer or keeps the partial file', async () => {
  const directory = fixture();
  try {
    await assert.rejects(() => backend.ensurePackage(directory, core.defaultConfig, target, false, {
      fetchText: async address => address.endsWith('SHA256SUMS') ? sums : JSON.stringify(metadata),
      download: async (address, file) => fs.writeFileSync(file, 'wrong bytes')
    }), /SHA256/);
    assert.ok(!fs.existsSync(path.join(directory, 'data', 'cache', 'codex-cli', 'cached-' + target + '.json')));
    const dir = path.join(directory, 'data', 'cache', 'codex-cli', version, target);
    assert.ok(fs.readdirSync(dir).every(name => !name.endsWith('.partial')));
  } finally { clean(directory); }
});

test('auth validation rejects malformed data without parser snippets, accepts supported login structures', () => {
  assert.throws(() => backend.validateAuthBytes(Buffer.from('{"access_token":"secret-marker"} invalid')), error => !error.message.includes('secret-marker'));
  assert.throws(() => backend.validateAuthBytes(Buffer.from('[]')));
  assert.throws(() => backend.validateAuthBytes(Buffer.from('{}')));
  assert.throws(() => backend.validateAuthBytes(Buffer.alloc(262145)));
  const auth = { tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id' } };
  assert.deepEqual(JSON.parse(backend.validateAuthBytes(Buffer.from(JSON.stringify(auth)))), auth);
  assert.deepEqual(JSON.parse(backend.validateAuthBytes(Buffer.from('{"OPENAI_API_KEY":"fixture-api-key"}'))), { OPENAI_API_KEY: 'fixture-api-key' });
});

test('auth source priority keeps the platform first and original profiles as explicit read-only fallbacks', () => {
  const paths = backend.authCandidates(root, { originalCodexHome: 'D:\\old-codex', originalProfile: 'C:\\Users\\original', profileFallback: 'C:\\Users\\actual' }, {}, 'C:\\Users\\actual');
  assert.equal(paths[0], path.join(root, 'data', 'codex', 'auth.json'));
  assert.equal(paths[1], 'D:\\old-codex\\auth.json');
  assert.equal(paths[2], 'C:\\Users\\original\\.codex\\auth.json');
  assert.equal(paths[3], 'C:\\Users\\actual\\.codex\\auth.json');
  assert.equal(paths.length, 4);
  assert.deepEqual(backend.authCandidates(root, { authFile: 'C:\\approved\\auth.json' }, {}, 'C:\\Users\\a'), ['C:\\approved\\auth.json']);
});

test('valid existing remote login is preserved without inspecting even an invalid explicit AuthFile', async () => {
  const calls = [];
  const installed = { sessionCommand: mode => 'session ' + mode, transport: async (command, options) => { calls.push({ command, options }); return { code: 0 }; } };
  assert.equal(await backend.prepareAuth(root, { authFile: 'C:\\does-not-exist\\auth.json' }, installed), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'session status');
  assert.equal(calls[0].options.quiet, true);
});

test('authorized auth goes only to quiet SSH stdin and memory payload is cleared afterwards', async () => {
  const directory = fixture(), calls = [];
  const credential = { OPENAI_API_KEY: 'offline-fixture-not-a-real-key' };
  try {
    fs.mkdirSync(path.join(directory, 'data', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'data', 'codex', 'auth.json'), JSON.stringify(credential));
    const installed = {
      sessionCommand: mode => 'fixed-remote-session ' + mode,
      transport: async (command, options) => {
        calls.push({ command, options, copied: options.input && Buffer.from(options.input) });
        return { code: command.endsWith('status') ? 10 : 0 };
      }
    };
    assert.equal(await backend.prepareAuth(directory, {}, installed), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.quiet, true);
    assert.deepEqual(JSON.parse(calls[1].copied), credential);
    assert.ok(!calls[1].command.includes(credential.OPENAI_API_KEY));
    assert.ok(calls[1].options.input.every(byte => byte === 0));
  } finally { clean(directory); }
});

test('remote executable reuse avoids download and session deployment precedes credentials', async () => {
  const calls = [];
  const configuration = { ...core.defaultConfig, host: 'example.com' };
  const installed = await backend.installOrReuse(root, configuration, core.getPaths(root), { update: false }, {
    ensurePackage: async () => { throw Error('download must not be reached'); },
    transport: async (command, options) => {
      calls.push({ command, options });
      return { code: 0, stdout: calls.length === 1 ? 'HUB_REMOTE_V1\tx86_64\t/home/research/.local/share/autodl-research-hub\t/usr/local/bin/codex\tcodex-cli 1.2.3\n' : '' };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(installed.remote.binary, '/usr/local/bin/codex');
  assert.match(installed.sessionCommand('launch'), /codex-session|session\.sh/);
  assert.match(installed.sessionCommand('launch'), /\/root\/autodl-tmp\/research-hub\/projects/);
  assert.ok(calls[1].command.indexOf('test ! -L') < calls[1].command.indexOf('mkdir -p'));
});

test('paths, interactive SSH and remote scripts preserve strict host checks and credential boundaries', () => {
  for (const value of ['/', '../x', '/x/../y', '/x;whoami', '/x\nbad']) assert.throws(() => backend.posixPath(value, 'test'));
  const args = backend.sshBase(core.getPaths(root), true);
  assert.ok(args.includes('-tt')); assert.ok(args.includes('RequestTTY=force'));
  assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('BatchMode=yes'));
  const session = fs.readFileSync(path.join(root, 'remote', 'codex-session.sh'), 'utf8');
  assert.match(session, /login status >\/dev\/null 2>&1/);
  assert.match(session, /chmod 700 -- "\$CODEX_HOME"/);
  assert.match(session, /chmod 600 -- "\$auth_temp"/);
  assert.match(session, /mv -fT -- "\$auth_temp" "\$CODEX_HOME\/auth\.json"/);
  assert.match(session, /login --device-auth/);
  assert.ok(!session.includes('--dangerously-bypass'));
  const install = fs.readFileSync(path.join(root, 'remote', 'codex-install.sh'), 'utf8');
  assert.match(install, /no_links "\$base\/versions"/);
  assert.ok(!install.includes('grep -qv'));
});
