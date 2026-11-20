const dayKey=date=>date.toLocaleDateString('sv-SE');
export const labelDay=day=>day?new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'}):'待定日期';

/** 两处表单共用同一份标记，ID 用于各自的标签和既有表单联动。 */
export function workDateMarkup(buttonId,labelId){
 return `<button type="button" id="${buttonId}" class="date-picker" aria-label="选择工作日期" aria-haspopup="dialog"><svg aria-hidden="true"><use href="#calendar"/></svg><span id="${labelId}">选择日期</span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><button type="button" class="date-shortcut" data-date>今天</button><button type="button" class="date-shortcut" data-date>昨天</button>`;
}

let closePicker;
export function closeCalendar() { closePicker?.(); }

/** 挂在发起选择的原生弹窗内，确保弹窗中的日历可点击并先于弹窗处理 Escape。 */
export function calendar(anchor,value,onSelect,{max=''}={}){
 closeCalendar();
 const popup=document.createElement('div');popup.className='date-popover';popup.setAttribute('role','dialog');popup.setAttribute('aria-label','选择工作日期');
 const controller=new AbortController(),{signal}=controller;
 closePicker=()=>{controller.abort();popup.remove();anchor.setAttribute('aria-expanded','false');closePicker=null;};
 let shown=new Date((value||max||dayKey(new Date()))+'T12:00:00');
 const render=()=>{
  popup.replaceChildren();
  const head=document.createElement('div');head.className='date-head';
  const year=shown.getFullYear(),month=shown.getMonth();
  head.innerHTML='<button type="button" aria-label="上个月">‹</button><strong>'+year+'年'+(month+1)+'月</strong><button type="button" aria-label="下个月">›</button>';
  head.firstChild.onclick=()=>{shown=new Date(year,month-1,1);render();popup.querySelector('.date-head button').focus();};
  head.lastChild.onclick=()=>{shown=new Date(year,month+1,1);render();popup.querySelector('.date-head button:last-child').focus();};
  popup.append(head);
  const grid=document.createElement('div');grid.className='calendar-grid';
  for(const weekday of ['一','二','三','四','五','六','日']){const span=document.createElement('span');span.textContent=weekday;grid.append(span);}
  const first=(new Date(year,month,1).getDay()+6)%7;
  for(let i=0;i<first;i++)grid.append(document.createElement('span'));
  for(let day=1;day<=new Date(year,month+1,0).getDate();day++){
   const key=dayKey(new Date(year,month,day,12));
   const button=document.createElement('button');button.type='button';button.textContent=day;button.disabled=Boolean(max&&key>max);button.classList.toggle('current',key===value);button.setAttribute('aria-label',key);
   button.onclick=()=>{closeCalendar();onSelect(key);anchor.focus();};grid.append(button);
  }
  popup.append(grid);
 };
 render();(anchor.closest('dialog')||document.body).append(popup);
 anchor.setAttribute('aria-expanded','true');
 const rect=anchor.getBoundingClientRect();popup.style.left=Math.min(rect.left,innerWidth-popup.offsetWidth-8)+'px';popup.style.top=Math.min(rect.bottom+6,innerHeight-popup.offsetHeight-8)+'px';
 document.addEventListener('pointerdown',event=>{if(!popup.contains(event.target)&&!anchor.contains(event.target))closeCalendar();},{signal});
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCalendar();anchor.focus();}
 },{capture:true,signal});
 (popup.querySelector('.current:not(:disabled)')||popup.querySelector('button')).focus();
}

/** 工时填报和待办共用日期按钮与快捷选项；调用方决定能否选择未来日期。 */
export function bindWorkDate(row,{value,today,max=today,onSelect}){
 const anchor=row.querySelector('.date-picker'),label=anchor.querySelector('span');
 const shortcuts=[...row.querySelectorAll('[data-date]')];
 const yesterday=new Date(today+'T12:00:00');yesterday.setDate(yesterday.getDate()-1);
 const dates=[today,dayKey(yesterday)];
 const paint=day=>{
  value=day;
  label.textContent=labelDay(value);
  shortcuts.forEach((button,index)=>button.setAttribute('aria-pressed',String(button.classList.toggle('selected',value===dates[index]))));
 };
 const select=day=>{paint(day);onSelect(day);};
 anchor.setAttribute('aria-expanded','false');
 anchor.onclick=()=>anchor.getAttribute('aria-expanded')==='true'?closeCalendar():calendar(anchor,value,select,{max});
 shortcuts.forEach((button,index)=>button.onclick=()=>{closeCalendar();select(dates[index]);});
 paint(value);
 return paint;
}
