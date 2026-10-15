'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const win = path.win32;
const defaultConfig = Object.freeze({
  host: '',
  port: 22,
  user: 'root',
  remotePath: '/root/autodl-tmp/research-hub/projects',
  proxyUrl: 'http://127.0.0.1:7897',
  identityFile: '',
  useProxy: true,
  tunnel: false,
  remoteProxyPort: 17897,
});

function fail(message) { throw new Error(message); }

function existingRealPath(candidate) {
  let ancestor = candidate;
  const tail = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      return win.join(fs.realpathSync.native(ancestor), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A broken link must not be mistaken for an ordinary missing directory.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) fail('路径包含失效的链接。');
      } catch (linkError) {
        if (linkError.code !== 'ENOENT') throw linkError;
      }
      const parent = win.dirname(ancestor);
      if (parent === ancestor) fail('所选本地磁盘不可用。');
      tail.push(win.basename(ancestor));
      ancestor = parent;
    }
  }
}

function inside(candidate, root) {
  const relative = win.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win.isAbsolute(relative));
}

/** Validate a local Windows path; managed writes also require a root boundary. */
function assertLocalPath(candidate, options = {}) {
  if (typeof candidate !== 'string' || !/^[a-zA-Z]:[\\/]/.test(candidate)) {
    fail('平台路径必须是本地磁盘绝对路径。');
  }
  if (/[\x00-\x1f<>"|?*]/.test(candidate) || candidate.slice(2).includes(':')) {
    fail('路径包含不允许的 Windows 字符。');
  }
  const segments = candidate.slice(3).split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || /[ .]$/.test(segment)) {
      fail('路径不能包含目录跳转或末尾空格、句点。');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      fail('路径不能使用 Windows 设备名称。');
    }
  }
  const normalized = win.normalize(candidate[0].toUpperCase() + candidate.slice(1));
  const boundary = options.within ? assertLocalPath(options.within) : null;
  if (boundary && !inside(normalized, boundary)) fail('文件必须位于平台目录内。');
  if (process.platform === 'win32') {
    const actual = existingRealPath(normalized);
    if (actual.toLowerCase() !== normalized.toLowerCase()) fail('路径包含链接或重定向，已拒绝写入。');
    if (boundary && !inside(actual, existingRealPath(boundary))) {
      fail('路径链接越出了平台目录，已拒绝写入。');
    }
  }
  return normalized;
}

// Kept for installed scripts from earlier releases; the portable policy is
// local absolute paths plus explicit containment, not a particular drive letter.
const assertEPath = assertLocalPath;

function getSshExecutable(root, program = 'ssh') {
  if (!['ssh', 'ssh-keygen', 'scp'].includes(program)) fail('不支持的 SSH 工具。');
  root = assertLocalPath(root);
  const bundled = assertLocalPath(win.join(root, 'app', 'openssh', program + '.exe'), { within: root });
  if (fs.existsSync(bundled)) return bundled;
  const system = win.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', program + '.exe');
  if (fs.existsSync(system)) return system;
  const git = assertLocalPath(win.join(root, 'app', 'git', 'usr', 'bin', program + '.exe'), { within: root });
  return fs.existsSync(git) ? git : system;
}

function getPaths(root) {
  root = assertEPath(root);
  if (root === win.parse(root).root) fail('请使用专用文件夹，不能直接使用磁盘根目录。');
  const p = (...parts) => assertEPath(win.join(root, ...parts), { within: root });
  const result = {
    root,
    data: p('data'),
    configFile: p('data', 'connection.json'),
    sshDir: p('data', 'ssh'),
    sshConfig: p('data', 'ssh', 'config'),
    knownHosts: p('data', 'ssh', 'known_hosts'),
    userData: p('data', 'vscode-user'),
    extensions: p('data', 'extensions'),
    codexHome: p('data', 'codex'),
    logs: p('data', 'logs'),
    temp: p('data', 'temp'),
    home: p('data', 'home'),
    appData: p('data', 'appdata', 'Roaming'),
    localAppData: p('data', 'appdata', 'Local'),
    browserData: p('data', 'browser'),
    cache: p('data', 'cache'),
    workspace: p('workspace'),
  };
  result.directories = Object.keys(result)
    .filter(key => !['configFile', 'sshConfig', 'knownHosts'].includes(key))
    .map(key => result[key]);
  return result;
}

function port(value, name) {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`${name} 必须为 1 至 65535 的整数。`);
  return value;
}

function hostname(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) fail('请填写 SSH 主机名。');
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (net.isIP(value)) return value;
  if (/^[0-9.]+$/.test(value) || value.length > 253) fail('SSH 主机名或 IP 地址无效。');
  const labels = value.split('.');
  if (!labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    fail('SSH 主机名只能包含有效域名或 IP 地址。');
  }
  return value.toLowerCase();
}

function parseProxy(proxyUrl) {
  if (typeof proxyUrl !== 'string' || /[\s\x00-\x1f]/.test(proxyUrl)) fail('代理地址无效。');
  let url;
  try { url = new URL(proxyUrl); } catch { fail('代理地址应为 http://127.0.0.1:7897。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    fail('仅允许不含账号、路径或参数的本机回环 HTTP 代理。');
  }
  const proxyPort = port(url.port || 80, '代理端口');
  return { host: url.hostname, port: proxyPort, url: `http://${url.hostname}:${proxyPort}` };
}

function validateConfig(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('连接配置必须是对象。');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaultConfig, key)) fail(`不支持的配置字段：${key}`);
  }
  const config = { ...defaultConfig, ...input };
  if (!(options.allowEmptyHost && config.host === '')) config.host = hostname(config.host);
  config.port = port(config.port, 'SSH 端口');
  config.remoteProxyPort = port(config.remoteProxyPort, '远端代理端口');
  if (typeof config.user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(config.user)) {
    fail('SSH 用户名无效。');
  }
  if (typeof config.remotePath !== 'string' || !/^\/[\p{L}\p{N}_./-]*$/u.test(config.remotePath)
      || config.remotePath.includes('//') || config.remotePath.split('/').some(part => part === '.' || part === '..')) {
    fail('远端目录必须为绝对 Linux 路径，不得包含空格、目录跳转或 Shell 控制字符。');
  }
  if (typeof config.identityFile !== 'string') fail('SSH 私钥路径必须为字符串。');
  if (config.identityFile) config.identityFile = assertEPath(config.identityFile);
  for (const key of ['useProxy', 'tunnel']) {
    if (typeof config[key] !== 'boolean') fail(`${key} 必须为布尔值。`);
  }
  const proxy = parseProxy(config.proxyUrl);
  config.proxyUrl = proxy.url;
  if (config.tunnel && !config.useProxy) fail('开启远端代理转发前，请先启用本机代理。');
  return config;
}

function tokenizeCommand(command) {
  if (typeof command !== 'string' || !command.trim() || /[;&|`$<>\r\n\x00]/.test(command)) {
    fail('仅接受 SSH 登录命令，不接受密码或 Shell 命令。');
  }
  const tokens = [];
  let token = '';
  let quote = '';
  let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = '';
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else {
      token += character;
      started = true;
    }
  }
  if (quote) fail('SSH 命令中的引号没有闭合。');
  if (started) tokens.push(token);
  return tokens;
}

function parseSshCommand(command) {
  const tokens = tokenizeCommand(command);
  if (!/^ssh(?:\.exe)?$/i.test(tokens.shift() || '')) fail('命令必须以 ssh 开头。');
  let target;
  let sshPort = 22;
  let identityFile = '';
  const seen = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-p' || token === '-i') {
      if (seen.has(token) || index + 1 >= tokens.length) fail('SSH 参数重复或缺少参数值。');
      seen.add(token);
      const value = tokens[++index];
      if (token === '-p') sshPort = port(value, 'SSH 端口');
      else identityFile = assertEPath(value);
    } else {
      if (token.startsWith('-') || target) fail('仅支持 ssh、-p 端口、-i 本地私钥以及 用户@主机。');
      target = token;
    }
  }
  const match = /^([^@]+)@([^@]+)$/.exec(target || '');
  if (!match) fail('SSH 命令必须包含 用户@主机。');
  const config = validateConfig({ host: match[2], user: match[1], port: sshPort, identityFile });
  return { host: config.host, port: config.port, user: config.user, identityFile: config.identityFile };
}

function sshPath(value) { return `"${assertEPath(value).replace(/\\/g, '/')}"`; }

function renderSshConfig(root, input) {
  const paths = getPaths(root);
  const config = validateConfig(input);
  const lines = [
    '# Managed by AutoDL Research Hub; kept inside the portable platform folder.',
    'Host autodl-research',
    `  HostName ${config.host}`,
    `  Port ${config.port}`,
    `  User ${config.user}`,
    `  UserKnownHostsFile ${sshPath(paths.knownHosts)}`,
    '  GlobalKnownHostsFile NUL',
    '  StrictHostKeyChecking ask',
    '  ServerAliveInterval 30',
    '  ServerAliveCountMax 3',
    '  AddKeysToAgent no',
    '  ControlMaster no',
  ];
  if (config.identityFile) {
    lines.push(`  IdentityFile ${sshPath(config.identityFile)}`, '  IdentitiesOnly yes');
  } else {
    lines.push('  IdentityFile none');
  }
  // A separate ssh -N process owns reverse forwarding. Remote-SSH opens
  // multiple sessions, so placing RemoteForward here would collide on ports.
  return `${lines.join('\n')}\n`;
}

/** Open a research shell in the same directory displayed by Remote-SSH. */
function buildProjectSshArgs(root, input) {
  const paths = getPaths(root);
  const config = validateConfig(input);
  if (!config.identityFile) fail('请先配置平台 SSH 私钥，再打开远端项目终端。');
  // Keep the directory change and shell on the remote side of one SSH call.
  // The && chain deliberately stops when cd fails; it must never open a shell
  // in the login directory or fall back to a local research shell.
  const command = `cd -- '${config.remotePath}' && ` +
    'printf \'[AutoDL remote] host=%s cwd=%s\\n\' "$(hostname)" "$PWD" && exec bash -i';
  return [
    '-F', paths.sshConfig,
    '-o', `HostName=${config.host}`, '-p', String(config.port), '-l', config.user,
    '-i', config.identityFile,
    '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=45', '-o', 'ConnectionAttempts=1',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'AddKeysToAgent=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'RemoteCommand=none',
    '-t', 'autodl-research', command,
  ];
}

function buildRemoteProjectUriData(input) {
  const config = validateConfig(input);
  return { scheme: 'vscode-remote', authority: 'ssh-remote+autodl-research', path: config.remotePath };
}

function atomicWrite(file, content, root) {
  assertEPath(file, { within: root });
  const temporary = assertEPath(`${file}.${crypto.randomBytes(8).toString('hex')}.tmp`, { within: root });
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    assertEPath(file, { within: root });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function saveConfig(root, input) {
  const paths = getPaths(root);
  const config = validateConfig(input, { allowEmptyHost: true });
  const ssh = config.host
    ? renderSshConfig(root, config)
    : '# AutoDL Research Hub: SSH host is not configured yet.\n';
  for (const directory of [paths.data, paths.sshDir]) {
    assertEPath(directory, { within: paths.root });
    fs.mkdirSync(directory, { recursive: true });
    assertEPath(directory, { within: paths.root });
  }
  atomicWrite(paths.sshConfig, ssh, paths.root);
  atomicWrite(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, paths.root);
  return config;
}

function readConfig(root) {
  const paths = getPaths(root);
  if (!fs.existsSync(paths.configFile)) return { ...defaultConfig };
  const text = fs.readFileSync(paths.configFile, 'utf8').replace(/^\uFEFF/, '');
  return validateConfig(JSON.parse(text), { allowEmptyHost: true });
}

function buildStorageEnv(root, input = defaultConfig) {
  const paths = getPaths(root);
  const config = validateConfig(input, { allowEmptyHost: true });
  const env = {
    HOME: paths.home,
    USERPROFILE: paths.home,
    HOMEDRIVE: paths.home.slice(0, 2),
    HOMEPATH: paths.home.slice(2),
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    CODEX_HOME: paths.codexHome,
    XDG_CONFIG_HOME: win.join(paths.home, '.config'),
    XDG_DATA_HOME: win.join(paths.home, '.local', 'share'),
    XDG_CACHE_HOME: paths.cache,
    npm_config_cache: win.join(paths.cache, 'npm'),
    PIP_CACHE_DIR: win.join(paths.cache, 'pip'),
    HF_HOME: win.join(paths.cache, 'huggingface'),
    TORCH_HOME: win.join(paths.cache, 'torch'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (config.useProxy) {
    env.HTTP_PROXY = config.proxyUrl;
    env.HTTPS_PROXY = config.proxyUrl;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return env;
}

function buildSettings(root, input = defaultConfig) {
  const paths = getPaths(root);
  const config = validateConfig(input, { allowEmptyHost: true });
  const remoteEnv = {
    CODEX_HOME: '/root/autodl-tmp/research-hub/codex',
    XDG_CACHE_HOME: '/root/autodl-tmp/research-hub/cache',
    PIP_CACHE_DIR: '/root/autodl-tmp/research-hub/cache/pip',
    HF_HOME: '/root/autodl-tmp/research-hub/cache/huggingface',
    TORCH_HOME: '/root/autodl-tmp/research-hub/cache/torch',
  };
  if (config.tunnel) {
    remoteEnv.HTTP_PROXY = `http://127.0.0.1:${config.remoteProxyPort}`;
    remoteEnv.HTTPS_PROXY = remoteEnv.HTTP_PROXY;
    remoteEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return {
    'remote.SSH.path': getSshExecutable(root),
    'remote.SSH.configFile': paths.sshConfig.replace(/\\/g, '/'),
    'remote.SSH.remotePlatform': { 'autodl-research': 'linux' },
    'remote.SSH.serverInstallPath': { 'autodl-research': '/root/autodl-tmp/research-hub/vscode-server' },
    'remote.SSH.defaultExtensions': ['ms-python.python', 'ms-python.vscode-pylance', 'ms-toolsai.jupyter'],
    'remote.SSH.showLoginTerminal': false,
    'remote.SSH.connectTimeout': 45,
    'remote.SSH.useLocalServer': false,
    'remote.SSH.localServerDownload': 'always',
    'chatgpt.openOnStartup': false,
    'terminal.integrated.env.windows': buildStorageEnv(root, config),
    'terminal.integrated.env.linux': remoteEnv,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
  };
}

function codexConsoleAction(remoteName, workspaceFile, root) {
  if (remoteName) return 'return-local';
  const target = win.join(assertEPath(root), 'Research.code-workspace').toLowerCase();
  const current = workspaceFile?.scheme === 'file' && typeof workspaceFile.fsPath === 'string'
    ? win.normalize(workspaceFile.fsPath).toLowerCase() : '';
  return current === target ? 'open-sidebar' : 'open-workspace';
}

module.exports = {
  codexConsoleAction,
  defaultConfig,
  getPaths,
  assertEPath,
  assertLocalPath,
  getSshExecutable,
  validateConfig,
  parseSshCommand,
  parseProxy,
  renderSshConfig,
  buildProjectSshArgs,
  buildRemoteProjectUriData,
  readConfig,
  saveConfig,
  buildStorageEnv,
  buildSettings,
};
