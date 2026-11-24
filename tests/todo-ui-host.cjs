const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
// 本例的界面偏好也必须隔离，并跨两次进程保留。
require('node:fs').mkdirSync(path.join(process.argv[2],'profile'),{recursive:true});
app.setPath('userData',path.join(process.argv[2],'profile'));
app.whenReady().then(async()=>{
 const {Store}=await import('../app/store.js');
 const {WorkbenchService}=await import('../app/service.js');
 const directory=process.argv[2],phase=process.argv[3];
 const store=new Store(directory);
 const service=new WorkbenchService({store,createJira(){throw Error('TODO must not request JIRA');},agent:{extract(){throw Error('TODO must not request Agent');}}});
 ipcMain.handle('workbench:call',async(_,command,payload)=>{try{return {ok:true,value:await service.call(command,payload)};}catch(error){return {ok:false,error:error.message,code:error.code,field:error.field};}});
 const window=new BrowserWindow({show:false,width:1200,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
 const run=code=>window.webContents.executeJavaScript(code);
 const wait=async(code)=>{for(let n=0;n<120;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('UI timeout: '+code);};
 if(phase==='create'){
  await fs.writeFile(path.join(directory,'personal-todos.json'),JSON.stringify({groups:[
   {id:'g-a',name:'老分组A'},{id:'g-b',name:'老分组B'},
   {id:'g-new1',name:'次新分组',createdAt:'2026-11-18T00:00:00.000Z'},
   {id:'g-new2',name:'最新分组',createdAt:'2026-11-19T00:00:00.000Z'}
  ],todos:[]}));
 }
 await window.loadFile(path.resolve('app/ui/index.html'));
 await wait("Boolean(document.querySelector('[data-page=todo].active'))");
 if(phase==='create'){
  await wait("document.querySelectorAll('#groupNav .group-name').length===5");
  assert.deepEqual(await run("[...document.querySelectorAll('#groupNav .group-name')].map(n=>n.textContent)"),['全部','最新分组','次新分组','老分组A','老分组B'],'默认按创建时间倒序，老分组保持原顺序');
 }
 assert.equal(await run("document.querySelector('[data-page=todo]').classList.contains('active')"),true,'启动默认进入个人待办');
 await wait("Boolean(document.querySelector('#newTodo')) && !document.querySelector('#newTodo').disabled");
 if(phase==='create'){
  const dateStyles=selector=>run(`(()=>{
   const row=document.querySelector('${selector}');
   return [...row.querySelectorAll('button,svg')].map(node=>{
    const s=getComputedStyle(node);
    return [s.height,s.padding,s.border,s.borderRadius,s.backgroundColor,s.color,s.fontSize,s.fontWeight,s.lineHeight,s.alignItems,s.gap];
   });
  })()`);
  assert.deepEqual(await run("[...document.querySelectorAll('nav [data-page]')].map(n=>n.dataset.page)"),['todo','daily','batch','history','settings']);
  await run("document.querySelector('[data-page=daily]').click()");
  await wait("Boolean(document.querySelector('#taskNote'))");
  const dailyDate=await dateStyles('#dailyWorkDate');
  for(const [id,text] of [['taskNote','提交时自动创建同名子任务'],['subtaskNumberNote','留空自动匹配或创建']]){
   assert.equal(await run(`getComputedStyle(document.querySelector('#${id}')).visibility`),'hidden');
   await run(`document.querySelector('[aria-describedby=${id}]').focus()`);
   assert.deepEqual(await run(`(()=>{const tip=document.querySelector('#${id}');return [getComputedStyle(tip).visibility,tip.textContent];})()`),['visible',text]);
  }
  if(process.argv[4]){
   await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   await fs.writeFile(path.join(directory,'daily-help.png'),(await window.webContents.capturePage()).toPNG());
  }
  await run("document.querySelector('[data-page=todo]').click()");
  await wait("Boolean(document.querySelector('#newTodo')) && !document.querySelector('#newTodo').disabled");
  await run("document.querySelector('#newTodo').click()");
  await wait("Boolean(document.querySelector('#todoTitle'))");
  await run("document.querySelector('#todoTitle').value='真实保存与重开';document.querySelector('#todoTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#todoForm').requestSubmit()");
  await wait("document.querySelector('#todoEditor').hidden");
  assert.equal(await run("document.querySelector('#detailDrawer').hidden"),true,'创建成功不应自动打开详情');
  await run("document.querySelector('.todo-table tbody tr').click()");
  await wait("document.querySelector('#detailTitle')?.textContent==='真实保存与重开'");
  await run("document.querySelector('.comment-action').click();document.querySelector('#commentInput').value='真实评论';document.querySelector('#commentInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#commentForm').requestSubmit()");
  await wait("document.querySelector('.comment-text')?.textContent==='真实评论'");
  assert.equal(await run("document.querySelector('.subtask-empty')?.textContent"),'还没有子任务，点击右上角「添加」添加子任务。');
  // 子任务：新增、勾选、编辑、删除、完成提醒和列表进度。
  let expectedSubtasks=0;
  const addSubtask=async title=>{
   expectedSubtasks+=1;
   await run("document.querySelector('.subtask-add-trigger').click()");
   await wait("Boolean(document.querySelector('#subtaskDialog[open]'))");
   await run(`document.querySelector('#subtaskTitle').value=${JSON.stringify(title)};document.querySelector('#subtaskForm').requestSubmit()`);
   await wait(`document.querySelectorAll('.subtask-item').length===${expectedSubtasks}`);
  };
  await addSubtask('整理验收范围');await addSubtask('汇总遗留问题');await addSubtask('同步周会记录');
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 0/3');
  await run("document.querySelectorAll('.subtask-checkbox')[0].click()");
  await wait("document.querySelector('.subtask-count').textContent==='已完成 1/3'");
  assert.equal(await run("document.querySelector('.todo-table tbody tr .subtask-progress').textContent"),'已完成 1/3');
  await run("document.querySelectorAll('.subtask-actions button')[2].click()");
  await wait("Boolean(document.querySelector('.subtask-edit input'))");
  await run("document.querySelector('.subtask-edit input').value='汇总遗留问题（更新）';document.querySelector('.subtask-edit button').click()");
  await wait("document.querySelectorAll('.subtask-title')[1].textContent==='汇总遗留问题（更新）'");
  await run("document.querySelectorAll('.subtask-item')[2].querySelector('.subtask-actions button.danger').click()");
  await wait("Boolean(document.querySelector('#confirmDialog[open]'))");
  await run("document.querySelector('#confirmDelete').click()");
  await wait("document.querySelectorAll('.subtask-item').length===2");
  // 先独立记录一笔工时；此时父待办仍未完成。
  await run("document.querySelector('.worklog-add').click()");
  await wait("Boolean(document.querySelector('.worklog-dialog[open]'))");
  assert.equal(await run("document.querySelector('.worklog-dialog').getBoundingClientRect().width"),420);
  assert.deepEqual(await dateStyles('.worklog-dialog .date-row'),dailyDate,'日期按钮、快捷键和图标使用与工时填报一致的样式');
  assert.equal(await run(`(()=>{
   const button=document.querySelector('#worklogDay'),center=node=>node.getBoundingClientRect().top+node.getBoundingClientRect().height/2;
   return [...button.children].every(node=>Math.abs(center(node)-center(button))<1);
  })()`),true,'图标、日期和箭头垂直居中');
  await run("document.querySelector('#worklogDescription').value='整理筛选条件';document.querySelector('.worklog-dialog .worklog-chip').click();document.querySelector('.worklog-dialog [data-date]:last-child').click();document.querySelector('#worklogDay').click();document.querySelector('.date-head button').click()");
  await wait("Boolean(document.querySelector('.worklog-dialog .date-popover .calendar-grid'))");
  if(process.argv[4]){
   await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   await fs.writeFile(path.join(directory,'worklog-calendar.png'),(await window.webContents.capturePage()).toPNG());
  }
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  await wait("!document.querySelector('.date-popover') && Boolean(document.querySelector('.worklog-dialog[open]'))");
  if(process.argv[4])await fs.writeFile(path.join(directory,'worklog-dialog.png'),(await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('.worklog-dialog button[type=submit]').click()");
  await wait("document.querySelector('.worklog-description')?.textContent==='整理筛选条件'");
  assert.equal(await run("document.querySelector('#detailStatus').value"),'待处理','记录工时不应改变父状态');
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 1/2');
  assert.equal(await run("document.querySelectorAll('.worklog-item').length"),1);

  // 详情按钮：有未完成子任务，先确认；取消不改变父/子状态。
  await run("document.querySelector('.detail-action-bar button').click()");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  assert.equal(await run("Boolean(document.querySelector('.worklog-dialog[open]'))"),false,'完成不应再打开工时弹窗');
  assert.equal(await run("document.querySelectorAll('.completion-confirm .worklog-field').length"),0,'完成确认框不应含工时字段');
  assert.match(await run("document.querySelector('#completionConfirmTitle').textContent"),/还有 1 个未完成子任务/);
  assert.match(await run("document.querySelector('#completionConfirmBody').textContent"),/这 1 个子任务都会标记为“已完成”/);
  await run("document.querySelector('.completion-confirm .dialog-footer button').click()");
  await wait("!document.querySelector('.completion-confirm[open]')");
  assert.equal(await run("document.querySelector('#detailStatus').value"),'待处理');
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 1/2');
  assert.equal(await run("document.querySelectorAll('.worklog-item').length"),1);
  await run("document.querySelector('.detail-action-bar button').click()");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  await run("document.querySelector('.completion-confirm .primary').click()");
  await wait("document.querySelector('#detailStatus').value==='已完成'");
  assert.equal(await run("Boolean(document.querySelector('.worklog-dialog[open]'))"),false);
  assert.equal(await run("Boolean(document.querySelector('.completion-confirm[open]'))"),false);
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 2/2','确认完成应完成所有子任务');
  assert.equal(await run("document.querySelectorAll('.subtask-item').length"),2);
  assert.equal(await run("document.querySelector('.todo-table tbody tr .subtask-progress').textContent"),'已完成 2/2');
  assert.equal(await run("document.querySelectorAll('.worklog-item').length"),1,'完成不应自动新增工时');

  // 状态下拉：先重开并取消一条子任务，制造未完成；取消确认保留进行中。
  await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#detailStatus').value==='进行中'");
  await run("document.querySelectorAll('.subtask-checkbox')[0].click()");
  await wait("document.querySelector('.subtask-count').textContent==='已完成 1/2'");
  await run("document.querySelector('#detailStatus').value='已完成';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  await run("document.querySelector('.completion-confirm .dialog-footer button').click()");
  await wait("!document.querySelector('.completion-confirm[open]')");
  assert.equal(await run("document.querySelector('#detailStatus').value"),'进行中');
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 1/2');
  await run("document.querySelector('#detailStatus').value='已完成';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  await run("document.querySelector('.completion-confirm .primary').click()");
  await wait("document.querySelector('#detailStatus').value==='已完成'");
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 2/2');

  // 列表复选框：先重开并取消一条子任务，再通过列表完成；取消后勾选保持未完成。
  await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#detailStatus').value==='进行中'");
  await run("document.querySelectorAll('.subtask-checkbox')[0].click()");
  await wait("document.querySelector('.subtask-count').textContent==='已完成 1/2'");
  await run("document.querySelector('#closeDrawer').click()");
  await wait("document.querySelector('#detailDrawer').hidden===true");
  await wait("document.querySelector('tr[data-todo-id] .todo-checkbox').checked===false");
  await run("document.querySelector('tr[data-todo-id] .todo-checkbox').click()");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  await run("document.querySelector('.completion-confirm .dialog-footer button').click()");
  await wait("!document.querySelector('.completion-confirm[open]')");
  assert.equal(await run("document.querySelector('tr[data-todo-id] .todo-checkbox').checked"),false);
  await run("document.querySelector('tr[data-todo-id] .todo-checkbox').click()");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  await run("document.querySelector('.completion-confirm .primary').click()");
  await wait("document.querySelector('tr[data-todo-id] .todo-checkbox').checked===true");
  await run("document.querySelector('tr[data-todo-id]').click()");
  await wait("document.querySelector('#detailTitle')?.textContent==='真实保存与重开'");
  assert.equal(await run("document.querySelector('#detailStatus').value"),'已完成');
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 2/2');

  // 无未完成子任务：详情按钮直接完成，不再确认。
  await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#detailStatus').value==='进行中'");
  await run("document.querySelector('.detail-action-bar button').click()");
  await wait("document.querySelector('#detailStatus').value==='已完成'");
  assert.equal(await run("Boolean(document.querySelector('.completion-confirm[open]'))"),false);
  assert.equal(await run("Boolean(document.querySelector('.worklog-dialog[open]'))"),false);

  // 自定义状态下拉：有未完成子任务时确认框接管焦点；取消后状态不变。
  await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#detailStatus').value==='进行中'");
  await run("document.querySelectorAll('.subtask-checkbox')[0].click()");
  await wait("document.querySelector('.subtask-count').textContent==='已完成 1/2'");
  await run("document.querySelector('#detailStatusTrigger').click()");
  await wait("Boolean(document.querySelector('.query-menu'))");
  await run("[...document.querySelectorAll('.query-menu button')].find(button=>button.textContent.includes('已完成')).click()");
  await wait("Boolean(document.querySelector('.completion-confirm[open]'))");
  assert.equal(await run("document.activeElement.id"),'completionCancel','确认框应接管状态菜单的焦点');
  await run("document.querySelector('#completionCancel').click()");
  await wait("!document.querySelector('.completion-confirm[open]')");
  assert.equal(await run("document.querySelector('#detailStatus').value"),'进行中');
  await run("document.querySelectorAll('.subtask-checkbox')[0].click()");
  await wait("document.querySelector('.subtask-count').textContent==='已完成 2/2'");
  await run("document.querySelector('.detail-action-bar button').click()");
  await wait("document.querySelector('#detailStatus').value==='已完成'");

  // 无未完成子任务：列表复选框直接完成，不出现确认框。
  await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
  await wait("document.querySelector('#detailStatus').value==='进行中'");
  await run("document.querySelector('#closeDrawer').click()");
  await wait("document.querySelector('#detailDrawer').hidden===true");
  await run("document.querySelector('tr[data-todo-id] .todo-checkbox').click()");
  await wait("document.querySelector('tr[data-todo-id] .todo-checkbox').checked===true");
  assert.equal(await run("Boolean(document.querySelector('.completion-confirm[open]'))"),false);
  await run("document.querySelector('tr[data-todo-id]').click()");
  await wait("document.querySelector('#detailTitle')?.textContent==='真实保存与重开'");

  // 完成后编辑独立工时。
  await run("document.querySelector('.worklog-actions button').click()");
  assert.equal(await run("document.querySelector('#worklogDescription').value"),'整理筛选条件');
  await run("document.querySelector('#worklogDescription').value='补充验收说明';document.querySelector('.worklog-dialog button[type=submit]').click()");
  await wait("document.querySelector('.worklog-description')?.textContent==='补充验收说明'");
  await run("document.querySelectorAll('.detail-action-bar button')[1].click();document.querySelector('#todoDescription').value='失败后重试的说明'");
  const before=await fs.readFile(path.join(directory,'personal-todos.json'),'utf8');
  // Windows 的 chmod 不会阻止写入，只读失败场景仅在类 Unix 上可复现。
  if(process.platform!=='win32'){
   await fs.chmod(directory,0o500);
   try{
    await run("document.querySelector('#todoForm').requestSubmit()");
    await wait("!document.querySelector('#editorError').hidden");
    assert.equal(await fs.readFile(path.join(directory,'personal-todos.json'),'utf8'),before);
    assert.equal(await run("document.querySelector('#todoDescription').value"),'失败后重试的说明');
   }finally{await fs.chmod(directory,0o700);}
  }
  await run("document.querySelector('#todoForm').requestSubmit()");
  await wait("document.querySelector('#todoEditor').hidden");
  await wait("document.querySelector('.todo-table').textContent.includes('真实保存与重开')");
 const pendingRow=await run("[...document.querySelectorAll('.todo-table tbody tr')].find(tr=>tr.textContent.includes('真实保存与重开')).textContent");
 assert.match(pendingRow,/总工时 0\.25 h/,'列表应展示总工时');
 assert.doesNotMatch(pendingRow,/未登记|已登记/,'列表只显示总工时，登记状态留在详情');
 await run("document.querySelector('#closeDrawer').click();document.querySelector('#statusFilter').value='已完成';document.querySelector('#statusFilter').dispatchEvent(new Event('change'));document.querySelector('#sortRule').value='due-asc';document.querySelector('#sortRule').dispatchEvent(new Event('change'));document.querySelector('#filterTrigger').click();document.querySelector('#priorityFilter').value='unset';document.querySelector('#dateMode').value='undated';document.querySelector('#filterForm').requestSubmit();document.querySelector('#collapseGroups').click();document.querySelector('[data-page=daily]').click()");
  await wait("Boolean(document.querySelector('#issue'))");
  await run("document.querySelector('[data-page=todo]').click()");
  await wait("Boolean(document.querySelector('#newTodo')) && !document.querySelector('#newTodo').disabled");
 }else{
  await wait("document.querySelector('.todo-table').textContent.includes('真实保存与重开')");
 }
 assert.equal(await run("document.querySelector('#groupSidebar').hidden"),true,'分组栏收起状态应跨页面和重启恢复');
 assert.equal(await run("document.querySelector('#clearConditions')===null"),true,'设置查询后列表上方不应出现清除条件按钮');
 assert.deepEqual(await run("[document.querySelector('#statusFilter').value,document.querySelector('#sortRule').value]"),['已完成','due-asc']);
 await run("document.querySelector('#filterTrigger').click()");
 assert.deepEqual(await run("[document.querySelector('#priorityFilter').value,document.querySelector('#dateMode').value]"),['unset','undated']);
 await run("document.querySelector('[data-close=filterDialog]').click();document.querySelector('#calendarView').click()");
 assert.equal(await run("document.querySelector('#resultSummary').textContent"),'');
 assert.equal(await run("getComputedStyle(document.querySelector('.month-year')).fontSize===getComputedStyle(document.querySelector('.month-value')).fontSize"),true);
 assert.equal(await run("document.querySelector('.group-footnote')===null"),true);
 const state=JSON.parse(await fs.readFile(path.join(directory,'personal-todos.json'),'utf8'));
 assert.equal(state.todos.length,1);assert.equal(state.todos[0].title,'真实保存与重开');assert.equal(state.todos[0].status,'已完成');assert.equal(state.todos[0].comments[0].content,'真实评论');assert.equal(state.todos[0].description,'失败后重试的说明');
  assert.equal(state.todos[0].workLogs[0].hours,.25,'独立记录的工时应保存到待办');assert.equal(state.todos[0].workLogs[0].state,'recorded');assert.ok(state.todos[0].completedAt,'完成时间应单独保存');
  const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
  assert.equal(state.todos[0].workLogs[0].day,yesterday.toLocaleDateString('sv-SE'));
  assert.equal(state.todos[0].workLogs[0].description,'补充验收说明');
  assert.equal(state.todos[0].subtasks.length,2);
  assert.equal(state.todos[0].subtasks.filter(item=>item.done).length,2);
  assert.equal(state.todos[0].subtasks[1].title,'汇总遗留问题（更新）');
 if(phase==='reopen'){
  await run("document.querySelector('#listView').click()");
  await wait("Boolean(document.querySelector('.todo-table tbody tr'))");
  await run("document.querySelector('.todo-table tbody tr').click()");
  await wait("document.querySelector('#detailTitle')?.textContent==='真实保存与重开'");
  assert.equal(await run("document.querySelector('.subtask-count').textContent"),'已完成 2/2');
  assert.equal(await run("document.querySelectorAll('.subtask-item').length"),2);
  await run("document.querySelector('#closeDrawer').click()");
 }
 if(process.argv[4]){window.setContentSize(1200,750);await new Promise(r=>setTimeout(r,150));await fs.writeFile(process.argv[4],(await window.webContents.capturePage()).toPNG());}
 if(phase==='reopen'){
  await run("document.querySelector('#newTodo').click()");
  await wait("Boolean(document.querySelector('#createExtras'))");
  await run("document.querySelector('#createExtras [data-create-hours=\"2\"]').click()");
  assert.equal(await run("document.querySelector('#todoHours').value"),'2','点选常用工时应写入输入框');
  await run("document.querySelector('#todoTitle').value='新建即完成';document.querySelector('#todoTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#todoHours').value='1.5';document.querySelector('#todoHours').dispatchEvent(new Event('input'));document.querySelector('#todoDue').value='2026-11-10';document.querySelector('#todoStatus').value='已完成';document.querySelector('#todoForm').requestSubmit()");
  await wait("document.querySelector('#todoEditor').hidden");
  const after=JSON.parse(await fs.readFile(path.join(directory,'personal-todos.json'),'utf8'));
  const created=after.todos.find(todo=>todo.title==='新建即完成');
  assert.ok(created,'新建待办应保存');
  assert.equal(created.status,'已完成');
  assert.equal(created.workLogs[0].hours,1.5);
  assert.equal(created.workLogs[0].day,new Date().toLocaleDateString('sv-SE'),'创建工时使用当天，不借用截止日期');
  assert.equal(created.dueDate,'2026-11-10');
  assert.ok(created.completedAt,'直接完成应写完成时间');
 }
 console.log('TODO_UI_PASS '+phase);window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
