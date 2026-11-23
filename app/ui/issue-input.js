const controls=new WeakMap();
const ISSUE_KEY=/^[A-Z][A-Z0-9_]*-\d+$/;
// 全应用同一时刻只保留一个工单候选列表；页面切换与控件关闭共用 openIssueList 这一个出口。
let issueListSeq=0,openIssueList=null;

/** All work-order pickers clear through their normal input handler, keeping the selected issue and dependent task in sync. */
export function attachIssueClear(input) {
 const existing=controls.get(input);if(existing)return existing;
 const wrapper=document.createElement('div');wrapper.className='issue-input-wrap';
 input.before(wrapper);wrapper.append(input);
 const button=document.createElement('button');button.type='button';button.className='issue-input-clear';button.setAttribute('aria-label','清空工单');
 button.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6m0-6-6 6"/></svg>';
 const refresh=()=>{button.hidden=!input.value||input.readOnly||input.disabled;};
 button.onclick=()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();refresh();};
 wrapper.append(button);input.addEventListener('input',refresh);controls.set(input,refresh);refresh();return refresh;
}

/** Programmatic selection changes a value without emitting input, because input would discard the selection again. */
export function refreshIssueClear(input) {controls.get(input)?.();}

/** 关闭当前打开的候选列表；与 work-date.js 的 closeCalendar 同构，页面切换时统一调用。 */
export function closeIssueSearch() {openIssueList?.close();}

/**
 * 工单输入框的候选选择控件：查询、候选列表、回车/方向键/Esc 与 ARIA 都由这里维护。
 * 页面只注入查询与详情、选中结果和布局差异（列表 class、挂载位置、行渲染、写回文本）；
 * 控件不读写页面状态、错误提示或业务选择结果，关闭时只通过 onClose 通知页面收起自己的浮层。
 */
export function bindIssueSearch(input,{
 search,load,onSelect,onQuery=()=>{},onError=error=>console.error(error),
 listClass='issue-results',place=(anchor,list)=>anchor.parentElement.append(list),
 renderRow=(button,row)=>{button.textContent=row.key+' · '+(row.title || row.fields?.summary || '');},
 valueFor=(row,button)=>button?button.textContent:row.key+' · '+(row.title || row.fields?.summary || ''),
 onClose=()=>{}
}){
 const refreshClear=attachIssueClear(input);
 let timer,revision=0,list=null,active=-1;
 const options=()=>list?.isConnected?[...list.querySelectorAll('button')]:[];
 const closeList=()=>{
  if(list){list.remove();if(openIssueList?.node===list)openIssueList=null;}
  list=null;active=-1;
  input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
  onClose();
 };
 const highlight=index=>{
  const rows=options();if(!rows.length)return;
  active=(index+rows.length)%rows.length;
  rows.forEach((button,position)=>{button.classList.toggle('active',position===active);button.setAttribute('aria-selected',String(position===active));});
  input.setAttribute('aria-activedescendant',rows[active].id);
  rows[active].scrollIntoView({block:'nearest'});
 };
 // 选中统一走这里：鼠标点击、方向键回车、完整工单号自动识别共用一条路径。
 const pick=async(row,button)=>{
  const selection=++revision;clearTimeout(timer);closeList();
  let detail;
  try{detail=await load(row.key);}catch(error){if(selection===revision)onError(error);return false;}
  if(selection!==revision)return false;
  onSelect({...row,...detail,subtasks:detail.subtasks || detail.fields?.subtasks || []});
  input.value=valueFor(row,button);input.dataset.picked=input.value;
  refreshClear();
  return true;
 };
 const paint=rows=>{
  openIssueList?.close();
  list=document.createElement('div');
  list.id='issue-candidates-'+(++issueListSeq);
  list.className=listClass;
  list.setAttribute('role','listbox');list.setAttribute('aria-label','工单候选');
  for(const [index,row] of rows.entries()){
   const button=document.createElement('button');button.type='button';button.id=list.id+'-'+index;
   button.setAttribute('role','option');button.setAttribute('aria-selected','false');
   renderRow(button,row);
   button.onclick=()=>pick(row,button).catch(onError);
   list.append(button);
  }
  if(!rows.length)list.textContent='未找到可访问的工单';
  input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','true');
  place(input,list);
  openIssueList={node:list,close:closeList};
  if(rows.length)highlight(0);
 };
 const runSearch=async({immediate=false,autoPick=false}={})=>{
  const current=++revision,query=input.value.trim();
  onQuery();clearTimeout(timer);closeList();closeIssueSearch();
  if(!query)return;
  const execute=async()=>{
   try{
    let rows=await search(query);
    // 直接输入完整工单号时，即使它不是故事类型（任务/子任务等）也应能选中。
    if(!rows.length&&ISSUE_KEY.test(query)){
     try{const detail=await load(query);if(current!==revision)return;rows=[detail];}catch{}
    }
    // A completed selection or a cleared query must not be replaced by an older search response.
    if(current!==revision)return;
    // 只有用户明确按回车、且输入就是完整工单号、又只命中一条时才直接选中；边输入边查询绝不改写输入内容。
    if(autoPick&&rows.length===1&&ISSUE_KEY.test(query)){await pick(rows[0]);return;}
    paint(rows);
   }catch(error){onError(error);}
  };
  if(immediate)await execute();else timer=setTimeout(execute,280);
 };
 input.oninput=()=>{
  // 选中后输入框里是"KEY · 标题"，没有编辑就不应再搜一次，避免误报未找到。
  if(input.dataset.picked&&input.value===input.dataset.picked)return;
  delete input.dataset.picked;
  runSearch();
 };
 // 用赋值而不是 addEventListener：批量页切换类型时会复用同一个 input 节点，重复绑定会叠加多次查询。
 input.onkeydown=event=>{
  if(event.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'){if(list){event.preventDefault();event.stopPropagation();closeList();}return;}
  if(!['Enter','ArrowDown','ArrowUp'].includes(event.key))return;
  // 关键：工单查询框里的回车只做查询/选中，永远不触发整张表单的隐式提交（那会把红边打到工单字段上）。
  event.preventDefault();event.stopPropagation();
  if(input.readOnly||input.disabled)return;
  const rows=options();
  if(rows.length){
   if(event.key==='ArrowDown')return highlight(active+1);
   if(event.key==='ArrowUp')return highlight(active-1);
   rows[active>=0?active:0].click();
   return;
  }
  if(event.key!=='Enter')return;
  if(input.dataset.picked&&input.value===input.dataset.picked)return;
  if(!input.value.trim())return;
  runSearch({immediate:true,autoPick:true});
 };
}
