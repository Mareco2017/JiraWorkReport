import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchService } from '../app/service.js';
test('unknown renderer command is rejected before dependencies are called', async () => {
 const service=new WorkbenchService({});
 await assert.rejects(service.call('readAnyFile',{path:'/private/file'}), /不支持/);
});
test('initial load returns only redacted settings and local drafts', async () => {
 const service=new WorkbenchService({store:{loadConfig:async()=>({jira:{url:'https://jira.test',username:'alice',keyRef:'secret-ref'}}),load:async()=>({drafts:[],history:[]})}});
 const state=await service.call('initialize');
 assert.equal(state.config.jira.hasToken,true);
 assert.equal(JSON.stringify(state).includes('secret-ref'),false);
});
test('private project defaults preserve old workspace data and reach JIRA connections',async()=>{
 let config={jira:{url:'https://jira.example.test',username:'alice',userKey:'A',keyRef:'ref'}},loadedScope;
 const projects=[],opened=[];
 const service=new WorkbenchService({
  defaultProject:'TEAM',
  store:{loadConfig:async()=>config,saveConfig:async value=>{config=value;},load:async scope=>{loadedScope=scope;return {drafts:[{id:'existing'}],history:[]};}},
  secrets:{get:async()=> 'fixture-token',put:async()=> 'new-ref'},
  createJira:options=>{projects.push(options.project);return {connect:async()=>({user:{name:'alice',key:'A',timeZone:'Asia/Shanghai'},project:{key:'TEAM'},types:[]})};},
  openExternal:async url=>opened.push(url)
 });
 assert.equal((await service.call('initialize')).state.drafts[0].id,'existing');
 assert.deepEqual(loadedScope,{site:'https://jira.example.test',project:'TEAM',user:'A'});
 await service.call('openIssue',{key:'TEAM-123'});
 assert.deepEqual(opened,['https://jira.example.test/browse/TEAM-123']);
 await assert.rejects(service.call('openIssue',{key:'DEMO-123'}),/工单号无效/);
 await service.call('testJira',{url:config.jira.url,username:'alice'});
 await service.call('saveJira',{url:config.jira.url,username:'alice'});
 assert.equal(config.jira.projectKey,'TEAM');
 assert(projects.every(project=>project==='TEAM'));
 service.defaultProject='DEMO';
 await service.call('initialize');
 assert.equal(loadedScope.project,'TEAM');
});
test('view issue opens the configured JIRA detail URL directly',async()=>{
 const opened=[];
 const service=new WorkbenchService({store:{loadConfig:async()=>({jira:{url:'https://jira.example.test',username:'alice',keyRef:'ref'}})},secrets:{get:async()=> 'fixture'},createJira:()=>({}),openExternal:async url=>opened.push(url)});
 await service.call('openIssue',{key:'DEMO-105'});assert.deepEqual(opened,['https://jira.example.test/browse/DEMO-105']);
 await assert.rejects(service.call('openIssue',{key:'https://unrelated.test'}),/工单号无效/);assert.equal(opened.length,1);
});
test('switching back to a previously saved model uses its host credential reference',async()=>{
 let candidate;
 const service=new WorkbenchService({
  store:{loadConfig:async()=>({agent:{url:'https://other.test',keyRef:'other'},modelServices:[{url:'https://old.test',model:'old-model',keyRef:'saved'}]})},
  agent:{test:async input=>{candidate=input;return {ok:true};}}
 });
 await service.call('testAgent',{config:{engine:'Codex CLI',mode:'custom',url:'https://old.test',model:'old-model'}});
 assert.equal(candidate.keyRef,'saved');
 assert.equal(candidate.approvedInternal,false);
});
test('only host-verified internal origins can receive real note suggestions',async()=>{
 let candidate;
 const service=new WorkbenchService({
  trustedModelOrigins:['https://models.internal.test'],
  store:{loadConfig:async()=>({})},
  agent:{test:async config=>{candidate=config;return {ok:true};}}
 });
 await service.call('testAgent',{config:{engine:'Codex CLI',mode:'custom',url:'https://models.internal.test/v1',model:'m'}});
 assert.equal(candidate.approvedInternal,true);
 await service.call('testAgent',{config:{engine:'Codex CLI',mode:'custom',url:'https://external.test/v1',model:'m',approvedInternal:true}});
 assert.equal(candidate.approvedInternal,false);
});

test('legacy saved DSH engine labels are normalized once on config load without requesting credentials',async()=>{
 let observed,secretReads=0;
 const config={agent:{engine:'DSC CLI',executable:'/sample/dsh',mode:'custom',url:'https://models.internal.test/v1',model:'m',keyRef:'old-encrypted-reference',approvedInternal:true},modelServices:[{engine:'DSC CLI',url:'https://models.internal.test/v1',model:'m',keyRef:'saved-service-reference'}]};
 const service=new WorkbenchService({
  store:{loadConfig:async()=>structuredClone(config),load:async()=>({drafts:[],history:[],bindings:{}})},
  secrets:{get:async()=>{secretReads++;throw Error('should not read the key during label normalization');}},
  agent:{suggest:async(records,candidate)=>{observed=candidate;return [{id:records[0].id,type:'需求分析',task:'需求调研及分析'}];}}
 });
 const loaded=await service.call('initialize');
 assert.equal(loaded.config.agent.engine,'DSH CLI');
 assert.equal(loaded.config.modelServices[0].engine,'DSH CLI');
 assert.equal(loaded.config.agent.hasToken,true);
 assert(!JSON.stringify(loaded).includes('old-encrypted-reference'));
 await service.call('suggest',{records:[{id:'legacy-row',title:'虚构事项'}]});
 assert.equal(observed.engine,'DSH CLI');
 assert.equal(observed.keyRef,'old-encrypted-reference');
 assert.equal(secretReads,0);
});
