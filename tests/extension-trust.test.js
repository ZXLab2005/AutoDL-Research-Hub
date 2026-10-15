'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {promisify}=require('node:util');
const core=require('../src/core');
const {render}=require('../src/view');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src','extension.js'),'utf8');

function harness({trusted=false,remote='',folders,stat=async()=>({type:2}),tabs=[],stopWatch=async()=>{}}={}) {
  const calls={exec:[],spawn:[],net:[],terminals:[],commands:[],messages:[],errors:[],reads:[],exists:[],clipboard:[],stats:[],sentText:[],configReads:0,saves:0,reveals:0,activityReads:0,watches:[]};
  const registered=new Map(),timers=[],trustListeners=[];
  let receive,viewListener,disposeListener,launchListener,launchMarker=null;
  calls.closedTabs=[];
  const saved={...core.defaultConfig,host:'connect.example.com',port:23456,tunnel:false,identityFile:path.join(root,'tests','fixture-key')};
  const fakeCore={...core,
    assertEPath:value=>value,
    getPaths:()=>({logs:path.join(root,'data','logs'),sshConfig:path.join(root,'data','ssh','config'),userData:path.join(root,'data','vscode-user'),codexHome:path.join(root,'data','codex')}),
    readConfig:()=>{calls.configReads++;return {...saved};},
    saveConfig:()=>{calls.saves++;return {...saved};},
    buildStorageEnv:()=>({}),
    codexConsoleAction:remoteName=>remoteName?'return-local':'open-sidebar',
  };
  const fakeFs={
    mkdirSync(){},appendFileSync(){},writeFileSync(){},
    existsSync:file=>{calls.exists.push(file);return false;},
    readFileSync:file=>{
      calls.reads.push(file);
      if(file.endsWith('launch-session.json')&&launchMarker)return JSON.stringify(launchMarker);
      if(file.endsWith('launch-config.json'))return JSON.stringify({nodeExe:'E:\\Node\\node.exe'});
      throw Error('fixture has no setup or credential files');
    },
    watchFile:(_file,_options,callback)=>{launchListener=callback;},unwatchFile(){},
  };
  const execFile=()=>{throw Error('unexpected callback process API');};
  execFile[promisify.custom]=async(...args)=>{calls.exec.push(args);return {stdout:JSON.stringify({status:'stopped',message:'offline fixture'}),stderr:''};};
  const disposable=()=>({dispose(){}});
  const panel={
    visible:true,
    webview:{html:'',postMessage:async message=>{calls.messages.push(message);return true;},onDidReceiveMessage:callback=>{receive=callback;return disposable();}},
    reveal(){calls.reveals++;this.visible=true;},onDidDispose:callback=>{disposeListener=callback;return disposable();},
    onDidChangeViewState:callback=>{viewListener=callback;return disposable();},
  };
  const workspace={
    isTrusted:trusted,workspaceFile:{scheme:'file',fsPath:path.join(root,'Research.code-workspace')},
    workspaceFolders:folders ?? (remote?[{uri:core.buildRemoteProjectUriData(saved)}]:[]),
    fs:{stat:async uri=>{calls.stats.push(uri);return stat(uri);}},
    onDidGrantWorkspaceTrust:callback=>{trustListeners.push(callback);return disposable();},
  };
  const vscode={workspace,
    env:{remoteName:remote,clipboard:{writeText:async text=>calls.clipboard.push(text)}},
    extensions:{getExtension:id=>({id})},
    ViewColumn:{One:1},StatusBarAlignment:{Left:0},FileType:{Unknown:0,File:1,Directory:2,SymbolicLink:64},
    Uri:{file:fsPath=>({scheme:'file',fsPath}),from:value=>value},
    commands:{registerCommand:(id,callback)=>{registered.set(id,callback);return disposable();},executeCommand:async(...args)=>{calls.commands.push(args);}},
    window:{
      tabGroups:{all:[{tabs}],close:async items=>{calls.closedTabs.push(...items);return true;}},
      createOutputChannel:()=>({appendLine(){},clear(){},show(){},dispose(){}}),
      createWebviewPanel:()=>panel,
      createStatusBarItem:()=>({show(){},dispose(){}}),
      onDidCloseTerminal:disposable,
      showErrorMessage:message=>calls.errors.push(message),showInformationMessage(){},
      createTerminal:options=>{calls.terminals.push(options);return {show(){},sendText:text=>calls.sentText.push(text)};},
    },
  };
  const module={exports:{}};
  const context={module,exports:module.exports,process:{env:{RESEARCH_HUB_ROOT:root,SystemRoot:'C:\\Windows'}},
    setInterval:callback=>{timers.push(callback);return timers.length;},clearInterval(){},
    require:name=>{
      if(name==='vscode')return vscode;
      if(name==='node:fs')return fakeFs;
      if(name==='node:net')return {createConnection:options=>{calls.net.push(options);throw Error('unexpected network');}};
      if(name==='node:child_process')return {execFile,spawn:(...args)=>{calls.spawn.push(args);throw Error('unexpected spawn');}};
      if(name==='./core')return fakeCore;
      if(name==='./view')return {render};
      if(name==='./session')return require('../src/session');
      if(name==='./activity')return {readActivity:()=>{calls.activityReads++;return {activities:[],events:[],summary:{running:0,succeeded:0,failed:0}};}};
      if(name==='./folder-watch')return {startWatch:(root,config,callbacks)=>{const record={root,config,callbacks,stopped:false};calls.watches.push(record);return {stop:async()=>{record.stopped=true;await stopWatch();}};}};
      return require(name);
    },
  };
  vm.runInNewContext(source,context,{filename:'extension.js'});
  module.exports.activate({extensionPath:root,subscriptions:[]});
  return {calls,registered,timers,workspace,panel,saved,
    flush:async()=>{await new Promise(resolve=>setImmediate(resolve));},
    send:async message=>{assert.equal(typeof receive,'function');await receive(message);},
    grant:async()=>{workspace.isTrusted=true;for(const listener of trustListeners)await listener();},
    poll:async()=>{for(const timer of timers)timer();await new Promise(resolve=>setImmediate(resolve));},
    visibility:async value=>{panel.visible=value;await viewListener();await new Promise(resolve=>setImmediate(resolve));},
    close:async()=>{disposeListener();await new Promise(resolve=>setImmediate(resolve));},
    newLaunch:async()=>{launchMarker={version:1,mode:'fresh-home',id:'11111111-2222-3333-4444-555555555555',startedAt:new Date().toISOString()};launchListener?.();await new Promise(resolve=>setImmediate(resolve));},
  };
}

test('manifest supports a limited dashboard while executable commands remain trust-gated',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.match(manifest.version,/^1\.\d+\.\d+$/);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported,'limited');
  assert.ok(manifest.capabilities.untrustedWorkspaces.description);
  for(const id of ['researchHub.connect','researchHub.ssh'])assert.equal(manifest.contributes.commands.find(command=>command.command===id).enablement,'isWorkspaceTrusted');
});

test('restricted activation, ready and polling show the dashboard without reading connection or executing processes',async()=>{
  const h=harness();
  assert.match(h.panel.webview.html,/AUTODL \/ RESEARCH HUB/);
  await h.send({type:'ready'});await h.poll();
  const state=h.calls.messages.find(message=>message.type==='state').data;
  assert.equal(state.trusted,false);assert.equal(state.config.host,core.defaultConfig.host);
  assert.equal(h.calls.configReads,0);assert.equal(h.calls.reads.length,0);assert.equal(h.calls.exists.length,0);
  assert.equal(h.calls.activityReads,0);assert.equal(h.calls.watches.length,0);
  assert.equal(h.timers.length,0);assert.equal(h.calls.exec.length,0);assert.equal(h.calls.spawn.length,0);assert.equal(h.calls.net.length,0);
  assert.equal(h.calls.commands.some(command=>command[0]==='chatgpt.openSidebar'),false);
});

test('forged webview messages and direct commands cannot execute in Restricted Mode',async()=>{
  const h=harness();
  for(const type of ['save','ssh','install','tunnel','stopTunnel','tunnelStatus','copyKey','remoteCodex','updateRemoteCodex','key','verify','bootstrap','console','connect','diagnose','codex','parse','unknownCommand','watchStart','watchStop','activityRefresh']) {
    await h.send({type,config:h.saved,command:'ssh root@example.com'});
  }
  await h.registered.get('researchHub.connect')();await h.registered.get('researchHub.ssh')();
  assert.equal(h.calls.errors.length,23);
  assert.equal(h.calls.activityReads,0);assert.equal(h.calls.watches.length,0);
  assert.equal(h.calls.configReads,0);assert.equal(h.calls.reads.length,0);assert.equal(h.calls.saves,0);
  for(const key of ['exec','spawn','net','terminals','clipboard'])assert.equal(h.calls[key].length,0,key);
});

test('trust enables operations but Codex opens only after an explicit action',async()=>{
  const h=harness();await h.flush();
  await h.send({type:'trust'});
  assert.equal(h.workspace.isTrusted,false);
  assert.equal(h.calls.commands.at(-1)[0],'workbench.trust.manage');
  assert.equal(h.calls.configReads,0);assert.equal(h.calls.exec.length,0);
  await h.grant();
  const state=h.calls.messages.filter(message=>message.type==='state').at(-1).data;
  assert.equal(state.trusted,true);assert.equal(state.config.host,h.saved.host);
  assert.ok(h.calls.reveals>=1);assert.equal(h.timers.length,1);
  assert.equal(h.calls.commands.some(command=>command[0]==='chatgpt.openSidebar'),false);
  await h.send({type:'codex'});
  assert.equal(h.calls.commands.at(-1)[0],'chatgpt.openSidebar');
  assert.equal(h.calls.commands.some(command=>/workbench.*chat/i.test(command[0])),false);
  await h.registered.get('researchHub.connect')();await h.registered.get('researchHub.ssh')();
  assert.equal(h.calls.commands.at(-1)[0],'vscode.openFolder');
  assert.equal(h.calls.commands.at(-1)[1].authority,'ssh-remote+autodl-research');
  assert.equal(h.calls.terminals.length,1);
  assert.deepEqual(Array.from(h.calls.terminals[0].shellArgs),core.buildProjectSshArgs(root,h.saved));
  assert.match(h.calls.terminals[0].shellArgs.at(-1),/cd -- '\/root\/autodl-tmp\/research-hub\/projects' &&/);
  assert.equal(h.calls.stats.length,0);
  h.workspace.isTrusted=false;
  const count=h.calls.exec.length;await h.poll();assert.equal(h.calls.exec.length,count);
});

test('remote SSH windows enforce the same gate and never auto-open local Codex',async()=>{
  const h=harness({remote:'ssh-remote'});
  await h.registered.get('researchHub.open')();
  await h.send({type:'ready'});await h.send({type:'remoteCodex'});await h.registered.get('researchHub.ssh')();
  assert.equal(h.calls.exec.length,0);assert.equal(h.calls.reads.length,0);assert.equal(h.calls.terminals.length,0);
  assert.equal(h.calls.stats.length,0);
  await h.grant();
  assert.equal(h.calls.messages.filter(message=>message.type==='state').at(-1).data.trusted,true);
  assert.equal(h.calls.commands.some(command=>command[0]==='chatgpt.openSidebar'),false);
  assert.equal(h.calls.terminals.length,1);
  assert.equal(h.calls.terminals[0].cwd,h.workspace.workspaceFolders[0].uri);
});

test('trusted Remote SSH activation opens a remote project terminal only after its filesystem is ready',async()=>{
  let resolveStat;
  const pending=new Promise(resolve=>{resolveStat=resolve;});
  const h=harness({trusted:true,remote:'ssh-remote',stat:()=>pending});
  assert.equal(h.calls.stats.length,1);
  assert.equal(h.calls.terminals.length,0);
  resolveStat({type:2});await h.flush();
  assert.equal(h.calls.errors.length,0);assert.equal(h.calls.terminals.length,1);
  const options=h.calls.terminals[0];
  assert.equal(options.cwd,h.workspace.workspaceFolders[0].uri);
  assert.equal(options.cwd.scheme,'vscode-remote');
  assert.equal(options.cwd.authority,'ssh-remote+autodl-research');
  assert.equal(options.cwd.path,h.saved.remotePath);
  assert.match(options.name,/projects/);assert.equal(options.isTransient,true);
  assert.equal(Object.hasOwn(options,'shellPath'),false);
  assert.equal(Object.hasOwn(options,'shellArgs'),false);
  assert.equal(Object.hasOwn(options,'env'),false);
  assert.equal(h.calls.sentText.length,0);
  assert.equal(h.calls.exec.length,0);assert.equal(h.calls.spawn.length,0);
  await h.grant();
  assert.equal(h.calls.terminals.length,1,'another automatic event must not duplicate the terminal');
  await h.registered.get('researchHub.ssh')();
  assert.equal(h.calls.terminals.length,2,'an explicit new project terminal remains available');
});

test('other remote authorities, folders and providers cannot open a project terminal',async()=>{
  const target={scheme:'vscode-remote',authority:'ssh-remote+autodl-research',path:core.defaultConfig.remotePath};
  for(const [remote,uri] of [
    ['ssh-remote',{...target,authority:'ssh-remote+another-server'}],
    ['ssh-remote',{...target,path:target.path+'-unrelated'}],
    ['ssh-remote',{...target,path:target.path+'/nested'}],
    ['ssh-remote',{...target,scheme:'file'}],
    ['dev-container',target],
  ]) {
    const h=harness({trusted:true,remote,folders:[{uri}]});await h.flush();
    assert.equal(h.calls.errors.length,0,'automatic activation quietly skips an unrelated workspace');
    assert.equal(h.calls.stats.length,0);assert.equal(h.calls.terminals.length,0);
    await h.registered.get('researchHub.ssh')();
    assert.equal(h.calls.errors.length,1);
    assert.match(h.calls.errors[0],/目录与研究台保存的远端项目不同/);
    assert.equal(h.calls.stats.length,0);assert.equal(h.calls.terminals.length,0);
  }
});

test('unavailable remote filesystem and nondirectory paths fail without creating any terminal',async()=>{
  for(const [stat,message] of [
    [async()=>{throw Error('No file system provider found');},/远端文件服务尚未连接成功/],
    [async()=>({type:1}),/不是目录/],
  ]) {
    const h=harness({trusted:true,remote:'ssh-remote',stat});await h.flush();
    assert.equal(h.calls.errors.length,1);assert.match(h.calls.errors[0],message);
    assert.equal(h.calls.terminals.length,0);assert.equal(h.calls.sentText.length,0);
    await h.registered.get('researchHub.ssh')();
    assert.equal(h.calls.errors.length,2);assert.equal(h.calls.stats.length,2);
    assert.equal(h.calls.terminals.length,0);
  }
});

test('trust is rechecked after the asynchronous remote filesystem request',async()=>{
  let resolveStat;
  const pending=new Promise(resolve=>{resolveStat=resolve;});
  const h=harness({trusted:true,remote:'ssh-remote',stat:()=>pending});
  assert.equal(h.calls.stats.length,1);
  h.workspace.isTrusted=false;
  resolveStat({type:2});await h.flush();
  assert.equal(h.calls.terminals.length,0);
  assert.equal(h.calls.errors.length,1);assert.match(h.calls.errors[0],/受限模式/);
  await h.grant();
  assert.equal(h.calls.terminals.length,1,'a genuine later trust event can retry');
});

function webviewHarness(){
  const html=render('test');
  const nodes=[],byId=new Map();
  const makeNode=(tag,properties={})=>({tag,dataset:{},disabled:false,textContent:'',value:'',checked:false,className:'',children:[],append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},...properties});
  for(const match of html.matchAll(/<(input|button|div|p|b)\b([^>]*)>/g)) {
    const attr=match[2],id=/\bid="([^"]+)"/.exec(attr)?.[1],action=/\bdata-action="([^"]+)"/.exec(attr)?.[1];
    const node=makeNode(match[1],{id,dataset:action?{action}:{},type:/\btype="([^"]+)"/.exec(attr)?.[1]||''});
    nodes.push(node);if(id)byId.set(id,node);
  }
  let onMessage;
  const document={createElement:tag=>makeNode(tag),getElementById:id=>{assert.ok(byId.has(id),id);return byId.get(id);},querySelectorAll:selector=>selector==='[data-action]'?nodes.filter(node=>node.dataset.action):nodes.filter(node=>['input','button'].includes(node.tag))};
  const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{document,window:{addEventListener:(_,callback)=>{onMessage=callback;}},acquireVsCodeApi:()=>({postMessage(){}})});
  return {html,nodes,byId,onMessage};
}

test('dashboard disables inputs and execution buttons until trusted, including stale tunnel status',()=>{
  const {nodes,byId,onMessage}=webviewHarness();
  for(const node of nodes.filter(node=>['input','button'].includes(node.tag)))assert.equal(node.disabled,!['trust','readme','remoteHelp'].includes(node.dataset.action));
  const state={trusted:true,config:{...core.defaultConfig,host:'example.com'},root,extensions:[],setup:{},tunnelState:{status:'running',message:'active'}};
  onMessage({data:{type:'state',data:state}});assert.equal(byId.get('host').disabled,false);assert.equal(byId.get('stopTunnel').disabled,false);
  onMessage({data:{type:'state',data:{...state,trusted:false}}});
  onMessage({data:{type:'tunnelState',data:{status:'running'}}});
  assert.equal(byId.get('host').disabled,true);assert.equal(byId.get('stopTunnel').disabled,true);
  assert.equal(nodes.find(node=>node.dataset.action==='trust').disabled,false);
});

test('monitor starts only inside a visible trusted activity screen and stops on leaving',async()=>{
  const h=harness();await h.flush();await h.send({type:'ready'});
  assert.equal(h.calls.watches.length,0);
  await h.grant();assert.equal(h.calls.watches.length,0);
  await h.send({type:'liveVisibility',visible:true});assert.equal(h.calls.watches.length,1);
  assert.equal(h.calls.watches[0].config.remotePath,h.saved.remotePath);
  await h.visibility(false);assert.equal(h.calls.watches[0].stopped,true);
  const reads=h.calls.activityReads;await h.poll();assert.equal(h.calls.activityReads,reads);
  await h.visibility(true);assert.equal(h.calls.watches.length,2);
  await h.send({type:'liveVisibility',visible:false});assert.equal(h.calls.watches[1].stopped,true);
  await h.send({type:'liveVisibility',visible:true});assert.equal(h.calls.watches.length,3);
  await h.close();assert.equal(h.calls.watches[2].stopped,true);
});

test('fresh home and repeated launches preserve dirty editors and never start Codex or SSH',async()=>{
  const clean={isDirty:false,input:{uri:{path:'previous.py'}}};
  const dirty={isDirty:true,input:{uri:{path:'unsaved.py'}}};
  const dashboard={isDirty:false,input:{viewType:'researchHub'}};
  const h=harness({trusted:true,tabs:[clean,dirty,dashboard]});await h.flush();
  assert.deepEqual(h.calls.closedTabs,[clean]);
  assert.equal(h.calls.terminals.length,0);assert.equal(h.calls.watches.length,0);
  assert.equal(h.calls.commands.some(command=>command[0]==='chatgpt.openSidebar'),false);
  assert.ok(h.calls.messages.some(message=>message.type==='resetView'));
  await h.send({type:'liveVisibility',visible:true});
  const first=h.calls.watches[0];assert.ok(first);
  first.callbacks.onEvent({type:'change',changes:[{type:'added',path:'old-session.py'}]});
  const resets=h.calls.messages.filter(message=>message.type==='resetView').length;
  await h.newLaunch();
  assert.equal(first.stopped,true);
  assert.equal(h.calls.messages.filter(message=>message.type==='resetView').length,resets+1);
  const reads=h.calls.activityReads;await h.poll();assert.equal(h.calls.activityReads,reads);
  await h.newLaunch();
  assert.equal(h.calls.messages.filter(message=>message.type==='resetView').length,resets+1,'the same launch marker is not applied twice');
  await h.send({type:'resetSession'});
  assert.equal(h.calls.messages.filter(message=>message.type==='resetView').length,resets+2);
  await h.send({type:'liveVisibility',visible:true});
  const snapshot=h.calls.messages.filter(message=>message.type==='watch').at(-1).data;
  assert.equal(snapshot.changes.length,0);assert.equal(snapshot.totalChanges,0);
  assert.ok(h.calls.closedTabs.every(tab=>tab===clean));
  assert.equal(h.calls.saves,0);assert.equal(h.calls.terminals.length,0);
});

test('restricted visibility and reset messages never read credentials or launch a watcher',async()=>{
  const h=harness();await h.flush();
  await h.send({type:'liveVisibility',visible:true});await h.send({type:'resetSession'});
  await h.newLaunch();await h.poll();
  assert.equal(h.calls.configReads,0);assert.equal(h.calls.reads.length,0);
  assert.equal(h.calls.watches.length,0);assert.equal(h.calls.terminals.length,0);
  assert.equal(h.calls.exec.length,0);
});

test('overlapping resets coalesce and a new action waits for the reset to finish',async()=>{
  let releaseStop;
  const pendingStop=new Promise(resolve=>{releaseStop=resolve;});
  const h=harness({trusted:true,stopWatch:()=>pendingStop});await h.flush();
  await h.send({type:'liveVisibility',visible:true});
  const count=h.calls.messages.filter(message=>message.type==='resetView').length;
  const reset=h.send({type:'resetSession'});await h.flush();
  const concurrentReset=h.send({type:'resetSession'});
  const nextAction=h.send({type:'codex'});await h.flush();
  assert.equal(h.calls.messages.filter(message=>message.type==='resetView').length,count+1,'home appears before a slow monitor stops');
  assert.equal(h.calls.commands.some(command=>command[0]==='chatgpt.openSidebar'),false);
  releaseStop();await Promise.all([reset,concurrentReset,nextAction]);
  assert.equal(h.calls.messages.filter(message=>message.type==='resetView').length,count+1);
  assert.equal(h.calls.commands.at(-1)[0],'chatgpt.openSidebar','reset cannot hide a new Codex action later');
});

test('paused watcher keeps activity refresh, ignores stale events and restarts against a changed directory',async()=>{
  const h=harness({trusted:true});await h.flush();await h.send({type:'ready'});await h.send({type:'liveVisibility',visible:true});
  const first=h.calls.watches[0];assert.ok(first);
  first.callbacks.onEvent({type:'baseline',timestamp:'2026-10-04T00:00:00Z',filesCount:5,complete:true});
  assert.equal(h.calls.messages.filter(message=>message.type==='watch').at(-1).data.fileCount,5);
  first.callbacks.onEvent({type:'change',changes:[{type:'added',path:'real.py'}],omittedChanges:2});
  assert.equal(h.calls.messages.filter(message=>message.type==='watch').at(-1).data.totalChanges,3);
  await h.send({type:'watchStop'});assert.equal(first.stopped,true);
  const count=h.calls.messages.length;first.callbacks.onEvent({type:'change',changes:[{type:'added',path:'stale.py'}]});assert.equal(h.calls.messages.length,count);
  const reads=h.calls.activityReads;await h.poll();assert.ok(h.calls.activityReads>reads);assert.equal(h.calls.watches.length,1);
  h.saved.remotePath+='/Search-R1';await h.send({type:'watchStart'});
  assert.equal(h.calls.watches.length,2);assert.equal(h.calls.watches[1].config.remotePath,h.saved.remotePath);
  const latest=h.calls.messages.filter(message=>message.type==='watch').at(-1).data;
  assert.equal(latest.changes.length,0);assert.equal(latest.totalChanges,0);
  h.saved.remotePath+='/nested';await h.send({type:'activityRefresh'});
  assert.equal(h.calls.watches[1].stopped,true);assert.equal(h.calls.watches.length,3);
});

test('activity and file names are rendered as text and late payloads cannot escape restricted mode',()=>{
  const {html,byId,onMessage}=webviewHarness();
  assert.equal(html.includes('innerHTML'),false);
  const state={trusted:true,config:{...core.defaultConfig,host:'example.com'},root,extensions:[],setup:{}};
  onMessage({data:{type:'state',data:state}});
  const hostile='<img src=x onerror=alert(1)>';
  onMessage({data:{type:'activity',data:{activities:[{label:hostile,status:'succeeded',startedAt:'2026-10-04T00:00:00Z',exitCode:0}],summary:{running:0,succeeded:1,failed:0}}}});
  assert.equal(byId.get('activityList').children[0].children[0].children[0].textContent,hostile);
  assert.equal(byId.get('activitySucceeded').textContent,'1');
  onMessage({data:{type:'watch',data:{state:'watching',enabled:true,changes:[{path:hostile,type:'added'}],totalChanges:1}}});
  assert.equal(byId.get('fileChanges').children[0].children[0].children[0].textContent,hostile);
  assert.equal(byId.get('watchStart').disabled,true);assert.equal(byId.get('watchStop').disabled,false);
  onMessage({data:{type:'state',data:{...state,trusted:false}}});
  onMessage({data:{type:'watch',data:{state:'watching',enabled:true,changes:[{path:'must-not-display.py'}]}}});
  onMessage({data:{type:'activity',data:{activities:[{label:'must-not-display'}]}}});
  assert.equal(byId.get('watchStart').disabled,true);assert.equal(byId.get('watchStop').disabled,true);
  assert.equal(byId.get('activityRunning').textContent,'—');assert.equal(byId.get('fileChangeCount').textContent,'—');
  assert.equal(byId.get('activityList').children[0].textContent,'等待实际操作记录。');
});
