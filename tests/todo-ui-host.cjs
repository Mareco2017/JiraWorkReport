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
 const window=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message);});
 const run=code=>window.webContents.executeJavaScript(code);
 const wait=async(code)=>{for(let n=0;n<120;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('UI timeout: '+code);};
 await window.loadFile(path.resolve('app/ui/index.html'));
 await wait("Boolean(document.querySelector('[data-page=todo].active'))");
 assert.equal(await run("document.querySelector('[data-page=todo]').classList.contains('active')"),true,'启动默认进入个人待办');
 await wait("Boolean(document.querySelector('#newTodo')) && !document.querySelector('#newTodo').disabled");
 if(phase==='create'){
  await run("document.querySelector('#newTodo').click()");
  await wait("Boolean(document.querySelector('#todoTitle'))");
  await run("document.querySelector('#todoTitle').value='真实保存与重开';document.querySelector('#todoTitle').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#todoForm').requestSubmit()");
  await wait("document.querySelector('#todoEditor').hidden");
  assert.equal(await run("document.querySelector('#detailDrawer').hidden"),true,'创建成功不应自动打开详情');
  await run("document.querySelector('.todo-table tbody tr').click()");
  await wait("document.querySelector('#detailTitle')?.textContent==='真实保存与重开'");
  await run("document.querySelector('.comment-action').click();document.querySelector('#commentInput').value='真实评论';document.querySelector('#commentInput').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#commentForm').requestSubmit()");
  await wait("document.querySelector('.comment-text')?.textContent==='真实评论'");
  await run("document.querySelector('.detail-action-bar button').click()");
  await wait("document.querySelector('#detailStatus').value==='已完成'");
  await run("document.querySelectorAll('.detail-action-bar button')[1].click();document.querySelector('#todoDescription').value='失败后重试的说明'");
  const before=await fs.readFile(path.join(directory,'personal-todos.json'),'utf8');
  await fs.chmod(directory,0o500);
  try{
   await run("document.querySelector('#todoForm').requestSubmit()");
   await wait("!document.querySelector('#editorError').hidden");
   assert.equal(await fs.readFile(path.join(directory,'personal-todos.json'),'utf8'),before);
   assert.equal(await run("document.querySelector('#todoDescription').value"),'失败后重试的说明');
  }finally{await fs.chmod(directory,0o700);}
  await run("document.querySelector('#todoForm').requestSubmit()");
  await wait("document.querySelector('#todoEditor').hidden");
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
 if(process.argv[4]){window.setContentSize(1250,750);await new Promise(r=>setTimeout(r,150));await fs.writeFile(process.argv[4],(await window.webContents.capturePage()).toPNG());}
 console.log('TODO_UI_PASS '+phase);window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
