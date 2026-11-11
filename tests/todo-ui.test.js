import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electron from 'electron';

// 两个独立Electron进程复用本例目录，避免用同页内存冒充重启持久化。
test('personal todo UI saves through real IPC and reopens the same local file', {timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jira-todo-ui-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 try{for(const phase of ['create','reopen']){
  const child=spawn(electron,['tests/todo-ui-host.cjs',directory,phase],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const timer=setTimeout(()=>child.kill(),25000);
  try{const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.equal(code,0,output);assert.match(output,/TODO_UI_PASS/);}finally{clearTimeout(timer);child.kill();}
 }}finally{await rm(directory,{recursive:true,force:true});}
});
