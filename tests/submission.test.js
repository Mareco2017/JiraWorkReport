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


test('手填子任务直接使用该子任务，不创建任何子任务',async()=>{
 const jira=api();
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([{...record('pick'),issue:'',subtaskKey:'S-2'}]);
 await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'success');
 assert.equal(item.targetKey,'S-2');
 assert.equal(item.issue,'S-1');
 assert.equal(item.issueSource,'subtask');
 assert.equal(jira.created.length,0);
 assert.equal(jira.posts[0].targetKey,'S-2');
});

test('手填子任务以所属工单为准，覆盖行内已选工单',async()=>{
 const jira=api();
 const get=jira.getIssue;
 jira.getIssue=async key=>key==='OTHER-1'?{key:'OTHER-1',id:'900',title:'另一需求',typeId:'10001',project:'DEMO',subtasks:[]}:get(key);
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([{...record('override'),issue:'OTHER-1',subtaskKey:'S-2'}]);
 await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'success');
 assert.equal(item.issue,'S-1');
 assert.equal(item.targetKey,'S-2');
});

test('手填编号不是子任务时拒绝且不写入',async()=>{
 const jira=api();
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([{...record('bad'),issue:'',subtaskKey:'S-1'}]);
 await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'failed');
 assert.equal(item.code,'SUBTASK');
 assert.equal(jira.posts.length,0);
 assert.equal(jira.created.length,0);
});

test('月度任务手填已有子任务时使用该子任务并绑定该月',async()=>{
 const jira=api();jira.types.push({name:'日常综合',value:'日常综合'});
 const get=jira.getIssue;
 jira.getIssue=async key=>key==='M-2'
  ?{key:'M-2',id:'302',title:'日常综合',typeId:'10003',project:'DEMO',parent:'MONTH'}
  :key==='MONTH'
   ?{key:'MONTH',id:'300',title:'2024年2月综合工时',typeId:'10002',project:'DEMO',assignee:'A',assigneeName:'alice',subtasks:[{key:'M-2',id:'302',title:'日常综合'}]}
   :get(key);
 const store=memoryStore(),service=new SubmissionService({store,jira});
 const batch=await service.start([{...record('month'),type:'日常综合',task:'日常综合',issue:'',subtaskKey:'M-2'}]);
 await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'success');
 assert.equal(item.targetKey,'M-2');
 assert.equal(item.issue,'MONTH');
 assert.equal(jira.created.length,0);
 const binding=(await store.load()).bindings['2024-02'];
 assert.equal(binding.key,'MONTH');
 assert.equal(binding.source,'手选子任务');
});

test('A-12 手选上月子任务不改变当月绑定或下一条去向',async()=>{
 const jira=api(),store=memoryStore();
 jira.types.push({name:'日常综合',value:'日常综合'});
 const month=(key,title,child)=>({key,id:key,title,typeId:'10002',project:'DEMO',assignee:'A',subtasks:[{key:child,id:child,title:'日常综合'}]});
 const january=month('M-1','2024年1月综合工时','M-2'),february=month('M-3','2024年2月综合工时','M-4');
 const issues={'M-1':january,'M-3':february,'M-2':{key:'M-2',id:'M-2',typeId:'10003',parent:'M-1'}};
 jira.getIssue=async key=>issues[key];
 await store.update(null,state=>{state.bindings['2024-02']={key:'M-3'};});
 const service=new SubmissionService({store,jira});
 const base={type:'日常综合',task:'日常综合',issue:''};
 const batch=await service.start([{...record('manual'),...base,subtaskKey:'M-2'},{...record('auto'),...base}]);
 await service.wait(batch.id);
 assert.deepEqual(jira.posts.map(row=>row.targetKey),['M-2','M-4']);
 assert.equal((await store.load()).bindings['2024-02'].key,'M-3');
});

test('A-09 月度填报失败退回后，按当前绑定重新选单',async()=>{
 const jira=api(),store=memoryStore();
 jira.types.push({name:'项目管理',value:'迭代项目管理'});
 jira.getIssue=async key=>({key,id:key,title:'2024年2月综合工时',typeId:'10002',project:'DEMO',assignee:'A',subtasks:[{key:key==='M-1'?'M-2':'M-4',title:'迭代项目管理'}]});
 const submit=jira.submitWorklog;
 jira.submitWorklog=async item=>{if(item.targetKey==='M-2')throw Error('远端明确拒绝本次写入');return submit(item);};
 await store.update(null,state=>{state.bindings['2024-02']={key:'M-1'};});
 const service=new SubmissionService({store,jira});
 const first=await service.start([{...record('a09'),type:'项目管理',task:'迭代项目管理',issue:''}]);
 assert.equal((await service.wait(first.id)).items[0].status,'failed');
 await store.update(null,state=>{state.bindings['2024-02']={key:'M-3'};});
 await service.returnToDrafts(first.id);
 const second=await service.start((await store.load()).drafts);
 assert.equal((await service.wait(second.id)).items[0].targetKey,'M-4');
 assert.deepEqual(jira.posts.map(row=>row.targetKey),['M-4']);
});

test('A-21 有多个同名子任务时不要静默写到第一个',async()=>{
 const jira=api(),get=jira.getIssue;
 jira.getIssue=async key=>({...await get(key),subtasks:[{key:'S-2',title:'需求调研及分析'},{key:'S-3',title:'需求调研及分析'}]});
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([record('same-title')]);
 const done=await service.wait(batch.id);
 assert.match(done.items[0].error,/同名子任务/);
 assert.equal(jira.posts.length,0);
 assert.equal(jira.created.length,0);
});

test('手填子任务不再限制父单类型：月度任务也能挂到需求故事下的子任务',async()=>{
 const jira=api();jira.types.push({name:'日常综合',value:'日常综合'});
 const store=memoryStore(),service=new SubmissionService({store,jira});
 const batch=await service.start([{...record('month-other'),type:'日常综合',task:'日常综合',issue:'',subtaskKey:'S-2'}]);
 await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'success');
 assert.equal(item.targetKey,'S-2');
 assert.equal(item.issue,'S-1');
 assert.equal(jira.created.length,0);
 assert.equal((await store.load()).bindings['2024-02'],undefined,'父单不是综合工时单时不绑定');
});

test('新功能/故事/任务三种父单都可创建子任务，其他类型提示不支持',async()=>{
 for(const typeId of ['10100','10001','10002']){
  const jira=api(),get=jira.getIssue;
  jira.getIssue=async key=>key==='S-1'?{...await get(key),typeId,subtasks:[]}:await get(key);
  const service=new SubmissionService({store:memoryStore(),jira});
  const batch=await service.start([record('ok-'+typeId)]);await service.wait(batch.id);
  const item=(await service.getBatch(batch.id)).items[0];
  assert.equal(item.status,'success',typeId);
  assert.equal(item.targetKey,'S-3');
  assert.equal(jira.created.length,1,typeId);
 }
 const jira=api(),get=jira.getIssue;
 jira.getIssue=async key=>key==='S-1'?{...await get(key),typeId:'10301',subtasks:[]}:await get(key);
 const service=new SubmissionService({store:memoryStore(),jira});
 const batch=await service.start([record('bad-type')]);await service.wait(batch.id);
 const item=(await service.getBatch(batch.id)).items[0];
 assert.equal(item.status,'failed');
 assert.equal(item.code,'TARGET');
 assert.match(item.error,/该类型的工单不支持创建子任务/);
 assert.equal(jira.posts.length,0);
});

test('新建子任务与新建月度工单都会带上报告人',async()=>{
 // 子任务创建
 const jira=api(),get=jira.getIssue;
 jira.getIssue=async key=>({...await get(key),subtasks:[]});
 const service=new SubmissionService({store:memoryStore(),jira});
 let batch=await service.start([record('report-child')]);await service.wait(batch.id);
 assert.equal(jira.created.length,1);
 assert.deepEqual(jira.created[0].reporter,{name:'alice'},'子任务需带 reporter');
 assert.equal((await service.getBatch(batch.id)).items[0].status,'success');

 // 月度工单创建
 const jira2=api();jira2.types.push({name:'日常综合',value:'日常综合'});
 const template={key:'M-1',id:'10',title:'2024年1月综合工时',created:'2024-01-01',typeId:'10002',project:'DEMO',assignee:'A',assigneeName:'alice',tenant:'888',businessLine:{id:'17008'},subtasks:[]};
 const monthParent={...template,key:'M-2',id:'20',title:'2024年2月产品综合工时管理',created:'2024-02-01'};
 jira2.searchMonthly=async()=>[template];
 jira2.createIssue=async fields=>{jira2.created.push(fields);return fields.issuetype.id==='10002'?monthParent:{key:'M-3',id:'30',title:fields.summary,typeId:'10003',project:'DEMO',parent:'M-2'};};
 jira2.getIssue=async key=>key==='M-2'?monthParent:{key:'M-3',id:'30',title:'日常综合',typeId:'10003',project:'DEMO',parent:'M-2'};
 const service2=new SubmissionService({store:memoryStore(),jira:jira2});
 batch=await service2.start([{...record('report-month'),issue:'',type:'日常综合',task:'日常综合'}]);await service2.wait(batch.id);
 const monthlyFields=jira2.created.find(fields=>fields.issuetype.id==='10002');
 assert.ok(monthlyFields,'应创建月度工单');
 assert.deepEqual(monthlyFields.reporter,{name:'alice'},'月工单需带 reporter');
});

test('自定义子任务名称优先复用同名子任务，没有同名时按该名称创建',async()=>{
 // 已存在同名子任务
 const jira=api(),get=jira.getIssue;
 jira.getIssue=async key=>key==='S-1'?{...await get(key),subtasks:[{key:'CUSTOM',id:'104',title:'样例功能改造'}]}:await get(key);
 let service=new SubmissionService({store:memoryStore(),jira});
 let batch=await service.start([{...record('custom-reuse'),task:'样例功能改造'}]);await service.wait(batch.id);
 assert.equal((await service.getBatch(batch.id)).items[0].targetKey,'CUSTOM');
 assert.equal(jira.created.length,0);

 // 父单下没有同名子任务
 const jira2=api(),get2=jira2.getIssue;
 jira2.getIssue=async key=>({...await get2(key),subtasks:[]});
 service=new SubmissionService({store:memoryStore(),jira:jira2});
 batch=await service.start([{...record('custom-create'),task:'样例功能改造'}]);await service.wait(batch.id);
 assert.equal((await service.getBatch(batch.id)).items[0].targetKey,'S-3');
 assert.equal(jira2.created[0].summary,'样例功能改造','创建时应使用编辑后的名称');
});

test('禁止创建且未手填子任务时在校验阶段拒绝',async()=>{
 const jira=api();
 const service=new SubmissionService({store:memoryStore(),jira});
 await assert.rejects(service.start([{...record('none'),createSubtask:false}]),{code:'INVALID_RECORD'});
});
