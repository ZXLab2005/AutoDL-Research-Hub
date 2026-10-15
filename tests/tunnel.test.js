'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../src/core');
const {createTunnelManager,sshArguments,parseWindowsCommandLine,processMatches}=require('../src/tunnel');
const ROOT=path.resolve(__dirname,'..');
const CONFIG={...core.defaultConfig,host:'connect.example.com',port:23456,tunnel:true};
function fixture(t,options={}){
 const root=core.assertEPath(path.join(ROOT,'data','test-runs','tunnel-'+process.pid+'-'+Math.random().toString(16).slice(2)));
 fs.mkdirSync(root,{recursive:true});
 t.after(()=>{core.assertEPath(root,{within:ROOT});fs.rmSync(root,{recursive:true,force:true});});
 const processes=new Map();let pid=20000,time=0;
 const calls={launch:0,stop:[],ownedAbort:[],lookup:0,probe:0,sleep:0};
 const runtime={
  executable:'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  async lookup(id){
   calls.lookup++;
   if(options.failLookupAt===calls.lookup)throw Error('CIM lookup unavailable');
   if(options.missingLookup)return null;
   const actual=processes.get(id)||null;
   if(actual&&options.lookupMismatch)return {...actual,commandLine:actual.commandLine+' unexpected'};
   return actual;
  },
  launch(executable,args,logFile){
   calls.launch++; const id=++pid;
   const quote=value=>'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/g,'$1$1')+'"';
   const created={pid:id,executable,commandLine:[executable,...args].map(quote).join(' '),startedAt:'2026-10-03T00:00:'+id+'.0000000Z'};
   processes.set(id,created);
   fs.writeFileSync(logFile,options.emptyLog?'':'debug1: remote forward success for: listen 127.0.0.1 port 17897\n');
   calls.logFile=logFile;
   if(options.stateWriteFailure)fs.mkdirSync(path.join(root,'data','tunnel','state.json'));
   return {pid:id,abort:async()=>{
    calls.ownedAbort.push(id);
    if(options.failAbort)throw Error('owned handle cleanup failed');
    // Model the original handle: never delete a new process reusing this PID.
    if(processes.get(id)===created)processes.delete(id);
   }};
  },
  async terminate(actual){calls.stop.push(actual.pid);processes.delete(actual.pid);},
  async probe(){calls.probe++;if(options.failProxy)throw Error('proxy unavailable');},
 };
 const managerOptions={runtime,now:()=>time,sleep:async ms=>{
  time+=ms;calls.sleep++;
  if(options.delayedReady&&calls.sleep===3)fs.writeFileSync(calls.logFile,'debug1: remote forward success for: listen 127.0.0.1 port 17897\n');
  await new Promise(resolve=>setImmediate(resolve));
 }};
 return {root,runtime,manager:createTunnelManager(root,managerOptions),managerOptions,processes,calls};
}
test('tunnel arguments retain strict authentication and forwarding safeguards',()=>{
 const args=sshArguments(CONFIG,'E:\\research\\data\\tunnel\\test.sshconfig');
 for(const value of ['-N','-v','BatchMode=yes','StrictHostKeyChecking=yes','ExitOnForwardFailure=yes','ServerAliveInterval=30','ServerAliveCountMax=3'])assert.ok(args.includes(value));
 assert.ok(args.includes('127.0.0.1:17897:127.0.0.1:7897'));
 assert.throws(()=>sshArguments({...CONFIG,host:'x\nProxyCommand bad'},'E:\\test'));
});
test('Windows command parser preserves quoted Unicode paths and rejects incomplete quotes',()=>{
 assert.deepEqual(parseWindowsCommandLine('"C:\\Windows\\ssh.exe" -F "E:\\研究 空格\\config" -N'),['C:\\Windows\\ssh.exe','-F','E:\\研究 空格\\config','-N']);
 assert.throws(()=>parseWindowsCommandLine('ssh "E:\\unclosed'));
});
test('first ensure waits for forwarding success; repeat and new manager reuse one process',async t=>{
 const f=fixture(t);
 assert.equal((await f.manager.status(CONFIG)).status,'stopped');
 const first=await f.manager.ensure(CONFIG);assert.equal(first.status,'running');assert.equal(first.reused,false);
 const second=await createTunnelManager(f.root,f.managerOptions).ensure(CONFIG);
 assert.equal(second.pid,first.pid);assert.equal(second.reused,true);assert.equal(f.calls.launch,1);
 assert.equal((await f.manager.status(CONFIG)).configMatches,true);
 const stopped=await f.manager.stop();assert.equal(stopped.status,'stopped');assert.deepEqual(f.calls.stop,[first.pid]);
 assert.equal((await f.manager.stop()).status,'stopped');assert.equal(f.calls.stop.length,1);
});
test('simultaneous ensure operations serialize and do not spawn duplicate forwards',async t=>{
 const f=fixture(t);
 const results=await Promise.all([f.manager.ensure(CONFIG),createTunnelManager(f.root,f.managerOptions).ensure(CONFIG)]);
 assert.equal(results[0].pid,results[1].pid);assert.equal(f.calls.launch,1);
});
test('changed connection stops only the verified old process and starts a new one',async t=>{
 const f=fixture(t),first=await f.manager.ensure(CONFIG);
 const changed={...CONFIG,port:23457};
 assert.equal((await f.manager.status(changed)).configMatches,false);
 const second=await f.manager.ensure(changed);
 assert.notEqual(first.pid,second.pid);assert.deepEqual(f.calls.stop,[first.pid]);
});
test('recycled PID or modified command line is never terminated',async t=>{
 const f=fixture(t),first=await f.manager.ensure(CONFIG);
 f.processes.get(first.pid).startedAt='different-process-start-time';
 assert.equal((await f.manager.status(CONFIG)).status,'stopped');
 await f.manager.stop();assert.deepEqual(f.calls.stop,[]);
 const second=await f.manager.ensure(CONFIG);
 f.processes.get(second.pid).commandLine='"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -R unknown host';
 await f.manager.stop();assert.deepEqual(f.calls.stop,[]);
});
test('tampered connection snapshot blocks process manipulation',async t=>{
 const f=fixture(t);await f.manager.ensure(CONFIG);
 const snapshot=fs.readdirSync(path.join(f.root,'data','tunnel')).find(name=>name.endsWith('.sshconfig'));
 fs.appendFileSync(path.join(f.root,'data','tunnel',snapshot),'Host malicious\n');
 assert.equal((await f.manager.status(CONFIG)).status,'error');
 await assert.rejects(f.manager.stop(),/快照已改变/);assert.deepEqual(f.calls.stop,[]);
});
test('start does not report ready before SSH confirms remote forwarding',async t=>{
 const f=fixture(t,{emptyLog:true,delayedReady:true});
 const result=await f.manager.ensure(CONFIG);assert.equal(result.status,'running');assert.ok(f.calls.sleep>=3);
});
test('a forwarding timeout safely cleans its verified process and returns failure',async t=>{
 const f=fixture(t,{emptyLog:true});
 await assert.rejects(f.manager.ensure(CONFIG),/超时/);
 assert.equal(f.calls.stop.length,0);assert.equal(f.calls.ownedAbort.length,1);assert.equal(f.processes.size,0);
});
test('missing local proxy prevents SSH launch',async t=>{
 const f=fixture(t,{failProxy:true});
 await assert.rejects(f.manager.ensure(CONFIG),/proxy unavailable/);
 assert.equal(f.calls.launch,0);assert.equal(f.calls.stop.length,0);
});
test('identity matching requires exact executable, creation time and full arguments',()=>{
 const expected={pid:123,startedAt:'date',executable:'C:\\Windows\\ssh.exe',args:['-N','-F','E:\\研究 空格\\config']};
 const actual={pid:123,startedAt:'date',executable:expected.executable,commandLine:'"C:\\Windows\\ssh.exe" -N -F "E:\\研究 空格\\config"'};
 assert.equal(processMatches(actual,expected),true);
 for(const patch of [{pid:124},{startedAt:'other'},{executable:'C:\\Windows\\other.exe'},{commandLine:actual.commandLine+' extra'}])assert.equal(processMatches({...actual,...patch},expected),false);
});

test('stale lock contenders never delete the lock or enter the critical section',async t=>{
 const f=fixture(t),folder=path.join(f.root,'data','tunnel');
 fs.mkdirSync(folder,{recursive:true});
 const lock=path.join(folder,'operation.lock'),contents=JSON.stringify({pid:2147483647,token:'stale-owner'});
 fs.writeFileSync(lock,contents);
 const outcomes=await Promise.allSettled([f.manager.ensure(CONFIG),createTunnelManager(f.root,f.managerOptions).ensure(CONFIG)]);
 for(const outcome of outcomes){assert.equal(outcome.status,'rejected');assert.match(outcome.reason.message,/不会自动回收/);}
 assert.equal(fs.readFileSync(lock,'utf8'),contents);
 assert.equal(f.calls.launch,0);assert.equal(f.calls.probe,0);assert.deepEqual(f.calls.stop,[]);
});
test('first CIM lookup failure cancels the owned spawn without using PID termination',async t=>{
 const f=fixture(t,{failLookupAt:1});
 await assert.rejects(f.manager.ensure(CONFIG),/CIM lookup unavailable/);
 assert.equal(f.calls.launch,1);assert.equal(f.calls.ownedAbort.length,1);
 assert.equal(f.processes.size,0);assert.deepEqual(f.calls.stop,[]);
 assert.equal(fs.existsSync(path.join(f.root,'data','tunnel','state.json')),false);
});
test('initial identity mismatch cancels only the newly owned process',async t=>{
 const f=fixture(t,{lookupMismatch:true});
 await assert.rejects(f.manager.ensure(CONFIG),/身份无法验证/);
 assert.equal(f.calls.ownedAbort.length,1);assert.equal(f.processes.size,0);assert.deepEqual(f.calls.stop,[]);
});
test('first state rename failure cancels the owned spawn before any ready result',async t=>{
 const f=fixture(t,{stateWriteFailure:true});
 await assert.rejects(f.manager.ensure(CONFIG));
 assert.equal(f.calls.ownedAbort.length,1);assert.equal(f.processes.size,0);assert.deepEqual(f.calls.stop,[]);
});
test('CIM failure during readiness also uses the original spawn handle',async t=>{
 const f=fixture(t,{failLookupAt:2});
 await assert.rejects(f.manager.ensure(CONFIG),/CIM lookup unavailable/);
 assert.equal(f.calls.ownedAbort.length,1);assert.equal(f.processes.size,0);assert.deepEqual(f.calls.stop,[]);
});
test('a spawned process never found by CIM is still cancelled by its owned handle',async t=>{
 const f=fixture(t,{missingLookup:true});
 await assert.rejects(f.manager.ensure(CONFIG),/启动后立即退出/);
 assert.equal(f.calls.lookup,15);assert.equal(f.calls.ownedAbort.length,1);assert.equal(f.processes.size,0);
});
test('cleanup failure is reported alongside the original startup error',async t=>{
 const f=fixture(t,{failLookupAt:1,failAbort:true});
 await assert.rejects(f.manager.ensure(CONFIG),/CIM lookup unavailable.*owned handle cleanup failed/);
 assert.equal(f.calls.ownedAbort.length,1);assert.deepEqual(f.calls.stop,[]);
});
