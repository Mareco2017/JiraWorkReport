import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.js';
import {WorkbenchService} from '../app/service.js';
import {JiraClient} from '../app/jira.js';
import {SubmissionService} from '../app/submission.js';

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'jira-service-integration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new Store(directory),keys=new Map();let nextKey=0;const logs=[],posts=[];
 const secrets={put:async value=>{const key='ref-'+(++nextKey);keys.set(key,value);return key;},get:async key=>keys.get(key)};
 const who={name:'alice',key:'A',timeZone:'Asia/Shanghai'};
 const issue={id:'101',key:'DEMO-1',fields:{summary:'需求',issuetype:{id:'10001'},project:{key:'DEMO'},assignee:who,subtasks:[{id:'102',key:'DEMO-2',fields:{summary:'需求调研及分析'}}]}};
 let failOnce=false;
 const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const request=async(url,options)=>{
   const path=new URL(url).pathname;
   if(options.headers.Authorization=== 'Basic '+Buffer.from('alice:invalid').toString('base64'))return response({},401);
   if(path.endsWith('/myself'))return response(who);
   if(path.endsWith('/project/DEMO'))return response({id:'10000',key:'DEMO'});
   if(path.endsWith('/work-attribute'))return response([{id:3,key:'_产品工时类型_',values:[{name:'需求分析',value:'需求分析会议'}]}]);
   if(path.endsWith('/issue/DEMO-1'))return response(issue);
   if(path.endsWith('/issue/DEMO-2/worklog'))return response({total:logs.length,worklogs:logs});
   if(path.endsWith('/worklogs/')&&options.method==='POST'){
     const body=JSON.parse(options.body);posts.push(body);
     if(failOnce){failOnce=false;return response({},429);}
     const id=String(700+posts.length);logs.push({id,author:who,started:body.started,timeSpentSeconds:body.timeSpentSeconds,comment:body.comment});return response({id},201);
   }
   if(/\/worklogs\/\d+$/.test(path)&&options.method==='DELETE'){
     const id=path.split('/').at(-1),at=logs.findIndex(row=>row.id===id);if(at>=0)logs.splice(at,1);return new Response(null,{status:204});
   }
   if(/\/worklogs\/\d+$/.test(path)&&options.method==='PUT'){
     const row=logs.find(row=>row.id===path.split('/').at(-1)),body=JSON.parse(options.body);
     Object.assign(row,{comment:body.comment,started:body.started,timeSpentSeconds:body.timeSpentSeconds});return response({originId:row.id});
   }
   if(/\/worklogs\/\d+$/.test(path))return response({attributes:{'_产品工时类型_':{value:'需求分析会议'}}});
   throw Error('unexpected endpoint '+path);
 };
 const service=new WorkbenchService({store,secrets,createJira:options=>new JiraClient({...options,request}),createSubmission:jira=>new SubmissionService({store,jira})});
 async function connect(token='sample'){await service.call('testJira',{url:'https://jira.example.test',username:'alice',token});return service.call('saveJira',{url:'https://jira.example.test',username:'alice'});}
 return {service,store,keys,posts,connect,issue,setFail:()=>{failOnce=true;}};
}
const draft=id=>({id,title:'事项'+id,day:'2024-02-15',hours:1,type:'需求分析',task:'需求调研及分析',issue:'DEMO-1',source:'按天填报'});

test('A integration: real service entry saves redacted auth, persists draft and retries only the failed item',async t=>{
 const f=await fixture(t);await f.connect();
 const config=(await f.service.call('initialize')).config;assert.equal(config.jira.hasToken,true);assert.equal(JSON.stringify(config).includes('ref-'),false);
 await f.service.call('saveDraft',{record:draft('a')});assert.equal((await f.service.call('initialize')).state.drafts.length,1);
 f.setFail();const batch=await f.service.call('startSubmission',{records:[draft('a')]});await f.service.submission.wait(batch.id);
 assert.equal((await f.service.call('getBatch',{id:batch.id})).items[0].status,'failed');
 await f.service.call('retry',{batchId:batch.id,itemId:'a'});await f.service.submission.wait(batch.id);
 const result=await f.service.call('getBatch',{id:batch.id});assert.equal(result.items[0].status,'success');
 const state=(await f.service.call('initialize')).state;assert.equal(state.history.length,1);assert.equal(state.drafts.length,0);assert.equal(f.posts.length,2);
});

test('A integration: failed replacement token invalidates the old test and cannot save an unverified connection',async t=>{
 const f=await fixture(t);
 await f.service.call('testJira',{url:'https://jira.example.test',username:'alice',token:'sample'});
 await assert.rejects(f.service.call('testJira',{url:'https://jira.example.test',username:'alice',token:'invalid'}),{code:'AUTH'});
 await assert.rejects(f.service.call('saveJira',{url:'https://jira.example.test',username:'alice'}),/先测试/);
 assert.equal((await f.store.loadConfig()).jira,undefined);
});

test('record deletion bridge removes the remote ID and history while preserving a sibling and restart state',async t=>{
 const f=await fixture(t);await f.connect();
 const batch=await f.service.call('startSubmission',{records:[draft('delete-a'),draft('keep-b')]});await f.service.submission.wait(batch.id);
 const first=(await f.service.call('initialize')).state.history.find(row=>row.id==='delete-a');assert(first.worklogId);
 await f.service.call('deleteRecord',{id:'delete-a'});
 const state=(await f.service.call('initialize')).state;assert.deepEqual(state.history.map(row=>row.id),['keep-b']);assert.equal(state.batches[0].items[0].status,'deleted');
 await f.service.submission.persist(f.service.submission.batches.get(batch.id));assert.equal((await f.service.call('initialize')).state.history.length,1);
 const reopened=new SubmissionService({store:f.store,jira:f.service.submission.jira});await assert.rejects(reopened.retry(batch.id,'delete-a'),{code:'DELETED'});
 await assert.rejects(f.service.call('deleteRecord',{id:123}),/请选择/);
});

test('A integration: wrong owner, project and issue type cannot replace an existing monthly binding',async t=>{
 const f=await fixture(t);await f.connect();
 const original=structuredClone(f.issue);
 Object.assign(f.issue.fields,{issuetype:{id:'10002'}});
 await f.service.call('bindMonth',{month:'2024-02',issue:'DEMO-1'});
 for(const change of [{assignee:{name:'bob',key:'B'}},{project:{key:'OTHER'}},{issuetype:{id:'10003'}}]){
   f.issue.fields={...original.fields,issuetype:{id:'10002'},...change};
   await assert.rejects(f.service.call('bindMonth',{month:'2024-02',issue:'DEMO-1'}),/当前账号/);
   assert.equal((await f.service.call('initialize')).state.bindings['2024-02'].key,'DEMO-1');
 }
 assert.equal(f.posts.length,0);
});

test('monthly settings may bind an existing story monthly issue',async t=>{
 const f=await fixture(t);await f.connect();
 f.issue.fields.summary='2026年11月综合工时';
 await f.service.call('bindMonth',{month:'2026-11',issue:'DEMO-1'});
 const binding=(await f.service.call('initialize')).state.bindings['2026-11'];
 assert.equal(binding.key,'DEMO-1');assert.equal(binding.title,'2026年11月综合工时');assert.equal(binding.source,'手动指定');assert.equal(f.posts.length,0);
});

test('A integration: unfinished rows return to editable drafts while successful history and frozen batch remain intact',async t=>{
 const f=await fixture(t);await f.connect();f.setFail();
 await f.service.call('saveDraft',{record:draft('a')});await f.service.call('saveDraft',{record:draft('b')});
 const batch=await f.service.call('startSubmission',{records:[draft('a'),draft('b')]});await f.service.submission.wait(batch.id);
 const old=await f.service.call('getBatch',{id:batch.id});assert.deepEqual(old.items.map(row=>row.status),['failed','success']);
 const ids=await f.service.call('returnToDrafts',{batchId:batch.id});assert.deepEqual(ids,['a']);
 const state=(await f.service.call('initialize')).state;assert.deepEqual(state.drafts.map(row=>row.id),['a']);
 assert.equal(state.history.find(row=>row.id==='b').worklogId,old.items[1].worklogId);
 const frozen=await f.service.call('getBatch',{id:batch.id});assert.equal(frozen.items[1].worklogId,old.items[1].worklogId);assert.equal(f.posts.length,2);
});

test('record edit bridge updates the existing remote ID, local history and stored batch on restart',async t=>{
 const f=await fixture(t);await f.connect();const batch=await f.service.call('startSubmission',{records:[draft('edit-a'),draft('keep-b')]});await f.service.submission.wait(batch.id);
 const before=(await f.service.call('initialize')).state.history.find(row=>row.id==='edit-a');
 await f.service.call('updateRecord',{id:'edit-a',changes:{title:'已修改事项',day:'2024-02-16',hours:2.5}});
 const after=(await f.service.call('initialize')).state.history.find(row=>row.id==='edit-a');assert.equal(after.worklogId,before.worklogId);assert.equal(after.hours,2.5);assert.equal(after.day,'2024-02-16');assert.equal(f.posts.length,2);
 const reopened=new SubmissionService({store:f.store,jira:f.service.submission.jira});assert.equal((await reopened.getBatch(batch.id)).items[0].title,'已修改事项');
 await assert.rejects(f.service.call('updateRecord',{id:'edit-a',changes:null}),/请填写/);
});
