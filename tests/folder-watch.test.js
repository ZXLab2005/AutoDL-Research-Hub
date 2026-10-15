'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const core = require('../src/core');
const watch = require('../src/folder-watch');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = { ...core.defaultConfig, host: 'watch.example.com', port: 22022,
  remotePath: '/root/projects', identityFile: path.join(ROOT, 'data', 'ssh', 'watch-test-identity') };
const PATHS = core.getPaths(ROOT);
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = (extra = {}) => ({ type: 'baseline', root: CONFIG.remotePath,
  timestamp: new Date().toISOString(), filesCount: 1, directoriesCount: 0,
  scannedEntries: 1, complete: true, truncated: false, errors: 0,
  latest: [{ path: '研究.py', kind: 'file', size: 23, mtimeMs: 1 }], ...extra });

test('JSON parser handles byte splits inside UTF-8 and multiple/partial lines', () => {
  const values = [], errors = [];
  const parser = watch.createLineParser(value => values.push(value), error => errors.push(error));
  const bytes = Buffer.from(JSON.stringify({ path: '中文.py' }) + '\n' + JSON.stringify({ count: 2 }) + '\n');
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(values, [{ path: '中文.py' }, { count: 2 }]);
  assert.equal(errors.length, 0);
});

test('JSON parser bounds malformed/unterminated output and never resumes after error', () => {
  for (const chunks of [['bad\n', '{}\n'], ['{"unfinished":'], ['x'.repeat(51)]]) {
    const values = [], errors = [];
    const parser = watch.createLineParser(value => values.push(value), error => errors.push(error), { maxBytes: 50 });
    chunks.forEach(chunk => parser.write(chunk));
    parser.end();
    assert.equal(errors.length, 1);
    assert.equal(values.length, 0);
    assert.ok(!errors[0].message.includes(chunks[0]));
  }
});

test('watch SSH is pinned to saved target with no password, forwarding or local shell fallback', () => {
  const args = watch.buildWatchArgs(PATHS, CONFIG);
  for (const option of ['BatchMode=yes', 'PasswordAuthentication=no', 'StrictHostKeyChecking=yes',
    'IdentityAgent=none', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no',
    'ProxyCommand=none', 'GlobalKnownHostsFile=NUL']) assert.ok(args.includes(option), option);
  assert.ok(args.includes(CONFIG.identityFile));
  assert.ok(args.includes('HostName=watch.example.com'));
  assert.equal(args.at(-1), "python3 -u -B - '/root/projects' 3 10000");
  assert.throws(() => watch.buildWatchArgs(PATHS, { ...CONFIG, remotePath: '/root/../etc' }));
  assert.throws(() => watch.buildWatchArgs(PATHS, CONFIG, 0));
});

test('event validation rejects mismatched server directory, escaped paths and oversized batches', () => {
  assert.equal(watch.validateEvent(event(), CONFIG.remotePath), true);
  for (const value of [event({ root: '/elsewhere' }), event({ scannedEntries: 99999 }),
    event({ latest: [{ path: '../secret', kind: 'file', size: 2, mtimeMs: 2 }] }),
    event({ latest: [{ path: '/etc/passwd', kind: 'file', size: 2, mtimeMs: 2 }] }),
    event({ latest: Array(11).fill(event().latest[0]) }), event({ timestamp: 'nonsense' })]) {
    assert.equal(watch.validateEvent(value, CONFIG.remotePath), false);
  }
});

function fixture({ busy = false } = {}) {
  const statuses = [], events = [], children = [], timers = [], server = new EventEmitter();
  server.listen = (name, callback) => {
    server.name = name;
    queueMicrotask(() => busy ? server.emit('error', Object.assign(Error('busy'), { code: 'EADDRINUSE' })) : callback());
  };
  server.close = callback => { server.closed = true; callback?.(); };
  const dependencies = {
    validateSnapshot: () => ({ config: CONFIG, paths: PATHS }),
    createServer: () => server,
    setTimeout: (fn, ms) => { const token = { fn, ms, cancelled: false, unref() {} }; timers.push(token); return token; },
    clearTimeout: token => { token.cancelled = true; },
    spawn: (exe, args, options) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.exitCode = null; child.signalCode = null; child.kills = 0;
      child.exe = exe; child.args = args; child.options = options;
      child.kill = () => { child.kills += 1; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null)); };
      children.push(child); return child;
    },
  };
  const controller = watch.startWatch(ROOT, CONFIG, { onStatus: value => statuses.push(value), onEvent: value => events.push(value) }, dependencies);
  return { statuses, events, children, timers, server, controller, dependencies };
}

test('watcher scopes process storage to the platform, emits complete scans, and stops only owned SSH', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.children.length, 1);
  const owned = f.children[0];
  assert.equal(owned.options.windowsHide, true);
  assert.equal(owned.options.shell, false);
  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'CODEX_HOME']) core.assertLocalPath(owned.options.env[name], { within: ROOT });
  owned.stdout.write(JSON.stringify(event()) + '\n');
  assert.equal(f.events.length, 1);
  assert.equal(f.statuses.at(-1).state, 'watching');
  const statusCount = f.statuses.length;
  await f.controller.stop();
  owned.stdout.write(JSON.stringify(event()) + '\n');
  assert.equal(f.events.length, 1);
  assert.equal(f.statuses.length, statusCount);
  assert.equal(owned.kills, 1);
  assert.equal(f.server.closed, true);
  assert.ok(f.timers.every(timer => timer.cancelled));
});

test('cross-window named pipe conflict reports busy without spawning SSH', async () => {
  const f = fixture({ busy: true });
  await flush();
  assert.equal(f.children.length, 0);
  assert.equal(f.statuses.at(-1).state, 'busy');
  assert.match(f.server.name, /^\\\\\.\\pipe\\autodl-research-watch-[a-f0-9]+$/);
  await f.controller.stop();
});

test('watcher reconnects with bounded backoff and gives up after five retries', async () => {
  const f = fixture();
  await flush();
  const delays = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const owned = f.children.at(-1);
    owned.exitCode = 255;
    owned.emit('close', 255);
    if (attempt < 5) {
      assert.equal(f.statuses.at(-1).state, 'retrying');
      const timer = f.timers.filter(timer => !timer.cancelled).at(-1);
      delays.push(timer.ms);
      timer.cancelled = true; timer.fn();
    }
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000]);
  assert.equal(f.children.length, 6);
  assert.equal(f.statuses.at(-1).state, 'error');
  assert.equal(f.server.closed, true);
  await f.controller.stop();
});

test('invalid remote event terminates watcher channel without forwarding payload', async () => {
  const f = fixture();
  await flush();
  f.children[0].stdout.write(JSON.stringify(event({ root: '/etc' })) + '\n');
  await flush();
  assert.equal(f.events.length, 0);
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.statuses.at(-1).state, 'retrying');
  await f.controller.stop();
});

test('stop before lock acquisition performs no connection', async () => {
  const f = fixture();
  await f.controller.stop();
  await flush();
  assert.equal(f.children.length, 0);
  assert.equal(f.statuses.length, 0);
});

test('Python scanner detects real metadata changes, excludes caches, bounds scans and handles unavailable roots safely', t => {
  const python = [process.env.HUB_TEST_PYTHON, ...String(process.env.PATH || '').split(path.delimiter).filter(dir => !/WindowsApps/i.test(dir)).map(dir => path.join(dir, 'python.exe'))].find(file => file && fs.existsSync(file));
  if (!python) return t.skip('Set HUB_TEST_PYTHON to an existing Python executable to run the scanner integration test.');
  const temp = core.assertEPath(fs.mkdtempSync(path.join(PATHS.temp, 'folder-watch-test-')), { within: ROOT });
  try {
    const source = watch.REMOTE_WATCH_SCRIPT.replace("if __name__ == '__main__':\n    main()", '') + String.raw`
import tempfile
root = sys.argv[1]
os.mkdir(os.path.join(root, 'nested'))
os.mkdir(os.path.join(root, 'node_modules'))
with open(os.path.join(root, 'node_modules', 'hidden'), 'w') as file: file.write('ignored')
with open(os.path.join(root, 'first.py'), 'w') as file: file.write('a')
first = scan(root)
assert first['complete'] and first['filesCount'] == 1
assert not any('node_modules' in name for name in first['entries'])
assert event_for(None, first, root)['type'] == 'baseline'
with open(os.path.join(root, 'first.py'), 'w') as file: file.write('changed length')
with open(os.path.join(root, 'nested', 'new.py'), 'w') as file: file.write('new')
second = scan(root)
changed = event_for(first, second, root)
assert changed['counts'] == {'added': 1, 'modified': 1, 'deleted': 0}, changed
assert all('_inode' not in entry and '_mtimeNs' not in entry for entry in changed['changes'])
os.remove(os.path.join(root, 'first.py'))
third = scan(root)
deleted = event_for(second, third, root)
assert deleted['counts']['deleted'] == 1
partial = scan(root, 1)
assert not partial['complete'] and partial['truncated']
assert event_for(third, partial, root)['counts']['deleted'] == 0
missing = scan(os.path.join(root, 'missing'))
assert not missing['complete'] and missing['rootError'] == 'unavailable'
assert event_for(third, missing, root)['counts']['deleted'] == 0
batch = event_for(first, second, root, batch=1)
assert len(batch['changes']) == 1 and batch['omittedChanges'] == 1
try:
    os.symlink(os.path.join(root, 'nested'), os.path.join(root, 'linked'), target_is_directory=True)
except (OSError, NotImplementedError):
    pass
else:
    linked = scan(root)
    assert linked['entries']['linked']['kind'] == 'symlink'
    assert not any(name.startswith('linked/') for name in linked['entries'])
    assert scan(os.path.join(root, 'linked'))['rootError'] == 'symlink'
print('scanner-metadata-tests-ok')
`;
    const result = spawnSync(python, ['-B', '-c', source, temp], {
      env: { ...process.env, ...core.buildStorageEnv(ROOT, CONFIG), PYTHONDONTWRITEBYTECODE: '1' },
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /scanner-metadata-tests-ok/);
  } finally {
    core.assertEPath(temp, { within: PATHS.temp });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
