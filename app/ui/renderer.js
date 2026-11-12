import {mountTodo} from './todo/view.js';
import {templates} from './templates.js';
import {typeMapping,monthlyTasks,requirementTasks,taskForType,validateRecord,isCompletedItem} from '../worklogs.js';
import {attachIssueClear,refreshIssueClear} from './issue-input.js';
import {openRecordEditor} from './record-editor.js';

const $ = selector=>document.querySelector(selector);
const main=$('#content');
const defaultCommonTypes=['需求分析','需求分析评审','概要设计','规格撰写','4.0应用开发','日常综合'];
let snapshot, page='todo', types=Object.keys(typeMapping), selectedType='需求分析', issueSelection=null, selectedFile=null, noteRecords=[], step=1, activeBatch=null;
const localToday=()=>new Date().toLocaleDateString('sv-SE');
const escapeText=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labelDay=day=>day ? new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'}) : '待定日期';
let toastTimer;
const pageViews = new Map();
let disposeTodo;
const submissionBatches = new Map();
const releasedBatches = new Set();
let drawerDesiredOpen = false;
let repairJiraConnection = false;
let importKind='file', importSource=null, filePreview=null, pasteResult=null, importBusy=false, previewFailed=false;
const importEdits=new Map();
// 无效标题不能写入正式草稿，页面内按已确认来源和正文指纹保留，重读时优先于旧有效稿。
function rememberImportEdits(){
 if(importSource&&noteRecords.length)importEdits.set(importSource.id+'\n'+importSource.contentHash,structuredClone(noteRecords));
}
function restoreImportEdits(source,records){
 const edits=new Map((importEdits.get(source.id+'\n'+source.contentHash)||[]).map(row=>[row.id,row]));
 return records.map(row=>edits.get(row.id)||row);
}
const importName=()=>importKind==='paste'?'手动粘贴内容':selectedFile?.name||'';

function sourceKey(flow=page,fileId=selectedFile?.id) {
 return flow==='batch' ? 'batch/'+(importSource?.id||fileId||'') : 'daily';
}
function batchSource(batch) {
 const item=batch.items?.[0];
 return item?.source==='批量填报' ? 'batch/'+(item.importSourceId||item.sourceFile||'') : 'daily';
}
function rememberBatch(batch) {
 if(!batch || batch.returnedToDrafts || releasedBatches.has(batch.id))return;
 // 主进程以确切记录编号关联的旧批次也可能挂在新来源键下，更新这些已知关联。
 for(const [key,known] of submissionBatches)if(known.id===batch.id)submissionBatches.set(key,batch);
 submissionBatches.set(batchSource(batch),batch);
}
function currentBatch() {
 return submissionBatches.get(sourceKey());
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
 document.querySelector('.date-popover')?.remove();document.querySelector('.hours-popover')?.remove();document.querySelector('.issue-results')?.remove();
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
  }});
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

function calendar(anchor,value,onSelect,{min='',max=localToday()}={}){
 document.querySelector('.date-popover')?.remove();
 const popup=document.createElement('div');popup.className='date-popover';popup.setAttribute('role','dialog');popup.setAttribute('aria-label','选择工作日期');
 let shown=new Date((value||max)+'T12:00:00');
 const render=()=>{
  popup.replaceChildren();
  const head=document.createElement('div');head.className='date-head';
  head.innerHTML='<button aria-label="上个月">‹</button><strong>'+shown.getFullYear()+'年'+(shown.getMonth()+1)+'月</strong><button aria-label="下个月">›</button>';
  head.firstChild.onclick=()=>{shown=new Date(shown.getFullYear(),shown.getMonth()-1,1);render();};
  head.lastChild.onclick=()=>{shown=new Date(shown.getFullYear(),shown.getMonth()+1,1);render();};popup.append(head);
  const grid=document.createElement('div');grid.className='calendar-grid';
  for(const weekday of ['一','二','三','四','五','六','日']){const span=document.createElement('span');span.textContent=weekday;grid.append(span);}
  const first=(new Date(shown.getFullYear(),shown.getMonth(),1).getDay()+6)%7;
  for(let i=0;i<first;i++)grid.append(document.createElement('span'));
  for(let day=1;day<=new Date(shown.getFullYear(),shown.getMonth()+1,0).getDate();day++){
   const key=shown.getFullYear()+'-'+String(shown.getMonth()+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
   const button=document.createElement('button');button.textContent=day;button.disabled=key>max || Boolean(min && key<min);button.classList.toggle('current',key===value);button.setAttribute('aria-label',key);
   button.onclick=()=>{onSelect(key);popup.remove();};grid.append(button);
  }
  popup.append(grid);
 };
 render();(anchor.closest('dialog')||document.body).append(popup);
 const rect=anchor.getBoundingClientRect();popup.style.left=Math.min(rect.left,innerWidth-280)+'px';popup.style.top=Math.min(rect.bottom+6,innerHeight-popup.offsetHeight-8)+'px';
 const close=event=>{if(!popup.contains(event.target)&&event.target!==anchor&&!anchor.contains(event.target)){popup.remove();document.removeEventListener('pointerdown',close);}};
 setTimeout(()=>document.addEventListener('pointerdown',close),0);
 popup.onkeydown=event=>{if(event.key==='Escape')popup.remove();};
}
function hourOptions(input,onValue){
 document.querySelector('.hours-popover')?.remove();
 const popup=document.createElement('div');popup.className='hours-popover';
 for(const value of [.5,1,1.5,2,2.5,3]){
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
function renderTask(){
 const input=$('#issue'),optional=Boolean(requirementTasks[selectedType]),day=$('#date').value;
 if(input.readOnly&&optional)input.value='';
 const task=taskForType(selectedType,Boolean(issueSelection?.key || optional&&input.value.trim())),monthly=monthlyTasks.includes(task);
 const binding=snapshot.state.bindings?.[day.slice(0,7)];
 const wasReadonly=input.readOnly;input.readOnly=monthly&&!optional;
 $('#issueLabel').textContent=optional?'关联需求／综合工时单':monthly?'关联综合工时单':'关联需求工单';
 input.placeholder=optional?'输入需求单号或标题，留空使用月度工单':'输入工单号或标题关键词';
 if(monthly&&!optional)input.value=binding?binding.key+' · '+binding.title:day.slice(0,7)+' 产品综合工时管理';
 else if(issueSelection?.key)input.value=issueSelection.key+(issueSelection.title?' · '+issueSelection.title:'');
 else if(wasReadonly)input.value='';
 $('#monthlyStatus').hidden=!monthly;
 $('#monthlyStatus').textContent=binding?(optional?'使用月度工单 · ':'已创建 · ')+binding.key+' · '+binding.title:(optional?'未指定需求单时使用 ':'')+day.slice(0,7)+' 综合工时单 · 提交时查找或创建';
 $('#subtasks').innerHTML=(monthly?monthlyTasks:['需求调研及分析','概要设计及评审','规格撰写及评审','开发协同及验收','UI设计']).map(name=>{
 const exists=issueSelection?.subtasks?.some(row=>(row.fields?.summary || row.title)===name);
 return '<button type="button" class="chip '+(name===task?'selected':'')+'" '+(name!==task?'disabled':'')+'><span>'+escapeText(name)+'</span><span class="task-status">'+(exists?'已创建':'未创建 · 提交时自动创建')+'</span></button>';
 }).join('');
 refreshIssueClear(input);
}
function issueSearch(input,chosen,onQuery=()=>{}){
 const refreshClear=attachIssueClear(input);
 let timer,revision=0;input.oninput=()=>{
  const current=++revision,query=input.value.trim();
  onQuery();clearTimeout(timer);document.querySelectorAll('.issue-results').forEach(list=>list.remove());
  if(!query)return;
  timer=setTimeout(safe(async()=>{
   const response=await call('searchIssues',{query});const rows=response.issues || response;
   // A completed selection or a cleared query must not be replaced by an older search response.
   if(current!==revision)return;
   const list=document.createElement('div');list.className=page==='batch'?'issue-results issue-candidates row-popover':'issue-results';
   for(const row of rows){const button=document.createElement('button');button.type='button';if(page==='batch'){button.className='candidate';button.innerHTML=escapeText(row.key)+'<span>'+escapeText(row.title||row.fields?.summary||'')+'</span>';}else button.textContent=row.key+' · '+(row.title || row.fields?.summary || '');button.onclick=safe(async()=>{
    const selection=++revision;clearTimeout(timer);list.remove();
    const detail=await call('getIssue',{key:row.key});if(selection!==revision)return;
    chosen({...row,...detail,subtasks:detail.subtasks || detail.fields?.subtasks || []});input.value=page==='batch'?row.key:button.textContent;refreshClear();closeBatchPopup();
   });list.append(button);}
   if(!rows.length)list.textContent='未找到可访问的工单';
   if(page==='batch')placeBatchPopup(input,list);else input.parentElement.append(list);
  }),280);
 };
}
function daily(){
 $('#date').value=snapshot.today;$('#dateLabel').textContent=labelDay(snapshot.today);
 const shortcuts=[snapshot.today,new Date(new Date(snapshot.today+'T12:00:00').getTime()-86400000).toLocaleDateString('sv-SE')];
 document.querySelectorAll('[data-date]').forEach((button,index)=>button.onclick=()=>{setDay(shortcuts[index]);});
 const setDay=day=>{$('#date').value=day;$('#dateLabel').textContent=labelDay(day);document.querySelectorAll('[data-date]').forEach((button,index)=>button.classList.toggle('selected',day===shortcuts[index]));renderTask();};
 $('#dateButton').onclick=()=>calendar($('#dateButton'),$('#date').value,setDay,{max:snapshot.today});
 const syncHours=()=>document.querySelectorAll('[data-hours]').forEach(button=>button.classList.toggle('selected',Number($('#hours').value)===Number(button.dataset.hours)));
 document.querySelectorAll('[data-hours]').forEach(button=>button.onclick=()=>{$('#hours').value=button.dataset.hours;syncHours();});
 $('#hours').addEventListener('input',syncHours);
 for(const field of ['date','description','hours','issue']){
  $('#'+field).addEventListener('input',()=>{$('#'+field+'-error').hidden=true;$('#'+field).removeAttribute('aria-invalid');$('#entryError').textContent='';});
 }
 $('#configureTypes').onclick=()=>typeDialog(true);
 $('[data-open-batch]').onclick=safe(()=>navigate('batch'));
 issueSearch($('#issue'),row=>{issueSelection=row;renderTask();},()=>{issueSelection=null;renderTask();});
 $('#entry').onsubmit=safe(async event=>{
  event.preventDefault();const task=taskForType(selectedType,Boolean(issueSelection?.key)),monthly=monthlyTasks.includes(task);
  const record={id:$('#entry').dataset.editId || undefined,day:$('#date').value,title:$('#description').value,hours:$('#hours').value,type:selectedType,task,issue:monthly?'':issueSelection?.key,issueTitle:monthly?'':issueSelection?.title,source:'按天填报'};
  try{
   if(requirementTasks[selectedType]&&$('#issue').value.trim()&&!issueSelection?.key)throw Object.assign(new Error('请选择候选需求单，或清空后使用月度工单'),{field:'issue'});
   validateRecord(record,{today:snapshot.today});if(!types.includes(record.type))throw new Error('请选择当前可用的工时类型');
  }
  catch(error){
   const field={day:'date',title:'description',hours:'hours',issue:'issue',type:'issue',task:'issue'}[error.field]||'issue';
   $('#'+field+'-error').textContent=error.message;$('#'+field+'-error').hidden=false;
   $('#'+field).setAttribute('aria-invalid','true');$('#'+field).focus();$('#entryError').textContent=error.message;return;
  }
  await call('saveDraft',{record});delete $('#entry').dataset.editId;$('#description').value='';$('#entryError').textContent='';$('#description').focus();await refresh();renderQueue();
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
    $('#entry').dataset.editId=row.id;$('#date').value=row.day;$('#dateLabel').textContent=labelDay(row.day);$('#description').value=row.title;$('#hours').value=row.hours;selectedType=row.type;
    // Returned monthly rows can contain the resolved parent key; only a requirement task represents a user-picked requirement.
    issueSelection=row.issue&&!monthlyTasks.includes(row.task)?{key:row.issue,title:row.issueTitle}:null;
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
 batch$('#read').textContent=failed?'重试读取':'开始解析';
 batch$('#read').disabled=importBusy||(importKind==='paste'?!batch$('#pasteInput').value.trim():!filePreview&&!failed);
 batch$('#read').hidden=importBusy;batch$('#readProgress').hidden=!importBusy;batch$('#sourceHint').hidden=importBusy;
 batch$('#sourceHint').textContent=importKind==='file'&&!selectedFile?'请选择一份文档':'缺失的日期和工时，解析后手动补齐';
 for(const node of batchRoot().querySelectorAll('.week-file,#localTab,#pasteTab,#changeDirectory,#pasteInput'))node.disabled=importBusy;
 batch$('#step2').disabled=importBusy||!noteRecords.length;batch$('#step3').disabled=importBusy||!noteRecords.length;
}
function chooseImportKind(kind){
 rememberImportEdits();importKind=kind;clearReadFeedback();
 for(const [value,id] of [['file','local'],['paste','paste']]){
  batch$('#'+id+'Tab').classList.toggle('selected',kind===value);batch$('#'+id+'Tab').setAttribute('aria-selected',String(kind===value));
  batch$('#'+id+'Source').hidden=kind!==value;
 }
 importSource=kind==='file'?filePreview?.source:pasteResult?.source;
 noteRecords=importSource?restoreImportEdits(importSource,snapshot.state.drafts.filter(row=>row.importSourceId===importSource.id)):[];
 updateImportControls();if(kind==='paste')batch$('#pasteInput').focus();
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
 batch$('#step1').onclick=()=>showStep(1);batch$('#step2').onclick=()=>showStep(2);batch$('#step3').onclick=()=>showStep(3);
 batch$('#back').onclick=()=>{rememberImportEdits();showStep(1);};batch$('#editAgain').onclick=()=>showStep(2);batch$('#nextReview').onclick=()=>showStep(3);
 batch$('#submit').onclick=safe(()=>submitRecords(noteRecords));
 batch$('#localTab').onclick=()=>chooseImportKind('file');batch$('#pasteTab').onclick=()=>chooseImportKind('paste');
 batch$('#pasteInput').oninput=()=>{rememberImportEdits();pasteResult=null;importSource=null;noteRecords=[];clearReadFeedback();batch$('#pasteCount').textContent=batch$('#pasteInput').value.length+' 字';updateImportControls();};
 batch$('#read').onclick=safe(async()=>{
  if(previewFailed&&importKind==='file'){await previewDocument(selectedFile);return;}
  if(importKind==='paste'&&!batch$('#pasteInput').value.trim()){importFeedback('请先粘贴或输入工作记录。');batch$('#pasteInput').setAttribute('aria-invalid','true');batch$('#pasteInput').focus();updateImportControls();return;}
  rememberImportEdits();clearReadFeedback();importBusy=true;updateImportControls();
  batch$('#readStage').textContent='Agent 正在识别工时记录';batch$('#readSource').textContent=importName();batch$('#readCount').textContent='';batch$('#readMeter').removeAttribute('value');
  try{
   const parsed=await call('parseImport',importKind==='file'?{kind:'file',sourceId:filePreview.source.id}:{kind:'paste',content:batch$('#pasteInput').value});
   await refresh();importSource=parsed.source;if(importKind==='paste')pasteResult=parsed;
   noteRecords=restoreImportEdits(parsed.source,parsed.records);rememberImportEdits();
   if(parsed.batchId){const batch=await call('getBatch',{id:parsed.batchId});rememberBatch(batch);submissionBatches.set('batch/'+parsed.source.id,batch);}
   if(!noteRecords.length){importFeedback(parsed.outcome==='registered'?'当前内容中的工时已全部登记。可查看填报记录。':'未识别到工时记录。请检查当前内容，或更换文档后再次解析。',{empty:true,batchId:parsed.batchId});return;}
   batch$('#agentNotice').hidden=false;batch$('#agentNotice').textContent='已按原文识别工时记录，请核对并补齐标记的字段后提交。';showStep(2);
  }catch(error){importFeedback(error.message,{settings:['DESTINATION_UNVERIFIED','AGENT_UNCONFIGURED','CLI_NOT_FOUND','MODEL_CONFIGURATION','MODEL_KEY_MISSING'].includes(error.code)});}
  finally{importBusy=false;updateImportControls();}
 });
 batch$('#previewBody').innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');
 await loadImportDirectory();chooseImportKind(importKind);showStep(1);
}
function showStep(next){
 step=next;if(page!=='batch'||pageViews.has('batch'))return;
 closeBatchPopup();
 for(const [number,id] of [[1,'choosePanel'],[2,'confirmPanel'],[3,'reviewPanel']]){$('#'+id).hidden=next!==number;$('#step'+number).classList.toggle('active',next===number);if(number>1)$('#step'+number).disabled=!noteRecords.length;}
 if(next===2)renderBatchRows();
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
 for(const value of [.5,1,1.5,2,2.5,3]){
  const button=document.createElement('button');button.type='button';button.textContent=value+' h';button.setAttribute('aria-pressed',String(Number(row.hours)===value));
  button.onclick=()=>{row.hours=value;row.touched=true;rememberImportEdits();safe(async()=>{if(row.title.trim())await call('saveDraft',{record:row});closeBatchPopup();renderBatchRows();})();};panel.append(button);
 }
 placeBatchPopup(anchor,panel);
}

function renderBatchRows(){
 $('#agentNotice').hidden=noteRecords.every(row=>{try{validateRecord(row,{today:snapshot.today});return true;}catch{return false;}});
 $('#sourceName').textContent=importName();$('#recordCount').textContent=noteRecords.length+' 条记录';$('#editRows').replaceChildren();
 const groups=[...new Set(noteRecords.map(row=>row.day || ''))].sort((a,b)=>(a||'z').localeCompare(b||'z'));
 for(const day of groups){
  const records=noteRecords.filter(row=>(row.day||'')===day);const header=document.createElement('tr');header.className='date-group';header.dataset.day=day;
  header.innerHTML='<td colspan="7"><strong>'+labelDay(day)+'</strong><span class="group-detail">'+records.length+' 条 · 已填 '+records.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h</span></td>';$('#editRows').append(header);
  for(const row of records){
   const tr=document.createElement('tr');tr.dataset.row=row.id;const index=noteRecords.indexOf(row);
   tr.innerHTML='<td class="number-cell">'+String(index+1).padStart(2,'0')+'</td><td><input data-field="title" aria-label="工作事项" value="'+escapeText(row.title)+'"></td><td><button class="date-picker" data-day aria-label="选择工作日期"><svg><use href="#calendar"/></svg><span>'+(row.day?labelDay(row.day):'选择日期')+'</span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></td><td><input data-field="hours" aria-label="工时" type="number" step="0.5" min="0.5" value="'+escapeText(row.hours)+'" placeholder="待填"></td><td><select data-field="type" aria-label="工时类型"><option value="">选择工时类型</option>'+types.map(type=>'<option '+(row.type===type?'selected':'')+'>'+escapeText(type)+'</option>').join('')+'</select></td><td><div style="position:relative"><input aria-label="关联工单" data-issue value="'+escapeText(row.issue || row.issueQuery)+'" placeholder="输入工单号"></div></td><td><span data-task>'+escapeText(row.task || '选择工时类型')+'</span></td>';
   const save=async()=>{row.touched=true;rememberImportEdits();if(row.title.trim())await call('saveDraft',{record:row});};
   const markMissing=()=>{
    const invalidHours=row.hours===''||row.hours==null?'原文未提供':Number(row.hours)<.5?'至少0.5h':Number(row.hours)*2%1!==0?'0.5h倍数':'';
    for(const [selector,hint] of [['[data-field=title]',row.title.trim()?'':'请填写工作事项'],['[data-field=hours]',invalidHours],['[data-field=type]',row.type?'':'请选择工时类型'],['[data-day]',!row.day?'原文未提供':row.day>snapshot.today?'请选择今天及以前':'']]){
     const input=tr.querySelector(selector);
     // 已填但不符合0.5h步长的值保留原文，以红边区别于仍待补的空值。
     const invalid=selector==='[data-field=hours]'&&Boolean(hint)&&row.hours!==''&&row.hours!=null;
     input.classList.toggle('missing',Boolean(hint)&&!invalid);input.classList.toggle('invalid',invalid);
     let label=input.nextElementSibling;if(!label?.classList.contains('cell-hint')){label=document.createElement('div');label.className='cell-hint';input.after(label);}label.textContent=hint;
    }
    tr.querySelector('[data-issue]').classList.toggle('missing',!row.issue&&!monthlyTasks.includes(row.task));
   };
   markMissing();

   tr.querySelectorAll('[data-field]').forEach(input=>input.onchange=safe(async()=>{
    const hadRequirement=Boolean(row.issue || row.issueQuery)&&!monthlyTasks.includes(row.task);row[input.dataset.field]=input.value;
    if(input.dataset.field==='type'){
     row.task=taskForType(row.type,hadRequirement);
     if(monthlyTasks.includes(row.task)){row.issue='';row.issueTitle='';row.issueQuery='';}
     tr.querySelector('[data-task]').textContent=row.task || '选择工时类型';
     const issueInput=tr.querySelector('[data-issue]'),optional=Boolean(requirementTasks[row.type]);
     issueInput.readOnly=monthlyTasks.includes(row.task)&&!optional;
     issueInput.value=issueInput.readOnly?(row.day?.slice(0,7)||'对应月份')+' 综合工时单':row.issue || row.issueQuery || '';
     issueInput.placeholder=optional?'留空使用月度工单':'输入工单号';
     refreshIssueClear(issueInput);
    }
    await save();markMissing();updateBatchTotals();
   }));
   tr.querySelector('[data-day]').onclick=()=>openBatchCalendar(tr.querySelector('[data-day]'),row);
   const hours=tr.querySelector('[data-field=hours]');hours.addEventListener('blur',updateBatchTotals);hours.onfocus=()=>setTimeout(()=>{if(document.activeElement===hours&&document.contains(hours))openBatchHours(hours,row);},0);hours.onclick=()=>openBatchHours(hours,row);
   const input=tr.querySelector('[data-issue]');
   if(row.issueTitle){const title=document.createElement('div');title.className='issue-title';title.textContent=row.issueTitle;input.parentElement.append(title);}
   const optional=Boolean(requirementTasks[row.type]);
   if(monthlyTasks.includes(row.task)){
    input.readOnly=!optional;input.value=optional?'':(row.day?.slice(0,7)||'对应月份')+' 综合工时单';
   }
   if(optional)input.placeholder='留空使用月度工单';
   // Rows may switch from a monthly type to a requirement type without being rebuilt.
   issueSearch(input,issue=>{
    row.issue=issue.key;row.issueTitle=issue.title;row.issueQuery='';row.task=taskForType(row.type,true);tr.querySelector('[data-task]').textContent=row.task;
    markMissing();safe(save)();updateBatchTotals();if(step===3)reviewBatch();
   },()=>{
    // Keep an unfinished query when the user returns from confirmation, so it remains selectable or clearable.
    row.issue='';row.issueTitle='';row.issueQuery=input.value;row.task=taskForType(row.type,Boolean(input.value.trim()));tr.querySelector('[data-task]').textContent=row.task || '选择工时类型';
    markMissing();safe(save)();updateBatchTotals();
   });
   $('#editRows').append(tr);
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
  const hints=[...new Set(rows.flatMap(row=>[!row.title.trim()&&'事项',!row.day&&'日期',(row.hours===''||row.hours==null||Number(row.hours)<.5||Number(row.hours)*2%1!==0)&&'工时',!row.type&&'类型',!row.issue&&!monthlyTasks.includes(row.task)&&'工单'].filter(Boolean)))];
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
  clearReadFeedback();$('#pasteInput').value='';$('#pasteCount').textContent='0 字';
  $('#previewName').textContent='';$('#previewBody').innerHTML=emptySource('选择一份文档预览','仅展示文字内容，不更改原文件。');
  for(const [kind,id] of [['file','local'],['paste','paste']]){
   $('#'+id+'Tab').classList.toggle('selected',kind===importKind);$('#'+id+'Tab').setAttribute('aria-selected',String(kind===importKind));$('#'+id+'Source').hidden=kind!==importKind;
  }
  document.querySelectorAll('.week-file').forEach(button=>{button.classList.remove('selected');button.setAttribute('aria-pressed','false');});
  updateImportControls();showStep(2);
 }
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
  footer.innerHTML='<a class="result-history" href="#">查看填报记录</a><button class="result-continue" data-return '+(unfinished?'data-edit':'')+'>'+(unfinished?'返回填报':'继续填报')+'</button>';
  footer.querySelector('.result-history').onclick=safe(async event=>{event.preventDefault();close();await navigate('history');});
  footer.querySelector('[data-return]').onclick=safe(async()=>{
   if(unfinished)return restoreUnfinished(batch);
   close();await refresh();if(page==='daily')renderQueue();if(page==='history')history();if(page==='batch')reviewBatch();
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
    const item=document.createElement('div');item.className='record-row';item.innerHTML='<div class="record-main"><div class="item-title">'+escapeText(row.title)+'</div><div class="item-meta">'+escapeText((row.targetKey || row.issue)+(row.issueTitle?' - '+row.issueTitle:''))+' · '+escapeText(row.task)+' · '+escapeText(row.type)+'</div>'+(row.error?'<p class="failure-reason">'+escapeText(row.error)+'</p>':'')+'</div><span class="source">'+escapeText(row.source || '按天填报')+'</span><span class="hours">'+row.hours+' h</span><div class="status"><span class="status-label '+(row.status==='success'?'success':'failed')+'">'+(row.status==='success'?'已登记':'失败')+'</span></div><div class="action"><button data-edit-record '+(row.status==='uncertain'?'disabled title="请先核对提交结果"':'')+'>编辑</button><button data-record-open>'+(canRetry?'重试':'查看工单')+'</button><button class="delete-record" data-delete-record '+(row.status==='uncertain'?'disabled title="请先核对提交结果"':'')+'>删除</button></div>';
    item.querySelector('[data-delete-record]').onclick=()=>confirmDeleteRecord(row,render);
    item.querySelector('[data-edit-record]').onclick=()=>openRecordEditor({row,today:snapshot.today,calendar,hourOptions,save:async changes=>{
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
// The editor owns Escape even after a calendar rerender moves focus to body; its cancel handler must see the open picker first.
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('.record-editor[open]')){document.querySelector('.date-popover')?.remove();document.querySelector('.hours-popover')?.remove();}});
navigate('todo').catch(error=>{main.innerHTML='<header class="topbar"><h1>JIRA工时填报</h1></header><p>'+escapeText(error.message)+'</p><button id="retryLoad">重新打开</button>';$('#retryLoad').onclick=()=>location.reload();});

// 启动直接展示待办；宿主连接摘要仍读取既有本机配置，不阻塞待办入口。
refresh().catch(()=>{document.querySelectorAll('.status-value').forEach((row,index)=>{if(index<2)updateConnection(row,'暂不可用',false);});});

window.addEventListener('keydown',event=>{if(event.key==='Escape')closeBatchPopup();});
document.addEventListener('pointerdown',event=>{if(batchPopup&&!batchPopup.contains(event.target)&&!batchPopupAnchor?.contains(event.target))closeBatchPopup();});
document.addEventListener('scroll',event=>{if(batchPopup&&!batchPopup.contains(event.target))closeBatchPopup();},true);
