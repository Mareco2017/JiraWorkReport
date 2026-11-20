export function matchesQuery(todo, query, currentGroup = '') {
  const keyword = (query.keyword || '').trim().toLocaleLowerCase();
  return (!currentGroup || todo.groupId === currentGroup)
    && (!query.status || todo.status === query.status)
    && (!query.priority || (query.priority === 'unset' ? !todo.priority : todo.priority === query.priority))
    && (query.dateMode !== 'undated' || !todo.dueDate)
    && (query.dateMode !== 'range' || ((!query.from && !query.to) || (Boolean(todo.dueDate) && (!query.from || todo.dueDate >= query.from) && (!query.to || todo.dueDate <= query.to))))
    && (!keyword || todo.title.toLocaleLowerCase().includes(keyword) || todo.description.toLocaleLowerCase().includes(keyword));
}

// 未设置的日期/优先级固定后置，方向只影响已设置项；同值按创建时间倒序。
export function compareTodos(a, b, sort) {
  const created = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  const [field, direction] = sort.split('-');
  if (field === 'created') return direction === 'desc' ? created : -created;
  const priorityValues = {高: 3, 中: 2, 低: 1};
  const av = field === 'due' ? a.dueDate : priorityValues[a.priority];
  const bv = field === 'due' ? b.dueDate : priorityValues[b.priority];
  if (!av || !bv) return av ? -1 : bv ? 1 : created;
  const value = av < bv ? -1 : av > bv ? 1 : 0;
  return (direction === 'asc' ? value : -value) || created;
}


// 自然日期只在本机日历中运算，避免UTC转换把截止日期移到前后一天。
export function dayKey(date) { return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-'); }
export function monthCells(month) {
 const offset=(month.getDay()+6)%7, days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
 return Array.from({length:Math.ceil((offset+days)/7)*7},(_,i)=>dayKey(new Date(month.getFullYear(),month.getMonth(),i-offset+1)));
}
