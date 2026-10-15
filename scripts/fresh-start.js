'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../src/core');

// These are supported settings in the bundled VS Code installation. Editor
// restoration is separate from its dirty-working-copy backup recovery: keep
// hot exit enabled and leave Backups, workspaceStorage and credentials alone.
const workspaceSettings = Object.freeze({
  'workbench.editor.restoreEditors': false,
  'workbench.editor.restoreViewState': false,
  'terminal.integrated.enablePersistentSessions': false,
  'terminal.integrated.persistentSessionReviveProcess': 'never',
  'terminal.integrated.hideOnStartup': 'always',
  'chatgpt.openOnStartup': false,
});

const userSettings = Object.freeze({
  ...workspaceSettings,
  'window.restoreWindows': 'none',
  'workbench.startupEditor': 'none',
  'files.hotExit': 'onExit',
});

function writeLaunchSession(root) {
  root = core.getPaths(root).root;
  const data = core.assertEPath(path.join(root, 'data'), { within: root });
  fs.mkdirSync(data, { recursive: true });
  const file = core.assertEPath(path.join(data, 'launch-session.json'), { within: root });
  const temporary = core.assertEPath(`${file}.${crypto.randomUUID()}.tmp`, { within: root });
  const session = { version: 1, id: crypto.randomUUID(), startedAt: new Date().toISOString(), mode: 'fresh-home' };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    core.assertEPath(file, { within: root });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return session;
}

module.exports = { workspaceSettings, userSettings, writeLaunchSession };

if (require.main === module) {
  const session = writeLaunchSession(process.argv[2] || path.join(__dirname, '..'));
  console.log(`Fresh home ready: ${session.id}`);
}
