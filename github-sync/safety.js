'use strict';

// Publication checks read Git objects, never the changing working directory.
// Known binary formats are size checked; their embedded content is not inspected.
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');

const DEFAULTS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxTextBytes: 8 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxEntries: 250000,
  maxListingBytes: 64 * 1024 * 1024,
  timeoutMs: 180000,
});
const objectCache = new Map();
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function fail(message) { throw new Error(`Publication safety check: ${message}`); }

function runGit(context, args, input, maxBytes = context.limits.maxListingBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(context.gitExe, ['-C', context.root, ...args], {
      env: { ...context.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = []; let size = 0; let failure;
    const timer = setTimeout(() => { failure = 'Git read timed out'; child.kill(); }, context.limits.timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { failure = 'Git response exceeds scan capacity'; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Never return Git stderr: paths or object contents can be private.
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'Git could not be started'; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(`Publication safety check: ${failure || 'Git object read failed'}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

function decodePath(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('a Git path is not valid UTF-8'); }
}

function pathRules(file) {
  const lower = file.toLowerCase(); const parts = lower.split('/');
  const name = parts.at(-1); const rules = [];
  if (!file || /[\x00-\x1f\x7f\\]/.test(file) || /^[a-z]:/i.test(file) || file.startsWith('/') || parts.some(p => !p || p === '.' || p === '..')) rules.push('unsafe-path');
  if (parts[0] === '学习文献' || lower.endsWith('.pdf')) rules.push('excluded-by-user-publication-scope');
  if (['data', 'app', 'exports'].includes(parts[0])) rules.push('platform-runtime-or-auth-data');
  if (parts.some(p => ['.git', '.ssh', '.agent-sync', '.aws', '.azure', '.gnupg'].includes(p))) rules.push('private-directory');
  const hub = parts.indexOf('autodl-research-hub');
  if (hub >= 0 && ['data', 'app'].includes(parts[hub + 1])) rules.push('platform-runtime-or-auth-data');
  if (['auth.json', 'credentials.json', 'credential.json', 'secrets.json', 'token.json', 'tokens.json', '.git-credentials', '.netrc', '_netrc', '.pypirc', 'cookies', 'cookies.sqlite', 'cookies.sqlite3', 'cookies.txt', 'login data', 'web data'].includes(name)) rules.push('credential-file');
  if (/^auth(?:\.[^.]+)+\.json$/.test(name) || ['hosts.yml', 'known_hosts', 'known_hosts.old', 'connection.json', 'setup-state.json', 'launch-config.json', 'state.vscdb'].includes(name)) rules.push('private-local-configuration');
  if (/\.(?:zip|7z|rar|tar|tgz|gz|bz2|xz|exe|msi|sqlite\d*(?:-(?:wal|shm))?|db)$/i.test(name)) rules.push('unreviewed-archive-executable-or-database');
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:_sk)?$/.test(name)) rules.push('ssh-private-key-file');
  if (/^\.env(?:\..+)?$/.test(name) && !/^\.env(?:\.[a-z0-9_-]+)*\.(?:example|sample|template)$/.test(name)) rules.push('environment-secrets-file');
  return rules;
}

function isPlaceholder(value) {
  // Exact low-entropy literals from this project's credential-redaction tests.
  // No arbitrary fixture/test prefix, file, directory or blob is exempted.
  if (['must-not-be-stored', 'secret-marker', 'fixture-access', 'fixture-refresh', 'fixture-api-key', 'offline-fixture-not-a-real-key'].includes(value)) return true;
  return value === '' || /^(?:none|null|undefined|false)$/i.test(value) ||
    /^<[^<>\r\n]{1,100}>$/.test(value) || /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value) ||
    /^(?:YOUR|REPLACE|INSERT|ENTER|EXAMPLE|DUMMY|FAKE|TEST)[ _-](?:API[ _-]?)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|VALUE)(?:[ _-]HERE)?$/i.test(value) ||
    /^(?:REPLACE_ME|CHANGEME|CHANGE_ME|PLACEHOLDER)$/i.test(value) || /^[xX*•]{4,}$/.test(value);
}

function secretRules(text, bareScalars = false) {
  const rules = [];
  if (/^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*$/m.test(text)) rules.push('private-key-content');
  const github = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g;
  if ([...text.matchAll(github)].some(m => !/^(?:gh[pousr]_|github_pat_)[xX]{20,}$/.test(m[0]))) rules.push('github-token-content');
  const openai = /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/g;
  if ([...text.matchAll(openai)].some(m => !/^sk-(?:(?:proj|svcacct)-)?[xX]{20,}$/.test(m[0]))) rules.push('api-secret-content');
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) rules.push('aws-access-key-content');
  // Literal credential fields only: references to environment variables are not values.
  const assignment = /(?:^|[\s{,;])(?:["']?)(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|github[_-]?token|openai[_-]?api[_-]?key|hf[_-]?token|token)(?:["']?)[ \t]*([:=])[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;#}\r\n]+))/gim;
  for (const match of text.matchAll(assignment)) {
    const value = match[3] ?? match[4] ?? match[5];
    const quoted = match[3] !== undefined || match[4] !== undefined;
    if (!quoted && !bareScalars) continue;
    if (isPlaceholder(value)) continue;
    if (/^\$(?:\{|\(|[A-Za-z_])/.test(value)) continue;
    if (!quoted && /^(?:None|null|undefined|false|str|int|float|bytes|bool)(?:[)\]:]|$)/.test(value)) continue;
    if (!quoted && /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*[.(\[]/.test(value)) continue;
    if (!quoted && value === match[1]) continue;
    // Assignment to a bare source-code identifier is a reference; YAML scalars
    // following a colon are literal configuration values and remain inspectable.
    if (!quoted && match[2] === '=' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) continue;
    if (match[1].toLowerCase() === 'token' && (value.length < 20 || (!quoted && match[2] === '='))) continue;
    if (value.length >= 4) { rules.push('literal-credential-value'); break; }
  }
  return [...new Set(rules)];
}

function knownBinary(buffer) {
  if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const pe = buffer.readUInt32LE(60);
    if (pe >= 64 && pe + 4 <= buffer.length && buffer.subarray(pe, pe + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) return true;
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp' && buffer.readUInt32BE(0) >= 16) return true;
  if (/^FCS[23]\.[01] {4}/.test(buffer.subarray(0, 12).toString('ascii'))) return true;
  if (buffer.subarray(0, 12).equals(Buffer.from('00000000efee6e4f7b141640', 'hex'))) return true;
  if (buffer.subarray(0, 19).toString('ascii') === '<stata_dta><header>') return true;
  if (buffer.subarray(0, 8).equals(Buffer.from('0005160700020000', 'hex'))) return true;
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-' ||
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    /^(?:GIF8[79]a|RIFF|wOFF|wOF2|OTTO|7z\xbc\xaf|SQLite format 3\x00)/.test(buffer.subarray(0, 20).toString('latin1')) ||
    buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) ||
    buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]));
}

function inspectContent(buffer, size, limit, bareScalars = false) {
  // Private portable backups can be renamed; inspect signatures as well as names.
  if (buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
    || buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    || buffer.subarray(0, 4).toString('ascii') === 'Rar!'
    || buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
    || buffer.subarray(0, 16).toString('ascii') === 'SQLite format 3\0'
    || buffer.subarray(257, 262).toString('ascii') === 'ustar') {
    return { rules: ['unreviewed-archive-executable-or-database'], binary: true };
  }
  if (knownBinary(buffer)) return { rules: [], binary: true };
  if (size > limit) return { rules: ['text-scan-capacity-exceeded'], binary: false };
  let text;
  try {
    if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
    else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
    else text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Legacy Western-language academic source is common. Decode it only when
    // almost all bytes are printable, and still run every credential rule.
    const controls = buffer.reduce((count, byte) => count + ((byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127 ? 1 : 0), 0);
    if (controls > Math.max(1, buffer.length * 0.01)) return { rules: ['unscannable-text-encoding'], binary: false };
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  const controls = [...text.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g)].length;
  if (controls > Math.max(1, text.length * 0.01)) return { rules: ['unrecognized-binary-format'], binary: false };
  // PDF extraction sometimes leaves a few NUL/control bytes. Remove them for
  // scanning so they cannot split and conceal a credential-shaped string.
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return { rules: secretRules(text, bareScalars), binary: false };
}

function parseEntries(listing, index) {
  const entries = []; let start = 0;
  for (let i = 0; i < listing.length; i++) {
    if (listing[i] !== 0) continue;
    const row = listing.subarray(start, i); start = i + 1;
    const tab = row.indexOf(9); if (tab < 0) fail('malformed Git tree entry');
    const header = row.subarray(0, tab).toString('ascii');
    const match = index ? /^(\d{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])$/.exec(header) : /^(\d{6}) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(header);
    if (!match) fail('malformed Git object identifier');
    entries.push({ mode: match[1], oid: index ? match[2] : match[3], stage: index ? Number(match[3]) : 0, path: decodePath(row.subarray(tab + 1)) });
  }
  if (start !== listing.length) fail('truncated Git listing');
  return entries;
}

function scanBatch(context, objects) {
  if (!objects.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn(context.gitExe, ['-C', context.root, 'cat-file', '--batch'], {
      env: { ...context.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let header = Buffer.alloc(0); let current; let position = 0; let trailer = false; let failure;
    const results = new Map();
    const stop = reason => { failure = reason; child.kill(); };
    const timer = setTimeout(() => stop('blob scan timed out'), context.limits.timeoutMs);
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'Git could not be started'; });
    child.stdout.on('data', chunk => {
      try {
        let offset = 0;
        while (offset < chunk.length && !failure) {
          if (trailer) {
            if (chunk[offset++] !== 10) { stop('invalid blob boundary'); break; }
            trailer = false; position++; continue;
          }
          if (!current) {
            const end = chunk.indexOf(10, offset);
            const piece = chunk.subarray(offset, end < 0 ? chunk.length : end);
            header = Buffer.concat([header, piece]);
            if (header.length > 200) { stop('invalid blob header'); break; }
            offset = end < 0 ? chunk.length : end + 1;
            if (end < 0) continue;
            const match = /^([a-f0-9]+) blob (\d+)$/.exec(header.toString('ascii'));
            const expected = objects[position]; header = Buffer.alloc(0);
            if (!match || !expected || match[1] !== expected.oid || Number(match[2]) !== expected.size) { stop('blob metadata changed'); break; }
            current = { ...expected, left: expected.size, captured: 0, chunks: [] };
            if (current.left === 0) { results.set(current.oid, inspectContent(Buffer.alloc(0), 0, context.limits.maxTextBytes, current.bareScalars)); current = undefined; trailer = true; }
            continue;
          }
          const count = Math.min(chunk.length - offset, current.left);
          // Binary files are streamed through without retaining their full contents.
          const cap = current.size > context.limits.maxTextBytes ? 8192 : context.limits.maxTextBytes;
          const keep = Math.min(count, Math.max(0, cap - current.captured));
          if (keep) { current.chunks.push(Buffer.from(chunk.subarray(offset, offset + keep))); current.captured += keep; }
          offset += count; current.left -= count;
          if (current.left === 0) {
            results.set(current.oid, inspectContent(Buffer.concat(current.chunks), current.size, context.limits.maxTextBytes, current.bareScalars));
            current = undefined; trailer = true;
          }
        }
      } catch { stop('blob scan failed'); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || current || trailer || header.length || position !== objects.length) reject(new Error(`Publication safety check: ${failure || 'incomplete blob scan'}`));
      else resolve(results);
    });
    child.stdin.end(objects.map(object => object.oid).join('\n') + '\n');
  });
}

async function auditTree(options = {}) {
  if (!options.root || typeof options.root !== 'string') fail('repository root is required');
  const context = { root: options.root, gitExe: options.gitExe || 'git', env: options.env || process.env, limits: { ...DEFAULTS, ...options.limits } };
  for (const value of Object.values(context.limits)) if (!Number.isSafeInteger(value) || value <= 0) fail('invalid scan limit');
  const treeish = options.treeish || ':index'; const index = treeish === ':index';
  let reference;
  if (!index) {
    if (typeof treeish !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./~^{}-]*$/.test(treeish)) fail('invalid tree reference');
    reference = (await runGit(context, ['rev-parse', '--verify', '--end-of-options', `${treeish}^{tree}`], undefined, 200)).toString('ascii').trim();
    if (!OID.test(reference)) fail('invalid tree object');
  }
  const listing = await runGit(context, index ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', reference]);
  const entries = parseEntries(listing, index);
  if (entries.length > context.limits.maxEntries) fail('file count exceeds scan capacity');
  const findings = []; const add = (path, rule) => findings.push({ path, rule });
  const unique = new Map();
  for (const entry of entries) {
    for (const rule of pathRules(entry.path)) add(entry.path, rule);
    if (entry.stage !== 0) add(entry.path, 'unmerged-index-entry');
    if (entry.mode === '120000') add(entry.path, 'symbolic-link');
    else if (entry.mode === '160000') add(entry.path, 'submodule');
    else if (!['100644', '100755'].includes(entry.mode)) add(entry.path, 'unsupported-file-mode');
    else {
      if (!unique.has(entry.oid)) unique.set(entry.oid, []);
      unique.get(entry.oid).push(entry.path);
    }
  }
  const identifiers = [...unique.keys()]; const objects = []; let totalBytes = 0;
  if (identifiers.length) {
    const info = (await runGit(context, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], identifiers.join('\n') + '\n')).toString('ascii').trim().split('\n');
    if (info.length !== identifiers.length) fail('incomplete blob metadata');
    for (let i = 0; i < info.length; i++) {
      const match = /^([a-f0-9]+) blob (\d+)$/.exec(info[i]);
      if (!match || match[1] !== identifiers[i] || !Number.isSafeInteger(Number(match[2]))) fail('invalid blob metadata');
      const size = Number(match[2]); totalBytes += size;
      if (size > context.limits.maxFileBytes) for (const path of unique.get(match[1])) add(path, 'file-exceeds-github-size-limit');
      else objects.push({ oid: match[1], size, bareScalars: unique.get(match[1]).some(file => /\.(?:ya?ml|ini|cfg|sh|bash|zsh)$|(?:^|\/)\.env(?:\.|$)/i.test(file)) });
    }
  }
  if (totalBytes > context.limits.maxTotalBytes) add('(repository)', 'total-scan-capacity-exceeded');
  // Any policy failure blocks publication. Do not read huge or disallowed files.
  if (findings.length) return { ok: false, findings, summary: { entries: entries.length, uniqueBlobs: unique.size, scannedBytes: 0, totalBytes, binaryBlobs: 0 } };
  const cacheKey = object => `${context.limits.maxTextBytes}:${object.oid}:${object.size}:${object.bareScalars}`;
  const missing = objects.filter(object => !objectCache.has(cacheKey(object)));
  const scans = await scanBatch(context, missing);
  for (const object of missing) objectCache.set(cacheKey(object), scans.get(object.oid));
  let binaryBlobs = 0;
  for (const object of objects) {
    const scan = objectCache.get(cacheKey(object));
    if (scan.binary) binaryBlobs++;
    for (const rule of scan.rules) for (const path of unique.get(object.oid)) add(path, rule);
  }
  if (objectCache.size > 100000) objectCache.clear();
  return { ok: findings.length === 0, findings, summary: { entries: entries.length, uniqueBlobs: unique.size, scannedBytes: missing.reduce((sum, object) => sum + object.size, 0), totalBytes, binaryBlobs } };
}

async function auditIndex(options) { return auditTree({ ...options, treeish: ':index' }); }
async function auditCommit(options = {}) { if (!options.commit) fail('commit is required'); return auditTree({ ...options, treeish: options.commit }); }

module.exports = { auditTree, auditIndex, auditCommit, DEFAULTS };
