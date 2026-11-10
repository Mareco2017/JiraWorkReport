import {templates} from './templates.js';
import {typeMapping,monthlyTasks,requirementTasks,taskForType,validateRecord,isCompletedItem} from '../worklogs.js';
import {attachIssueClear,refreshIssueClear} from './issue-input.js';
import {openRecordEditor} from './record-editor.js';

const $ = selector=>document.querySelector(selector);
const main=$('#content');
const defaultCommonTypes=['需求分析','需求分析评审','概要设计','规格撰写','4.0应用开发','日常综合'];
let snapshot, page='daily', types=Object.keys(typeMapping), selectedType='需求分析', issueSelection=null, selectedFile=null, noteRecords=[], step=1, activeBatch=null;
const localToday=()=>new Date().toLocaleDateString('sv-SE');
const escapeText=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labelDay=day=>day ? new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'}) : '待定日期';
let toastTimer;
const pageViews = new Map();
const submissionBatches = new Map();
const releasedBatches = new Set();
let drawerDesiredOpen = false;
let repairJiraConnection = false;

function sourceKey(flow=page,fileId=selectedFile?.id) {
 return flow==='batch' ? 'batch/'+(fileId||'') : 'daily';
}
function batchSource(batch) {
 const item=batch.items?.[0];
 return item?.source==='批量填报' ? sourceKey('batch',item.sourceFile) : 'daily';
}
function rememberBatch(batch) {
 if(!batch || batch.returnedToDrafts || releasedBatches.has(batch.id))return;
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
async function refresh(){
 snapshot=await call('initialize');
 const liveTypes=snapshot.config.jira?.typeNames;
 types=Array.isArray(liveTypes)?Object.keys(typeMapping).filter(name=>liveTypes.includes(name)):Object.keys(typeMapping);
 for(const batch of snapshot.state.batches || [])rememberBatch(batch);
 const rows=document.querySelectorAll('.status-value');
 rows[0].innerHTML='<i></i>'+escapeText(snapshot.config.jira ? snapshot.config.jira.username : '未配置');
 rows[1].innerHTML='<i></i>'+escapeText(snapshot.config.agent?.engine || '未配置');
 rows[0].className='status-value '+(snapshot.config.jira?'status-good':'status-idle');
 rows[1].className='status-value '+(snapshot.config.agent?'status-good':'status-idle');
 const dailyNav=$('[data-page=daily]');
 let draftBadge=dailyNav.querySelector('.badge');
 if(!draftBadge){draftBadge=document.createElement('span');draftBadge.className='badge';dailyNav.append(draftBadge);}
 const dailyCount=snapshot.state.drafts.filter(row=>row.source!=='批量填报').length;
 draftBadge.hidden=!dailyCount;draftBadge.textContent=dailyCount;
 const todayRows=(snapshot.state.drafts || []).filter(row=>row.day===snapshot.today);
 rows[2].textContent=todayRows.length+' 条 · '+todayRows.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h';
}
const safe = action=>async event=>{try{await action(event);}catch(error){toast(error.message);}};
document.querySelectorAll('[data-page]').forEach(button=>button.onclick=safe(()=>navigate(button.dataset.page)));
async function navigate(next){
 if(['daily','batch'].includes(page) && main.children.length){
  const view=document.createDocumentFragment();
  while(main.firstChild)view.append(main.firstChild);
  pageViews.set(page,view);
 }
 document.querySelector('.date-popover')?.remove();document.querySelector('.hours-popover')?.remove();document.querySelector('.issue-results')?.remove();
 page=next;await refresh();
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
   const list=document.createElement('div');list.className='issue-results';
   for(const row of rows){const button=document.createElement('button');button.type='button';button.textContent=row.key+' · '+(row.title || row.fields?.summary || '');button.onclick=safe(async()=>{
    const selection=++revision;clearTimeout(timer);list.remove();
    const detail=await call('getIssue',{key:row.key});if(selection!==revision)return;
    chosen({...row,...detail,subtasks:detail.subtasks || detail.fields?.subtasks || []});input.value=button.textContent;refreshClear();
   });list.append(button);}
   if(!rows.length)list.textContent='未找到可访问的工单';
   input.parentElement.append(list);
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

function clearReadFeedback() {
 $('#readError').hidden=true;$('#readError').textContent='';$('#read').textContent='读取并解析';
}
function showReadFailure(file,error) {
 const detail={ENOENT:'文件已移动或不存在',EACCES:'没有读取这个文件的权限',EPERM:'没有读取这个文件的权限',INVALID_FILE:'文件不在所选文件夹中'}[error.code] || error.message;
 $('#previewBody').textContent='';
 $('#readError').textContent='「'+file.name+'」读取失败：'+detail+'。请检查文件后重试。';
 $('#readError').hidden=false;$('#read').textContent='重试读取';
}

async function batch(){
 $('#step1').onclick=()=>showStep(1);$('#step2').onclick=()=>showStep(2);$('#step3').onclick=()=>showStep(3);
 $('#back').onclick=()=>showStep(1);$('#editAgain').onclick=()=>showStep(2);$('#nextReview').onclick=()=>showStep(3);
 $('#submit').onclick=safe(()=>submitRecords(noteRecords));
 $('#read').onclick=safe(async()=>{
  if(!selectedFile)throw new Error('请选择一份周文件');
  clearReadFeedback();
  $('#readProgress').hidden=false;$('#readStage').textContent='正在读取周文件';$('#readSource').textContent=selectedFile.name;$('#read').hidden=true;$('#read').disabled=true;
  $('#readCount').textContent='';$('#readMeter').removeAttribute('value');
  document.querySelectorAll('.week-file').forEach(button=>button.disabled=true);$('#step2').disabled=true;$('#step3').disabled=true;
  try{
   const file=selectedFile;
   let parsed;
   try{parsed=await call('parseNote',{file:file.id});}
   catch(error){if(page==='batch'&&selectedFile?.id===file.id)showReadFailure(file,error);return;}
   if(page!=='batch'||selectedFile?.id!==file.id)return;
   await refresh();
   const existing=new Map(snapshot.state.drafts.filter(row=>row.sourceFile===file.id).map(row=>[row.id,row]));
   const registered=new Set(snapshot.state.history.filter(row=>row.status==='success').map(row=>row.id));
   noteRecords=(parsed.records || []).filter(row=>!registered.has(row.id)).map(row=>existing.get(row.id)||({...row,source:'批量填报',sourceFile:file.id}));
   $('#readStage').textContent='正在解析工时';$('#readMeter').max=noteRecords.length||1;
   for(const [index,row] of noteRecords.entries()){
    await call('saveDraft',{record:row});$('#readCount').textContent=(index+1)+' / '+noteRecords.length+' 条';$('#readMeter').value=index+1;
   }
   if(!noteRecords.length){$('#readError').hidden=false;$('#readError').textContent=(parsed.warnings||[{message:'未找到可识别的工时记录'}]).map(value=>value.message || value).join('；');return;}
   $('#agentNotice').hidden=true;
   $('#readStage').textContent='正在生成工时建议';$('#readCount').textContent='共 '+noteRecords.length+' 条';$('#readMeter').removeAttribute('value');
   try{
    const suggestions=await call('suggest',{records:noteRecords.map(row=>({id:row.id,title:row.title}))});
    for(const suggestion of suggestions){const row=noteRecords.find(row=>row.id===suggestion.id);if(row && !row.touched){row.type=suggestion.type;row.task=suggestion.task;await call('saveDraft',{record:row});}}
    if(page==='batch'&&selectedFile?.id===file.id){$('#readCount').textContent=noteRecords.length+' / '+noteRecords.length+' 条';$('#readMeter').value=noteRecords.length;}
   }catch(error){if(page==='batch'&&$('#agentNotice')){$('#agentNotice').hidden=false;$('#agentNotice').textContent=error.message;}}
   if(page==='batch'&&selectedFile?.id===file.id)showStep(2);
  }finally{if($('#read')){
   $('#readProgress').hidden=true;$('#read').hidden=false;$('#read').disabled=false;document.querySelectorAll('.week-file').forEach(button=>button.disabled=false);
   $('#step2').disabled=!noteRecords.length;$('#step3').disabled=!noteRecords.length;
  }}
 });
 let files;
 try{files=await call('listNotes');}
 catch(error){
  $('#weekFiles').innerHTML='<p class="empty">请选择周文件所在文件夹</p><button id="chooseDirectory" class="primary">选择文件夹</button>';
  $('#chooseDirectory').onclick=safe(async()=>{if(await call('chooseNotes'))await batch();});return;
 }
 $('#fileListTitle').nextElementSibling.textContent=files.length+' 份';
 $('#weekFiles').replaceChildren();
 for(const file of files){
  const button=document.createElement('button');button.className='week-file';button.innerHTML='<svg aria-hidden="true"><use href="#batch"/></svg><strong>'+escapeText(file.name)+'</strong><span class="file-range">Markdown 周文件</span>';
  button.onclick=safe(async()=>{
   selectedFile=file;clearReadFeedback();document.querySelectorAll('.week-file').forEach(el=>el.classList.toggle('selected',el===button));
   $('#previewName').textContent=file.name;$('#previewBody').textContent='';
   noteRecords=snapshot.state.drafts.filter(row=>row.sourceFile===file.id);
   $('#step2').disabled=!noteRecords.length;$('#step3').disabled=!noteRecords.length;
   try{
    const read=await call('readNote',{file:file.id});
    if(page==='batch'&&selectedFile?.id===file.id)$('#previewBody').textContent=typeof read==='string'?read:read.content;
   }catch(error){if(page==='batch'&&selectedFile?.id===file.id)showReadFailure(file,error);}
  });$('#weekFiles').append(button);
 }
 const choose=document.createElement('button');choose.textContent='更换文件夹';choose.className='quiet-link';choose.onclick=safe(async()=>{if(await call('chooseNotes'))await batch();});$('#weekFiles').append(choose);
 if(selectedFile && files.some(file=>file.id===selectedFile.id))await $('#weekFiles').children[files.findIndex(file=>file.id===selectedFile.id)].onclick();
 showStep(noteRecords.length?step:1);
}
function showStep(next){
 step=next;
 for(const [number,id] of [[1,'choosePanel'],[2,'confirmPanel'],[3,'reviewPanel']]){$('#'+id).hidden=next!==number;$('#step'+number).classList.toggle('active',next===number);if(number>1)$('#step'+number).disabled=!noteRecords.length;}
 if(next===2)renderBatchRows();
 if(next===3)reviewBatch();
}
function renderBatchRows(){
 $('#sourceName').textContent=selectedFile?.name || '';$('#recordCount').textContent=noteRecords.length+' 条记录';$('#editRows').replaceChildren();
 const groups=[...new Set(noteRecords.map(row=>row.day || ''))].sort((a,b)=>(a||'z').localeCompare(b||'z'));
 for(const day of groups){
  const records=noteRecords.filter(row=>(row.day||'')===day);const header=document.createElement('tr');header.className='date-group';header.dataset.day=day;
  header.innerHTML='<td colspan="7"><strong>'+labelDay(day)+'</strong>　'+records.length+' 条　已填 '+records.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h</td>';$('#editRows').append(header);
  for(const row of records){
   const tr=document.createElement('tr');const index=noteRecords.indexOf(row);
   tr.innerHTML='<td>'+String(index+1).padStart(2,'0')+'</td><td><input data-field="title" aria-label="工作事项" value="'+escapeText(row.title)+'"></td><td><button class="date-picker" data-day aria-label="选择工作日期"><svg><use href="#calendar"/></svg><span>'+labelDay(row.day)+'</span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></td><td><input data-field="hours" aria-label="工时" type="number" step="0.5" min="0.5" value="'+escapeText(row.hours)+'" placeholder="待填"></td><td><select data-field="type" aria-label="工时类型"><option value="">选择工时类型</option>'+types.map(type=>'<option '+(row.type===type?'selected':'')+'>'+escapeText(type)+'</option>').join('')+'</select></td><td><div style="position:relative"><input aria-label="关联工单" data-issue value="'+escapeText(row.issue || row.issueQuery)+'" placeholder="输入工单号"></div></td><td><span data-task>'+escapeText(row.task || '选择工时类型')+'</span></td>';
   const save=async()=>{row.touched=true;await call('saveDraft',{record:row});};
   const markMissing=()=>{
    tr.querySelector('[data-field=hours]').classList.toggle('missing',row.hours==='' || row.hours==null);
    tr.querySelector('[data-field=type]').classList.toggle('missing',!row.type);
    tr.querySelector('[data-issue]').classList.toggle('missing',!row.issue && !monthlyTasks.includes(row.task));
    tr.querySelector('[data-day]').classList.toggle('missing',!row.day);
   };
   if(row.hours==='' || row.hours==null){
    const hint=document.createElement('div');hint.className='cell-hint';hint.textContent='原文未提供';tr.querySelector('[data-field=hours]').after(hint);
   }
   markMissing();

   tr.querySelectorAll('[data-field]').forEach(input=>input.onchange=safe(async()=>{
    const hadRequirement=Boolean(row.issue || row.issueQuery)&&!monthlyTasks.includes(row.task);row[input.dataset.field]=input.value;
    if(input.dataset.field==='type'){
     row.task=taskForType(row.type,hadRequirement);
     if(monthlyTasks.includes(row.task)){row.issue='';row.issueTitle='';row.issueQuery='';}
     tr.querySelector('[data-task]').textContent=row.task || '';
     const issueInput=tr.querySelector('[data-issue]'),optional=Boolean(requirementTasks[row.type]);
     issueInput.readOnly=monthlyTasks.includes(row.task)&&!optional;
     issueInput.value=issueInput.readOnly?(row.day?.slice(0,7)||'对应月份')+' 综合工时单':row.issue || row.issueQuery || '';
     issueInput.placeholder=optional?'留空使用月度工单':'输入工单号';
     refreshIssueClear(issueInput);
    }
    await save();markMissing();updateBatchTotals();
   }));
   tr.querySelector('[data-day]').onclick=()=>calendar(tr.querySelector('[data-day]'),row.day,day=>{row.day=day;safe(async()=>{await save();renderBatchRows();})()},sourceWeekRange());
   const hours=tr.querySelector('[data-field=hours]');hours.addEventListener('blur',updateBatchTotals);hours.onfocus=()=>hourOptions(hours,value=>{hours.value=value;hours.dispatchEvent(new Event('change'));});
   const input=tr.querySelector('[data-issue]');
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
    row.issue='';row.issueTitle='';row.issueQuery=input.value;row.task=taskForType(row.type,Boolean(input.value.trim()));tr.querySelector('[data-task]').textContent=row.task || '';
    markMissing();safe(save)();updateBatchTotals();
   });
   $('#editRows').append(tr);
  }
 }
 updateBatchTotals();
}
function reviewBatch(){
 $('#reviewFile').textContent=selectedFile?.name || '';
 $('#weekTotal').textContent=noteRecords.filter(row=>row.day).reduce((sum,row)=>sum+Number(row.hours||0),0)+' h';
 const incomplete=noteRecords.filter(row=>{try{validateRecord(row,{today:snapshot.today});return !types.includes(row.type);}catch{return true;}});
 $('#weekPending').textContent=incomplete.length?'待补 '+incomplete.length+' 条':'';
 $('#weekRange').textContent='';
 $('#reviewRows').innerHTML=[...new Set(noteRecords.map(row=>row.day||''))].sort().map(day=>{
 const rows=noteRecords.filter(row=>(row.day||'')===day);return '<tr><td>'+labelDay(day)+'</td><td>'+rows.length+' 条</td><td>'+rows.reduce((sum,row)=>sum+Number(row.hours||0),0)+' h</td><td>'+rows.filter(row=>incomplete.includes(row)).length+' 处</td></tr>';
 }).join('');
 $('#reviewStatus').textContent=incomplete.length?'请返回填报补齐后提交':'已可提交';
 setSubmissionButton(noteRecords);if(incomplete.length&&!currentBatch())$('#submit').disabled=true;
}
// A chosen source week constrains row calendars; an undated file gets its range from the first explicit work date.
function sourceWeekRange() {
 const known=selectedFile?.weekStart || noteRecords.find(row=>row.day)?.day;
 if(!known)return {max:snapshot.today};
 const monday=new Date(known+'T12:00:00');monday.setDate(monday.getDate()-(monday.getDay()+6)%7);
 const sunday=new Date(monday);sunday.setDate(sunday.getDate()+6);
 const min=monday.toLocaleDateString('sv-SE'),end=sunday.toLocaleDateString('sv-SE');
 return {min,max:end<snapshot.today?end:snapshot.today};
}
function updateBatchTotals() {
 if(page!=='batch'||!$('#editRows'))return;
 for(const header of document.querySelectorAll('#editRows .date-group')){
  const rows=noteRecords.filter(row=>(row.day||'')===header.dataset.day);
  header.firstElementChild.innerHTML='<strong>'+escapeText(labelDay(header.dataset.day))+'</strong>　'+rows.length+' 条　已填 '+rows.reduce((sum,row)=>sum+(Number(row.hours)||0),0)+' h';
 }
 const pending=noteRecords.filter(row=>{try{validateRecord(row,{today:snapshot.today});return false;}catch{return true;}}).length;
 $('#summary').textContent='已填 '+noteRecords.reduce((sum,row)=>sum+(Number(row.hours)||0),0)+' h'+(pending?'　待补 '+pending+' 条':'');
}
async function submitRecords(records){
 const existing=currentBatch();
 const oldIds=new Set(existing?.items.filter(item=>item.status!=='deleted').map(item=>item.id)||[]);
 if(existing && (existing.running || existing.items.some(item=>!isCompletedItem(item)) || !records.some(row=>!oldIds.has(row.id)))){
  activeBatch=existing.id;await showBatch(await call('getBatch',{id:existing.id}),{open:true});return;
 }
 const valid=records.filter(row=>{try{validateRecord(row,{today:snapshot.today});return types.includes(row.type);}catch{return false;}});
 if(!valid.length)throw new Error('请先补齐待提交事项');
 const batch=await call('startSubmission',{records:valid});activeBatch=batch.id;rememberBatch(batch);await showBatch(batch,{open:true});
 if(page==='daily')setSubmissionButton(snapshot.state.drafts.filter(row=>row.source!=='批量填报'));
 if(page==='batch')setSubmissionButton(noteRecords);
}
async function restoreUnfinished(batch) {
 await call('returnToDrafts',{batchId:batch.id});
 releasedBatches.add(batch.id);submissionBatches.delete(batchSource(batch));
 drawerDesiredOpen=false;$('#submissionView').close();activeBatch=null;
 const origin=batchSource(batch).startsWith('batch/')?'batch':'daily';
 await navigate(origin);
 if(origin==='batch'){
  const ids=new Set(batch.items.filter(item=>!isCompletedItem(item)).map(item=>item.id));
  noteRecords=snapshot.state.drafts.filter(row=>ids.has(row.id));
  const source=noteRecords[0]?.sourceFile;
  if(source)selectedFile={...(selectedFile||{}),id:source,name:selectedFile?.id===source?selectedFile.name:source};
  showStep(2);
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
navigate('daily').catch(error=>{main.innerHTML='<header class="topbar"><h1>JIRA工时填报</h1></header><p>'+escapeText(error.message)+'</p><button id="retryLoad">重新打开</button>';$('#retryLoad').onclick=()=>location.reload();});
