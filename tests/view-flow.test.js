'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {render}=require('../src/view');
const {defaultConfig}=require('../src/core');

// Execute the shipped webview script against a small DOM. No SSH, editor or
// saved credential access is needed to exercise navigation and form ownership.
function harness(){
  const html=render('flow-test-nonce'),nodes=[],byId=new Map(),sent=[];
  const makeNode=(tag,properties={})=>({tagName:tag.toUpperCase(),dataset:{},disabled:false,hidden:false,open:false,textContent:'',value:'',checked:false,className:'',children:[],attributes:{},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},setAttribute(key,value){this.attributes[key]=value;},...properties});
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/g)){
    const tag=match[1],attrs=match[2],id=/\bid="([^"]+)"/.exec(attrs)?.[1],action=/\bdata-action="([^"]+)"/.exec(attrs)?.[1];
    const node=makeNode(tag,{id,dataset:action?{action}:{},type:/\btype="([^"]+)"/.exec(attrs)?.[1]||'',hidden:/\bhidden(?:\s|$)/.test(attrs),open:/\bopen(?:\s|$)/.test(attrs),value:/\bvalue="([^"]*)"/.exec(attrs)?.[1]||'',checked:/\bchecked(?:\s|$)/.test(attrs)});
    nodes.push(node);if(id){assert.equal(byId.has(id),false,'unique HTML ID '+id);byId.set(id,node);}
  }
  let onMessage;
  const document={createElement:tag=>makeNode(tag),getElementById:id=>{assert.ok(byId.has(id),'rendered DOM includes '+id);return byId.get(id);},querySelectorAll:selector=>{
    if(selector==='[data-action]')return nodes.filter(node=>node.dataset.action);
    if(selector==='input,button')return nodes.filter(node=>['INPUT','BUTTON'].includes(node.tagName));
    if(selector==='details')return nodes.filter(node=>node.tagName==='DETAILS');
    throw Error('unexpected DOM selector '+selector);
  }};
  const source=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source,{document,window:{addEventListener:(event,callback)=>{assert.equal(event,'message');onMessage=callback;}},acquireVsCodeApi:()=>({postMessage:message=>sent.push(JSON.parse(JSON.stringify(message))),getState(){throw Error('a fresh launch must not restore a previous route');},setState(){throw Error('a screen must not persist across launches');}})});
  const state=(changes={})=>({trusted:true,config:{...defaultConfig,host:'research.example.com',port:2222,identityFile:'E:\\research\\id_ed25519'},extensions:[{id:'openai.chatgpt',ready:true}],root:'E:\\research',setup:{publicKeyRegistered:true,sshVerified:true},...changes});
  return {html,nodes,byId,sent,state,message:(type,data)=>onMessage({data:{type,data}}),reset:()=>onMessage({data:{type:'resetView'}}),notice:(text,error=false)=>onMessage({data:{type:'notice',text,error}}),click(id){const node=byId.get(id);assert.ok(node,'button '+id);assert.equal(node.disabled,false,'button is enabled: '+id);node.onclick();},edit(id,value){const node=byId.get(id);assert.equal(node.disabled,false);if(node.type==='checkbox')node.checked=value;else node.value=String(value);node.oninput();}};
}

function expectScreen(h,visible){
  for(const name of ['Home','Connection','Preparation','Workspace','Activity'])assert.equal(h.byId.get('screen'+name).hidden,name!==visible,'visible screen '+name);
}

test('fresh dashboard shows only the home flow and requests no network or Codex action',()=>{
  const h=harness();expectScreen(h,'Home');assert.deepEqual(h.sent,[{type:'ready'}]);
  assert.ok(h.nodes.filter(node=>node.tagName==='DETAILS').length>=4);
  assert.ok(h.nodes.filter(node=>node.tagName==='DETAILS').every(node=>node.open===false));
  h.message('state',h.state());expectScreen(h,'Home');assert.deepEqual(h.sent,[{type:'ready'}]);
  assert.match(h.byId.get('sshStatus').textContent,/research\.example\.com:2222/);
  assert.match(h.html,/已保存的 SSH 目标 · 不代表在线/);
  assert.match(h.byId.get('keyStatus').textContent,/已有验证记录，本次连接仍以 SSH 结果为准/);
});

test('each home card and next button enters only its requested step; only live navigation starts monitoring',()=>{
  const h=harness();h.message('state',h.state());
  h.click('cardConnection');expectScreen(h,'Connection');
  h.click('nextPreparation');expectScreen(h,'Preparation');
  h.click('nextWorkspace');expectScreen(h,'Workspace');
  assert.deepEqual(h.sent,[{type:'ready'}]);
  h.click('nextActivity');expectScreen(h,'Activity');assert.deepEqual(h.sent.at(-1),{type:'liveVisibility',visible:true});
  const sentCount=h.sent.length;h.click('navActivity');assert.equal(h.sent.length,sentCount,'same live route does not create another watcher request');
  h.click('backActivity');expectScreen(h,'Home');assert.deepEqual(h.sent.at(-1),{type:'liveVisibility',visible:false});
  for(const [button,screen] of [['cardPreparation','Preparation'],['cardWorkspace','Workspace'],['cardActivity','Activity']]){h.click(button);expectScreen(h,screen);h.click('navHome');}
});

test('periodic state and activity messages preserve the chosen step and all unsaved fields',()=>{
  const h=harness();const original=h.state();h.message('state',original);h.click('cardConnection');
  h.edit('host','draft.example.com');h.edit('port',3555);h.edit('useProxy',false);h.edit('remotePath','/data/my project');
  h.message('state',{...original,config:{...original.config,remoteProxyPort:18888}});
  assert.equal(h.byId.get('host').value,'draft.example.com');assert.equal(h.byId.get('port').value,'3555');assert.equal(h.byId.get('useProxy').checked,false);assert.equal(h.byId.get('remotePath').value,'/data/my project');assert.equal(Number(h.byId.get('remoteProxyPort').value),18888);expectScreen(h,'Connection');
  h.message('activity',{activities:[],summary:{running:1,succeeded:2}});h.message('watch',{state:'paused',totalChanges:3,changes:[]});expectScreen(h,'Connection');assert.equal(h.byId.get('host').value,'draft.example.com');
  h.click('nextPreparation');h.message('state',original);expectScreen(h,'Preparation');h.click('navConnection');assert.equal(h.byId.get('host').value,'draft.example.com');assert.match(h.byId.get('draftStatus').textContent,/未保存/);
});

test('parse results stay as an editable draft until saving, with correct numeric and checkbox values',()=>{
  const h=harness();const state=h.state();h.message('state',state);h.click('cardConnection');
  h.byId.get('command').value='ssh -p 9000 root@parsed.example.com';h.click('parse');assert.deepEqual(h.sent.at(-1),{type:'parse',command:'ssh -p 9000 root@parsed.example.com'});
  h.message('parsed',{host:'parsed.example.com',port:9000,user:'root'});h.message('state',state);
  assert.equal(h.byId.get('host').value,'parsed.example.com');assert.equal(Number(h.byId.get('port').value),9000);
  h.edit('tunnel',true);h.click('save');const saved=h.sent.at(-1);assert.equal(saved.type,'save');assert.equal(saved.config.port,9000);assert.equal(saved.config.tunnel,true);assert.equal(saved.config.identityFile,state.config.identityFile);
  h.message('state',{...state,config:saved.config});assert.doesNotMatch(h.byId.get('draftStatus').textContent,/未保存/);
  h.message('state',{...state,config:{...saved.config,port:9001}});assert.equal(Number(h.byId.get('port').value),9001,'an acknowledged field follows later saved configuration');
});

test('a late save response cannot overwrite edits made while the save was pending',()=>{
  const h=harness();const state=h.state();h.message('state',state);h.edit('host','first.example.com');h.click('save');const requested=h.sent.at(-1).config;
  h.edit('host','second.example.com');h.message('state',{...state,config:requested});assert.equal(h.byId.get('host').value,'second.example.com');assert.match(h.byId.get('draftStatus').textContent,/未保存/);
});

test('reset clears transient UI, collapses advanced options and retains saved connection without sending save',()=>{
  const h=harness();const state=h.state();h.message('state',state);h.edit('host','unsaved.example.com');h.byId.get('command').value='temporary input';h.click('cardActivity');
  h.message('activity',{summary:{succeeded:7},activities:[{label:'old operation',status:'succeeded'}]});h.message('watch',{totalChanges:2,changes:[{path:'old.py',type:'added'}]});h.notice('old operation failed',true);
  h.nodes.filter(node=>node.tagName==='DETAILS').forEach(node=>{node.open=true;});h.reset();
  expectScreen(h,'Home');assert.equal(h.byId.get('host').value,state.config.host);assert.equal(h.byId.get('command').value,'');assert.equal(h.byId.get('notice').textContent,'');assert.equal(h.byId.get('activitySucceeded').textContent,'0');assert.equal(h.byId.get('fileChangeCount').textContent,'0');assert.equal(h.byId.get('watchStop').disabled,true);
  assert.ok(h.nodes.filter(node=>node.tagName==='DETAILS').every(node=>!node.open));assert.equal(h.sent.some(message=>message.type==='save'),false);assert.deepEqual(h.sent.at(-1),{type:'liveVisibility',visible:false});
  h.click('cleanHome');assert.deepEqual(h.sent.at(-1),{type:'resetSession'});assert.match(h.html,/回到首页，保留配置与文件/);
});

test('restricted mode retains the trust gate and rejects late parse or live records',()=>{
  const h=harness();for(const node of h.nodes.filter(node=>['INPUT','BUTTON'].includes(node.tagName)))assert.equal(node.disabled,!['trust','readme','remoteHelp'].includes(node.dataset.action));
  h.message('parsed',{host:'hidden.example.com'});assert.equal(h.byId.get('host').value,'');
  h.message('state',h.state());h.edit('host','unsaved.example.com');h.message('state',h.state({trusted:false,config:{...defaultConfig}}));h.message('activity',{summary:{succeeded:10},activities:[{label:'must not render'}]});h.message('watch',{changes:[{path:'must not render'}]});
  assert.equal(h.byId.get('host').value,'');assert.equal(h.byId.get('activitySucceeded').textContent,'—');assert.equal(h.byId.get('fileChangeCount').textContent,'—');assert.doesNotMatch(h.byId.get('draftStatus').textContent,/未保存/);
});

test('render keeps nonce CSP and inline resources, and all existing execution messages remain reachable',()=>{
  const h=harness();assert.match(h.html,/default-src 'none'; style-src 'nonce-flow-test-nonce'; script-src 'nonce-flow-test-nonce'/);assert.doesNotMatch(h.html,/<(?:script|link|img)\b[^>]*(?:src|href)=/);assert.doesNotMatch(h.html,/innerHTML/);
  const actions=new Set(h.nodes.map(node=>node.dataset.action).filter(Boolean));
  for(const action of ['trust','codex','connect','activityRefresh','watchStart','watchStop','diagnose','ssh','key','copyKey','verify','console','tunnel','stopTunnel','bootstrap','tunnelStatus','install','remoteHelp','remoteCodex','updateRemoteCodex','readme'])assert.ok(actions.has(action),'existing action '+action);
});

test('portable UI reports the supplied platform root without requiring a particular drive',()=>{
  const h=harness();const state=h.state({root:'D:\\移动研究台\\Research Hub'});
  state.config.identityFile='D:\\移动研究台\\Research Hub\\data\\ssh\\id_ed25519';state.keyReady=true;
  h.message('state',state);
  assert.ok(h.byId.get('root').textContent.includes(state.root));
  assert.equal(h.byId.get('identityFile').value,state.config.identityFile);
  assert.doesNotMatch(h.html,/只接受 E 盘|本地 E 盘|均使用平台 E 盘|所有本地平台文件保存在 E 盘/);
  assert.match(h.byId.get('keyStatus').textContent,/平台私有数据目录/);
});
