'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core');

const MAX_READ_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 4096;
const STATUSES = new Set(['running', 'succeeded', 'failed', 'timed-out', 'cancelled']);

function normalizeLabel(value, kind = 'command') {
  if (value === undefined || value === '') return kind === 'script' ? '远端脚本' : '远端命令';
  if (typeof value !== 'string' || [...value].length > 120 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) || !value.trim()) {
    throw Error('Label must be a non-empty single-line action title of at most 120 characters.');
  }
  // Labels are explicit action titles, never inferred from command/script text.
  if (/-----BEGIN|\bBearer\s|\bsk-[A-Za-z0-9]|(?:token|password|secret|api[_-]?key)\s*[:=]/i.test(value)) {
    throw Error('Label must not contain credentials.');
  }
  return value.trim();
}

function journalPath(root) {
  const paths = core.getPaths(root);
  return core.assertEPath(path.win32.join(paths.logs, 'activity.jsonl'), { within: paths.root });
}

function safeRecord(input) {
  if (!input || input.version !== 1 || !['started', 'finished'].includes(input.event)
      || !/^[a-f0-9-]{36}$/i.test(input.invocationId || '')
      || !Number.isFinite(Date.parse(input.timestamp))
      || !['command', 'script'].includes(input.kind) || !STATUSES.has(input.status)) throw Error('Invalid activity record.');
  if (input.target !== null && (typeof input.target !== 'string' || input.target.length > 340
      || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9.:[\]-]+:[0-9]{1,5}$/.test(input.target))) throw Error('Invalid activity target.');
  if (input.remotePath !== null) core.validateConfig({ ...core.defaultConfig, host: 'validation.invalid', remotePath: input.remotePath });
  const nullableInteger = (value, maximum) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maximum);
  if (!nullableInteger(input.sourceBytes, Number.MAX_SAFE_INTEGER)
      || !nullableInteger(input.durationMs, Number.MAX_SAFE_INTEGER)
      || !nullableInteger(input.exitCode, 255)
      || typeof input.remoteMayContinue !== 'boolean') throw Error('Invalid activity result.');
  if (input.event === 'started' && (input.status !== 'running' || input.exitCode !== null || input.durationMs !== null)) throw Error('Invalid activity start.');
  if (input.event === 'finished' && (input.status === 'running' || input.exitCode === null || input.durationMs === null)) throw Error('Invalid activity end.');
  // Construct a strict allowlist: unknown properties (especially source/output) cannot reach disk/UI.
  return {
    version: 1, event: input.event, invocationId: input.invocationId,
    timestamp: new Date(input.timestamp).toISOString(), target: input.target, remotePath: input.remotePath,
    label: normalizeLabel(input.label, input.kind), kind: input.kind, sourceBytes: input.sourceBytes,
    status: input.status, exitCode: input.exitCode, durationMs: input.durationMs,
    remoteMayContinue: input.remoteMayContinue,
  };
}

function appendActivity(root, record, io = fs) {
  const file = journalPath(root);
  const directory = core.assertEPath(path.win32.dirname(file), { within: root });
  const line = '\n' + JSON.stringify(safeRecord(record)) + '\n';
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw Error('Activity record exceeds the size limit.');
  io.mkdirSync(directory, { recursive: true });
  core.assertEPath(file, { within: root });
  // One append per record; the leading separator recovers after an interrupted partial write.
  io.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
}

function createInvocation(root, metadata = {}, dependencies = {}) {
  const write = dependencies.append || appendActivity;
  const report = dependencies.report || (message => process.stderr.write(message + '\n'));
  const now = dependencies.now || Date.now;
  const started = now();
  const kind = metadata.kind === 'script' ? 'script' : 'command';
  const base = {
    version: 1, invocationId: crypto.randomUUID(), target: metadata.target || null,
    remotePath: metadata.remotePath || null, label: normalizeLabel(metadata.label, kind), kind,
    sourceBytes: Number.isSafeInteger(metadata.sourceBytes) && metadata.sourceBytes >= 0 ? metadata.sourceBytes : null,
  };
  let warned = false, ended = false;
  const emit = record => {
    try { write(root, safeRecord(record)); }
    catch {
      if (!warned) {
        warned = true;
        try { report('[AutoDL] Activity journal unavailable; SSH execution is unaffected.'); } catch { /* Logging is best effort. */ }
      }
    }
  };
  emit({ ...base, event: 'started', timestamp: new Date(started).toISOString(), status: 'running', exitCode: null, durationMs: null, remoteMayContinue: false });
  return {
    invocationId: base.invocationId,
    finish(exitCode, outcome = 'exit', updated = {}) {
      if (ended) return;
      ended = true;
      const code = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 2;
      const status = outcome === 'timeout' ? 'timed-out' : outcome === 'cancelled' ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
      const finished = now();
      emit({ ...base,
        target: updated.target || base.target, remotePath: updated.remotePath || base.remotePath,
        sourceBytes: Number.isSafeInteger(updated.sourceBytes) && updated.sourceBytes >= 0 ? updated.sourceBytes : base.sourceBytes,
        event: 'finished', timestamp: new Date(finished).toISOString(), status, exitCode: code,
        durationMs: Math.max(0, finished - started), remoteMayContinue: ['timeout', 'cancelled', 'input-failed'].includes(outcome),
      });
    },
  };
}

function readActivity(root, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(200, options.limit)) : 60;
  const empty = { activities: [], events: [], summary: { running: 0, succeeded: 0, failed: 0 }, truncated: false };
  let descriptor;
  try {
    const file = journalPath(root);
    try { descriptor = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const bytes = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, count).toString('utf8').split('\n');
    if (start > 0) lines.shift(); // May start in the middle of a UTF-8 record.
    lines.pop(); // An unfinished concurrent append is not a record yet.
    const parsed = [];
    for (const line of lines) {
      if (!line.trim() || Buffer.byteLength(line) > MAX_RECORD_BYTES) continue;
      try { parsed.push(safeRecord(JSON.parse(line))); } catch { /* Skip malformed/interrupted records. */ }
    }
    const grouped = new Map();
    for (const record of parsed) {
      const previous = grouped.get(record.invocationId);
      if (previous?.endedAt && record.event === 'started') continue;
      grouped.set(record.invocationId, {
        ...record,
        startedAt: record.event === 'started' ? record.timestamp : previous?.startedAt || null,
        endedAt: record.event === 'finished' ? record.timestamp : null,
      });
    }
    const all = [...grouped.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const activities = all.slice(0, limit);
    const events = parsed.slice(-limit * 2);
    const summary = { running: 0, succeeded: 0, failed: 0 };
    for (const item of activities) summary[item.status === 'running' ? 'running' : item.status === 'succeeded' ? 'succeeded' : 'failed']++;
    return { activities, events, summary, truncated: start > 0 || all.length > limit };
  } catch {
    return { ...empty, error: '操作记录暂时不可读取。' };
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Read-only close. */ }
  }
}

module.exports = { MAX_READ_BYTES, normalizeLabel, journalPath, safeRecord, appendActivity, createInvocation, readActivity };
