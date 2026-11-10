import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {AgentService} from '../app/agent.js';

const sample = [{id:'r1',title:'梳理客户需求',day:'2024-02-15',hours:2,issue:'DEMO-PRIVATE',private:'NEVER_SEND'}];
function processMock({engine='codex',answer=[{id:'r1',type:'需求分析',task:'需求调研及分析'}],code=0,stderr='',hang=false}={}) {
  const calls=[];
  function spawn(file,args,options) {
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    const chunks=[];child.stdin.on('data',chunk=>chunks.push(chunk.toString()));
    child.kill=()=>{child.killed=true;child.emit('close',null,'SIGTERM');};
    const call={file,args,options,child};calls.push(call);
    child.stdin.on('finish',()=>{
      call.input=chunks.join('');
      if(hang)return;
      queueMicrotask(()=>{
        const text=typeof answer==='string'?answer:JSON.stringify({suggestions:answer});
        const event=engine==='dsh'?{type:'final',text}:{type:'item.completed',item:{type:'agent_message',text}};
        child.stdout.write(JSON.stringify(event)+'\n');child.stderr.write(stderr);child.emit('close',code);
      });
    });
    return child;
  }
  return {spawn,calls};
}
const custom={engine:'Codex CLI',executable:'/sample/codex',mode:'custom',url:'https://models.example.test/v1',model:'team-model',keyRef:'ref1',approvedInternal:true};
const secrets={get:async()=> 'secret-only-child-env'};

test('TC-020 custom Codex emits constrained structured suggestions and sends minimal records',async()=>{
  const mock=processMock();const agent=new AgentService({secrets,spawn:mock.spawn});
  const result=await agent.suggest(sample,custom);
  assert.deepEqual(result,[{id:'r1',type:'需求分析',task:'需求调研及分析'}]);
  const call=mock.calls[0];
  assert.equal(call.options.shell,false);assert.equal(call.options.env.WORKBENCH_MODEL_KEY,'secret-only-child-env');
  assert(!JSON.stringify(call.args).includes('secret-only-child-env'));
  assert(!call.input.includes('NEVER_SEND'));assert(!call.input.includes('DEMO-PRIVATE'));assert(!call.input.includes('2024-02-15'));
  assert(call.args.includes('--ignore-user-config'));assert(call.args.includes('read-only'));
});

test('TC-021 unknown default or external service receives no real work item',async()=>{
  const mock=processMock();const agent=new AgentService({secrets,spawn:mock.spawn});
  await assert.rejects(agent.suggest(sample,{...custom,mode:'default'}),{code:'DESTINATION_UNVERIFIED'});
  await assert.rejects(agent.suggest(sample,{...custom,approvedInternal:false}),{code:'DESTINATION_UNVERIFIED'});
  assert.equal(mock.calls.length,0);
});

test('UI design suggestions use the dedicated UI design task',async()=>{
 const answer=[{id:'r1',type:'UI设计',task:'UI设计'}],mock=processMock({answer});
 assert.deepEqual(await new AgentService({secrets,spawn:mock.spawn}).suggest(sample,custom),answer);
 const old=processMock({answer:[{id:'r1',type:'UI设计',task:'概要设计及评审'}]});
 await assert.rejects(new AgentService({secrets,spawn:old.spawn}).suggest(sample,custom),{code:'INVALID_SUGGESTIONS'});
});

test('TC-020 test uses a fictional record and does not disclose actual notes to an external model',async()=>{
  const mock=processMock({answer:[{id:'connection-test',type:'需求分析',task:'需求调研及分析'}]});
  const agent=new AgentService({secrets,spawn:mock.spawn});
  assert.deepEqual(await agent.test({...custom,approvedInternal:false}),{ok:true,engine:'Codex CLI',model:'team-model'});
  assert(mock.calls[0].input.includes('connection-test'));
});

test('TC-021 a model may not amend a date, duration or issue and unknown values fail validation',async()=>{
  for(const answer of [
    [{id:'r1',type:'需求分析',task:'需求调研及分析',hours:8}],
    [{id:'unknown',type:'需求分析',task:'需求调研及分析'}],
    [{id:'r1',type:'作废类型',task:'需求调研及分析'}],
    [{id:'r1',type:'需求分析',task:'日常综合'}],
    'not json'
  ]) {
    const mock=processMock({answer});
    await assert.rejects(new AgentService({secrets,spawn:mock.spawn}).suggest(sample,custom),{code:'INVALID_SUGGESTIONS'});
  }
});

test('TC-020 DSH supplies a per-run patch with an environment reference and disabled tools',async()=>{
  const mock=processMock({engine:'dsh'});
  const agent=new AgentService({secrets,spawn:mock.spawn});
  assert.equal((await agent.suggest(sample,{...custom,engine:'DSH CLI',executable:'/sample/dsh'}))[0].type,'需求分析');
  const call=mock.calls[0];assert(call.args.includes('--patch'));assert(call.args.includes('--permission-mode'));
  assert(!call.args.join(' ').includes('secret-only-child-env'));
});

test('TC-020 CLI failures classify missing executable, login and timeouts without leaking stderr',async()=>{
  const missing=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('error',Object.assign(new Error('path'),{code:'ENOENT'})));return child;};
  await assert.rejects(new AgentService({secrets,spawn:missing}).suggest(sample,custom),{code:'CLI_NOT_FOUND'});
  const login=processMock({code:1,stderr:'Authentication required token=NEVER_REPORT'});
  await assert.rejects(new AgentService({secrets,spawn:login.spawn}).suggest(sample,custom),error=>error.code==='CLI_LOGIN_REQUIRED'&&!error.message.includes('NEVER_REPORT'));
  const timeout=processMock({hang:true});
  await assert.rejects(new AgentService({secrets,spawn:timeout.spawn,timeoutMs:10}).suggest(sample,custom),{code:'CLI_TIMEOUT'});
  assert.equal(timeout.calls[0].child.killed,true);
});

test('TC-021 JIRA credentials and unrelated environment secrets never reach the child process',async()=>{
  const previous=process.env.JIRA_TOKEN;
  process.env.JIRA_TOKEN='not-for-model';
  try {
    const mock=processMock();
    await new AgentService({secrets,spawn:mock.spawn}).suggest(sample,custom);
    assert.equal(mock.calls[0].options.env.JIRA_TOKEN,undefined);
  } finally {
    if(previous===undefined) delete process.env.JIRA_TOKEN;else process.env.JIRA_TOKEN=previous;
  }
});


test('TC-020 DSH keeps its native turn executor while removing registered work tools',async()=>{
  const output=processMock({engine:'dsh'});
  const spawn=(file,args,options)=>{
    const patch=JSON.parse(readFileSync(args[args.indexOf('--patch')+1],'utf8'));
    // The installed headless profile requires its native executor even when no tools are exposed.
    assert(!patch.some(item=>item.id==='tool-executor-native'&&item.disabled));
    for(const id of ['tool-bash','tool-fs','tool-web'])assert(patch.some(item=>item.id===id&&item.disabled));
    return output.spawn(file,args,options);
  };
  assert.equal((await new AgentService({secrets,spawn}).suggest(sample,{...custom,engine:'DSH CLI',executable:'/sample/dsh'}))[0].type,'需求分析');
});

test('TC-020 DSH structured final missing-credential reason is actionable without echoing provider text',async()=>{
  function spawn(){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    child.stdin.on('finish',()=>queueMicrotask(()=>{
      child.stdout.write(JSON.stringify({type:'final',reason:{kind:'error',error:{code:'MISSING_CREDENTIAL',message:'test-only-private-detail'}},text:''})+'\n');
      child.emit('close',1);
    }));
    return child;
  }
  await assert.rejects(new AgentService({secrets,spawn}).suggest(sample,{...custom,engine:'DSH CLI',executable:'/sample/dsh'}),error=>error.code==='CLI_LOGIN_REQUIRED'&&!error.message.includes('test-only-private-detail'));
});
