import {randomUUID} from 'node:crypto';
import {todoObject,todoText,todoChoice,todoFields,todoValidation,todoStatuses} from './todo-data.js';

export const todoCommands = ['todoLoad','todoCreate','todoUpdate','todoSetStatus','todoDelete','todoGroupCreate','todoGroupRename','todoGroupDelete','todoGroupReorder','todoCommentCreate','todoCommentUpdate','todoCommentDelete'];

// IPC入口只保留约定字段，ID、时间、状态初值和评论归属不会由页面覆盖。
function parseCommand(command,payload) {
 const data=todoObject(payload,'payload');
 if(command==='todoCreate')return todoFields(data,{create:true});
 if(command==='todoLoad')return {};
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
  let resultId;
  const state=await this.store.updatePersonalTodos(state=>{
   const stamp=()=>this.now().toISOString();
   if(command==='todoCreate'){
    checkGroup(state,data.groupId);resultId=this.id();const time=stamp();state.todos.push({id:resultId,...data,status:'待处理',createdAt:time,updatedAt:time,comments:[]});return;
   }
   if(command==='todoGroupCreate'){
    checkGroupName(state,data.name);resultId=this.id();state.groups.push({id:resultId,name:data.name});return;
   }
   if(command==='todoGroupReorder'){
    if(data.ids.length!==state.groups.length||new Set(data.ids).size!==state.groups.length||data.ids.some(id=>!state.groups.some(group=>group.id===id)))throw todoValidation('分组顺序必须包含每个自定义分组且不重复','ids');
    state.groups=data.ids.map(id=>state.groups.find(group=>group.id===id));return;
   }
   if(command==='todoGroupRename'||command==='todoGroupDelete'){
    const group=target(state.groups,data.id,'id','分组');
    if(command==='todoGroupRename'){checkGroupName(state,data.name,group.id);group.name=data.name;resultId=group.id;}
    else {state.groups=state.groups.filter(group=>group.id!==data.id);for(const todo of state.todos)if(todo.groupId===data.id)todo.groupId='';}
    return;
   }
   const todo=target(state.todos,data.todoId||data.id,data.todoId?'todoId':'id','待办');
   if(command==='todoDelete'){state.todos=state.todos.filter(row=>row.id!==todo.id);return;}
   if(command==='todoUpdate'){
    if(Object.hasOwn(data.changes,'groupId'))checkGroup(state,data.changes.groupId);
    Object.assign(todo,data.changes);resultId=todo.id;
   }else if(command==='todoSetStatus'){todo.status=data.status;resultId=todo.id;}
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
}
