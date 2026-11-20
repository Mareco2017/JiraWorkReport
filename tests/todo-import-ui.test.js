import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import electron from 'electron';

// 「已完成待办」来源用真实渲染与 IPC 驱动，仅替换主进程动作。
test('batch todo source lists completed work, fills hours and hides submitted rows', {timeout:40000}, async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,['tests/todo-import-ui-host.cjs'],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
 const timer=setTimeout(()=>child.kill(),35000);
 try {
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,output);assert.match(output,/TODO_IMPORT_UI_PASS/);
 }finally{clearTimeout(timer);child.kill();}
});
