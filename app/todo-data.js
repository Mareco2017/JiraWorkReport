// 仅磁盘和IPC两个外部入口使用这些规则，内部业务继续使用已校验的字段。
import {HOURS_ERROR,hoursValid} from './worklogs.js';
export const todoStatuses = ['待处理','进行中','已完成'];
export const todoPriorities = ['','高','中','低'];
export const workLogStates = ['recorded','submitted'];
export const WORKLOG_MAX = 50;
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
export function todoDate(value,field='dueDate') {
 todoText(value,field);
 if(value && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value))throw todoValidation('请选择有效截止日期',field);
 return value;
}
export function todoChoice(value,choices,field) {
 if(!choices.includes(value))throw todoValidation('请选择有效选项',field);
 return value;
}
/** 一笔待办工时只含日期和工时；状态、工单号等由主进程回写。 */
export function todoWorkLogEntry(value) {
 const source=todoObject(value,'workLog');
 const hours=Number(source.hours);
 // 与提交时的工时规则保持一致：至少 HOURS_MIN，且是步长的整数倍。
 if(source.hours===''||source.hours===null||source.hours===undefined||!hoursValid(hours))throw todoValidation(HOURS_ERROR,'hours');
 const day=todoDate(source.day ?? '','day');
 if(!day)throw todoValidation('请选择有效的工作日期','day');
 // 已确认允许未来日期，这里不比较 today。
 return {day,hours};
}
/** 修改一笔工时：允许只改日期或只改工时。 */
export function todoWorkLogPatch(value) {
 const source=todoObject(value,'workLog'),patch={};
 if(Object.hasOwn(source,'hours')){
  const hours=Number(source.hours);
  if(source.hours===''||source.hours===null||source.hours===undefined||!hoursValid(hours))throw todoValidation(HOURS_ERROR,'hours');
  patch.hours=hours;
 }
 if(Object.hasOwn(source,'day')){
  const day=todoDate(source.day ?? '','day');
  if(!day)throw todoValidation('请选择有效的工作日期','day');
  patch.day=day;
 }
 if(!Object.keys(patch).length)throw todoValidation('请填写要修改的工时','workLog');
 return patch;
}
export const sumWorkLogs = (todo,{pendingOnly=false}={}) => (todo?.workLogs || [])
 .filter(entry=>!pendingOnly||entry.state!=='submitted')
 .reduce((sum,entry)=>sum+Number(entry.hours||0),0);
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
 if(state.groupOrderManual!==undefined&&typeof state.groupOrderManual!=='boolean')throw todoValidation('本机分组排序标记不正确','groupOrderManual');
 const unique=(set,id,field)=>{todoText(id,field,{required:true});if(set.has(id))throw todoValidation('本机记录编号重复',field);set.add(id);};
 const time=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw todoValidation('本机记录时间不正确','createdAt');};
 for(const group of state.groups){todoObject(group,'groups');unique(groups,group.id,'groupId');const name=todoText(group.name,'name',{required:true,trim:true});if(name==='全部'||names.has(name))throw todoValidation('本机分组名称重复','name');names.add(name);if(group.createdAt!==undefined)time(group.createdAt);}
 for(const todo of state.todos){
  todoObject(todo,'todos');unique(items,todo.id,'id');
  for(const field of ['title','description','dueDate','priority','groupId'])if(!Object.hasOwn(todo,field))throw todoValidation('本机待办缺少字段',field);
  todoFields(todo,{create:true});todoChoice(todo.status,todoStatuses,'status');time(todo.createdAt);time(todo.updatedAt);
  if(todo.groupId&&!groups.has(todo.groupId))throw todoValidation('本机待办分组不存在','groupId');
  // 完成时间与工时账本是在旧数据之后新增的字段，缺省视为未填写，不能因此判定文件损坏。
  if(todo.completedAt!==undefined)time(todo.completedAt);
  if(todo.workLogs!==undefined&&todo.workLogs!==null){
   if(!Array.isArray(todo.workLogs))throw todoValidation('本机工时记录格式不正确','workLogs');
   if(todo.workLogs.length>WORKLOG_MAX)throw todoValidation('单条待办的工时记录过多','workLogs');
   for(const entry of todo.workLogs){
    todoObject(entry,'workLogs');
    todoText(entry.id,'entryId',{required:true});
    todoWorkLogEntry(entry);todoChoice(entry.state,workLogStates,'state');
    for(const field of ['worklogId','recordId','targetKey'])if(entry[field]!==undefined)todoText(entry[field],field);
    for(const field of ['submittedAt','createdAt','updatedAt'])if(entry[field]!==undefined)time(entry[field]);
   }
  }
  // 旧版单条 workLog 已确认不再保留，读取时直接丢弃。
  if(todo.workLog!==undefined) delete todo.workLog;
  if(!Array.isArray(todo.comments))throw todoValidation('本机评论格式不正确','comments');
  for(const comment of todo.comments){todoObject(comment,'comments');unique(comments,comment.id,'commentId');todoText(comment.content,'content',{required:true});time(comment.createdAt);if(typeof comment.edited!=='boolean')throw todoValidation('本机评论格式不正确','edited');}
 }
 return state;
}
