import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import electron from 'electron';

test('shared sidebar keeps daily styles and stable nodes across all menus',{timeout:45000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jira-sidebar-test-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,['tests/sidebar-ui-host.cjs',directory],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const timer=setTimeout(()=>child.kill(),40000);
 try{const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});assert.equal(code,0,output);assert.match(output,/SIDEBAR_UI_PASS/);}finally{clearTimeout(timer);child.kill();await rm(directory,{recursive:true,force:true});}
});
