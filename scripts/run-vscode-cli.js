'use strict';
// Node waits for GUI-subsystem Code.exe even when invoked by Windows PowerShell 5.
const {spawnSync}=require('node:child_process');
const [exe,cli,...args]=process.argv.slice(2);
if(!exe || !cli) throw Error('Missing VS Code executable or CLI path.');
const result=spawnSync(exe,[cli,...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit',windowsHide:true});
if(result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status === null ? 1 : result.status);
