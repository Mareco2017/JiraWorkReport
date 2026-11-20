import {randomUUID} from 'node:crypto';
import {todoObject,todoText,todoChoice,todoFields,todoValidation,todoStatuses,todoWorkLogEntry,todoWorkLogPatch,workLogStates,WORKLOG_MAX} from './todo-data.js';

export const todoCommands = ['todoLoad','todoCreate','todoUpdate','todoSetStatus','todoDelete','todoComplete','todoAddWorkLog','todoUpdateWorkLog','todoDeleteWorkLog','todoGroupCreate','todoGroupRename','todoGroupDelete','todoGroupReorder','todoCommentCreate','todoCommentUpdate','todoCommentDelete'];

// IPC入口只保留约定字段，ID、时间、状态初值和评论归属不会由页面覆盖。
function parseCommand(command,payload) {
 const data=todoObject(payload,'payload');
 if(command==='todoCreate'){
  const fields=todoFields(data,{create:true});
  const status=data.status===undefined?'待处理':todoChoice(data.status,todoStatuses,'status');
  const workLog=data.workLog==null?null:todoWorkLogEntry(data.workLog);
  return {...fields,status,workLog};
 }
 if(command==='todoLoad')return {};
 // 完成待办可以顺手记一笔（日期+工时），也可以不记。
 if(command==='todoComplete')return {id:todoText(data.id,'id',{required:true}),workLog:data.workLog==null?null:todoWorkLogEntry(data.workLog)};
 if(command==='todoAddWorkLog')return {todoId:todoText(data.todoId,'todoId',{required:true}),workLog:todoWorkLogEntry(data.workLog)};
 if(command==='todoUpdateWorkLog')return {todoId:todoText(data.todoId,'todoId',{required:true}),entryId:todoText(data.entryId,'entryId',{required:true}),patch:todoWorkLogPatch(data.workLog)};
 if(command==='todoDeleteWorkLog')return {todoId:todoText(data.todoId,'todoId',{required:true}),entryId:todoText(data.entryId,'entryId',{required:true})};
 if(command==='todoGroupReorder'){
  if(!Array.isArray(data.ids))throw todoValidation('请提供分组顺序','ids');
  return {ids:data.ids.map(id=>todoText(id,'ids',{required:true}))};
 }
 const result={};
 if(command!=='todoGroupCreate'&&command!=='todoCommentCreate')result.id=todoText(data.id,'id',{required:true});
 if(command.startsWith('todoComment'))result.todoId=todoText(data.todoId,'todoId',{required:true});
 if(command==='todoUpdate')result.changes=todoFields(data.changes);
 if(command==='todoSetStatus')result.status=todoChoice(data.status,todoStatuses,'status');
 if(command==='todoGroupCreate'||command==='todoGroupRename')result.name=todoText(data.name,'name',{required:true,trim:true});
 if(command==='todoCommentCreate'||command==='todoCommentUpdate')result.content=todoText(data.content,'content',{required:true,trim:true});
 return result;
}
function target(rows,id,field,label) {
 const found=rows.find(row=>row.id===id);
 if(!found)throw todoValidation(label+'不存在，请重新打开后重试',field);
 return found;
}
function checkGroup(state,groupId) {if(groupId)target(state.groups,groupId,'groupId','分组');}
function checkGroupName(state,name,id) {
 if(name==='全部'||state.groups.some(group=>group.id!==id&&group.name===name))throw todoValidation('分组名称不能与全部或已有分组重复','name');
}

/** 本机待办业务不依赖工时配置或远端客户端；Store负责串行读改写。 */
export class PersonalTodoService {
 constructor({store,today=()=>new Date().toLocaleDateString('sv-SE'),id=randomUUID,now=()=>new Date()}) {Object.assign(this,{store,today,id,now});}
 async call(command,payload={}) {
  if(!todoCommands.includes(command))throw new Error('不支持的待办操作');
  const data=parseCommand(command,payload);
  if(command==='todoLoad')return {state:await this.store.loadPersonalTodos(),today:this.today()};
  if(command==='todoDeleteWorkLog')return {state:await this.deleteWorkLog(data.todoId,data.entryId)};
  let resultId;
  const state=await this.store.updatePersonalTodos(state=>{
   const stamp=()=>this.now().toISOString();
   if(command==='todoCreate'){
    checkGroup(state,data.groupId);
    const {workLog,...fields}=data,time=stamp();
    resultId=this.id();
    const todo={id:resultId,...fields,createdAt:time,updatedAt:time,comments:[]};
    if(workLog){
     todo.workLogs=[{id:this.id(),...workLog,state:'recorded',createdAt:time,updatedAt:time}];
     todo.completedAt=time;
    }
    if(todo.status==='已完成')todo.completedAt??=time;
    state.todos.push(todo);return;
   }
   if(command==='todoGroupCreate'){
    checkGroupName(state,data.name);resultId=this.id();state.groups.unshift({id:resultId,name:data.name,createdAt:stamp()});return;
   }
   if(command==='todoGroupReorder'){
    if(data.ids.length!==state.groups.length||new Set(data.ids).size!==state.groups.length||data.ids.some(id=>!state.groups.some(group=>group.id===id)))throw todoValidation('分组顺序必须包含每个自定义分组且不重复','ids');
    state.groups=data.ids.map(id=>state.groups.find(group=>group.id===id));state.groupOrderManual=true;return;
   }
   if(command==='todoGroupRename'||command==='todoGroupDelete'){
    const group=target(state.groups,data.id,'id','分组');
    if(command==='todoGroupRename'){checkGroupName(state,data.name,group.id);group.name=data.name;resultId=group.id;}
    else {state.groups=state.groups.filter(group=>group.id!==data.id);for(const todo of state.todos)if(todo.groupId===data.id)todo.groupId='';if(!state.groups.length)delete state.groupOrderManual;}
    return;
   }
   const todo=target(state.todos,data.todoId||data.id,data.todoId?'todoId':'id','待办');
   const logs=()=>{todo.workLogs??=[];return todo.workLogs;};
   if(command==='todoDelete'){state.todos=state.todos.filter(row=>row.id!==todo.id);return;}
   if(command==='todoComplete'){
    todo.status='已完成';
    if(data.workLog){
     const entries=logs();
     if(entries.length>=WORKLOG_MAX)throw todoValidation('单条待办的工时记录过多','workLogs');
     const entry={id:this.id(),...data.workLog,state:'recorded',createdAt:stamp(),updatedAt:stamp()};
     entries.push(entry);resultId=entry.id;
    }else resultId=todo.id;
    // 首次完成时间单独保存；updatedAt 会被评论等修改刷新，不能当作工作日期。
    todo.completedAt??=stamp();
   }else if(command==='todoAddWorkLog'){
    const entries=logs();
    if(entries.length>=WORKLOG_MAX)throw todoValidation('单条待办的工时记录过多','workLogs');
    const entry={id:this.id(),...data.workLog,state:'recorded',createdAt:stamp(),updatedAt:stamp()};
    entries.push(entry);resultId=entry.id;
   }else if(command==='todoUpdateWorkLog'){
    const entry=target(logs(),data.entryId,'entryId','工时记录');
    if(entry.state==='submitted')throw todoValidation('该工时已在JIRA登记，请从填报记录中修改','workLog');
    Object.assign(entry,data.patch,{updatedAt:stamp()});resultId=todo.id;
   }else if(command==='todoUpdate'){
    if(Object.hasOwn(data.changes,'groupId'))checkGroup(state,data.changes.groupId);
    Object.assign(todo,data.changes);resultId=todo.id;
   }else if(command==='todoSetStatus'){
    todo.status=data.status;
    if(data.status==='已完成')todo.completedAt??=stamp();
    resultId=todo.id;
   }
   else if(command==='todoCommentCreate'){
    resultId=this.id();todo.comments.push({id:resultId,content:data.content,createdAt:stamp(),edited:false});
   }else{
    const comment=target(todo.comments,data.id,'id','评论');
    if(command==='todoCommentUpdate'){comment.content=data.content;comment.edited=true;resultId=comment.id;}
    else todo.comments=todo.comments.filter(row=>row.id!==comment.id);
   }
   todo.updatedAt=stamp();
  });
  return resultId?{state,id:resultId}:{state};
 }
 /** 内部删除：服务层完成远端删除后可用 force 删除已登记的一笔。 */
 async deleteWorkLog(todoId,entryId,{force=false}={}) {
  let removed=false;
  const state=await this.store.updatePersonalTodos(current=>{
   const todo=current.todos.find(row=>row.id===todoId);
   if(!todo)return;
   const entries=todo.workLogs||[],entry=entries.find(row=>row.id===entryId);
   if(!entry)return;
   if(entry.state==='submitted'&&!force)throw todoValidation('该工时已在JIRA登记，请从填报记录中删除','workLog');
   todo.workLogs=entries.filter(row=>row.id!==entryId);
   todo.updatedAt=this.now().toISOString();removed=true;
  });
  if(!removed)throw todoValidation('工时记录不存在，请重新打开后重试','entryId');
  return state;
 }
 /** 提交成功后由主进程回写，页面无法直接设置该状态。 */
 async markSubmitted(todoId,entryId,{worklogId,recordId,targetKey,day}={}) {
  const current=await this.store.loadPersonalTodos();
  const todo=current.todos.find(row=>row.id===todoId);
  const entry=todo?.workLogs?.find(row=>row.id===entryId);
  if(!entry)return null;
  const stamp=this.now().toISOString();
  Object.assign(entry,{state:'submitted',submittedAt:stamp});
  if(worklogId)entry.worklogId=String(worklogId);
  if(recordId)entry.recordId=String(recordId);
  if(targetKey)entry.targetKey=String(targetKey);
  if(day)entry.day=day;
  return this.writeEntry(todoId,entry,stamp);
 }
 /** 删除填报记录后回退，让这一笔重新可带入。 */
 async markRecorded(todoId,entryId) {
  const current=await this.store.loadPersonalTodos();
  const todo=current.todos.find(row=>row.id===todoId);
  const entry=todo?.workLogs?.find(row=>row.id===entryId);
  if(!entry)return null;
  const {worklogId,recordId,targetKey,submittedAt,...rest}=entry;
  return this.writeEntry(todoId,{...rest,state:'recorded'},this.now().toISOString());
 }
 async writeEntry(todoId,entry,stamp) {
  let found=false;
  const state=await this.store.updatePersonalTodos(current=>{
   const todo=current.todos.find(row=>row.id===todoId);
   if(!todo)return;
   todo.workLogs=(todo.workLogs||[]).map(row=>row.id===entry.id?{...entry,state:workLogStates.includes(entry.state)?entry.state:'recorded'}:row);
   todo.updatedAt=stamp;found=true;
  });
  return found?state:null;
 }
}
