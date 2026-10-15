'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Engine, execute, runProcess, ignoredWatchPath, validOrigin, serve, contact, SyncError, loadConfig } = require('./sync');

const BASE = path.resolve(__dirname, '../.agent-sync/temp');
const GIT = path.resolve(__dirname, '../app/git/cmd/git.exe');
const GH = process.execPath; // Test runner never invokes authentication.

test('relative bundled tools relocate under the chosen folder while external executables are rejected', async t => {
  fs.mkdirSync(BASE, { recursive: true });
  const root = fs.mkdtempSync(path.join(BASE, 'sync-tool-paths-'));
  t.after(() => {
    assert.ok(fs.realpathSync(root).toLowerCase().startsWith(fs.realpathSync(BASE).toLowerCase() + path.sep));
    fs.rmSync(root, { recursive: true });
  });
  for (const relative of ['app/git/cmd/git.exe', 'app/gh/bin/gh.exe']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture only; never executed');
  }
  fs.mkdirSync(path.join(root, '.agent-sync'));
  const file = path.join(root, '.agent-sync/config.json');
  const config = { repository: 'example/portable', branch: 'main', gitExe: 'app/git/cmd/git.exe', ghExe: 'app/gh/bin/gh.exe', proxyUrl: '' };
  fs.writeFileSync(file, JSON.stringify(config));
  const loaded = loadConfig(root);
  assert.equal(loaded.gitExe, path.join(root, 'app/git/cmd/git.exe'));
  assert.equal(loaded.ghExe, path.join(root, 'app/gh/bin/gh.exe'));
  assert.equal(loaded.repository, config.repository, 'migration does not select a new publishing target');
  fs.writeFileSync(file, JSON.stringify({ ...config, ghExe: process.execPath }));
  assert.throws(() => loadConfig(root), error => error.reason === 'CONFIG_TOOL_PATH_INVALID');
});

async function fixture(t, safetyOverride) {
  fs.mkdirSync(BASE, { recursive: true });
  const root = await fsp.mkdtemp(path.join(BASE, 'sync-test-'));
  const mock = { remote: null, pushes: [], network: [], failPush: false, audits: [] };
  const safety = safetyOverride || {
    async auditIndex() { mock.audits.push('index'); return { ok: true }; },
    async auditCommit({ commit }) { mock.audits.push(commit); return { ok: true }; }
  };
  const config = { repository: 'example-owner/AutoDL-Research-Hub', branch: 'main', gitExe: GIT, ghExe: GH, proxyUrl: '' };
  const engine = new Engine(root, config, { safety, runner: async (exe, args, options) => {
    let i = 0; while (args[i] === '-c') i += 2;
    const command = args.slice(i);
    if (['ls-remote', 'fetch', 'push'].includes(command[0])) {
      mock.network.push(command);
      if (command[0] === 'ls-remote') return { code: 0, stdout: mock.remote ? `${mock.remote}\trefs/heads/main\n` : '', stderr: '' };
      if (command[0] === 'fetch') {
        const result = await runProcess(exe, [...args.slice(0, i), 'update-ref', 'refs/remotes/origin/main', mock.remote], options);
        return result;
      }
      if (mock.failPush) return { code: 1, stdout: '', stderr: 'simulated credentials must never be printed' };
      const sha = command[2].split(':')[0];
      assert.match(sha, /^[a-f0-9]{40,64}$/);
      mock.pushes.push(sha); mock.remote = sha;
      return { code: 0, stdout: '', stderr: '' };
    }
    return runProcess(exe, args, options);
  } });
  async function raw(args) {
    const result = await runProcess(GIT, args, { cwd: root, env: engine.env, timeoutMs: 15000 });
    assert.equal(result.code, 0, `git ${args[0]} failed`);
    return result.stdout.trim();
  }
  await raw(['init', '-b', 'main']);
  await raw(['config', 'user.name', 'Sync test']);
  await raw(['config', 'user.email', 'test@example.invalid']);
  await raw(['remote', 'add', 'origin', 'https://github.com/example-owner/AutoDL-Research-Hub.git']);
  await fsp.writeFile(path.join(root, '.gitignore'), '.agent-sync/\n');
  async function write(name, value) { await fsp.writeFile(path.join(root, name), value); }
  async function commit() { await raw(['add', '-A']); await raw(['commit', '-m', 'test change']); return raw(['rev-parse', 'HEAD']); }
  t.after(async () => {
    const resolved = await fsp.realpath(root);
    assert.ok(resolved.toLowerCase().startsWith((await fsp.realpath(BASE)).toLowerCase() + path.sep));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, engine, mock, config, raw, write, commit };
}

test('initial sync audits the staged snapshot and every outgoing commit before a pinned push', async t => {
  const f = await fixture(t);
  await f.write('research.md', '# research\n');
  const result = await f.engine.sync();
  assert.equal(result.status, 'synced');
  assert.equal(f.mock.pushes.length, 1);
  assert.deepEqual(f.mock.audits, ['index', f.mock.pushes[0]]);
  assert.equal(await f.raw(['status', '--porcelain']), '');
  const count = await f.raw(['rev-list', '--count', 'HEAD']);
  const audits = f.mock.audits.length;
  await f.engine.sync();
  assert.equal(await f.raw(['rev-list', '--count', 'HEAD']), count);
  assert.equal(f.mock.pushes.length, 1, 'unchanged content must not create/push extra commits');
  assert.equal(f.mock.audits.length, audits, 'unchanged published content must not be rescanned');
});

test('user staged changes are left untouched and never committed', async t => {
  const f = await fixture(t);
  await f.write('manual.txt', 'manual staged change'); await f.raw(['add', 'manual.txt']);
  const before = await f.raw(['write-tree']);
  const result = await f.engine.sync();
  assert.equal(result.reason, 'USER_STAGED_CHANGES_NEED_REVIEW');
  assert.equal(await f.raw(['write-tree']), before);
  assert.equal(f.mock.network.length, 0); assert.equal(f.mock.pushes.length, 0);
});

test('index audit rejection leaves the original index untouched, does not commit, and never logs contents', async t => {
  const f = await fixture(t, {
    async auditIndex() { return { ok: false, findings: [{ path: 'blocked.txt', rule: 'sensitive' }] }; },
    async auditCommit() { throw new Error('should not audit an absent commit'); }
  });
  await f.write('blocked.txt', 'simulated-secret-value-never-log');
  const result = await f.engine.sync();
  assert.equal(result.reason, 'STAGED_CONTENT_FAILED_SAFETY_CHECK');
  assert.equal(result.findings, 1); assert.equal(f.mock.pushes.length, 0);
  assert.equal(await f.raw(['diff', '--cached', '--name-only']), '');
  assert.equal(await fsp.readFile(path.join(f.root, 'blocked.txt'), 'utf8'), 'simulated-secret-value-never-log');
  assert.equal(fs.existsSync(path.join(f.root, '.git/index.lock')), false);
  const log = await fsp.readFile(path.join(f.root, '.agent-sync/sync.log'), 'utf8');
  assert.ok(!log.includes('simulated-secret-value-never-log'));
});

test('a manual commit cannot bypass the safety gate', async t => {
  const audited = [];
  const f = await fixture(t, {
    async auditIndex() { return { ok: true }; },
    async auditCommit({ commit }) { audited.push(commit); return { ok: false, findings: [{ path: 'manual.txt', rule: 'sensitive' }] }; }
  });
  await f.write('manual.txt', 'manually committed'); const head = await f.commit();
  const result = await f.engine.sync();
  assert.equal(result.reason, 'PENDING_COMMIT_FAILED_SAFETY_CHECK');
  assert.deepEqual(audited, [head]); assert.equal(f.mock.pushes.length, 0);
});

test('remote ahead pauses without altering working files or the index', async t => {
  const f = await fixture(t);
  await f.write('research.txt', 'base'); const base = await f.commit();
  const tree = await f.raw(['rev-parse', `${base}^{tree}`]);
  f.mock.remote = await f.raw(['commit-tree', tree, '-p', base, '-m', 'remote work']);
  await f.write('research.txt', 'unfinished local work');
  const result = await f.engine.sync();
  assert.equal(result.reason, 'REMOTE_AHEAD_OR_DIVERGED');
  assert.equal(await f.raw(['rev-parse', 'HEAD']), base);
  assert.equal(await f.raw(['diff', '--cached', '--name-only']), '');
  assert.equal(await fsp.readFile(path.join(f.root, 'research.txt'), 'utf8'), 'unfinished local work');
  assert.equal(f.mock.pushes.length, 0);
});

test('divergence pauses without merge, reset, pull, or push', async t => {
  const f = await fixture(t);
  await f.write('research.txt', 'base'); const base = await f.commit();
  const baseTree = await f.raw(['rev-parse', `${base}^{tree}`]);
  await f.write('research.txt', 'local change'); const local = await f.commit();
  f.mock.remote = await f.raw(['commit-tree', baseTree, '-p', base, '-m', 'remote change']);
  const result = await f.engine.sync();
  assert.equal(result.reason, 'REMOTE_AHEAD_OR_DIVERGED');
  assert.equal(await f.raw(['rev-parse', 'HEAD']), local); assert.equal(f.mock.pushes.length, 0);
});

test('an earlier push failure retries its reviewed commit without creating a duplicate commit', async t => {
  const f = await fixture(t);
  await f.write('work.txt', 'prepared'); f.mock.failPush = true;
  const failed = await f.engine.sync(); assert.equal(failed.status, 'paused');
  const committed = await f.raw(['rev-parse', 'HEAD']);
  const count = await f.raw(['rev-list', '--count', 'HEAD']);
  f.mock.failPush = false;
  const result = await f.engine.sync();
  assert.equal(result.status, 'synced'); assert.deepEqual(f.mock.pushes, [committed]);
  assert.equal(await f.raw(['rev-list', '--count', 'HEAD']), count);
  assert.ok(!(await fsp.readFile(path.join(f.root, '.agent-sync/sync.log'), 'utf8')).includes('credentials'));
});

test('wrong branches and unexpected push URLs are rejected before network access', async t => {
  const f = await fixture(t);
  await f.write('work.txt', 'base'); await f.commit();
  await f.raw(['checkout', '-b', 'research']);
  assert.equal((await f.engine.sync()).reason, 'BRANCH_MUST_BE_MAIN');
  await f.raw(['checkout', 'main']);
  await f.raw(['remote', 'set-url', '--push', 'origin', 'https://github.com/other/Agent.git']);
  assert.equal((await f.engine.sync()).reason, 'ORIGIN_DOES_NOT_MATCH_CONFIGURATION');
  assert.equal(f.mock.network.length, 0);
});

test('every outgoing tree is checked, including an older manually committed revision', async t => {
  const audited = [];
  const f = await fixture(t, { async auditIndex() { return { ok: true }; }, async auditCommit({ commit }) { audited.push(commit); return { ok: true }; } });
  await f.write('work.txt', 'first'); const first = await f.commit();
  await f.write('work.txt', 'second'); const second = await f.commit();
  assert.equal((await f.engine.sync()).status, 'synced');
  assert.deepEqual(audited, [first, second]);
});

test('runtime and credential configuration are confined to the portable folder with tokens removed', async t => {
  const f = await fixture(t);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL']) assert.ok(f.engine.env[key].startsWith(f.root + path.sep));
  assert.equal(f.engine.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(f.engine.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(f.engine.env.GH_TOKEN, undefined); assert.equal(f.engine.env.GITHUB_TOKEN, undefined);
});

test('named pipe prevents duplicate sync and stop targets only the owning service', async t => {
  const f = await fixture(t);
  let stopped = false;
  const server = await serve(f.root, request => { if (request.command === 'stop') stopped = true; return { running: true, stopped }; });
  try {
    assert.deepEqual(await contact(f.root, 'status'), { running: true, stopped: false });
    await assert.rejects(() => serve(f.root, () => ({})), error => error instanceof SyncError && error.reason === 'SYNC_ALREADY_RUNNING');
    assert.deepEqual(await execute('stop', f.root), { running: true, stopped: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('watch filtering ignores runtime trees but keeps user project edits', () => {
  for (const name of ['.git/index', '.agent-sync/sync.log', 'app', 'data', 'data\\ssh\\config', 'app/vscode/Code.exe', 'AutoDL-Research-Hub\\data\\ssh\\config', 'AutoDL-Research-Hub/app/vscode/Code.exe', 'project/__pycache__/x.pyc']) assert.equal(ignoredWatchPath(name), true, name);
  for (const name of ['README.md', 'src/view.js', 'scripts/Start-Hub.ps1', 'AutoDL-Research-Hub/src/view.js', '研究/project.py', 'other/data/results.json', 'application/main.js', 'database/schema.sql']) assert.equal(ignoredWatchPath(name), false, name);
  assert.equal(validOrigin('https://github.com/example-owner/AutoDL-Research-Hub.git', 'example-owner/AutoDL-Research-Hub'), true);
  assert.equal(validOrigin('https://token@github.com/example-owner/AutoDL-Research-Hub.git', 'example-owner/AutoDL-Research-Hub'), false);
});

test('real publication scanner integrates with the engine for accepted text and rejected committed credentials', async t => {
  const f = await fixture(t, require('./safety'));
  await f.write('work.txt', 'ordinary publishable research code');
  assert.equal((await f.engine.sync()).status, 'synced');
  const published = f.mock.remote;
  await f.write('work.txt', ['gh', 'p_', 'C9b8A7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2'].join(''));
  await f.commit();
  const result = await f.engine.sync();
  assert.equal(result.reason, 'PENDING_COMMIT_FAILED_SAFETY_CHECK');
  assert.equal(f.mock.remote, published); assert.equal(f.mock.pushes.length, 1);
});

test('manual staging in the pre-lock gap is preserved and pauses synchronization', async t => {
  const f = await fixture(t);
  await f.write('work.txt', 'initial'); await f.commit();
  await f.write('work.txt', 'automatic change'); await f.write('manual.txt', 'manually staged');
  const original = f.engine.stageAndCommit.bind(f.engine);
  let manualTree;
  f.engine.stageAndCommit = async before => {
    await f.raw(['add', 'manual.txt']);
    manualTree = await f.raw(['write-tree']);
    return original(before);
  };
  const result = await f.engine.sync();
  assert.equal(result.reason, 'USER_STAGED_CHANGES_NEED_REVIEW');
  assert.equal(await f.raw(['write-tree']), manualTree);
  assert.equal(await f.raw(['diff', '--cached', '--name-only']), 'manual.txt');
  assert.equal(f.mock.pushes.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.git/index.lock')), false);
});

test('the real Git index lock blocks a competing git add while the isolated snapshot is audited', async t => {
  let f, competingAdd, originalIndex;
  const safety = {
    async auditIndex(context) {
      assert.notEqual(context.env.GIT_INDEX_FILE, path.join(f.root, '.git/index'));
      assert.ok(context.env.GIT_INDEX_FILE.startsWith(f.root + path.sep));
      assert.ok(fs.existsSync(path.join(f.root, '.git/index.lock')));
      originalIndex = await fsp.readFile(path.join(f.root, '.git/index'));
      await f.write('work.txt', 'new edit during audit');
      competingAdd = await runProcess(GIT, ['add', 'work.txt'], { cwd: f.root, env: f.engine.env });
      assert.notEqual(competingAdd.code, 0, 'another Git writer must see the owned index lock');
      assert.deepEqual(await fsp.readFile(path.join(f.root, '.git/index')), originalIndex);
      return require('./safety').auditIndex(context);
    },
    async auditCommit(context) { return require('./safety').auditCommit(context); }
  };
  f = await fixture(t, safety);
  await f.write('work.txt', 'base'); await f.commit();
  await f.write('work.txt', 'captured for automatic sync');
  assert.equal((await f.engine.sync()).status, 'synced');
  assert.notEqual(competingAdd.code, 0);
  assert.equal(await f.raw(['show', 'HEAD:work.txt']), 'captured for automatic sync');
  assert.equal(await fsp.readFile(path.join(f.root, 'work.txt'), 'utf8'), 'new edit during audit');
  assert.equal(await f.raw(['diff', '--cached', '--name-only']), '');
  assert.equal(await f.raw(['diff', '--name-only']), 'work.txt');
  assert.equal(fs.existsSync(path.join(f.root, '.git/index.lock')), false);
});

test('a writer that bypasses Git locking cannot have its changed index overwritten', async t => {
  let f, manualIndexBytes;
  const safety = {
    async auditIndex() {
      const privateIndex = path.join(f.root, '.agent-sync/temp/manual-test-index');
      await fsp.copyFile(path.join(f.root, '.git/index'), privateIndex);
      const result = await runProcess(GIT, ['add', 'manual.txt'], { cwd: f.root, env: { ...f.engine.env, GIT_INDEX_FILE: privateIndex } });
      assert.equal(result.code, 0);
      manualIndexBytes = await fsp.readFile(privateIndex);
      // Simulate an editor that ignores Git's index.lock protocol.
      await fsp.writeFile(path.join(f.root, '.git/index'), manualIndexBytes);
      return { ok: true };
    },
    async auditCommit() { return { ok: true }; }
  };
  f = await fixture(t, safety);
  await f.write('work.txt', 'base'); const base = await f.commit();
  await f.write('work.txt', 'automatic change'); await f.write('manual.txt', 'manual staging');
  const result = await f.engine.sync();
  assert.equal(result.reason, 'USER_INDEX_CHANGED_DURING_REVIEW');
  assert.deepEqual(await fsp.readFile(path.join(f.root, '.git/index')), manualIndexBytes);
  assert.equal(await f.raw(['rev-parse', 'HEAD']), base);
  assert.equal(await f.raw(['diff', '--cached', '--name-only']), 'manual.txt');
  assert.equal(f.mock.pushes.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.git/index.lock')), false);
});
