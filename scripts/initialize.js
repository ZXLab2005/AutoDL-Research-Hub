'use strict';
const fs=require('node:fs');
const path=require('node:path');
const core=require('../src/core');
const freshStart=require('./fresh-start');
const root=core.assertEPath(process.argv[2] || path.join(__dirname,'..'));
const p=core.getPaths(root);
for(const dir of [p.userData,p.extensions,p.codexHome,path.join(root,'data','temp'),path.join(root,'data','logs'),path.join(root,'workspace')]) fs.mkdirSync(core.assertEPath(dir),{recursive:true});
const config=core.readConfig(root);
core.saveConfig(root,config);
const settingsPath=path.join(p.userData,'User','settings.json');
fs.mkdirSync(path.dirname(settingsPath),{recursive:true});
const settings={...core.buildSettings(root,config),
  'update.mode':'none','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,
  'telemetry.telemetryLevel':'off','workbench.startupEditor':'none','window.title':'AutoDL 研究台 · ${rootName}${separator}${appName}',
  'workbench.colorTheme':'Default Dark Modern','chatgpt.openOnStartup':false,
  'chatgpt.runCodexInWindowsSubsystemForLinux':false,
  'remote.SSH.localServerDownload':'always','remote.SSH.remotePlatform':{'autodl-research':'linux'},
  'remote.SSH.defaultExtensions':['ms-python.python','ms-python.vscode-pylance','ms-toolsai.jupyter'],
  'terminal.integrated.profiles.windows':{'研究终端':{path:path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile']}},
  'terminal.integrated.defaultProfile.windows':'研究终端',
  ...freshStart.userSettings
};
let previous={}; if(fs.existsSync(settingsPath)) { try{previous=JSON.parse(fs.readFileSync(settingsPath,'utf8'));}catch(e){throw Error('平台 settings.json 不是有效 JSON，请先修复，未覆盖原文件。');} }
fs.writeFileSync(settingsPath,JSON.stringify({...previous,...settings},null,2)+'\n');
const codexConfig=path.join(p.codexHome,'config.toml');
if(!fs.existsSync(codexConfig)) fs.writeFileSync(codexConfig,'# Research Hub: credentials and state stay inside the portable CODEX_HOME.\ncli_auth_credentials_store = "file"\n');
const workspace=path.join(root,'Research.code-workspace');
let workspaceConfig={folders:[{name:'Codex 控制台 · 本地',path:'workspace'}]};
if(fs.existsSync(workspace)) {
  try { workspaceConfig=JSON.parse(fs.readFileSync(workspace,'utf8').replace(/^\uFEFF/,'')); }
  catch { throw Error('Research.code-workspace 不是有效 JSON，未覆盖原文件。'); }
  if(!workspaceConfig || typeof workspaceConfig!=='object' || Array.isArray(workspaceConfig)) throw Error('Research.code-workspace 格式无效，未覆盖原文件。');
}
workspaceConfig.settings={...workspaceConfig.settings,...freshStart.workspaceSettings};
fs.writeFileSync(workspace,JSON.stringify(workspaceConfig,null,2)+'\n');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Invalid research hub extension version.');
const target=core.assertEPath(path.join(p.extensions,'local-research.autodl-research-hub-'+manifest.version));
fs.mkdirSync(target,{recursive:true});
fs.copyFileSync(path.join(root,'package.json'),path.join(target,'package.json'));
fs.cpSync(path.join(root,'src'),path.join(target,'src'),{recursive:true});
// Official extensions are installed into this folder by Start-Hub when absent.
// No extensions or credentials are copied from another computer's profile.
console.log('Ready: '+root+'\nApplication data: '+path.join(root,'data'));
