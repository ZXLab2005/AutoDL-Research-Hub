'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');

function readLaunchSession(root, io = fs) {
  try {
    const file = core.assertEPath(path.join(root, 'data', 'launch-session.json'), { within: root });
    const value = JSON.parse(io.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.mode !== 'fresh-home' || !/^[a-f0-9-]{36}$/i.test(value.id)
        || !Number.isFinite(Date.parse(value.startedAt))) return null;
    return { id: value.id, startedAt: new Date(value.startedAt).toISOString() };
  } catch { return null; }
}

// Filter presentation only. Historical journals, auth and research files are untouched.
function currentActivity(snapshot, since) {
  const boundary = Date.parse(since);
  const activities = (snapshot.activities || []).filter(item => Number.isFinite(boundary)
    && Date.parse(item.startedAt || item.timestamp) >= boundary);
  const ids = new Set(activities.map(item => item.invocationId));
  const events = (snapshot.events || []).filter(item => ids.has(item.invocationId));
  const summary = { running: 0, succeeded: 0, failed: 0 };
  for (const item of activities) summary[item.status === 'running' ? 'running' : item.status === 'succeeded' ? 'succeeded' : 'failed']++;
  return { ...snapshot, activities, events, summary, sessionStartedAt: since };
}

function savedTabsToClose(groups) {
  return (groups || []).flatMap(group => group.tabs || [])
    .filter(tab => {
      if (tab.isDirty || ['researchHub', 'mainThreadWebview-researchHub'].includes(tab.input?.viewType)) return false;
      // Only close saved file editors. Terminal editors and unknown webviews may
      // own running processes or unsaved state even when isDirty is false.
      const uris = [tab.input?.uri, tab.input?.original, tab.input?.modified].filter(Boolean);
      return uris.length > 0 && !uris.some(uri => uri.scheme === 'untitled');
    });
}
module.exports = { readLaunchSession, currentActivity, savedTabsToClose };
