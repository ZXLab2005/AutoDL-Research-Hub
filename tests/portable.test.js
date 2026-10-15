'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../src/core');
const portable = require('../scripts/portable');
const root = path.resolve(__dirname, '..');
const base = core.assertLocalPath(path.join(root, 'data/temp'), { within: root });
const sid = 'S-1-5-21-1000';

function put(root, relative, value) {
  const file = core.assertLocalPath(path.join(root, relative), { within: root });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value, null, 2) + '\n' : value);
  return file;
}
function json(root, relative) { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const container = fs.mkdtempSync(path.join(base, 'portable-test-'));
  t.after(() => {
    core.assertLocalPath(container, { within: base });
    fs.rmSync(container, { recursive: true });
  });
  const platform = path.join(container, 'old app');
  for (const file of ['app/node/node.exe', 'app/vscode/Code.exe', 'app/git/cmd/git.exe', 'app/gh/bin/gh.exe', 'app/openssh/ssh.exe', 'app/openssh/ssh-keygen.exe', 'app/openssh/scp.exe']) put(platform, file, 'fixture binary; never executed');
  put(platform, 'launch-config.json', { platformRoot: platform, codeExe: path.join(platform, 'app/vscode/Code.exe'), nodeExe: 'E:\\old-tools\\node.exe' });
  put(platform, 'data/portable-state.json', { version: 1, root: platform });
  const identity = put(platform, 'data/ssh/id_ed25519', 'synthetic-key-fixture-do-not-use');
  put(platform, 'data/ssh/id_ed25519.pub', 'synthetic-public-key-fixture');
  put(platform, 'data/ssh/known_hosts', 'synthetic-host-record');
  put(platform, 'data/connection.json', { ...core.defaultConfig, host: 'research.example.invalid', port: 2222, identityFile: identity, useProxy: true });
  const protectedFiles = ['data/ssh/id_ed25519', 'data/ssh/id_ed25519.pub', 'data/ssh/known_hosts', 'data/codex/auth.json', 'data/codex/config.toml', 'data/codex/sessions/sample.jsonl', 'data/vscode-user/Backups/unsaved.txt', 'data/vscode-user/User/workspaceStorage/sample/state.vscdb', 'workspace/experiment.py'];
  for (const file of protectedFiles.slice(3)) put(platform, file, 'preserved fixture: ' + file);
  const protectedBytes = new Map(protectedFiles.map(file => [file, fs.readFileSync(path.join(platform, file))]));
  const protections = [], calls = [];
  const options = {
    userSid: sid,
    restrictPrivateKey(file, userSid) { assert.equal(userSid, sid); protections.push(file); },
    run(exe, args, options) { calls.push({ exe, args, options }); return { status: args.includes('--get-all') ? 1 : 0, stdout: '' }; },
  };
  return { container, platform, identity, protectedBytes, protections, calls, options };
}

test('actual folder rename rebases internal paths and keeps authentication, backups and research bytes', t => {
  const f = fixture(t), old = f.platform;
  put(old, 'data/vscode-user/User/settings.json', { nested: [path.join(old, 'data/cache')], external: path.join(old + '-neighbor', 'keep'), rootUri: '/' + old.replaceAll('\\', '/') + '/workspace' });
  put(old, 'Research.code-workspace', { folders: [{ path: path.join(old, 'workspace') }], settings: { 'editor.fontSize': 17 } });
  put(old, 'data/setup-state.json', { sshVerified: true, verifiedConnection: { identityFile: f.identity } });
  put(old, 'data/extensions/extensions.json', [{ relativeLocation: 'test.extension', location: { scheme: 'file', path: '/stale' } }]);
  put(old, 'data/tunnel/state.json', { pid: 123 });
  const moved = core.assertLocalPath(path.join(f.container, "迁移后的 app's folder"), { within: f.container });
  core.assertLocalPath(old, { within: f.container });
  fs.renameSync(old, moved);
  const result = portable.preparePortable(moved, f.options);
  assert.equal(result.moved, true);
  assert.equal(result.root, moved);
  const config = json(moved, 'data/connection.json');
  assert.equal(config.identityFile, path.join(moved, 'data/ssh/id_ed25519'));
  assert.equal(config.useProxy, true, 'existing proxy choice is retained');
  assert.equal(json(moved, 'data/setup-state.json').verifiedConnection.identityFile, config.identityFile);
  assert.equal(json(moved, 'Research.code-workspace').folders[0].path, path.join(moved, 'workspace'));
  const settings = json(moved, 'data/vscode-user/User/settings.json');
  assert.equal(settings.nested[0], path.join(moved, 'data/cache'));
  assert.equal(settings.external, path.join(old + '-neighbor', 'keep'));
  assert.equal(settings.rootUri, '/' + moved.replaceAll('\\', '/') + '/workspace');
  assert.equal(json(moved, 'data/extensions/extensions.json')[0].location.path, '/' + path.join(moved, 'data/extensions/test.extension').replaceAll('\\', '/'));
  for (const [file, bytes] of f.protectedBytes) assert.deepEqual(fs.readFileSync(path.join(moved, file)), bytes, file);
  assert.equal(fs.existsSync(path.join(moved, 'data/tunnel/state.json')), false);
  assert.equal(json(result.backup, 'data/tunnel/state.json').pid, 123);
  for (const [key, file] of [['nodeExe','app/node/node.exe'], ['codeExe','app/vscode/Code.exe'], ['gitExe','app/git/cmd/git.exe'], ['ghExe','app/gh/bin/gh.exe']]) assert.equal(result.tools[key], path.join(moved, file));
  assert.deepEqual(f.protections, [config.identityFile]);
  const stateBytes = fs.readFileSync(path.join(moved, 'data/portable-state.json'));
  const again = portable.preparePortable(moved, f.options);
  assert.equal(again.moved, false); assert.equal(again.backup, null);
  assert.equal(f.protections.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(moved, 'data/portable-state.json')), stateBytes);
});

test('same-folder legacy upgrade preserves a working existing key without rewriting its ACL', t => {
  const f = fixture(t);
  portable.preparePortable(f.platform, f.options);
  assert.deepEqual(f.protections, []);
  assert.deepEqual(fs.readFileSync(f.identity), f.protectedBytes.get('data/ssh/id_ed25519'));
});

test('new portable folders default to direct access instead of assuming a local proxy', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.platform, 'data/connection.json'));
  portable.preparePortable(f.platform, f.options);
  const config = json(f.platform, 'data/connection.json');
  assert.equal(config.useProxy, false); assert.equal(config.tunnel, false);
  assert.equal(config.identityFile, '');
});

test('an explicitly selected external key is imported and protected without changing its source', t => {
  const f = fixture(t);
  const external = put(f.container, 'external/my-key', 'synthetic-external-key-fixture');
  put(f.container, 'external/my-key.pub', 'synthetic-public-fixture');
  const config = json(f.platform, 'data/connection.json'); config.identityFile = external;
  put(f.platform, 'data/connection.json', config);
  portable.preparePortable(f.platform, f.options);
  const imported = json(f.platform, 'data/connection.json').identityFile;
  assert.ok(imported.startsWith(path.join(f.platform, 'data/ssh/imported-')));
  assert.equal(fs.readFileSync(imported, 'utf8'), 'synthetic-external-key-fixture');
  assert.equal(fs.readFileSync(imported + '.pub', 'utf8'), 'synthetic-public-fixture');
  assert.equal(fs.readFileSync(external, 'utf8'), 'synthetic-external-key-fixture');
  assert.equal(f.protections.length, 1);
  assert.ok(f.protections[0].startsWith(imported + '.'));
  assert.ok(f.protections[0].endsWith('.tmp'), 'ACL is secured before publishing the imported private key');
});

test('malformed JSON and a missing moved key fail before rewriting configuration or generating any key', t => {
  for (const mode of ['invalid-json', 'missing-key']) {
    const f = fixture(t);
    if (mode === 'invalid-json') put(f.platform, 'data/vscode-user/User/settings.json', '{broken');
    else {
      const moved = path.join(f.container, 'moved');
      core.assertLocalPath(moved, { within: f.container });
      fs.renameSync(f.platform, moved); f.platform = moved;
      fs.unlinkSync(path.join(moved, 'data/ssh/id_ed25519'));
    }
    const before = fs.readFileSync(path.join(f.platform, 'data/connection.json'));
    const launch = fs.readFileSync(path.join(f.platform, 'launch-config.json'));
    const keyFiles = fs.readdirSync(path.join(f.platform, 'data/ssh'));
    assert.throws(() => portable.preparePortable(f.platform, f.options), mode === 'invalid-json' ? /invalid JSON/ : /missing its SSH key/);
    assert.deepEqual(fs.readFileSync(path.join(f.platform, 'data/connection.json')), before);
    assert.deepEqual(fs.readFileSync(path.join(f.platform, 'launch-config.json')), launch);
    assert.deepEqual(fs.readdirSync(path.join(f.platform, 'data/ssh')), keyFiles);
    assert.deepEqual(f.protections, []); assert.deepEqual(f.calls, []);
  }
});

test('failed key protection does not publish an imported private key or change the selected connection', t => {
  const f = fixture(t);
  const external = put(f.container, 'external/key', 'synthetic-key-ACL-failure');
  const config = { ...json(f.platform, 'data/connection.json'), identityFile: external };
  put(f.platform, 'data/connection.json', config);
  const before = fs.readFileSync(path.join(f.platform, 'data/connection.json'));
  assert.throws(() => portable.preparePortable(f.platform, { ...f.options, restrictPrivateKey() { throw Error('fixture denied'); } }), /fixture denied/);
  assert.deepEqual(fs.readFileSync(path.join(f.platform, 'data/connection.json')), before);
  assert.equal(fs.readdirSync(path.join(f.platform, 'data/ssh')).some(file => file.startsWith('imported-')), false);
});

test('path rebasing respects sibling prefixes and rejects a previous drive root', () => {
  const old = 'E:\\Portable App', next = 'D:\\Research';
  assert.equal(portable.rebase(old + '\\data\\cache', old, next), next + '\\data\\cache');
  assert.equal(portable.rebase(old + '-other\\keep', old, next), old + '-other\\keep');
  assert.equal(portable.rebase('/root/research', old, next), '/root/research');
  assert.throws(() => portable.previousRoot({ root: 'E:\\' }, {}), /previous platform root is invalid/);
});

test('Git credential repair passes literal argv, a quoted bundled helper and isolated configuration to the runner', t => {
  const f = fixture(t);
  const moved = path.join(f.container, "quoted ' app");
  core.assertLocalPath(moved, { within: f.container });
  fs.renameSync(f.platform, moved); f.platform = moved;
  put(moved, '.agent-sync/config.json', { repository: 'example/approved-repository', branch: 'main', gitExe: 'E:\\old\\git.exe', ghExe: 'E:\\old\\gh.exe' });
  put(moved, '.agent-sync/private/gitconfig', '# fixture existing local configuration\n');
  portable.preparePortable(moved, f.options);
  const config = json(moved, '.agent-sync/config.json');
  assert.equal(config.repository, 'example/approved-repository');
  assert.equal(config.gitExe, path.join(moved, 'app/git/cmd/git.exe'));
  const helper = f.calls.find(call => call.args.includes('--add') && call.args.some(arg => arg.endsWith(' auth git-credential')));
  assert.ok(helper);
  assert.equal(helper.exe, config.gitExe);
  assert.equal(helper.options.shell, false);
  assert.equal(helper.options.cwd, moved);
  assert.equal(helper.options.env.GIT_CONFIG_GLOBAL, path.join(moved, '.agent-sync/private/gitconfig'));
  assert.equal(helper.options.env.GH_CONFIG_DIR, path.join(moved, '.agent-sync/private/gh'));
  const expected = "!'" + path.join(moved, 'app/gh/bin/gh.exe').replaceAll('\\', '/').replaceAll("'", "'\\''") + "' auth git-credential";
  assert.equal(helper.args.at(-1), expected);
  assert.equal(f.calls.some(call => call.args.includes('push') || call.args.includes('clone') || call.args.includes('init')), false);
});

test('native Windows ACL protection succeeds for a newly imported fixture without exposing source contents', t => {
  const f = fixture(t);
  const external = put(f.container, 'external/key', 'synthetic-native-acl-key');
  put(f.platform, 'data/connection.json', { ...json(f.platform, 'data/connection.json'), identityFile: external });
  fs.mkdirSync(path.join(f.platform, 'data/temp'), { recursive: true });
  portable.preparePortable(f.platform, { run: f.options.run });
  const imported = json(f.platform, 'data/connection.json').identityFile;
  assert.equal(fs.readFileSync(imported, 'utf8'), 'synthetic-native-acl-key');
  assert.equal(fs.readFileSync(external, 'utf8'), 'synthetic-native-acl-key');
  assert.ok(json(f.platform, 'data/portable-state.json').userSid.startsWith('S-1-'));
});
