const escapeText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

/** The caller owns persistence; the editor closes only after that save has confirmed the remote and local result. */
export function openRecordEditor({row,today,calendar,hourOptions,save}) {
 const dialog=document.createElement('dialog');dialog.className='record-editor';dialog.setAttribute('aria-labelledby','recordEditorTitle');
 dialog.innerHTML='<header class="record-editor-head"><h2 id="recordEditorTitle">编辑填报记录</h2><button type="button" data-close aria-label="关闭编辑">×</button></header><form><label class="record-editor-field"><span>工作事项</span><input name="title" aria-label="工作事项" autocomplete="off" required></label><div class="record-editor-fields"><div class="record-editor-field"><span id="recordEditorDayLabel">工作日期</span><button type="button" name="day" class="date-picker" aria-label="选择工作日期"><svg aria-hidden="true"><use href="#calendar"/></svg><span data-day-label></span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div><label class="record-editor-field"><span>工时 / h</span><input name="hours" aria-label="工时" type="number" min="0.5" step="0.5" required></label></div><dl class="record-editor-destination"><div><dt>关联工单</dt><dd>'+escapeText((row.issue||row.targetKey||'未关联工单')+(row.issueTitle?' · '+row.issueTitle:''))+'</dd></div><div><dt>工时类型</dt><dd>'+escapeText(row.type)+'</dd></div><div><dt>子任务</dt><dd>'+escapeText(row.task)+'</dd></div></dl><p class="record-editor-error" role="alert" hidden></p><footer><button type="button" data-cancel>取消</button><button type="submit" class="record-editor-save">保存</button></footer></form>';
 const form=dialog.querySelector('form'),title=form.elements.title,hours=form.elements.hours,dateButton=form.elements.day,error=dialog.querySelector('.record-editor-error');
 let day=row.day,pending=false;
 title.value=row.title;hours.value=row.hours;
 const renderDate=()=>{dialog.querySelector('[data-day-label]').textContent=day?day+' '+new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{weekday:'short'}):'选择日期';};
 const clearError=()=>{error.hidden=true;error.textContent='';form.querySelectorAll('[aria-invalid]').forEach(input=>input.removeAttribute('aria-invalid'));};
 const removePopovers=()=>dialog.querySelectorAll('.date-popover,.hours-popover').forEach(popup=>popup.remove());
 const close=()=>{if(!pending){removePopovers();dialog.remove();}};
 dateButton.onclick=()=>{dialog.querySelector('.hours-popover')?.remove();calendar(dateButton,day,value=>{day=value;renderDate();clearError();},{max:today});};
 hours.onfocus=()=>{dialog.querySelector('.date-popover')?.remove();hourOptions(hours,value=>{hours.value=value;clearError();});};
 form.oninput=clearError;renderDate();
 dialog.querySelector('[data-close]').onclick=close;dialog.querySelector('[data-cancel]').onclick=close;
 dialog.oncancel=event=>{
  if(pending)event.preventDefault();
  else if(dialog.querySelector('.date-popover,.hours-popover')){event.preventDefault();removePopovers();}
  else close();
 };
 // Escape dismisses a picker first; an in-progress save must keep its visible context until the result arrives.
 dialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&(pending||dialog.querySelector('.date-popover,.hours-popover'))){event.preventDefault();event.stopPropagation();if(!pending)removePopovers();}},true);
 form.onsubmit=async event=>{
  event.preventDefault();if(pending)return;
  const changes={title:title.value,day,hours:hours.value};clearError();removePopovers();pending=true;
  dialog.querySelectorAll('input,button').forEach(control=>control.disabled=true);dialog.querySelector('.record-editor-save').textContent='保存中…';
  try{await save(changes);removePopovers();dialog.remove();}
  catch(reason){error.textContent=reason.message;error.hidden=false;const input=form.elements[reason.field];if(input)input.setAttribute('aria-invalid','true');}
  finally{pending=false;dialog.querySelectorAll('input,button').forEach(control=>control.disabled=false);dialog.querySelector('.record-editor-save').textContent='保存';}
 };
 document.body.append(dialog);dialog.showModal();title.focus();return dialog;
}
