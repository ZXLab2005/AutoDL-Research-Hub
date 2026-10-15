'use strict';
// A detached OpenSSH process, with platform-local state. No terminal or VS Code
// lifecycle owns this process; only an explicit verified stop terminates it.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const core = require('./core');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseWindowsCommandLine(command) {
  const result = [];
  let index = 0;
  while (index < command.length) {
    while (/\s/.test(command[index] || '') && index < command.length) index++;
    if (index >= command.length) break;
    let argument = '', quoted = false;
    while (index < command.length && (quoted || !/\s/.test(command[index]))) {
      let slashes = 0;
      while (command[index] === '\\') { slashes++; index++; }
      if (command[index] === '"') {
        argument += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) argument += '"';
        else quoted = !quoted;
        index++;
      } else {
        argument += '\\'.repeat(slashes);
        if (index < command.length) argument += command[index++];
      }
    }
    if (quoted) throw Error('进程命令行引号不完整，拒绝操作。');
    result.push(argument);
  }
  return result;
}
function signature(input) {
  const c = core.validateConfig(input);
  return JSON.stringify([c.host,c.port,c.user,c.identityFile,c.proxyUrl,c.remoteProxyPort]);
}
function sshArguments(config, configFile) {
  const c = core.validateConfig(config), proxy = core.parseProxy(c.proxyUrl);
  return ['-F',configFile,'-N','-v','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=15','-o','ConnectionAttempts=1',
    '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3',
    '-R','127.0.0.1:'+c.remoteProxyPort+':'+proxy.host+':'+proxy.port,'autodl-research'];
}
function processMatches(actual, expected) {
  if (!actual || !expected || actual.pid !== expected.pid || actual.startedAt !== expected.startedAt) return false;
  if (path.win32.normalize(actual.executable || '').toLowerCase() !== path.win32.normalize(expected.executable).toLowerCase()) return false;
  let argumentsList;
  try { argumentsList = parseWindowsCommandLine(actual.commandLine || ''); } catch { return false; }
  if (path.win32.normalize(argumentsList.shift() || '').toLowerCase() !== path.win32.normalize(expected.executable).toLowerCase()) return false;
  return argumentsList.length === expected.args.length && argumentsList.every((value,index) => value === expected.args[index]);
}
function encoded(value) { return Buffer.from(value, 'utf8').toString('base64'); }
function psString(value) { return "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded(value)+"'))"; }
async function terminateCreatedChild(child) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  // ChildProcess.kill uses the handle returned by our own spawn on Windows,
  // not an unrelated process subsequently reusing the same numeric PID.
  await new Promise((resolve,reject)=>{
    let timer;
    const finish=error=>{
      clearTimeout(timer);child.removeListener('exit',onExit);child.removeListener('error',onError);
      error?reject(error):resolve();
    };
    const onExit=()=>finish();
    const onError=error=>finish(error);
    child.once('exit',onExit);child.once('error',onError);
    timer=setTimeout(()=>finish(Error('本次启动的 SSH 未在 5 秒内退出。')),5000);
    try {
      if(!child.kill() && child.exitCode === null && child.signalCode === null) {
        finish(Error('无法取消本次创建的 SSH 进程，请检查隧道日志。'));
      }
    } catch(error) { finish(error); }
  });
}
function defaultRuntime(root) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  async function powershellRun(script) {
    const source = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+script;
    return run(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],
      { windowsHide:true, timeout:15000, encoding:'utf8', maxBuffer:1024*1024 });
  }
  return {
    executable: core.getSshExecutable(root),
    async lookup(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('无效的隧道进程编号。');
      const { stdout } = await powershellRun(
        '$hubProcess=Get-CimInstance Win32_Process -Filter "ProcessId = '+pid+'"; if($hubProcess){ '+
        '[pscustomobject]@{pid=[int]$hubProcess.ProcessId; executable=$hubProcess.ExecutablePath; commandLine=$hubProcess.CommandLine; '+
        'startedAt=$hubProcess.CreationDate.ToUniversalTime().ToString("o")} | ConvertTo-Json -Compress }');
      return stdout.trim() ? JSON.parse(stdout) : null;
    },
    async launch(executable,args,logFile,root,config) {
      const env = {...process.env,...core.buildStorageEnv(root,config)};
      env.HOMEDRIVE=env.USERPROFILE.substring(0,2); env.HOMEPATH=env.USERPROFILE.substring(2);
      delete env.ELECTRON_RUN_AS_NODE;
      let descriptor, child;
      try {
        descriptor=fs.openSync(logFile,'wx');
        child=spawn(executable,args,{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',descriptor,descriptor]});
        // Logging must not crash the launcher before its owned child is cleaned up.
        child.on('error', error => {
          try { fs.appendFileSync(logFile,'\n启动失败：'+error.message+'\n'); } catch {}
        });
        fs.closeSync(descriptor);descriptor=undefined;
        if (!child.pid) throw Error('后台 SSH 启动失败，请检查隧道日志。');
        child.unref();
        return {pid:child.pid,abort:()=>terminateCreatedChild(child)};
      } catch(error) {
        try { await terminateCreatedChild(child); }
        catch(cleanupError) { throw Error(error.message+'；取消本次启动失败：'+cleanupError.message); }
        throw error;
      } finally {
        if(descriptor!==undefined) { try { fs.closeSync(descriptor); } catch {} }
      }
    },
    async terminate(actual) {
      // Acquire a process handle before rechecking CIM. A recycled PID cannot
      // redirect Kill() to a different process after the identity check.
      const script='$hubHandle=[Diagnostics.Process]::GetProcessById('+actual.pid+'); '+
        '$null=$hubHandle.Handle; $hubProcess=Get-CimInstance Win32_Process -Filter "ProcessId = '+actual.pid+'"; '+
        '$hubExpectedCommand='+psString(actual.commandLine)+'; $hubExpectedExe='+psString(actual.executable)+'; '+
        '$hubExpectedStart='+psString(actual.startedAt)+'; '+
        'if(!$hubProcess -or $hubProcess.CommandLine -cne $hubExpectedCommand -or $hubProcess.ExecutablePath -ine $hubExpectedExe '+
        '-or $hubProcess.CreationDate.ToUniversalTime().ToString("o") -cne $hubExpectedStart '+
        '-or [Math]::Abs(($hubHandle.StartTime.ToUniversalTime()-$hubProcess.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) '+
        '{throw "隧道进程身份已改变，未停止任何进程。"}; '+
        '$hubHandle.Kill(); if(!$hubHandle.WaitForExit(5000)){throw "隧道未在 5 秒内退出。"}';
      await powershellRun(script);
    },
    async probe(host,port) {
      await new Promise((resolve,reject)=>{
        const socket=net.createConnection({host:host.replace(/^\[|\]$/g,''),port});
        const finish=error=>{socket.destroy();error?reject(error):resolve();};
        socket.setTimeout(3500,()=>finish(Error('本机代理没有响应，请启动 Clash。')));
        socket.once('connect',()=>finish());
        socket.once('error',()=>finish(Error('无法连接本机代理，请检查 Clash 和代理端口。')));
      });
    },
  };
}
function createTunnelManager(root, options={}) {
  root=core.assertEPath(root);
  const runtime=options.runtime || defaultRuntime(root), sleep=options.sleep || delay, now=options.now || Date.now;
  const paths=core.getPaths(root), checked=file=>core.assertEPath(file,{within:root});
  const directory=checked(path.win32.join(paths.data,'tunnel'));
  const stateFile=checked(path.win32.join(directory,'state.json'));
  const lockFile=checked(path.win32.join(directory,'operation.lock'));
  function files(token) {
    if (!/^[a-f0-9]{24}$/.test(token)) throw Error('隧道记录标识无效，未操作进程。');
    return { configFile:checked(path.win32.join(directory,token+'.sshconfig')),
      logFile:checked(path.win32.join(paths.logs,'tunnel-'+token+'.log')) };
  }
  function expected(record) {
    if (!record || record.version!==1 || !Number.isSafeInteger(record.pid) || record.pid<=0 || typeof record.startedAt!=='string') {
      throw Error('隧道状态记录无效，未操作进程。');
    }
    const c=core.validateConfig(record.config), f=files(record.token);
    if (!c.tunnel || !c.useProxy) throw Error('隧道记录配置无效。');
    if (fs.readFileSync(f.configFile,'utf8')!==core.renderSshConfig(root,c)) throw Error('隧道配置快照已改变，拒绝操作此进程。');
    return {pid:record.pid,startedAt:record.startedAt,executable:runtime.executable,args:sshArguments(c,f.configFile)};
  }
  function readRecord() {
    if (!fs.existsSync(stateFile)) return null;
    return JSON.parse(fs.readFileSync(checked(stateFile),'utf8'));
  }
  function writeRecord(record) {
    const temporary=checked(stateFile+'.'+crypto.randomBytes(5).toString('hex')+'.tmp');
    fs.writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    checked(stateFile);fs.renameSync(temporary,stateFile);
  }
  async function inspect() {
    const record=readRecord();
    if (!record) return {status:'stopped',message:'后台代理隧道未运行。'};
    const want=expected(record), actual=await runtime.lookup(record.pid), f=files(record.token);
    if (!processMatches(actual,want)) return {status:'stopped',message:'此前隧道已退出，连接时会重新启动。',logFile:f.logFile};
    return {status:record.ready?'running':'starting',pid:record.pid,startedAt:record.startedAt,
      logFile:f.logFile,message:record.ready?'后台隧道运行中；关闭终端或 VS Code 不会停止它。':'正在建立后台隧道。',record,actual};
  }
  function publicState(state,config) {
    const {record,actual,...result}=state;
    if(record && config) result.configMatches=signature(record.config)===signature(config);
    return result;
  }
  async function status(config) {
    try {return publicState(await inspect(),config?.host?config:undefined);}
    catch(error){return {status:'error',message:error.message};}
  }
  async function locked(fn) {
    fs.mkdirSync(checked(directory),{recursive:true});fs.mkdirSync(checked(paths.logs),{recursive:true});
    const token=crypto.randomBytes(12).toString('hex'), deadline=now()+45000;
    for (;;) {
      try {
        fs.writeFileSync(checked(lockFile),JSON.stringify({pid:process.pid,token}),{flag:'wx'});
        break;
      } catch(error) {
        if(error.code!=='EEXIST')throw error;
        // Contenders never delete/reclaim an existing lock. Checking a stale
        // token and then unlinking is racy: another contender may own a new lock.
        // A crashed owner's lock deliberately requires manual inspection.
        if(now()>deadline)throw Error('隧道操作锁仍存在，未启动或停止任何进程。请稍后重试；若上次操作已中断，确认没有管理命令运行后检查：'+lockFile+'。平台不会自动回收此锁。');
        await sleep(200);
      }
    }
    try{return await fn();}finally{
      const lock=JSON.parse(fs.readFileSync(checked(lockFile),'utf8'));
      if(lock.token===token)fs.unlinkSync(checked(lockFile));
    }
  }
  async function stopVerified(state) {
    if(!state.actual || !state.record)return;
    // Re-query immediately before stop and validate exact executable, arguments,
    // and creation time, rather than trusting a number in a JSON file.
    const actual=await runtime.lookup(state.record.pid);
    if(!processMatches(actual,expected(state.record)))throw Error('隧道进程身份已改变，未停止任何进程。');
    await runtime.terminate(actual);
  }
  async function waitReady(record) {
    const deadline=now()+25000;
    for(;;){
      const state=await inspect();
      if(state.status==='stopped')throw Error('后台 SSH 已退出。请检查免密认证、主机指纹或远端代理端口是否被旧隧道占用。日志：'+files(record.token).logFile);
      const log=fs.readFileSync(files(record.token).logFile,'utf8');
      if(/remote forward success for:/i.test(log)){
        record.ready=true;writeRecord(record);return publicState({...state,status:'running',record,
          message:'后台隧道已就绪；关闭终端或 VS Code 不会停止它。'});
      }
      if(now()>deadline)throw Error('等待后台 SSH 转发成功超时，请检查隧道日志：'+files(record.token).logFile);
      await sleep(300);
    }
  }
  async function ensure(input) {
    const c=core.validateConfig(input);
    if(!c.tunnel || !c.useProxy)throw Error('请先启用“为远端提供本机代理隧道”并保存。');
    return locked(async()=>{
      const proxy=core.parseProxy(c.proxyUrl);await runtime.probe(proxy.host,proxy.port);
      const state=await inspect();
      if(state.record && signature(state.record.config)===signature(c)){
        if(state.status==='running')return {...publicState(state,c),reused:true};
        return {...await waitReady(state.record),reused:true};
      }
      if(state.record)await stopVerified(state);
      const token=crypto.randomBytes(12).toString('hex'), f=files(token);
      fs.writeFileSync(f.configFile,core.renderSshConfig(root,c),{flag:'wx'});
      let owned;
      try {
        owned=await runtime.launch(runtime.executable,sshArguments(c,f.configFile),f.logFile,root,c);
        const pid=owned.pid;
        let actual;
        for(let attempt=0;attempt<15;attempt++){
          actual=await runtime.lookup(pid);
          if(actual)break;
          await sleep(100);
        }
        if(!actual)throw Error('后台 SSH 启动后立即退出，请查看日志：'+f.logFile);
        const record={version:1,token,pid,startedAt:actual.startedAt,config:c,ready:false};
        const want={pid,startedAt:actual.startedAt,executable:runtime.executable,args:sshArguments(c,f.configFile)};
        if(!processMatches(actual,want))throw Error('新隧道进程身份无法验证，已取消本次启动。');
        writeRecord(record);
        return {...await waitReady(record),reused:false};
      } catch(error) {
        // This boundary starts before the first CIM lookup and state write.
        // Even if either fails, the process we created is held by its original
        // spawn handle; cleanup never needs an unverified PID or readable state.
        if(owned) {
          try { await owned.abort(); }
          catch(cleanupError) { throw Error(error.message+'；取消本次启动失败：'+cleanupError.message); }
        }
        throw error;
      }
    });
  }
  async function stop() {
    return locked(async()=>{
      const state=await inspect();
      if(state.record)await stopVerified(state);
      if(fs.existsSync(stateFile))fs.unlinkSync(checked(stateFile));
      return {status:'stopped',message:state.record?'已停止本平台验证过的后台代理隧道。':'后台隧道已经停止。'};
    });
  }
  return {ensure,status,stop};
}
module.exports={createTunnelManager,sshArguments,parseWindowsCommandLine,processMatches,signature};
