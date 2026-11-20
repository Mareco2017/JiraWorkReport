/* 批量页「已完成待办」按笔带入、子任务工单下拉的真实渲染与 IPC 回归；不访问远端。 */
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');

const day='2026-11-17';
const todos=[
 {id:'t1',title:'EXEPD-101 示例需求评审',description:'',dueDate:'',priority:'高',groupId:'',status:'已完成',completedAt:'2026-11-17T02:00:00.000Z',updatedAt:'2026-11-17T02:00:00.000Z',createdAt:'2026-11-10T01:00:00.000Z',comments:[],workLogs:[
  {id:'e1',day:'2026-11-16',hours:1.5,state:'recorded'},
  {id:'e2',day:'2026-11-17',hours:2,state:'recorded'}
 ]},
 {id:'t2',title:'jira工时填报-测试',description:'',dueDate:'',priority:'',groupId:'',status:'已完成',completedAt:'2026-11-17T03:00:00.000Z',updatedAt:'2026-11-17T03:00:00.000Z',createdAt:'2026-11-11T01:00:00.000Z',comments:[],workLogs:[
  {id:'e3',day:'2026-11-17',hours:1.5,state:'recorded'}
 ]},
 {id:'t3',title:'已登记的待办',description:'',dueDate:'',priority:'',groupId:'',status:'已完成',completedAt:'2026-11-17T04:00:00.000Z',updatedAt:'2026-11-17T04:00:00.000Z',createdAt:'2026-11-12T01:00:00.000Z',comments:[],workLogs:[
  {id:'e4',day:'2026-11-17',hours:1,state:'submitted',worklogId:'7001'}
 ]},
 {id:'t4',title:'进行中的需求梳理',description:'',dueDate:'',priority:'',groupId:'',status:'进行中',updatedAt:'2026-11-17T05:00:00.000Z',createdAt:'2026-11-13T01:00:00.000Z',comments:[],workLogs:[
  {id:'e5',day:'2026-11-16',hours:0.5,state:'recorded'}
 ]}
];
const entryOf=id=>todos.flatMap(todo=>(todo.workLogs||[]).map(entry=>({todo,entry}))).find(row=>row.entry.id===id);
const recordId=id=>createHash('sha256').update('todo-entry\n'+id).digest('hex').slice(0,24);

app.whenReady().then(async()=>{
 const state={drafts:[],history:[],batches:[],settings:{},bindings:{'2026-11':{month:'2026-11',id:'300',key:'MONTH-1',title:'2026年11月综合工时单'}}};
 const commands=[];
 ipcMain.handle('workbench:call',async(_,name,payload)=>{
  commands.push({name,payload});let value;
  if(name==='initialize')value={config:{notesDirectory:'/fictional/documents',commonTypes:[],jira:{url:'https://fixture.invalid',username:'tester',projectKey:'EXEPD',typeNames:['需求分析','项目管理','日常综合']}},state,today:day,runtimes:{}};
  else if(name==='listDocuments')value={files:[]};
  else if(name==='searchIssues')value={issues:[]};
  else if(name==='todoLoad')value={state:{groups:[],todos},today:day};
  else if(name==='importTodos'){
   const wanted=payload.entryIds||[];
   const rows=wanted.map(id=>entryOf(id));
   const records=rows.map(({todo,entry},index)=>({id:recordId(entry.id),todoId:todo.id,todoEntryId:entry.id,title:todo.title,day:entry.day,hours:entry.hours,type:'',task:'',issue:/^EXEPD-\d+/.test(todo.title)?'EXEPD-101':'',issueTitle:'',issueQuery:'',source:'批量填报',importSourceId:'todo:'+todo.id,sourceKind:'todo',sourceName:'已完成待办',sourceHash:'hash-todo',sourceFile:'',sourceLine:index+1,sourceStart:0,sourceEnd:todo.title.length,sourceText:todo.title,missing:['type']}));
   for(const row of records)if(!state.drafts.some(draft=>draft.id===row.id))state.drafts.push({...row});
   value={source:{id:'todo',kind:'todo',name:'已完成待办',contentHash:'hash-todo'},records,outcome:'loaded'};
  }else if(name==='syncTodoDrafts'){
   const alive=new Set(todos.flatMap(todo=>(todo.workLogs||[]).map(entry=>entry.id)));
   const removed=state.drafts.filter(draft=>draft.todoEntryId&&!alive.has(draft.todoEntryId)).map(draft=>draft.id);
   state.drafts=state.drafts.filter(draft=>!removed.includes(draft.id));
   value={removed};
  }
  else if(name==='saveDraft'){const index=state.drafts.findIndex(row=>row.id===payload.record.id);if(index>=0)state.drafts[index]=payload.record;value=state;}
  else if(name==='getIssue'){
   if(payload.key==='EXEPD-101')value={key:'EXEPD-101',title:'需求',typeId:'10001',project:'EXEPD',subtasks:[{key:'EXEPD-105',title:'需求调研及分析',statusCategory:'new'},{key:'EXEPD-106',title:'概要设计及评审',statusCategory:'done'}]};
   else if(payload.key==='EXEPD-103')value={key:'EXEPD-103',title:'候选工单',typeId:'10001',project:'EXEPD',subtasks:[]};
   else if(payload.key==='MONTH-1')value={key:'MONTH-1',title:'2026年11月综合工时单',typeId:'10002',project:'EXEPD',assignee:'tester',assigneeName:'tester',subtasks:[{key:'MONTH-2',title:'日常综合',statusCategory:'new'}]};
   else if(name==='searchMonthly')value=[];
   else value={key:payload.key,title:payload.key==='EXEPD-105'?'样例功能改造':payload.key==='EXEPD-106'?'样例说明补充':'需求',typeId:'10003',project:'EXEPD',parent:'EXEPD-101',subtasks:[]};
  }
  else if(name==='searchMonthly')value=[];
 else if(name==='getBatch')value={id:'batch-1',running:false,items:[]};
  else return {ok:false,error:'unexpected '+name};
  return {ok:true,value};
 });
 const window=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);}});
 await window.loadFile(path.resolve('app/ui/index.html'));
 const run=code=>window.webContents.executeJavaScript(code);
 const wait=async(code)=>{for(let n=0;n<120;n++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('UI wait failed: '+code);};
 await wait("Boolean(document.querySelector('[data-page=todo].active'))");
 await run("document.querySelector('[data-page=daily]').click()");
 await wait("Boolean(document.querySelector('[data-open-batch]'))");
 await run("document.querySelector('[data-page=batch]').click()");
 await wait("Boolean(document.querySelector('#todoTab'))");
 assert.equal(await run("document.querySelector('.source-tab').id"),'todoTab','待办工时在最左');
 assert.equal(await run("document.querySelector('#todoTab').getAttribute('aria-selected')"),'true','默认选中待办工时');
 await wait("Boolean(document.querySelector('.todo-row'))");
 assert.match(await run("document.querySelector('#todoTab').textContent"),/待办工时/,'来源页名称');

 // 来源页：按笔分组，已登记笔不显示；没有带入规则/开关/兜底
 assert.equal(await run("document.querySelectorAll('.todo-group').length"),3,'未完成待办也显示');
 assert.equal(await run("document.querySelectorAll('.todo-row').length"),4,'未登记笔共 4 行');
 assert.match(await run("[...document.querySelectorAll('.todo-group-status')].map(n=>n.textContent).join(',')"),/进行中/,'组头显示待办状态');
 assert.equal(await run("Boolean(document.querySelector('#todoHours'))||Boolean(document.querySelector('#todoShowSubmitted'))"),false,'没有兜底与显示已登记开关');
 assert.equal(await run("document.body.textContent.includes('带入规则')"),false);
 assert.match(await run("[...document.querySelectorAll('.todo-group-meta')].map(n=>n.textContent).join('|')"),/0\.5 h/,'组头显示未登记合计');

 await run("document.querySelector('#todoSelectAll').click()");
 assert.equal(await run("document.querySelectorAll('.todo-row[aria-pressed=true]').length"),4);
 const marks=await run(`['#todoSelectAll .todo-mark','.todo-group-head .todo-mark','.todo-row .todo-mark'].map(selector=>{
  const node=document.querySelector(selector),s=getComputedStyle(node);
  return [s.width,s.height,s.border,s.backgroundColor,s.color,getComputedStyle(node,'::before').content];
 })`);
 assert.deepEqual(marks[0],marks[1]);
 assert.deepEqual(marks[0],marks[2]);
 assert.equal(marks[0][3],'rgb(53, 170, 123)');
 if(process.argv[3]){
  await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await require('node:fs/promises').writeFile(process.argv[3],(await window.webContents.capturePage()).toPNG());
 }
 await run("document.querySelector('#todoSelectAll').click()");
 assert.deepEqual(await run("[document.querySelector('#todoSelectAll').getAttribute('aria-pressed'),document.querySelectorAll('.todo-row[aria-pressed=true]').length]"),['false',0]);

 // 按笔勾选
 await run("document.querySelector('[data-entry-id=e2]').click()");
 await wait("!document.querySelector('#read').disabled");
 assert.match(await run("document.querySelector('#todoSummary').textContent"),/已选 1 笔 · 合计 2 h/);
 await run("document.querySelector('#read').click()");
 await wait("!document.querySelector('#confirmPanel').hidden");
 assert.deepEqual(commands.filter(c=>c.name==='importTodos').at(-1).payload.entryIds,['e2']);
 assert.equal(commands.some(c=>c.name==='parseImport'),false);
 assert.equal(await run("document.querySelector('[data-field=hours]').value"),'2');
 assert.equal(await run("document.querySelector('[data-field=type]').value"),'','类型不由待办带出');
 assert.match(await run("document.querySelector('.edit-table thead').textContent"),/子任务工单/);
 assert.equal(await run("document.querySelectorAll('.edit-table thead th').length"),8);

 // 选中类型后按规则自动匹配同名子任务
 await run("var t=document.querySelector('[data-field=type]');t.value='需求分析';t.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-subtask]').value==='EXEPD-105'");
 assert.match(await run("document.querySelector('.subtask-hint').textContent"),/需求调研及分析/);
 assert.ok(state.drafts.some(d=>d.subtaskKey==='EXEPD-105'&&d.subtaskSource==='auto'),'自动匹配写入草稿');

 // 改名后不能继续使用旧的自动编号；唯一同名再自动匹配。
 await run("var n=document.querySelector('[data-field=task]');n.value='概要设计及评审';n.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-subtask]').value==='EXEPD-106'");
 await run("var n=document.querySelector('[data-field=task]');n.value='需求调研及分析';n.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-subtask]').value==='EXEPD-105'");

 // 右侧按钮打开下拉：默认隐藏已完成，勾选后出现；选择写回 manual
 await run("document.querySelector('[data-subtask-pick]').click()");
 await wait("Boolean(document.querySelector('.subtask-picker'))");
 assert.equal(await run("[...document.querySelectorAll('.subtask-options button')].some(b=>b.textContent.includes('概要设计及评审'))"),false,'默认不显示已完成');
 await run("var d=document.querySelector('.subtask-done-toggle input');d.checked=true;d.dispatchEvent(new Event('change'))");
 await wait("[...document.querySelectorAll('.subtask-options button')].some(b=>b.textContent.includes('概要设计及评审'))");
 await run("[...document.querySelectorAll('.subtask-options button')].find(b=>b.textContent.includes('EXEPD-106')).click()");
 await wait("document.querySelector('[data-subtask]').value==='EXEPD-106'");
 assert.equal(commands.filter(c=>c.name==='saveDraft').at(-1).payload.record.subtaskSource,'manual');

 // 综合工时单：类型切到日常综合后，子任务工单同样能下拉（走当月绑定）
 await run("var t=document.querySelector('[data-field=type]');t.value='日常综合';t.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-issue]').value.includes('综合工时单')");
 assert.equal(await run("document.querySelector('[data-subtask]').value"),'EXEPD-106','切换类型保留手选编号');
 await run("document.querySelector('[data-subtask-pick]').click()");
 await wait("Boolean(document.querySelector('.subtask-picker'))");
 await wait("[...document.querySelectorAll('.subtask-options button')].some(b=>b.textContent.includes('MONTH-2'))");
 await run("[...document.querySelectorAll('.subtask-options button')].find(b=>b.textContent.includes('MONTH-2')).click()");
 await wait("document.querySelector('[data-subtask]').value==='MONTH-2'");
 assert.equal(commands.filter(c=>c.name==='saveDraft').at(-1).payload.record.subtaskKey,'MONTH-2');

 // 完整工单号直接输入：搜索为空时按编号补一次解析，且选中后不误报未找到
 await run("var t=document.querySelector('[data-field=type]');t.value='需求分析';t.dispatchEvent(new Event('change'));");
 await wait("!document.querySelector('[data-issue]').readOnly");
 await run("var i=document.querySelector('[data-issue]');i.value='EXEPD-103';i.dispatchEvent(new Event('input'));");
 await wait("Boolean(document.querySelector('.issue-candidates .candidate'))");
 assert.equal(await run("document.body.textContent.includes('未找到可访问的工单')"),false,'完整编号不应误报');
 await run("document.querySelector('.issue-candidates .candidate').click()");
 await wait("document.querySelector('[data-issue]').value==='EXEPD-103'");
 assert.equal(await run("Boolean(document.querySelector('.issue-results'))"),false,'选中后候选应关闭');

 // 页面已打开后再新建带工时的待办，点刷新应立刻出现
 todos.push({id:'t5',title:'EXEPD-999999 新建完成',description:'',dueDate:'',priority:'',groupId:'',status:'已完成',completedAt:'2026-11-17T06:00:00.000Z',updatedAt:'2026-11-17T06:00:00.000Z',createdAt:'2026-11-17T06:00:00.000Z',comments:[],workLogs:[{id:'e6',day:'2026-11-17',hours:2,state:'recorded'}]});
 await run("document.querySelector('#todoRefresh').click()");
 await wait("document.querySelector('#todoRows').textContent.includes('EXEPD-999999')");

 // 返回来源页：已登记的待办隐藏，列表仍按笔
 await run("document.querySelector('#back').click()");
 const barBox=await run("(()=>{const bar=document.querySelector('#todoSource .directory-bar');const a=document.querySelector('#todoSelectAll').getBoundingClientRect();const b=document.querySelector('#todoRefresh').getBoundingClientRect();const r=bar.getBoundingClientRect();const pad=parseFloat(getComputedStyle(bar).paddingRight);return {gap:Math.round(b.left-a.right),right:Math.round(r.right-pad-b.right)}})()");
 assert.ok(barBox.gap<=12,'两个按钮之间保持 8px 栅格间距');
 assert.ok(Math.abs(barBox.right)<=1,'刷新按钮应贴右:'+JSON.stringify(barBox));
 assert.equal(await run("document.querySelectorAll('.todo-row').length"),5,'新建待办的工时刷新后应出现');
 // 待办被删除后刷新：其未登记带入草稿同步删除
 const index=todos.findIndex(todo=>todo.id==='t1');todos.splice(index,1);
 await run("document.querySelector('#todoRefresh').click()");
 for(let n=0;n<60&&state.drafts.some(draft=>draft.todoEntryId==='e2');n++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(state.drafts.some(draft=>draft.todoEntryId==='e2'),false,'已删除待办的工时草稿应被清理');
 assert.equal(commands.some(command=>command.name==='syncTodoDrafts'),true);
 assert.match(await run("document.querySelector('#toast').textContent"),/同步删除/);
 assert.deepEqual(errors,[]);
 console.log('TODO_IMPORT_UI_PASS');
 window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
 // 全选/刷新应贴在工具栏右侧
