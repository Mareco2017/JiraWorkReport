import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import electron from 'electron';

// 产品 DOM 与预加载桥接真实运行，受控动作保证本用例不写远端业务数据。
test('batch UI uses both import sources and retains invalid title on same-content reparse', {timeout:30000}, async()=>{
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,['tests/batch-ui-host.cjs'],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
 const timer=setTimeout(()=>child.kill(),25000);
 try {
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,output);assert.match(output,/BATCH_UI_PASS/);
 }finally{clearTimeout(timer);child.kill();}
});
