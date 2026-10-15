'use strict';

// No shell strings, tokens, or project contents are written to the journal.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const core = require('../src/core');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const MAX_OUTPUT = 8 * 1024 * 1024;
const LOG_BYTES = 1024 * 1024;
class SyncError extends Error {
  constructor(reason, details = {}) { super(reason); this.reason = reason; this.details = details; }
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function assertRoot(root) {
  root = path.resolve(root);
  try { core.assertEPath(root); } catch { throw new SyncError('ROOT_MUST_BE_A_LOCAL_APPLICATION_FOLDER'); }
  if (path.parse(root).root.toLowerCase() === root.toLowerCase()) throw new SyncError('ROOT_MUST_BE_A_LOCAL_APPLICATION_FOLDER');
  if (fs.lstatSync(root).isSymbolicLink() || !samePath(fs.realpathSync(root), root)) {
    throw new SyncError('ROOT_MUST_NOT_BE_A_LINK');
  }
  return root;
}
function safeDirectory(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new SyncError('INVALID_RUNTIME_PATH');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (fs.lstatSync(current).isSymbolicLink() || !samePath(fs.realpathSync(current), current)) {
      throw new SyncError('RUNTIME_DIRECTORY_MUST_NOT_BE_A_LINK');
    }
  }
  return target;
}
function safeFile(file) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) {
    throw new SyncError('RUNTIME_FILE_MUST_NOT_BE_A_LINK');
  }
}
function loadConfig(root) {
  const file = path.join(root, '.agent-sync', 'config.json');
  safeFile(file);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new SyncError('CONFIG_UNAVAILABLE'); }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository || '') || config.branch !== 'main') {
    throw new SyncError('CONFIG_REPOSITORY_OR_BRANCH_INVALID');
  }
  for (const key of ['gitExe', 'ghExe']) {
    const relative = key === 'gitExe' ? 'app/git/cmd/git.exe' : 'app/gh/bin/gh.exe';
    const configured = config[key] || relative;
    const candidate = path.isAbsolute(configured) ? configured : path.resolve(root, configured);
    try {
      core.assertEPath(candidate, { within: root });
      if (!fs.statSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) throw Error('Invalid tool');
    } catch { throw new SyncError('CONFIG_TOOL_PATH_INVALID'); }
    config[key] = candidate;
  }
  if (config.pushTimeoutSeconds !== undefined && (!Number.isInteger(config.pushTimeoutSeconds) || config.pushTimeoutSeconds < 30 || config.pushTimeoutSeconds > 3600)) throw new SyncError('CONFIG_PUSH_TIMEOUT_INVALID');
  if (config.proxyUrl) {
    let url;
    try { url = new URL(config.proxyUrl); } catch { throw new SyncError('CONFIG_PROXY_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new SyncError('CONFIG_PROXY_MUST_BE_LOCAL');
    }
  }
  return config;
}
function makeEnvironment(root, config) {
  const privateDir = safeDirectory(root, '.agent-sync/private');
  const home = safeDirectory(root, '.agent-sync/private/home');
  const temp = safeDirectory(root, '.agent-sync/temp');
  const gh = safeDirectory(root, '.agent-sync/private/gh');
  const appData = safeDirectory(root, '.agent-sync/private/appdata');
  const localAppData = safeDirectory(root, '.agent-sync/private/localappdata');
  const hooks = safeDirectory(root, '.agent-sync/private/empty-hooks');
  const globalConfig = path.join(privateDir, 'gitconfig');
  safeFile(globalConfig);
  const env = { ...process.env };
  // Do not inherit an alternate repository/index or token from the launching app.
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_.*)?|TRACE.*|ASKPASS|SSH.*)$/i.test(key) || /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key) || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(root).root.slice(0, 2), HOMEPATH: home.slice(2), APPDATA: appData, LOCALAPPDATA: localAppData,
    TEMP: temp, TMP: temp, TMPDIR: temp, XDG_CONFIG_HOME: appData, XDG_CACHE_HOME: localAppData,
    GH_CONFIG_DIR: gh, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0',
    PATH: `${path.dirname(config.ghExe)};${path.dirname(config.gitExe)};${process.env.PATH || ''}`
  });
  if (config.proxyUrl) Object.assign(env, { HTTP_PROXY: config.proxyUrl, HTTPS_PROXY: config.proxyUrl, ALL_PROXY: config.proxyUrl });
  return { env, hooks };
}
function runProcess(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: options.cwd, env: options.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = []; let size = 0, finished = false, failure;
    const timer = setTimeout(() => { failure = new SyncError('GIT_OPERATION_TIMED_OUT'); child.kill(); }, options.timeoutMs || 60000);
    function collect(chunks, chunk) {
      size += chunk.length;
      if (size > MAX_OUTPUT) { failure = new SyncError('GIT_OUTPUT_LIMIT_EXCEEDED'); child.kill(); }
      else chunks.push(chunk);
    }
    child.stdout.on('data', chunk => collect(out, chunk));
    child.stderr.on('data', chunk => collect(err, chunk));
    child.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); reject(new SyncError('GIT_PROCESS_COULD_NOT_START')); } });
    child.on('close', code => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}
function validOrigin(origin, repository) {
  return origin.trim().toLowerCase().replace(/\.git$/, '') === `https://github.com/${repository}`.toLowerCase();
}
function ignoredWatchPath(name) {
  if (!name) return false;
  const normalized = String(name).replace(/\\/g, '/');
  return /(^|\/)(?:\.git|\.agent-sync|__pycache__)(\/|$)/i.test(normalized) || /^(?:AutoDL-Research-Hub\/)?(?:app|data)(\/|$)/i.test(normalized);
}
function pipeName(root) { return `\\\\.\\pipe\\agent-github-sync-${crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}`; }

class Engine {
  constructor(root, config, dependencies = {}) {
    this.root = assertRoot(root); this.config = config;
    this.runtime = safeDirectory(root, '.agent-sync');
    const isolated = makeEnvironment(root, config);
    this.env = isolated.env; this.hooks = isolated.hooks;
    this.runner = dependencies.runner || runProcess;
    this.safety = dependencies.safety || require('./safety');
    this.state = { version: 1, repository: config.repository, branch: config.branch };
    try {
      const previous = JSON.parse(fs.readFileSync(path.join(this.runtime, 'status.json'), 'utf8'));
      if (previous.repository === config.repository) {
        for (const key of ['lastSuccessAt', 'lastCommit']) if (typeof previous[key] === 'string') this.state[key] = previous[key];
      }
    } catch { /* No previous state. */ }
    this.running = false;
    this.recordQueue = Promise.resolve();
  }
  async git(args, allowed = [0], env = this.env) {
    const options = [
      '-c', `core.hooksPath=${this.hooks}`, '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-c', 'credential.interactive=false',
      '-c', 'core.askPass=', '-c', 'submodule.recurse=false'
    ];
    if (this.config.proxyUrl) options.push('-c', `http.proxy=${this.config.proxyUrl}`);
    const timeoutMs = args[0] === 'push' ? (this.config.pushTimeoutSeconds || 180) * 1000 : 60000;
    const result = await this.runner(this.config.gitExe, [...options, ...args], { cwd: this.root, env, timeoutMs });
    if (!allowed.includes(result.code)) throw new SyncError('GIT_OPERATION_FAILED', { operation: args[0] });
    return result;
  }
  record(status, extra = {}) {
    const task = this.recordQueue.then(() => this.writeRecord(status, extra));
    this.recordQueue = task.catch(() => {});
    return task;
  }
  async writeRecord(status, extra = {}) {
    const state = { ...this.state, ...extra, status, updatedAt: new Date().toISOString() };
    this.state = state;
    const target = path.join(this.runtime, 'status.json');
    const temporary = path.join(this.runtime, `status.${process.pid}.tmp`);
    safeFile(target); safeFile(temporary);
    await fsp.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, target);
    const log = path.join(this.runtime, 'sync.log'); safeFile(log);
    let bytes = 0; try { bytes = (await fsp.stat(log)).size; } catch { /* New log. */ }
    if (bytes >= LOG_BYTES) {
      const previous = log + '.1'; safeFile(previous);
      await fsp.rm(previous, { force: true }); await fsp.rename(log, previous);
    }
    await fsp.appendFile(log, JSON.stringify({ time: state.updatedAt, status, reason: extra.reason || null, operation: extra.operation || null, findings: extra.findings || 0 }) + '\n', { mode: 0o600 });
    return state;
  }
  async verifyRepository(ownsIndexLock = false) {
    assertRoot(this.root);
    const gitDir = path.join(this.root, '.git');
    if (!fs.existsSync(gitDir) || !fs.lstatSync(gitDir).isDirectory() || fs.lstatSync(gitDir).isSymbolicLink()) throw new SyncError('EXPECTED_STANDALONE_GIT_REPOSITORY');
    const top = (await this.git(['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!samePath(top, this.root)) throw new SyncError('WRONG_GIT_ROOT');
    if ((await this.git(['rev-parse', '--is-shallow-repository'])).stdout.trim() !== 'false' || fs.existsSync(path.join(gitDir, 'info', 'grafts'))) throw new SyncError('COMPLETE_UNMODIFIED_HISTORY_REQUIRED');
    const branch = (await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).stdout.trim();
    if (branch !== 'main') throw new SyncError('BRANCH_MUST_BE_MAIN');
    const fetchUrls = (await this.git(['remote', 'get-url', '--all', 'origin'])).stdout.trim().split(/\r?\n/);
    const pushUrls = (await this.git(['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split(/\r?\n/);
    if (fetchUrls.length !== 1 || pushUrls.length !== 1 || !validOrigin(fetchUrls[0], this.config.repository) || !validOrigin(pushUrls[0], this.config.repository)) throw new SyncError('ORIGIN_DOES_NOT_MATCH_CONFIGURATION');
    for (const sentinel of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
      if (sentinel === 'index.lock' && ownsIndexLock) continue;
      if (fs.existsSync(path.join(gitDir, sentinel))) throw new SyncError('GIT_OPERATION_ALREADY_IN_PROGRESS');
    }
  }
  async head() { return (await this.git(['rev-parse', '--verify', 'HEAD'], [0, 128])).stdout.trim(); }
  async remoteHead() {
    const response = await this.git(['ls-remote', '--heads', 'origin', 'refs/heads/main']);
    const line = response.stdout.trim();
    if (!line) return null;
    if (!/^[a-f0-9]{40,64}\s+refs\/heads\/main$/i.test(line)) throw new SyncError('REMOTE_HEAD_RESPONSE_INVALID');
    return line.split(/\s/)[0];
  }
  async auditPending(remote, checked) {
    const head = await this.head(); if (!head) return [];
    const list = (await this.git(['rev-list', '--reverse', remote ? `${remote}..${head}` : head])).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (list.length > 1000) throw new SyncError('TOO_MANY_PENDING_COMMITS_FOR_AUTOMATIC_REVIEW');
    for (const commit of list) {
      if (checked.has(commit)) continue;
      const audit = await this.safety.auditCommit({ root: this.root, gitExe: this.config.gitExe, env: this.env, commit });
      if (!audit || !audit.ok) throw new SyncError('PENDING_COMMIT_FAILED_SAFETY_CHECK', { findings: audit?.findings?.length || 1 });
      checked.add(commit);
    }
    return list;
  }
  async stageAndCommit(before) {
    const index = path.join(this.root, '.git', 'index');
    const lockPath = index + '.lock';
    const temporary = path.join(this.runtime, 'temp', `index-${crypto.randomUUID()}`);
    const temporaryEnv = { ...this.env, GIT_INDEX_FILE: temporary };
    let lock, ownedIdentity, installed = false;
    const snapshot = async () => {
      safeFile(index);
      try {
        const data = await fsp.readFile(index);
        return { data, hash: crypto.createHash('sha256').update(data).digest('hex') };
      } catch (error) {
        if (error.code === 'ENOENT') return { data: null, hash: null };
        throw error;
      }
    };
    const ownsLock = async () => {
      try {
        const current = await fsp.lstat(lockPath);
        return !current.isSymbolicLink() && current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino;
      } catch { return false; }
    };
    try {
      try { lock = await fsp.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new SyncError('GIT_OPERATION_ALREADY_IN_PROGRESS');
        throw error;
      }
      ownedIdentity = await lock.stat();
      // Git writers now see the real lock. Recheck staging under that lock,
      // then operate exclusively on our portable private index snapshot.
      await this.verifyRepository(true);
      if ((await this.head()) !== before) throw new SyncError('LOCAL_HEAD_CHANGED_DURING_CHECK');
      if ((await this.git(['diff', '--cached', '--quiet', '--exit-code'], [0, 1])).code !== 0) throw new SyncError('USER_STAGED_CHANGES_NEED_REVIEW');
      const original = await snapshot();
      if (original.data) await fsp.writeFile(temporary, original.data, { flag: 'wx', mode: 0o600 });
      await this.git(['add', '-A', '--', '.'], [0], temporaryEnv);
      const tree = (await this.git(['write-tree'], [0], temporaryEnv)).stdout.trim();
      const audit = await this.safety.auditIndex({ root: this.root, gitExe: this.config.gitExe, env: temporaryEnv });
      if (!audit || !audit.ok) throw new SyncError('STAGED_CONTENT_FAILED_SAFETY_CHECK', { findings: audit?.findings?.length || 1 });
      if ((await this.git(['write-tree'], [0], temporaryEnv)).stdout.trim() !== tree || (await this.head()) !== before) throw new SyncError('INDEX_OR_HEAD_CHANGED_DURING_REVIEW');
      if (!(await ownsLock()) || (await snapshot()).hash !== original.hash) throw new SyncError('USER_INDEX_CHANGED_DURING_REVIEW');
      const changes = (await this.git(['diff', '--cached', '--quiet', '--exit-code'], [0, 1], temporaryEnv)).code !== 0;
      if (!changes) return;
      await this.verifyRepository(true);
      await this.record('committing', { reason: null });
      await this.git(['commit', '--quiet', '-m', `chore: sync Agent ${new Date().toISOString()}`], [0], temporaryEnv);
      // A non-Git writer must not cause us to overwrite a changed user index.
      // On failure the original index remains intact; no reset is attempted.
      if (!(await ownsLock()) || (await snapshot()).hash !== original.hash) throw new SyncError('USER_INDEX_CHANGED_DURING_REVIEW');
      if ((await this.git(['rev-parse', 'HEAD^{tree}'])).stdout.trim() !== tree) throw new SyncError('LOCAL_HEAD_CHANGED_BEFORE_INDEX_INSTALL');
      const result = await fsp.readFile(temporary);
      await lock.truncate(0);
      await lock.writeFile(result);
      await lock.sync();
      await lock.close(); lock = null;
      // Renaming the still-owned Git lock publishes the index atomically and
      // releases the lock in the same operation, following Git's lock protocol.
      await fsp.rename(lockPath, index);
      installed = true;
    } finally {
      if (lock) await lock.close();
      if (!installed && ownedIdentity && await ownsLock()) await fsp.unlink(lockPath);
      // These UUID paths belong only to this transaction, never to a user index.
      await fsp.rm(temporary, { force: true });
      await fsp.rm(temporary + '.lock', { force: true });
    }
  }
  async sync() {
    if (this.running) return this.state;
    this.running = true;
    try {
      await this.record('checking', { reason: null, operation: null, findings: 0 });
      await this.verifyRepository();
      if ((await this.git(['diff', '--cached', '--quiet', '--exit-code'], [0, 1])).code !== 0) throw new SyncError('USER_STAGED_CHANGES_NEED_REVIEW');
      if ((await this.git(['ls-files', '--unmerged'])).stdout.trim()) throw new SyncError('UNMERGED_FILES_NEED_REVIEW');
      const before = await this.head();
      const remote = await this.remoteHead();
      if (remote) {
        await this.git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
        const fetched = (await this.git(['rev-parse', 'refs/remotes/origin/main'])).stdout.trim();
        if (fetched !== remote) throw new SyncError('REMOTE_CHANGED_DURING_CHECK');
        if (!before || (await this.git(['merge-base', '--is-ancestor', remote, before], [0, 1])).code !== 0) throw new SyncError('REMOTE_AHEAD_OR_DIVERGED');
      } else {
        const branches = (await this.git(['ls-remote', '--heads', 'origin'])).stdout.trim();
        if (branches) throw new SyncError('REMOTE_MAIN_BRANCH_MISSING');
      }
      // A clean, already-published tree was checked before its original push.
      // Avoid re-reading gigabytes of unchanged research material every minute.
      const dirty = (await this.git(['status', '--porcelain=v1', '--untracked-files=normal'])).stdout.length > 0;
      if (!dirty && before === remote) {
        return await this.record('synced', { reason: null, lastCommit: before || null, pendingCommits: 0, lastSuccessAt: new Date().toISOString() });
      }
      const checked = new Set();
      await this.auditPending(remote, checked);
      // Recheck immediately before staging; never clear another person's index.
      await this.verifyRepository();
      if ((await this.head()) !== before) throw new SyncError('LOCAL_HEAD_CHANGED_DURING_CHECK');
      if ((await this.git(['diff', '--cached', '--quiet', '--exit-code'], [0, 1])).code !== 0) throw new SyncError('USER_STAGED_CHANGES_NEED_REVIEW');
      if (dirty) {
        await this.stageAndCommit(before);
      }
      const commits = await this.auditPending(remote, checked);
      const head = await this.head();
      if (head && head !== remote) {
        await this.verifyRepository();
        if (await this.remoteHead() !== remote) throw new SyncError('REMOTE_CHANGED_BEFORE_PUSH');
        if (await this.head() !== head) throw new SyncError('LOCAL_HEAD_CHANGED_BEFORE_PUSH');
        await this.record('pushing', { reason: null, pendingCommits: commits.length });
        // Pin the reviewed commit so a simultaneous manual commit cannot bypass auditing.
        await this.git(['push', 'origin', `${head}:refs/heads/main`]);
      }
      return await this.record('synced', { reason: null, lastCommit: head || null, pendingCommits: 0, lastSuccessAt: new Date().toISOString() });
    } catch (error) {
      return await this.record('paused', { reason: error instanceof SyncError ? error.reason : 'SAFETY_CHECK_OR_RUNTIME_ERROR', ...(error instanceof SyncError ? error.details : {}) });
    } finally { this.running = false; }
  }
}

function contact(root, command) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipeName(root)); let data = '', finished = false;
    function finish(value) { if (!finished) { finished = true; socket.destroy(); resolve(value); } }
    socket.setTimeout(2000, () => finish(null)); socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 65536) return finish(null);
      if (data.includes('\n')) { try { finish(JSON.parse(data.split('\n')[0])); } catch { finish(null); } }
    });
    socket.on('end', () => finish(null));
  });
}
async function serve(root, onRequest) {
  const server = net.createServer(socket => {
    let text = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      text += chunk.toString('utf8');
      if (text.length > 1024) { socket.destroy(); return; }
      if (text.includes('\n')) {
        let request; try { request = JSON.parse(text.split('\n')[0]); } catch { socket.destroy(); return; }
        Promise.resolve(onRequest(request)).then(response => socket.end(JSON.stringify(response) + '\n')).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new SyncError('SYNC_ALREADY_RUNNING')));
    server.listen(pipeName(root), resolve);
  });
  return server;
}
async function execute(command, root = DEFAULT_ROOT, dependencies = {}) {
  root = assertRoot(root);
  if (command === 'status' || command === 'stop') {
    const live = await contact(root, command);
    if (live) return live;
    let state = null; try { state = JSON.parse(fs.readFileSync(path.join(root, '.agent-sync', 'status.json'), 'utf8')); } catch { /* No state. */ }
    return { running: false, state };
  }
  if (!['once', 'watch'].includes(command)) throw new SyncError('USE_ONCE_WATCH_STATUS_OR_STOP');
  const config = dependencies.config || loadConfig(root);
  const engine = new Engine(root, config, dependencies);
  let stopping = false, watcher, debounce, interval;
  let finishWatch;
  const stopped = new Promise(resolve => { finishWatch = resolve; });
  const server = await serve(root, request => {
    if (request.command === 'stop') {
      if (command === 'watch') {
        stopping = true; watcher?.close(); clearTimeout(debounce); clearInterval(interval);
        // Allow an already-reviewed commit/push to finish; never kill by a saved PID.
        finishWatch();
      }
      return { running: true, stopping, mode: command, state: engine.state };
    }
    return { running: true, stopping, mode: command, state: engine.state };
  });
  const sync = () => stopping ? Promise.resolve(engine.state) : engine.sync();
  let active = Promise.resolve();
  const startSync = () => {
    if (!engine.running && !stopping) active = sync().catch(() => {
      // A runtime write failure cannot be reported safely to the journal; stop
      // this owned watcher and let the foreground command report a generic error.
      stopFromSignal();
      throw new SyncError('SYNC_RUNTIME_STATE_UNAVAILABLE');
    });
  };
  const stopFromSignal = () => { stopping = true; watcher?.close(); clearTimeout(debounce); clearInterval(interval); finishWatch(); };
  try {
    if (command === 'once') return await engine.sync();
    process.once('SIGINT', stopFromSignal); process.once('SIGTERM', stopFromSignal);
    const watchUnavailable = () => {
      void engine.record('watch-fallback', { reason: 'FILE_WATCH_UNAVAILABLE_USING_60_SECOND_POLL' }).catch(stopFromSignal);
    };
    try {
      watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        if (ignoredWatchPath(name) || stopping) return;
        clearTimeout(debounce); debounce = setTimeout(startSync, 30000);
      });
      watcher.on('error', watchUnavailable);
    } catch { await engine.record('watch-fallback', { reason: 'FILE_WATCH_UNAVAILABLE_USING_60_SECOND_POLL' }); }
    interval = setInterval(startSync, 60000);
    startSync();
    await stopped;
    await active;
    return await engine.record('stopped', { reason: null });
  } finally {
    watcher?.close(); clearTimeout(debounce); clearInterval(interval);
    process.removeListener('SIGINT', stopFromSignal); process.removeListener('SIGTERM', stopFromSignal);
    await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const root = rest.length === 2 && rest[0] === '--root' ? rest[1] : DEFAULT_ROOT;
  if (rest.length && !(rest.length === 2 && rest[0] === '--root')) {
    process.stderr.write('USE: node github-sync/sync.js once|watch|status|stop [--root <portable-folder>]\n'); process.exitCode = 2;
  } else {
    execute(command, root).then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (result.status === 'paused') process.exitCode = 1;
    }).catch(error => { process.stderr.write((error instanceof SyncError ? error.reason : 'SYNC_RUNTIME_ERROR') + '\n'); process.exitCode = 1; });
  }
}
module.exports = { Engine, SyncError, execute, runProcess, makeEnvironment, loadConfig, ignoredWatchPath, validOrigin, assertRoot, contact, serve, pipeName };
