'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const path = require('node:path');
const bridge = require('../scripts/invoke-autodl');
const core = require('../src/core');
const root = path.resolve(__dirname, '..');
const config = { ...core.defaultConfig, host: 'connect.example.com', port: 24470, identityFile: root + '\\workspace\\bridge-test-key' };
const paths = core.getPaths(root);
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

test('Command crosses argv as Base64 and retains Chinese, quotes and multiline UTF-8 LF bytes', () => {
  const command = 'printf "%s\\n" "中文研究"\r\npython - <<\'PY\'\r\nprint("实验完成")\r\nPY\r\nexit 23';
  const parsed = bridge.parseArguments(['--root-base64', b64(root), '--command-base64', b64(command)]);
  assert.equal(parsed.command, command.replace(/\r\n/g, '\n'));
  const bytes = bridge.buildRemoteScript('/root/autodl-tmp/研究', parsed.command);
  assert.ok(Buffer.isBuffer(bytes));
  const sent = bytes.toString('utf8');
  assert.ok(sent.startsWith("set -e\ncd -- '/root/autodl-tmp/研究'\n"));
  assert.ok(sent.endsWith('exit 23\n'));
  assert.ok(sent.includes('print("实验完成")\nPY'));
  assert.ok(!sent.includes('\r'));
  assert.deepEqual(Buffer.from(sent, 'utf8'), bytes);
});

test('connection/config mismatch or injected local SSH command is rejected before spawn', () => {
  const text = core.renderSshConfig(root, config);
  assert.deepEqual(bridge.validateConnectionSnapshot(root, config, text), core.validateConfig(config));
  assert.throws(() => bridge.validateConnectionSnapshot(root, config, text + '  ProxyCommand evil\n'), /does not match/);
  assert.throws(() => bridge.validateConnectionSnapshot(root, { ...config, port: 1234 }, text), /does not match/);
  assert.throws(() => bridge.validateConnectionSnapshot(root, { ...config, identityFile: '' }, text), /identity/);
  assert.throws(() => bridge.buildRemoteScript('/root/../etc', 'pwd'), /远端目录/);
  assert.throws(() => bridge.buildRemoteScript("/root/a'; whoami", 'pwd'), /远端目录/);
});

test('private key and credentials cannot be uploaded; outside-root and linked escape rejected without reading data', () => {
  let reads = 0;
  const io = { readFileSync() { reads++; throw Error('must never read'); }, realpathSync: { native() { return 'C:\\secret.sh'; } } };
  for (const candidate of [config.identityFile, root + '\\data\\codex\\auth.json', 'C:\\work\\job.sh', 'E:\\a\\..\\job.sh']) {
    assert.throws(() => bridge.readScriptFile(root, config, candidate, io));
  }
  assert.throws(() => bridge.readScriptFile(root, config, root + '\\workspace\\linked.sh', io));
  assert.equal(reads, 0);
});

test('ScriptPath reads UTF-8 BOM and CRLF as LF; invalid UTF-8 and private-key text rejected', () => {
  const file = root + '\\workspace\\research.sh';
  const io = content => ({
    realpathSync: { native() { return file; } },
    statSync() { return { isFile: () => true, size: content.length }; },
    readFileSync() { return content; }
  });
  assert.equal(bridge.readScriptFile(root, config, file, io(Buffer.from('\uFEFFecho 中文\r\npwd\r\n'))), 'echo 中文\npwd\n');
  assert.throws(() => bridge.readScriptFile(root, config, file, io(Buffer.from([0xff]))), /UTF-8/);
  assert.throws(() => bridge.readScriptFile(root, config, file, io(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n'))), /Private key/);
});

test('mutual exclusivity, unknown arguments and invalid transport/limits fail early', () => {
  const prefix = ['--root-base64', b64(root)];
  assert.throws(() => bridge.parseArguments(prefix), /exactly one/);
  assert.throws(() => bridge.parseArguments([...prefix, '--command-base64', b64('pwd'), '--script-base64', b64('E:\\job.sh')]), /exactly one/);
  assert.throws(() => bridge.parseArguments([...prefix, '--command-base64', '??']), /Base64/);
  assert.throws(() => bridge.parseArguments([...prefix, '--command-base64', b64('pwd'), '--bad', 'x']), /Invalid/);
  assert.throws(() => bridge.buildSshArgs(paths, 0), /ConnectTimeoutSeconds/);
  assert.throws(() => bridge.buildRemoteScript(config.remotePath, '\0'), /NUL/);
});

function mockSsh(mode, exitCode = 0) {
  const captured = { chunks: [], kills: 0, reports: [] };
  captured.spawn = (exe, args, options) => {
    captured.exe = exe; captured.args = args; captured.options = options;
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, encoding, callback) { captured.chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        callback();
        if (mode === 'exit') setImmediate(() => child.emit('close', exitCode, null));
        if (mode === 'error') setImmediate(() => child.emit('error', Error('secret should not be included')));
      }
    });
    child.kill = () => { captured.kills++; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    return child;
  };
  return captured;
}
function options(script, extra = {}) {
  return { paths, sshExe: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', env: { TEMP: paths.temp }, script, timeoutSeconds: 0, connectTimeoutSeconds: 15, ...extra };
}
const deps = captured => ({ spawn: captured.spawn, report: text => captured.reports.push(text) });

test('mock SSH receives exact stdin bytes, strict key-only flags, inherited output and remote exit code', async () => {
  const command = 'printf "中文\\n"\nexit 23';
  const script = bridge.buildRemoteScript(config.remotePath, command);
  const captured = mockSsh('exit', 23);
  assert.equal(await bridge.runSsh(options(script), deps(captured)), 23);
  assert.deepEqual(Buffer.concat(captured.chunks), script);
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.options.stdio, ['pipe', 'inherit', 'inherit']);
  assert.deepEqual(captured.args.slice(-4), ['autodl-research', 'bash', '-s', '--']);
  for (const flag of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'PreferredAuthentications=publickey', 'UpdateHostKeys=no', 'PermitLocalCommand=no', 'ProxyCommand=none']) {
    assert.ok(captured.args.includes(flag), flag);
  }
  assert.ok(!captured.args.includes(command));
  assert.equal(captured.kills, 0);
});

test('timeout returns 124 and cancellation 130; neither claims a remote job was killed', async () => {
  const timeout = mockSsh('wait');
  const outcomes = [];
  assert.equal(await bridge.runSsh(options(Buffer.from('pwd\n'), { timeoutSeconds: 1 }), { ...deps(timeout), onOutcome: value => outcomes.push(value) }), 124);
  assert.equal(timeout.kills, 1);
  assert.ok(timeout.reports.join('\n').includes('a remote job may continue'));
  const cancelled = mockSsh('wait');
  const controller = new AbortController();
  const result = bridge.runSsh(options(Buffer.from('pwd\n'), { abortSignal: controller.signal }), { ...deps(cancelled), onOutcome: value => outcomes.push(value) });
  controller.abort();
  assert.equal(await result, 130);
  assert.equal(cancelled.kills, 1);
  assert.deepEqual(outcomes, ['timeout', 'cancelled']);
  const remote124 = mockSsh('exit', 124);
  assert.equal(await bridge.runSsh(options(Buffer.from('exit 124\n')), { ...deps(remote124), onOutcome: value => outcomes.push(value) }), 124);
  assert.equal(outcomes.at(-1), 'exit');
});

test('SSH failure remains 255 with actionable no-password hint; spawn failure returns 127 without detail leakage', async () => {
  const authentication = mockSsh('exit', 255);
  assert.equal(await bridge.runSsh(options(Buffer.from('pwd\n')), deps(authentication)), 255);
  assert.match(authentication.reports.join('\n'), /Test-SSH\.ps1/);
  const missing = mockSsh('error');
  assert.equal(await bridge.runSsh(options(Buffer.from('pwd\n')), deps(missing)), 127);
  assert.ok(!missing.reports.join('\n').includes('secret'));
});

test('real Windows PowerShell 5.1 native argv roundtrip preserves multiline Unicode via Base64', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const command = 'printf "%s\\n" "实验中文"\npython - <<\'PY\'\nprint("多行")\nPY';
  const encoded = b64(command);
  const nodeExe = path.join(root, 'app/node/node.exe').replaceAll("'", "''");
  const ps = "$hubText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')); " +
    "$hubUtf8=New-Object System.Text.UTF8Encoding($false,$true); " +
    "& '" + nodeExe + "' -e 'process.stdout.write(process.argv[1])' ([Convert]::ToBase64String($hubUtf8.GetBytes($hubText))); exit $LASTEXITCODE";
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', ps], {
    cwd: root, windowsHide: true, encoding: 'utf8',
    env: { ...process.env, ...core.buildStorageEnv(root, core.defaultConfig) }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, encoded);
});
