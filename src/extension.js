'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const core = require('./core');
const activity = require('./activity');
const { startWatch } = require('./folder-watch');
const { render } = require('./view');
const session = require('./session');
let panel;

function readSetupState(root, config) {
  const fallback = { publicKeyRegistered: false, sshVerified: false };
  const publicFingerprint = file => {
    try {
      const keyFile = core.assertEPath(file);
      const publicKey = fs.readFileSync(keyFile, 'utf8').trim().split(/\s+/);
      if (!publicKey[0] || !publicKey[1]) return '';
      return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(publicKey[1], 'base64')).digest('base64').replace(/=+$/, '');
    } catch { return ''; }
  };
  try {
    const file = core.assertEPath(path.join(root, 'data', 'setup-state.json'), { within: root });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return fallback;
    const fingerprint = publicFingerprint(path.join(root, 'data', 'ssh', 'id_ed25519.pub'));
    const publicKeyRegistered = !!fingerprint && saved.publicKeyRegistered === true && saved.fingerprint === fingerprint;
    const selectedFingerprint = config?.identityFile ? publicFingerprint(config.identityFile + '.pub') : '';
    // Older successful records used the registered public fingerprint. Keep
    // those valid, but new authentication records do not depend on portal registration.
    const verifiedFingerprint = saved.verifiedFingerprint || (publicKeyRegistered ? saved.fingerprint : '');
    return {
      publicKeyRegistered,
      sshVerified: !!selectedFingerprint && selectedFingerprint === verifiedFingerprint && saved.sshVerified === true
        && saved.verifiedConnection?.host === config?.host
        && saved.verifiedConnection?.port === config?.port
        && saved.verifiedConnection?.user === config?.user
        && saved.verifiedConnection?.identityFile === config?.identityFile,
      account: typeof saved.account === 'string' ? saved.account : '',
      remark: typeof saved.remark === 'string' ? saved.remark : '',
      fingerprint,
    };
  } catch {
    // A missing, malformed, unreadable, or stale record is never proof of setup.
    return fallback;
  }
}

function activate(context) {
  const root = core.assertEPath(process.env.RESEARCH_HUB_ROOT || context.extensionPath);
  const paths = core.getPaths(root);
  const output = vscode.window.createOutputChannel('AutoDL 研究台');
  fs.mkdirSync(paths.logs,{recursive:true});
  const log = text => fs.appendFileSync(path.join(paths.logs,'hub.log'),new Date().toISOString()+' '+text+'\n');
  log('activated: '+root+'; remote='+(vscode.env.remoteName || 'local')+'; version='+(context.extension?.packageJSON?.version || 'development'));
  const ssh = core.getSshExecutable(root);
  const keygen = core.getSshExecutable(root, 'ssh-keygen');
  const keyPath = path.join(root, 'data', 'ssh', 'id_ed25519');
  const verificationTerminals = new Set();
  const requireTrusted = () => {
    if(!vscode.workspace.isTrusted) throw Error('当前处于受限模式。请点击“管理工程信任”，在 VS Code 中核对并信任此工作区后再操作。');
  };
  const cfg = () => { requireTrusted(); return core.readConfig(root); };
  const requireHost = () => { const c = cfg(); if (!c.host) throw Error('先粘贴 AutoDL 的 SSH 命令并保存连接。'); return c; };
  let liveTimer, liveBusy=false, watcher, watchGeneration=0, watchEnabled=true, watchedKey='', extensionDisposed=false;
  let liveRequested=false, sessionStartedAt=new Date().toISOString(), launchId='', launchWatching=false, freshPromise;
  let fileChanges=[], totalFileChanges=0, watchStatus={state:'waiting',message:'信任工作区后开始监视共用的远端项目目录。'};
  let liveQueue=Promise.resolve();
  const panelVisible=()=>!extensionDisposed && !!panel && panel.visible!==false;
  const liveVisible=()=>liveRequested && panelVisible();
  const targetKey=c=>JSON.stringify([c.host,c.port,c.user,c.remotePath,c.identityFile]);
  function postWatch() {
    if(vscode.workspace.isTrusted && liveVisible()) panel.webview.postMessage({type:'watch',data:{...watchStatus,enabled:watchEnabled,changes:fileChanges,totalChanges:totalFileChanges}});
  }
  async function haltWatch() {
    watchGeneration++;
    const old=watcher;watcher=undefined;watchedKey='';
    if(old) await old.stop();
  }
  async function reconcileWatch(config) {
    if(!vscode.workspace.isTrusted || !liveVisible()) { await haltWatch();return; }
    if(!watchEnabled) { await haltWatch();watchStatus={...watchStatus,state:'stopped',message:'文件监视已暂停。操作记录仍会刷新。'};postWatch();return; }
    if(!config.host) { await haltWatch();watchStatus={state:'waiting',message:'保存 SSH 连接后开始监视。'};postWatch();return; }
    const key=targetKey(config);
    if(watcher && watchedKey===key)return;
    await haltWatch();
    if(!vscode.workspace.isTrusted || !liveVisible() || !watchEnabled)return;
    const generation=watchGeneration;
    watchedKey=key;fileChanges=[];totalFileChanges=0;
    watchStatus={state:'connecting',message:'正在连接远端目录，建立文件快照…',remotePath:config.remotePath};postWatch();
    try {
      const current=await Promise.resolve(startWatch(root,config,{
        onStatus:status=>{
          if(generation!==watchGeneration || !vscode.workspace.isTrusted || !liveVisible())return;
          watchStatus={...watchStatus,...status};postWatch();
        },
        onEvent:event=>{
          if(generation!==watchGeneration || !vscode.workspace.isTrusted || !liveVisible())return;
          const timestamp=event.timestamp || new Date().toISOString();
          if(['baseline','change','scan'].includes(event.type)) watchStatus={...watchStatus,lastScanAt:timestamp,fileCount:event.filesCount,directoriesCount:event.directoriesCount,complete:event.complete,truncated:event.truncated,omittedChanges:event.omittedChanges || 0};
          if(event.type==='baseline' && event.complete!==false) watchStatus={...watchStatus,state:'watching',message:'初始快照已建立，正在监视文件变化。'};
          if(event.type==='change') {
            const changes=Array.isArray(event.changes)?event.changes:[];
            totalFileChanges+=changes.length+(Number.isSafeInteger(event.omittedChanges)&&event.omittedChanges>0?event.omittedChanges:0);
            fileChanges=[...changes.map(change=>({...change,timestamp})).reverse(),...fileChanges].slice(0,80);
          }
          postWatch();
        },
      }));
      if(generation!==watchGeneration || !vscode.workspace.isTrusted || !liveVisible()) { await current.stop();return; }
      watcher=current;
    } catch {
      if(generation!==watchGeneration)return;
      watchedKey='';watchEnabled=false;
      watchStatus={...watchStatus,state:'error',message:'文件监视启动失败。请检查 SSH 连接，再点击“开始监视”重试。'};postWatch();
    }
  }
  async function refreshLive() {
    if(!vscode.workspace.isTrusted || !liveVisible())return;
    const config=cfg();
    const snapshot=session.currentActivity(activity.readActivity(root,{limit:60}),sessionStartedAt);
    await panel.webview.postMessage({type:'activity',data:{...snapshot,updatedAt:new Date().toISOString()}});
    if(watchedKey && watchedKey!==targetKey(config)) await refresh();
    await reconcileWatch(config);
  }
  function requestLiveRefresh() {
    liveQueue=liveQueue.catch(()=>{}).then(async()=>{
      if(!vscode.workspace.isTrusted || !liveVisible())return;
      try {await refreshLive();} catch {
        await haltWatch().catch(()=>{});
        watchStatus={...watchStatus,state:'error',message:'实时监视暂不可用，请核对已保存的连接后重试。'};postWatch();
      }
    });
    return liveQueue;
  }
  async function startLive() {
    if(!vscode.workspace.isTrusted || !liveVisible())return;
    if(!liveTimer)liveTimer=setInterval(()=>{
      if(liveBusy)return;
      liveBusy=true;requestLiveRefresh().finally(()=>{liveBusy=false;});
    },2000);
    await requestLiveRefresh();
  }
  async function pauseLive() {
    if(liveTimer)clearInterval(liveTimer);liveTimer=undefined;
    await haltWatch();
  }
  function freshHome() {
    if(freshPromise)return freshPromise;
    freshPromise=resetHome().finally(()=>{freshPromise=undefined;});
    return freshPromise;
  }
  async function resetHome() {
    sessionStartedAt=new Date().toISOString();liveRequested=false;watchEnabled=true;
    const resetLocal=!vscode.env.remoteName && core.codexConsoleAction('',vscode.workspace.workspaceFile,root)==='open-sidebar';
    const tabs=resetLocal?session.savedTabsToClose(vscode.window.tabGroups?.all):[];
    // Show the fresh home before awaiting remote watcher shutdown. Never wait
    // for tunnel diagnostics, or close tabs opened after the reset began.
    await open(false);
    await panel?.webview.postMessage({type:'resetView',sessionStartedAt});
    await pauseLive();fileChanges=[];totalFileChanges=0;
    watchStatus={state:'waiting',message:'进入“实时动态”后开始本次会话监视。'};
    if(resetLocal) {
      if(tabs.length && vscode.window.tabGroups?.close) await vscode.window.tabGroups.close(tabs,true);
      for(const command of ['workbench.action.closePanel','workbench.action.closeSidebar','workbench.action.closeAuxiliaryBar']) {
        await vscode.commands.executeCommand(command);
      }
    }
    log('fresh home; preserved authentication, journals, research files and unsaved editors');
  }
  function watchLaunches() {
    if(launchWatching || vscode.env.remoteName || !vscode.workspace.isTrusted
      || core.codexConsoleAction('',vscode.workspace.workspaceFile,root)!=='open-sidebar')return;
    launchWatching=true;
    launchId=session.readLaunchSession(root,fs)?.id || '';
    const file=core.assertEPath(path.join(root,'data','launch-session.json'),{within:root});
    const changed=()=>{
      if(extensionDisposed || !vscode.workspace.isTrusted)return;
      const marker=session.readLaunchSession(root,fs);
      if(marker && marker.id!==launchId){launchId=marker.id;guarded(freshHome);}
    };
    if(typeof fs.watchFile==='function') {
      fs.watchFile(file,{interval:1000,persistent:false},changed);
      context.subscriptions.push({dispose:()=>fs.unwatchFile(file,changed)});
    }
  }
  const localTerminal = (name, shellPath, shellArgs) => {
    requireTrusted();
    if (vscode.env.remoteName) throw Error('此操作需要本机终端，请回到最初的本地“AutoDL 研究台”窗口操作。');
    // This UI extension always runs locally, including in Remote SSH windows.
    const t = vscode.window.createTerminal({ name, shellPath, shellArgs, cwd: root, isTransient: true });
    t.show(); return t;
  };
  async function tunnelAction(action, quiet=false) {
    requireTrusted();
    const launch=JSON.parse(fs.readFileSync(path.join(root,'launch-config.json'),'utf8'));
    const nodeExe=core.assertEPath(launch.nodeExe);
    if(!quiet) panel?.webview.postMessage({type:'notice',text:action==='stop'?'正在安全停止后台隧道…':'正在确认后台代理隧道，请等待 SSH 握手完成…'});
    let result;
    try {
      const {stdout}=await run(nodeExe,[path.join(root,'scripts','tunnel.js'),action,root],
        {windowsHide:true,timeout:90000,maxBuffer:1024*1024,env:{...process.env,...core.buildStorageEnv(root,cfg())}});
      result=JSON.parse(stdout.trim());
    } catch(error) {
      try {result=JSON.parse(error.stdout?.trim() || '{}');} catch {}
      const message=result?.message || error.message;
      if(action==='status')return {status:'error',message};
      await refreshTunnel();
      throw Error(message);
    }
    if(action!=='status') {
      panel?.webview.postMessage({type:'tunnelState',data:result});
      if(!quiet)panel?.webview.postMessage({type:'notice',text:result.message+(result.reused?' 已复用现有连接。':'')});
    }
    return result;
  }
  async function refreshTunnel() {
    if(!vscode.workspace.isTrusted) return;
    if(panel)panel.webview.postMessage({type:'tunnelState',data:await tunnelAction('status',true)});
  }
  async function state() {
    if(!vscode.workspace.isTrusted) return {
      trusted:false, config:{...core.defaultConfig}, root, keyReady:false,
      setup:{publicKeyRegistered:false,sshVerified:false}, remote:vscode.env.remoteName || '',
      tunnelState:{status:'restricted',message:'受限模式下不检查或操作隧道。'},
      extensions:['ms-vscode-remote.remote-ssh','openai.chatgpt'].map(id=>({id,ready:false})),
    };
    const config = cfg();
    return { trusted:true, config, root, keyReady: fs.existsSync(keyPath + '.pub'), setup: readSetupState(root, config),
      remote: vscode.env.remoteName || '', tunnelState: await tunnelAction('status',true),
      extensions: ['ms-vscode-remote.remote-ssh', 'openai.chatgpt'].map(id => ({ id, ready: !!vscode.extensions.getExtension(id) })) };
  }
  async function refresh() { if (panel) await panel.webview.postMessage({ type: 'state', data: await state() }); }
  async function refreshSetup() {
    if(!vscode.workspace.isTrusted) { await refresh(); return; }
    if (panel) await panel.webview.postMessage({ type: 'setup', data: {
      keyReady: fs.existsSync(keyPath + '.pub'), setup: readSetupState(root, cfg()),
    } });
  }
  async function guarded(fn) { try { await fn(); } catch (e) { log('error: '+e.message); output.appendLine(e.message); vscode.window.showErrorMessage(e.message); if(panel) panel.webview.postMessage({ type:'notice', text: e.message, error:true }); } }
  context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
    // Refresh just the status after this verification, preserving connection drafts.
    if (verificationTerminals.delete(terminal)) guarded(refreshSetup);
  }));
  async function connect() {
    requireTrusted();
    const c = requireHost();
    if (!vscode.extensions.getExtension('ms-vscode-remote.remote-ssh')) throw Error('Remote SSH 尚未安装，请先点击“安装 / 修复扩展”。');
    if(c.tunnel) await tunnelAction('ensure');
    const uri = vscode.Uri.from(core.buildRemoteProjectUriData(c));
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow:true });
  }
  async function openCodex() {
    requireTrusted();
    const action=core.codexConsoleAction(vscode.env.remoteName,vscode.workspace.workspaceFile,root);
    if(action==='return-local') {
      const message='当前是远端编辑器，仅用于查看与调试。请回到本地“Codex 控制台”窗口操作 Codex；默认通过免密 SSH 读写和运行 AutoDL 项目，无需在服务器登录 Codex。';
      vscode.window.showInformationMessage(message);
      panel?.webview.postMessage({type:'notice',text:message});
      return;
    }
    if(action==='open-workspace') {
      await vscode.commands.executeCommand('vscode.openFolder',vscode.Uri.file(path.join(root,'Research.code-workspace')),{forceNewWindow:false});
      return;
    }
    if(!vscode.workspace.isTrusted) {
      vscode.window.showInformationMessage('请先通过 VS Code 的正常提示核对并信任这个本地控制台工程，再使用 Codex。');
      return;
    }
    if(!vscode.extensions.getExtension('openai.chatgpt')) throw Error('本地 Codex 尚未安装，请点击“安装 / 修复扩展”。');
    await vscode.commands.executeCommand('chatgpt.openSidebar');
  }
  async function startRemoteCodex(update=false) {
    requireTrusted();
    if(vscode.env.remoteName) {
      const message='请回到本地 Codex 控制台点击此按钮。此入口通过本机 SSH 启动远端 Codex CLI，不需要远端 IDE 扩展。';
      vscode.window.showInformationMessage(message);
      panel?.webview.postMessage({type:'notice',text:message});
      return;
    }
    const c=requireHost();
    const target=c.user+'@'+c.host+':'+c.port+' · '+c.remotePath;
    if(c.tunnel) await tunnelAction('ensure');
    panel?.webview.postMessage({type:'notice',text:(update?'正在更新远端 Codex CLI：':'正在安装并启动远端 Codex CLI：')+target+(update?'':'。远端已有可识别的登录状态时直接复用；否则按需同步本机 auth.json，终端不会显示凭据内容。')});
    localTerminal(update?'更新远端 Codex CLI':'远端 Codex CLI',path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','Start-RemoteCodex.ps1'),...(update?['-Update','-InstallOnly']:[])]);
  }
  let automaticTerminalRequested=false;
  async function openSsh(automatic=false) {
    const c=requireHost();
    const name='AutoDL 项目 · '+(path.posix.basename(c.remotePath)||'/');
    if(!vscode.env.remoteName) {
      localTerminal(name,ssh,core.buildProjectSshArgs(root,c));
      return;
    }
    const target=core.buildRemoteProjectUriData(c);
    const matches=uri=>uri?.scheme===target.scheme && uri.authority===target.authority
      && path.posix.normalize(uri.path)===path.posix.normalize(target.path);
    const folder=vscode.workspace.workspaceFolders?.find(item=>matches(item.uri));
    if(vscode.env.remoteName!=='ssh-remote' || !folder) {
      if(automatic)return;
      throw Error('当前窗口的目录与研究台保存的远端项目不同。请回到本地研究台保存所需目录，并重新点击“远端编辑 / 调试”，让文件、终端和 Codex 使用同一目录。');
    }
    if(automatic && automaticTerminalRequested)return;
    // URI selects the remote terminal backend even though this extension runs locally.
    // A remote title alone is not evidence that the file/terminal services connected.
    let info;
    try { info=await vscode.workspace.fs.stat(folder.uri); }
    catch { throw Error('远端文件服务尚未连接成功，未创建项目终端。请查看“Remote - SSH”输出并重新连接；install－本地是连接安装终端。'); }
    requireTrusted();
    if(!(info.type & vscode.FileType.Directory))throw Error('保存的远端研究路径不是目录，未创建项目终端。');
    if(automatic && automaticTerminalRequested)return;
    log('remote project filesystem ready: '+folder.uri.path);
    const terminal=vscode.window.createTerminal({name,cwd:folder.uri,isTransient:true});
    automaticTerminalRequested=true;
    terminal.show();
    log('remote project terminal requested: '+folder.uri.path);
    terminal.processId?.then(pid=>{if(Number.isInteger(pid))log('remote project terminal process started: '+pid+'; cwd='+folder.uri.path);}).catch(()=>{});
  }
  async function generateKey() {
    requireTrusted();
    core.assertEPath(keyPath);
    fs.mkdirSync(path.dirname(keyPath), { recursive:true });
    if (!fs.existsSync(keyPath)) {
      await run(keygen, ['-t','ed25519','-N','','-C','autodl-research-hub','-f',keyPath], { windowsHide:true, timeout:30000 });
    }
    // Restrict the private key to this Windows account, never print its contents.
    const { stdout } = await run('whoami.exe', [], { windowsHide:true });
    await run('icacls.exe', [keyPath, '/inheritance:r', '/grant:r', stdout.trim() + ':(F)'], { windowsHide:true });
    if (!fs.existsSync(keyPath + '.pub')) {
      const r = await run(keygen, ['-y','-f',keyPath], { windowsHide:true });
      fs.writeFileSync(keyPath + '.pub', r.stdout.trim() + '\n');
    }
    const c = cfg(); c.identityFile = keyPath; core.saveConfig(root,c);
    vscode.window.showInformationMessage('专用密钥已保存在平台 data/ssh 文件夹。点击“复制公钥”，在 AutoDL 设置 SSH 免密登录中添加。');
    await refresh();
  }
  async function openBrowser() {
    requireTrusted();
    const candidates = [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft','Edge','Application','msedge.exe'),path.join(process.env.ProgramFiles || 'C:\\Program Files','Google','Chrome','Application','chrome.exe')];
    const exe = candidates.find(p => fs.existsSync(p));
    if (!exe) throw Error('未找到浏览器。请在已有浏览器打开 https://www.autodl.com/console/instance/list');
    const profile = core.assertEPath(path.join(root,'data','browser'));
    fs.mkdirSync(profile,{recursive:true});
    const child = spawn(exe, ['--user-data-dir='+profile,'--disk-cache-dir='+path.join(profile,'cache'),'--no-first-run','--no-default-browser-check','https://www.autodl.com/console/instance/list'],{detached:true,stdio:'ignore',windowsHide:true});
    child.on('error',e=>vscode.window.showErrorMessage(e.message)); child.unref();
  }
  async function probe(host,port) {
    requireTrusted();
    return new Promise(resolve=>{ const s=net.createConnection({host,port}); let done=false; const end=v=>{if(done)return;done=true;s.destroy();resolve(v);}; s.setTimeout(3500);s.once('connect',()=>end('端口可达'));s.once('timeout',()=>end('超时 / 未开机'));s.once('error',e=>end(e.code || '不可达')); });
  }
  async function diagnose() {
    requireTrusted();
    const c=cfg(); const rows=[];
    rows.push('平台目录：'+root, 'SSH 配置：'+paths.sshConfig, 'Codex 数据：'+paths.codexHome);
    for (const id of ['ms-vscode-remote.remote-ssh','openai.chatgpt']) rows.push(id+'：'+(vscode.extensions.getExtension(id)?'已安装':'未安装'));
    if (c.useProxy) { const u=new URL(c.proxyUrl); rows.push('本机代理：'+await probe(u.hostname.replace(/^\[|\]$/g,''),Number(u.port || 80))); }
    rows.push('SSH：'+(c.host?await probe(c.host,c.port):'尚未填写主机'));
    rows.push('密钥：'+(fs.existsSync(keyPath)?'平台私钥存在':'尚未生成'));
    rows.push('说明：端口可达不代表认证成功；请在 SSH 终端核对主机指纹并登录。');
    output.clear(); output.appendLine(rows.join('\n')); output.show(true);
    panel?.webview.postMessage({type:'notice',text:rows.join('\n')});
  }
  async function open(refreshState=true) {
    if(panel){panel.reveal();if(refreshState)await refresh();await startLive();return;}
    panel=vscode.window.createWebviewPanel('researchHub','AutoDL 研究台',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[]});
    panel.webview.html=render(crypto.randomBytes(18).toString('hex'));
    panel.onDidDispose(()=>{panel=undefined;liveRequested=false;pauseLive().catch(()=>{});},null,context.subscriptions);
    panel.onDidChangeViewState(()=>{
      if(panelVisible()) guarded(startLive);else pauseLive().catch(()=>{});
    },null,context.subscriptions);
    panel.webview.onDidReceiveMessage(m=>guarded(async()=>{
      if(!m || typeof m.type!=='string') throw Error('无效的研究台操作。');
      if(freshPromise && !['ready','resetSession'].includes(m.type)) await freshPromise;
      if(!['ready','trust','readme','remoteHelp','resetSession','liveVisibility'].includes(m.type)) requireTrusted();
      switch(m.type){
        case 'ready': log('dashboard webview ready'); await refresh(); await startLive(); break;
        case 'liveVisibility': {
          liveRequested=m.visible===true && vscode.workspace.isTrusted;
          if(liveRequested)await startLive();else await pauseLive();
          break;
        }
        case 'resetSession': await freshHome(); break;
        case 'trust': await vscode.commands.executeCommand('workbench.trust.manage'); break;
        case 'parse': { const parsed=core.parseSshCommand(m.command); if(!parsed.identityFile) delete parsed.identityFile; panel.webview.postMessage({type:'parsed',data:parsed}); break; }
        case 'save': { const saved=core.saveConfig(root,m.config); const file=path.join(paths.userData,'User','settings.json'); const old=JSON.parse(fs.readFileSync(file,'utf8')); fs.writeFileSync(core.assertEPath(file),JSON.stringify({...old,...core.buildSettings(root,saved)},null,2)+'\n'); await refresh(); await requestLiveRefresh(); panel.webview.postMessage({type:'notice',text:'连接已保存到平台文件夹。代理设置更改后，请关闭本平台的 VS Code 窗口并从启动入口重新打开。'}); break; }
        case 'watchStart': watchEnabled=true;await haltWatch();await startLive();break;
        case 'watchStop': watchEnabled=false;await haltWatch();watchStatus={...watchStatus,state:'stopped',message:'文件监视已暂停。操作记录仍会刷新。'};postWatch();break;
        case 'activityRefresh': await requestLiveRefresh();break;
        case 'connect': await connect(); break;
        case 'ssh': await openSsh(); break;
        case 'verify': requireHost(); verificationTerminals.add(localTerminal('验证 AutoDL 免密登录',path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','Test-SSH.ps1')])); break;
        case 'tunnel': requireHost(); await tunnelAction('ensure'); break;
        case 'stopTunnel': await tunnelAction('stop'); break;
        case 'tunnelStatus': await refreshTunnel(); break;
        case 'bootstrap': if(requireHost().tunnel) await tunnelAction('ensure'); localTerminal('准备 AutoDL 研究环境',path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','Setup-Remote.ps1')]); break;
        case 'key': await generateKey(); break;
        case 'copyKey': if(!fs.existsSync(keyPath+'.pub')) throw Error('请先生成专用密钥。'); await vscode.env.clipboard.writeText(fs.readFileSync(keyPath+'.pub','utf8').trim()); vscode.window.showInformationMessage('已复制公钥。私钥没有复制。'); break;
        case 'console': await openBrowser(); break;
        case 'codex': await openCodex(); break;
        case 'remoteCodex': await startRemoteCodex(); break;
        case 'updateRemoteCodex': await startRemoteCodex(true); break;
        case 'diagnose': await diagnose(); break;
        case 'install': localTerminal('安装研究扩展',path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','Start-Hub.ps1'),'-InstallExtensions','-NoLaunch']); break;
        case 'readme': await vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(path.join(root,'README.md'))); break;
        case 'remoteHelp': await vscode.commands.executeCommand('markdown.showPreview',vscode.Uri.file(path.join(root,'REMOTE.md'))); break;
      }
    }),null,context.subscriptions);
  }
  let tunnelPolling=false, tunnelTimer;
  function startTunnelPolling() {
    if(tunnelTimer || !vscode.workspace.isTrusted) return;
      tunnelTimer=setInterval(()=>{if(vscode.workspace.isTrusted&&panelVisible()&&!tunnelPolling){tunnelPolling=true;refreshTunnel().catch(e=>log('tunnel status: '+e.message)).finally(()=>{tunnelPolling=false;});}},8000);
  }
  startTunnelPolling();
  context.subscriptions.push({dispose:()=>{if(tunnelTimer)clearInterval(tunnelTimer);}});
  context.subscriptions.push({dispose:()=>{extensionDisposed=true;pauseLive().catch(()=>{});}});
  context.subscriptions.push(output,
    vscode.commands.registerCommand('researchHub.open',()=>guarded(open)),
    vscode.commands.registerCommand('researchHub.connect',()=>guarded(connect)),
    vscode.commands.registerCommand('researchHub.ssh',()=>guarded(async()=>openSsh())));
  const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,90);
  status.text='$(remote) AutoDL 研究台';status.command='researchHub.open';status.show();context.subscriptions.push(status);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(()=>guarded(async()=>{
    await refresh();
    if(panel) panel.reveal();
    startTunnelPolling();
    watchLaunches();
    await startLive();
    if(vscode.env.remoteName) await openSsh(true);
  })));
  if(!vscode.env.remoteName) {
    guarded(async()=>{await open();await freshHome();});
    watchLaunches();
  }
  else if(vscode.workspace.isTrusted) guarded(()=>openSsh(true));
}
module.exports={activate,deactivate(){},readSetupState};
