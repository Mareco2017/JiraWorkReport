// 仅磁盘和IPC两个外部入口使用这些规则，内部业务继续使用已校验的字段。
export const todoStatuses = ['待处理','进行中','已完成'];
export const todoPriorities = ['','高','中','低'];
export function todoValidation(message,field) {return Object.assign(new Error(message),{code:'TODO_VALIDATION',field});}
export function todoObject(value,field) {
 if(!value||typeof value!=='object'||Array.isArray(value))throw todoValidation('请提供有效的待办信息',field);
 return value;
}
export function todoText(value,field,{required=false,trim=false}={}) {
 if(typeof value!=='string')throw todoValidation('请填写有效文字',field);
 const result=trim?value.trim():value;
 if(required&&!result.trim())throw todoValidation('此项不能为空',field);
 return result;
}
export function todoDate(value) {
 todoText(value,'dueDate');
 if(value && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value))throw todoValidation('请选择有效截止日期','dueDate');
 return value;
}
export function todoChoice(value,choices,field) {
 if(!choices.includes(value))throw todoValidation('请选择有效选项',field);
 return value;
}
export function todoFields(value,{create=false}={}) {
 const source=todoObject(value,'changes'),fields={};
 for(const field of ['title','description','dueDate','priority','groupId']){
  if(!Object.hasOwn(source,field)&&!create)continue;
  const v=source[field]??(Object.hasOwn(source,field)?null:'');
  if(field==='dueDate')fields[field]=todoDate(v);
  else if(field==='priority')fields[field]=todoChoice(v,todoPriorities,field);
  else fields[field]=todoText(v,field,{required:field==='title',trim:field==='title'});
 }
 return fields;
}

/** 严格读取当前格式，损坏的个人清单不能退化为空清单再被下一次保存覆盖。 */
export function validateTodoState(value) {
 const state=todoObject(value,'state');
 if(!Array.isArray(state.groups)||!Array.isArray(state.todos))throw todoValidation('本机待办格式不正确','state');
 const groups=new Set(),names=new Set(),items=new Set(),comments=new Set();
 const unique=(set,id,field)=>{todoText(id,field,{required:true});if(set.has(id))throw todoValidation('本机记录编号重复',field);set.add(id);};
 const time=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw todoValidation('本机记录时间不正确','createdAt');};
 for(const group of state.groups){todoObject(group,'groups');unique(groups,group.id,'groupId');const name=todoText(group.name,'name',{required:true,trim:true});if(name==='全部'||names.has(name))throw todoValidation('本机分组名称重复','name');names.add(name);}
 for(const todo of state.todos){
  todoObject(todo,'todos');unique(items,todo.id,'id');
  for(const field of ['title','description','dueDate','priority','groupId'])if(!Object.hasOwn(todo,field))throw todoValidation('本机待办缺少字段',field);
  todoFields(todo,{create:true});todoChoice(todo.status,todoStatuses,'status');time(todo.createdAt);time(todo.updatedAt);
  if(todo.groupId&&!groups.has(todo.groupId))throw todoValidation('本机待办分组不存在','groupId');
  if(!Array.isArray(todo.comments))throw todoValidation('本机评论格式不正确','comments');
  for(const comment of todo.comments){todoObject(comment,'comments');unique(comments,comment.id,'commentId');todoText(comment.content,'content',{required:true});time(comment.createdAt);if(typeof comment.edited!=='boolean')throw todoValidation('本机评论格式不正确','edited');}
 }
 return state;
}
