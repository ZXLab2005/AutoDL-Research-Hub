'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = { ...core.defaultConfig, host: 'connect.example.com', port: 23456 };

test('storage inventory stays within its portable root and keeps SSH files isolated', () => {
  const paths = core.getPaths(ROOT);
  for (const [key, value] of Object.entries(paths)) {
    if (key !== 'directories') assert.equal(core.assertLocalPath(value, { within: ROOT }), value);
  }
  assert.equal(paths.sshConfig, `${ROOT}\\data\\ssh\\config`);
  assert.equal(paths.knownHosts, `${ROOT}\\data\\ssh\\known_hosts`);
  assert.equal(paths.codexHome, `${ROOT}\\data\\codex`);
  assert.ok(paths.directories.includes(paths.temp));
  assert.ok(!paths.directories.includes(paths.configFile));
});

test('accept local drives but reject relative paths and Windows path aliases', () => {
  for (const candidate of [
    'relative\\folder', 'E:relative', '\\\\server\\share', '\\\\?\\E:\\folder',
    'E:\\a\\..\\other', 'E:\\a\\.\\other', 'E:\\a.\\other', 'E:\\a \\other',
    'E:\\file:stream', 'E:\\NUL', 'E:\\con.txt', 'E:\\COM1\\file', 'E:\\bad\nfile',
  ]) {
    assert.throws(() => core.assertEPath(candidate), undefined, candidate);
  }
  assert.equal(core.assertEPath('e:/研究/keys/id_ed25519'), 'E:\\研究\\keys\\id_ed25519');
  assert.equal(core.assertLocalPath('D:\\Portable Hub'), 'D:\\Portable Hub');
  assert.throws(() => core.assertEPath('E:\\elsewhere', { within: ROOT }));
});

test('connection accepts domain, IPv4, IPv6, numeric port input and Chinese remote paths', () => {
  assert.equal(core.validateConfig({ ...CONFIG, host: 'CONNECT.Example.COM', port: '2222' }).host, 'connect.example.com');
  assert.equal(core.validateConfig({ ...CONFIG, port: '2222' }).port, 2222);
  assert.equal(core.validateConfig({ ...CONFIG, host: '192.0.2.4' }).host, '192.0.2.4');
  assert.equal(core.validateConfig({ ...CONFIG, host: '[2001:db8::1]' }).host, '2001:db8::1');
  assert.equal(core.validateConfig({ ...CONFIG, remotePath: '/root/autodl-tmp/研究' }).remotePath, '/root/autodl-tmp/研究');
});

test('reject SSH config injection, shell paths, credentials and invalid config types', () => {
  for (const patch of [
    { host: 'host\nProxyCommand anything' }, { host: '-oProxyCommand=anything' },
    { host: 'host;touch' }, { host: '999.1.1.1' }, { user: 'root -o anything' },
    { remotePath: 'relative/path' }, { remotePath: '/root/../etc' },
    { remotePath: '/root/$(touch /tmp/x)' }, { remotePath: '/root/a;b' },
    { remotePath: '/root/a\nb' }, { remotePath: '/root/a b' },
    { identityFile: '.ssh\\id_ed25519' },
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: '22x' }, { useProxy: 'true' },
    { tunnel: true, useProxy: false }, { password: 'must-not-be-stored' },
  ]) assert.throws(() => core.validateConfig({ ...CONFIG, ...patch }));
  assert.throws(() => core.validateConfig(null));
  assert.throws(() => core.validateConfig([]));
  assert.throws(() => core.validateConfig({}));
});

test('proxy remains local and cannot include credentials or arbitrary URL fields', () => {
  assert.equal(core.parseProxy('http://localhost:7897').port, 7897);
  assert.equal(core.parseProxy('http://[::1]:7897').host, '[::1]');
  for (const proxyUrl of [
    'http://example.com:7897', 'http://0.0.0.0:7897', 'http://127.0.0.1.evil.test:7897',
    'http://user:password@127.0.0.1:7897', 'http://127.0.0.1:7897/path',
    'http://127.0.0.1:7897?x=1', 'http://127.0.0.1:7897#x',
    'socks5://127.0.0.1:7897', 'http://127.0.0.1:70000',
  ]) assert.throws(() => core.validateConfig({ ...CONFIG, proxyUrl }));
});

test('SSH command import supports AutoDL commands and quoted local keys', () => {
  assert.deepEqual(core.parseSshCommand('ssh -p 23456 root@connect.example.com'), {
    host: 'connect.example.com', port: 23456, user: 'root', identityFile: '',
  });
  assert.deepEqual(core.parseSshCommand('ssh root@[2001:db8::1] -i "E:\\研究 keys\\id_ed25519" -p 2222'), {
    host: '2001:db8::1', port: 2222, user: 'root', identityFile: 'E:\\研究 keys\\id_ed25519',
  });
  assert.equal(core.parseSshCommand('ssh.exe root@localhost').port, 22);
});

test('SSH command import rejects executable options, shell commands and password text', () => {
  for (const command of [
    'ssh -o ProxyCommand=anything root@host', 'ssh -R 1:host:2 root@host',
    'ssh root@host echo hello', 'ssh root@host; whoami', 'ssh root@host && whoami',
    'ssh root@host\nwhoami', 'ssh root@host `whoami`', 'ssh root@host $(whoami)',
    'sshpass -p password ssh root@host', 'ssh -p 22 -p 23 root@host',
    'ssh -i relative-key root@host', 'ssh host', 'ssh root@host password',
    'ssh -p root@host', 'ssh root@host -i "E:\\unclosed',
  ]) assert.throws(() => core.parseSshCommand(command), undefined, command);
});

test('SSH output preserves host-key checks and leaves tunnels to a separate process', () => {
  const plain = core.renderSshConfig(ROOT, CONFIG);
  assert.match(plain, /StrictHostKeyChecking ask/);
  assert.ok(plain.includes('UserKnownHostsFile "' + core.getPaths(ROOT).knownHosts.replaceAll('\\', '/') + '"'));
  assert.match(plain, /GlobalKnownHostsFile NUL/);
  assert.match(plain, /IdentityFile none/);
  assert.doesNotMatch(plain, /RemoteForward|RemoteCommand|ProxyCommand/);
  const tunneled = core.renderSshConfig(ROOT, { ...CONFIG, tunnel: true, identityFile: 'E:\\keys\\id_ed25519' });
  assert.doesNotMatch(tunneled, /RemoteForward/);
  assert.match(tunneled, /IdentityFile "E:\/keys\/id_ed25519"/);
});

test('project terminal uses the selected remote folder and a fail-closed remote command', () => {
  const config = { ...CONFIG, remotePath: '/root/autodl-tmp/研究', identityFile: 'E:\\keys\\id_ed25519' };
  const args = core.buildProjectSshArgs(ROOT, config);
  assert.deepEqual(args.slice(-3), [
    '-t', 'autodl-research',
    'cd -- \'/root/autodl-tmp/研究\' && printf \'[AutoDL remote] host=%s cwd=%s\\n\' "$(hostname)" "$PWD" && exec bash -i',
  ]);
  assert.equal(args[args.indexOf('-F') + 1], core.getPaths(ROOT).sshConfig);
  assert.equal(args[args.indexOf('-i') + 1], config.identityFile);
  assert.equal(args[args.indexOf('-p') + 1], String(config.port));
  assert.equal(args[args.indexOf('-l') + 1], config.user);
  assert.ok(args.includes('HostName=' + config.host));
  for (const setting of [
    'BatchMode=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
    'PreferredAuthentications=publickey', 'StrictHostKeyChecking=yes',
    'ForwardAgent=no', 'IdentityAgent=none', 'ClearAllForwardings=yes',
    'PermitLocalCommand=no', 'ProxyCommand=none', 'RemoteCommand=none',
  ]) assert.ok(args.includes(setting), setting);
  // No fallback branch after a failed cd; the only command argument is sent
  // after the remote host and is never a local PowerShell command.
  assert.doesNotMatch(args.at(-1), /\|\||;|powershell|cmd\.exe/i);
  assert.equal(args.includes('-R'), false);
  assert.equal(args.includes('-L'), false);
});

test('project terminal refuses missing keys and unsafe remote directories before opening SSH', () => {
  assert.throws(() => core.buildProjectSshArgs(ROOT, CONFIG), /私钥/);
  for (const remotePath of ["/root/a'", '/root/../etc', '/root/a;bash', '/root/$(whoami)', 'relative', '/root/a\nb']) {
    assert.throws(() => core.buildProjectSshArgs(ROOT, { ...CONFIG, remotePath, identityFile: 'E:\\keys\\id_ed25519' }));
    assert.throws(() => core.buildRemoteProjectUriData({ ...CONFIG, remotePath }));
  }
});

test('remote project URI and terminal target the same validated directory', () => {
  const config = { ...CONFIG, remotePath: '/root/autodl-tmp/共享项目', identityFile: 'E:\\keys\\id_ed25519' };
  const uri = core.buildRemoteProjectUriData(config);
  assert.deepEqual(uri, { scheme: 'vscode-remote', authority: 'ssh-remote+autodl-research', path: config.remotePath });
  assert.ok(core.buildProjectSshArgs(ROOT, config).at(-1).startsWith(`cd -- '${uri.path}' && `));
});

test('Windows storage env and remote Linux env remain separate', () => {
  const settings = core.buildSettings(ROOT, { ...CONFIG, tunnel: true });
  const local = settings['terminal.integrated.env.windows'];
  const remote = settings['terminal.integrated.env.linux'];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME', 'PIP_CACHE_DIR', 'HF_HOME']) {
    assert.equal(core.assertLocalPath(local[key], { within: ROOT }), local[key]);
  }
  assert.equal(local.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(remote.HTTP_PROXY, 'http://127.0.0.1:17897');
  assert.equal(remote.CODEX_HOME, '/root/autodl-tmp/research-hub/codex');
  assert.doesNotMatch(JSON.stringify(remote), /[CE]:/i);
  assert.equal(settings['remote.SSH.serverInstallPath']['autodl-research'], '/root/autodl-tmp/research-hub/vscode-server');
  assert.deepEqual(settings['remote.SSH.defaultExtensions'], ['ms-python.python', 'ms-python.vscode-pylance', 'ms-toolsai.jupyter']);
  assert.equal(settings['remote.SSH.defaultExtensions'].includes('openai.chatgpt'), false);
  assert.equal(settings['remote.SSH.showLoginTerminal'], false);
  assert.equal(settings['remote.SSH.connectTimeout'], 45);
  assert.equal(settings['chatgpt.openOnStartup'], false);
  assert.equal(Object.hasOwn(settings, 'http.proxy'), false);
  assert.equal(Object.hasOwn(core.buildStorageEnv(ROOT, { ...CONFIG, useProxy: false }), 'HTTP_PROXY'), false);
  assert.equal(Object.hasOwn(core.buildSettings(ROOT, CONFIG)['terminal.integrated.env.linux'], 'HTTP_PROXY'), false);
});

test('config persistence roundtrip uses a dedicated platform test directory', { skip: process.platform !== 'win32' }, () => {
  const testRoot = path.win32.join(ROOT, 'data', 'test-runs', `core-${process.pid}-${Date.now()}`);
  core.assertEPath(testRoot, { within: ROOT });
  try {
    assert.deepEqual(core.readConfig(testRoot), core.defaultConfig);
    const paths = core.getPaths(testRoot);
    core.saveConfig(testRoot, core.defaultConfig);
    assert.deepEqual(core.readConfig(testRoot), core.defaultConfig);
    assert.doesNotMatch(fs.readFileSync(paths.sshConfig, 'utf8'), /^\s*Host\s/m);
    assert.throws(() => core.validateConfig(core.defaultConfig));
    assert.throws(() => core.renderSshConfig(testRoot, core.defaultConfig));
    const saved = core.saveConfig(testRoot, CONFIG);
    assert.deepEqual(core.readConfig(testRoot), saved);
    assert.match(fs.readFileSync(paths.sshConfig, 'utf8'), /Port 23456/);
    assert.equal(fs.readdirSync(paths.data).some(name => name.endsWith('.tmp')), false);
    const original = fs.readFileSync(paths.configFile, 'utf8');
    assert.throws(() => core.saveConfig(testRoot, { ...CONFIG, host: 'bad\nHost *' }));
    assert.equal(fs.readFileSync(paths.configFile, 'utf8'), original);
  } finally {
    core.assertEPath(testRoot, { within: ROOT });
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('existing junctions cannot redirect platform writes', { skip: process.platform !== 'win32' }, () => {
  const testRoot = path.win32.join(ROOT, 'data', 'test-runs', `junction-${process.pid}-${Date.now()}`);
  const outside = path.win32.join(testRoot, 'outside');
  const platform = path.win32.join(testRoot, 'platform');
  const link = path.win32.join(platform, 'data');
  core.assertEPath(testRoot, { within: ROOT });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(platform, { recursive: true });
  try {
    fs.symlinkSync(outside, link, 'junction');
    assert.throws(() => core.getPaths(platform), /链接/);
    assert.throws(() => core.saveConfig(platform, CONFIG), /链接/);
    assert.deepEqual(fs.readdirSync(outside), []);
    // Remove the junction itself before recursively deleting the test fixture.
    fs.unlinkSync(link);
    fs.symlinkSync('C:\\Windows', link, 'junction');
    assert.throws(() => core.assertEPath(link), /链接/);
    assert.throws(() => core.saveConfig(platform, CONFIG), /链接/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    core.assertEPath(testRoot, { within: ROOT });
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('Codex routes only to the dedicated local control workspace', () => {
  const workspaceFile={scheme:'file',fsPath:ROOT+'\\Research.code-workspace'};
  assert.equal(core.codexConsoleAction('',workspaceFile,ROOT),'open-sidebar');
  assert.equal(core.codexConsoleAction('',{...workspaceFile,fsPath:workspaceFile.fsPath.toLowerCase()},ROOT),'open-sidebar');
  assert.equal(core.codexConsoleAction('',undefined,ROOT),'open-workspace');
  assert.equal(core.codexConsoleAction('',{scheme:'file',fsPath:ROOT+'\\other.code-workspace'},ROOT),'open-workspace');
  assert.equal(core.codexConsoleAction('ssh-remote',workspaceFile,ROOT),'return-local');
  assert.equal(core.codexConsoleAction('ssh-remote',{scheme:'vscode-remote',fsPath:'/root/project'},ROOT),'return-local');
});
test('local workspace scopes Codex startup without bypassing workspace trust', () => {
  const workspace=JSON.parse(fs.readFileSync(path.join(__dirname,'..','Research.code-workspace'),'utf8'));
  assert.equal(workspace.folders[0].path,'workspace');
  assert.equal(workspace.settings['chatgpt.openOnStartup'],false);
  assert.equal(workspace.settings['security.workspace.trust.enabled'],undefined);
  assert.equal(workspace.settings['remote.extensionKind'],undefined);
  const settings=core.buildSettings(ROOT,CONFIG);
  assert.equal(settings['chatgpt.openOnStartup'],false);
  assert.equal(settings['remote.SSH.defaultExtensions'].includes('openai.chatgpt'),false);
  assert.equal(settings['remote.extensionKind'],undefined);
});
