/* 日填报「关联需求／综合工时单」控件的真实 renderer/preload 回归；只替换主进程动作，不访问 JIRA。
   覆盖：回车只查询/选中不提交、选中后红边与文案成对清除、切换类型不残留错误、子任务名称错误定位。 */
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');

const day='2026-11-17';
const issues=[
 {id:'1',key:'EXEPD-101',title:'报表筛选体验优化',project:'EXEPD',typeId:'10001',subtasks:[{key:'EXEPD-105',title:'需求调研及分析',statusCategory:'new'}]},
 {id:'2',key:'EXEPD-102',title:'报表导出异常',project:'EXEPD',typeId:'10001',subtasks:[]}
];
const state={drafts:[],history:[],batches:[],settings:{},bindings:{}};
const commands=[];

ipcMain.handle('workbench:call',async(_,name,payload)=>{
 commands.push({name,payload});let value;
 if(name==='initialize')value={config:{commonTypes:['需求分析','项目管理','日常综合'],jira:{url:'https://fixture.invalid',username:'tester',projectKey:'EXEPD',typeNames:['需求分析','项目管理','日常综合']}},state,today:day,runtimes:{}};
 else if(name==='todoLoad')value={state:{groups:[],todos:[]},today:day};
 else if(name==='searchIssues')value={issues:issues.filter(row=>(row.key+' '+row.title).includes(payload.query))};
 else if(name==='getIssue'){
  const row=issues.find(issue=>issue.key===payload.key);
  if(!row)return {ok:false,error:'工单不存在',code:'NOT_FOUND'};
  value=structuredClone(row);
 }else if(name==='saveDraft'){
  const index=state.drafts.findIndex(row=>row.id===payload.record.id);
  const record={...payload.record,id:payload.record.id||'draft-'+(state.drafts.length+1)};
  if(index>=0)state.drafts[index]=record;else state.drafts.push(record);
  value=state;
 }else if(name==='deleteDraft'){state.drafts=state.drafts.filter(row=>row.id!==payload.id);value=state;}
 else if(name==='getBatch')value={id:'none',running:false,items:[]};
 else return {ok:false,error:'unexpected '+name};
 return {ok:true,value};
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

let loaded=false;
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,width:1250,height:800,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const consoleErrors=[];
 window.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)consoleErrors.push(String(event.message));});
 const run=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){throw new Error('RUN FAILED: '+code+' :: '+error.message);}};
 const wait=async code=>{for(let attempt=0;attempt<200;attempt++){if(await run(code))return;await pause(25);}throw new Error('UI wait failed: '+code);};
 const saveCount=()=>commands.filter(command=>command.name==='saveDraft').length;
 const searchCount=()=>commands.filter(command=>command.name==='searchIssues').length;
 const selectType=async name=>{await run(`document.querySelector('[data-type="${name}"]').click()`);await pause(80);};
 const focusIssue=async text=>run(`(()=>{const input=document.querySelector('#issue');input.focus();input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const fillEntry=async(description,hours)=>run(`(()=>{document.querySelector('#description').value=${JSON.stringify(description)};document.querySelector('#hours').value=${JSON.stringify(hours)};})()`);
 const pressEnter=async()=>{
  window.webContents.focus();window.focus();
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await pause(180);
 };
 const keydown=async key=>run(`document.querySelector('#issue').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
 const issueState=()=>run(`(()=>{const input=document.querySelector('#issue'),error=document.querySelector('#issue-error');return {value:input.value,readOnly:input.readOnly,invalid:input.getAttribute('aria-invalid'),border:getComputedStyle(input).borderTopColor,errorHidden:error.hidden,errorText:error.textContent,entryError:document.querySelector('#entryError').textContent,candidates:document.querySelectorAll('.issue-results button').length,active:[...document.querySelectorAll('.issue-results button')].findIndex(button=>button.classList.contains('active')),expanded:input.getAttribute('aria-expanded'),picked:input.dataset.picked||''};})()`);
 // 不变量：任何红框都必须有可见文案，避免“像报错但说不出原因”。
 const looseErrors=()=>run(`[...document.querySelectorAll('[aria-invalid="true"]')].filter(input=>{const box=input.closest('.field')?.querySelector('.field-error');return !box||box.hidden||!box.textContent.trim();}).map(input=>input.id)`);
 const pageErrors=()=>run('window.__pageErrors');
 const freshDaily=async()=>{
  if(!loaded){loaded=true;await window.loadFile(path.resolve('app/ui/index.html'));}
  else{const done=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await done;}
  await wait("Boolean(document.querySelector('[data-page=todo].active'))");
  await run("document.querySelector('[data-page=daily]').click()");
  await wait("Boolean(document.querySelector('#issue'))");
  await run("window.__pageErrors=[];window.addEventListener('error',event=>window.__pageErrors.push(String(event.message)))");
 };

 // A. 输入关键词后（候选已展开）按真实回车：只选中当前高亮项，不提交、不出现红边。
 await freshDaily();await selectType('项目管理');
 await focusIssue('报表');
 await wait("document.querySelectorAll('.issue-results button').length===2");
 let current=await issueState();
 assert.equal(current.active,0,'候选默认高亮第一项');
 assert.equal(current.expanded,'true','展开候选时 aria-expanded 为 true');
 assert.equal(current.invalid,null,'查询阶段不得出现红边');
 const savesAtA=saveCount();
 await pressEnter();
 current=await issueState();
 assert.equal(current.value,'EXEPD-101 · 报表筛选体验优化','回车选中当前高亮候选');
 assert.equal(current.invalid,null,'选中后不得留下红边');
 assert.equal(current.errorHidden,true,'选中后不得出现工单提示');
 assert.equal(current.candidates,0,'选中后候选收起');
 assert.equal(current.expanded,'false','收起后 aria-expanded 为 false');
 assert.equal(saveCount(),savesAtA,'工单查询框里的回车不得加入清单');
 // 表单填完整后再回车：已选中的工单框仍然只吞掉默认行为，不得触发“加入清单”。
 await fillEntry('整理报表筛选规则','2');
 await run("document.querySelector('#issue').focus()");
 await pressEnter();
 assert.equal(saveCount(),savesAtA,'表单完整时回车也不得加入清单');
 assert.equal(await run("[...document.querySelectorAll('[aria-invalid=true]')].length"),0,'重复回车不得标红任何字段');

 // B. 输入事件后立刻（渲染前）派发回车：阻止默认行为并立即查询，不等 280ms 防抖。
 await freshDaily();await selectType('项目管理');
 const immediate=await run(`(()=>{const input=document.querySelector('#issue');input.focus();input.value='报表';input.dispatchEvent(new Event('input',{bubbles:true}));const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});input.dispatchEvent(event);return event.defaultPrevented;})()`);
 assert.equal(immediate,true,'工单查询框必须吞掉回车的默认提交行为');
 await wait("document.querySelectorAll('.issue-results button').length===2");
 assert.ok(searchCount()>=2,'回车应立即发起查询（不等防抖定时器）');
 current=await issueState();
 assert.equal(current.invalid,null,'立即查询不得出现红边');
 assert.equal(current.entryError,'','回车查询不得写底部错误提示');

 // C. 用户实际场景：输入关键词后马上按真实回车，不出现红边、不加入清单。
 await freshDaily();await selectType('项目管理');
 const savesAtC=saveCount();
 await focusIssue('报表');
 await pressEnter();
 current=await issueState();
 assert.equal(current.invalid,null,'回车查询不得把工单字段标红');
 assert.equal(current.errorHidden,true,'回车查询不得显示“请选择候选需求单”');
 assert.equal(current.entryError,'','回车查询不得写底部错误提示');
 assert.equal(saveCount(),savesAtC,'回车查询不得加入清单');
 assert.equal(await run("[...document.querySelectorAll('[aria-invalid=true]')].length"),0,'回车后无任何字段被标红');

 // D. 点「加入清单」才做完整校验：提示与红边成对出现；随后选中候选，两者一起消失，并可正常加入。
 await freshDaily();await selectType('项目管理');
 await focusIssue('报表');
 await wait("document.querySelectorAll('.issue-results button').length===2");
 await fillEntry('整理报表筛选规则','2');
 await run("document.querySelector('#entry').requestSubmit()");
 await pause(120);
 current=await issueState();
 assert.equal(current.invalid,'true','未选候选就加入清单应标红');
 assert.equal(current.errorHidden,false,'红边必须伴随提示文案');
 assert.match(current.errorText,/请选择候选需求单/);
 assert.equal(current.border,'rgb(197, 104, 89)','红边使用统一错误色');
 assert.equal(saveCount(),savesAtC,'未选候选不得保存草稿');
 await run("document.querySelector('.issue-results button').click()");
 await pause(200);
 current=await issueState();
 assert.equal(current.invalid,null,'选中候选后红边必须立刻消失');
 assert.equal(current.errorHidden,true,'选中候选后提示文案必须立刻消失');
 assert.equal(current.entryError,'','选中候选后底部错误提示必须清空');
 assert.deepEqual(await looseErrors(),[],'不允许出现无文案的红框');
 await run("document.querySelector('#entry').requestSubmit()");
 await pause(250);
 assert.equal(saveCount(),savesAtC+1,'选中候选后可正常加入清单');
 assert.equal(state.drafts.length,1,'草稿应写入一次');
 assert.deepEqual(await looseErrors(),[]);

 // E. 完整工单号 + 回车：唯一命中直接选中，不出现红边，也不等于加入清单。
 await freshDaily();await selectType('项目管理');
 const savesAtE=saveCount();
 await focusIssue('EXEPD-101');
 await pressEnter();
 await wait("document.querySelector('#issue').value.includes('EXEPD-101 · ')");
 current=await issueState();
 assert.equal(current.value,'EXEPD-101 · 报表筛选体验优化','完整工单号回车应直接选中');
 assert.equal(current.invalid,null);
 assert.equal(current.errorHidden,true);
 assert.equal(saveCount(),savesAtE,'回车选中工单不等于加入清单');

 // F. 方向键移动高亮后回车选中第二项。
 await freshDaily();await selectType('项目管理');
 await focusIssue('报表');
 await wait("document.querySelectorAll('.issue-results button').length===2");
 await keydown('ArrowDown');
 current=await issueState();
 assert.equal(current.active,1,'方向键把高亮移到第二项');
 await pressEnter();
 current=await issueState();
 assert.equal(current.value,'EXEPD-102 · 报表导出异常','回车选中高亮项而不是固定第一项');

 // G. 从需求类切回月度综合工时单：旧红边与旧文案不得残留。
 await freshDaily();await selectType('项目管理');
 await focusIssue('报表');
 await fillEntry('整理报表筛选规则','2');
 await run("document.querySelector('#entry').requestSubmit()");
 await pause(120);
 assert.equal((await issueState()).invalid,'true','先制造一次真实的工单校验错误');
 await selectType('日常综合');
 current=await issueState();
 assert.equal(current.readOnly,true,'日常综合使用只读月度工单号');
 assert.equal(current.invalid,null,'切换类型后不得残留工单红边');
 assert.equal(current.errorHidden,true,'切换类型后不得残留工单提示');
 assert.equal(current.entryError,'','切换类型后不得残留底部提示');

 // H. 子任务名称：输入不再抛异常；名称为空时提示落在本字段而不是工单字段。
 await freshDaily();await selectType('需求分析');
 await run(`(()=>{const input=document.querySelector('#taskName');input.focus();input.value='需求调研及分析x';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await pause(80);
 assert.deepEqual(await pageErrors(),[],'子任务名称输入不得抛异常');
 assert.deepEqual(consoleErrors.filter(message=>/setError is not defined/.test(message)),[],'不得再出现 setError 未定义');
 await fillEntry('整理报表筛选规则','2');
 await run("document.querySelector('#taskName').value='';document.querySelector('#entry').requestSubmit()");
 await pause(120);
 const taskError=await run(`(()=>{const box=document.querySelector('#task-error');return {hidden:box.hidden,text:box.textContent,invalid:document.querySelector('#taskName').getAttribute('aria-invalid'),focused:document.activeElement.id,entry:document.querySelector('#entryError').textContent};})()`);
 assert.equal(taskError.hidden,false,'空子任务名称应显示字段提示');
 assert.match(taskError.text,/请填写子任务名称/,'提示指向子任务名称本身');
 assert.equal(taskError.invalid,'true');
 assert.equal(taskError.focused,'taskName','焦点回到子任务名称');
 assert.match(taskError.entry,/请填写子任务名称/,'底部同时给出可读原因');
 assert.equal(await run("document.querySelector('#issue').getAttribute('aria-invalid')"),null,'不得把红框打到工单字段上');
 assert.equal(consoleErrors.filter(message=>/Cannot set properties of null/.test(message)).length,0,'不得出现裸 JS 错误');

 // I. 切换页面会关闭候选列表（与日期浮层同构），返回日填报后控件仍可用且不恢复旧候选。
 await freshDaily();await selectType('项目管理');
 await focusIssue('报表');
 await wait("document.querySelectorAll('.issue-results button').length===2");
 await run("document.querySelector('[data-page=todo]').click()");
 await wait("document.querySelector('[data-page=todo]').classList.contains('active')");
 assert.equal(await run("document.querySelectorAll('.issue-results').length"),0,'切换页面应关闭候选列表');
 await run("document.querySelector('[data-page=daily]').click()");
 await wait("Boolean(document.querySelector('#issue'))");
 current=await issueState();
 assert.equal(current.candidates,0,'返回日填报后不得恢复旧候选');
 assert.equal(current.expanded,'false','返回后 aria-expanded 应被重置');
 await focusIssue('EXEPD-101');
 await pressEnter();
 await wait("document.querySelector('#issue').value.includes('EXEPD-101 · ')");
 assert.equal((await issueState()).value,'EXEPD-101 · 报表筛选体验优化','返回后回车仍可选中工单');

 assert.deepEqual(await looseErrors(),[]);
 console.log('DAILY_ISSUE_UI_PASS');
 window.destroy();app.quit();
}).catch(error=>{console.error('DAILY_ISSUE_UI_FAIL',error);app.exit(1);});
