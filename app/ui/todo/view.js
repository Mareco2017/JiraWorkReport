import {template} from './template.js';
import {matchesQuery as matchTodo,compareTodos,dayKey,monthCells} from './query.js';

// 每次挂载拥有独立的查看状态，释放后异步保存回包不会操作宿主其他页面。
export function mountTodo(root,{call,onCount=()=>{}}){
root.classList.add('todo-product');root.innerHTML=template;
let disposed=false;const controller=new AbortController();
const statuses = ['待处理', '进行中', '已完成'];
const $ = selector => root.querySelector(selector);
let data = {groups: [], todos: []};
let currentGroup = '';
let view = 'list';
let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let collapsed = false;
let query = {status: '', priority: '', dateMode: 'any', from: '', to: '', keyword: '', sort: 'created-desc'};
// 只记住已生效的查询偏好；个人事项仍由主进程独立文件保存。
const preferenceKey = 'jira-personal-todo-view-preferences';
function restorePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [field, selectId] of Object.entries({status:'statusFilter',sort:'sortRule',priority:'priorityFilter',dateMode:'dateMode'})) {
      if ([...$('#'+selectId).options].some(option=>option.value===saved[field])) query[field]=saved[field];
    }
    for (const field of ['from','to']) {
      const value=saved[field];
      if (value==='' || (typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value)) query[field]=value;
    }
  } catch { /* 无法读取偏好时仍可使用默认查询，不影响事项文件。 */ }
}
function rememberPreferences() {
  try { localStorage.setItem(preferenceKey,JSON.stringify(Object.fromEntries(['status','sort','priority','dateMode','from','to'].map(field=>[field,query[field]])))); }
  catch { showToast('查看条件未能保存，下次进入可能恢复默认条件。'); }
}
restorePreferences();

let selectedId = null;
let scene = 'loading';

let editingId = null;
let editingGroupId = null;
let editingCommentId = null;
let pendingDelete = null;
let toastTimer;
let loadingTimer;
let drawerReturnFocus = null;
let searchExpanded = false;
let composerExpanded = false;
let groupOrderDraft = [];
let datePanelAnchor = null;
const commentDrafts = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#todo-i-' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function showToast(message) {
  $('#todoToast').textContent = message;
  $('#todoToast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#todoToast').hidden = true; }, 4000);
}

function dateLabel(value) {
  return new Date(value + 'T12:00:00').toLocaleDateString('zh-CN', {month: 'long', day: 'numeric'});
}

function timeLabel(value) {
  return new Date(value).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
}

function statusClass(status) {
  return status === '进行中' ? 'progress' : status === '已完成' ? 'done' : 'pending';
}

function groupName(id) {
  return data.groups.find(group => group.id === id)?.name || '未分组';
}

function setError(target, message) {
  target.textContent = message;
  target.hidden = !message;
}

// 主进程返回保存后的快照；离页后只完成保存，不触碰新页面。
const pending = new Set();
async function send(command, payload, errorTarget, control) {
 const key=command+':'+(payload.id||payload.todoId||'');
 if(pending.has(key))return false;
 pending.add(key);
 const buttons=control ? [control] : errorTarget?.closest('form,dialog')?.querySelectorAll('button[type=submit],#confirmDelete,#saveGroupOrder') || [];
 for(const button of buttons)button.disabled=true;
 try {
  const result=await call(command,payload);
  if(disposed)return false;
  data=result.state; onCount(data.todos.filter(todo=>todo.status!=='已完成').length);
  return result;
 } catch(error) {
  if(!disposed){if(errorTarget)setError(errorTarget,error.message);else showToast(error.message);}
  return false;
 } finally {pending.delete(key);if(!disposed)for(const button of buttons)button.disabled=false;}
}
function matchesQuery(todo){return matchTodo(todo,query,currentGroup);}
function visibleTodos(){return data.todos.filter(matchesQuery).sort((a,b)=>compareTodos(a,b,query.sort));}

function hasConditions() {
  return Boolean(query.status || query.priority || query.dateMode === 'undated' || (query.dateMode === 'range' && (query.from || query.to)) || query.keyword.trim());
}

function isInCurrentView(todo) {
  if (!matchesQuery(todo)) return false;
  return view === 'list' || !todo.dueDate || todo.dueDate.slice(0, 7) === dayKey(month).slice(0, 7);
}

function render() {
  const unavailable = scene !== 'normal';
  onCount(unavailable ? null : data.todos.filter(todo => todo.status !== '已完成').length);
  $('#currentGroupTitle').textContent = currentGroup ? groupName(currentGroup) : '全部';
  $('#currentGroupTitle').title = $('#currentGroupTitle').textContent;
  $('#groupTotal').textContent = unavailable ? '' : data.todos.filter(todo => !currentGroup || todo.groupId === currentGroup).length + ' 项';
  $('#shell').classList.toggle('groups-collapsed', collapsed);
  $('#groupSidebar').hidden = collapsed;
  $('#expandGroups').hidden = !collapsed;
  $('#listView').classList.toggle('active', view === 'list');
  $('#calendarView').classList.toggle('active', view === 'calendar');
  $('#listView').setAttribute('aria-selected', String(view === 'list'));
  $('#calendarView').setAttribute('aria-selected', String(view === 'calendar'));
  $('#statusFilter').value = query.status;
  $('#sortRule').value = query.sort;
  $('#statusLabel').textContent = $('#statusFilter').selectedOptions[0].textContent;
  $('#sortLabel').textContent = $('#sortRule').selectedOptions[0].textContent;
  $('#searchBox').hidden = !searchExpanded;
  $('#searchTrigger').hidden = searchExpanded;
  $('#searchTrigger').setAttribute('aria-expanded', String(searchExpanded));
  $('#searchTrigger').classList.toggle('has-keyword', Boolean(query.keyword.trim()));
  $('#searchTrigger .search-active-dot').hidden = !query.keyword.trim();
  const filterCount = Number(Boolean(query.priority)) + Number(query.dateMode === 'undated' || (query.dateMode === 'range' && Boolean(query.from || query.to)));
  $('#filterTrigger').classList.toggle('has-filters', filterCount > 0);
  $('#filterCount').hidden = !filterCount;
  $('#filterCount').textContent = filterCount;
  $('#clearConditions').hidden = !hasConditions();
  ['newTodo', 'addGroup', 'manageGroups', 'statusTrigger', 'sortTrigger', 'statusFilter', 'sortRule', 'filterTrigger', 'searchTrigger', 'keyword'].forEach(id => { $('#' + id).disabled = unavailable; });
  renderGroups(unavailable);
  renderContent();
  renderDetail();
  if ($('#groupManager').open) renderGroupManager();
}

function renderGroups(disabled) {
  const nav = $('#groupNav');
  nav.replaceChildren();
  [{id: '', name: '全部'}, ...data.groups].forEach(group => {
    const row = element('div', 'group-item' + (currentGroup === group.id ? ' active' : ''));
    const button = element('button', 'group-button');
    button.type = 'button';
    button.disabled = disabled;
    button.dataset.groupId = group.id;
    button.title = group.name;
    if (currentGroup === group.id) button.setAttribute('aria-current', 'true');
    button.append(element('span', 'group-name', group.name), element('span', 'group-number', disabled ? '—' : data.todos.filter(todo => !group.id || todo.groupId === group.id).length));
    button.addEventListener('click', () => { currentGroup = group.id; closeDrawer(); render(); });
    row.append(button);
    nav.append(row);
  });
}

// 管理弹窗使用尚未保存的顺序；只有“保存顺序”成功才更新侧栏和事项分组选项。
function openGroupManager() {
  groupOrderDraft = data.groups.map(group => group.id);
  setError($('#groupOrderError'), '');
  renderGroupManager();
  $('#groupManager').showModal();
}

function renderGroupManager() {
  groupOrderDraft = groupOrderDraft.filter(id => data.groups.some(group => group.id === id));
  data.groups.forEach(group => { if (!groupOrderDraft.includes(group.id)) groupOrderDraft.push(group.id); });
  const list = $('#managedGroupList');
  list.replaceChildren();
  if (!groupOrderDraft.length) list.append(element('p', 'manager-empty', '还没有自定义分组。'));
  groupOrderDraft.forEach((id, index) => {
    const group = data.groups.find(item => item.id === id);
    const row = element('div', 'managed-group-row');
    row.dataset.groupId = id;
    const name = element('span', 'managed-group-name', group.name);
    name.title = group.name;
    const up = element('button', 'managed-order-button', '↑');
    up.type = 'button'; up.disabled = index === 0;
    up.setAttribute('aria-label', '上移分组：' + group.name);
    up.addEventListener('click', () => { [groupOrderDraft[index-1], groupOrderDraft[index]] = [groupOrderDraft[index], groupOrderDraft[index-1]]; renderGroupManager(); });
    const down = element('button', 'managed-order-button', '↓');
    down.type = 'button'; down.disabled = index === groupOrderDraft.length - 1;
    down.setAttribute('aria-label', '下移分组：' + group.name);
    down.addEventListener('click', () => { [groupOrderDraft[index], groupOrderDraft[index+1]] = [groupOrderDraft[index+1], groupOrderDraft[index]]; renderGroupManager(); });
    const rename = element('button', 'managed-link', '重命名');
    rename.type = 'button'; rename.addEventListener('click', () => openGroupEditor(id));
    const remove = element('button', 'managed-link danger', '删除');
    remove.type = 'button'; remove.addEventListener('click', () => askDelete('group', id));
    row.append(name, up, down, rename, remove);
    list.append(row);
  });
}

async function saveGroupOrder() {
  if (!await send('todoGroupReorder',{ids:groupOrderDraft},$('#groupOrderError'),$('#saveGroupOrder'))) return;
  $('#groupManager').close();
  render();
  showToast('分组顺序已保存');
}

// 所有下拉都读取原选择值，统一控件外观与键盘行为，不复制查询或字段规则。
function enhanceSelect(select) {
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const trigger = element('button', 'field-select-button');
  trigger.type = 'button';
  trigger.id = select.id + 'Trigger';
  trigger.dataset.menuSelect = select.id;
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent || '选择' );
  trigger.append(element('span', '', select.selectedOptions[0].textContent), icon('chevron'));
  trigger.addEventListener('click', () => openQueryMenu(select.id, trigger.id));
  select.after(trigger);
  select.addEventListener('change', () => syncSelectButton(select));
}

function syncSelectButton(select) {
  const trigger = $('#' + select.id + 'Trigger');
  trigger.querySelector('span').textContent = select.selectedOptions[0].textContent;
}

// 浮窗对齐触发控件，空间不足时向上展开；不改变页面布局。
function placeFloating(anchor, panel) {
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth, height = panel.offsetHeight;
  panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
  panel.style.top = (rect.bottom + height + 8 < innerHeight ? rect.bottom + 5 : Math.max(8, rect.top - height - 5)) + 'px';
}

function openQueryMenu(selectId, triggerId) {
  closeQueryMenu(); closeDatePanel();
  const select = $('#' + selectId), trigger = $('#' + triggerId);
  const menu = element('div', 'query-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', trigger.getAttribute('aria-label') || '选择选项');
  [...select.options].forEach(option => {
    const button = element('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(select.value === option.value));
    const check = element('span', 'check-slot');
    if (select.value === option.value) check.append(icon('check'));
    button.append(element('span', '', option.textContent), check);
    button.addEventListener('click', () => { select.value = option.value; select.dispatchEvent(new Event('change')); closeQueryMenu(); trigger.focus(); });
    menu.append(button);
  });
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button')];
    const position = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(position + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQueryMenu(); trigger.focus(); }
  });
  trigger.setAttribute('aria-expanded', 'true');
  root.append(menu); placeFloating(trigger, menu);
  (menu.querySelector('[aria-checked=true]') || menu.querySelector('button')).focus();
}

function closeQueryMenu() {
  root.querySelector('.query-menu')?.remove();
  root.querySelectorAll('.query-select-button,.field-select-button').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

function syncDateButton(inputId) {
  const input = $('#' + inputId), trigger = $('#' + inputId + 'Trigger');
  const placeholders = {todoDue: '选择日期', dateFrom: '选择起始日期', dateTo: '选择结束日期'};
  trigger.querySelector('span').textContent = input.value ? input.value.replaceAll('-', '/') : placeholders[inputId];
}

// 复用工作台当前 row-calendar 的布局；待办允许过去与未来日期，保留清除和快捷选择。
function openDatePanel(inputId, trigger) {
  closeDatePanel(); closeQueryMenu();
  const input = $('#' + inputId);
  let calendarMonth = new Date((input.value || dayKey(new Date())) + 'T12:00:00');
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const panel = element('div', 'row-calendar');
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '选择截止日期');
  // 切换月份会替换按钮，阻止旧按钮事件被外层误判为点击日历外部。
  panel.addEventListener('click', event => event.stopPropagation());
  const choose = value => {
    input.value = value; syncDateButton(inputId); input.dispatchEvent(new Event('change'));
    closeDatePanel(); trigger.focus();
  };
  function paint() {
    panel.replaceChildren();
    const header = element('header'); header.append(element('h2', '', '选择日期'));
    const close = element('button', 'calendar-close', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭日期选择');
    close.addEventListener('click', () => { closeDatePanel(); trigger.focus(); }); header.append(close);
    const nav = element('div', 'calendar-nav');
    const prev = element('button', '', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', '上个月');
    prev.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()-1, 1); paint(); });
    const next = element('button', '', '›'); next.type = 'button'; next.setAttribute('aria-label', '下个月');
    next.addEventListener('click', () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth()+1, 1); paint(); });
    nav.append(prev, element('strong', '', calendarMonth.getFullYear()+'年'+(calendarMonth.getMonth()+1)+'月'), next);
    const weekdays = element('div', 'calendar-weekdays'); ['一','二','三','四','五','六','日'].forEach(text => weekdays.append(element('span','',text)));
    const days = element('div', 'calendar-days');
    const offset = (calendarMonth.getDay()+6)%7, count = new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,0).getDate();
    for(let i=0;i<offset;i++) days.append(element('span'));
    for(let day=1;day<=count;day++) {
      const value = dayKey(new Date(calendarMonth.getFullYear(),calendarMonth.getMonth(),day));
      const button = element('button', value===input.value?'chosen':value===dayKey(new Date())?'current':'', day);
      button.type = 'button'; button.dataset.date = value; button.setAttribute('aria-label', value);
      button.addEventListener('click', () => choose(value)); days.append(button);
    }
    const caption = element('div', 'calendar-caption'); caption.append(element('span','','可选择其他月份'),element('span','','不限日期范围'));
    const actions = element('div', 'calendar-actions');
    const today = element('button', 'shortcut', '今天'); today.type = 'button'; today.addEventListener('click', () => choose(dayKey(new Date())));
    const yesterday = element('button', 'shortcut', '昨天'); yesterday.type = 'button'; yesterday.addEventListener('click', () => { const date=new Date();date.setDate(date.getDate()-1);choose(dayKey(date)); });
    const clear = element('button', 'clear-date', '清除日期'); clear.type = 'button'; clear.addEventListener('click', () => choose(''));
    actions.append(today,yesterday,clear); panel.append(header,nav,weekdays,days,caption,actions);
    if (panel.isConnected) placeFloating(trigger,panel);
  }
  paint(); root.append(panel); placeFloating(trigger,panel);
  datePanelAnchor = trigger; trigger.setAttribute('aria-expanded','true');
  panel.addEventListener('keydown', event => { if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDatePanel();trigger.focus();} });
  (panel.querySelector('.chosen') || panel.querySelector('.current') || panel.querySelector('[data-date]')).focus();
}

function closeDatePanel() {
  root.querySelector('.row-calendar')?.remove();
  datePanelAnchor?.setAttribute('aria-expanded','false'); datePanelAnchor=null;
}

function closeSurface(id) {
  closeQueryMenu(); closeDatePanel();
  const surface = $('#' + id);
  if (surface instanceof HTMLDialogElement) surface.close();
  else surface.hidden = true;
  if (id === 'todoEditor') { $('#editorBackdrop').hidden = true; (selectedId?$('#closeDrawer'):$('#newTodo')).focus(); }
  if (id === 'filterDialog') { $('#filterTrigger').setAttribute('aria-expanded','false'); $('#filterTrigger').focus(); }
}

function stateContent(title, text, iconName) {
  const state = element('div', 'state-content');
  const symbol = element('span', 'state-icon');
  symbol.append(icon(iconName));
  state.append(symbol, element('h3', '', title), element('p', '', text));
  return state;
}

function renderContent() {
  const area = $('#contentArea');
  area.replaceChildren();
  area.setAttribute('aria-busy', String(scene === 'loading'));
  if (scene === 'loading') {
    $('#resultSummary').textContent = '';
    const state = stateContent('正在读取分组和待办', '稍后即可继续查看和处理。', 'todo');
    state.querySelector('.state-icon').replaceWith(element('span', 'spinner'));
    area.append(state);
    return;
  }
  if (scene === 'read-error') {
    $('#resultSummary').textContent = '';
    const state = stateContent('暂时无法读取待办', '读取失败不代表已保存的分组和事项被删除，请重试。', 'alert');
    const actions = element('div', 'state-actions');
    const retry = element('button', '', '重新读取');
    retry.addEventListener('click', load);
    actions.append(retry); state.append(actions); area.append(state);
    return;
  }
  const visible = visibleTodos();
  const labels = [];
  if (query.status) labels.push(query.status);
  if (query.priority) labels.push('优先级：' + (query.priority === 'unset' ? '未设置' : query.priority));
  if (query.dateMode === 'undated') labels.push('未设置日期');
  if (query.dateMode === 'range' && (query.from || query.to)) labels.push((query.from || '不限起始') + ' 至 ' + (query.to || '不限结束'));
  if (query.keyword.trim()) labels.push('“' + query.keyword.trim() + '”');
  $('#resultSummary').textContent = view==='calendar' ? '' : '共 ' + visible.length + ' 项待办' + (labels.length ? ' · ' + labels.join(' · ') : '');
  if (view === 'calendar') { renderCalendar(visible); return; }
  if (!visible.length) {
    const noMatch = hasConditions();
    const state = stateContent(noMatch ? '没有符合条件的待办' : '这里还没有待办', noMatch ? '调整筛选条件，或切换分组再看看。' : '把接下来要做的事记在这里。', 'todo');
    const actions = element('div', 'state-actions');
    if (noMatch) { const clear = element('button', '', '清除条件'); clear.addEventListener('click', clearConditions); actions.append(clear); }
    const create = element('button', '', '新建待办'); create.addEventListener('click', () => openEditor()); actions.append(create);
    state.append(actions); area.append(state);
    return;
  }
  const table = element('table', 'todo-table');
  const cols = element('colgroup');
  ['col-title', 'col-state', 'col-due', 'col-priority'].forEach(name => cols.append(element('col', name)));
  const head = element('thead'); const heading = element('tr');
  ['待办事项', '状态', '截止日期', '优先级'].forEach(text => heading.append(element('th', '', text)));
  head.append(heading);
  const body = element('tbody');
  visible.forEach(todo => {
    const row = element('tr', todo.id === selectedId ? 'selected' : '');
    row.tabIndex = 0; row.dataset.todoId = todo.id; row.setAttribute('aria-label', '查看待办：' + todo.title);
    const titleCell = element('td'); const title = element('div', 'title-cell');
    const mark = element('input', 'todo-checkbox');
    mark.type = 'checkbox'; mark.checked = todo.status === '已完成';
    mark.setAttribute('aria-label', (mark.checked ? '恢复待处理：' : '完成待办：') + todo.title);
    mark.addEventListener('click', event => event.stopPropagation());
    mark.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); });
    mark.addEventListener('change', async () => {
      const desired=mark.checked ? '已完成' : '待处理';mark.checked=todo.status==='已完成';
      await changeStatus(todo.id,desired,mark);
      mark.checked = data.todos.find(item => item.id === todo.id).status === '已完成';
    });
    const content = element('div'); content.append(element('span', 'row-title', todo.title));
    const subtitle = element('div', 'row-subtitle'); subtitle.append(element('span', '', groupName(todo.groupId)));
    if (todo.comments.length) { const count = element('span', 'comment-count'); count.append(icon('comment'), document.createTextNode(todo.comments.length)); subtitle.append(count); }
    content.append(subtitle); title.append(mark, content); titleCell.append(title);
    const status = element('td'); status.append(element('span', 'status-badge ' + statusClass(todo.status), todo.status));
    const due = element('td', todo.dueDate ? 'date-cell' : 'unset', todo.dueDate ? dateLabel(todo.dueDate) : '未设置');
    const priority = element('td'); priority.append(element('span', todo.priority ? 'priority-label ' + ({高:'high',中:'medium',低:'low'}[todo.priority]) : 'unset', todo.priority || '未设置'));
    row.append(titleCell, status, due, priority);
    row.addEventListener('click', () => openDrawer(todo.id));
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(todo.id); } });
    body.append(row);
  });
  table.append(cols, head, body); area.append(table);
}

function renderCalendar(visible) {
  const area = $('#contentArea');
  const page = element('div', 'todo-calendar-view');
  const dated = visible.filter(todo => todo.dueDate && todo.dueDate.slice(0, 7) === dayKey(month).slice(0, 7));
  const undated = visible.filter(todo => !todo.dueDate);
  const toolbar = element('div', 'calendar-toolbar');
  const heading = element('div', 'month-heading');
  const title = element('h3', 'calendar-month');
  title.append(element('span', 'month-year', month.getFullYear() + '年'), element('span', 'month-value', (month.getMonth() + 1) + '月'));
  heading.append(title, element('p', 'month-summary', '本月 ' + dated.length + ' 项待办 · 未设置日期 ' + undated.length + ' 项'));
  const nav = element('div', 'month-navigation');
  const today = element('button', 'month-today', '回到今天');
  today.type = 'button';
  today.addEventListener('click', () => { month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderContent(); });
  const arrows = element('div', 'month-arrows');
  const prev = element('button', 'month-arrow');
  prev.type = 'button'; prev.setAttribute('aria-label', '上一个月'); prev.append(icon('chevron'));
  prev.addEventListener('click', () => changeMonth(-1));
  const next = element('button', 'month-arrow');
  next.type = 'button'; next.setAttribute('aria-label', '下一个月'); next.append(icon('chevron'));
  next.addEventListener('click', () => changeMonth(1));
  arrows.append(prev, next); nav.append(today, arrows); toolbar.append(heading, nav); page.append(toolbar);
  if (!dated.length) page.append(element('p', 'calendar-empty-note', hasConditions() ? '本月没有符合条件的有日期待办，可调整条件或切换月份。' : '本月暂时没有设置截止日期的待办。'));
  const calendar = element('div', 'month-calendar');
  calendar.setAttribute('aria-label', month.getFullYear() + '年' + (month.getMonth() + 1) + '月待办日历');
  const weekdays = element('div', 'week-head');
  ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].forEach((text, index) => weekdays.append(element('span', index > 4 ? 'weekend' : '', text)));
  const grid = element('div', 'month-grid');
  const startOffset = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const calendarDates=monthCells(month);const cells=calendarDates.length;
  for (let i = 0; i < cells; i++) {
    const date = new Date(month.getFullYear(), month.getMonth(), i - startOffset + 1);
    const key = calendarDates[i], inMonth = date.getMonth() === month.getMonth(), todayDate = key === dayKey(new Date());
    const items = inMonth ? dated.filter(todo => todo.dueDate === key) : [];
    const cell = element('div', 'calendar-day' + (!inMonth ? ' outside' : '') + (todayDate ? ' today' : '') + (i % 7 > 4 ? ' weekend' : ''));
    const dayHeader = element('div', 'day-header');
    const dayNumber = element('time', 'day-number', date.getDate());
    dayNumber.dateTime = key;
    dayHeader.append(dayNumber);
    if (todayDate) dayHeader.append(element('span', 'today-label', '今天'));
    else if (items.length > 1) dayHeader.append(element('span', 'day-count', items.length + ' 项'));
    cell.append(dayHeader);
    // 日期格随实际事项自然增高，保留同一天的全部打开入口。
    items.forEach(todo => {
      const button = element('button', 'calendar-event ' + statusClass(todo.status));
      button.type = 'button'; button.dataset.todoId = todo.id;
      button.title = todo.title + ' · ' + todo.status;
      button.setAttribute('aria-label', dateLabel(todo.dueDate) + '，' + todo.title + '，' + todo.status);
      const mark = element('span', 'event-state');
      if (todo.status === '已完成') mark.append(icon('check'));
      button.append(mark, element('span', 'event-title', todo.title));
      button.addEventListener('click', () => openDrawer(todo.id));
      cell.append(button);
    });
    grid.append(cell);
  }
  calendar.append(weekdays, grid); page.append(calendar);
  const legend = element('div', 'calendar-legend');
  statuses.forEach(status => { const item = element('span', 'legend-item ' + statusClass(status)); item.append(element('i'), document.createTextNode(status)); legend.append(item); });
  page.append(legend);
  const section = element('section', 'undated-section');
  const undatedHeading = element('div', 'undated-heading');
  undatedHeading.append(element('h3', '', '未设置日期'), element('span', 'undated-count', undated.length));
  const sectionHeader = element('div', 'undated-header');
  sectionHeader.append(undatedHeading, element('p', '', '补充截止日期后，会显示在对应日期。'));
  section.append(sectionHeader);
  if (!undated.length) section.append(element('p', 'undated-empty', '当前范围没有未设置日期的事项。'));
  else {
    const list = element('div', 'undated-list');
    undated.forEach(todo => {
      const button = element('button', 'undated-item');
      button.type = 'button'; button.dataset.todoId = todo.id; button.title = todo.title;
      const content = element('span', 'undated-content');
      content.append(element('span', 'undated-title', todo.title), element('span', 'undated-group', groupName(todo.groupId)));
      button.append(content, element('span', 'status-badge ' + statusClass(todo.status), todo.status));
      button.addEventListener('click', () => openDrawer(todo.id)); list.append(button);
    });
    section.append(list);
  }
  page.append(section); area.append(page);
}

function changeMonth(direction) { month = new Date(month.getFullYear(), month.getMonth() + direction, 1); renderContent(); }

function openDrawer(id) {
  drawerReturnFocus = document.activeElement;
  selectedId = id; editingCommentId = null; composerExpanded = false;
  $('#detailDrawer').hidden = false; $('#drawerBackdrop').hidden = false;
  renderContent(); renderDetail(); $('#closeDrawer').focus();
}

function closeDrawer() {
  const previousId = selectedId;
  selectedId = null; editingCommentId = null; composerExpanded = false;
  $('#detailDrawer').hidden = true; $('#drawerBackdrop').hidden = true;
  const currentRow = previousId ? root.querySelector('[data-todo-id="' + CSS.escape(previousId) + '"]') : null;
  (currentRow || (drawerReturnFocus?.isConnected ? drawerReturnFocus : $('#newTodo'))).focus();
}

function detailAction(text, iconName, action, danger=false) {
  const button = element('button', 'text-action'+(danger?' danger':'')); button.type='button';
  button.append(icon(iconName),document.createTextNode(text)); button.addEventListener('click',action); return button;
}

function renderDetail() {
  const panel=$('#detailPanel'); panel.replaceChildren();
  const todo=data.todos.find(item=>item.id===selectedId);
  if (!todo) return;
  const scroll=element('div','detail-scroll'); const heading=element('header','detail-heading');
  const line=element('div','detail-title-line'); const title=element('h2','detail-title',todo.title); title.id='detailTitle';
  $('#detailDrawer').setAttribute('aria-labelledby','detailTitle');
  const actions=element('div','detail-actions'); actions.append(detailAction('删除','trash',()=>askDelete('todo',todo.id),true)); line.append(title,actions);
  const fields=element('div','detail-fields');
  const statusField=element('div','detail-field'); const statusLabel=element('label','','状态'); statusLabel.htmlFor='detailStatus';
  const status=element('select'); status.id='detailStatus'; statuses.forEach(value=>{const option=element('option','',value); status.append(option);}); status.value=todo.status;
  status.addEventListener('change',()=>changeStatus(todo.id,status.value,status)); statusField.append(statusLabel,status); enhanceSelect(status);
  const groupField=element('div','detail-field'); const groupLabel=element('label','','分组'); groupLabel.htmlFor='detailGroup';
  const group=element('select'); group.id='detailGroup'; populateGroups(group,todo.groupId); group.addEventListener('change',()=>moveGroup(todo.id,group)); groupField.append(groupLabel,group); enhanceSelect(group);
  const due=element('div','detail-field'); due.append(element('span','','截止'),element('span','field-value',todo.dueDate?dateLabel(todo.dueDate):'未设置'));
  const priority=element('div','detail-field'); priority.append(element('span','','优先级'),element('span','field-value',todo.priority||'未设置'));
  fields.append(statusField,groupField,due,priority); heading.append(line,fields);
  if (!isInCurrentView(todo)) heading.append(element('div','inline-alert','已保存。此事项不在当前分组、条件或月份范围中，关闭详情后可调整范围查看。'));
  const description=element('section','description-section'); description.append(element('h3','','详细说明'),element('p',todo.description?'description-text':'empty-description',todo.description||'暂未填写详细说明'));
  const times=element('div','time-meta'); times.append(element('span','','创建于 '+timeLabel(todo.createdAt)),element('span','','最近修改 '+timeLabel(todo.updatedAt))); description.append(times);
  const comments=element('section','comments-section'); const commentTitle=element('div','comments-title'); commentTitle.append(element('h3','','评论'),element('span','',todo.comments.length)); comments.append(commentTitle);
  if (!todo.comments.length) comments.append(element('p','comments-empty','还没有评论，记下第一条进展吧。'));
  todo.comments.slice().sort((a,b)=>new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime()).forEach(comment=>comments.append(renderComment(todo,comment)));
  scroll.append(heading,description,comments);
  panel.append(scroll);
  if (composerExpanded) panel.append(renderComposer(todo));
  const bar = element('footer', 'detail-action-bar');
  const complete = element('button', todo.status === '已完成' ? '' : 'primary');
  complete.type = 'button';
  complete.append(icon('check'), document.createTextNode(todo.status === '已完成' ? '重新开始' : '完成待办'));
  complete.addEventListener('click', () => changeStatus(todo.id, todo.status === '已完成' ? '进行中' : '已完成'));
  const edit = element('button'); edit.type = 'button'; edit.append(icon('edit'), document.createTextNode('编辑'));
  edit.addEventListener('click', () => openEditor(todo.id));
  const comment = element('button', 'comment-action'); comment.type = 'button';
  comment.append(icon('comment'), document.createTextNode('评论'));
  comment.addEventListener('click', () => { composerExpanded = true; renderDetail(); $('#commentInput').focus(); });
  bar.append(complete, edit, comment); panel.append(bar);
}

async function changeStatus(id,nextStatus,select=null) {
 const original=data.todos.find(todo=>todo.id===id).status;
 if(!await send('todoSetStatus',{id,status:nextStatus},null,select)){if(disposed)return;if(select)select.value=original;render();return;}
 render();showToast('已更新为“'+nextStatus+'”');
}
async function moveGroup(id,select) {
 const original=data.todos.find(todo=>todo.id===id).groupId,groupId=select.value;
 if(!await send('todoUpdate',{id,changes:{groupId}},null,select)){if(disposed)return;select.value=original;return;}
 render();showToast('已移至“'+groupName(groupId)+'”');
}

function renderComment(todo, comment) {
  const row = element('article', 'comment');
  row.dataset.commentId = comment.id;
  const body = element('div', 'comment-body');
  const header = element('div', 'comment-header');
  header.append(element('span', 'comment-author', '我'), element('time', 'comment-time', timeLabel(comment.createdAt)));
  if (comment.edited) header.append(element('span', 'comment-edited', '已编辑'));
  body.append(header);
  if (editingCommentId === comment.id) {
    const form = element('form', 'comment-edit');
    form.noValidate = true;
    const input = element('textarea');
    input.value = comment.content;
    input.setAttribute('aria-label', '编辑评论内容');
    const error = element('p', 'field-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const saveError = element('div', 'inline-alert');
    saveError.setAttribute('role', 'alert');
    saveError.hidden = true;
    const footer = element('div', 'comment-edit-footer');
    const cancel = element('button', '', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { editingCommentId = null; renderDetail(); });
    const save = element('button', 'primary', '保存修改');
    save.type = 'submit';
    footer.append(cancel, save);
    form.append(input, error, saveError, footer);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const content = input.value.trim();
      setError(error, content ? '' : '请填写评论内容');
      input.setAttribute('aria-invalid', String(!content));
      if (!content) { input.focus(); return; }
      if (!await send('todoCommentUpdate',{todoId:todo.id,id:comment.id,content},saveError,save)) return;
      editingCommentId = null;
      render();
      showToast('评论已更新');
    });
    body.append(form);
  } else {
    const actions = element('div', 'comment-actions');
    actions.append(detailAction('编辑', 'edit', () => { editingCommentId = comment.id; renderDetail(); $('#detailPanel .comment-edit textarea').focus(); }), detailAction('删除', 'trash', () => askDelete('comment', todo.id, comment.id), true));
    header.append(actions);
    body.append(element('p', 'comment-text', comment.content));
  }
  row.append(element('span', 'avatar', '我'), body);
  return row;
}

function renderComposer(todo) {
  const form = element('form', 'comment-composer');
  form.id = 'commentForm';
  form.noValidate = true;
  const label = element('label', '', '记录进展');
  label.htmlFor = 'commentInput';
  const input = element('textarea', 'composer-textarea');
  input.id = 'commentInput';
  input.placeholder = '写下处理进展、补充说明或下一步安排…';
  input.value = commentDrafts.get(todo.id) || '';
  input.setAttribute('aria-describedby', 'commentError');
  input.addEventListener('input', () => { commentDrafts.set(todo.id, input.value); });
  const error = element('p', 'field-error');
  error.id = 'commentError';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const saveError = element('div', 'inline-alert');
  saveError.id = 'commentSaveError';
  saveError.setAttribute('role', 'alert');
  saveError.hidden = true;
  const footer = element('div', 'composer-footer');
  const button = element('button', 'primary', '发布评论');
  button.type = 'submit';
  const cancel = element('button', '', '收起');
  cancel.type = 'button';
  cancel.addEventListener('click', () => { composerExpanded = false; renderDetail(); });
  footer.append(cancel, button);
  form.append(label, input, error, saveError, footer);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const content = input.value.trim();
    setError(error, content ? '' : '请填写评论内容');
    input.setAttribute('aria-invalid', String(!content));
    if (!content) { input.focus(); return; }
    if (!await send('todoCommentCreate',{todoId:todo.id,content},saveError,button)) return;
    commentDrafts.delete(todo.id);
    composerExpanded = false;
    render();
    const scroll = $('#detailPanel .detail-scroll');
    scroll.scrollTop = scroll.scrollHeight;
    showToast('评论已发布');
  });
  return form;
}

function populateGroups(select, selected) {
  select.replaceChildren();
  const unset=element('option','','未分组');unset.value='';select.append(unset);
  data.groups.forEach(group=>{const option=element('option','',group.name);option.value=group.id;select.append(option);});
  select.value=selected;
}

function openEditor(id=null) {
  if (!$('#filterDialog').hidden) closeSurface('filterDialog');
  closeQueryMenu(); closeDatePanel();
  editingId=id;
  const todo=id?data.todos.find(item=>item.id===id):null;
  $('#editorTitle').textContent=todo?'编辑待办':'新建待办';
  $('#editorSubtitle').textContent=todo?'更新事项信息，已有评论会保留。':'先记下标题，其他信息可以稍后补充。';
  $('#saveTodo').textContent=todo?'保存修改':'创建待办';
  $('#todoTitle').value=todo?.title||'';
  $('#todoDescription').value=todo?.description||'';
  $('#todoDue').value=todo?.dueDate||'';
  $('#todoPriority').value=todo?.priority||'';
  populateGroups($('#todoGroup'),todo?todo.groupId:currentGroup);
  $('#newStatusNote').hidden=Boolean(todo);
  ['titleError','dateError','editorError'].forEach(name=>setError($('#'+name),''));
  $('#todoTitle').removeAttribute('aria-invalid');$('#todoDue').removeAttribute('aria-invalid');
  syncDateButton('todoDue');syncSelectButton($('#todoPriority'));syncSelectButton($('#todoGroup'));
  $('#todoEditor').hidden=false;$('#editorBackdrop').hidden=false;$('#todoTitle').focus();
}

async function saveTodo(event) {
  event.preventDefault();
  const title=$('#todoTitle').value.trim();const due=$('#todoDue');
  setError($('#titleError'),title?'':'请填写待办标题');setError($('#dateError'),due.validity.valid?'':'请选择有效的截止日期');
  $('#todoTitle').setAttribute('aria-invalid',String(!title));due.setAttribute('aria-invalid',String(!due.validity.valid));
  if (!title||!due.validity.valid) {(title?due:$('#todoTitle')).focus();return;}
  const fields={title,description:$('#todoDescription').value,dueDate:due.value,priority:$('#todoPriority').value,groupId:$('#todoGroup').value};
  const result=await send(editingId?'todoUpdate':'todoCreate',editingId?{id:editingId,changes:fields}:fields,$('#editorError'),$('#saveTodo'));
  if(!result)return;
  const id=result.id;
  closeSurface('todoEditor');editingCommentId=null;
  if(editingId){selectedId=id;$('#detailDrawer').hidden=false;$('#drawerBackdrop').hidden=false;}
  else closeDrawer();
  render();(editingId?$('#closeDrawer'):$('#newTodo')).focus();
  const saved=data.todos.find(todo=>todo.id===id);
  showToast(isInCurrentView(saved)?(editingId?'待办已更新':'待办已创建'):'已保存，当前范围不显示此事项，可调整分组、条件或月份查看。');
}

function openGroupEditor(id=null) {
  editingGroupId=id;
  $('#groupEditorTitle').textContent=id?'重命名分组':'新建分组';
  $('#groupName').value=id?data.groups.find(group=>group.id===id).name:'';
  setError($('#groupError'),'');setError($('#groupSaveError'),'');$('#groupName').removeAttribute('aria-invalid');
  $('#groupEditor').showModal();$('#groupName').focus();
}

async function saveGroup(event) {
  event.preventDefault();const name=$('#groupName').value.trim();
  const error=!name?'请填写分组名称':name==='全部'?'“全部”是固定分组，请使用其他名称':data.groups.some(group=>group.id!==editingGroupId&&group.name===name)?'已有同名分组，请使用其他名称':'';
  setError($('#groupError'),error);$('#groupName').setAttribute('aria-invalid',String(Boolean(error)));
  if (error) {$('#groupName').focus();return;}
  if(!await send(editingGroupId?'todoGroupRename':'todoGroupCreate',editingGroupId?{id:editingGroupId,name}:{name},$('#groupSaveError')))return;
  $('#groupEditor').close();render();showToast(editingGroupId?'分组已重命名':'分组已创建');
}

function askDelete(kind,id,commentId=null) {
  pendingDelete={kind,id,commentId};
  let title,target,body,button;
  if(kind==='group'){
    const group=data.groups.find(item=>item.id===id);title='删除这个分组？';target=group.name;button='删除分组';
    body='仅删除分组，其下的 '+data.todos.filter(todo=>todo.groupId===id).length+' 条待办和评论将保留，变为未分组，可在“全部”中继续查看。';
  }else{
    const todo=data.todos.find(item=>item.id===id);
    title=kind==='todo'?'永久删除这条待办？':'删除这条评论？';
    target=kind==='todo'?todo.title:todo.comments.find(comment=>comment.id===commentId).content;
    body=kind==='todo'?'这条待办及其全部 '+todo.comments.length+' 条评论将一并永久删除，删除后无法恢复。':'这条评论将被永久删除，待办和其他评论会保留。删除后无法恢复。';
    button=kind==='todo'?'永久删除':'删除评论';
  }
  $('#confirmTitle').textContent=title;$('#confirmTarget').textContent=target;$('#confirmBody').textContent=body;$('#confirmDelete').textContent=button;
  setError($('#confirmError'),'');$('#confirmDialog').showModal();$('#cancelDelete').focus();
}

async function confirmDelete() {
  const {kind,id,commentId}=pendingDelete;
  const command=kind==='group'?'todoGroupDelete':kind==='todo'?'todoDelete':'todoCommentDelete';
  if(!await send(command,kind==='comment'?{todoId:id,id:commentId}:{id},$('#confirmError'),$('#confirmDelete')))return;
  $('#confirmDialog').close();
  if(kind==='group'&&currentGroup===id)currentGroup='';
  if(kind==='todo'){commentDrafts.delete(id);closeDrawer();}
  render();showToast(kind==='group'?'分组已删除，待办及评论已保留':kind==='todo'?'待办及其评论已永久删除':'评论已删除');
}

function openFilters() {
  $('#priorityFilter').value=query.priority;$('#dateMode').value=query.dateMode;$('#dateFrom').value=query.from;$('#dateTo').value=query.to;
  $('#dateRange').hidden=query.dateMode!=='range';setError($('#filterError'),'');
  syncSelectButton($('#priorityFilter'));syncSelectButton($('#dateMode'));syncDateButton('dateFrom');syncDateButton('dateTo');
  $('#filterDialog').hidden=false;$('#filterTrigger').setAttribute('aria-expanded','true');placeFloating($('#filterTrigger'),$('#filterDialog'));$('#priorityFilterTrigger').focus();
}

function applyFilters(event) {
  event.preventDefault();const mode=$('#dateMode').value;const from=$('#dateFrom');const to=$('#dateTo');
  const invalid=mode==='range'&&(!from.validity.valid||!to.validity.valid||(from.value&&to.value&&from.value>to.value));
  setError($('#filterError'),invalid?'请选择有效日期，起始日期不能晚于结束日期':'');
  if(invalid)return;
  query.priority=$('#priorityFilter').value;query.dateMode=mode;
  query.from=mode==='range'?from.value:'';query.to=mode==='range'?to.value:'';
  rememberPreferences();closeSurface('filterDialog');render();
}

function clearConditions() {
  query.status='';query.priority='';query.dateMode='any';query.from='';query.to='';query.keyword='';$('#keyword').value='';rememberPreferences();render();
}

$('#newTodo').addEventListener('click',()=>openEditor());
$('#todoForm').addEventListener('submit',saveTodo);
$('#groupForm').addEventListener('submit',saveGroup);
$('#filterForm').addEventListener('submit',applyFilters);
$('#dateMode').addEventListener('change',()=>{$('#dateRange').hidden=$('#dateMode').value!=='range';placeFloating($('#filterTrigger'),$('#filterDialog'));});
$('#confirmDelete').addEventListener('click',confirmDelete);
$('#addGroup').addEventListener('click',()=>openGroupEditor());
$('#manageGroups').addEventListener('click',openGroupManager);
$('#saveGroupOrder').addEventListener('click',saveGroupOrder);
$('#statusTrigger').addEventListener('click',()=>openQueryMenu('statusFilter','statusTrigger'));
$('#sortTrigger').addEventListener('click',()=>openQueryMenu('sortRule','sortTrigger'));
$('#searchTrigger').addEventListener('click',()=>{searchExpanded=true;render();$('#keyword').focus();$('#keyword').select();});
$('#closeSearch').addEventListener('click',()=>{searchExpanded=false;render();$('#searchTrigger').focus();});
$('#collapseGroups').addEventListener('click',()=>{collapsed=true;render();$('#expandGroups').focus();});
$('#expandGroups').addEventListener('click',()=>{collapsed=false;render();$('#collapseGroups').focus();});
$('#listView').addEventListener('click',()=>{view='list';render();});
$('#calendarView').addEventListener('click',()=>{view='calendar';render();});
$('#statusFilter').addEventListener('change',event=>{query.status=event.target.value;rememberPreferences();render();});
$('#sortRule').addEventListener('change',event=>{query.sort=event.target.value;rememberPreferences();render();});
$('#keyword').addEventListener('input',event=>{query.keyword=event.target.value;render();});
$('#clearConditions').addEventListener('click',clearConditions);
$('#filterTrigger').addEventListener('click',openFilters);
$('#closeDrawer').addEventListener('click',()=>{closeDrawer();renderContent();});
$('#drawerBackdrop').addEventListener('click',()=>{closeDrawer();renderContent();});
root.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>closeSurface(button.dataset.close)));
$('#editorBackdrop').addEventListener('click',()=>closeSurface('todoEditor'));
root.querySelectorAll('[data-date-input]').forEach(button=>button.addEventListener('click',()=>openDatePanel(button.dataset.dateInput,button)));
document.addEventListener('click',event=>{
  if(!event.target.closest('.query-menu,.query-select-button,.field-select-button'))closeQueryMenu();
  if(!event.target.closest('.row-calendar,[data-date-input]'))closeDatePanel();
  if(!$('#filterDialog').hidden&&!event.target.closest('#filterDialog,#filterTrigger,.query-menu,.row-calendar'))closeSurface('filterDialog');
},{signal:controller.signal});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    if(root.querySelector('.query-menu')){closeQueryMenu();return;}
    if(root.querySelector('.row-calendar')){closeDatePanel();return;}
    if(!$('#filterDialog').hidden){closeSurface('filterDialog');return;}
    if(!root.querySelector('dialog[open]')&&!$('#todoEditor').hidden){closeSurface('todoEditor');return;}
    if(!root.querySelector('dialog[open]')&&!$('#detailDrawer').hidden){closeDrawer();renderContent();}
  }
  // 表单与详情都位于右侧；日期或选择浮窗打开后将键盘操作交给浮窗。
  const activeDrawer = !$('#todoEditor').hidden ? $('#todoEditor') : !$('#detailDrawer').hidden ? $('#detailDrawer') : null;
  if(event.key==='Tab'&&activeDrawer&&!root.querySelector('dialog[open],.query-menu,.row-calendar')){
    const items=[...activeDrawer.querySelectorAll('button,input,select,textarea')].filter(item=>!item.disabled&&item.offsetParent!==null);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
},{signal:controller.signal});
populateGroups($('#todoGroup'),'');
['todoPriority','todoGroup','priorityFilter','dateMode'].forEach(id=>enhanceSelect($('#'+id)));
render();

async function load(){
 scene='loading';render();
 try{const result=await call('todoLoad');if(disposed)return;data=result.state;scene='normal';render();}
 catch(error){if(disposed)return;scene='read-error';render();showToast(error.message);}
}
load();
return ()=>{disposed=true;controller.abort();clearTimeout(toastTimer);clearTimeout(loadingTimer);root.replaceChildren();root.classList.remove('todo-product');};
}
