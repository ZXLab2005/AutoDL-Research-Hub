'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../src/core');
const { writeLaunchSession } = require('../scripts/fresh-start');

const root = path.resolve(__dirname, '..');

function fixture(t) {
  const tempRoot = core.assertEPath(path.join(root, 'data', 'temp'), { within: root });
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = core.assertEPath(fs.mkdtempSync(path.join(tempRoot, 'fresh-start-test-')), { within: tempRoot });
  t.after(() => {
    core.assertEPath(dir, { within: tempRoot });
    fs.rmSync(dir, { recursive: true });
  });
  return dir;
}

function put(root, file, value) {
  const dest = core.assertEPath(path.join(root, file), { within: root });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, typeof value === 'string' ? value : JSON.stringify(value));
}

function read(root, file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('initialization disables UI restoration while preserving credentials, backups, history and custom workspace settings', t => {
  const dir = fixture(t);
  put(dir, 'package.json', { name: 'fresh-start-fixture', version: '1.2.0' });
  put(dir, 'launch-config.json', {});
  put(dir, 'src/example.js', '// test source');
  put(dir, 'data/connection.json', { host: 'test.example.org', port: 2222, remotePath: '/home/research/project' });
  put(dir, 'data/vscode-user/User/settings.json', { 'editor.fontSize': 19, 'chatgpt.openOnStartup': true, 'window.restoreWindows': 'all' });
  put(dir, 'Research.code-workspace', {
    folders: [{ name: 'Research folder', path: 'workspace' }],
    settings: { 'editor.wordWrap': 'on', 'chatgpt.openOnStartup': true },
    extensions: { recommendations: ['ms-python.python'] },
  });
  const preserved = [
    'data/codex/auth.json', 'data/codex/sessions/history.jsonl',
    'data/codex/config.toml', 'data/ssh/id_ed25519',
    'data/vscode-user/Backups/unsaved-fixture',
    'data/vscode-user/User/workspaceStorage/example/state.vscdb',
    'workspace/research.py',
  ];
  for (const file of preserved) put(dir, file, `preserve fixture: ${file}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'initialize.js'), dir], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TEMP: path.join(dir, 'data', 'temp'), TMP: path.join(dir, 'data', 'temp') },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of preserved) assert.equal(read(dir, file), `preserve fixture: ${file}`);
  const settings = JSON.parse(read(dir, 'data/vscode-user/User/settings.json'));
  assert.equal(settings['editor.fontSize'], 19);
  assert.equal(settings['window.restoreWindows'], 'none');
  assert.equal(settings['workbench.editor.restoreEditors'], false);
  assert.equal(settings['terminal.integrated.enablePersistentSessions'], false);
  assert.equal(settings['terminal.integrated.persistentSessionReviveProcess'], 'never');
  assert.equal(settings['terminal.integrated.hideOnStartup'], 'always');
  assert.equal(settings['files.hotExit'], 'onExit');
  assert.equal(settings['chatgpt.openOnStartup'], false);
  const workspace = JSON.parse(read(dir, 'Research.code-workspace'));
  assert.equal(workspace.settings['chatgpt.openOnStartup'], false);
  assert.equal(workspace.settings['workbench.editor.restoreEditors'], false);
  assert.equal(workspace.settings['editor.wordWrap'], 'on');
  assert.deepEqual(workspace.folders, [{ name: 'Research folder', path: 'workspace' }]);
  assert.deepEqual(workspace.extensions, { recommendations: ['ms-python.python'] });
  assert.equal(JSON.parse(read(dir, 'data/connection.json')).remotePath, '/home/research/project');
  assert.equal(fs.existsSync(path.join(dir, 'data', 'launch-session.json')), false, 'install-only initialization must not reset a running session');
});

test('each explicit launch emits a new session without modifying project and authentication files', t => {
  const dir = fixture(t);
  put(dir, 'data/codex/auth.json', 'fixture login must remain');
  put(dir, 'workspace/experiment.py', 'fixture experiment must remain');
  const first = writeLaunchSession(dir);
  const second = writeLaunchSession(dir);
  assert.notEqual(first.id, second.id);
  assert.match(second.id, /^[0-9a-f-]{36}$/);
  assert.equal(second.version, 1);
  assert.equal(second.mode, 'fresh-home');
  assert.ok(Number.isFinite(Date.parse(second.startedAt)));
  assert.deepEqual(JSON.parse(read(dir, 'data/launch-session.json')), second);
  assert.equal(read(dir, 'data/codex/auth.json'), 'fixture login must remain');
  assert.equal(read(dir, 'workspace/experiment.py'), 'fixture experiment must remain');
  assert.equal(fs.readdirSync(path.join(dir, 'data')).filter(file => file.endsWith('.tmp')).length, 0);
});

test('fresh launch refuses relative and network roots before writing anything', () => {
  assert.throws(() => writeLaunchSession('\\\\host\\share\\hub'));
  assert.throws(() => writeLaunchSession('E:relative'));
  assert.throws(() => writeLaunchSession('E:\\'));
});
