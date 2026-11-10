import test from 'node:test';
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {discoverRuntimes} from '../app/runtimes.js';

// 用目标系统的路径和文件清单验证发现逻辑，不依赖开发电脑实际安装的 CLI。
function installed(files){
 return async(file,mode)=>{assert.equal(mode,constants.F_OK);if(!files.includes(file))throw Object.assign(new Error('missing'),{code:'ENOENT'});};
}

test('Windows discovers native EXE and npm CMD from PATH containing spaces',async()=>{
 const codex='C:\\Program Files\\Codex\\codex.exe',dsh='D:\\Tools\\dsh.cmd';
 const found=await discoverRuntimes({home:'C:\\Users\\tester',platform:'win32',path:'"C:\\Program Files\\Codex";D:\\Tools',probe:installed([codex,dsh])});
 assert.deepEqual(found,{'Codex CLI':codex,'DSH CLI':dsh});
});

test('Windows finds user npm and local native CLI without PATH entries',async()=>{
 const home='C:\\Users\\张 三',codex=home+'\\.local\\bin\\codex.exe',dsh='D:\\Roaming Profile\\npm\\dsh.cmd';
 assert.deepEqual(await discoverRuntimes({home,platform:'win32',path:'',appData:'D:\\Roaming Profile',probe:installed([codex,dsh])}),{'Codex CLI':codex,'DSH CLI':dsh});
});

test('Windows falls back to the standard roaming npm directory and accepts BAT',async()=>{
 const home='C:\\Users\\tester',dsh=home+'\\AppData\\Roaming\\npm\\dsh.bat';
 assert.deepEqual(await discoverRuntimes({home,platform:'win32',path:'',appData:'',probe:installed([dsh])}),{'DSH CLI':dsh});
});

test('Windows respects PATH directory priority',async()=>{
 const first='C:\\First\\codex.cmd',second='C:\\Second\\codex.exe';
 const found=await discoverRuntimes({home:'C:\\Users\\tester',platform:'win32',path:'C:\\First;C:\\Second',probe:installed([first,second])});
 assert.equal(found['Codex CLI'],first);
});

test('No installed Windows CLI leaves manual selection available',async()=>{
 assert.deepEqual(await discoverRuntimes({home:'C:\\Users\\tester',platform:'win32',path:'',probe:installed([])}),{});
});

test('macOS preserves DSH app priority and nvm Codex discovery for both chip families',async()=>{
 const dsh='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',codex='/Users/tester/.nvm/versions/node/v22.0.0/bin/codex';
 const found=await discoverRuntimes({home:'/Users/tester',platform:'darwin',path:'/usr/local/bin',listDirectory:async()=>['v22.0.0'],probe:async(file,mode)=>{
  assert.equal(mode,constants.X_OK);
  if(![dsh,codex,'/usr/local/bin/dsh'].includes(file))throw new Error('missing');
 }});
 assert.deepEqual(found,{'Codex CLI':codex,'DSH CLI':dsh});
});
