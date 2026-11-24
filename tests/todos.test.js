import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../app/store.js';
import {WorkbenchService} from '../app/service.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'personal-todo-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(root);store.loadConfig=()=>{throw Error('TODO must not read configuration');};
 let n=0;const service=new WorkbenchService({store,today:()=> '2026-11-11',todoId:()=> 'id-'+(++n),todoNow:()=>new Date('2026-11-11T09:00:00Z')});
 return {root,store,call:(command,data)=>service.call(command,data),file:join(root,'personal-todos.json')};
}
test('TODO independent empty load and title-only create survive reopening without config',async t=>{
 const {root,store,call}=await fixture(t);
 assert.deepEqual(await store.loadPersonalTodos(),{groups:[],todos:[]});assert.deepEqual(await readdir(root),[]);
 const created=await call('todoCreate',{title:'  first  ',id:'spoof',createdAt:'spoof'});
 const todo=created.state.todos[0];assert.equal(todo.title,'first');assert.equal(todo.status,'待处理');assert.notEqual(todo.id,'spoof');assert.equal(todo.description,'');assert.equal(todo.groupId,'');
 assert.equal((await new Store(root).loadPersonalTodos()).todos[0].id,todo.id);
 assert.equal((await call('todoLoad')).today,'2026-11-11');
});
test('TODO full edit, statuses, comments and deletion retain the correct identity and order',async t=>{
 const {call}=await fixture(t);const group=(await call('todoGroupCreate',{name:'  product  '})).id;
 const created=await call('todoCreate',{title:'first',description:'a\nb',dueDate:'2028-02-29',priority:'高',groupId:group});const id=created.id;
 const first=created.state.todos[0];
 for(const status of ['进行中','待处理','进行中','待处理']) assert.equal((await call('todoSetStatus',{id,status})).state.todos[0].status,status);
 assert.equal((await call('todoComplete',{id})).state.todos[0].status,'已完成');
 await assert.rejects(call('todoSetStatus',{id,status:'已完成'}),e=>e.code==='TODO_VALIDATION');
 const c1=(await call('todoCommentCreate',{todoId:id,content:'  line1\nline2  '})).id;const c2=(await call('todoCommentCreate',{todoId:id,content:'second'})).id;
 let result=await call('todoCommentUpdate',{todoId:id,id:c1,content:'changed'});assert.equal(result.state.todos[0].comments[0].edited,true);assert.equal(result.state.todos[0].comments[0].createdAt,first.createdAt);assert.equal(result.state.todos[0].comments[1].id,c2);assert.equal(result.state.todos[0].status,'已完成');
 result=await call('todoUpdate',{id,changes:{title:'new',description:'',dueDate:'',priority:'',groupId:'',status:'待处理',comments:[],createdAt:'spoof'}});
 assert.equal(result.state.todos[0].status,'已完成');assert.equal(result.state.todos[0].createdAt,first.createdAt);assert.equal(result.state.todos[0].comments.length,2);
 result=await call('todoCommentDelete',{todoId:id,id:c1});assert.equal(result.state.todos[0].comments[0].id,c2);
 assert.deepEqual((await call('todoDelete',{id})).state.todos,[]);
});
test('TODO group reorder, rename and delete keep items and comments and timestamps',async t=>{
 // 分组创建时间用于默认倒序。
 const {call,root}=await fixture(t);const a=(await call('todoGroupCreate',{name:'a'})).id,b=(await call('todoGroupCreate',{name:'b'})).id;
 const id=(await call('todoCreate',{title:'x',groupId:a})).id;await call('todoCommentCreate',{todoId:id,content:'keep'});
 const before=(await call('todoLoad')).state.todos[0];await call('todoGroupRename',{id:a,name:'renamed'});
 let result=await call('todoGroupReorder',{ids:[b,a]});assert.deepEqual(result.state.groups.map(g=>g.id),[b,a]);assert.deepEqual(result.state.todos[0],before);assert.equal(result.state.groupOrderManual,true,'保存手动顺序后以手动排序为准');
 result=await call('todoGroupDelete',{id:a});assert.equal(result.state.todos[0].groupId,'');assert.equal(result.state.todos[0].comments[0].content,'keep');assert.equal(result.state.todos[0].title,'x');
 assert.deepEqual((await new Store(root).loadPersonalTodos()).groups.map(g=>g.id),[b]);
});
test('新分组默认置顶，且所有分组都可手动排序',async t=>{
 const {call}=await fixture(t);
 const a=(await call('todoGroupCreate',{name:'a'})).id;
 const b=(await call('todoGroupCreate',{name:'b'})).id;
 assert.deepEqual((await call('todoLoad')).state.groups.map(g=>g.id),[b,a],'新分组应排在最前');
 await call('todoGroupReorder',{ids:[a,b]});
 const c=(await call('todoGroupCreate',{name:'c'})).id;
 assert.deepEqual((await call('todoLoad')).state.groups.map(g=>g.id),[c,a,b],'手动排序后新分组仍置顶');
 await call('todoGroupReorder',{ids:[b,c,a]});
 assert.deepEqual((await call('todoLoad')).state.groups.map(g=>g.id),[b,c,a],'所有分组都可手动排序');
});

test('TODO validation rejects invalid fields and foreign targets without writing',async t=>{
 const {call,file}=await fixture(t);const a=(await call('todoGroupCreate',{name:'a'})).id;const id=(await call('todoCreate',{title:'x'})).id;
 const comment=(await call('todoCommentCreate',{todoId:id,content:'keep'})).id;const other=(await call('todoCreate',{title:'other'})).id;
 const before=await readFile(file,'utf8');
 const invalid=[['todoCreate',{title:' '}],['todoCreate',{title:'x',dueDate:'2026-02-30'}],['todoCreate',{title:'x',description:3}],['todoCreate',{title:'x',priority:'urgent'}],['todoCreate',{title:'x',groupId:'missing'}],['todoSetStatus',{id,status:'unknown'}],['todoUpdate',{id,changes:[]}],['todoDelete',{id:'missing'}],['todoGroupCreate',{name:' a '}],['todoGroupCreate',{name:'全部'}],['todoGroupRename',{id:a,name:' '}],['todoGroupReorder',{ids:[a,a]}],['todoGroupReorder',{ids:[]}],['todoCommentCreate',{todoId:id,content:' '}],['todoCommentDelete',{todoId:other,id:comment}],['todoCommentUpdate',{todoId:other,id:comment,content:'x'}],['todoCreate',null]];
 for(const [command,data] of invalid){await assert.rejects(call(command,data),e=>e.code==='TODO_VALIDATION'&&Boolean(e.field),command);assert.equal(await readFile(file,'utf8'),before,command);}
 await assert.rejects(call('todoUnsupported',{}),/不支持/);
});
test('TODO damaged files are errors and never silently replaced',async t=>{
 const {call,file,root}=await fixture(t);
 for(const content of ['{broken','[]','{"groups":{},"todos":[]}','{"groups":[],"todos":[{"id":"x","status":"bad"}]}']){
  await writeFile(file,content);await assert.rejects(call('todoLoad'),e=>e.code==='TODO_READ_FAILED');await assert.rejects(call('todoCreate',{title:'x'}),e=>e.code==='TODO_READ_FAILED');assert.equal(await readFile(file,'utf8'),content);assert.deepEqual(await readdir(root),['personal-todos.json']);
 }
 await writeFile(file,'{"groups":[],"todos":[]}');assert.equal((await call('todoCreate',{title:'recovered'})).state.todos.length,1);
});
test('TODO real I/O write failure keeps old bytes and the queue can retry',async t=>{
 const {call,file,root}=await fixture(t);const id=(await call('todoCreate',{title:'old'})).id;const before=await readFile(file,'utf8');
 await chmod(root,0o500);
 try {await assert.rejects(call('todoUpdate',{id,changes:{title:'new'}}),e=>e.code==='TODO_SAVE_FAILED');assert.equal(await readFile(file,'utf8'),before);}
 finally {await chmod(root,0o700);}
 const result=await call('todoUpdate',{id,changes:{title:'new'}});assert.equal(result.state.todos[0].title,'new');assert.deepEqual(await readdir(root),['personal-todos.json']);
});
test('TODO completion write failure keeps parent and subtasks unchanged',async t=>{
 const {call,file,root}=await fixture(t);const id=(await call('todoCreate',{title:'complete fail'})).id;
 await call('todoSubtaskCreate',{todoId:id,title:'child'});
 const before=await readFile(file,'utf8');
 await chmod(root,0o500);
 try{
  await assert.rejects(call('todoComplete',{id}),e=>e.code==='TODO_SAVE_FAILED');
  assert.equal(await readFile(file,'utf8'),before);
  const state=JSON.parse(before);
  assert.equal(state.todos[0].status,'待处理');assert.equal(state.todos[0].subtasks[0].done,false);
 }finally{await chmod(root,0o700);}
 const result=await call('todoComplete',{id});
 assert.equal(result.state.todos[0].status,'已完成');assert.equal(result.state.todos[0].subtasks[0].done,true);
});
test('TODO simultaneous commands read current state within the existing file queue',async t=>{
 const {call,store}=await fixture(t);await Promise.all(Array.from({length:10},(_,i)=>call('todoCreate',{title:'item '+i})));
 assert.equal((await store.loadPersonalTodos()).todos.length,10);
});

test('TODO persisted records require every current field instead of creating defaults on read',async t=>{
 const {call,file}=await fixture(t);const created=await call('todoCreate',{title:'complete'});
 for(const field of ['description','dueDate','priority','groupId']){
  const state=structuredClone(created.state);delete state.todos[0][field];const content=JSON.stringify(state);await writeFile(file,content);
  await assert.rejects(call('todoLoad'),e=>e.code==='TODO_READ_FAILED');assert.equal(await readFile(file,'utf8'),content);
 }
});
test('TODO entire successful lifecycle leaves workspaces and configuration byte-for-byte unchanged',async t=>{
 const {call,root,store}=await fixture(t);const scope={site:'https://jira-a.invalid',project:'P1',user:'u1'};
 await store.saveConfig({jira:{url:scope.site,keyRef:'test-reference'},agent:{engine:'test',keyRef:'agent-reference'}});
 await store.update(scope,state=>{state.drafts.push({id:'draft',title:'protected'});state.history.push({id:'history'});state.bindings['2026-11']={key:'P1-1'};});
 const files=[join(root,'settings.json'),store.workspacePath(scope)];const before=await Promise.all(files.map(file=>readFile(file,'utf8')));
 const a=(await call('todoGroupCreate',{name:'a'})).id,b=(await call('todoGroupCreate',{name:'b'})).id;
 const id=(await call('todoCreate',{title:'local',groupId:a})).id;
 const comment=(await call('todoCommentCreate',{todoId:id,content:'comment'})).id;
 await call('todoUpdate',{id,changes:{groupId:b,title:'moved'}});await call('todoGroupRename',{id:a,name:'renamed'});await call('todoGroupReorder',{ids:[b,a]});
 await call('todoComplete',{id});await call('todoCommentUpdate',{todoId:id,id:comment,content:'edited'});await call('todoCommentDelete',{todoId:id,id:comment});
 await call('todoGroupDelete',{id:b});await call('todoDelete',{id});await call('todoGroupDelete',{id:a});
 assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),before);assert.deepEqual(await store.loadPersonalTodos(),{groups:[],todos:[]});
});
test('TODO a read I/O error remains separate from empty and succeeds after permission is restored',async t=>{
 const {call,file}=await fixture(t);await call('todoCreate',{title:'keep'});await chmod(file,0o000);
 try{await assert.rejects(call('todoLoad'),e=>e.code==='TODO_READ_FAILED');}finally{await chmod(file,0o600);}
 assert.equal((await call('todoLoad')).state.todos[0].title,'keep');
});

test('TODO subtasks create, check, edit, delete and persist in order', async t => {
 const {call,root}=await fixture(t);const id=(await call('todoCreate',{title:'parent'})).id;
 const created=await call('todoSubtaskCreate',{todoId:id,title:'  first  '});
 assert.equal(created.state.todos[0].subtasks[0].title,'first');
 assert.equal(created.state.todos[0].subtasks[0].done,false);
 const first=created.id;
 const second=(await call('todoSubtaskCreate',{todoId:id,title:'second'})).id;
 assert.deepEqual((await call('todoLoad')).state.todos[0].subtasks.map(row=>row.title),['first','second']);
 let result=await call('todoSubtaskSetDone',{todoId:id,id:first,done:true});
 assert.equal(result.state.todos[0].subtasks[0].done,true);
 assert.equal(result.state.todos[0].subtasks[1].done,false);
 result=await call('todoSubtaskUpdate',{todoId:id,id:second,title:'  updated  '});
 assert.equal(result.state.todos[0].subtasks[1].title,'updated');
 assert.equal(result.state.todos[0].subtasks[1].done,false);
 result=await call('todoSubtaskDelete',{todoId:id,id:first});
 assert.deepEqual(result.state.todos[0].subtasks.map(row=>row.title),['updated']);
 const reopened=(await new Store(root).loadPersonalTodos()).todos[0];
 assert.deepEqual(reopened.subtasks.map(row=>row.title),['updated']);
 assert.equal(reopened.subtasks[0].done,false);
});

test('TODO subtask validation rejects invalid fields and foreign targets without writing', async t => {
 const {call,file}=await fixture(t);const a=(await call('todoCreate',{title:'a'})).id,b=(await call('todoCreate',{title:'b'})).id;
 const sub=(await call('todoSubtaskCreate',{todoId:a,title:'keep'})).id;
 const before=await readFile(file,'utf8');
 const invalid=[
  ['todoSubtaskCreate',{todoId:a,title:' '}],
  ['todoSubtaskCreate',{todoId:'missing',title:'x'}],
  ['todoSubtaskUpdate',{todoId:a,id:'missing',title:'x'}],
  ['todoSubtaskUpdate',{todoId:b,id:sub,title:'x'}],
  ['todoSubtaskSetDone',{todoId:a,id:sub,done:'true'}],
  ['todoSubtaskSetDone',{todoId:a,id:'missing',done:true}],
  ['todoSubtaskDelete',{todoId:b,id:sub}],
  ['todoSubtaskDelete',{todoId:a,id:'missing'}],
  ['todoSubtaskCreate',null],
 ];
 for(const [command,data] of invalid){await assert.rejects(call(command,data),e=>e.code==='TODO_VALIDATION'&&Boolean(e.field),command);assert.equal(await readFile(file,'utf8'),before,command);}
});

test('TODO old todos without subtasks load as empty and invalid subtasks fail without replacement', async t => {
 const {call,file}=await fixture(t);const id=(await call('todoCreate',{title:'legacy'})).id;
 const state=JSON.parse(await readFile(file,'utf8'));delete state.todos[0].subtasks;
 await writeFile(file,JSON.stringify(state));const before=await readFile(file,'utf8');
 assert.deepEqual((await call('todoLoad')).state.todos[0].subtasks,[]);
 assert.equal(await readFile(file,'utf8'),before);
 const invalid=[
  {subtasks:null},
  {subtasks:{}},
  {subtasks:[{id:'x',title:'',done:false}]},
  {subtasks:[{id:'x',title:'x',done:'false'}]},
  {subtasks:[{id:'x',title:'x',done:false},{id:'x',title:'y',done:false}]},
 ];
 for(const change of invalid){
  const next=JSON.parse(await readFile(file,'utf8'));Object.assign(next.todos[0],change);await writeFile(file,JSON.stringify(next));const bytes=await readFile(file,'utf8');
  await assert.rejects(call('todoLoad'),e=>e.code==='TODO_READ_FAILED');assert.equal(await readFile(file,'utf8'),bytes);
 }
});

test('TODO new todos include an empty subtask list and parent deletion removes them', async t => {
 const {call,file,root}=await fixture(t);const id=(await call('todoCreate',{title:'parent'})).id;
 assert.deepEqual((await call('todoLoad')).state.todos[0].subtasks,[]);
 await call('todoSubtaskCreate',{todoId:id,title:'child'});
 assert.equal(JSON.parse(await readFile(file,'utf8')).todos[0].subtasks.length,1);
 const result=await call('todoDelete',{id});
 assert.deepEqual(result.state.todos,[]);
 assert.deepEqual(await new Store(root).loadPersonalTodos(),{groups:[],todos:[]});
});

test('TODO subtask operations update parent updatedAt without changing other fields', async t => {
 const root=await mkdtemp(join(tmpdir(),'personal-todo-clock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(root);let n=0;const times=['2026-11-11T09:00:00Z','2026-11-11T09:01:00Z','2026-11-11T09:02:00Z','2026-11-11T09:03:00Z','2026-11-11T09:04:00Z'];
 const service=new WorkbenchService({store,today:()=> '2026-11-11',todoId:()=> 'id-'+(++n),todoNow:()=>new Date(times.shift())});
 const call=(command,data)=>service.call(command,data);
 const id=(await call('todoCreate',{title:'parent'})).id;const before=(await call('todoLoad')).state.todos[0];
 const sub=(await call('todoSubtaskCreate',{todoId:id,title:'child'})).id;
 await call('todoSubtaskSetDone',{todoId:id,id:sub,done:true});
 await call('todoSubtaskUpdate',{todoId:id,id:sub,title:'updated'});
 const after=(await call('todoLoad')).state.todos[0];
 assert.equal(after.status,before.status);assert.equal(after.groupId,before.groupId);assert.deepEqual(after.comments,before.comments);
 assert.notEqual(after.updatedAt,before.updatedAt);assert.ok(new Date(after.updatedAt)>new Date(before.updatedAt));
});
