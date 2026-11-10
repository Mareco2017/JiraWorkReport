import test from 'node:test';
import assert from 'node:assert/strict';
import {SubmissionService} from '../app/submission.js';

function fixture({status='success',worklogId='701'}={}) {
 const record={id:'a',batchId:'batch',day:'2024-02-15',title:'原事项',hours:1,seconds:3600,type:'需求分析',task:'需求调研及分析',issue:'DEMO-1',targetKey:'DEMO-2',worklogId,status,author:'A',source:'按天填报'};
 const other={...record,id:'b',title:'保留事项',worklogId:'702'};
 const scope={site:'https://jira.test',project:'DEMO',user:'A'};let data={history:[record,other],drafts:[],batches:[{id:'batch',scope,running:false,items:[record,other]}],bindings:{},settings:{}};
 let remote={id:worklogId,author:'A',issue:'DEMO-2',day:record.day,title:record.title,seconds:record.seconds,typeValue:'需求分析会议'};const writes=[],updates=[];
 const store={load:async()=>structuredClone(data),update:async(scope,fn)=>{const next=structuredClone(data);await fn(next);data=next;return structuredClone(data);}};
 const jira={url:scope.site,projectKey:'DEMO',identity:{name:'alice',key:'A'},connect:async()=>({user:{name:'alice',key:'A'}}),getWorklog:async()=>structuredClone(remote),updateWorklog:async(id,row)=>{writes.push({id,row});remote={...remote,title:row.title,day:row.day,seconds:row.seconds};}};
 const service=new SubmissionService({store,jira,today:()=> '2024-02-20',onUpdate:batch=>updates.push(batch)});
 return {record,other,scope,store,jira,service,writes,updates,state:()=>data,setRemote:value=>{remote=value;}};
}
const changes={title:'修改后的事项',day:'2024-02-16',hours:2.5};

test('edit updates the same worklog and synchronizes history and batch while preserving its destination',async()=>{
 const f=fixture();await f.service.getBatch('batch');await f.service.updateRecord('a',changes);
 const row=f.state().history[0];assert.equal(row.title,changes.title);assert.equal(row.day,changes.day);assert.equal(row.hours,2.5);assert.equal(row.seconds,9000);
 for(const field of ['worklogId','type','task','issue','targetKey','author'])assert.equal(row[field],f.record[field]);
 assert.deepEqual(f.state().history[1],f.other);assert.equal(f.writes[0].id,'701');assert.equal((await f.service.getBatch('batch')).items[0].hours,2.5);
 await f.service.persist(f.service.batches.get('batch'));assert.equal(f.state().history[0].title,changes.title);
});
test('permission failure leaves local history and batch unchanged',async()=>{
 const f=fixture();f.jira.updateWorklog=async()=>{throw Object.assign(Error('forbidden'),{code:'PERMISSION'});};
 await assert.rejects(f.service.updateRecord('a',changes),{code:'PERMISSION'});assert.deepEqual(f.state().history[0],f.record);
});
test('uncertain PUT completes only if the original ID reads back with the intended values',async()=>{
 for(const applied of [true,false]){
  const f=fixture(),write=f.jira.updateWorklog;
  f.jira.updateWorklog=async(id,row)=>{if(applied)await write(id,row);throw Object.assign(Error('lost receipt'),{code:'NETWORK',uncertain:true});};
  if(applied){await f.service.updateRecord('a',changes);assert.equal(f.state().history[0].hours,2.5);}
  else {await assert.rejects(f.service.updateRecord('a',changes),{code:'UPDATE_UNCONFIRMED'});assert.equal(f.state().history[0].hours,1);}
 }
});
test('failed readback retains local data; retry reconciles the same ID without another update',async()=>{
 const f=fixture(),read=f.jira.getWorklog,write=f.jira.updateWorklog;let offline=false;
 f.jira.updateWorklog=async(id,row)=>{await write(id,row);offline=true;};f.jira.getWorklog=async()=>{if(offline)throw Object.assign(Error('offline'),{code:'NETWORK'});return read();};
 await assert.rejects(f.service.updateRecord('a',changes),{code:'NETWORK'});assert.equal(f.state().history[0].hours,1);
 offline=false;await f.service.updateRecord('a',changes);assert.equal(f.writes.length,1);assert.equal(f.state().history[0].hours,2.5);
});
test('invalid editable fields fail before any remote update',async()=>{
 for(const values of [{title:' '},{day:'2024-02-30'},{day:'2024-02-21'},{hours:0},{hours:.25}]){
  const f=fixture();await assert.rejects(f.service.updateRecord('a',{...changes,...values}),{code:'INVALID_RECORD'});assert.equal(f.writes.length,0);
 }
});
test('other authors and absent remote worklogs cannot be edited',async()=>{
 const f=fixture();f.setRemote({...f.record,author:'OTHER'});await assert.rejects(f.service.updateRecord('a',changes),{code:'IDENTITY'});assert.equal(f.writes.length,0);
 const missing=fixture();missing.setRemote(null);await assert.rejects(missing.service.updateRecord('a',changes),{code:'NOT_FOUND'});assert.equal(missing.state().history[0].hours,1);
});
test('failed unsent records update their matching draft and batch without remote calls',async()=>{
 const f=fixture({status:'failed',worklogId:''});f.state().drafts.push({...f.record});await f.service.updateRecord('a',changes);
 assert.equal(f.state().history[0].title,changes.title);assert.equal(f.state().drafts[0].hours,2.5);assert.equal(f.state().batches[0].items[0].day,changes.day);assert.equal(f.writes.length,0);
});
test('running batches and uncertain records require completion before editing',async()=>{
 const f=fixture();f.state().batches[0].running=true;await assert.rejects(f.service.updateRecord('a',changes),{code:'BUSY'});
 const uncertain=fixture({status:'uncertain'});await assert.rejects(uncertain.service.updateRecord('a',changes),{code:'UNCERTAIN'});
});
test('changes cannot override the original ID, type, assignee or issue',async()=>{
 const f=fixture();await f.service.updateRecord('a',{...changes,id:'other',worklogId:'999',type:'UI设计',task:'UI设计',issue:'OTHER-1',author:'OTHER'});
 for(const k of ['id','worklogId','type','task','issue','author'])assert.equal(f.state().history[0][k],f.record[k]);
});
test('basic edits preserve historical type-task mappings rather than reassigning their destination',async()=>{
 const f=fixture();for(const row of [f.state().history[0],f.state().batches[0].items[0]]){row.type='UI设计';row.task='概要设计及评审';}
 await f.service.updateRecord('a',changes);assert.equal(f.state().history[0].task,'概要设计及评审');assert.equal(f.state().history[0].type,'UI设计');
});
