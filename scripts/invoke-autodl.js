'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const core = require('../src/core');
const activity = require('../src/activity');

function decodeUtf8(bytes, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Error(label + ' must contain valid UTF-8 text.'); }
  if (text.includes('\0')) throw Error(label + ' must not contain NUL bytes.');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function normalizeSshConfig(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
}

function validateConnectionSnapshot(root, config, sshConfigText) {
  const checked = core.validateConfig(config);
  if (!checked.identityFile) throw Error('No portable SSH identity configured. Run Test-SSH.ps1 first.');
  if (normalizeSshConfig(sshConfigText) !== normalizeSshConfig(core.renderSshConfig(root, checked))) {
    throw Error('SSH config does not match connection.json. Save the connection in Research Hub and run Test-SSH.ps1 first.');
  }
  return checked;
}

function loadConnection(root) {
  const paths = core.getPaths(root);
  const config = validateConnectionSnapshot(root, core.readConfig(root), fs.readFileSync(paths.sshConfig, 'utf8'));
  if (!fs.existsSync(config.identityFile)) throw Error('The configured SSH identity is missing.');
  if (!fs.existsSync(paths.knownHosts) || fs.statSync(paths.knownHosts).size === 0) {
    throw Error('No verified host is recorded. Run scripts/Test-SSH.ps1 -NoPause to verify this instance first; this command will not accept an unknown host.');
  }
  return { paths, config };
}

function inside(candidate, directory) {
  const relative = path.win32.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
}

function readScriptFile(root, config, candidate, io = fs) {
  const paths = core.getPaths(root);
  const checked = core.assertEPath(candidate, { within: root });
  const isSensitive = file => file.toLowerCase() === config.identityFile.toLowerCase()
    || inside(file, paths.sshDir) || inside(file, paths.codexHome);
  if (isSensitive(checked)) throw Error('SSH identities and credential directories cannot be used as research scripts.');
  const actual = core.assertEPath(io.realpathSync.native(checked), { within: root });
  if (isSensitive(actual)) throw Error('The script path resolves to an SSH or credential file.');
  const info = io.statSync(actual);
  if (!info.isFile()) throw Error('ScriptPath must refer to an existing file inside the portable folder.');
  if (info.size > 8 * 1024 * 1024) throw Error('The UTF-8 research script exceeds 8 MiB.');
  const script = decodeUtf8(io.readFileSync(actual), 'Research script');
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(script)) {
    throw Error('Private key material cannot be sent as a research script.');
  }
  return script;
}

function buildRemoteScript(remotePath, source) {
  // Validate cd independently, including in tests. No user command is a local shell argument.
  core.validateConfig({ ...core.defaultConfig, host: 'validation.invalid', remotePath });
  const script = decodeUtf8(Buffer.from(source, 'utf8'), 'Command');
  if (!script.trim()) throw Error('The research command or script is empty.');
  return Buffer.from(
    'set -e\n' +
    "cd -- '" + remotePath + "'\n" +
    'printf \'[AutoDL remote] host=%s user=%s cwd=%s\\n\' "$(hostname)" "$(id -un)" "$PWD" >&2\n' +
    script + (script.endsWith('\n') ? '' : '\n'), 'utf8');
}

function buildSshArgs(paths, connectTimeoutSeconds) {
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 300) {
    throw Error('ConnectTimeoutSeconds must be an integer between 1 and 300.');
  }
  return [
    '-F', paths.sshConfig, '-T',
    '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ConnectTimeout=' + connectTimeoutSeconds, '-o', 'ConnectionAttempts=1',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'AddKeysToAgent=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
    'autodl-research', 'bash', '-s', '--'
  ];
}

function runSsh(options, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn;
  const report = dependencies.report || (message => process.stderr.write(message + '\n'));
  const sshArgs = buildSshArgs(options.paths, options.connectTimeoutSeconds);
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 0 || options.timeoutSeconds > 2147483) {
    throw Error('TimeoutSeconds must be an integer between 0 and 2147483.');
  }
  return new Promise(resolve => {
    let timer, finished = false, forcedCode = null, forcedOutcome = null;
    let child;
    const finish = (code, outcome = 'exit') => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', cancel);
      try { dependencies.onOutcome?.(forcedOutcome || outcome); } catch { /* Telemetry must not change execution. */ }
      resolve(forcedCode === null ? code : forcedCode);
    };
    const stop = (code, explanation, outcome) => {
      if (finished || forcedCode !== null) return;
      forcedCode = code;
      forcedOutcome = outcome;
      report(explanation + ' The SSH client is closed; a remote job may continue. Use tmux/nohup explicitly for persistent jobs.');
      if (child) child.kill();
    };
    const cancel = () => stop(130, '[AutoDL] Cancelled locally.', 'cancelled');
    try {
      child = spawnProcess(options.sshExe, sshArgs, {
        cwd: options.paths.root, env: options.env,
        shell: false, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit']
      });
      child.once('error', () => {
        report('[AutoDL] Unable to start the Windows OpenSSH client. No research command was executed locally.');
        finish(127, 'start-failed');
      });
      child.once('close', (code, signal) => {
        if (forcedCode === null && code === 255) {
          report('[AutoDL] SSH connection, key authentication, or host verification failed. Run scripts/Test-SSH.ps1 -NoPause after checking the saved instance. Password fallback is disabled.');
        }
        finish(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : 255, signal === 'SIGINT' ? 'cancelled' : 'exit');
      });
      // ssh can close stdin after an early authentication failure or explicit remote exit.
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
          report('[AutoDL] Could not deliver the complete script to SSH.');
          stop(74, '[AutoDL] Script input failed.', 'input-failed');
        }
      });
      if (options.abortSignal) {
        options.abortSignal.addEventListener('abort', cancel, { once: true });
        if (options.abortSignal.aborted) cancel();
      }
      if (options.timeoutSeconds > 0) {
        timer = setTimeout(() => stop(124, '[AutoDL] TimeoutSeconds expired.', 'timeout'), options.timeoutSeconds * 1000);
      }
      child.stdin.end(options.script);
    } catch {
      if (child) child.kill();
      report('[AutoDL] Failed to start or feed SSH. No research command was executed locally.');
      finish(127, 'start-failed');
    }
  });
}

function fromBase64(value, label) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw Error(label + ' is not valid Base64.');
  }
  return decodeUtf8(Buffer.from(value, 'base64'), label);
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(['--root-base64', '--command-base64', '--script-base64', '--label-base64', '--timeout-seconds', '--connect-timeout-seconds']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.has(key) || index + 1 >= argv.length || Object.hasOwn(values, key)) {
      throw Error('Invalid or repeated invocation argument.');
    }
    values[key] = argv[index + 1];
  }
  const hasCommand = Object.hasOwn(values, '--command-base64');
  const hasScript = Object.hasOwn(values, '--script-base64');
  if (hasCommand === hasScript) throw Error('Provide exactly one of Command or ScriptPath.');
  const integer = (key, defaultValue) => {
    const value = values[key];
    if (value === undefined) return defaultValue;
    if (!/^\d+$/.test(value)) throw Error(key + ' must be a non-negative integer.');
    return Number(value);
  };
  return {
    root: core.assertEPath(fromBase64(values['--root-base64'], 'Platform root')),
    command: hasCommand ? fromBase64(values['--command-base64'], 'Command') : undefined,
    scriptPath: hasScript ? fromBase64(values['--script-base64'], 'ScriptPath') : undefined,
    label: activity.normalizeLabel(values['--label-base64'] === undefined ? undefined : fromBase64(values['--label-base64'], 'Label'), hasScript ? 'script' : 'command'),
    timeoutSeconds: integer('--timeout-seconds', 0),
    connectTimeoutSeconds: integer('--connect-timeout-seconds', 15),
  };
}

async function main(argv, dependencies = {}) {
  const createInvocation = dependencies.createInvocation || activity.createInvocation;
  const report = dependencies.report || (message => process.stderr.write(message + '\n'));
  let options;
  try { options = parseArguments(argv); }
  catch (error) {
    // Invalid requests are still visible when one unambiguous E root is supplied.
    // Never recover the source or the rejected label into a diagnostic record.
    const rootIndex = argv.indexOf('--root-base64');
    if (rootIndex >= 0 && argv.lastIndexOf('--root-base64') === rootIndex) {
      try {
        const root = core.assertEPath(fromBase64(argv[rootIndex + 1], 'Platform root'));
        createInvocation(root, { kind: argv.includes('--script-base64') ? 'script' : 'command' }, { report }).finish(2, 'validation-failed');
      } catch { /* An absent/invalid root cannot receive a journal. */ }
    }
    throw error;
  }
  let invocation, resultCode = 2, outcome = 'validation-failed';
  const metadata = { label: options.label, kind: options.scriptPath === undefined ? 'command' : 'script',
    sourceBytes: options.command === undefined ? null : Buffer.byteLength(options.command, 'utf8') };
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const { paths, config } = (dependencies.loadConnection || loadConnection)(options.root);
    metadata.target = config.user + '@' + config.host + ':' + config.port;
    metadata.remotePath = config.remotePath;
    invocation = createInvocation(options.root, metadata, { report });
    const source = options.scriptPath === undefined ? options.command : readScriptFile(options.root, config, options.scriptPath);
    metadata.sourceBytes = Buffer.byteLength(source, 'utf8');
    const script = buildRemoteScript(config.remotePath, source);
    const sshExe = core.getSshExecutable(options.root);
    const env = { ...process.env, ...core.buildStorageEnv(options.root, config) };
    report('[AutoDL] target=' + metadata.target + ' remotePath=' + config.remotePath);
    report('[AutoDL] Remote Bash only; timeout=' + (options.timeoutSeconds ? options.timeoutSeconds + 's' : 'none (wait until completion)') + '.');
    outcome = 'exit';
    resultCode = await (dependencies.runSsh || runSsh)({
      ...options, paths, sshExe, env, script, abortSignal: controller.signal
    }, { onOutcome: value => { outcome = value; } });
    return resultCode;
  } finally {
    if (!invocation) invocation = createInvocation(options.root, metadata, { report });
    invocation.finish(resultCode, outcome, metadata);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

module.exports = { decodeUtf8, normalizeSshConfig, validateConnectionSnapshot, readScriptFile, buildRemoteScript, buildSshArgs, runSsh, fromBase64, parseArguments, main };
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write('[AutoDL] ' + error.message + '\n');
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        process.stderr.write('[AutoDL] Keep the private-key ACL unchanged. In Codex, retry this command through the normal approved require_escalated tool execution.\n');
      }
      process.exitCode = 2;
    });
}
