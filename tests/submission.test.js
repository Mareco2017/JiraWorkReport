import test from 'node:test';
import assert from 'node:assert/strict';
import {SubmissionService} from '../app/submission.js';

function memoryStore(){let data={drafts:[],batches:[],bindings:{},settings:{},history:[]};return {load:async()=>structuredClone(data),update:async(scope,fn)=>{const copy=structuredClone(data);await fn(copy);data=copy;return structuredClone(data);}};}
function api(){
 const posts=[],created=[],logs=[];
 const who={name:'alice',key:'A',timeZone:'Asia/Shanghai'};
 const issue={key:'S-1',id:'101',title:'需求',typeId:'10001',project:'DEMO',subtasks:[{key:'S-2',id:'102',title:'需求调研及分析'}]};
 return {url:'https://jira.example.test',projectKey:'DEMO',identity:who,types:[{name:'需求分析',value:'需求分析会议'}],who,posts,created,logs,
 connect:async()=>({user:who,project:{id:'10000',key:'DEMO'}}),getIssue:async key=>key==='S-1'?issue:{key,id:'102',title:'需求调研及分析',typeId:'10003',project:'DEMO',parent:'S-1'},
 listWorklogs:async()=>structuredClone(logs), getCreateMeta:async()=>({}),searchMonthly:async()=>[],
 createIssue:async fields=>{created.push(fields);return {key:'S-3',id:'103',title:fields.summary,typeId:fields.issuetype.id,project:'DEMO',subtasks:[]};},
 submitWorklog:async record=>{posts.push(record);const row={id:String(700+posts.length),issue:record.targetKey,author:'A',title:record.title,day:record.day,seconds:record.seconds,typeValue:'需求分析会议'};logs.push(row);return row;}
 };
}
const record=(id,hours=1)=>({id,day:'2024-02-15',title:'工作'+id,hours,type:'需求分析',issue:'S-1',task:'需求调研及分析',source:'按天填报'});

test('UI design creates or reuses only the exact UI design child',async()=>{
 for(const exists of [false,true]){
  const jira=api();jira.types.push({name:'UI设计',value:'产品UI设计'});
  const get=jira.getIssue;
  jira.getIssue=async key=>key==='S-1'?{...await get(key),subtasks:[{key:'OLD',id:'104',title:'概要设计及评审'},...(exists?[{key:'UI',id:'105',title:'UI设计'}]:[])]}:await get(key);
  const service=new SubmissionService({store:memoryStore(),jira});
  const batch=await service.start([{...record('ui'),type:'UI设计',task:'UI设计'}]);await service.wait(batch.id);
  const result=(await service.getBatch(batch.id)).items[0];assert.equal(result.status,'success');
  assert.equal(result.targetKey,exists?'UI':'S-3');assert.equal(jira.created.length,exists?0:1);
  if(!exists){const fields=jira.created[0];assert.equal(fields.summary,'UI设计');assert.equal(fields.customfield_14600,'2024-02-01');assert.equal(fields.duedate,'2024-02-29');assert.deepEqual(fields.timetracking,{originalEstimate:'0m',remainingEstimate:'0m'});assert.deepEqual(fields.assignee,{name:'alice'});}
 }
});

test('TC-016 partial failure retries only the original failed record, preserving successful worklog ID',async()=>{
 const jira=api(),original=jira.submitWorklog;let failed=false;
 jira.submitWorklog=async row=>{if(row.id==='b'&&!failed){failed=true;throw Object.assign(Error('temporary'),{code:'REMOTE'});}return original(row);};
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([record('a'),record('b')]);
 await service.wait(batch.id);
 const before=await service.getBatch(batch.id);
 assert.equal(before.items[0].status,'success');assert.equal(before.items[1].status,'failed');
 const id=before.items[0].worklogId;
 await service.retry(batch.id,before.items[1].id);await service.wait(batch.id);
 const done=await service.getBatch(batch.id);
 assert.deepEqual(done.items.map(item=>item.status),['success','success']);assert.equal(done.items[0].worklogId,id);assert.equal(jira.posts.filter(row=>row.id==='a').length,1);
});

test('TC-016 retry remains visibly retrying while the failed item is being written again',async()=>{
 const jira=api(),submit=jira.submitWorklog,states=[];let attempts=0;
 jira.submitWorklog=async row=>{if(++attempts===1)throw Object.assign(Error('temporary'),{code:'REMOTE'});assert.equal(row.status,'retrying');return submit(row);};
 const service=new SubmissionService({store:memoryStore(),jira,onUpdate:batch=>states.push(batch.items[0].status)});
 const batch=await service.start([record('retry-label')]);await service.wait(batch.id);
 states.length=0;await service.retry(batch.id,batch.items[0].id);await service.wait(batch.id);
 assert(states.includes('retrying'));assert.equal((await service.getBatch(batch.id)).items[0].status,'success');
});

test('TC-013 missing subtask uses work month bounds, zero estimates, and current account',async()=>{
 const jira=api(),get=jira.getIssue;jira.getIssue=async key=>({...await get(key),subtasks:[]});
 const service=new SubmissionService({store:memoryStore(),jira});const batch=await service.start([record('a')]);await service.wait(batch.id);
 assert.equal(jira.created.length,1);const f=jira.created[0];assert.equal(f.customfield_14600,'2024-02-01');assert.equal(f.duedate,'2024-02-29');assert.deepEqual(f.timetracking,{originalEstimate:'0m',remainingEstimate:'0m'});assert.deepEqual(f.assignee,{name:'alice'});
});

test('TC-018 cannot retry an original batch with another current account',async()=>{
 const jira=api();jira.submitWorklog=async()=>{throw Object.assign(Error('expired'),{code:'AUTH'});};
 const service=new SubmissionService({store:memoryStore(),jira});const batch=await service.start([record('a')]);await service.wait(batch.id);jira.who.key='B';jira.who.name='bob';
 await assert.rejects(service.retry(batch.id,batch.items[0].id),{code:'IDENTITY'});
});

test('TC-012 created monthly issue is bound before a later child failure; retry never creates another parent',async()=>{
 const jira=api();const template={key:'M-1',id:'10',title:'2024年1月综合工时',created:'2024-01-01',typeId:'10002',project:'DEMO',assignee:'A',tenant:'888',businessLine:{id:'17008'},subtasks:[]};
 const parent={...template,key:'M-2',id:'20',title:'2024年2月产品综合工时管理',created:'2024-02-01'};
 jira.types.push({name:'日常综合',value:'日常综合'});
 let parentCreates=0;
 jira.searchMonthly=async()=>[template];
 jira.createIssue=async fields=>{if(fields.issuetype.id==='10002'){parentCreates++;return parent;}throw Object.assign(Error('no child permission'),{code:'PERMISSION'});};
 jira.getIssue=async()=>parent;
 const store=memoryStore(),service=new SubmissionService({store,jira});
 const batch=await service.start([{...record('a'),issue:'',type:'日常综合',task:'日常综合'}]);await service.wait(batch.id);
 const state=await store.load();assert.equal(state.bindings['2024-02'].key,'M-2');assert.equal(state.bindings['2024-02'].source,'自动创建');assert.equal(parentCreates,1);
 assert.equal((await service.getBatch(batch.id)).items[0].code,'PERMISSION');
 await service.returnToDrafts(batch.id);
 jira.createIssue=async fields=>{if(fields.issuetype.id==='10002')parentCreates++;return {id:'30',key:'M-3',title:'日常综合'};};
 const next=await service.start((await store.load()).drafts);await service.wait(next.id);assert.equal(parentCreates,1);assert.equal((await service.getBatch(next.id)).items[0].status,'success');
});

test('TC-017 uncertain receipt matches only one truly new worklog with every business field equal',async()=>{
 const target={...record('a'),targetKey:'S-2',seconds:3600};
 const original={id:'700',issue:'S-2',author:'A',day:target.day,seconds:3600,title:target.title,typeValue:'需求分析会议'};
 for(const mutation of [{author:'B'},{issue:'S-9'},{day:'2024-02-16'},{seconds:1800},{title:'different'},{typeValue:'需求调研'}]) {
   const jira=api();jira.logs.push(original);
   jira.submitWorklog=async()=>{jira.logs.push({...original,id:'702',...mutation});throw Object.assign(Error('network lost'),{code:'NETWORK',uncertain:true});};
   const service=new SubmissionService({store:memoryStore(),jira});
   const batch=await service.start([{...record('a'),allowDuplicate:true}]);await service.wait(batch.id);
   const row=(await service.getBatch(batch.id)).items[0];assert.equal(row.status,'uncertain');assert.equal(row.worklogId,'');
 }
 const jira=api();jira.submitWorklog=async row=>{jira.logs.push({...original,id:'701'});throw Object.assign(Error('lost'),{code:'NETWORK',uncertain:true});};
 const service=new SubmissionService({store:memoryStore(),jira});const batch=await service.start([record('a')]);await service.wait(batch.id);
 assert.equal((await service.getBatch(batch.id)).items[0].worklogId,'701');
});

test('TC-004 excluded duplicate stays a draft and does not enter submitted history',async()=>{
 const jira=api();jira.logs.push({id:'700',author:'A',title:'工作a',day:'2024-02-15',seconds:3600,issue:'S-2',typeValue:'需求分析会议'});
 const store=memoryStore(),service=new SubmissionService({store,jira});
 const batch=await service.start([record('a')]);await service.wait(batch.id);
 assert.equal((await service.getBatch(batch.id)).items[0].status,'duplicate');assert.equal(jira.posts.length,0);assert.equal((await store.load()).history.length,0);
 await service.retry(batch.id,batch.items[0].id,{allowDuplicate:true});await service.wait(batch.id);assert.equal(jira.posts.length,1);
});

test('TC-015 returned batch marker survives restart without changing frozen results',async()=>{
 const jira=api();let attempt=0;const submit=jira.submitWorklog;
 jira.submitWorklog=async row=>{if(++attempt===1)throw Object.assign(Error('failed'),{code:'REMOTE'});return submit(row);};
 const store=memoryStore();const service=new SubmissionService({store,jira});
 const batch=await service.start([record('a'),record('b')]);await service.wait(batch.id);
 const before=(await service.getBatch(batch.id)).items;
 await service.returnToDrafts(batch.id);
 assert.equal((await service.getBatch(batch.id)).returnedToDrafts,true);
 const reopened=new SubmissionService({store,jira});
 const restored=await reopened.getBatch(batch.id);
 assert.equal(restored.returnedToDrafts,true);
 assert.deepEqual(restored.items,before);
 assert.equal(jira.posts.filter(row=>row.id==='b').length,1);
});

test('explicit requirement destinations bypass monthly lookup for management and presales',async()=>{
 for(const [type,task] of [['项目管理','开发协同及验收'],['售前及实施支持','需求调研及分析']]){
  const jira=api();jira.types.push({name:type,value:type});
  jira.getIssue=async()=>({key:'S-1',id:'101',title:'具体需求',typeId:'10001',project:'DEMO',subtasks:[{key:'CHILD',id:'104',title:task}]});
  let monthlyQueries=0;jira.searchMonthly=async()=>{monthlyQueries++;return [];};
  const service=new SubmissionService({store:memoryStore(),jira});const batch=await service.start([{...record(type),type,task}]);await service.wait(batch.id);
  const item=(await service.getBatch(batch.id)).items[0];assert.equal(item.status,'success');assert.equal(item.targetKey,'CHILD');assert.equal(item.task,task);assert.equal(monthlyQueries,0);assert.equal(jira.created.length,0);
 }
});

test('monthly fallback reuses an existing story monthly issue for both optional requirement types',async()=>{
 for(const [type,task] of [['项目管理','迭代项目管理'],['售前及实施支持','工单及线上问题处理']]){
  const jira=api();jira.types.push({name:type,value:type});
  const parent={key:'MONTH',id:'300',title:'2024年2月综合工时',typeId:'10001',project:'DEMO',assignee:'A',created:'2024-02-01',subtasks:[{key:'MONTH-CHILD',id:'301',title:task}]};
  jira.searchMonthly=async()=>[parent];jira.getIssue=async()=>parent;
  const store=memoryStore(),service=new SubmissionService({store,jira});const batch=await service.start([{...record(type),type,task,issue:''}]);await service.wait(batch.id);
  const item=(await service.getBatch(batch.id)).items[0];assert.equal(item.status,'success');assert.equal(item.targetKey,'MONTH-CHILD');assert.equal(jira.created.length,0);assert.equal((await store.load()).bindings['2024-02'].key,'MONTH');
 }
});
