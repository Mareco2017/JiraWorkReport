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
 const created=await call('todoCreate',{title:'  first  ',id:'spoof',status:'已完成',createdAt:'spoof'});
 const todo=created.state.todos[0];assert.equal(todo.title,'first');assert.equal(todo.status,'待处理');assert.notEqual(todo.id,'spoof');assert.equal(todo.description,'');assert.equal(todo.groupId,'');
 assert.equal((await new Store(root).loadPersonalTodos()).todos[0].id,todo.id);
 assert.equal((await call('todoLoad')).today,'2026-11-11');
});
test('TODO full edit, statuses, comments and deletion retain the correct identity and order',async t=>{
 const {call}=await fixture(t);const group=(await call('todoGroupCreate',{name:'  product  '})).id;
 const created=await call('todoCreate',{title:'first',description:'a\nb',dueDate:'2028-02-29',priority:'高',groupId:group});const id=created.id;
 const first=created.state.todos[0];
 for(const status of ['进行中','已完成','待处理','已完成','进行中','待处理']) assert.equal((await call('todoSetStatus',{id,status})).state.todos[0].status,status);
 await call('todoSetStatus',{id,status:'已完成'});
 const c1=(await call('todoCommentCreate',{todoId:id,content:'  line1\nline2  '})).id;const c2=(await call('todoCommentCreate',{todoId:id,content:'second'})).id;
 let result=await call('todoCommentUpdate',{todoId:id,id:c1,content:'changed'});assert.equal(result.state.todos[0].comments[0].edited,true);assert.equal(result.state.todos[0].comments[0].createdAt,first.createdAt);assert.equal(result.state.todos[0].comments[1].id,c2);assert.equal(result.state.todos[0].status,'已完成');
 result=await call('todoUpdate',{id,changes:{title:'new',description:'',dueDate:'',priority:'',groupId:'',status:'待处理',comments:[],createdAt:'spoof'}});
 assert.equal(result.state.todos[0].status,'已完成');assert.equal(result.state.todos[0].createdAt,first.createdAt);assert.equal(result.state.todos[0].comments.length,2);
 result=await call('todoCommentDelete',{todoId:id,id:c1});assert.equal(result.state.todos[0].comments[0].id,c2);
 assert.deepEqual((await call('todoDelete',{id})).state.todos,[]);
});
test('TODO group reorder, rename and delete keep items and comments and timestamps',async t=>{
 const {call,root}=await fixture(t);const a=(await call('todoGroupCreate',{name:'a'})).id,b=(await call('todoGroupCreate',{name:'b'})).id;
 const id=(await call('todoCreate',{title:'x',groupId:a})).id;await call('todoCommentCreate',{todoId:id,content:'keep'});
 const before=(await call('todoLoad')).state.todos[0];await call('todoGroupRename',{id:a,name:'renamed'});
 let result=await call('todoGroupReorder',{ids:[b,a]});assert.deepEqual(result.state.groups.map(g=>g.id),[b,a]);assert.deepEqual(result.state.todos[0],before);
 result=await call('todoGroupDelete',{id:a});assert.equal(result.state.todos[0].groupId,'');assert.equal(result.state.todos[0].comments[0].content,'keep');assert.equal(result.state.todos[0].title,'x');
 assert.deepEqual((await new Store(root).loadPersonalTodos()).groups.map(g=>g.id),[b]);
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
 await call('todoSetStatus',{id,status:'已完成'});await call('todoCommentUpdate',{todoId:id,id:comment,content:'edited'});await call('todoCommentDelete',{todoId:id,id:comment});
 await call('todoGroupDelete',{id:b});await call('todoDelete',{id});await call('todoGroupDelete',{id:a});
 assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),before);assert.deepEqual(await store.loadPersonalTodos(),{groups:[],todos:[]});
});
test('TODO a read I/O error remains separate from empty and succeeds after permission is restored',async t=>{
 const {call,file}=await fixture(t);await call('todoCreate',{title:'keep'});await chmod(file,0o000);
 try{await assert.rejects(call('todoLoad'),e=>e.code==='TODO_READ_FAILED');}finally{await chmod(file,0o600);}
 assert.equal((await call('todoLoad')).state.todos[0].title,'keep');
});
