'use strict';
const path=require('node:path');
const core=require('../src/core');
const {createTunnelManager}=require('../src/tunnel');
(async()=>{
  const action=process.argv[2] || 'status';
  if(!['ensure','status','stop'].includes(action))throw Error('支持的操作：ensure、status、stop。');
  const root=core.assertEPath(process.argv[3] || path.join(__dirname,'..'));
  const manager=createTunnelManager(root);
  const result=action==='stop'?await manager.stop():await manager[action](core.readConfig(root));
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status==='error')process.exitCode=1;
})().catch(error=>{process.stdout.write(JSON.stringify({status:'error',message:error.message})+'\n');process.exitCode=1;});
