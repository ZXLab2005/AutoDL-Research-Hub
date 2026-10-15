'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { auditIndex, auditCommit, auditTree } = require('./safety');

const gitExe = process.env.TEST_GIT_EXE || path.resolve(__dirname, '../app/git/cmd/git.exe');
const base = path.resolve(__dirname, '..', '.agent-sync', 'temp', 'safety-tests');
fs.mkdirSync(base, { recursive: true });
const fixtures = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'repo-')); fixtures.push(root);
  const env = { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root, GIT_CONFIG_GLOBAL: path.join(root, 'absent-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args, input) => {
    const result = spawnSync(gitExe, ['-C', root, ...args], { env, input, encoding: input instanceof Buffer ? undefined : 'utf8', windowsHide: true, shell: false });
    assert.equal(result.status, 0, 'fixture Git command failed');
    return result.stdout instanceof Buffer ? result.stdout : result.stdout.trim();
  };
  git(['init', '-q']); git(['config', 'user.name', 'Safety Tests']); git(['config', 'user.email', 'safety@example.invalid']);
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content); };
  return { root, gitExe, env, git, write };
}
test.after(() => {
  for (const root of fixtures) {
    assert.ok(root.startsWith(base + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
const credential = () => ['gh', 'p_', 'A7b9C2d4E6f8G0h1J3k5L7m9N2p4Q6r8S0t1'].join('');
const privateKey = () => ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----\n', 'bm90LWFjdHVhbC1rZXktbWF0ZXJpYWw=\n', '-----END ', 'OPENSSH PRIVATE KEY-----\n'].join('');
const literal = () => ['api', '_key = "', 'real-looking-credential-12345678', '"\n'].join('');

test('index audit uses staged blob despite a clean working copy', async () => {
  const repo = fixture(); repo.write('code.txt', credential()); repo.git(['add', '--', 'code.txt']); repo.write('code.txt', 'safe unstaged replacement');
  const result = await auditIndex(repo);
  assert.equal(result.ok, false); assert.deepEqual(result.findings, [{ path: 'code.txt', rule: 'github-token-content' }]);
  assert.ok(!JSON.stringify(result).includes(credential()));
});
test('unstaged secret does not taint a clean index snapshot', async () => {
  const repo = fixture(); repo.write('code.txt', 'safe staged content'); repo.git(['add', '--', 'code.txt']); repo.write('code.txt', credential());
  assert.equal((await auditIndex(repo)).ok, true);
});
test('commit audit inspects the selected immutable tree', async () => {
  const repo = fixture(); repo.write('code.txt', 'first safe version'); repo.git(['add', '.']); repo.git(['commit', '-qm', 'safe']);
  const safe = repo.git(['rev-parse', 'HEAD']); repo.write('code.txt', credential()); repo.git(['add', '.']); repo.git(['commit', '-qm', 'unsafe']);
  const unsafe = repo.git(['rev-parse', 'HEAD']); repo.write('code.txt', 'different working tree');
  assert.equal((await auditCommit({ ...repo, commit: safe })).ok, true);
  assert.equal((await auditCommit({ ...repo, commit: unsafe })).ok, false);
});
test('credential and runtime paths are blocked without displaying file content', async () => {
  const repo = fixture();
  for (const name of ['auth.json', 'nested/.ssh/known_hosts', '.agent-sync/config.json', '.env.production', 'id_ed25519', 'cookies.sqlite', 'data/settings.json', 'app/code.exe']) repo.write(name, '{}');
  repo.git(['add', '-f', '.']); const result = await auditIndex(repo);
  assert.equal(result.ok, false); assert.equal(new Set(result.findings.map(item => item.path)).size, 8); assert.equal(result.summary.scannedBytes, 0);
});
test('local connection records, auth variants, exports and archives remain private even when force staged', async () => {
  const repo = fixture();
  const names = ['nested/auth.backup.json', 'hosts.yml', 'known_hosts', 'connection.json', 'setup-state.json',
    'launch-config.json', 'exports/readme.txt', 'portable.zip', 'backup.7z', 'database.sqlite-wal', 'launcher.exe'];
  for (const name of names) repo.write(name, '{}');
  repo.git(['add', '-f', '.']);
  const result = await auditIndex(repo);
  assert.equal(result.ok, false);
  assert.deepEqual([...new Set(result.findings.map(item => item.path))].sort(), [...names].sort());
  assert.equal(result.summary.scannedBytes, 0);
});
test('renamed archives and databases cannot bypass checks with an ordinary file extension', async () => {
  const repo = fixture();
  repo.write('backup.txt', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  repo.write('sessions.dat', Buffer.from('SQLite format 3\0'));
  repo.git(['add', '.']);
  const result = await auditIndex(repo);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(item => item.rule === 'unreviewed-archive-executable-or-database'));
});
test('user-excluded literature directory and every PDF are blocked even if force staged', async () => {
  const repo = fixture(); repo.write('学习文献/notes.md', 'excluded material'); repo.write('docs/paper.PDF', '%PDF-1.7\n'); repo.git(['add', '-f', '.']);
  const result = await auditIndex(repo);
  assert.equal(result.ok, false); assert.equal(result.findings.length, 2);
  assert.ok(result.findings.every(f => f.rule === 'excluded-by-user-publication-scope'));
});
test('public key, environment examples and ordinary token variables are accepted', async () => {
  const repo = fixture();
  repo.write('.env.example', ['API', '_KEY=YOUR_API_KEY\n'].join(''));
  repo.write('key.pub', 'ssh-ed25519 public-material-only comment');
  repo.write('sample.py', [
    ['api', '_key = "YOUR_API_KEY"'].join(''),
    ['pass', 'word = os.getenv("APP_PASSWORD")'].join(''),
    ['to', 'ken = "word"'].join(''),
    ['to', 'ken = tokenizer.decode(ids)'].join(''),
    ['access', '_token = token'].join(''),
  ].join('\n'));
  repo.git(['add', '.']); assert.equal((await auditIndex(repo)).ok, true);
});
test('actual private key delimiters and explicit credential literals are detected', async () => {
  const repo = fixture(); repo.write('key-material.txt', privateKey()); repo.write('settings.py', literal()); repo.git(['add', '.']);
  const result = await auditIndex(repo);
  assert.equal(result.ok, false); assert.ok(result.findings.some(f => f.rule === 'private-key-content')); assert.ok(result.findings.some(f => f.rule === 'literal-credential-value'));
  assert.ok(!JSON.stringify(result).includes('real-looking'));
});
test('bare YAML credential scalars are not confused with source-code references', async () => {
  const repo = fixture(); repo.write('settings.yaml', ['pass', 'word: A9b2c4d6e8f0\n'].join('')); repo.git(['add', '.']);
  const result = await auditIndex(repo);
  assert.equal(result.ok, false); assert.equal(result.findings[0].rule, 'literal-credential-value');
});
test('the detector source and synthetic tests are publishable themselves', async () => {
  const repo = fixture();
  for (const name of ['safety.js', 'safety.test.js']) repo.write(name, fs.readFileSync(path.join(__dirname, name)));
  repo.git(['add', '.']); assert.deepEqual((await auditIndex(repo)).findings, []);
});
test('UTF16 credential text is inspected and unknown encoding blocks publication', async () => {
  const repo = fixture(); repo.write('utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from(literal(), 'utf16le')]));
  repo.write('unknown.txt', Buffer.from([0xff, 0x00, 0xac, 0x01])); repo.git(['add', '.']);
  const result = await auditIndex(repo);
  assert.ok(result.findings.some(f => f.path === 'utf16.txt' && f.rule === 'literal-credential-value'));
  assert.ok(result.findings.some(f => f.path === 'unknown.txt' && f.rule === 'unscannable-text-encoding'));
});
test('size limit checks blob size, not worktree size', async () => {
  const repo = fixture(); repo.write('large.txt', 'z'.repeat(2048)); repo.git(['add', '.']); repo.write('large.txt', 'small');
  const result = await auditIndex({ ...repo, limits: { maxFileBytes: 1024 } });
  assert.deepEqual(result.findings, [{ path: 'large.txt', rule: 'file-exceeds-github-size-limit' }]);
});
test('text larger than scan bound blocks rather than skipping its tail', async () => {
  const repo = fixture(); repo.write('long.txt', 'a'.repeat(2048) + credential()); repo.git(['add', '.']);
  const result = await auditIndex({ ...repo, limits: { maxTextBytes: 1024 } });
  assert.equal(result.ok, false); assert.equal(result.findings[0].rule, 'text-scan-capacity-exceeded');
});
test('recognized large binary is streamed and retained as a publishable file', async () => {
  const repo = fixture(); repo.write('figure.png', Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(2 * 1024 * 1024)])); repo.git(['add', '.']);
  const result = await auditIndex({ ...repo, limits: { maxTextBytes: 1024 } });
  assert.equal(result.ok, true); assert.equal(result.summary.binaryBlobs, 1);
});
test('exact synthetic fixture values are accepted but added credential content still blocks', async () => {
  const repo = fixture();
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'tests/core.test.js'));
  repo.write('reviewed-example.js', source); repo.git(['add', '.']);
  const safe = await auditIndex(repo); assert.equal(safe.ok, true);
  repo.write('reviewed-example.js', Buffer.concat([source, Buffer.from('\n' + credential())])); repo.git(['add', '.']);
  const unsafe = await auditIndex(repo); assert.equal(unsafe.ok, false);
  assert.ok(unsafe.findings.some(f => f.rule === 'github-token-content'));
});
test('duplicate blobs are scanned once; capacity limits fail closed', async () => {
  const repo = fixture(); repo.write('a.txt', 'deduplicated-blob-value'); repo.write('b.txt', 'deduplicated-blob-value'); repo.git(['add', '.']);
  const result = await auditIndex(repo); assert.equal(result.ok, true); assert.equal(result.summary.uniqueBlobs, 1);
  const limited = await auditIndex({ ...repo, limits: { maxTotalBytes: 10 } });
  assert.equal(limited.ok, false); assert.equal(limited.findings[0].rule, 'total-scan-capacity-exceeded');
  await assert.rejects(auditIndex({ ...repo, limits: { maxEntries: 1 } }), /capacity/);
});
test('symlink and submodule modes are rejected without following their target', async () => {
  const repo = fixture(); repo.write('ordinary.txt', 'base'); repo.git(['add', '.']); repo.git(['commit', '-qm', 'base']);
  const blob = repo.git(['hash-object', '-w', '--stdin'], '../outside/private-key');
  repo.git(['update-index', '--add', '--cacheinfo', `120000,${blob},pointer`]);
  repo.git(['update-index', '--add', '--cacheinfo', `160000,${repo.git(['rev-parse', 'HEAD'])},nested-repository`]);
  const result = await auditIndex(repo);
  assert.ok(result.findings.some(f => f.rule === 'symbolic-link')); assert.ok(result.findings.some(f => f.rule === 'submodule'));
});
test('malicious tree paths are rejected', async () => {
  const repo = fixture(); const blob = repo.git(['hash-object', '-w', '--stdin'], 'safe');
  const rawTree = Buffer.concat([Buffer.from('100644 ../escape\0'), Buffer.from(blob, 'hex')]);
  const tree = repo.git(['hash-object', '--literally', '-t', 'tree', '-w', '--stdin'], rawTree).toString('ascii').trim();
  const result = await auditTree({ ...repo, treeish: tree });
  assert.equal(result.ok, false); assert.ok(result.findings.some(f => f.rule === 'unsafe-path'));
});
test('invalid references and oversized listings fail without echoing secrets', async () => {
  const repo = fixture(); repo.write('normal.txt', 'safe'); repo.git(['add', '.']);
  await assert.rejects(auditCommit({ ...repo, commit: '--help' }), /invalid tree reference/);
  await assert.rejects(auditIndex({ ...repo, limits: { maxListingBytes: 5 } }), /capacity/);
});
