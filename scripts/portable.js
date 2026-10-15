'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('../src/core');
const win = path.win32;

function layout(root) {
  root = core.getPaths(root).root;
  const at = (...parts) => core.assertLocalPath(win.join(root, ...parts), { within: root });
  return {
    layoutVersion: 2, platformRoot: root,
    nodeExe: at('app', 'node', 'node.exe'), codeExe: at('app', 'vscode', 'Code.exe'),
    gitExe: at('app', 'git', 'cmd', 'git.exe'), ghExe: at('app', 'gh', 'bin', 'gh.exe'),
    sshExe: core.getSshExecutable(root), keygenExe: core.getSshExecutable(root, 'ssh-keygen'),
    scpExe: core.getSshExecutable(root, 'scp'),
  };
}

function within(value, root) {
  if (typeof value !== 'string' || !root || !/^[A-Za-z]:[\\/]/.test(value)) return false;
  const rel = win.relative(root, value);
  return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win.isAbsolute(rel));
}

// Only rebase paths inside the old platform, never unrelated user paths.
function rebase(value, oldRoot, root) {
  if (Array.isArray(value)) return value.map(item => rebase(item, oldRoot, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item, oldRoot, root)]));
  if (typeof value !== 'string' || !oldRoot) return value;
  const uriPath = /^\/[A-Za-z]:\//.test(value);
  const candidate = uriPath ? value.slice(1) : value;
  if (!within(candidate, oldRoot)) return value;
  const moved = win.join(root, win.relative(oldRoot, candidate));
  return uriPath ? '/' + moved.replaceAll('\\', '/') : moved;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('A platform configuration is invalid JSON: ' + win.basename(file) + '. The original file was preserved.'); }
}

function previousRoot(state, launch) {
  for (const candidate of [state?.root, launch?.platformRoot]) {
    if (typeof candidate === 'string' && /^[A-Za-z]:[\\/]/.test(candidate)) {
      const normalized = win.normalize(candidate);
      if (normalized === win.parse(normalized).root || candidate.split(/[\\/]/).some(part => part === '..' || part === '.')) {
        throw Error('The previous platform root is invalid. Restore portable-state.json from your own backup.');
      }
      return normalized;
    }
  }
  if (typeof launch?.codeExe === 'string' && /[\\/]app[\\/]vscode[\\/]Code\.exe$/i.test(launch.codeExe)) {
    return previousRoot({ root: win.dirname(win.dirname(win.dirname(launch.codeExe))) }, {});
  }
  return null;
}

function currentUserSid() {
  const result = spawnSync(win.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
  const sid = result.stdout?.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (result.status !== 0 || !sid) throw Error('Cannot identify the current Windows user to protect the portable SSH key.');
  return sid;
}

function restrictPrivateKey(file, sid, root) {
  file = core.assertLocalPath(file, { within: root });
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw Error('Invalid Windows user identity.');
  const encodedPath = Buffer.from(file, 'utf8').toString('base64');
  const source = `$ErrorActionPreference='Stop'; $file=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); ` +
    `$sid=[Security.Principal.SecurityIdentifier]::new('${sid}'); $acl=[IO.File]::GetAccessControl($file); ` +
    `$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if ($owner -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'The copied key has an unsupported owner; restore ownership before continuing.' }; ` +
    `$acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }; ` +
    `$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); [IO.File]::SetAccessControl($file,$acl); ` +
    `$check=[IO.File]::GetAccessControl($file); $rules=$check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); ` +
    `if (-not $check.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne 'Allow') { throw 'Private key access verification failed.' }`;
  const result = spawnSync(win.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { windowsHide: true, shell: false, timeout: 15000, stdio: 'ignore',
      env: { ...process.env, ...core.buildStorageEnv(root, { ...core.defaultConfig, useProxy: false }) } });
  if (result.status !== 0 || result.error) throw Error('Cannot protect the copied SSH key for this Windows user. Migration was not completed; restore access to data/ssh and retry.');
}

function preparePortable(root, options = {}) {
  const tools = layout(root);
  root = tools.platformRoot;
  const at = (...parts) => core.assertLocalPath(win.join(root, ...parts), { within: root });
  for (const key of ['nodeExe', 'codeExe', 'gitExe', 'ghExe']) {
    if (!fs.existsSync(tools[key]) || !fs.statSync(tools[key]).isFile()) throw Error('Missing portable component: ' + key + '. Run the platform EXE to prepare it.');
  }
  const launchFile = at('launch-config.json'), stateFile = at('data', 'portable-state.json');
  const oldLaunch = readJson(launchFile, {}), oldState = readJson(stateFile, {});
  for (const value of [oldLaunch, oldState]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('The portable launch and state configurations must be JSON objects.');
  }
  const oldRoot = previousRoot(oldState, oldLaunch);
  const moved = !!oldRoot && oldRoot.toLowerCase() !== root.toLowerCase();
  const connectionFile = at('data', 'connection.json');
  let connection = readJson(connectionFile, { ...core.defaultConfig, useProxy: false, tunnel: false });
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw Error('Invalid connection configuration; no migration was performed.');
  connection = { ...connection };
  const originalIdentity = connection.identityFile;
  const relocatedIdentity = rebase(originalIdentity, oldRoot, root);
  const plans = [];
  const userSid = originalIdentity ? (options.userSid || currentUserSid()) : null;
  const protectKey = options.restrictPrivateKey || restrictPrivateKey;
  let importedIdentity = false;
  const backupRoot = at('data', 'migration-backups', Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  let backupCreated = false;
  function backup(file) {
    if (!fs.existsSync(file)) return;
    const copy = core.assertLocalPath(win.join(backupRoot, win.relative(root, file)), { within: root });
    fs.mkdirSync(win.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
    backupCreated = true;
  }
  function write(file, bytes, privateKey = false) {
    file = core.assertLocalPath(file, { within: root });
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) {
      if (privateKey) protectKey(file, userSid, root);
      return;
    }
    backup(file);
    fs.mkdirSync(win.dirname(file), { recursive: true });
    const temp = core.assertLocalPath(file + '.' + crypto.randomUUID() + '.tmp', { within: root });
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      if (privateKey) protectKey(temp, userSid, root);
      core.assertLocalPath(file, { within: root });
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  const planJson = (file, value) => plans.push([file, JSON.stringify(value, null, 2) + '\n']);

  if (originalIdentity) {
    if (within(relocatedIdentity, root)) {
      connection.identityFile = core.assertLocalPath(relocatedIdentity, { within: root });
      // After moving, a missing copied key must never silently use an unrelated
      // file at the old path or generate a replacement key for the same account.
      if (moved && !fs.existsSync(connection.identityFile)) throw Error('The moved platform is missing its SSH key. Restore data/ssh from your own backup before continuing.');
    } else {
      const source = core.assertLocalPath(originalIdentity);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw Error('The selected external SSH key is missing. Copy it into data/ssh before moving this platform.');
      const bytes = fs.readFileSync(source);
      const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const imported = at('data', 'ssh', 'imported-' + id);
      plans.push([imported, bytes, true]);
      importedIdentity = true;
      const publicSource = source + '.pub';
      if (fs.existsSync(publicSource)) plans.push([imported + '.pub', fs.readFileSync(core.assertLocalPath(publicSource))]);
      connection.identityFile = imported;
    }
  }
  connection = core.validateConfig(connection, { allowEmptyHost: true });

  for (const relative of ['data/setup-state.json', 'data/vscode-user/User/settings.json', 'data/extensions/extensions.json', 'Research.code-workspace']) {
    const file = at(relative), existing = readJson(file);
    if (existing === null) continue;
    if ((relative === 'data/extensions/extensions.json' && !Array.isArray(existing))
      || (relative !== 'data/extensions/extensions.json' && (!existing || typeof existing !== 'object' || Array.isArray(existing)))) {
      throw Error('A platform configuration has the wrong shape: ' + win.basename(file) + '. No migration was performed.');
    }
    let next = rebase(existing, oldRoot, root);
    if (relative === 'data/setup-state.json' && next.verifiedConnection?.identityFile === relocatedIdentity && connection.identityFile) {
      next.verifiedConnection.identityFile = connection.identityFile;
    }
    if (relative === 'data/extensions/extensions.json' && Array.isArray(next)) {
      next = next.map(entry => {
        if (typeof entry.relativeLocation !== 'string') return entry;
        const target = core.assertLocalPath(win.join(root, 'data', 'extensions', entry.relativeLocation), { within: at('data', 'extensions') });
        return { ...entry, location: { ...(entry.location || {}), scheme: 'file', path: '/' + target.replaceAll('\\', '/') } };
      });
    }
    planJson(file, next);
  }

  const syncFile = at('.agent-sync', 'config.json');
  const sync = readJson(syncFile);
  if (sync && (typeof sync !== 'object' || Array.isArray(sync))) throw Error('The GitHub sync configuration must be an object.');
  if (sync) planJson(syncFile, { ...sync, gitExe: tools.gitExe, ghExe: tools.ghExe });
  planJson(connectionFile, connection);
  planJson(launchFile, tools);
  // All input JSON is parsed before writing; malformed state never causes a
  // partial replacement of the user's credentials or connection configuration.
  for (const [file, bytes, privateKey] of plans) write(file, bytes, privateKey);
  if (connection.identityFile && !importedIdentity && (moved || (oldState.userSid && oldState.userSid !== userSid))) {
    protectKey(connection.identityFile, userSid, root);
  }
  core.saveConfig(root, connection);

  const gitConfig = at('.agent-sync', 'private', 'gitconfig');
  const gitNeedsRepair = sync && (moved || oldState.version !== 2 || oldLaunch.gitExe !== tools.gitExe
    || oldLaunch.ghExe !== tools.ghExe || !fs.existsSync(gitConfig));
  if (gitNeedsRepair) {
    backup(gitConfig);
    fs.mkdirSync(win.dirname(gitConfig), { recursive: true });
    const env = { ...process.env, ...core.buildStorageEnv(root, { ...core.defaultConfig, useProxy: false }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
      GH_CONFIG_DIR: at('.agent-sync', 'private', 'gh'), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
    const runner = options.run || spawnSync;
    const git = (args, allowed = [0]) => {
      const result = runner(tools.gitExe, ['config', '--file', gitConfig, ...args], { cwd: root, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 });
      if (result.error || !allowed.includes(result.status)) throw Error('Unable to repair the portable Git configuration. Check the platform folder permissions.');
      return result.stdout || '';
    };
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const host of ['https://github.com', 'https://gist.github.com']) {
      const key = 'credential.' + host + '.helper';
      git(['--unset-all', key], [0, 5]);
      git(['--add', key, '']);
      git(['--add', key, '!' + quote(tools.ghExe.replaceAll('\\', '/')) + ' auth git-credential']);
    }
    const safeRoots = git(['--get-all', 'safe.directory'], [0, 1]).trim().split(/\r?\n/);
    if (!safeRoots.some(value => win.normalize(value).toLowerCase() === root.toLowerCase())) git(['--add', 'safe.directory', root.replaceAll('\\', '/')]);
  }

  if (moved) {
    // These are local process claims, not experiment files. Archive copied
    // claims so a new computer never tries to reuse an old process identity.
    for (const relative of ['data/tunnel/state.json', 'data/tunnel/operation.lock']) {
      const file = at(relative);
      if (fs.existsSync(file)) { backup(file); fs.unlinkSync(file); }
    }
  }
  const unchanged = oldState.version === 2 && oldState.root === root && oldState.userSid === userSid;
  if (!unchanged) write(stateFile, JSON.stringify({ version: 2, root, userSid, preparedAt: new Date().toISOString() }, null, 2) + '\n');
  return { root, moved, tools, backup: backupCreated ? backupRoot : null };
}

module.exports = { layout, within, rebase, previousRoot, preparePortable };
if (require.main === module) {
  try {
    const result = preparePortable(process.argv[2] || win.resolve(__dirname, '..'));
    console.log('Portable paths ready: ' + result.root + (result.moved ? ' (location updated)' : ''));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
