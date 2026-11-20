import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.js';
import {PersonalTodoService} from '../app/todos.js';
import {BatchImportService,todoEntryRecordId} from '../app/batch-import.js';
import {WorkbenchService} from '../app/service.js';
import {SubmissionService} from '../app/submission.js';

const TODAY='2026-11-17';
const scope={site:'https://fixture.invalid',project:'EXEPD',user:'tester'};

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'todo-worklog-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(root);let n=0;
 const todos=new PersonalTodoService({store,today:()=>TODAY,id:()=>'id-'+(++n),now:()=>new Date('2026-11-17T02:00:00Z')});
 return {root,store,todos,file:join(root,'personal-todos.json')};
}
async function created(f,title){return (await f.todos.call('todoCreate',{title})).id;}
const entry=(hours,extra={})=>({hours,day:TODAY,...extra});

test('待办可记录多笔工时，汇总按笔累加',async t=>{
 const f=await fixture(t);const id=await created(f,'多笔工时');
 const first=await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1.5,{day:'2026-11-16'})});
 assert.ok(first.id,'新增返回这一笔的编号');
 await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(.25)});
 await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2,{day:'2026-11-20'})});
 const todo=(await f.todos.call('todoLoad')).state.todos[0];
 assert.deepEqual(todo.workLogs.map(row=>row.hours),[1.5,.25,2]);
 assert.deepEqual(todo.workLogs.map(row=>row.state),['recorded','recorded','recorded']);
 assert.equal(todo.workLogs.reduce((sum,row)=>sum+row.hours,0),3.75);
});

test('工时校验：0.25 步长、合法日期，允许未来日期',async t=>{
 const f=await fixture(t);const id=await created(f,'校验');
 const before=await readFile(f.file,'utf8');
 for(const hours of [0,.1,.3,.375,'abc',null])await assert.rejects(f.todos.call('todoAddWorkLog',{todoId:id,workLog:{hours,day:TODAY}}),e=>e.code==='TODO_VALIDATION');
 await assert.rejects(f.todos.call('todoAddWorkLog',{todoId:id,workLog:{hours:1,day:'2026-02-30'}}),e=>e.code==='TODO_VALIDATION');
 await assert.rejects(f.todos.call('todoAddWorkLog',{todoId:id,workLog:[]}),e=>e.code==='TODO_VALIDATION');
 assert.equal(await readFile(f.file,'utf8'),before);
 const future=await f.todos.call('todoAddWorkLog',{todoId:id,workLog:{hours:1,day:'2027-01-05'}});
 assert.equal(future.state.todos[0].workLogs[0].day,'2027-01-05');
});

test('修改一笔工时支持只改日期或工时，已登记的一笔不可改',async t=>{
 const f=await fixture(t);const id=await created(f,'修改');
 const added=await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)});
 const entryId=added.id;
 let state=(await f.todos.call('todoUpdateWorkLog',{todoId:id,entryId,workLog:{hours:2}})).state;
 assert.equal(state.todos[0].workLogs[0].hours,2);
 assert.equal(state.todos[0].workLogs[0].day,TODAY);
 state=(await f.todos.call('todoUpdateWorkLog',{todoId:id,entryId,workLog:{day:'2026-11-15'}})).state;
 assert.equal(state.todos[0].workLogs[0].day,'2026-11-15');
 await f.todos.markSubmitted(id,entryId,{worklogId:'9',recordId:'r9',targetKey:'EXEPD-1'});
 await assert.rejects(f.todos.call('todoUpdateWorkLog',{todoId:id,entryId,workLog:{hours:3}}),e=>e.code==='TODO_VALIDATION');
});

test('单笔描述持久化并带入，旧记录沿用待办标题，工单仍可取自待办标题',async t=>{
 const f=await fixture(t),id=await created(f,'EXEPD-123 待办标题');
 const first=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1,{description:'  补充报表筛选  '})})).id;
 const legacy=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 await assert.rejects(f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1,{description:3})}),{field:'description'});
 const service=new WorkbenchService({store:new Store(f.root),defaultProject:'EXEPD'});
 const load=async()=>(await service.call('importTodos',{entryIds:[first,legacy]})).records;
 const [described,old]=await load();
 assert.deepEqual([described.title,described.issue,old.title],['补充报表筛选','EXEPD-123','EXEPD-123 待办标题']);
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:first,workLog:{description:'整理验收记录'}});
 assert.equal((await load())[0].title,'整理验收记录');
 await service.call('saveDraft',{record:{...(await load())[0],title:'批量已手改'}});
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:first,workLog:{description:''}});
 const [conflict]=await load();
 assert.equal(conflict.title,'批量已手改');
 assert.deepEqual(conflict.todoConflicts,{title:{previous:'整理验收记录',current:'EXEPD-123 待办标题'}});
});

test('删除一笔：未登记直接删，已登记需 force',async t=>{
 const f=await fixture(t);const id=await created(f,'删除');
 const a=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const b=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2)})).id;
 await f.todos.markSubmitted(id,b,{worklogId:'9',recordId:'r9'});
 await assert.rejects(f.todos.call('todoDeleteWorkLog',{todoId:id,entryId:b}),e=>e.code==='TODO_VALIDATION');
 let state=(await f.todos.call('todoDeleteWorkLog',{todoId:id,entryId:a})).state;
 assert.deepEqual(state.todos[0].workLogs.map(row=>row.id),[b]);
 state=await f.todos.deleteWorkLog(id,b,{force:true});
 assert.equal(state.todos[0].workLogs.length,0);
});

test('完成待办可顺手记一笔，也可不记；完成时间单独保存',async t=>{
 const f=await fixture(t);const a=await created(f,'带工时完成'),b=await created(f,'只完成');
 await f.todos.call('todoComplete',{id:a,workLog:entry(1.5)});
 await f.todos.call('todoComplete',{id:b});
 const state=(await f.todos.call('todoLoad')).state;
 const first=state.todos.find(row=>row.id===a),second=state.todos.find(row=>row.id===b);
 assert.equal(first.status,'已完成');assert.equal(first.workLogs.length,1);assert.equal(first.workLogs[0].hours,1.5);
 assert.equal(second.status,'已完成');assert.equal(second.workLogs,undefined);
 assert.equal(first.completedAt,'2026-11-17T02:00:00.000Z');
});

test('新建待办可直接记录工时并设为已完成',async t=>{
 const f=await fixture(t);
 const created=await f.todos.call('todoCreate',{title:'新建即完成',status:'已完成',workLog:{hours:1.5,day:TODAY}});
 const todo=created.state.todos[0];
 assert.equal(todo.status,'已完成');
 assert.equal(todo.workLogs[0].hours,1.5);
 assert.equal(todo.workLogs[0].state,'recorded');
 assert.equal(todo.completedAt,'2026-11-17T02:00:00.000Z');
 await assert.rejects(f.todos.call('todoCreate',{title:'坏状态',status:'未知'}),e=>e.code==='TODO_VALIDATION');
 await assert.rejects(f.todos.call('todoCreate',{title:'坏工时',workLog:{hours:.1,day:TODAY}}),e=>e.code==='TODO_VALIDATION');
});

test('旧单条 workLog 读取时丢弃，保存后不残留',async t=>{
 const f=await fixture(t);
 await writeFile(f.file,JSON.stringify({groups:[],todos:[{id:'old',title:'旧数据',description:'',dueDate:'',priority:'',groupId:'',status:'已完成',createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',comments:[],completedAt:'2026-11-01T00:00:00.000Z',workLog:{hours:2,day:'2026-11-01',state:'recorded'}}]}));
 const state=(await f.todos.call('todoLoad')).state;
 assert.equal(state.todos[0].workLog,undefined);
 assert.equal(state.todos[0].title,'旧数据');
 await f.todos.call('todoAddWorkLog',{todoId:'old',workLog:entry(1)});
 const raw=JSON.parse(await readFile(f.file,'utf8'));
 assert.equal(raw.todos[0].workLog,undefined,'保存后不应残留旧字段');
 assert.equal(raw.todos[0].workLogs.length,1);
});

test('带入按笔生成记录，类型为空且重复带入不新增',async t=>{
 const f=await fixture(t);
 const id=await created(f,'EXEPD-101 示例需求评审');
 const a=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1.5,{day:'2026-11-16'})})).id;
 const b=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2,{day:'2026-11-17'})})).id;
 await f.todos.call('todoComplete',{id});
 const todos=(await f.todos.call('todoLoad')).state.todos;
 const importer=new BatchImportService({store:f.store,agent:{},documentsFactory:()=>{}});
 const result=await importer.importTodos({entryIds:[a,b]},todos,scope);
 assert.equal(result.records.length,2,'一笔工时一行');
 assert.deepEqual(result.records.map(row=>row.todoEntryId).sort(),[a,b].sort());
 assert.deepEqual(result.records.map(row=>row.hours).sort(),[1.5,2]);
 assert.deepEqual(result.records.map(row=>row.day).sort(),['2026-11-16','2026-11-17']);
 for(const row of result.records){assert.equal(row.type,'');assert.equal(row.task,'');assert.equal(row.issue,'EXEPD-101');}
 assert.equal(result.records[0].id,todoEntryRecordId(result.records[0].todoEntryId));
 const again=await importer.importTodos({entryIds:[a,b]},todos,scope);
 assert.equal((await f.store.load(scope)).drafts.length,2,'草稿不重复');
});

test('只带入未登记的笔；已登记笔计数不符时整体拒绝',async t=>{
 const f=await fixture(t);
 const id=await created(f,'部分登记');
 const a=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const b=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2)})).id;
 await f.todos.call('todoComplete',{id});
 await f.todos.markSubmitted(id,a,{worklogId:'9',recordId:'r9'});
 const todos=(await f.todos.call('todoLoad')).state.todos;
 const importer=new BatchImportService({store:f.store,agent:{},documentsFactory:()=>{}});
 // 勾选集合里混入已登记笔时整体拒绝，提示刷新后重选
 await assert.rejects(importer.importTodos({entryIds:[a,b]},todos,scope),e=>e.code==='INVALID_TODOS');
 const result=await importer.importTodos({entryIds:[b]},todos,scope);
 assert.equal(result.records.length,1);
 assert.equal(result.records[0].todoEntryId,b);
});

test('未完成的待办也可以带入工时',async t=>{
 const f=await fixture(t);const id=await created(f,'进行中的待办');
 const e=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const todos=(await f.todos.call('todoLoad')).state.todos;
 const importer=new BatchImportService({store:f.store,agent:{},documentsFactory:()=>{}});
 const result=await importer.importTodos({entryIds:[e]},todos,scope);
 assert.equal(result.records.length,1);
 assert.equal(result.records[0].todoEntryId,e);
});

test('服务层：提交回写只影响对应一笔，删除记录只回退该笔',async t=>{
 const f=await fixture(t);const id=await created(f,'回写');
 const a=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const b=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2)})).id;
 const service=new WorkbenchService({store:f.store,secrets:{get:async()=>'k'},agent:{},defaultProject:'EXEPD',createJira:()=>{throw Error('unused');},createSubmission:()=>{throw Error('unused');}});
 await service.settleTodo({id:'rec-a',todoId:id,todoEntryId:a,status:'success',worklogId:'7001',targetKey:'EXEPD-2',day:'2026-11-16'});
 let todo=(await f.todos.call('todoLoad')).state.todos[0];
 assert.equal(todo.workLogs.find(row=>row.id===a).state,'submitted');
 assert.equal(todo.workLogs.find(row=>row.id===a).recordId,'rec-a');
 assert.equal(todo.workLogs.find(row=>row.id===b).state,'recorded');
 await service.releaseTodo({id:'rec-a',todoId:id,todoEntryId:a});
 todo=(await f.todos.call('todoLoad')).state.todos[0];
 assert.equal(todo.workLogs.find(row=>row.id===a).state,'recorded');
 assert.equal(todo.workLogs.find(row=>row.id===a).recordId,undefined);
});

test('服务层：改删未登记笔同步草稿；删已登记笔先删远端',async t=>{
 const f=await fixture(t);const id=await created(f,'同步');
 const a=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const b=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(2)})).id;
 await f.todos.call('todoComplete',{id});
 await f.store.saveConfig({jira:{url:'https://fixture.invalid',projectKey:'EXEPD',username:'tester',keyRef:'k'}});
 const deleted=[];
 const service=new WorkbenchService({store:f.store,secrets:{get:async()=>'k'},agent:{},defaultProject:'EXEPD',createJira:()=>({}),createSubmission:()=>({deleteRecord:async recordId=>{deleted.push(recordId);return {id:recordId};}})});
 const importer=new BatchImportService({store:f.store,agent:{},documentsFactory:()=>{}});
 const todos=(await f.todos.call('todoLoad')).state.todos;
 const imported=await importer.importTodos({entryIds:[a,b]},todos,scope);
 const recA=imported.records.find(row=>row.todoEntryId===a),recB=imported.records.find(row=>row.todoEntryId===b);
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:a,workLog:{hours:3,day:'2026-11-14'}});
 let draft=(await f.store.load(scope)).drafts.find(row=>row.id===recA.id);
 assert.equal(draft.hours,3);assert.equal(draft.day,'2026-11-14');
 await service.call('todoDeleteWorkLog',{todoId:id,entryId:a});
 assert.equal((await f.store.load(scope)).drafts.find(row=>row.id===recA.id),undefined);
 await f.todos.markSubmitted(id,b,{worklogId:'9',recordId:recB.id,targetKey:'EXEPD-2'});
 await service.call('todoDeleteWorkLog',{todoId:id,entryId:b});
 assert.deepEqual(deleted,[recB.id]);
 assert.equal((await f.todos.call('todoLoad')).state.todos[0].workLogs.length,0);
});

test('待办删除后刷新会删除其未登记带入草稿，手填草稿保留',async t=>{
 const f=await fixture(t);const id=await created(f,'待删除待办');
 const e=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 await f.store.saveConfig({jira:{url:'https://fixture.invalid',projectKey:'EXEPD',username:'tester',keyRef:'k'}});
 await f.store.update(scope,current=>{current.drafts.push({id:'manual-draft',title:'手填草稿'});});
 const service=new WorkbenchService({store:f.store,secrets:{get:async()=>'k'},agent:{},defaultProject:'EXEPD',createJira:()=>({}),createSubmission:()=>({deleteRecord:async()=>({})})});
 const importer=new BatchImportService({store:f.store,agent:{},documentsFactory:()=>{}});
 await importer.importTodos({entryIds:[e]},(await f.todos.call('todoLoad')).state.todos,scope);
 let drafts=(await f.store.load(scope)).drafts;
 const todoDraft=drafts.find(row=>row.todoEntryId===e);
 assert.ok(todoDraft);
 await service.call('todoDelete',{id});
 const result=await service.call('syncTodoDrafts');
 assert.deepEqual(result.removed,[todoDraft.id]);
 drafts=(await f.store.load(scope)).drafts;
 assert.deepEqual(drafts.map(row=>row.id),['manual-draft'],'只删待办来源的草稿');
});

test('提交层只对带笔标识的记录回写',async t=>{
 const settled=[];
 const submission=new SubmissionService({store:new Store(tmpdir()),jira:{},onItemSettled:async item=>settled.push(item)});
 await submission.settle({id:'r1',todoId:'t1',todoEntryId:'e1',status:'success',worklogId:'9'});
 await submission.settle({id:'r2',todoId:'t1',status:'success'});
 await submission.settle({id:'r3',todoId:'t1',todoEntryId:'e1',status:'failed'});
 assert.equal(settled.length,1);
 assert.equal(settled[0].todoEntryId,'e1');
});

test('A-01/A-03 切换账号后重新带入同步来源，手改冲突保留两边的值',async t=>{
 const f=await fixture(t),id=await created(f,'跨账号工时');
 const e=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 const service=new WorkbenchService({store:f.store,defaultProject:'EXEPD'});
 const use=async username=>f.store.saveConfig({jira:{url:scope.site,projectKey:scope.project,username,keyRef:'k'}});
 const load=async()=>(await service.call('importTodos',{entryIds:[e]})).records[0];
 await use(scope.user);
 const first=await load();
 await service.call('saveDraft',{record:{...first,type:'需求分析',issue:'EXEPD-123'}});
 await use('other');
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:e,workLog:{hours:2}});
 assert.equal((await load()).type,'');
 await use(scope.user);
 const second=await load();
 assert.deepEqual([second.hours,second.type,second.issue],[2,'需求分析','EXEPD-123']);
 await service.call('saveDraft',{record:{...second,hours:'1.5'}});
 await use('other');
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:e,workLog:{hours:3,day:'2026-11-16'}});
 await use(scope.user);
 const conflict=await load();
 assert.equal(conflict.hours,'1.5');
 assert.equal(conflict.day,'2026-11-16');
 assert.deepEqual(conflict.todoConflicts,{hours:{previous:2,current:3}});
});

test('A-04/A-05 来源变更拦截旧确认，删除失败项后跨重启不能再写入或恢复',async t=>{
 const f=await fixture(t),id=await created(f,'删除后重试');
 const e=(await f.todos.call('todoAddWorkLog',{todoId:id,workLog:entry(1)})).id;
 await f.store.saveConfig({jira:{url:scope.site,projectKey:scope.project,username:scope.user,keyRef:'k'}});
 const posts=[],parent={key:'EXEPD-1',typeId:'10001',project:'EXEPD',subtasks:[{key:'EXEPD-2',title:'需求调研及分析'}]};
 const jira={url:scope.site,projectKey:scope.project,identity:{name:scope.user},types:[{name:'需求分析'}],connect:async()=>({user:{name:scope.user}}),getIssue:async()=>parent,listWorklogs:async()=>[],submitWorklog:async row=>{posts.push(row);throw Error('暂时失败');}};
 const open=()=>new WorkbenchService({store:f.store,createJira:()=>jira,createSubmission:(jira,hooks)=>new SubmissionService({store:f.store,jira,...hooks,today:()=>TODAY}),secrets:{get:async()=>'k'}});
 const fill=async service=>({...((await service.call('importTodos',{entryIds:[e]})).records[0]),type:'需求分析',task:'需求调研及分析',issue:'EXEPD-1'});
 let service=open();const original=await fill(service);
 await service.call('todoUpdateWorkLog',{todoId:id,entryId:e,workLog:{hours:2}});
 await assert.rejects(service.call('startSubmission',{records:[original]}),{code:'TODO_CHANGED'});
 assert.equal(posts.length,0);
 const valid=await fill(service);
 const batch=await service.call('startSubmission',{records:[valid]});
 await service.submission.wait(batch.id);
 assert.equal(posts.length,1);
 assert.equal(posts[0].hours,2);
 await service.call('todoDeleteWorkLog',{todoId:id,entryId:e});
 service=open();
 await assert.rejects(service.call('retry',{batchId:batch.id,itemId:valid.id}),{code:'TODO_REMOVED'});
 assert.deepEqual(await service.call('returnToDrafts',{batchId:batch.id}),[]);
 assert.equal(posts.length,1);
 assert.equal((await f.store.load(scope)).drafts.length,0);
});
