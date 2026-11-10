import test from 'node:test';
import assert from 'node:assert/strict';
import {SubmissionService} from '../app/submission.js';

/** Deletion runs against the same stored batch/history shapes as submission; only the remote JIRA is controlled. */
function fixture({status='success',worklogId='701'}={}) {
 const record={id:'a',batchId:'batch',day:'2024-02-15',title:'事项A',hours:1,seconds:3600,type:'需求分析',task:'需求调研及分析',issue:'DEMO-1',targetKey:'DEMO-2',worklogId,status,author:'A',source:'按天填报'};
 const other={...record,id:'b',title:'事项B',worklogId:'702'};
 const scope={site:'https://jira.test',project:'DEMO',user:'A'};
 let data={history:[record,other],drafts:[],batches:[{id:'batch',scope,running:false,items:[record,other]}],bindings:{},settings:{}};
 let remote=worklogId?{id:worklogId,author:'A',issue:'DEMO-2'}:null;
 const deleted=[],updates=[];
 const store={load:async()=>structuredClone(data),update:async(scope,fn)=>{const next=structuredClone(data);await fn(next);data=next;return structuredClone(data);}};
 const jira={url:scope.site,projectKey:'DEMO',identity:{name:'alice',key:'A'},connect:async()=>({user:{name:'alice',key:'A'}}),getWorklog:async()=>structuredClone(remote),deleteWorklog:async id=>{deleted.push(id);remote=null;}};
 const service=new SubmissionService({store,jira,onUpdate:batch=>updates.push(batch)});
 return {record,other,scope,store,jira,service,deleted,updates,state:()=>data,setRemote:value=>{remote=value;}};
}

test('delete registered worklog first, then remove its history and mark the original item deleted',async()=>{
 const f=fixture();await f.service.getBatch('batch');await f.service.deleteRecord('a');
 assert.deepEqual(f.deleted,['701']);assert.deepEqual(f.state().history,[f.other]);
 assert.equal(f.state().batches[0].items[0].status,'deleted');assert.equal(f.state().batches[0].items[1].status,'success');
 assert.equal((await f.service.getBatch('batch')).items[0].status,'deleted');assert.equal(f.updates.at(-1).items[0].status,'deleted');
});
test('remote permission failure preserves the local record and original batch result',async()=>{
 const f=fixture();f.jira.deleteWorklog=async()=>{throw Object.assign(Error('no permission'),{code:'PERMISSION'});};
 await assert.rejects(f.service.deleteRecord('a'),{code:'PERMISSION'});
 assert.equal(f.state().history.length,2);assert.equal(f.state().batches[0].items[0].status,'success');
});
test('current account cannot delete another author worklog',async()=>{
 const f=fixture();f.setRemote({id:'701',author:'OTHER'});
 await assert.rejects(f.service.deleteRecord('a'),{code:'IDENTITY'});assert.equal(f.deleted.length,0);assert.equal(f.state().history.length,2);
});
test('an already absent remote worklog only needs local cleanup',async()=>{
 const f=fixture();f.setRemote(null);await f.service.deleteRecord('a');assert.equal(f.deleted.length,0);assert.equal(f.state().history.length,1);
});
test('lost DELETE response is accepted only after the worklog is confirmed absent',async()=>{
 for(const applied of [true,false]){
  const f=fixture();f.jira.deleteWorklog=async()=>{if(applied)f.setRemote(null);throw Object.assign(Error('lost receipt'),{code:'NETWORK',uncertain:true});};
  if(applied){await f.service.deleteRecord('a');assert.equal(f.state().history.length,1);}
  else{await assert.rejects(f.service.deleteRecord('a'),{code:'DELETE_UNCONFIRMED'});assert.equal(f.state().history.length,2);}
 }
});
test('failed readback preserves local history and a later attempt cleans it without another DELETE',async()=>{
 const f=fixture(),read=f.jira.getWorklog;let fail=false;
 f.jira.deleteWorklog=async id=>{f.deleted.push(id);f.setRemote(null);fail=true;};
 f.jira.getWorklog=async()=>{if(fail)throw Object.assign(Error('offline'),{code:'NETWORK'});return read();};
 await assert.rejects(f.service.deleteRecord('a'),{code:'NETWORK'});assert.equal(f.state().history.length,2);
 fail=false;await f.service.deleteRecord('a');assert.equal(f.deleted.length,1);assert.equal(f.state().history.length,1);
});
test('failed unsent records remove their matching draft, but uncertain writes require reconciliation',async()=>{
 const f=fixture({status:'failed',worklogId:''});f.state().drafts.push({...f.record});await f.service.deleteRecord('a');
 assert.equal(f.state().history.length,1);assert.equal(f.state().drafts.length,0);assert.equal(f.deleted.length,0);
 const pending=fixture({status:'uncertain',worklogId:''});await assert.rejects(pending.service.deleteRecord('a'),{code:'UNCERTAIN'});assert.equal(pending.state().history.length,2);
});
test('running batches must finish before records are deleted',async()=>{
 const f=fixture();f.state().batches[0].running=true;await assert.rejects(f.service.deleteRecord('a'),{code:'BUSY'});assert.equal(f.deleted.length,0);
});
test('deleted items cannot retry, return to drafts, or reappear when a sibling result persists',async()=>{
 const f=fixture();await f.service.getBatch('batch');await f.service.deleteRecord('a');
 await assert.rejects(f.service.retry('batch','a'),{code:'DELETED'});
 await f.service.returnToDrafts('batch');assert.equal(f.state().drafts.length,0);
 await f.service.persist(f.service.batches.get('batch'));assert.deepEqual(f.state().history.map(row=>row.id),['b']);
});
test('unknown records do not call DELETE',async()=>{
 const f=fixture();await assert.rejects(f.service.deleteRecord('missing'),{code:'NOT_FOUND'});assert.equal(f.deleted.length,0);
});
