'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const activity = require('../src/activity');
const bridge = require('../scripts/invoke-autodl');
const core = require('../src/core');
const platform = path.resolve(__dirname, '..');
const b64 = value => Buffer.from(value, 'utf8').toString('base64');

function fixture(t) {
  const parent = core.assertEPath(path.join(platform, 'data', 'temp'), { within: platform });
  fs.mkdirSync(parent, { recursive: true });
  const root = core.assertEPath(fs.mkdtempSync(path.join(parent, 'activity-test-')), { within: parent });
  t.after(() => {
    // Resolve and verify the exact generated directory immediately before recursive cleanup.
    core.assertEPath(fs.realpathSync.native(root), { within: parent });
    assert.match(path.basename(root), /^activity-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function metadata(extra = {}) {
  return { label: '检查 Search-R1 安装进度', kind: 'command', target: 'root@connect.example.com:24470',
    remotePath: '/root/projects', sourceBytes: 15, ...extra };
}

test('journal reports bridge start/end with safe allowlisted metadata and preserves Unicode labels', t => {
  const root = fixture(t);
  const record = activity.createInvocation(root, metadata({ command: 'password=DO_NOT_LOG', stdout: 'PRIVATE_OUTPUT', auth: 'TOKEN' }));
  let live = activity.readActivity(root);
  assert.equal(live.activities.length, 1);
  assert.equal(live.activities[0].status, 'running');
  assert.equal(live.summary.running, 1);
  record.finish(0);
  record.finish(255); // Idempotent finish.
  live = activity.readActivity(root);
  assert.equal(live.events.length, 2);
  assert.equal(live.activities[0].status, 'succeeded');
  assert.equal(live.activities[0].label, '检查 Search-R1 安装进度');
  assert.equal(live.activities[0].target, 'root@connect.example.com:24470');
  assert.equal(live.activities[0].exitCode, 0);
  assert.ok(live.activities[0].startedAt);
  assert.ok(live.activities[0].endedAt);
  assert.doesNotMatch(fs.readFileSync(activity.journalPath(root), 'utf8'), /DO_NOT_LOG|PRIVATE_OUTPUT|TOKEN|"command":|"stdout":|"auth":/);
});

test('nonzero remote codes differ from actual timeout/cancel and never claim detached job completion', t => {
  const root = fixture(t);
  for (const [code, outcome, status, remoteMayContinue] of [
    [37, 'exit', 'failed', false], [124, 'exit', 'failed', false], [130, 'exit', 'failed', false],
    [124, 'timeout', 'timed-out', true], [130, 'cancelled', 'cancelled', true],
    [127, 'start-failed', 'failed', false], [74, 'input-failed', 'failed', true],
  ]) {
    const item = activity.createInvocation(root, metadata());
    item.finish(code, outcome);
    const found = activity.readActivity(root).activities.find(value => value.invocationId === item.invocationId);
    assert.equal(found.exitCode, code);
    assert.equal(found.status, status);
    assert.equal(found.remoteMayContinue, remoteMayContinue);
  }
});

test('journal write failure is best effort, generic and reported only once for both events', () => {
  const reports = [];
  const invocation = activity.createInvocation(platform, metadata(), {
    append() { throw Error('secret filesystem detail'); }, report: message => reports.push(message),
  });
  assert.doesNotThrow(() => invocation.finish(37));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /SSH execution is unaffected/);
  assert.doesNotMatch(reports[0], /secret/);
});

test('reader ignores malformed/partial data and bounds memory and record count', t => {
  const root = fixture(t);
  const file = activity.journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(activity.MAX_READ_BYTES + 65536) + '\n{bad-json}\n{"partial":');
  const item = activity.createInvocation(root, metadata());
  item.finish(0);
  fs.appendFileSync(file, '{"unterminated":');
  const live = activity.readActivity(root, { limit: 1 });
  assert.equal(live.truncated, true);
  assert.equal(live.activities.length, 1);
  assert.equal(live.events.length, 2);
  assert.equal(live.activities[0].invocationId, item.invocationId);
  assert.equal(live.activities[0].status, 'succeeded');
});

test('concurrent writers retain separate complete invocations without rewriting the journal', async t => {
  const root = fixture(t);
  const modulePath = require.resolve('../src/activity');
  const source = `const {workerData,parentPort}=require('node:worker_threads');
    const activity=require(workerData.modulePath);
    for(let i=0;i<10;i++){const a=activity.createInvocation(workerData.root,{label:'并发操作',kind:'script'});a.finish(i%2);}
    parentPort.postMessage('done');`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { root, modulePath } });
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(Error('worker exit=' + code)));
  })));
  const live = activity.readActivity(root, { limit: 100 });
  assert.equal(live.events.length, 80);
  assert.equal(live.activities.length, 40);
  assert.equal(live.summary.succeeded, 20);
  assert.equal(live.summary.failed, 20);
  assert.equal(live.summary.running, 0);
  assert.ok(live.activities.every(value => value.startedAt && value.endedAt));
});

test('labels are explicit UTF-8 titles, validated and never extracted from commands', () => {
  const prefix = ['--root-base64', b64(platform), '--command-base64', b64('echo SECRET_COMMAND_CONTENT')];
  assert.equal(bridge.parseArguments(prefix).label, '远端命令');
  assert.equal(bridge.parseArguments([...prefix, '--label-base64', b64('启动 Search-R1 安装')]).label, '启动 Search-R1 安装');
  for (const label of ['a\nb', 'a\u2028b', 'x'.repeat(121), 'Bearer SECRET', 'password=SECRET', 'sk-abc123']) {
    assert.throws(() => bridge.parseArguments([...prefix, '--label-base64', b64(label)]), /Label/);
  }
  assert.throws(() => activity.journalPath('relative-path'));
});

test('bridge main journals metadata only and preserves remote failure exit code', async t => {
  const root = fixture(t);
  const config = { ...core.defaultConfig, host: 'connect.example.com', port: 24470,
    remotePath: '/root/projects', identityFile: path.join(root, 'key') };
  const source = 'printf "%s" "SUPER_SECRET_COMMAND"; exit 37';
  const code = await bridge.main(['--root-base64', b64(root), '--command-base64', b64(source), '--label-base64', b64('验证环境')], {
    loadConnection: () => ({ paths: core.getPaths(root), config }), report() {},
    runSsh: async options => { assert.match(options.script.toString(), /SUPER_SECRET_COMMAND/); return 37; },
  });
  assert.equal(code, 37);
  const live = activity.readActivity(root);
  assert.equal(live.activities[0].status, 'failed');
  assert.equal(live.activities[0].exitCode, 37);
  assert.equal(live.activities[0].sourceBytes, Buffer.byteLength(source));
  assert.equal(live.activities[0].target, 'root@connect.example.com:24470');
  assert.doesNotMatch(fs.readFileSync(activity.journalPath(root), 'utf8'), /SUPER_SECRET_COMMAND/);
});

test('bridge validation failure records a safe failed invocation without replacing the original error', async t => {
  const root = fixture(t);
  await assert.rejects(bridge.main(['--root-base64', b64(root), '--command-base64', b64('echo hidden')], {
    loadConnection() { throw Error('known hosts missing'); }, report() {},
  }), /known hosts missing/);
  const live = activity.readActivity(root);
  assert.equal(live.activities[0].target, null);
  assert.equal(live.activities[0].status, 'failed');
  assert.equal(live.activities[0].exitCode, 2);
  assert.doesNotMatch(fs.readFileSync(activity.journalPath(root), 'utf8'), /known hosts missing|hidden/);
});

test('invalid CLI arguments get a generic failed event when a unique platform root is available', async t => {
  const root = fixture(t);
  await assert.rejects(bridge.main(['--root-base64', b64(root), '--command-base64', b64('echo hidden'),
    '--label-base64', b64('password=REJECTED_SECRET')], { report() {} }), /Label/);
  const live = activity.readActivity(root);
  assert.equal(live.activities[0].label, '远端命令');
  assert.equal(live.activities[0].exitCode, 2);
  assert.equal(live.activities[0].sourceBytes, null);
  assert.doesNotMatch(fs.readFileSync(activity.journalPath(root), 'utf8'), /REJECTED_SECRET|hidden/);
});

test('bridge SSH execution continues when both journal appends fail', async () => {
  const reports = [];
  const config = { ...core.defaultConfig, host: 'connect.example.com', identityFile: path.join(platform, 'workspace', 'test-key') };
  const code = await bridge.main(['--root-base64', b64(platform), '--command-base64', b64('exit 0')], {
    loadConnection: () => ({ paths: core.getPaths(platform), config }),
    report: value => reports.push(value), runSsh: async () => 0,
    createInvocation: (root, value, dependencies) => activity.createInvocation(root, value, { ...dependencies, append() { throw Error('no write'); } }),
  });
  assert.equal(code, 0);
  assert.equal(reports.filter(value => value.includes('journal unavailable')).length, 1);
});
