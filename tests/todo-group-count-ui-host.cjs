const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
app.setPath('userData',path.join(process.argv[2],'profile'));
app.whenReady().then(async()=>{
 const directory=process.argv[2];
 await fs.mkdir(directory,{recursive:true});
 const t=s=>new Date(s).toISOString();
 const state={groups:[{id:'g1',name:'产品',createdAt:t('2026-11-02T00:00:00Z')},{id:'g2',name:'项目',createdAt:t('2026-11-01T00:00:00Z')}],todos:[
  {id:'t1',title:'Alpha 需求',description:'',dueDate:'2026-11-12',priority:'高',groupId:'g1',status:'待处理',createdAt:t('2026-11-03T00:00:00Z'),updatedAt:t('2026-11-03T00:00:00Z'),comments:[]},
  {id:'t2',title:'Beta 联调',description:'',dueDate:'2026-11-13',priority:'中',groupId:'g1',status:'进行中',createdAt:t('2026-11-04T00:00:00Z'),updatedAt:t('2026-11-04T00:00:00Z'),comments:[]},
  {id:'t3',title:'Alpha 文案',description:'',dueDate:'2026-11-12',priority:'低',groupId:'g2',status:'已完成',createdAt:t('2026-11-05T00:00:00Z'),updatedAt:t('2026-11-05T00:00:00Z'),comments:[]},
  {id:'t4',title:'未分组事项',description:'',dueDate:'',priority:'',groupId:'',status:'待处理',createdAt:t('2026-11-06T00:00:00Z'),updatedAt:t('2026-11-06T00:00:00Z'),comments:[]},
  {id:'t5',title:'Gamma 发布',description:'',dueDate:'2026-11-14',priority:'高',groupId:'g2',status:'待处理',createdAt:t('2026-11-07T00:00:00Z'),updatedAt:t('2026-11-07T00:00:00Z'),comments:[]}
 ]};
 await fs.writeFile(path.join(directory,'personal-todos.json'),JSON.stringify(state));
 const {Store}=await import('../app/store.js');
 const {WorkbenchService}=await import('../app/service.js');
 const store=new Store(directory);
 const service=new WorkbenchService({store,createJira(){throw Error('no');},agent:{extract(){throw Error('no');}}});
 ipcMain.handle('workbench:call',async(_,command,payload)=>{try{return {ok:true,value:await service.call(command,payload)};}catch(error){return {ok:false,error:error.message,code:error.code,field:error.field};}});
 const window=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 await window.loadFile(path.resolve('app/ui/index.html'));
 const run=code=>window.webContents.executeJavaScript(code);
 const wait=async(code)=>{for(let n=0;n<200;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('timeout '+code);};
 const groupNumbers=()=>run("[...document.querySelectorAll('#groupNav .group-item')].map(row=>[row.querySelector('.group-name').textContent,row.querySelector('.group-number').textContent])");
 const total=()=>run("document.querySelector('#groupTotal').textContent");
 const summary=()=>run("document.querySelector('#resultSummary').textContent");
 const expectCounts=async(want,label)=>{
  assert.deepEqual(await groupNumbers(),want,label+' 分组数字');
  const totalNumber=await total();
  assert.equal(totalNumber, want.find(row=>row[0]==='全部')[1]+' 项',label+' 当前分组总数');
  assert.match(await summary(),new RegExp('共 '+want.find(row=>row[0]==='全部')[1]+' 项待办'),label+' 结果栏');
 };
 await wait("document.querySelectorAll('#groupNav .group-item').length===3 && document.querySelector('.todo-table tbody tr')");
 await expectCounts([['全部','5'],['产品','2'],['项目','2']],'无筛选');
 await run("document.querySelector('#statusFilter').value='待处理';document.querySelector('#statusFilter').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 3 项待办')");
 await expectCounts([['全部','3'],['产品','1'],['项目','1']],'状态待处理');
 await run("document.querySelector('#statusFilter').value='已完成';document.querySelector('#statusFilter').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 1 项待办')");
 await expectCounts([['全部','1'],['产品','0'],['项目','1']],'状态已完成');
 // 清空状态，再验证优先级、日期、关键词和组合条件。
 await run("document.querySelector('#statusFilter').value='';document.querySelector('#statusFilter').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 5 项待办')");
 await run("document.querySelector('#filterTrigger').click()");
 await wait("!document.querySelector('#filterDialog').hidden");
 await run("document.querySelector('#priorityFilter').value='高';document.querySelector('#filterForm').requestSubmit()");
 await wait("document.querySelector('#resultSummary').textContent.includes('优先级：高')");
 await expectCounts([['全部','2'],['产品','1'],['项目','1']],'优先级高');
 await run("document.querySelector('#filterTrigger').click();document.querySelector('#priorityFilter').value='';document.querySelector('#dateMode').value='range';document.querySelector('#dateFrom').value='2026-11-12';document.querySelector('#dateTo').value='2026-11-13';document.querySelector('#filterForm').requestSubmit()");
 await wait("document.querySelector('#resultSummary').textContent.includes('2026-11-12')");
 await expectCounts([['全部','3'],['产品','2'],['项目','1']],'日期范围');
 await run("document.querySelector('#filterTrigger').click();document.querySelector('#dateMode').value='any';document.querySelector('#dateFrom').value='';document.querySelector('#dateTo').value='';document.querySelector('#keyword').value='alpha';document.querySelector('#keyword').dispatchEvent(new Event('input'));document.querySelector('#filterForm').requestSubmit()");
 await wait("document.querySelector('#resultSummary').textContent.includes('alpha')");
 await expectCounts([['全部','2'],['产品','1'],['项目','1']],'关键词 alpha');
 // 切换分组：数字保持筛选结果，当前分组总数切到项目。
 await run("document.querySelectorAll('#groupNav .group-button')[2].click()");
 await wait("document.querySelector('#currentGroupTitle').textContent==='项目'");
 assert.equal(await total(),'1 项');
 assert.match(await summary(),/共 1 项待办/,'选中分组总数与结果栏一致');
 // 视图切换和换月不改变左侧数字。
 await run("document.querySelector('#calendarView').click()");
 await wait("Boolean(document.querySelector('.todo-calendar-view'))");
 assert.deepEqual(await groupNumbers(),[['全部','2'],['产品','1'],['项目','1']]);
 await run("document.querySelector('.month-arrow:last-child').click()");
 await new Promise(r=>setTimeout(r,60));
 // 强制一次全量 render，确保断言的是“月份不影响计数”，而不是换月未重绘。
 await run("document.querySelector('#listView').click();document.querySelector('#calendarView').click()");
 await wait("Boolean(document.querySelector('.todo-calendar-view'))");
 assert.deepEqual(await groupNumbers(),[['全部','2'],['产品','1'],['项目','1']]);
 await run("document.querySelector('#listView').click()");
 await wait("Boolean(document.querySelector('.todo-table'))");
 // 清空关键词，恢复全部。
 await run("document.querySelector('#searchTrigger').click();document.querySelector('#keyword').value='';document.querySelector('#keyword').dispatchEvent(new Event('input'));document.querySelector('#groupNav .group-button').click()");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 5 项待办')");
 await expectCounts([['全部','5'],['产品','2'],['项目','2']],'清除关键词');
 // 数据变化后数字刷新：状态筛选下把产品组的一条待办改为进行中，再恢复。
 await run("document.querySelector('#statusFilter').value='待处理';document.querySelector('#statusFilter').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 3 项待办')");
 await run("document.querySelector('tr[data-todo-id=\"t1\"]').click()");
 await wait("document.querySelector('#detailTitle')?.textContent==='Alpha 需求'");
 await run("document.querySelector('#detailStatus').value='进行中';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 2 项待办')");
 await expectCounts([['全部','2'],['产品','0'],['项目','1']],'改状态后');
 await run("document.querySelector('#detailStatus').value='待处理';document.querySelector('#detailStatus').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 3 项待办')");
 await expectCounts([['全部','3'],['产品','1'],['项目','1']],'恢复状态后');
 await run("document.querySelector('#closeDrawer').click()");
 await run("document.querySelector('#statusFilter').value='';document.querySelector('#statusFilter').dispatchEvent(new Event('change'))");
 await wait("document.querySelector('#resultSummary').textContent.includes('共 5 项待办')");
 // 组内新建：当前分组默认归入产品，数字 +1。
 await run("document.querySelectorAll('#groupNav .group-button')[1].click()");
 await wait("document.querySelector('#currentGroupTitle').textContent==='产品'");
 await run("document.querySelector('#newTodo').click()");
 await wait("Boolean(document.querySelector('#todoTitle'))");
 await run("document.querySelector('#todoTitle').value='新建筛选计数';document.querySelector('#todoForm').requestSubmit()");
 await wait("document.querySelector('.todo-table').textContent.includes('新建筛选计数')");
 assert.deepEqual(await groupNumbers(),[['全部','6'],['产品','3'],['项目','2']]);
 assert.equal(await total(),'3 项');
 assert.match(await summary(),/共 3 项待办/);
 // 删除当前分组：回到全部，数字按剩余分组重算。
 await run("document.querySelector('#manageGroups').click()");
 await wait("Boolean(document.querySelector('#groupManager[open]'))");
 await run("document.querySelector('.managed-group-row[data-group-id=\"g1\"] .managed-link.danger').click()");
 await wait("Boolean(document.querySelector('#confirmDialog[open]'))");
 await run("document.querySelector('#confirmDelete').click()");
 await wait("document.querySelectorAll('#groupNav .group-item').length===2");
 assert.equal(await run("document.querySelector('#currentGroupTitle').textContent"),'全部');
 await expectCounts([['全部','6'],['项目','2']],'删除当前分组后');
 // 1024 紧凑尺寸仍显示数字且无横向溢出。
 window.setContentSize(1024,720);
 await new Promise(r=>setTimeout(r,150));
 assert.deepEqual(await groupNumbers(),[['全部','6'],['项目','2']]);
 assert.equal(await run("document.documentElement.scrollWidth<=innerWidth+1"),true);
 console.log('GROUP_COUNT_UI_PASS');
 window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
