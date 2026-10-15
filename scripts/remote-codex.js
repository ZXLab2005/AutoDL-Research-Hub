'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('../src/core');
const bridge = require('./invoke-autodl');
const { createTunnelManager } = require('../src/tunnel');
const TARGETS = new Set(['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl']);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?$/;
const HASH = /^[a-f0-9]{64}$/;
const report = message => process.stderr.write('[Remote Codex] ' + message + '\n');
const quote = text => "'" + String(text).replace(/'/g, "'\\''") + "'";
const utf8 = bytes => bridge.decodeUtf8(bytes, 'UTF-8 input');
function posixPath(value, label) {
  if (typeof value !== 'string' || value === '/' || !/^\/[\p{L}\p{N}_./-]+$/u.test(value)
      || value.includes('//') || value.split('/').some(part => part === '.' || part === '..')) throw Error(label + ' must be a safe absolute Linux path.');
  return value.replace(/\/$/, '');
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function secureLocal(root, file) { return core.assertEPath(file, { within: root }); }
function mkdir(root, directory) {
  secureLocal(root, directory); fs.mkdirSync(directory, { recursive: true }); secureLocal(root, directory);
}
function saveJson(root, file, value) {
  secureLocal(root, file); mkdir(root, path.dirname(file));
  const temp = secureLocal(root, file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function runProcess(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false, size = 0, chunks = [], settled = false;
    const child = spawn(exe, args, {
      shell: false, windowsHide: !options.interactive, cwd: options.root, env: options.env,
      stdio: options.interactive ? 'inherit' : ['pipe', options.quiet ? 'ignore' : 'pipe', options.quiet ? 'ignore' : 'inherit']
    });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs) : null;
    const complete = (error, value) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    child.once('error', () => complete(Error('Unable to start ' + path.basename(exe) + '.')));
    if (child.stdout) child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > (options.maxOutput || 8 * 1024 * 1024)) { child.kill(); complete(Error('Process metadata output exceeded its limit.')); }
      else chunks.push(bytes);
    });
    child.once('close', code => complete(null, { code: timedOut ? 124 : Number.isInteger(code) ? code : 255, stdout: Buffer.concat(chunks).toString('utf8') }));
    if (!options.interactive) {
      child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) { child.kill(); complete(Error('Unable to send SSH input.')); } });
      if (options.inputFile) {
        const input = fs.createReadStream(options.inputFile);
        input.once('error', () => { child.kill(); complete(Error('Unable to read the verified package.')); });
        child.once('close', () => input.destroy());
        input.pipe(child.stdin);
      } else child.stdin.end(options.input || Buffer.alloc(0));
    }
  });
}
function sshBase(paths, interactive = false) {
  return bridge.buildSshArgs(paths, 20).slice(0, -4).map(arg => arg === '-T' ? (interactive ? '-tt' : '-T') : arg === 'RequestTTY=no' && interactive ? 'RequestTTY=force' : arg);
}
function makeTransport(root, config, paths) {
  const env = { ...process.env, ...core.buildStorageEnv(root, config) };
  const sshExe = core.getSshExecutable(root);
  return async (command, options = {}) => runProcess(sshExe, [...sshBase(paths, !!options.interactive), 'autodl-research', command], { root, env, timeoutMs: 90000, ...options });
}
async function remoteScript(transport, root, name, args) {
  return transport('bash -s -- ' + args.map(quote).join(' '), {
    input: Buffer.from(utf8(fs.readFileSync(path.join(root, 'remote', name))), 'utf8')
  });
}
function requireSuccess(result, step) {
  if (result.code !== 0) { const error = Error(step + ' failed (exit ' + result.code + ').'); error.exitCode = result.code; throw error; }
  return result;
}
function parseProbe(text) {
  const line = text.split(/\r?\n/).find(row => row.startsWith('HUB_REMOTE_V1\t'));
  if (!line) throw Error('Remote probe returned no recognizable result.');
  const [marker, arch, root, binary, version] = line.split('\t');
  if (!['x86_64', 'aarch64'].includes(arch)) throw Error('Unsupported Linux architecture.');
  return { arch, root: posixPath(root, 'RemoteRoot'), binary: binary ? posixPath(binary, 'Codex binary') : '', version: (version || '').slice(0, 120), target: arch + '-unknown-linux-musl' };
}
function validateReceipt(value, expectedTarget) {
  if (!value || !VERSION.test(value.version) || !TARGETS.has(value.target) || value.target !== expectedTarget || !HASH.test(value.sha256)) throw Error('Invalid cached Codex receipt.');
  const name = 'codex-package-' + value.target + '.tar.gz';
  if (value.assetName !== name) throw Error('Unexpected cached Codex package name.');
  validateReleaseUrl(value.sourceUrl, value.version, name);
  return { version: value.version, target: value.target, assetName: name, sha256: value.sha256, sourceUrl: value.sourceUrl };
}
function validateReleaseUrl(value, version, name) {
  const allowed = [
    'https://releases.openai.com/codex/releases/' + version + '/' + name,
    'https://github.com/openai/codex/releases/download/rust-v' + version + '/' + name
  ];
  if (!allowed.includes(value)) throw Error('Release asset does not use an expected official HTTPS URL.');
  return value;
}
function selectRelease(metadata, target) {
  if (!TARGETS.has(target) || !metadata || !/^rust-v/.test(metadata.tag_name || '') || !Array.isArray(metadata.assets)) throw Error('Invalid official release metadata.');
  const version = metadata.tag_name.slice(6);
  if (!VERSION.test(version)) throw Error('Invalid release version.');
  const packageName = 'codex-package-' + target + '.tar.gz';
  const getAsset = name => {
    const matches = metadata.assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest || '')) throw Error('Official SHA256 metadata is missing for ' + name + '.');
    const asset = matches[0];
    return { name, sha256: asset.digest.slice(7), url: validateReleaseUrl(asset.browser_download_url, version, name) };
  };
  return { version, target, package: getAsset(packageName), sums: getAsset('codex-package_SHA256SUMS') };
}
function checksumFor(text, name) {
  const matches = text.split(/\r?\n/).map(row => /^([a-f0-9]{64})[ \t]+[* ]?(.+)$/.exec(row.trim()))
    .filter(match => match && match[2] === name);
  if (matches.length !== 1) throw Error('The verified checksum list has no unique entry for the selected package.');
  return matches[0][1];
}
async function fetchWithCurl(root, config, url, file) {
  if (!url.startsWith('https://')) throw Error('Only HTTPS downloads are allowed.');
  const curl = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  const args = ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', file ? '900' : '90', '--retry', '2'];
  if (config.useProxy) args.push('--proxy', config.proxyUrl); else args.push('--noproxy', '*');
  if (file) args.push('--output', secureLocal(root, file));
  args.push(url);
  const result = await runProcess(curl, args, { root, env: { ...process.env, ...core.buildStorageEnv(root, config) }, timeoutMs: file ? 1000000 : 120000 });
  requireSuccess(result, 'Official HTTPS download');
  return file ? undefined : result.stdout;
}
async function ensurePackage(root, config, target, update, dependencies = {}) {
  const fetchText = dependencies.fetchText || (url => fetchWithCurl(root, config, url));
  const download = dependencies.download || ((url, file) => fetchWithCurl(root, config, url, file));
  const cache = secureLocal(root, path.join(root, 'data', 'cache', 'codex-cli'));
  const pointer = secureLocal(root, path.join(cache, 'cached-' + target + '.json'));
  let pinned;
  if (!update && fs.existsSync(pointer)) {
    pinned = validateReceipt(JSON.parse(fs.readFileSync(pointer, 'utf8').replace(/^\uFEFF/, '')), target);
    const file = secureLocal(root, path.join(cache, pinned.version, target, pinned.assetName));
    if (fs.existsSync(file) && await hashFile(file) === pinned.sha256) {
      report('Reusing verified portable cache: ' + pinned.version + ' / ' + target);
      return { ...pinned, file, fromCache: true };
    }
    report('Cached package is missing or fails SHA256; restoring the same pinned version.');
  }
  const endpoint = pinned ? 'https://releases.openai.com/codex/releases/' + pinned.version + '/release.json' : 'https://releases.openai.com/codex/channels/latest';
  let metadata;
  try { metadata = JSON.parse(await fetchText(endpoint)); }
  catch {
    const fallback = pinned ? 'https://api.github.com/repos/openai/codex/releases/tags/rust-v' + pinned.version : 'https://api.github.com/repos/openai/codex/releases/latest';
    metadata = JSON.parse(await fetchText(fallback));
  }
  const release = selectRelease(metadata, target);
  if (pinned && release.version !== pinned.version) throw Error('Pinned package metadata unexpectedly changed version.');
  const sumsText = await fetchText(release.sums.url);
  if (digest(Buffer.from(sumsText, 'utf8')) !== release.sums.sha256) throw Error('Official checksum list failed SHA256 validation.');
  const expected = checksumFor(sumsText, release.package.name);
  if (expected !== release.package.sha256) throw Error('Official package SHA256 metadata disagrees with the checksum list.');
  const receipt = { version: release.version, target, assetName: release.package.name, sha256: expected, sourceUrl: release.package.url };
  const directory = secureLocal(root, path.join(cache, release.version, target)); mkdir(root, directory);
  const file = secureLocal(root, path.join(directory, receipt.assetName));
  if (!fs.existsSync(file) || await hashFile(file) !== expected) {
    const partial = secureLocal(root, file + '.' + crypto.randomBytes(8).toString('hex') + '.partial');
    try {
      report('Downloading official Codex ' + release.version + ' for ' + target + ' into the portable cache.');
      await download(release.package.url, partial);
      if (await hashFile(partial) !== expected) throw Error('Downloaded Codex archive failed SHA256 validation.');
      fs.renameSync(partial, file);
    } finally { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
  }
  saveJson(root, path.join(directory, 'receipt.json'), receipt);
  saveJson(root, pointer, receipt);
  return { ...receipt, file, fromCache: false };
}
function validateAuthBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 262144) throw Error('auth.json must be a non-empty JSON file no larger than 256 KiB.');
  let value;
  try { value = JSON.parse(utf8(bytes)); } catch { throw Error('auth.json is not valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('auth.json must contain a credential object.');
  const nonempty = item => typeof item === 'string' && item.trim().length > 0;
  const apiKey = nonempty(value.OPENAI_API_KEY);
  const tokens = value.tokens && typeof value.tokens === 'object' && !Array.isArray(value.tokens)
    && nonempty(value.tokens.access_token) && nonempty(value.tokens.refresh_token) && nonempty(value.tokens.id_token);
  if (!apiKey && !tokens) throw Error('auth.json contains neither a supported API key nor complete ChatGPT tokens.');
  return Buffer.from(JSON.stringify(value), 'utf8');
}
function authCandidates(root, options = {}, environment = process.env, userHome = os.userInfo().homedir) {
  if (options.authFile) return [path.resolve(options.authFile)];
  const homes = [
    options.originalCodexHome || environment.RESEARCH_HUB_ORIGINAL_CODEX_HOME || environment.CODEX_HOME,
    options.originalProfile || environment.RESEARCH_HUB_ORIGINAL_USERPROFILE,
    options.profileFallback,
    userHome
  ];
  const list = [path.join(root, 'data', 'codex', 'auth.json')];
  if (homes[0]) list.push(path.join(homes[0], 'auth.json'));
  for (const home of homes.slice(1)) if (home) list.push(path.join(home, '.codex', 'auth.json'));
  return [...new Map(list.map(file => [path.resolve(file).toLowerCase(), path.resolve(file)])).values()];
}
function selectAuth(root, options) {
  for (const file of authCandidates(root, options)) {
    if (!fs.existsSync(file)) { if (options.authFile) throw Error('The selected auth.json does not exist: ' + file); continue; }
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 262144) throw Error('not a credential file of at most 256 KiB');
      return { file, bytes: validateAuthBytes(fs.readFileSync(file)) };
    } catch (error) {
      // Do not include JSON parser context, credential contents, or token fragments.
      const reason = /auth\.json|credential|256 KiB/.test(error.message) ? error.message : 'the credential file could not be read';
      report('Auth source skipped: ' + file + ' (' + reason + ').');
      if (options.authFile) throw Error('The explicitly selected auth.json is not usable.');
    }
  }
  return null;
}
async function installOrReuse(root, config, paths, options, dependencies = {}) {
  const transport = dependencies.transport || makeTransport(root, config, paths);
  const probeResult = requireSuccess(await remoteScript(transport, root, 'codex-probe.sh', [options.remoteRoot || '', config.remotePath]), 'Remote architecture and installation probe');
  const remote = parseProbe(probeResult.stdout);
  if (remote.binary && !options.update) {
    report('Reusing remote executable: ' + remote.binary + ' (' + remote.version + ').');
  } else {
    const asset = await (dependencies.ensurePackage || ensurePackage)(root, config, remote.target, !!options.update);
    const nonce = crypto.randomBytes(12).toString('hex');
    const args = [remote.root, asset.version, remote.target, asset.sha256, nonce];
    requireSuccess(await remoteScript(transport, root, 'codex-install.sh', ['prepare', ...args]), 'Remote staging');
    const stage = remote.root + '/tools/codex/.stage-' + nonce;
    const uploadCommand = 'umask 077; test -d ' + quote(stage) + ' && test ! -L ' + quote(stage) + ' && cat > ' + quote(stage + '/package.tar.gz');
    requireSuccess(await transport(uploadCommand, { inputFile: asset.file, timeoutMs: 600000 }), 'Verified package transfer');
    const installed = requireSuccess(await remoteScript(transport, root, 'codex-install.sh', ['install', ...args]), 'Remote package integrity and installation');
    const line = installed.stdout.split(/\r?\n/).find(row => row.startsWith('HUB_INSTALLED_V1\t'));
    if (!line) throw Error('Remote installer returned no verified executable.');
    const [, binary, version] = line.split('\t');
    remote.binary = posixPath(binary, 'Installed Codex binary'); remote.version = version;
    remote.cachedVersion = asset.version;
    report('Installed ' + remote.version + ' from the verified portable cache.');
  }
  const sessionPath = remote.root + '/tools/codex/session.sh';
  const stagingPath = sessionPath + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  const deploy = 'umask 077; test ! -L ' + quote(remote.root + '/tools') + ' && test ! -L ' + quote(remote.root + '/tools/codex')
    + ' && mkdir -p -- ' + quote(remote.root + '/tools/codex')
    + ' && test ! -L ' + quote(sessionPath) + ' && cat > ' + quote(stagingPath)
    + ' && chmod 700 -- ' + quote(stagingPath) + ' && mv -fT -- ' + quote(stagingPath) + ' ' + quote(sessionPath);
  requireSuccess(await transport(deploy, { input: Buffer.from(utf8(fs.readFileSync(path.join(root, 'remote', 'codex-session.sh'))), 'utf8') }), 'Remote session preparation');
  const sessionCommand = mode => 'bash ' + [sessionPath, remote.root, config.remotePath, remote.binary, String(config.tunnel ? config.remoteProxyPort : 0), mode].map(quote).join(' ');
  return { remote, transport, sessionCommand };
}
async function prepareAuth(root, options, installed) {
  const current = await installed.transport(installed.sessionCommand('status'), { quiet: true });
  if (current.code === 0) { report('Remote Codex recognizes its existing saved login; it was preserved.'); return true; }
  if (current.code !== 10) throw Error('Cannot inspect the remote CODEX_HOME safely (exit ' + current.code + ').');
  const local = selectAuth(root, options);
  if (!local) { report('No usable local auth.json was found. Interactive device login is available on launch.'); return false; }
  report('Transferring authorized local auth.json through SSH stdin from: ' + local.file);
  try {
    const result = await installed.transport(installed.sessionCommand('receive-auth'), { input: local.bytes, quiet: true });
    if (result.code !== 0) throw Error('The remote credential transfer or login-status check failed (exit ' + result.code + '). No credential content was logged.');
  } finally { local.bytes.fill(0); }
  report('Remote Codex recognizes the saved login. This does not test server-side token validity or model access.');
  return true;
}
function parseArguments(argv) {
  let action = 'launch', offset = 0;
  if (argv[0] && !argv[0].startsWith('--')) { action = argv[0]; offset = 1; }
  if (!['launch', 'install', 'prepare'].includes(action)) throw Error('Action must be launch, install, or prepare.');
  const options = { action, root: path.resolve(__dirname, '..'), update: false };
  const keys = {
    '--root-base64': 'root', '--remote-root-base64': 'remoteRoot', '--auth-file-base64': 'authFile',
    '--original-codex-home-base64': 'originalCodexHome', '--original-profile-base64': 'originalProfile', '--profile-fallback-base64': 'profileFallback'
  };
  const seen = new Set();
  for (let index = offset; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw Error('Repeated invocation option.');
    seen.add(flag);
    if (flag === '--update') { options.update = true; continue; }
    if (flag === '--auth-only') { options.action = 'prepare'; continue; }
    if (!keys[flag] || index + 1 >= argv.length) throw Error('Unknown or incomplete invocation option.');
    options[keys[flag]] = bridge.fromBase64(argv[++index], keys[flag]);
  }
  options.root = core.assertEPath(options.root);
  if (options.remoteRoot) options.remoteRoot = posixPath(options.remoteRoot, 'RemoteRoot');
  if (options.authFile && !path.win32.isAbsolute(options.authFile)) throw Error('AuthFile must be an absolute local path.');
  return options;
}
async function main(argv) {
  const options = parseArguments(argv);
  const root = options.root, paths = core.getPaths(root);
  const config = bridge.validateConnectionSnapshot(root, core.readConfig(root), fs.readFileSync(paths.sshConfig, 'utf8'));
  if (!fs.existsSync(paths.knownHosts) || fs.statSync(paths.knownHosts).size === 0) throw Error('Known-host verification is required. Run scripts/Test-SSH.ps1 -NoPause first.');
  report('target=' + config.user + '@' + config.host + ':' + config.port + ' project=' + config.remotePath);
  if (config.tunnel) {
    const tunnel = await createTunnelManager(root).ensure(config);
    if (!['ready', 'running'].includes(tunnel.status)) throw Error('Remote proxy tunnel is not ready: ' + (tunnel.message || tunnel.status));
    report('Remote proxy tunnel is ready.');
  }
  const installed = await installOrReuse(root, config, paths, options);
  saveJson(root, path.join(root, 'data', 'remote-codex-state.json'), {
    host: config.host, port: config.port, user: config.user, remotePath: config.remotePath,
    remoteRoot: installed.remote.root, codexHome: installed.remote.root + '/codex-remote',
    binary: installed.remote.binary, version: installed.remote.version, checkedAt: new Date().toISOString()
  });
  if (options.action === 'install') { report('Installation is ready. No local authentication file was inspected or transferred.'); return 0; }
  const authenticated = await prepareAuth(root, options, installed);
  if (options.action === 'prepare') return authenticated ? 0 : 10;
  const result = await installed.transport(installed.sessionCommand('launch'), { interactive: true, timeoutMs: 0 });
  return result.code;
}
module.exports = { posixPath, quote, digest, hashFile, parseProbe, validateReceipt, validateReleaseUrl, selectRelease, checksumFor, ensurePackage, validateAuthBytes, authCandidates, selectAuth, installOrReuse, prepareAuth, parseArguments, sshBase, runProcess, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  report(error.message);
  if (error.code === 'EACCES' || error.code === 'EPERM') report('Keep private-key permissions unchanged. In Codex, retry with the normal approved require_escalated tool execution.');
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 2;
});
