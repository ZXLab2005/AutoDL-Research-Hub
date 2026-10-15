'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const core = require('./core');

// Sent over the existing verified SSH connection's stdin. Nothing is installed
// on the server; the scanner reads directory/stat metadata, never file contents.
const REMOTE_WATCH_SCRIPT = String.raw`import os, sys, stat, time, json, datetime, signal

EXCLUDED = {'.git', '__pycache__', '.venv', 'venv', 'env', 'envs', 'node_modules',
            '.cache', 'cache', 'caches', '.mypy_cache', '.pytest_cache', '.ruff_cache',
            '.ipynb_checkpoints', '.tox', '.nox', 'site-packages'}

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def scan(root, limit=10000, budget=1.5):
    root = os.path.abspath(root)
    result = {'entries': {}, 'filesCount': 0, 'directoriesCount': 0,
              'scannedEntries': 0, 'complete': True, 'truncated': False, 'errors': 0}
    deadline = time.monotonic() + budget
    if os.path.realpath(root) != root or os.path.islink(root):
        result.update(complete=False, errors=1, rootError='symlink')
        return result
    # On Linux openat + O_NOFOLLOW closes directory-symlink replacement races.
    # The guarded path fallback makes the same scanner testable on Windows.
    use_fd = os.scandir in os.supports_fd and os.open in os.supports_dir_fd
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    root_fd = None
    try:
        if use_fd:
            root_fd = os.open('/', flags)
            for component in root.split('/'):
                if not component:
                    continue
                child = os.open(component, flags, dir_fd=root_fd)
                os.close(root_fd)
                root_fd = child
        elif not os.path.isdir(root):
            raise OSError('missing root')
    except OSError:
        if root_fd is not None:
            os.close(root_fd)
        result.update(complete=False, errors=1, rootError='unavailable')
        return result

    def visit(directory, relative):
        if time.monotonic() > deadline:
            result.update(complete=False, truncated=True)
            return
        try:
            with os.scandir(directory) as items:
                for entry in items:
                    if entry.name in EXCLUDED:
                        continue
                    if result['scannedEntries'] >= limit or time.monotonic() > deadline:
                        result.update(complete=False, truncated=True)
                        return
                    result['scannedEntries'] += 1
                    rel = relative + '/' + entry.name if relative else entry.name
                    try:
                        info = entry.stat(follow_symlinks=False)
                        kind = ('symlink' if stat.S_ISLNK(info.st_mode) else
                                'directory' if stat.S_ISDIR(info.st_mode) else 'file')
                        record = {'path': rel, 'kind': kind, 'size': info.st_size,
                                  'mtimeMs': info.st_mtime_ns // 1000000,
                                  '_mtimeNs': info.st_mtime_ns, '_inode': info.st_ino}
                        result['entries'][rel] = record
                        if kind == 'directory':
                            result['directoriesCount'] += 1
                            if rel.count('/') >= 64:
                                result.update(complete=False, truncated=True)
                                return
                            child_fd = None
                            try:
                                if use_fd:
                                    child_fd = os.open(entry.name, flags, dir_fd=directory)
                                    visit(child_fd, rel)
                                else:
                                    child = os.path.join(directory, entry.name)
                                    if os.path.realpath(child) != os.path.abspath(child):
                                        raise OSError('directory changed to symlink')
                                    visit(child, rel)
                            finally:
                                if child_fd is not None:
                                    os.close(child_fd)
                            if result['truncated']:
                                return
                        else:
                            result['filesCount'] += 1
                    except OSError:
                        result['errors'] += 1
                        result['complete'] = False
        except OSError:
            result['errors'] += 1
            result['complete'] = False
    try:
        visit(root_fd if use_fd else root, '')
    finally:
        if root_fd is not None:
            os.close(root_fd)
    return result

def public(entry):
    return {k: v for k, v in entry.items() if not k.startswith('_')}

def summarize(snapshot):
    return {k: v for k, v in snapshot.items() if k != 'entries'}

def event_for(previous, current, root, batch=200):
    event = dict(summarize(current), timestamp=stamp(), root=root)
    if previous is None:
        latest = sorted(current['entries'].values(), key=lambda item: item['_mtimeNs'], reverse=True)[:10]
        event.update(type='baseline', latest=[public(item) for item in latest])
    elif not current['complete']:
        # A partial scan is not evidence of deletion. Do not advance the baseline
        # or report potentially repeated additions until a complete scan returns.
        event.update(type='scan', changes=[], counts={'added': 0, 'modified': 0, 'deleted': 0}, omittedChanges=0)
    else:
        changes = []
        counts = {'added': 0, 'modified': 0, 'deleted': 0}
        old = previous['entries']
        new = current['entries']
        def append(kind, item):
            counts[kind] += 1
            if len(changes) < batch:
                changes.append(dict(public(item), type=kind))
        for name, item in new.items():
            if name not in old:
                append('added', item)
            elif (item['kind'] != old[name]['kind'] or
                  (item['kind'] != 'directory' and
                   (item['size'], item['_mtimeNs'], item['_inode']) !=
                   (old[name]['size'], old[name]['_mtimeNs'], old[name]['_inode']))):
                append('modified', item)
        for name, item in old.items():
            if name not in new:
                append('deleted', item)
        total = sum(counts.values())
        event.update(type='change' if total else 'scan', changes=changes,
                     counts=counts, omittedChanges=max(0, total-len(changes)))
    return event

def main():
    root = sys.argv[1]
    interval = max(3, min(60, int(sys.argv[2])))
    limit = max(10, min(10000, int(sys.argv[3])))
    previous = None
    for signum in (signal.SIGTERM, getattr(signal, 'SIGHUP', signal.SIGTERM)):
        signal.signal(signum, lambda signum, frame: sys.exit(0))
    try:
        while True:
            current = scan(root, limit)
            event = event_for(previous, current, root)
            print(json.dumps(event, ensure_ascii=True, separators=(',', ':')), flush=True)
            if current['complete']:
                previous = current
            time.sleep(interval)
    except (BrokenPipeError, KeyboardInterrupt):
        # A dropped SSH channel ends this read-only watcher; no server daemon.
        os._exit(0)

if __name__ == '__main__':
    main()
`;

function createLineParser(onValue, onError, options = {}) {
  const decoder = new StringDecoder('utf8');
  const maxBytes = options.maxBytes || 1024 * 1024;
  let pending = '', failed = false;
  const fail = message => { if (!failed) { failed = true; onError(new Error(message)); } };
  const append = text => {
    if (failed) return;
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > maxBytes) return fail('Watcher output exceeded its line limit.');
      let value;
      try { value = JSON.parse(line); } catch { return fail('Watcher returned invalid JSON.'); }
      onValue(value);
      if (failed) return;
    }
    if (Buffer.byteLength(pending, 'utf8') > maxBytes) fail('Watcher output exceeded its line limit.');
  };
  return {
    write(chunk) { append(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
    end() { append(decoder.end()); if (pending.trim() && !failed) fail('Watcher output ended inside a JSON line.'); },
  };
}

function normalizeSsh(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#')).join('\n');
}

function validateSnapshot(root, input) {
  const config = core.validateConfig(input);
  const paths = core.getPaths(root);
  if (!config.identityFile) throw Error('请先配置平台 SSH 私钥。');
  const saved = core.readConfig(root);
  if (Object.keys(config).some(key => saved[key] !== config[key])) {
    throw Error('连接设置已变化，请保存连接后重新开始监视。');
  }
  if (normalizeSsh(fs.readFileSync(paths.sshConfig, 'utf8')) !== normalizeSsh(core.renderSshConfig(root, config))) {
    throw Error('SSH 设置与研究台保存的连接不一致，请重新保存并检查连接。');
  }
  if (!fs.existsSync(config.identityFile) || !fs.existsSync(paths.knownHosts) || fs.statSync(paths.knownHosts).size === 0) {
    throw Error('请先完成免密 SSH 和服务器指纹检查。');
  }
  return { config, paths };
}

function buildWatchArgs(paths, config, interval = 3, maxEntries = 10000) {
  config = core.validateConfig(config);
  if (!Number.isInteger(interval) || interval < 3 || interval > 60 ||
      !Number.isInteger(maxEntries) || maxEntries < 10 || maxEntries > 10000) throw Error('Invalid watch limits.');
  return [
    '-F', paths.sshConfig, '-T', '-o', `HostName=${config.host}`, '-p', String(config.port), '-l', config.user,
    '-i', config.identityFile, '-o', `UserKnownHostsFile="${paths.knownHosts.replace(/\\/g, '/')}"`,
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=1', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'AddKeysToAgent=no', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none',
    '-o', 'RequestTTY=no', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    'autodl-research', `python3 -u -B - '${config.remotePath}' ${interval} ${maxEntries}`,
  ];
}

function validateEvent(value, expectedRoot) {
  if (!value || typeof value !== 'object' || !['baseline', 'change', 'scan'].includes(value.type)
      || value.root !== expectedRoot || typeof value.timestamp !== 'string'
      || !Number.isFinite(Date.parse(value.timestamp)) || typeof value.complete !== 'boolean'
      || typeof value.truncated !== 'boolean') return false;
  for (const name of ['filesCount', 'directoriesCount', 'scannedEntries', 'errors']) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 10001) return false;
  }
  const items = value.type === 'baseline' ? value.latest : value.changes;
  if (!Array.isArray(items) || items.length > (value.type === 'baseline' ? 10 : 200)) return false;
  for (const item of items) {
    if (!item || typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.length > 4096
        || item.path.split('/').some(part => !part || part === '.' || part === '..')
        || !['file', 'directory', 'symlink'].includes(item.kind)
        || !Number.isFinite(item.size) || item.size < 0 || !Number.isFinite(item.mtimeMs)
        || (value.type !== 'baseline' && !['added', 'modified', 'deleted'].includes(item.type))) return false;
  }
  return true;
}

function watchLockName(root, config) {
  const digest = crypto.createHash('sha256').update(JSON.stringify([
    core.assertEPath(root).toLowerCase(), config.host, config.port, config.user, config.remotePath,
  ])).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\autodl-research-watch-${digest}`;
}

/** One owned SSH process per saved project, only while its UI requests it. */
function startWatch(root, input, callbacks = {}, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const makeServer = dependencies.createServer || net.createServer;
  const load = dependencies.validateSnapshot || validateSnapshot;
  const delay = dependencies.setTimeout || setTimeout;
  const cancelDelay = dependencies.clearTimeout || clearTimeout;
  let stopped = false, child = null, lock = null, timer = null, watchdog = null, stopPromise;
  let retries = 0, generation = 0, hadOutput = false;
  const safeCall = (name, value) => { if (!stopped && typeof callbacks[name] === 'function') callbacks[name](value); };
  const status = (state, message, extra = {}) => safeCall('onStatus', { state, message, timestamp: new Date().toISOString(), ...extra });
  const clearTimers = () => {
    if (timer) { cancelDelay(timer); timer = null; }
    if (watchdog) { cancelDelay(watchdog); watchdog = null; }
  };
  const closeLock = () => {
    const owned = lock;
    lock = null;
    if (!owned) return Promise.resolve();
    return new Promise(resolve => { try { owned.close(resolve); } catch { resolve(); } });
  };
  const controller = {
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      generation += 1;
      clearTimers();
      const owned = child;
      child = null;
      stopPromise = Promise.all([
        closeLock(),
        new Promise(resolve => {
          if (!owned || owned.exitCode !== null || owned.signalCode !== null) return resolve();
          let finishTimer;
          const finish = () => { if (finishTimer) clearTimeout(finishTimer); resolve(); };
          owned.once('close', finish);
          finishTimer = setTimeout(finish, 2000);
          finishTimer.unref?.();
          try { owned.kill(); } catch { finish(); }
        }),
      ]).then(() => undefined);
      return stopPromise;
    },
  };
  let snapshot;
  try { snapshot = load(root, input); }
  catch (error) { queueMicrotask(() => status('error', error.message)); return controller; }
  const connect = () => {
    if (stopped) return;
    // Re-read saved configuration before reconnecting; never monitor an old target.
    try { snapshot = load(root, snapshot.config); }
    catch (error) { status('error', error.message); closeLock(); return; }
    const { config, paths } = snapshot;
    const current = ++generation;
    let owned, closing = false;
    hadOutput = false;
    status('connecting', '正在连接服务器文件监视器…', { attempt: retries + 1 });
    const fail = () => {
      if (stopped || current !== generation || closing) return;
      closing = true;
      try { owned?.kill(); } catch { /* Only our own child is terminated. */ }
    };
    const armWatchdog = milliseconds => {
      if (watchdog) cancelDelay(watchdog);
      watchdog = delay(fail, milliseconds);
      watchdog.unref?.();
    };
    const parser = createLineParser(value => {
      if (stopped || current !== generation || closing) return;
      if (!validateEvent(value, config.remotePath)) return fail();
      if (!hadOutput) { retries = 0; hadOutput = true; }
      armWatchdog(20000);
      status(value.complete ? 'watching' : 'partial', value.rootError
        ? '项目目录不可用或包含符号链接；未推断任何删除。'
        : value.complete ? '正在监视远端项目目录。' : '部分目录暂时无法扫描或超过扫描上限；未推断任何删除。', {
        lastScanAt: value.timestamp, filesCount: value.filesCount, directoriesCount: value.directoriesCount,
        complete: value.complete, truncated: value.truncated,
      });
      safeCall('onEvent', value);
    }, fail);
    try {
      const sshExe = core.getSshExecutable(root);
      owned = spawnProcess(sshExe, buildWatchArgs(paths, config), {
        cwd: paths.root, env: { ...process.env, ...core.buildStorageEnv(root, config) },
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = owned;
      owned.stdout.on('data', chunk => parser.write(chunk));
      // SSH diagnostics can contain arbitrary remote banners: never persist or
      // forward them to the UI. The exit/status path reports a fixed message.
      owned.stderr.on('data', () => {});
      owned.stdin.on('error', fail);
      owned.once('error', fail);
      owned.once('close', code => {
        if (stopped || current !== generation) return;
        parser.end();
        child = null;
        if (watchdog) { cancelDelay(watchdog); watchdog = null; }
        if (retries >= 5) {
          status('error', '文件监视连接多次失败，请检查 SSH 后重新打开实时监视。');
          closeLock();
          return;
        }
        const seconds = Math.min(30, 2 ** (retries + 1));
        retries += 1;
        status('retrying', '文件监视连接中断；正在等待重新连接。', { nextRetrySeconds: seconds, exitCode: Number.isInteger(code) ? code : null });
        timer = delay(() => { timer = null; connect(); }, seconds * 1000);
        timer.unref?.();
      });
      armWatchdog(45000);
      owned.stdin.end(REMOTE_WATCH_SCRIPT);
    } catch {
      fail();
      if (!owned) { status('error', '无法启动文件监视 SSH 客户端。'); closeLock(); }
    }
  };
  queueMicrotask(() => {
    if (stopped) return;
    lock = makeServer(socket => socket.destroy());
    lock.once('error', error => {
      if (stopped) return;
      status(error.code === 'EADDRINUSE' ? 'busy' : 'error', error.code === 'EADDRINUSE'
        ? '另一个研究台窗口正在监视这个目录。关闭其监视后可在此重试。' : '无法建立本机文件监视锁。');
      closeLock();
    });
    lock.listen(watchLockName(root, snapshot.config), connect);
  });
  return controller;
}

module.exports = { REMOTE_WATCH_SCRIPT, createLineParser, buildWatchArgs, validateEvent, validateSnapshot, watchLockName, startWatch };
