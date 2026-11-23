import {mountTodo} from './todo/view.js';
import {templates} from './templates.js';
import {typeMapping,monthlyTasks,requirementTasks,taskForType,isMonthlyType,validateRecord,isCompletedItem,HOUR_CHOICES,HOURS_ERROR,hoursValid} from '../worklogs.js';
import {bindIssueSearch,closeIssueSearch,refreshIssueClear} from './issue-input.js';
import {openRecordEditor} from './record-editor.js';
import {bindWorkDate,closeCalendar,labelDay,workDateMarkup} from './work-date.js';

const $ = selector=>document.querySelector(selector);
const main=$('#content');
const defaultCommonTypes=['需求分析','需求分析评审','概要设计','规格撰写','4.0应用开发','日常综合'];
let snapshot, page='todo', types=Object.keys(typeMapping), selectedType='需求分析', issueSelection=null, selectedSubtask=null, selectedTask='', taskEdited=false, selectedFile=null, noteRecords=[], step=1, activeBatch=null;
const escapeText=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const issueCache=new Map();
async function cachedIssue(key) {
 if(issueCache.has(key))return issueCache.get(key);
 const issue=await call('getIssue',{key});
 issueCache.set(key,issue);
 return issue;
}
const monthlySubtaskCache=new Map();
const hoursButtonsHtml=()=>HOUR_CHOICES.map(value=>'<button type="button" class="chip" data-hours="'+value+'">'+value+'</button>').join('')+'<input id="hours" aria-label="自定义耗时" type="number" min="0.25" step="0.25" required>';
const completedDay=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('sv-SE');};
let toastTimer;
const pageViews = new Map();
let disposeTodo;
let paintDailyDate;
const submissionBatches = new Map();
const releasedBatches = new Set();
let drawerDesiredOpen = false;
let repairJiraConnection = false;
let importKind='todo', importSource=null, filePreview=null, pasteResult=null, importBusy=false, previewFailed=false;
// 待办工时是第三个来源；选择、默认值和上次结果只在批量页生命周期内保留。
let todoResult=null, todoList=[], todoSelection=new Set(), todoLoaded=false, returnedFailedIds=new Set();
const importEdits=new Map();
// 无效标题不能写入正式草稿，页面内按已确认来源和正文指纹保留，重读时优先于旧有效稿。
function rememberImportEdits(){
 if(importSource&&noteRecords.length)importEdits.set(importSource.id+'\n'+importSource.contentHash,structuredClone(noteRecords));
}
function restoreImportEdits(source,records){
 const edits=new Map((importEdits.get(source.id+'\n'+source.contentHash)||[]).map(row=>[row.id,row]));
 // 待办草稿已在主进程按最新来源同步，不能再被页面里的旧副本覆盖。
 return records.map(row=>row.todoEntryId?row:edits.get(row.id)||row);
}
const importName=()=>importKind==='todo'?'待办工时':importKind==='paste'?'手动粘贴内容':selectedFile?.name||'';

function sourceKey(flow=page,fileId=selectedFile?.id) {
 return flow==='batch' ? 'batch/'+(importSource?.id||fileId||'') : 'daily';
}
function batchSource(batch) {
 const item=batch.items?.[0];
 const fromBatch=item?.source==='批量填报'||String(item?.importSourceId||'').startsWith('todo:')||Boolean(item?.sourceFile);
 return fromBatch ? 'batch/'+(item.importSourceId||item.sourceFile||'') : 'daily';
}
function rememberBatch(batch) {
 if(!batch || batch.returnedToDrafts || releasedBatches.has(batch.id))return;
 // 主进程以确切记录编号关联的旧批次也可能挂在新来源键下，更新这些已知关联。
 for(const [key,known] of submissionBatches)if(known.id===batch.id)submissionBatches.set(key,batch);
 submissionBatches.set(batchSource(batch),batch);
}
function currentBatch() {
 const batch=submissionBatches.get(sourceKey());
 // 已返回填报或已释放的批次不能继续代表“本次提交”，否则按钮会退回“查看本次提交”。
 if(!batch || batch.returnedToDrafts || releasedBatches.has(batch.id))return undefined;
 return batch;
}
function setSubmissionButton(records) {
 const button=$('#submit');
 if(!button)return;
 const batch=currentBatch();
 const pending=batch && (batch.running || batch.items.some(item=>!isCompletedItem(item)));
 const submittedIds=new Set(batch?.items.filter(item=>item.status!=='deleted').map(item=>item.id) || []);
 const newRecords=records.some(row=>!submittedIds.has(row.id));
 const reopen=batch && (pending || !newRecords);
 button.textContent=reopen?'查看本次提交':'确认提交';
 button.disabled=!reopen && !records.length;
}

// 错误由业务接口返回可读原因，渲染层只负责就近显示和继续操作。
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
async function call(name,payload={}){
 const response=await window.workbench.call(name,payload);
 if(!response.ok)throw Object.assign(new Error(response.error),{code:response.code,field:response.field});
 return response.value;
}
// 字段级错误只允许成对出现：有红框就有文案，有文案就能定位到对应控件。
// 控件 id 与提示 id 并非同构（子任务名称的提示是 task-error），所以显式映射而不是拼字符串。
const errorTargets={
 date:['#date','#date-error'],description:['#description','#description-error'],hours:['#hours','#hours-error'],
 issue:['#issue','#issue-error'],task:['#taskName','#task-error']
};
// 子任务号类错误没有独立提示位：只放在表单底部提示条并聚焦对应控件，不能把红框打到工单字段上。
function fieldParts(field){return (errorTargets[field]||errorTargets.issue).map(selector=>$(selector));}
function showFieldError(field,message){
 const [input,box]=fieldParts(field);
 if(box){box.textContent=message;box.hidden=false;}
 input?.setAttribute('aria-invalid','true');
 const entry=$('#entryError');if(entry)entry.textContent=message;
}
function clearFieldError(field){
 const [input,box]=fieldParts(field);
 if(box){box.textContent='';box.hidden=true;}
 input?.removeAttribute('aria-invalid');
 const entry=$('#entryError');if(entry)entry.textContent='';
}
function clearEntryErrors(){for(const field of Object.keys(errorTargets))clearFieldError(field);}
// 工单输入框的查询与详情由页面注入；日填报和批量两处调用点共用同一实现，控件本身不持有 IPC。
const searchIssueRows=async query=>{const response=await call('searchIssues',{query});return response.issues || response;};
const loadIssueDetail=key=>call('getIssue',{key});
const reportIssueError=error=>toast(error.message);
// 连接行与状态点常驻；刷新业务快照时仅更新真正改变的文字和状态。
function updateConnection(row,label,configured){
 if(row.lastChild.nodeValue!==label)row.lastChild.nodeValue=label;
 const className='status-value '+(configured?'status-good':'status-idle');
 if(row.className!==className)row.className=className;
}
async function refresh(){
 snapshot=await call('initialize');
 const liveTypes=snapshot.config.jira?.typeNames;
 types=Array.isArray(liveTypes)?Object.keys(typeMapping).filter(name=>liveTypes.includes(name)):Object.keys(typeMapping);
 for(const batch of snapshot.state.batches || [])rememberBatch(batch);
 const rows=document.querySelectorAll('.status-value');
 updateConnection(rows[0],snapshot.config.jira?snapshot.config.jira.username:'未配置',Boolean(snapshot.config.jira));
 updateConnection(rows[1],snapshot.config.agent?snapshot.config.agent.engine:'未配置',Boolean(snapshot.config.agent));
 const dailyNav=$('[data-page=daily]');
 let draftBadge=dailyNav.querySelector('.badge');
 if(!draftBadge){draftBadge=document.createElement('span');draftBadge.className='badge';dailyNav.append(draftBadge);}
 const dailyCount=snapshot.state.drafts.filter(row=>row.source!=='批量填报').length;
 if(draftBadge.hidden!==!dailyCount)draftBadge.hidden=!dailyCount;
 if(draftBadge.textContent!==String(dailyCount))draftBadge.textContent=dailyCount;
 const todayRows=(snapshot.state.drafts || []).filter(row=>row.day===snapshot.today);
 const todayText=todayRows.length+' 条 · '+todayRows.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h';
 if(rows[2].textContent!==todayText)rows[2].textContent=todayText;
}
const safe = action=>async event=>{try{await action(event);}catch(error){toast(error.message);}};
document.querySelectorAll('[data-page]').forEach(button=>button.onclick=safe(()=>navigate(button.dataset.page)));
async function navigate(next){
 if(next===page&&main.children.length)return;
 disposeTodo?.();disposeTodo=null;
 main.classList.remove('todo-host');
 closeBatchPopup();
 if(['daily','batch'].includes(page) && main.children.length){
  const view=document.createDocumentFragment();
  while(main.firstChild)view.append(main.firstChild);
  pageViews.set(page,view);
 }
 closeCalendar();closeIssueSearch();document.querySelector('.hours-popover')?.remove();
 page=next;
 // 待办不依赖initialize；原工时快照和缓存继续归原页面管理。
 if(page==='todo'){
  document.querySelectorAll('[data-page]').forEach(button=>button.classList.toggle('active',button.dataset.page===page));
  $('#pageStyle').disabled=true;$('#historyStyle').disabled=true;
  main.classList.add('todo-host');
  disposeTodo=mountTodo(main,{call,onCount:(count,{loading=false}={})=>{
   if(loading)return;
   const badge=$('#todoNavCount'),text=count===null?'—':String(count);
   if(badge.hidden)badge.hidden=false;
   if(badge.textContent!==text)badge.textContent=text;
  },getTypes:()=>types,getProject:()=>snapshot?.config?.jira?.projectKey||''});
  return;
 }
 await refresh();
 document.querySelectorAll('[data-page]').forEach(button=>button.classList.toggle('active',button.dataset.page===page));
 $('#pageStyle').disabled=page!=='batch'&&page!=='history';$('#historyStyle').disabled=page!=='history';
 const cached=pageViews.get(page);
 if(cached){
  main.replaceChildren(cached);pageViews.delete(page);
  if(page==='daily'){
   const query=$('#issue').value;renderDailyTypes();renderTask();
   if(!monthlyTasks.includes(typeMapping[selectedType])&&!issueSelection)$('#issue').value=query;
   renderQueue();
  }else showStep(step);
  return;
 }
 main.innerHTML=templates[page];
 if(page==='daily')daily();
 if(page==='batch')await batch();
 if(page==='history')history();
 if(page==='settings')await settings();
}

function hourOptions(input,onValue){
 document.querySelector('.hours-popover')?.remove();
 const popup=document.createElement('div');popup.className='hours-popover';
 for(const value of HOUR_CHOICES){
  const button=document.createElement('button');button.textContent=value;button.onmousedown=event=>{event.preventDefault();onValue(value);popup.remove();};popup.append(button);
 }
 (input.closest('dialog')||document.body).append(popup);const rect=input.getBoundingClientRect();popup.style.left=Math.min(rect.left,innerWidth-280)+'px';popup.style.top=(rect.bottom+5)+'px';input.onblur=()=>setTimeout(()=>popup.remove(),100);
}
function renderDailyTypes(){
 const common=snapshot.config.commonTypes || defaultCommonTypes;
 const visible=common.filter(name=>types.includes(name)),remaining=types.filter(name=>!visible.includes(name));
 $('#types').innerHTML=visible.map(name=>'<button class="chip '+(name===selectedType?'selected':'')+'" type="button" data-type="'+escapeText(name)+'">'+escapeText(name)+'</button>').join('')+(remaining.length?'<button type="button" class="chip" id="moreTypes">更多 '+remaining.length+'</button>':'');
 document.querySelectorAll('[data-type]').forEach(button=>button.onclick=()=>{selectedType=button.dataset.type;renderDailyTypes();renderTask();});
 if($('#moreTypes'))$('#moreTypes').onclick=()=>typeDialog(false);
 if(types.includes(selectedType)&&!visible.includes(selectedType)){const current=document.createElement('span');current.className='type-value';current.textContent='当前：'+selectedType;$('#types').append(current);}
 if(!types.includes(selectedType)){const warning=document.createElement('span');warning.className='inline-error';warning.textContent='当前工时类型已失效，请重新选择';$('#types').append(warning);}
}
function typeDialog(configure){
 const dialog=document.createElement('dialog');dialog.className='type-dialog';
 const common=snapshot.config.commonTypes||defaultCommonTypes,options=configure?types:types.filter(name=>!common.includes(name));
 dialog.setAttribute('aria-labelledby','typeDialogTitle');
 dialog.innerHTML='<div class="dialog-heading"><h2 id="typeDialogTitle">'+(configure?'设置常用工时类型':'更多工时类型')+'</h2><button type="button" class="close-dialog" data-close aria-label="关闭类型面板">×</button></div><p>'+(configure?'勾选的类型会直接展示在填报表单，其余类型保留在“更多”中。':'选择后自动匹配子任务；常用类型可以通过“自定义”放到表单上。')+'</p><div class="type-options">'+options.map(name=>configure?'<label><input type="checkbox" value="'+escapeText(name)+'" '+(common.includes(name)?'checked':'')+'>'+escapeText(name)+'</label>':'<button type="button" class="'+(name===selectedType?'selected':'')+'" data-value="'+escapeText(name)+'">'+escapeText(name)+'</button>').join('')+'</div><div class="dialog-footer">'+(configure?'<span data-count></span><button type="button" class="primary" data-save>保存常用项</button>':'')+'</div>';
 document.body.append(dialog);dialog.showModal();
 dialog.querySelector('[data-close]').onclick=()=>dialog.remove();
 dialog.oncancel=()=>dialog.remove();
 dialog.querySelectorAll('[data-value]').forEach(button=>button.onclick=()=>{selectedType=button.dataset.value;dialog.remove();renderDailyTypes();renderTask();});
 if(configure){
  const updateCount=()=>{dialog.querySelector('[data-count]').textContent='已选 '+dialog.querySelectorAll('input:checked').length+' 项';};
  dialog.querySelector('.type-options').onchange=updateCount;updateCount();
  // Render the configuration returned by the successful save immediately; reopening still reads the persisted value.
  dialog.querySelector('[data-save]').onclick=safe(async()=>{snapshot.config=await call('saveCommonTypes',{types:[...dialog.querySelectorAll('input:checked')].map(input=>input.value)});dialog.remove();renderDailyTypes();toast('常用类型已更新');});
 }
}
/** 提示紧贴对应字段标题，正常录入时收起说明，鼠标和键盘都能查看。 */
function subtaskHelp(id,label,text){
 return `<span class="field-help"><button type="button" class="help-button" aria-label="${label}说明" aria-describedby="${id}">?</button><span id="${id}" class="field-tooltip" role="tooltip">${text}</span></span>`;
}
function renderTask(){
 const input=$('#issue'),optional=Boolean(requirementTasks[selectedType]),day=$('#date').value;
 const beforeValue=input.value;
 if(input.readOnly&&optional)input.value='';
 const hasRequirement=Boolean(issueSelection?.key);
 const defaultTask=taskForType(selectedType,hasRequirement);
 const monthly=isMonthlyType(selectedType,hasRequirement);
 if(!taskEdited||!selectedTask)selectedTask=defaultTask;
 const binding=snapshot.state.bindings?.[day.slice(0,7)];
 const wasReadonly=input.readOnly;input.readOnly=monthly&&!optional;
 $('#issueLabel').textContent=optional?'关联需求／综合工时单':monthly?'关联综合工时单':'关联需求工单';
 input.placeholder=optional?'输入需求单号或标题，留空使用月度工单':'输入工单号或标题关键词';
 let painted=input.value!==beforeValue;
 if(monthly&&!optional){input.value=binding?binding.key+' · '+binding.title:day.slice(0,7)+' 产品综合工时管理';painted=true;}
 else if(issueSelection?.key){input.value=issueSelection.key+(issueSelection.title?' · '+issueSelection.title:'');painted=true;}
 else if(wasReadonly){input.value='';painted=true;}
 $('#monthlyStatus').hidden=!monthly;
 $('#monthlyStatus').textContent=binding?(optional?'使用月度工单 · ':'已创建 · ')+binding.key+' · '+binding.title:(optional?'未指定需求单时使用 ':'')+day.slice(0,7)+' 综合工时单 · 提交时查找或创建';
 const existing=monthly?(binding?monthlySubtaskCache.get(binding.key)||[]:[]):(issueSelection?.subtasks||[]);
 const exists=existing.some(row=>(row.title||row.fields?.summary)===selectedTask);
 $('#taskNameHelp').innerHTML=subtaskHelp('taskNote','子任务名称',exists?'已存在同名子任务，提交时复用':'提交时自动创建同名子任务');
 $('#subtasks').innerHTML='<input id="taskName" maxlength="255" autocomplete="off" value="'+escapeText(selectedTask)+'" placeholder="填写子任务名称"><p class="field-error" id="task-error" role="alert" hidden></p>';
 $('#taskName').oninput=event=>{selectedTask=event.target.value;taskEdited=true;clearFieldError('task');};
 if(monthly&&!optional&&binding&&!monthlySubtaskCache.has(binding.key)){
  monthlySubtaskCache.set(binding.key,[]);
  call('getIssue',{key:binding.key}).then(issue=>{monthlySubtaskCache.set(binding.key,issue.subtasks||[]);if(page==='daily')renderTask();}).catch(()=>{});
 }
 renderSubtaskChoice(selectedTask,monthly,binding);
 // 月单只读回填、选中回填、切类型清空都是程序化改写：把值固定成“已选中”，并收掉旧的工单红边。
 if(painted){input.dataset.picked=input.value;clearFieldError('issue');}
 refreshIssueClear(input);
}
// 子任务工单：能拿到该工单子任务时下拉，取不到时手填；留空仍走自动匹配/创建。
function renderSubtaskChoice(task,monthly,binding){
 const host=$('#subtaskChoice');
 if(!host)return;
 const source=monthly?(binding?monthlySubtaskCache.get(binding.key)||[]:[]):(issueSelection?.subtasks||[]);
 const options=source.filter(row=>(row.title||'').trim());
 const current=selectedSubtask?.key||'';
 // 已确认：日填报始终展示全部子任务（含已完成），不再提供开关。
 const visible=options;
 const help=subtaskHelp('subtaskNumberNote','子任务工单号','留空自动匹配或创建');
 if(current&&!visible.some(row=>row.key===current)){
  const chosen=options.find(row=>row.key===current);if(chosen)visible.unshift(chosen);
 }
 if(visible.length&&(!current||visible.some(row=>row.key===current))){
  host.innerHTML='<div class="label-row has-help"><label for="subtaskSelect">子任务工单号</label>'+help+'</div><select id="subtaskSelect" aria-label="选择子任务工单"><option value="">自动匹配或创建「'+escapeText(task)+'」</option>'+visible.map(row=>'<option value="'+escapeText(row.key)+'" '+(row.key===current?'selected':'')+'>'+escapeText(row.key+' · '+row.title+(row.statusCategory==='done'?'（已完成）':''))+'</option>').join('')+'</select>';
  $('#subtaskSelect').onchange=event=>{
   const key=event.target.value,row=visible.find(item=>item.key===key);
   selectedSubtask=key?{key,title:row?.title||''}:null;renderTask();
  };
 }else{
  host.innerHTML='<div class="label-row has-help"><label for="subtaskInput">子任务工单号</label>'+help+'</div><input id="subtaskInput" autocomplete="off" placeholder="例如 EXEPD-105" value="'+escapeText(current)+'">'+(selectedSubtask?.key?'<p class="target-note">已选：'+escapeText(selectedSubtask.title||selectedSubtask.key)+(monthly?' · 提交时校验月度归属':'')+'</p>':'');
  $('#subtaskInput').onchange=event=>{
   const key=event.target.value.trim().toUpperCase();
   selectedSubtask=key?{key,title:''}:null;renderTask();
   if(!key)return;
   call('getIssue',{key}).then(issue=>{if(selectedSubtask?.key===key){selectedSubtask={key,title:issue.title||''};renderTask();}}).catch(()=>{});
  };
 }
}
function daily(){
 // 工时快捷块由统一常量生成，避免模板与校验规则各写一份。
 $('#hoursButtons').innerHTML=hoursButtonsHtml();
 const dateRow=$('#dailyWorkDate');dateRow.innerHTML=workDateMarkup('dateButton','dateLabel');
 $('#date').value=snapshot.today;
 paintDailyDate=bindWorkDate(dateRow,{value:snapshot.today,today:snapshot.today,onSelect:day=>{$('#date').value=day;renderTask();}});
 const syncHours=()=>document.querySelectorAll('[data-hours]').forEach(button=>button.classList.toggle('selected',Number($('#hours').value)===Number(button.dataset.hours)));
 document.querySelectorAll('[data-hours]').forEach(button=>button.onclick=()=>{$('#hours').value=button.dataset.hours;syncHours();});
 $('#hours').addEventListener('input',syncHours);
 for(const field of ['date','description','hours','issue']){
  $('#'+field).addEventListener('input',()=>clearFieldError(field));
 }
 $('#configureTypes').onclick=()=>typeDialog(true);
 $('[data-open-batch]').onclick=safe(()=>navigate('batch'));
 bindIssueSearch($('#issue'),{
  search:searchIssueRows,load:loadIssueDetail,onError:reportIssueError,
  // 选中与清空都归页面：控件只回报结果，不碰字段错误状态。
  onSelect:row=>{issueSelection=row;selectedSubtask=null;renderTask();clearFieldError('issue');},
  onQuery:()=>{issueSelection=null;selectedSubtask=null;renderTask();}
 });
 $('#issue').addEventListener('change',safe(async()=>{
  const key=$('#issue').value.trim().split(/\s+/)[0];
  if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)||issueSelection?.key===key)return;
  const issue=await call('getIssue',{key});
  issueSelection=issue;selectedSubtask=null;renderTask();
 }));
 $('#entry').onsubmit=safe(async event=>{
  event.preventDefault();const task=String($('#taskName')?.value||'').trim(),monthly=isMonthlyType(selectedType,Boolean(issueSelection?.key));
  const record={id:$('#entry').dataset.editId || undefined,day:$('#date').value,title:$('#description').value,hours:$('#hours').value,type:selectedType,task,taskSource:taskEdited?'manual':'auto',issue:monthly?'':issueSelection?.key,issueTitle:monthly?'':issueSelection?.title,subtaskKey:selectedSubtask?.key||'',subtaskTitle:selectedSubtask?.title||'',source:'按天填报'};
  try{
   if(requirementTasks[selectedType]&&$('#issue').value.trim()&&!issueSelection?.key)throw Object.assign(new Error('请选择候选需求单，或清空后使用月度工单'),{field:'issue'});
   validateRecord(record,{today:snapshot.today});if(!types.includes(record.type))throw new Error('请选择当前可用的工时类型');
  }
  catch(error){
   const field={day:'date',title:'description',hours:'hours',issue:'issue',type:'issue',task:'task',subtask:'subtask'}[error.field]||'issue';
   // 子任务号错误没有独立提示位：只提示并聚焦对应控件，不能把红框打到工单字段上。
   if(field==='subtask'){$('#entryError').textContent=error.message;($('#subtaskInput')||$('#subtaskSelect'))?.focus();return;}
   showFieldError(field,error.message);fieldParts(field)[0]?.focus();return;
  }
  await call('saveDraft',{record});delete $('#entry').dataset.editId;$('#description').value='';clearEntryErrors();selectedTask='';taskEdited=false;$('#description').focus();await refresh();renderQueue();renderTask();
 });
 $('#submit').onclick=safe(()=>submitRecords(snapshot.state.drafts.filter(row=>row.source!=='批量填报')));
 renderDailyTypes();renderTask();renderQueue();
}
function renderQueue(){
 const rows=snapshot.state.drafts.filter(row=>row.source!=='批量填报');$('#records').replaceChildren();
 for(const day of [...new Set(rows.map(row=>row.day))].sort().reverse()){
  const group=rows.filter(row=>row.day===day),sum=group.reduce((total,row)=>total+Number(row.hours||0),0);
  const heading=document.createElement('div');heading.className='group-header';heading.innerHTML='<div class="group-left">'+labelDay(day)+'<span>'+group.length+' 条</span><div class="day-total">合计 <strong>'+sum+' h</strong><span> / 7.5 h · '+(sum<7.5?'还差 '+(7.5-sum)+' h':sum===7.5?'正好 7.5 h':'超出 '+(sum-7.5)+' h')+'</span></div></div>';$('#records').append(heading);
  for(const row of group){
   const item=document.createElement('article');item.className='record';item.innerHTML='<div class="record-body"><div class="record-title">'+escapeText(row.title)+'</div><div class="record-meta"><span>'+escapeText(row.issue ? row.issue+(row.issueTitle?' - '+row.issueTitle:'') : '当月综合工时单')+'</span><span>'+escapeText(row.task)+'</span><span>'+escapeText(row.type)+'</span></div></div><div class="record-hours">'+row.hours+'<small>h</small></div><div class="record-state">待提交</div><div class="record-actions"><button data-edit>编辑</button><button data-copy>复制</button><button data-delete>删除</button></div>';
   item.querySelector('.record-title').title=row.title;
   item.querySelector('[data-edit]').onclick=()=>{
    $('#entry').dataset.editId=row.id;$('#date').value=row.day;paintDailyDate(row.day);$('#description').value=row.title;$('#hours').value=row.hours;selectedType=row.type;
    // Returned monthly rows can contain the resolved parent key; only a requirement task represents a user-picked requirement.
    issueSelection=row.issue&&!isMonthlyType(row.type,Boolean(row.issue))?{key:row.issue,title:row.issueTitle}:null;
    selectedSubtask=row.subtaskKey?{key:row.subtaskKey,title:row.subtaskTitle||''}:null;
    selectedTask=row.task||'';taskEdited=row.taskSource==='manual'||Boolean(row.task&&row.task!==taskForType(row.type,!isMonthlyType(row.type,Boolean(row.issue))));
    $('#issue').value=issueSelection?.key||'';renderDailyTypes();renderTask();
   };
   item.querySelector('[data-copy]').onclick=safe(async()=>{await call('saveDraft',{record:{...row,id:undefined}});await refresh();renderQueue();});
   item.querySelector('[data-delete]').onclick=safe(async()=>{await call('deleteDraft',{id:row.id});await refresh();renderQueue();});
   $('#records').append(item);
  }
 }
 if(!rows.length)$('#records').innerHTML='<div class="empty">还没有待提交工时，从左侧添加第一条。</div>';
 $('#summary').textContent=rows.length+' 条 · 合计 '+rows.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h';
 const recovery=$('#recoveryNotice');
 recovery.hidden=!snapshot.state.recovery;
 recovery.classList.toggle('warning',Boolean(snapshot.state.recovery));
 recovery.textContent=snapshot.state.recovery?'原记录暂时无法读取，原记录已保留。可以重新填写，之后继续保存。':'';
 setSubmissionButton(rows);
}

// 解析可在用户查看历史时结束；批量页节点此时在既有pageViews缓存中，反馈仍归属该视图。
function batchRoot(){return pageViews.get('batch')||main;}
const batch$=selector=>batchRoot().querySelector(selector);
function clearReadFeedback(){
 batch$('#readError').hidden=true;batch$('#readError').textContent='';batch$('#readError').classList.remove('no-result');
 batch$('#pasteInput').removeAttribute('aria-invalid');
}
function importFeedback(message,{settings=false,empty=false,batchId=null}={}){
 const box=batch$('#readError');box.hidden=false;box.classList.toggle('no-result',empty);box.innerHTML='<span>'+escapeText(message)+'</span>';
 // 全登记结果没有可编辑行，只通过主进程给出的确切批次提供当前可见的恢复入口。
 if(batchId){const button=document.createElement('button');button.className='quiet-link';button.textContent='查看本次提交';button.dataset.reopenBatch=batchId;button.onclick=safe(async()=>{const batch=await call('getBatch',{id:batchId});activeBatch=batch.id;await showBatch(batch,{open:true});});box.append(button);}
 if(settings){const button=document.createElement('button');button.className='quiet-link';button.textContent=message.includes('尚未配置')?'配置 Agent':'检查配置';button.onclick=safe(()=>navigate('settings'));box.append(button);}
}
function emptySource(title,detail,choose=false){
 return '<div class="source-empty"><svg aria-hidden="true"><use href="#batch"/></svg><strong>'+escapeText(title)+'</strong><p>'+escapeText(detail)+'</p>'+(choose?'<button class="primary" id="chooseDirectory">'+(typeof choose==='string'?choose:'选择文件夹')+'</button>':'')+'</div>';
}
function updateImportControls(){
 const failed=importKind==='file'&&previewFailed;
 const ready=importKind==='todo'?todoSelection.size>0:importKind==='paste'?Boolean(batch$('#pasteInput').value.trim()):Boolean(filePreview)||failed;
 batch$('#read').textContent=failed?'重试读取':'开始解析';
 batch$('#read').disabled=importBusy||!ready;
 batch$('#read').hidden=importBusy;batch$('#readProgress').hidden=!importBusy;batch$('#sourceHint').hidden=importBusy;
 batch$('#sourceHint').textContent=todoHintText();
 for(const node of batchRoot().querySelectorAll('.week-file:not(.todo-row),#localTab,#pasteTab,#todoTab,#changeDirectory,#pasteInput ,#todoRefresh'))node.disabled=importBusy;
 batch$('#todoSelectAll').disabled=importBusy||!todoList.some(todo=>pendingEntries(todo).length);
 // 已登记的待办行始终保持只读，不能被忙碌状态的统一开关重新启用。
 for(const node of batchRoot().querySelectorAll('#todoRows .todo-row'))node.disabled=importBusy;
 batch$('#step2').disabled=importBusy||!noteRecords.length;batch$('#step3').disabled=importBusy||!noteRecords.length;
}
function todoHintText(){
 if(importKind==='todo')return todoSelection.size?'已选择 '+todoSelection.size+' 笔工时':'勾选要带入的工时记录；类型在下一步手动选择';
 if(importKind==='file')return selectedFile?'缺失的日期和工时，解析后手动补齐':'请选择一份文档';
 return '缺失的日期和工时，解析后手动补齐';
}
function chooseImportKind(kind){
 rememberImportEdits();importKind=kind;clearReadFeedback();
 for(const [value,id] of [['file','local'],['paste','paste'],['todo','todo']]){
  batch$('#'+id+'Tab').classList.toggle('selected',kind===value);batch$('#'+id+'Tab').setAttribute('aria-selected',String(kind===value));
  batch$('#'+id+'Source').hidden=kind!==value;
 }
 importSource=kind==='file'?filePreview?.source:kind==='paste'?pasteResult?.source:todoResult?.source;
 // 待办来源按记录自带 todo: 前缀标识，不能再用页签来源 id 过滤草稿。
 noteRecords=kind==='todo'
  ?(todoResult?restoreImportEdits(todoResult.source,todoResult.records):[])
  :(importSource?restoreImportEdits(importSource,snapshot.state.drafts.filter(row=>row.importSourceId===importSource.id)):[]);
 updateImportControls();
 if(kind==='paste')batch$('#pasteInput').focus();
 if(kind==='todo'&&!todoLoaded)loadCompletedTodos();
}
// 第三个来源沿用选文档的版式：左侧勾选待办，右侧说明生成规则与默认值。
function mountTodoSource(){
 const toolbar=batch$('.source-toolbar');
 if(toolbar.querySelector('#todoTab'))return;
 const tab=document.createElement('button');
 tab.type='button';tab.id='todoTab';tab.className='source-tab';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','false');tab.setAttribute('aria-controls','todoSource');
 tab.innerHTML='<svg aria-hidden="true"><use href="#check"/></svg>待办工时';
 toolbar.prepend(tab);
 const panel=document.createElement('section');
 panel.id='todoSource';panel.className='local-source todo-source';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','todoTab');panel.hidden=true;
 panel.innerHTML='<div class="directory-bar"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#check"/></svg><span class="directory-label">待办工时</span><span id="todoSummary" class="directory-path"></span><button type="button" id="todoSelectAll" class="quiet-link" aria-pressed="false"><span class="todo-mark" aria-hidden="true"></span>全选</button><button type="button" id="todoRefresh" class="quiet-link">刷新</button></div>'+
  '<div class="file-workspace todo-workspace"><section class="file-picker" aria-labelledby="todoListTitle"><div class="choose-heading"><h2 id="todoListTitle">待办</h2><span id="todoCount">0 条</span></div><div id="todoRows" class="week-files todo-rows" role="group" aria-label="可带入的待办工时"></div></section></div>';
 batch$('#choosePanel').querySelector('.source-toolbar').after(panel);
 batch$('#todoRefresh').onclick=safe(()=>loadCompletedTodos({announce:true}));
 batch$('#todoSelectAll').onclick=()=>{
  const all=todoList.flatMap(todo=>pendingEntries(todo).map(entry=>entry.id));
  const selected=all.filter(id=>todoSelection.has(id));
  todoSelection=selected.length===all.length?new Set():new Set(all);
  paintTodoRows();updateImportControls();
 };
}
async function loadCompletedTodos({announce=false}={}){
 const list=batch$('#todoRows');
 if(!list)return;
 list.innerHTML='<div class="source-empty"><strong>正在读取待办</strong></div>';
 try{
  const {state}=await call('todoLoad');
  // 未完成的待办也可以带入工时记录，只看是否有未登记笔。
  todoList=(state.todos||[]).sort((a,b)=>String(b.completedAt||b.updatedAt||'').localeCompare(String(a.completedAt||a.updatedAt||'')));
  todoLoaded=true;
  let removedCount=0;
  // 待办或某一笔在别处被删除时，同步移除已带入但未提交的草稿。
  const cleaned=await call('syncTodoDrafts',{}).catch(()=>null);
  if(cleaned?.removed?.length){
   await refresh();
   const gone=new Set(cleaned.removed),beforeCount=noteRecords.length;
   noteRecords=noteRecords.filter(row=>!gone.has(row.id));
   if(page==='batch'&&noteRecords.length!==beforeCount){
    if(!noteRecords.length)showStep(1);
    else if(step===2)renderBatchRows();
    else if(step===3)reviewBatch();
    setSubmissionButton(noteRecords);
   }
   removedCount=cleaned.removed.length;
  }
  const ids=new Set(todoList.flatMap(todo=>(todo.workLogs||[]).map(entry=>entry.id)));
  todoSelection=new Set([...todoSelection].filter(id=>ids.has(id)));
  paintTodoRows();
  if(announce)toast('已刷新 '+todoList.length+' 条待办的工时'+(removedCount?'，并同步删除 '+removedCount+' 条工时日志':''));
  else if(removedCount)toast('已同步删除 '+removedCount+' 条已删除待办的工时日志');
 }catch(error){
  todoLoaded=false;todoList=[];paintTodoRows();
  importFeedback('读取待办失败：'+error.message);
 }
 updateImportControls();
}
function entryDayLabel(day){return day?new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{month:'long',day:'numeric'}):'待定日期';}
function pendingEntries(todo){return (todo.workLogs||[]).filter(entry=>entry.state!=='submitted');}
function paintTodoRows(){
 const list=batch$('#todoRows');
 if(!list)return;
 list.replaceChildren();
 const groups=todoList.map(todo=>({todo,entries:pendingEntries(todo)})).filter(group=>group.entries.length);
 const selectAll=batch$('#todoSelectAll');
 selectAll.setAttribute('aria-pressed',String(groups.length>0&&groups.every(({entries})=>entries.every(entry=>todoSelection.has(entry.id)))));
 if(!groups.length){
  list.innerHTML='<div class="source-empty"><svg aria-hidden="true"><use href="#check"/></svg><strong>没有待带入的工时</strong><p>可前往待办记录工时。</p></div>'+
    '<div class="todo-empty-link"><button type="button" class="quiet-link" data-open-todo>前往待办</button></div>';
  const jump=list.querySelector('[data-open-todo]');if(jump)jump.onclick=safe(()=>navigate('todo'));
  batch$('#todoCount').textContent='0 笔';batch$('#todoSummary').textContent='';
  return;
 }
 for(const {todo,entries} of groups){
  const box=document.createElement('div');box.className='todo-group';
  const total=entries.reduce((sum,entry)=>sum+Number(entry.hours||0),0);
  const head=document.createElement('div');head.className='todo-group-head';
  const mark=document.createElement('input');mark.type='checkbox';mark.className='todo-mark';
  mark.checked=entries.every(entry=>todoSelection.has(entry.id));
  mark.setAttribute('aria-label','选择「'+todo.title+'」的全部未登记工时');
  mark.onchange=()=>{for(const entry of entries){if(mark.checked)todoSelection.add(entry.id);else todoSelection.delete(entry.id);}paintTodoRows();updateImportControls();};
  const name=document.createElement('strong');name.textContent=todo.title;name.title=todo.title;
  const status=document.createElement('span');status.className='todo-group-status';status.textContent=todo.status;
  const meta=document.createElement('span');meta.className='todo-group-meta';meta.textContent=entries.length+' 笔 · '+total+' h';
  head.append(mark,name,status,meta);box.append(head);
  for(const entry of entries){
   const button=document.createElement('button');
   button.type='button';button.className='week-file todo-row';
   button.dataset.entryId=entry.id;
   const on=todoSelection.has(entry.id);
   button.classList.toggle('selected',on);button.setAttribute('aria-pressed',String(on));
   button.innerHTML='<span class="todo-mark" aria-hidden="true"></span><strong>'+escapeText(entryDayLabel(entry.day))+' · '+escapeText(String(entry.hours))+' h</strong>'+(entry.description?'<span class="todo-entry-description">'+escapeText(entry.description)+'</span>':'')+'<span class="file-range">未登记</span>';
   button.onclick=()=>{if(todoSelection.has(entry.id))todoSelection.delete(entry.id);else todoSelection.add(entry.id);paintTodoRows();updateImportControls();};
   box.append(button);
  }
  list.append(box);
 }
 let count=0,hours=0;
 for(const group of groups)for(const entry of group.entries){count++;if(todoSelection.has(entry.id))hours+=Number(entry.hours||0);}
 batch$('#todoCount').textContent=count+' 笔';
 batch$('#todoSummary').textContent=todoSelection.size?'已选 '+todoSelection.size+' 笔 · 合计 '+hours+' h':'共 '+count+' 笔未带入';
}
async function previewDocument(file){
 rememberImportEdits();selectedFile=file;filePreview=null;importSource=null;noteRecords=[];previewFailed=false;clearReadFeedback();
 batchRoot().querySelectorAll('.week-file').forEach(button=>{const selected=button.dataset.file===file.id;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
 batch$('#previewName').textContent=file.name;batch$('#previewBody').textContent='';updateImportControls();
 try{
  filePreview=await call('readDocument',{file:file.id});importSource=filePreview.source;
  batch$('#previewBody').textContent=filePreview.content;
  noteRecords=restoreImportEdits(importSource,snapshot.state.drafts.filter(row=>row.importSourceId===importSource.id));
 }catch(error){
  previewFailed=true;batch$('#previewBody').innerHTML=emptySource('文档读取失败','请检查文件是否仍存在，以及是否有读取权限。');
  importFeedback('「'+file.name+'」读取失败：'+error.message+'。请检查后重试。');
 }
 updateImportControls();
}
function documentModifiedLabel(value){
 const date=new Date(value),day=date.toLocaleDateString('sv-SE');
 const yesterday=new Date(new Date(snapshot.today+'T12:00:00').getTime()-86400000).toLocaleDateString('sv-SE');
 const label=day===snapshot.today?'今天':day===yesterday?'昨天':(date.getMonth()+1)+'月'+date.getDate()+'日';
 return label+' '+date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
}
async function loadImportDirectory(){
 batch$('#directoryPath').textContent=snapshot.config.notesDirectory||'尚未配置';batch$('#directoryPath').title=snapshot.config.notesDirectory||'';
 batch$('#changeDirectory').textContent=snapshot.config.notesDirectory?'更换文件夹':'配置文件夹';
 const list=batch$('#weekFiles');list.replaceChildren();let files=[];
 try{
  if(!snapshot.config.notesDirectory)list.innerHTML=emptySource('尚未配置文件夹','选择文档存放位置后，在这里查看文件。',true);
  else {
   ({files}=await call('listDocuments'));
   if(!files.length)list.innerHTML=emptySource('没有可读取的文档','支持 .md、.txt、.docx，仅读取第一层。','更换文件夹');
   for(const file of files){
    const button=document.createElement('button');button.className='week-file';button.dataset.file=file.id;
    const format=/\.docx$/i.test(file.name)?'Word':/\.md$/i.test(file.name)?'Markdown':'文本';
    button.innerHTML='<svg aria-hidden="true"><use href="#batch"/></svg><strong>'+escapeText(file.name)+'</strong><span class="file-range">'+format+' · '+documentModifiedLabel(file.modifiedAt)+'</span>';
    button.onclick=safe(()=>previewDocument(file));list.append(button);
   }
  }
 }catch(error){list.innerHTML=emptySource('无法读取文件夹','该位置不存在或没有访问权限。','重新选择');}
 batch$('#fileListTitle').nextElementSibling.textContent=files.length+' 份';
 const choose=async()=>{rememberImportEdits();if(await call('chooseNotes')){await refresh();selectedFile=null;filePreview=null;importSource=null;noteRecords=[];previewFailed=false;clearReadFeedback();await loadImportDirectory();batch$('#previewName').textContent='';batch$('#previewBody').innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');updateImportControls();}};
 batch$('#changeDirectory').onclick=safe(choose);if(batch$('#chooseDirectory'))batch$('#chooseDirectory').onclick=safe(choose);
 if(selectedFile&&files.some(file=>file.id===selectedFile.id))await previewDocument(selectedFile);
}
async function batch(){
 mountTodoSource();
 batch$('#step1').onclick=()=>showStep(1);batch$('#step2').onclick=()=>showStep(2);batch$('#step3').onclick=()=>showStep(3);
 batch$('#back').onclick=()=>{rememberImportEdits();showStep(1);};batch$('#editAgain').onclick=()=>showStep(2);batch$('#nextReview').onclick=()=>showStep(3);
 batch$('#submit').onclick=safe(()=>submitRecords(noteRecords));
 batch$('#localTab').onclick=()=>chooseImportKind('file');batch$('#pasteTab').onclick=()=>chooseImportKind('paste');batch$('#todoTab').onclick=()=>chooseImportKind('todo');
 batch$('#pasteInput').oninput=()=>{rememberImportEdits();pasteResult=null;importSource=null;noteRecords=[];clearReadFeedback();batch$('#pasteCount').textContent=batch$('#pasteInput').value.length+' 字';updateImportControls();};
 batch$('#read').onclick=safe(async()=>{
  if(previewFailed&&importKind==='file'){await previewDocument(selectedFile);return;}
  if(importKind==='paste'&&!batch$('#pasteInput').value.trim()){importFeedback('请先粘贴或输入工作记录。');batch$('#pasteInput').setAttribute('aria-invalid','true');batch$('#pasteInput').focus();updateImportControls();return;}
  if(importKind==='todo'&&!todoSelection.size){importFeedback('请先勾选要带入的待办工时。');updateImportControls();return;}
  rememberImportEdits();clearReadFeedback();importBusy=true;updateImportControls();
  batch$('#readStage').textContent=importKind==='todo'?'正在读取所选工时':'Agent 正在识别工时记录';
  batch$('#readSource').textContent=importName();batch$('#readCount').textContent='';batch$('#readMeter').removeAttribute('value');
  try{
   const parsed=importKind==='todo'
    ?await call('importTodos',{entryIds:[...todoSelection]})
    :await call('parseImport',importKind==='file'?{kind:'file',sourceId:filePreview.source.id}:{kind:'paste',content:batch$('#pasteInput').value});
   await refresh();importSource=parsed.source;
   if(importKind==='paste')pasteResult=parsed;
   if(importKind==='todo'){todoResult=parsed;todoSelection=new Set();paintTodoRows();}
   noteRecords=restoreImportEdits(parsed.source,parsed.records);rememberImportEdits();
   if(parsed.batchId){const batch=await call('getBatch',{id:parsed.batchId});rememberBatch(batch);submissionBatches.set('batch/'+parsed.source.id,batch);}
   if(!noteRecords.length){
    const message=parsed.outcome==='registered'
     ?(importKind==='todo'?'所选待办中的工时已全部登记。可查看填报记录。':'当前内容中的工时已全部登记。可查看填报记录。')
     :'未识别到工时记录。请检查当前内容，或更换文档后再次解析。';
    importFeedback(message,{empty:true,batchId:parsed.batchId});return;
   }
   batch$('#agentNotice').hidden=false;
   batch$('#agentNotice').textContent=importKind==='todo'
    ?['已带入所选工时，请核对后提交。',parsed.notice].filter(Boolean).join(' ')
    :'已按原文识别工时记录，请核对并补齐标记的字段后提交。';
   showStep(2);
  }catch(error){importFeedback(error.message,{settings:['DESTINATION_UNVERIFIED','AGENT_UNCONFIGURED','CLI_NOT_FOUND','MODEL_CONFIGURATION','MODEL_KEY_MISSING'].includes(error.code)});}
  finally{importBusy=false;updateImportControls();}
 });
 batch$('#previewBody').innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');
 await loadImportDirectory();chooseImportKind(importKind);showStep(1);
}
function showStep(next,{force=false}={}){
 step=next;if(page!=='batch'||(!force&&pageViews.has('batch')))return;
 closeBatchPopup();
 for(const [number,id] of [[1,'choosePanel'],[2,'confirmPanel'],[3,'reviewPanel']]){$('#'+id).hidden=next!==number;$('#step'+number).classList.toggle('active',next===number);if(number>1)$('#step'+number).disabled=!noteRecords.length;}
 if(next===2){renderBatchRows();setSubmissionButton(noteRecords);}
 if(next===3)reviewBatch();
}
let batchPopup=null,batchPopupAnchor=null;
function closeBatchPopup(){batchPopup?.remove();batchPopup=null;batchPopupAnchor=null;}
// 批量浮层与确认设计使用相同锚点定位，滚动或切步骤时关闭。
function placeBatchPopup(anchor,panel){
 closeBatchPopup();batchPopup=panel;batchPopupAnchor=anchor;document.body.append(panel);
 const box=anchor.getBoundingClientRect(),height=panel.getBoundingClientRect().height;
 panel.style.left=Math.max(8,Math.min(box.left,innerWidth-panel.offsetWidth-8))+'px';
 panel.style.top=(box.bottom+height+8<innerHeight?box.bottom+5:Math.max(8,box.top-height-5))+'px';
}
function openBatchCalendar(anchor,row) {
 let month=(row.day||snapshot.today).slice(0,7);
 const panel=document.createElement('div');panel.className='row-calendar row-popover';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择工作日期');
 const commit=value=>{row.day=value;safe(async()=>{row.touched=true;rememberImportEdits();if(row.title.trim())await call('saveDraft',{record:row});closeBatchPopup();renderBatchRows();})();};
 function paint(){
  const [y,m]=month.split('-').map(Number),offset=(new Date(y,m-1,1).getDay()+6)%7,last=new Date(y,m,0).getDate();
  panel.innerHTML='<header><h2>选择工作日期</h2><button type="button" class="calendar-close" aria-label="关闭日期选择">×</button></header><div class="calendar-nav"><button type="button" data-prev aria-label="上个月">‹</button><strong>'+y+'年'+m+'月</strong><button type="button" data-next aria-label="下个月" '+(month>=snapshot.today.slice(0,7)?'disabled':'')+'>›</button></div><div class="calendar-weekdays">'+['一','二','三','四','五','六','日'].map(label=>'<span>'+label+'</span>').join('')+'</div><div class="calendar-days">'+Array(offset).fill('<span></span>').join('')+Array.from({length:last},(_,i)=>{
   const value=month+'-'+String(i+1).padStart(2,'0');return '<button type="button" data-date="'+value+'" aria-label="'+value+'" class="'+(value===row.day?'chosen':value===snapshot.today?'current':'')+'" '+(value>snapshot.today?'disabled':'')+'>'+(i+1)+'</button>';
  }).join('')+'</div><div class="calendar-caption"><span>可选择其他月份</span><span>今天及以前</span></div><div class="calendar-actions"><button type="button" class="shortcut" data-today>今天</button><button type="button" class="shortcut" data-yesterday>昨天</button><button type="button" class="clear-date" data-clear>清除日期</button></div>';
  panel.querySelector('.calendar-close').onclick=closeBatchPopup;
  panel.querySelector('[data-prev]').onclick=()=>{month=new Date(y,m-2,1,12).toLocaleDateString('sv-SE').slice(0,7);paint();};
  panel.querySelector('[data-next]').onclick=()=>{month=new Date(y,m,1,12).toLocaleDateString('sv-SE').slice(0,7);paint();};
  panel.querySelectorAll('[data-date]').forEach(button=>button.onclick=()=>commit(button.dataset.date));
  panel.querySelector('[data-today]').onclick=()=>commit(snapshot.today);panel.querySelector('[data-yesterday]').onclick=()=>commit(new Date(new Date(snapshot.today+'T12:00:00').getTime()-86400000).toLocaleDateString('sv-SE'));panel.querySelector('[data-clear]').onclick=()=>commit('');
 }
 paint();placeBatchPopup(anchor,panel);
}
function openBatchHours(anchor,row) {
 const panel=document.createElement('div');panel.className='hours-options row-popover';panel.setAttribute('role','group');panel.setAttribute('aria-label','常用工时');
 for(const value of HOUR_CHOICES){
  const button=document.createElement('button');button.type='button';button.textContent=value+' h';button.setAttribute('aria-pressed',String(Number(row.hours)===value));
  button.onclick=()=>{row.hours=value;row.touched=true;rememberImportEdits();safe(async()=>{if(row.title.trim())await call('saveDraft',{record:row});closeBatchPopup();renderBatchRows();})();};panel.append(button);
 }
 placeBatchPopup(anchor,panel);
}

// 综合工时单：优先用当月绑定，没有绑定时按月份搜索一次。
async function monthlyParentKey(row){
 const month=String(row.day||snapshot.today||'').slice(0,7);
 const binding=snapshot.state.bindings?.[month];
 if(binding?.key)return binding.key;
 try{
  const result=await call('searchMonthly',{query:''});
  const list=Array.isArray(result)?result:(result.issues||[]);
  const [year,number]=month.split('-').map(Number);
  const pattern=new RegExp('(?:^|[^0-9])'+year+'年0?'+number+'月');
  return list.find(item=>pattern.test(item.title||'')&&/综合|工时/.test(item.title||''))?.key||'';
 }catch{return '';}
}
// 批量行的子任务下拉：按当前工单（或综合工时单）拉取，默认不含已完成；选择后写回该行。
async function openSubtaskPicker(anchor,row,apply){
 const monthly=isMonthlyType(row.type,Boolean(row.issue));
 let issueKey=row.issue;
 if(monthly)issueKey=await monthlyParentKey(row);
 if(!issueKey){toast(monthly?'当月还没有综合工时单，可先手填子任务号':'请先选择工单');return;}
 let showDone=false,keyword='',issue=null;
 const panel=document.createElement('div');panel.className='subtask-picker row-popover';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择子任务工单');
 panel.innerHTML='<header><strong>选择子任务工单</strong><button type="button" data-close aria-label="关闭">×</button></header>'+
  '<label class="subtask-done-toggle"><input type="checkbox" data-done> 显示已完成</label>'+
  '<input class="subtask-search" data-search placeholder="按编号或标题筛选" autocomplete="off">'+
  '<div class="subtask-options" data-options><div class="subtask-picker-empty">正在读取子任务…</div></div>';
 const options=panel.querySelector('[data-options]');
 const render=()=>{
  if(!issue){options.innerHTML='<div class="subtask-picker-empty">无法读取子任务，请直接输入工单号</div>';return;}
  const list=(issue.subtasks||[]).filter(item=>(item.title||'').trim())
   .filter(item=>showDone||item.statusCategory!=='done')
   .filter(item=>!keyword||(item.key+' '+item.title).toLowerCase().includes(keyword));
  options.innerHTML='<button type="button" data-auto>自动匹配或创建「'+escapeText(row.task||'当前任务')+'」</button>'+
   list.map(item=>'<button type="button" data-key="'+escapeText(item.key)+'" data-title="'+escapeText(item.title)+'" class="'+(item.key===row.subtaskKey?'selected':'')+'">'+escapeText(item.key+' · '+item.title)+(item.statusCategory==='done'?'（已完成）':'')+'</button>').join('');
  options.querySelector('[data-auto]').onclick=()=>{apply('');closeBatchPopup();};
  options.querySelectorAll('[data-key]').forEach(button=>button.onclick=()=>{apply(button.dataset.key,button.dataset.title);closeBatchPopup();});
 };
 panel.querySelector('[data-close]').onclick=closeBatchPopup;
 panel.querySelector('[data-done]').onchange=event=>{showDone=event.target.checked;render();};
 panel.querySelector('[data-search]').oninput=event=>{keyword=event.target.value.trim().toLowerCase();render();};
 cachedIssue(issueKey).then(result=>{issue=result;render();}).catch(()=>render());
 placeBatchPopup(anchor,panel);
}
function renderBatchRows(){
 $('#agentNotice').hidden=noteRecords.every(row=>{try{validateRecord(row,{today:snapshot.today});return true;}catch{return false;}});
 $('#sourceName').textContent=importName();$('#recordCount').textContent=noteRecords.length+' 条记录';$('#editRows').replaceChildren();
 const groups=[...new Set(noteRecords.map(row=>row.day || ''))].sort((a,b)=>(a||'z').localeCompare(b||'z'));
 for(const day of groups){
  const records=noteRecords.filter(row=>(row.day||'')===day);const header=document.createElement('tr');header.className='date-group';header.dataset.day=day;
  header.innerHTML='<td colspan="8"><strong>'+labelDay(day)+'</strong><span class="group-detail">'+records.length+' 条 · 已填 '+records.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h</span></td>';$('#editRows').append(header);
  for(const row of records){
   const tr=document.createElement('tr');tr.dataset.row=row.id;tr.classList.toggle('returned-failed',returnedFailedIds.has(row.id));const index=noteRecords.indexOf(row);
   tr.innerHTML='<td class="number-cell">'+String(index+1).padStart(2,'0')+'</td><td><input data-field="title" aria-label="工作事项" value="'+escapeText(row.title)+'"></td><td><button class="date-picker" data-day aria-label="选择工作日期"><svg><use href="#calendar"/></svg><span>'+(row.day?labelDay(row.day):'选择日期')+'</span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></td><td><input data-field="hours" aria-label="工时" type="number" step="0.25" min="0.25" value="'+escapeText(row.hours)+'" placeholder="待填"></td><td><select data-field="type" aria-label="工时类型"><option value="">选择工时类型</option>'+types.map(type=>'<option '+(row.type===type?'selected':'')+'>'+escapeText(type)+'</option>').join('')+'</select></td><td><div style="position:relative"><input aria-label="关联工单" data-issue value="'+escapeText(row.issue || row.issueQuery)+'" placeholder="输入工单号"></div></td><td><input data-field=\"task\" aria-label=\"子任务名称\" maxlength=\"255\" value=\"'+escapeText(row.task||'')+'\" placeholder=\"选择或输入子任务名称\"></td><td><div class="subtask-field"><input aria-label="子任务工单号" data-subtask value="'+escapeText(row.subtaskKey||'')+'" placeholder="可留空"><button type="button" class="subtask-pick" data-subtask-pick aria-label="选择子任务工单">▾</button></div><div class="cell-hint subtask-hint"></div></td>';
   const save=async()=>{row.touched=true;rememberImportEdits();if(row.title.trim())await call('saveDraft',{record:row});};
   const markMissing=()=>{
    const invalidHours=row.hours===''||row.hours==null?'原文未提供':hoursValid(Number(row.hours))?'':HOURS_ERROR;
    for(const [selector,hint] of [['[data-field=title]',row.title.trim()?'':'请填写工作事项'],['[data-field=hours]',invalidHours],['[data-field=type]',row.type?'':'请选择工时类型'],['[data-field=task]',String(row.task||'').trim()?'':'请填写子任务名称'],['[data-day]',!row.day?'原文未提供':row.day>snapshot.today?'请选择今天及以前':'']]){
     const input=tr.querySelector(selector);
     // 已填但不符合0.25h步长的值保留原文，以红边区别于仍待补的空值。
     const invalid=selector==='[data-field=hours]'&&Boolean(hint)&&row.hours!==''&&row.hours!=null;
     input.classList.toggle('missing',Boolean(hint)&&!invalid);input.classList.toggle('invalid',invalid);
     let label=input.nextElementSibling;if(!label?.classList.contains('cell-hint')){label=document.createElement('div');label.className='cell-hint';input.after(label);}label.textContent=hint;
    }
    tr.querySelector('[data-issue]').classList.toggle('missing',!row.issue&&!row.subtaskKey&&!isMonthlyType(row.type,Boolean(row.issue)));
     const subtaskInput=tr.querySelector('[data-subtask]');const badSubtask=Boolean(row.subtaskKey)&&!/^[A-Z][A-Z0-9_]*-\d+$/.test(row.subtaskKey);
     subtaskInput.classList.toggle('invalid',badSubtask);
     const subtaskHint=tr.querySelector('.subtask-hint');subtaskHint.textContent=badSubtask?'子任务号格式不正确':(row.subtaskKey?((row.subtaskTitle||'提交时校验')+(row.issue?' · 以子任务所属工单为准':'')):(row.subtaskHint||''));
   };
   // 按工单已有子任务名自动带入子任务工单；只认唯一匹配，手填值不覆盖。
   const autoFill=async()=>{
    if(!row.issue||!row.task||row.subtaskKey||row.subtaskSource==='manual')return;
    const {issue:key,task}=row;
    try{
     const issue=await cachedIssue(key);
     if(row.issue!==key||row.task!==task||row.subtaskSource==='manual')return;
     const matches=(issue.subtasks||[]).filter(item=>item.title===task);
     if(matches.length===1){
      row.subtaskKey=matches[0].key;row.subtaskTitle=matches[0].title;row.subtaskSource='auto';row.subtaskHint='';
      const field=tr.querySelector('[data-subtask]');if(field)field.value=row.subtaskKey;
      markMissing();safe(save)();
     }else if(matches.length>1){
      row.subtaskHint='存在多个同名子任务，请手填工单号';markMissing();
     }
    }catch{ /* 取不到子任务列表时保持手填，不影响提交 */ }
   };
   // 只清理自动匹配；手填编号代表用户明确指定了本条去向。
   const clearAutomaticSubtask=()=>{
    if(row.subtaskSource==='manual')return;
    Object.assign(row,{subtaskKey:'',subtaskTitle:'',subtaskSource:'',subtaskHint:'',createSubtask:true});
    tr.querySelector('[data-subtask]').value='';
   };
   markMissing();

   for(const [field,change] of Object.entries(row.todoConflicts||{})){
    const cell=tr.querySelector(field==='day'?'[data-day]':`[data-field=${field}]`).parentElement;
    const choice=document.createElement('select'),label={day:'工作日期',hours:'工时',title:'工作事项'}[field];
    choice.setAttribute('aria-label','选择'+label+'采用待办或草稿');
    choice.add(new Option('待办'+label+'已变更，请选择',''));
    choice.add(new Option('使用待办：'+change.current,'source'));
    choice.add(new Option('保留草稿：'+row[field],'draft'));
    choice.title='原待办：'+(change.previous??'旧版本未记录');
    choice.onchange=safe(async()=>{
     if(!choice.value)return;
     if(choice.value==='source')row[field]=change.current;
     row.todoOrigin[field]=change.current;
     delete row.todoConflicts[field];
     await save();renderBatchRows();
    });
    cell.append(choice);
   }

   tr.querySelectorAll('[data-field]').forEach(input=>input.onchange=safe(async()=>{
    const field=input.dataset.field;
    if(field==='task'){
     row.task=input.value.trim();row.taskSource='manual';input.value=row.task;
     clearAutomaticSubtask();
     markMissing();await save();updateBatchTotals();autoFill();return;
    }
    const hadRequirement=Boolean(row.issue);
    row[field]=input.value;
    if(field==='type'){
     if(row.taskSource!=='manual'||!String(row.task||'').trim())row.task=taskForType(row.type,hadRequirement);
     if(isMonthlyType(row.type,Boolean(row.issue))){row.issue='';row.issueTitle='';row.issueQuery='';}
     tr.querySelector('[data-field=task]').value=row.task || '';
     clearAutomaticSubtask();
     const issueInput=tr.querySelector('[data-issue]'),optional=Boolean(requirementTasks[row.type]);
     issueInput.readOnly=isMonthlyType(row.type,Boolean(row.issue))&&!optional;
     issueInput.value=issueInput.readOnly?(row.day?.slice(0,7)||'对应月份')+' 综合工时单':row.issue || row.issueQuery || '';
     issueInput.placeholder=optional?'留空使用月度工单':'输入工单号';
     refreshIssueClear(issueInput);
    }
    await save();markMissing();updateBatchTotals();autoFill();
   }));
   tr.querySelector('[data-day]').onclick=()=>openBatchCalendar(tr.querySelector('[data-day]'),row);
   const subtaskField=tr.querySelector('[data-subtask]');
   const verifySubtask=async()=>{
    if(!row.subtaskKey||!/^[A-Z][A-Z0-9_]*-\d+$/.test(row.subtaskKey)){markMissing();return;}
    try{const issue=await call('getIssue',{key:row.subtaskKey});row.subtaskTitle=issue.title||'';}catch{row.subtaskTitle='';}
    markMissing();safe(save)();
   };
   subtaskField.onchange=()=>{
    const value=subtaskField.value.trim().toUpperCase();
    row.subtaskKey=value;row.subtaskTitle='';row.subtaskSource=value?'manual':'';row.subtaskHint='';
    subtaskField.value=row.subtaskKey;markMissing();safe(save)();
    if(row.subtaskKey)verifySubtask();else autoFill();
   };
   subtaskField.onblur=()=>verifySubtask();
   tr.querySelector('[data-subtask-pick]').onclick=()=>openSubtaskPicker(tr.querySelector('[data-subtask-pick]'),row,(key,title)=>{
    row.subtaskKey=key;row.subtaskTitle=title||'';row.subtaskSource=key?'manual':'';row.subtaskHint='';
    subtaskField.value=key;markMissing();safe(save)();
   });

   const hours=tr.querySelector('[data-field=hours]');hours.addEventListener('blur',updateBatchTotals);hours.onfocus=()=>setTimeout(()=>{if(document.activeElement===hours&&document.contains(hours))openBatchHours(hours,row);},0);hours.onclick=()=>openBatchHours(hours,row);
   const input=tr.querySelector('[data-issue]');
input.addEventListener('change',safe(async()=>{
    const key=input.value.trim().split(/\s+/)[0];
    if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)||row.issue===key)return;
    const issue=await cachedIssue(key);
    row.issue=issue.key;row.issueTitle=issue.title;row.issueQuery='';
    clearAutomaticSubtask();
    markMissing();safe(save)();autoFill();
   }));
   if(row.issueTitle){const title=document.createElement('div');title.className='issue-title';title.textContent=row.issueTitle;input.parentElement.append(title);}
   const optional=Boolean(requirementTasks[row.type]);
   if(isMonthlyType(row.type,Boolean(row.issue))){
    input.readOnly=!optional;input.value=optional?'':(row.day?.slice(0,7)||'对应月份')+' 综合工时单';
   }
   if(optional)input.placeholder='留空使用月度工单';
   // Rows may switch from a monthly type to a requirement type without being rebuilt.
   bindIssueSearch(input,{
    search:searchIssueRows,load:loadIssueDetail,onError:reportIssueError,
    listClass:'issue-results issue-candidates row-popover',place:placeBatchPopup,onClose:()=>closeBatchPopup(),
    valueFor:row=>row.key,
    renderRow:(button,row)=>{button.className='candidate';button.innerHTML=escapeText(row.key)+'<span>'+escapeText(row.title||row.fields?.summary||'')+'</span>';},
    onSelect:issue=>{
     row.issue=issue.key;row.issueTitle=issue.title;row.issueQuery='';if(row.taskSource!=='manual'||!String(row.task||'').trim())row.task=taskForType(row.type,true);tr.querySelector('[data-field=task]').value=row.task||'';
     clearAutomaticSubtask();
     markMissing();safe(save)();updateBatchTotals();if(step===3)reviewBatch();autoFill();
    },
    onQuery:()=>{
     // Keep an unfinished query when the user returns from confirmation, so it remains selectable or clearable.
     row.issue='';row.issueTitle='';row.issueQuery=input.value;if(row.taskSource!=='manual'||!String(row.task||'').trim())row.task=taskForType(row.type,false);tr.querySelector('[data-field=task]').value=row.task||'';
     clearAutomaticSubtask();
     markMissing();safe(save)();updateBatchTotals();
    }
   });
   $('#editRows').append(tr);
   if(row.issue&&row.task&&!row.subtaskKey)autoFill();
  }
 }
 updateBatchTotals();
}
function reviewBatch(){
 const hours=rows=>rows.reduce((sum,row)=>sum+(Number(row.hours)||0),0);
 const dated=noteRecords.filter(row=>row.day),undated=noteRecords.filter(row=>!row.day);
 const incomplete=noteRecords.filter(row=>{try{validateRecord(row,{today:snapshot.today});return !types.includes(row.type);}catch{return true;}});
 $('#reviewFile').textContent=importName();$('#weekTotal').innerHTML=hours(dated)+'<small> h</small>';
 $('#weekPending').textContent=undated.length?'另有 '+hours(undated)+' h 待确定日期':'';
 const dates=[...new Set(dated.map(row=>row.day))].sort();
 $('#weekRange').textContent=dates.length?dates[0].replaceAll('-','.')+' — '+dates.at(-1).replaceAll('-','.'): '日期待补齐';
 $('#weekRange').parentElement.classList.add('summary-range');
 $('#reviewRows').innerHTML=[...new Set(noteRecords.map(row=>row.day||''))].sort((a,b)=>(a||'z').localeCompare(b||'z')).map(day=>{
  const rows=noteRecords.filter(row=>(row.day||'')===day),pending=rows.some(row=>incomplete.includes(row));
  const hints=[...new Set(rows.flatMap(row=>[!row.title.trim()&&'事项',!String(row.task||'').trim()&&'子任务名称',!row.day&&'日期',!hoursValid(Number(row.hours))&&'工时',!row.type&&'类型',(!row.issue&&!row.subtaskKey&&!isMonthlyType(row.type,Boolean(row.issue)))&&'工单',Object.keys(row.todoConflicts||{}).length&&'待办工时变更'].filter(Boolean)))];
  return '<tr data-day="'+escapeText(day)+'"><td>'+labelDay(day)+'</td><td>'+rows.length+' 条</td><td>'+hours(rows)+' h</td><td class="'+(pending?'pending':'ready')+'">'+(pending?(hints.join('、')||'请检查字段'):'已齐全')+'</td></tr>';
 }).join('');
 $('#reviewStatus').className='confirm-summary '+(incomplete.length?'needs':'success');
 $('#reviewStatus').textContent=incomplete.length?'待补 '+incomplete.length+' 条，请返回填报':'字段已齐全，可提交';
 setSubmissionButton(noteRecords);if(incomplete.length&&!currentBatch())$('#submit').disabled=true;
}
function updateBatchTotals() {
 if(page!=='batch'||!$('#editRows'))return;
 for(const header of document.querySelectorAll('#editRows .date-group')){
  const rows=noteRecords.filter(row=>(row.day||'')===header.dataset.day);
  header.firstElementChild.innerHTML='<strong>'+escapeText(labelDay(header.dataset.day))+'</strong><span class="group-detail">'+rows.length+' 条 · 已填 '+rows.reduce((sum,row)=>sum+(Number(row.hours)||0),0)+' h</span>';
 }
 const pending=noteRecords.filter(row=>{try{validateRecord(row,{today:snapshot.today});return false;}catch{return true;}}).length;
 $('#summary').innerHTML='<span>已填 <strong>'+noteRecords.reduce((sum,row)=>sum+(Number(row.hours)||0),0)+' h</strong></span>'+(pending?'<span class="needs">待补 '+pending+' 条</span>':'<span class="success">字段已齐全</span>');
}
async function submitRecords(records){
 const existing=currentBatch();
 const oldIds=new Set(existing?.items.filter(item=>item.status!=='deleted').map(item=>item.id)||[]);
 if(existing && (existing.running || existing.items.some(item=>!isCompletedItem(item)) || !records.some(row=>!oldIds.has(row.id)))){
  activeBatch=existing.id;await showBatch(await call('getBatch',{id:existing.id}),{open:true});return;
 }
 const valid=records.filter(row=>{try{validateRecord(row,{today:snapshot.today});return types.includes(row.type);}catch{return false;}});
 if(!valid.length || (page==='batch'&&valid.length!==records.length))throw new Error('请先补齐待提交事项');
 // 首次提交中旧ID记录可能只带sourceFile；本次请求来源是确切证据，不改写旧记录元数据。
 const requestedSource=sourceKey();
 const batch=await call('startSubmission',{records:valid});activeBatch=batch.id;rememberBatch(batch);submissionBatches.set(requestedSource,batch);await showBatch(batch,{open:true});
 if(page==='daily')setSubmissionButton(snapshot.state.drafts.filter(row=>row.source!=='批量填报'));
 if(page==='batch')setSubmissionButton(noteRecords);
}
async function restoreUnfinished(batch) {
 await call('returnToDrafts',{batchId:batch.id});
 // 服务端已把失败项写回草稿；刷新快照，避免用提交前的旧标题/工时重新确认。
 await refresh();
 releasedBatches.add(batch.id);for(const [key,known] of submissionBatches)if(known.id===batch.id)submissionBatches.delete(key);
 drawerDesiredOpen=false;$('#submissionView').close();activeBatch=null;
 const origin=batchSource(batch).startsWith('batch/')?'batch':'daily';
 await navigate(origin);
 if(origin==='batch'){
  const ids=new Set(batch.items.filter(item=>!isCompletedItem(item)).map(item=>item.id));
  noteRecords=snapshot.state.drafts.filter(row=>ids.has(row.id));
  const record=noteRecords[0];
  // 历史恢复只使用该批次的原来源。旧记录没有新来源编号，不能继承别的文档预览或粘贴身份。
  filePreview=null;pasteResult=null;previewFailed=false;
  importSource=record?.importSourceId?{id:record.importSourceId,kind:record.sourceKind,name:record.sourceName,contentHash:record.sourceHash,fileName:record.sourceFile}:null;
  importKind=importSource?.kind||'file';
  selectedFile=record?.sourceFile?{id:record.sourceFile,name:record.sourceName||record.sourceFile}:null;
  if(importKind==='paste')pasteResult={source:importSource};
  if(importKind==='todo'){todoResult={source:importSource,records:noteRecords};todoSelection=new Set();paintTodoRows();}
  clearReadFeedback();$('#pasteInput').value='';$('#pasteCount').textContent='0 字';
  $('#previewName').textContent='';$('#previewBody').innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');
  for(const [kind,id] of [['file','local'],['paste','paste'],['todo','todo']]){
   $('#'+id+'Tab').classList.toggle('selected',kind===importKind);$('#'+id+'Tab').setAttribute('aria-selected',String(kind===importKind));$('#'+id+'Source').hidden=kind!==importKind;
  }
  document.querySelectorAll('.week-file').forEach(button=>{button.classList.remove('selected');button.setAttribute('aria-pressed','false');});
  updateImportControls();
  returnedFailedIds=new Set(ids);
  showStep(2,{force:true});
  setTimeout(()=>{
   const row=document.querySelector('#editRows tr.returned-failed');
   if(!row)return;
   row.scrollIntoView({block:'center'});
   const input=row.querySelector('[data-field=title]');
   if(input){input.focus();input.select();}
  },0);
 }
}
function resetBatchHome(){
 noteRecords=[];importSource=null;filePreview=null;pasteResult=null;previewFailed=false;
 todoResult=null;selectedFile=null;todoSelection=new Set();returnedFailedIds=new Set();
 clearReadFeedback();
 const paste=batch$('#pasteInput');
 if(paste){paste.value='';}
 const count=batch$('#pasteCount');if(count)count.textContent='0 字';
 const previewName=batch$('#previewName');if(previewName)previewName.textContent='';
 const previewBody=batch$('#previewBody');if(previewBody)previewBody.innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');
 document.querySelectorAll('.week-file').forEach(button=>{button.classList.remove('selected');button.setAttribute('aria-pressed','false');});
 if(batch$('#todoRows'))paintTodoRows();
 updateImportControls();
 showStep(1,{force:true});
}
async function showBatch(batch,{open=false}={}){
 if(!batch)return;
 rememberBatch(batch);if(open)drawerDesiredOpen=true;
 const drawer=$('#submissionView'),items=batch.items||[];
 const successes=items.filter(item=>item.status==='success');
 const failures=items.filter(item=>['failed','uncertain','duplicate'].includes(item.status));
 const waiting=items.filter(item=>item.status==='waiting');
 const working=items.find(item=>['creating','submitting','retrying'].includes(item.status));
 const processed=successes.length+failures.length+items.filter(item=>item.status==='deleted').length;
 const registeredHours=successes.reduce((sum,item)=>sum+Number(item.hours),0);
 const title=batch.running?'提交进度':'提交结果';
 drawer.classList.add('submission-view');
 drawer.setAttribute('aria-label',title);
 drawer.innerHTML='<header class="result-header"><h2 id="submissionDrawerHeading" tabindex="-1">'+title+'</h2><span class="result-count">本次 '+items.length+' 条</span><button class="result-close" aria-label="关闭抽屉"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10m0-10L5 15"/></svg></button></header><div class="result-summary"><div class="result-lead"><span class="result-caption">已登记工时</span><strong class="result-hours batch-total">'+registeredHours+'<small> h</small></strong></div><div class="result-meter"><div class="result-tally"><span class="result-good">'+successes.length+' 条已登记</span>'+(failures.length?'<span class="result-warn">'+failures.length+' 条失败</span>':'')+(waiting.length?'<span class="result-secondary">'+waiting.length+' 条待提交</span>':'')+'</div>'+(batch.running?'<span class="result-progress-label">已处理 '+processed+' / '+items.length+' 条</span><progress class="result-progress" aria-label="本次提交进度" max="'+Math.max(items.length,1)+'" value="'+processed+'"></progress>':'')+'</div></div><div class="result-rows submission-rows"></div><footer class="result-footer"></footer>';
 const close=()=>{drawerDesiredOpen=false;drawer.close();};
 drawer.querySelector('.result-close').onclick=close;
 drawer.oncancel=()=>{drawerDesiredOpen=false;};
 drawer.onclick=event=>{if(event.target===drawer){const box=drawer.getBoundingClientRect();if(event.clientX<box.left||event.clientX>=box.right||event.clientY<box.top||event.clientY>=box.bottom)close();}};
 const footer=drawer.querySelector('.result-footer');
 const unfinished=items.some(item=>!isCompletedItem(item));
 if(batch.running){
  const current=Math.max(items.indexOf(working),0)+1;
  footer.innerHTML='<span class="result-footer-note">正在处理第 '+current+' 条</span>';
 } else {
  footer.innerHTML='<a class="result-history" href="#">查看填报记录</a><button class="result-continue" data-return '+(unfinished?'data-edit':'')+'>'+'返回填报'+'</button>';
  footer.querySelector('.result-history').onclick=safe(async event=>{event.preventDefault();close();await navigate('history');});
  footer.querySelector('[data-return]').onclick=safe(async()=>{
   if(unfinished)return restoreUnfinished(batch);
   close();await refresh();
   if(page==='daily')renderQueue();
   if(page==='history')history();
   if(page!=='batch')await navigate('batch');
   resetBatchHome();
   showToast('已返回批量填报');
  });
 }
 const labels={waiting:'待提交',creating:'正在创建',submitting:'提交中',retrying:'重试中',success:'已登记',failed:'失败',uncertain:'待核对',duplicate:'疑似重复',deleted:'已删除'};
 for(const item of items){
  const row=document.createElement('article');row.className='result-row submission-row';row.dataset.itemId=item.id;row.dataset.state=item.status;
  const day=item.day?Number(item.day.slice(5,7))+'月'+Number(item.day.slice(8))+'日':'待定日期';
  const status=item.status==='creating'&&item.creationLabel?item.creationLabel:(labels[item.status]||item.status);
  row.innerHTML='<div class="result-row-top"><strong class="result-item-title">'+escapeText(item.title)+'</strong><span class="result-item-hours">'+escapeText(item.hours)+' h</span></div><div class="result-meta meta">'+[day,item.targetKey||item.issue||'综合工时单',item.task,item.type].filter(Boolean).map(escapeText).join(' · ')+'</div><div class="result-outcome outcome"><span class="result-line-status">'+escapeText(status)+'</span>'+(item.worklogId&&item.status!=='deleted'?'<span class="result-log">工时 ID · '+escapeText(item.worklogId)+'</span>':'')+'</div>'+(item.error?'<p class="result-note inline-error">'+escapeText(item.error)+'</p>':'');
  const outcome=row.querySelector('.result-outcome');
  if(['failed','duplicate','uncertain'].includes(item.status)){
   const button=document.createElement('button');button.className='result-action';
   const repairOnly=item.status==='failed'&&item.retryable===false;
   button.textContent=item.status==='uncertain'?'核对结果':item.status==='duplicate'?'确认仍要登记':repairOnly?'返回修正':'重试';
   button.disabled=batch.running;
   button.onclick=safe(async()=>{
    if(repairOnly)return restoreUnfinished(batch);
    const next=await call('retry',{batchId:batch.id,itemId:item.id,allowDuplicate:item.status==='duplicate'});await showBatch(next,{open:true});
   });outcome.append(button);
   if(item.code==='AUTH' || item.code==='AUTHENTICATION' || item.code==='UNAUTHORIZED' || /登录|认证/.test(item.error||'')){
    const repair=document.createElement('button');repair.className='result-action';repair.textContent='重新连接';repair.disabled=batch.running;repair.onclick=safe(async()=>{close();repairJiraConnection=true;await navigate('settings');});outcome.append(repair);
   }
  }
  drawer.querySelector('.result-rows').append(row);
 }
 if(drawerDesiredOpen&&!drawer.open)drawer.showModal();
 if(page==='daily')setSubmissionButton(snapshot.state.drafts.filter(row=>row.source!=='批量填报'));
 if(page==='batch')setSubmissionButton(noteRecords);
}
window.workbench.onUpdate(batch=>{
 rememberBatch(batch);
 if(batch.id===activeBatch)showBatch(batch).catch(error=>toast(error.message));
});
setInterval(async()=>{
 if(!activeBatch)return;
 try{const batch=await call('getBatch',{id:activeBatch});if(batch?.running)await showBatch(batch);}catch{}
},1200);


/** The dialog keeps the affected work visible; a remote failure leaves it open for the user to retry. */
function confirmDeleteRecord(row,renderHistory){
 const dialog=document.createElement('dialog');dialog.className='delete-record-dialog';dialog.setAttribute('aria-labelledby','deleteRecordTitle');
 dialog.innerHTML='<header><h2 id="deleteRecordTitle">删除填报记录？</h2><button type="button" data-close aria-label="关闭删除确认">×</button></header><p>'+(row.worklogId?'将同时删除本条填报记录及 JIRA 工时，删除后无法恢复。':'将删除本条填报记录及对应草稿。')+'</p><div class="delete-record-summary"><strong>'+escapeText(row.title)+'</strong><span>'+escapeText(row.day||'待定日期')+' · '+row.hours+' h</span><span>'+escapeText(row.targetKey||row.issue||'未关联工单')+'</span></div><p class="delete-record-error" role="alert" hidden></p><footer><button type="button" data-cancel>取消</button><button type="button" class="delete-record-confirm">删除</button></footer>';
 document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-cancel]').focus();
 let pending=false;
 const close=()=>{if(!pending)dialog.remove();};
 dialog.querySelector('[data-close]').onclick=close;dialog.querySelector('[data-cancel]').onclick=close;dialog.oncancel=event=>{if(pending)event.preventDefault();else dialog.remove();};
 dialog.querySelector('.delete-record-confirm').onclick=async()=>{
  pending=true;const error=dialog.querySelector('.delete-record-error');error.hidden=true;
  const buttons=dialog.querySelectorAll('button');buttons.forEach(button=>button.disabled=true);dialog.querySelector('.delete-record-confirm').textContent='删除中…';
  try{
   await call('deleteRecord',{id:row.id});noteRecords=noteRecords.filter(record=>record.id!==row.id);
   await refresh();renderHistory();dialog.remove();toast(row.worklogId?'填报记录及 JIRA 工时已删除':'填报记录已删除');
  }catch(reason){error.textContent=reason.message;error.hidden=false;}
  finally{pending=false;buttons.forEach(button=>button.disabled=false);dialog.querySelector('.delete-record-confirm').textContent='删除';}
 };
}

function history(){
 // The result drawer can refresh this page; keep the visible filters as the source of the new query.
 let period=$('[data-period][aria-pressed=true]')?.dataset.period||'week',query=$('input#search').value.trim().toLowerCase(),status=$('#resultStatus').value,range=[$('#rangeFrom').value,$('#rangeTo').value];
 const render=()=>{
  const all=snapshot.state.history || [];
  let from,to;
  if(period==='custom')[from,to]=range;
  else {
   const date=new Date(snapshot.today+'T12:00:00'),offset=(date.getDay()+6)%7+(period==='last'?7:0);
   from=new Date(date.getTime()-offset*86400000).toLocaleDateString('sv-SE');
   to=new Date(new Date(from+'T12:00:00').getTime()+6*86400000).toLocaleDateString('sv-SE');
  }
  $('#periodText').textContent=(from||'开始')+' 至 '+(to||'结束');
  const rows=all.filter(row=>(!from||row.day>=from)&&(!to||row.day<=to)).filter(row=>(status==='all'||row.status===status)&&(!query||(row.title+' '+row.issue+' '+row.targetKey).toLowerCase().includes(query)));
  $('#recordCount').textContent=rows.length+' 条';$('#recordList').replaceChildren();
  for(const day of [...new Set(rows.map(row=>row.day))].sort().reverse()){
   const total=all.filter(row=>row.day===day && row.status==='success').reduce((sum,row)=>sum+Number(row.hours||0),0);
   const failed=all.filter(row=>row.day===day && row.status!=='success').length;
   const heading=document.createElement('div');heading.className='day-heading';heading.innerHTML='<strong class="day-label">'+labelDay(day)+'</strong><span class="day-stat"><span class="registered">当日已登记 '+total+' h</span>'+(failed?'<span class="failed-stat">'+failed+' 条失败</span>':'')+'</span>';$('#recordList').append(heading);
   for(const row of rows.filter(row=>row.day===day)){
    const canRetry=row.status!=='success'&&row.retryable&&row.batchId;
    const item=document.createElement('div');item.className='record-row';item.innerHTML='<div class="record-main"><div class="item-title">'+escapeText(row.title)+'</div><div class="item-meta">'+escapeText((row.targetKey || row.issue)+(row.issueTitle?' - '+row.issueTitle:''))+' · '+escapeText(row.subtaskTitle?row.task+' → '+row.subtaskTitle:row.task)+' · '+escapeText(row.type)+'</div>'+(row.error?'<p class="failure-reason">'+escapeText(row.error)+'</p>':'')+'</div><span class="source">'+escapeText(row.source || '按天填报')+'</span><span class="hours">'+row.hours+' h</span><div class="status"><span class="status-label '+(row.status==='success'?'success':'failed')+'">'+(row.status==='success'?'已登记':'失败')+'</span></div><div class="action"><button data-edit-record '+(row.status==='uncertain'?'disabled title="请先核对提交结果"':'')+'>编辑</button><button data-record-open>'+(canRetry?'重试':'查看工单')+'</button><button class="delete-record" data-delete-record '+(row.status==='uncertain'?'disabled title="请先核对提交结果"':'')+'>删除</button></div>';
    item.querySelector('[data-delete-record]').onclick=()=>confirmDeleteRecord(row,render);
    item.querySelector('[data-edit-record]').onclick=()=>openRecordEditor({row,today:snapshot.today,hourOptions,save:async changes=>{
     const updated=await call('updateRecord',{id:row.id,changes});
     noteRecords=noteRecords.map(record=>record.id===row.id?{...record,title:updated.title,day:updated.day,hours:updated.hours}:record);
     await refresh();render();toast(row.worklogId?'填报记录及 JIRA 工时已更新':'填报记录已更新');
    }});
    item.querySelector('[data-record-open]').onclick=safe(async()=>{
     if(canRetry){
      activeBatch=row.batchId;
      await showBatch(await call('retry',{batchId:row.batchId,itemId:row.id}),{open:true});
      await refresh();render();return;
     }
     await call('openIssue',{key:row.targetKey||row.issue});
    });$('#recordList').append(item);
   }
  }
  if(!rows.length)$('#recordList').innerHTML='<div class="empty-state">该日期范围没有工作台填报记录</div>';
 };
 document.querySelectorAll('[data-period]').forEach(button=>button.onclick=()=>{
  period=button.dataset.period;document.querySelectorAll('[data-period]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));
  $('#rangePopover').hidden=period!=='custom';if(period!=='custom')render();
 });
 $('#applyRange').onclick=()=>{
  range=[$('#rangeFrom').value,$('#rangeTo').value];
  if(!range[0] || !range[1] || range[0]>range[1]){$('#rangeError').textContent='请选择有效的开始和结束日期';return;}
  $('#rangePopover').hidden=true;render();
 };
 $('input#search').oninput=event=>{query=event.target.value.trim().toLowerCase();render();};
 $('#resultStatus').onchange=event=>{status=event.target.value;render();};render();
}
async function settings(){
 const {mountSettings}=await import('./settings-view.js');
 await mountSettings({host:main,call,refresh,getSnapshot:()=>snapshot,toast,editJira:repairJiraConnection,onResume:activeBatch?async()=>{const batch=await call('getBatch',{id:activeBatch});await navigate(batchSource(batch).startsWith('batch/')?'batch':'daily');await showBatch(batch,{open:true});}:null});
 repairJiraConnection=false;
}
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('.record-editor[open]'))document.querySelector('.hours-popover')?.remove();});
navigate('todo').catch(error=>{main.innerHTML='<header class="topbar"><h1>JIRA工时填报</h1></header><p>'+escapeText(error.message)+'</p><button id="retryLoad">重新打开</button>';$('#retryLoad').onclick=()=>location.reload();});

// 启动直接展示待办；宿主连接摘要仍读取既有本机配置，不阻塞待办入口。
refresh().catch(()=>{document.querySelectorAll('.status-value').forEach((row,index)=>{if(index<2)updateConnection(row,'暂不可用',false);});});

window.addEventListener('keydown',event=>{if(event.key==='Escape')closeBatchPopup();});
document.addEventListener('pointerdown',event=>{if(batchPopup&&!batchPopup.contains(event.target)&&!batchPopupAnchor?.contains(event.target))closeBatchPopup();});
document.addEventListener('scroll',event=>{if(batchPopup&&!batchPopup.contains(event.target))closeBatchPopup();},true);
