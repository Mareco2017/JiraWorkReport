import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {rm} from 'node:fs/promises';
import {AgentService} from '../app/agent.js';

const config={engine:'DSH CLI',executable:'C:\\Tools\\dsh.cmd',mode:'custom',url:'https://fixture.invalid/v1',model:'team-model',keyRef:'fixture',approvedInternal:true};
const records=[{id:'r1',title:'虚构需求分析事项'}];
const secrets={get:async()=>'NEVER_DISCLOSE_KEY'};

// 模拟已启动的 CLI 及其标准流，覆盖 Windows 用户实际遇到的退出/清理组合。
function cli({code=0,stderr='',error,brokenInput=false}={}){
 return ()=>{
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>child.emit('close',null,'SIGTERM');
  child.stdin.on('finish',()=>queueMicrotask(()=>{
   if(brokenInput)child.stdin.emit('error',Object.assign(new Error('broken pipe'),{code:'EPIPE'}));
   const text=JSON.stringify({suggestions:[{id:'r1',type:'需求分析',task:'需求调研及分析'}]});
   child.stdout.write(JSON.stringify(error?{type:'final',reason:{kind:'error',error},text:''}:{type:'final',text})+'\n');
   child.stderr.write(stderr);child.emit('close',code);
  }));
  return child;
 };
}

for(const failure of [false,true]){
 test(`busy cleanup preserves ${failure?'the original CLI failure':'successful suggestions'}`,async t=>{
  t.mock.method(console,'warn',()=>{});
  let cleanupOptions;
  const agent=new AgentService({secrets,spawn:cli(failure?{code:1,error:{code:'MISSING_CREDENTIAL',message:'credential=NEVER_DISCLOSE_KEY'}}:{}),removeDirectory:async(path,options)=>{
   cleanupOptions=options;
   // 实际测试目录仍清除；注入的 EBUSY 代表 Windows 重试后依然被占用的结果。
   await rm(path,{recursive:true,force:true});
   throw Object.assign(new Error('private-path NEVER_DISCLOSE_KEY'),{code:'EBUSY'});
  }});
  if(failure)await assert.rejects(agent.suggest(records,config),{code:'CLI_LOGIN_REQUIRED'});
  else assert.deepEqual(await agent.suggest(records,config),[{id:'r1',type:'需求分析',task:'需求调研及分析'}]);
  assert.equal(cleanupOptions.maxRetries,5);assert.equal(cleanupOptions.retryDelay,100);
  assert.equal(console.warn.mock.callCount(),1);
  assert(!JSON.stringify(console.warn.mock.calls).includes('NEVER_DISCLOSE_KEY'));
 });
}

for(const entry of [
 {name:'DNS',code:1,error:{code:'ENOTFOUND',message:'fetch failed: getaddrinfo ENOTFOUND fixture.invalid'},expected:'MODEL_NETWORK_FAILED'},
 {name:'TLS',code:1,error:{code:'CERT_HAS_EXPIRED',message:'certificate has expired'},expected:'MODEL_TLS_FAILED'},
 {name:'HTTP 404',code:1,error:{code:'API_ERROR',message:'404 Not Found: /v1/responses'},expected:'MODEL_ENDPOINT_FAILED'},
 {name:'rate limit',code:1,error:{code:'API_ERROR',message:'429 Too Many Requests'},expected:'MODEL_RATE_LIMITED'},
 {name:'unsupported CLI flag',code:1,stderr:"error: unknown option '--patch'",expected:'CLI_VERSION_UNSUPPORTED'},
 {name:'DSH startup audit',code:1,stderr:'startup failed: plugin initialization failed\nFull diagnostics: C:\\private\\startup-1.log',expected:'CLI_STARTUP_FAILED'},
 {name:'Windows console initialization',code:1,stderr:'desktop CLI: cannot register the Windows console handler',expected:'CLI_STARTUP_FAILED'},
 {name:'missing runtime after stdin closes',code:9009,stderr:"'node' is not recognized as an internal or external command",brokenInput:true,expected:'CLI_RUNTIME_MISSING'},
 {name:'DSH error with zero process status',code:0,error:{code:'MISSING_CREDENTIAL',message:'missing credential'},expected:'CLI_LOGIN_REQUIRED'}
]){
 test(`${entry.name} reports its category without raw diagnostics`,async()=>{
  const stderr=(entry.stderr||'')+'\nprivate=NEVER_DISCLOSE_KEY';
  const error=entry.error?{...entry.error,message:entry.error.message+' token=NEVER_DISCLOSE_KEY'}:undefined;
  const agent=new AgentService({secrets,spawn:cli({...entry,stderr,error})});
  await assert.rejects(agent.suggest(records,config),reason=>reason.code===entry.expected&&!reason.message.includes('NEVER_DISCLOSE_KEY')&&!reason.message.includes('C:\\private'));
 });
}

test('unrecognized CLI failure includes exit status without claiming a cause',async()=>{
 const agent=new AgentService({secrets,spawn:cli({code:23,stderr:'opaque failure NEVER_DISCLOSE_KEY'})});
 await assert.rejects(agent.suggest(records,config),reason=>reason.code==='CLI_FAILED'&&reason.message.includes('23')&&!reason.message.includes('NEVER_DISCLOSE_KEY'));
});
