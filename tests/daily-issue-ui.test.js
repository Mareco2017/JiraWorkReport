import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import electron from 'electron';

// 真实 renderer/preload 跑在受控 IPC 上：回车语义与红边状态都是实际 DOM/样式断言。
test('daily issue picker keeps Enter as query/select and clears field errors with the message', {timeout:45000}, async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,['tests/daily-issue-ui-host.cjs'],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const timer=setTimeout(()=>child.kill(),40000);
 try {
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,output);assert.match(output,/DAILY_ISSUE_UI_PASS/);
 }finally{clearTimeout(timer);child.kill();}
});
