import {randomUUID} from 'node:crypto';
import {validateRecord,validateWorkDetails,monthBounds,isMonthlyType,typeValues,isCompletedItem} from './worklogs.js';
import {jiraError,sameWorklog} from './jira.js';
import {refreshTodoDraft} from './todo-data.js';

/** Both entry flows share this coordinator; UI closure never owns the lifetime of a batch. */
export class SubmissionService {
  constructor({store,jira,onUpdate=()=>{},onItemSettled=async()=>{},onItemRemoved=async()=>{},loadTodoEntries,today=()=>new Date().toLocaleDateString('sv-SE')}) {
    Object.assign(this,{store,jira,onUpdate,onItemSettled,onItemRemoved,loadTodoEntries,today});
    this.batches=new Map();
    this.jobs=new Map();
  }

  async identity() {
    const connection=await this.jira.connect();
    return {site:this.jira.url,project:this.jira.projectKey||'DEMO',user:connection.user.key||connection.user.name};
  }

  async start(records) {
    if([...this.batches.values()].some(batch=>batch.running)) throw jiraError('BUSY','本次提交仍在处理，请查看提交结果。');
    const items=records.map(row=>({...validateRecord(row,{today:this.today()}),id:row.id||randomUUID(),status:'waiting',error:'',worklogId:''}));
    if(!items.length) throw jiraError('EMPTY','请先填写可提交的工时。');
    const scope=await this.identity();
    const state=await this.store.load(scope);
    for(const row of items) if(state.history.some(saved=>saved.id===row.id&&saved.status==='success')) throw jiraError('ALREADY_SUBMITTED','该事项已登记，请查看填报记录。');
    const todoIds=new Set(items.filter(row=>row.todoEntryId).map(row=>row.todoEntryId));
    if(todoIds.size&&state.batches.some(batch=>batch.items.some(row=>todoIds.has(row.todoEntryId)&&['creating','submitting','retrying','uncertain'].includes(row.status)))){
      throw jiraError('UNCERTAIN','待办工时还有上次提交结果未确认，请先核对原批次。');
    }
    await this.checkTodoSources(items);
    const batch={id:randomUUID(),scope,createdAt:new Date().toISOString(),items,running:true};
    this.batches.set(batch.id,batch);
    await this.persist(batch);
    this.launch(batch);
    return structuredClone(batch);
  }

  async getBatch(id) {
    if(this.batches.has(id)) return structuredClone(this.batches.get(id));
    const scope=await this.identity();
    const state=await this.store.load(scope);
    const batch=state.batches.find(row=>row.id===id);
    if(!batch) throw jiraError('NOT_FOUND','找不到当前账号的提交批次。');
    // A lost process may have already written remotely. It must reconcile instead of POSTing again.
    for(const item of batch.items) {
      if(['submitting','retrying','creating'].includes(item.status)) {
        item.status='uncertain';item.code='UNCERTAIN';item.error='上次结果待核对，请先查询 JIRA。';
      }
    }
    batch.running=false;
    this.batches.set(id,batch);
    return structuredClone(batch);
  }

  async wait(id) { await this.jobs.get(id); return this.getBatch(id); }

  /** 只核对已确认的快照，不在用户不知情时改工时后提交。 */
  async checkTodoSources(items) {
    const rows=items.filter(row=>row.todoEntryId);
    if(!rows.length || !this.loadTodoEntries)return;
    const entries=await this.loadTodoEntries();
    for(const row of rows){
      const entry=entries.get(row.todoEntryId);
      if(!entry || entry.todoId!==row.todoId)throw jiraError('TODO_REMOVED','原待办工时已删除，请返回填报刷新。');
      if(entry.state==='submitted')throw jiraError('ALREADY_SUBMITTED','原待办工时已登记，请刷新。');
      const origin=row.todoOrigin||row;
      if(origin.day!==entry.day || origin.hours!==entry.hours || Object.keys(row.todoConflicts||{}).length){
        throw jiraError('TODO_CHANGED','待办工时已变化，请返回填报，重新带入并核对。');
      }
    }
  }

  async retry(batchId,itemId,{allowDuplicate=false}={}) {
    await this.getBatch(batchId);
    const batch=this.batches.get(batchId);
    if(batch.running) throw jiraError('BUSY','批次仍在处理。');
    const scope=await this.identity();
    if(scope.site!==batch.scope.site || scope.user!==batch.scope.user) throw jiraError('IDENTITY','请切回原 JIRA 站点和账号后重试。');
    const item=batch.items.find(row=>row.id===itemId);
    if(!item) throw jiraError('NOT_FOUND','找不到该事项。');
    if(item.status==='deleted') throw jiraError('DELETED','该条填报已删除，无法重试。');
    if(item.status==='success') return structuredClone(batch);
    if(item.status==='duplicate'&&!allowDuplicate) throw jiraError('DUPLICATE','该事项可能已登记，请明确确认重复后再提交。');
    if(allowDuplicate) item.allowDuplicate=true;
    if(item.status==='uncertain') {
      const recovered=await this.reconcile(item);
      if(recovered) {
        this.accept(item,recovered);await this.persist(batch);await this.settle(item);return structuredClone(batch);
      }
      throw jiraError('UNCERTAIN','无法确定上次写入结果，请先在 JIRA 核对。');
    }
    if(batch.returnedToDrafts)throw jiraError('DELETED','这批事项已退回，请重新确认后提交。');
    await this.checkTodoSources([item]);
    if(item.retryable===false && item.status!=='duplicate') throw jiraError(item.code||'INVALID','请返回填报修正后重新确认。');
    item.status='retrying';item.error='';batch.running=true;
    await this.persist(batch);
    this.launch(batch,[item]);
    return structuredClone(batch);
  }

  async returnToDrafts(id) {
    await this.getBatch(id);
    const batch=this.batches.get(id);
    if(batch.running) throw jiraError('BUSY','请等待本次处理完成。');
    if(batch.items.some(row=>row.status==='uncertain'&&row.todoEntryId))throw jiraError('UNCERTAIN','请先核对待办工时的上次提交结果。');
    const candidates=batch.items.filter(row=>!isCompletedItem(row));
    const entries=this.loadTodoEntries&&candidates.some(row=>row.todoEntryId)?await this.loadTodoEntries():null;
    const unfinished=candidates.filter(row=>!entries || !row.todoEntryId || (entries.get(row.todoEntryId)?.todoId===row.todoId&&entries.get(row.todoEntryId).state!=='submitted'));
    await this.store.update(batch.scope,state=>{
      for(const item of unfinished) {
        const {status,error,code,retryable,worklogId,targetId,targetKey,beforeIds,phase,allowDuplicate,duplicates,creationLabel,targetTitle,...record}=item;
        // 自动解析出的父单只是旧批次的去向，退回时按当前工作月重新选，不当作手选需求单。
        if(record.issueSource==='monthly' || (!record.issueSource && phase && selectMonth([{title:record.issueTitle||''}],record.day.slice(0,7)) && isMonthlyType(record.type,false))){
          Object.assign(record,{issue:'',issueTitle:'',issueQuery:'',issueSource:''});
          if(record.subtaskSource==='auto')Object.assign(record,{subtaskKey:'',subtaskTitle:'',subtaskSource:'',createSubtask:true});
        }
        if(entries&&record.todoEntryId)refreshTodoDraft(record,entries.get(record.todoEntryId));
        const index=state.drafts.findIndex(row=>row.id===record.id);
        if(index<0)state.drafts.push(record);else state.drafts[index]=record;
      }
      // Save the return marker with the drafts so restart never reopens their old frozen batch.
      for(const item of candidates.filter(row=>!unfinished.includes(row))){item.status='deleted';item.retryable=false;}
      state.batches.find(row=>row.id===batch.id).items=structuredClone(batch.items);
      state.batches.find(row=>row.id===batch.id).returnedToDrafts=true;
    });
    batch.returnedToDrafts=true;
    this.onUpdate(structuredClone(batch));
    return unfinished.map(row=>row.id);
  }

  /** Delete the remote worklog before removing local history; batch items keep a final marker so later sibling retries cannot restore it. */
  async deleteRecord(id) {
    const scope=await this.identity();
    const state=await this.store.load(scope);
    const record=recordForDeletion(state,id,this.batches,scope.user);
    if(record.worklogId) await this.removeRemoteWorklog(record,scope.user);
    const next=await this.store.update(scope,current=>{
      current.history=current.history.filter(row=>row.id!==id);
      current.drafts=current.drafts.filter(row=>row.id!==id);
      const item=current.batches.find(batch=>batch.id===record.batchId)?.items.find(row=>row.id===id);
      if(item){item.status='deleted';item.error='';item.code='';item.retryable=false;}
    });
    const batch=next.batches.find(row=>row.id===record.batchId);
    if(batch){this.batches.set(batch.id,batch);this.onUpdate(structuredClone(batch));}
    // 待办侧回退为“已记录”，让这条工时可以重新带入；失败同样不影响删除结果。
    if(record.todoId){try{await this.onItemRemoved({...record});}catch{}}
    return {id,batch,remoteDeleted:Boolean(record.worklogId)};
  }

  /** A missing DELETE receipt is resolved by reading the same ID; a failed read never removes the local record. */
  async removeRemoteWorklog(record,user) {
    const issue=record.targetKey||record.issue;
    const current=await this.jira.getWorklog(record.worklogId,issue);
    if(!current)return;
    if(current.author!==user)throw jiraError('IDENTITY','只能删除当前账号自己的 JIRA 工时。');
    try {await this.jira.deleteWorklog(record.worklogId);}
    catch(error){if(!error.uncertain&&error.code!=='NOT_FOUND')throw error;}
    if(await this.jira.getWorklog(record.worklogId,issue))throw jiraError('DELETE_UNCONFIRMED','尚未确认 JIRA 工时已删除，记录已保留，请稍后重试。');
  }

  /** Editing keeps the original worklog and destination; only confirmed remote values replace local history and batch snapshots. */
  async updateRecord(id,changes) {
    const scope=await this.identity();
    const state=await this.store.load(scope);
    const record=recordForEditing(state,id,this.batches,scope.user);
    const details=validateWorkDetails({...record,...Object.fromEntries(['title','day','hours'].filter(key=>Object.hasOwn(changes,key)).map(key=>[key,changes[key]]))},{today:this.today()});
    if(record.worklogId)await this.updateRemoteWorklog(record,details,scope.user);
    const values={title:details.title,day:details.day,hours:details.hours,seconds:details.seconds};
    const next=await this.store.update(scope,current=>{
      Object.assign(current.history.find(row=>row.id===id),values);
      const draft=current.drafts.find(row=>row.id===id);if(draft)Object.assign(draft,values);
      const item=current.batches.find(batch=>batch.id===record.batchId)?.items.find(row=>row.id===id);if(item)Object.assign(item,values);
    });
    const batch=next.batches.find(row=>row.id===record.batchId);
    if(batch){this.batches.set(batch.id,batch);this.onUpdate(structuredClone(batch));}
    return next.history.find(row=>row.id===id);
  }

  async updateRemoteWorklog(record,details,user) {
    const issue=record.targetKey||record.issue,current=await this.jira.getWorklog(record.worklogId,issue);
    if(!current)throw jiraError('NOT_FOUND','JIRA 工时已不存在，无法编辑，请先核对工单。');
    if(current.author!==user)throw jiraError('IDENTITY','只能修改当前账号自己的 JIRA 工时。');
    const expected={...current,title:details.title,day:details.day,seconds:details.seconds};
    // A retry after a lost readback can finish local synchronization without writing the same edit again.
    if(sameWorklog(current,expected))return;
    try{await this.jira.updateWorklog(record.worklogId,details);}
    catch(error){if(!error.uncertain)throw error;}
    const saved=await this.jira.getWorklog(record.worklogId,issue);
    if(!saved||!sameWorklog(saved,expected))throw jiraError('UPDATE_UNCONFIRMED','尚未确认 JIRA 工时已更新，本地记录已保留，请稍后重试。');
  }

  launch(batch,items=batch.items.filter(row=>row.status==='waiting')) {
    const task=this.run(batch,items).catch(async error=>{
      batch.storageError=error.message;batch.running=false;this.onUpdate(structuredClone(batch));
    });
    this.jobs.set(batch.id,task);
  }

  async run(batch,items) {
    for(const item of items) {
      try { await this.process(batch,item); }
      catch(error) {
        item.status=error.uncertain||error.code==='UNCERTAIN'?'uncertain':'failed';
        item.error=error.message;item.code=error.code||'REMOTE';
        item.retryable=!['PERMISSION','FIELDS','NOT_FOUND','INVALID_RECORD','TYPE_MISSING','MONTHLY_FIELDS','TARGET','METADATA'].includes(item.code);
        await this.persist(batch);
        if(item.phase==='creating' || item.code==='AUTH') break;
      }
    }
    batch.running=false;
    await this.persist(batch);
  }

  async process(batch,item) {
    if(!item.targetKey) await this.resolveTarget(batch,item);
    const before=await this.jira.listWorklogs({issue:item.targetKey,day:item.day});
    const matching=before.filter(saved=>saved.author===batch.scope.user&&similarDescription(saved.title,item.title));
    if(matching.length&&!item.allowDuplicate) {
      item.status='duplicate';item.duplicates=matching;item.error='可能重复：'+matching[0].title;item.retryable=false;
      await this.persist(batch);return;
    }
    item.beforeIds=before.map(row=>String(row.id));
    item.status=item.status==='retrying'?'retrying':'submitting';item.phase='writing';await this.persist(batch);
    let result;
    try { result=await this.jira.submitWorklog(item); }
    catch(error) {
      if(error.uncertain||error.code==='UNCERTAIN') {
        result=await this.reconcile(item).catch(()=>null);
        if(!result) throw jiraError('UNCERTAIN','写入结果待核对，请先查看 JIRA。',true);
      } else throw error;
    }
    this.accept(item,result);
    await this.persist(batch);
    // 回写待办的工时状态；失败不能影响已经成功的远端提交。
    await this.settle(item);
  }

  /** 待办侧只是登记状态的展示，任何回写异常都必须吞掉。 */
  async settle(item) {
    if(!item?.todoId || !item.todoEntryId || item.status!=='success') return;
    try { await this.onItemSettled({...item}); }
    catch { /* 已完成的远端工时不受本地待办回写失败影响。 */ }
  }

  accept(item,worklog) {
    item.status='success';item.worklogId=String(worklog.id);item.error='';item.code='';item.retryable=false;
  }

  async reconcile(item) {
    const entries=await this.jira.listWorklogs({issue:item.targetKey,day:item.day});
    const expected={...item,author:this.jira.identity.key||this.jira.identity.name,issue:item.targetKey,typeValue:typeValues[item.type]};
    const candidates=entries.filter(saved=>sameWorklog(saved,expected)&&!item.beforeIds?.includes(String(saved.id)));
    if(item.worklogId) return entries.find(saved=>saved.id===item.worklogId&&sameWorklog(saved,expected))||null;
    return candidates.length===1?candidates[0]:null;
  }

  async resolveTarget(batch,item) {
    // 手填子任务优先：先解析子任务，再由它反推父工单，不新建任何子任务。
    if(item.subtaskKey&&item.subtaskSource!=='auto') return this.resolveChosenSubtask(batch,item);
    let parent;
    if(isMonthlyType(item.type,Boolean(item.issue))) {
      parent=await this.monthlyParent(batch,item);
      item.issueSource='monthly';
    }
    else {
      parent=await this.jira.getIssue(item.issue);
      // 本站点的需求类工单有「新功能(10100)」「故事(10001)」，任务(10002)也允许挂子任务。
      if(!['10001','10100','10002'].includes(String(parent.typeId))||parent.project!==batch.scope.project) throw jiraError('TARGET','该类型的工单不支持创建子任务！');
    }
    item.issue=parent.key;item.issueTitle=parent.title;
    const matching=parent.subtasks.filter(task=>task.title===item.task);
    if(matching.length>1)throw jiraError('TARGET','存在多个同名子任务，请返回填报并指定子任务编号。');
    let [target]=matching;
    // 自动编号是用户确认时看到的提示，远端变更后不能静默换一张单或直接创建。
    if(item.subtaskSource==='auto'&&item.subtaskKey&&target?.key!==item.subtaskKey){
      throw jiraError('TARGET','自动匹配的子任务已变化，请返回填报核对。');
    }
    if(!target) {
      item.status='creating';item.phase='creating';item.creationLabel='正在创建子任务「'+item.task+'」';await this.persist(batch);
      const meta=await this.jira.getCreateMeta('10003');
      const period=monthBounds(item.day);
      const fields={project:{key:batch.scope.project},issuetype:{id:'10003'},parent:{key:parent.key},summary:item.task,assignee:{name:this.jira.identity.name},reporter:{name:this.jira.identity.name},customfield_14600:period.start,duedate:period.end,timetracking:{originalEstimate:'0m',remainingEstimate:'0m'}};
      requireFields(meta,fields);
      try { target=await this.jira.createIssue(fields); }
      catch(error) {
        if(!error.uncertain) throw error;
        const refreshed=await this.jira.getIssue(parent.key);
        const matches=refreshed.subtasks.filter(task=>task.title===item.task);
        if(matches.length!==1) throw jiraError('UNCERTAIN','子任务创建结果待核对。',true);
        [target]=matches;
      }
    }
    item.targetId=target.id;item.targetKey=target.key;item.targetTitle=target.title;item.phase='ready';await this.persist(batch);
  }

  /** 手填子任务：以子任务为准，反推父工单并校验类型，绝不创建。 */
  async resolveChosenSubtask(batch,item) {
    const useMonth=isMonthlyType(item.type,Boolean(item.issue));
    const target=await this.jira.getIssue(item.subtaskKey);
    if(target.typeId!=='10003') throw jiraError('SUBTASK','该编号不是子任务，请核对后再填。');
    if(!target.parent) throw jiraError('SUBTASK','该子任务缺少父工单，无法登记工时。');
    const parent=await this.jira.getIssue(target.parent);
    if(parent.project!==batch.scope.project) throw jiraError('SUBTASK','该子任务不在当前项目中。');
    // 手填为准：只要子任务存在且属于当前项目就直接使用，不再限制父单类型与工时类型匹配。
    item.issue=parent.key;item.issueTitle=parent.title;item.issueSource='subtask';
    // 月度任务且父单确实是综合工时单时才绑定该月，避免把需求故事误绑定为月度工单。
    if(useMonth&&selectMonth([parent],item.day.slice(0,7),batch.scope,this.jira.identity)){
      const state=await this.store.load(batch.scope);
      if(!state.bindings[item.day.slice(0,7)])await this.bindMonth(batch,item.day,parent,'手选子任务');
    }
    item.targetId=target.id;item.targetKey=target.key;item.targetTitle=target.title;item.phase='ready';
    await this.persist(batch);
  }

  async bindMonth(batch,day,issue,source) {
    const month=day.slice(0,7);
    await this.store.update(batch.scope,current=>{current.bindings[month]={month,id:issue.id,key:issue.key,title:issue.title,source};});
  }

  async monthlyParent(batch,item) {
    const month=item.day.slice(0,7);
    const state=await this.store.load(batch.scope);
    const binding=state.bindings[month];
    if(binding) {
      const issue=await this.jira.getIssue(binding.key);
      validateMonthly(issue,batch.scope,this.jira.identity);
      return issue;
    }
    const candidates=await this.jira.searchMonthly();
    let issue=selectMonth(candidates,month,batch.scope,this.jira.identity);
    let source='自动匹配';
    if(!issue) {
      const prior=new Date(month+'-01T00:00:00Z');prior.setUTCMonth(prior.getUTCMonth()-1);
      const template=selectMonth(candidates,prior.toISOString().slice(0,7),batch.scope,this.jira.identity);
      const meta=await this.jira.getCreateMeta('10002');
      if(!template?.tenant||!template.businessLine?.id) throw jiraError('MONTHLY_FIELDS','找不到本人上月的租户和业务线，请先在设置指定月度工单。');
      const allowed=meta.customfield_13801?.allowedValues;
      if(allowed&&!allowed.some(value=>String(value.id)===String(template.businessLine.id))) throw jiraError('MONTHLY_FIELDS','上月业务线已失效，请先配置月度工单。');
      const fields={project:{key:batch.scope.project},issuetype:{id:'10002'},summary:Number(month.slice(0,4))+'年'+Number(month.slice(5))+'月产品综合工时管理',assignee:{name:this.jira.identity.name},reporter:{name:this.jira.identity.name},customfield_10301:String(template.tenant),customfield_13801:{id:String(template.businessLine.id)}};
      requireFields(meta,fields);
      item.status='creating';item.phase='creating';item.creationLabel='正在创建'+fields.summary;await this.persist(batch);
      try { issue=await this.jira.createIssue(fields); }
      catch(error) {
        if(!error.uncertain) throw error;
        issue=selectMonth(await this.jira.searchMonthly(),month,batch.scope,this.jira.identity);
        if(!issue) throw jiraError('UNCERTAIN','月度工单创建结果待核对。',true);
      }
      source='自动创建';
    }
    validateMonthly(issue,batch.scope,this.jira.identity);
    // Persist the created parent before any child/worklog action, so a later failure cannot create it twice.
    await this.bindMonth(batch,item.day,issue,source);
    return issue;
  }

  async persist(batch) {
    await this.store.update(batch.scope,state=>{
      const index=state.batches.findIndex(row=>row.id===batch.id);
      if(index<0)state.batches.push(structuredClone(batch));else state.batches[index]=structuredClone(batch);
      for(const item of batch.items) {
        if(!['success','failed','uncertain'].includes(item.status)) continue;
        const record={...item,batchId:batch.id,source:item.source||'按天填报',author:batch.scope.user,updatedAt:new Date().toISOString()};
        const at=state.history.findIndex(row=>row.id===item.id);
        if(at<0)state.history.push(record);else state.history[at]=record;
        if(item.status==='success')state.drafts=state.drafts.filter(row=>row.id!==item.id);
      }
    });
    this.onUpdate(structuredClone(batch));
  }
}

function recordForDeletion(state,id,batches,user) {
  const record=state.history.find(row=>row.id===id);
  if(!record)throw jiraError('NOT_FOUND','这条填报记录已不存在，请刷新列表。');
  if(record.author!==user)throw jiraError('IDENTITY','只能删除当前账号的填报记录。');
  const batch=batches.get(record.batchId)||state.batches.find(row=>row.id===record.batchId);
  if(batch?.running)throw jiraError('BUSY','本次提交仍在处理，请完成后再删除。');
  if(record.status==='uncertain')throw jiraError('UNCERTAIN','请先核对这条工时的提交结果，再进行删除。');
  return record;
}

function recordForEditing(state,id,batches,user) {
  const record=state.history.find(row=>row.id===id);
  if(!record)throw jiraError('NOT_FOUND','这条填报记录已不存在，请刷新列表。');
  if(record.author!==user)throw jiraError('IDENTITY','只能修改当前账号的填报记录。');
  const batch=batches.get(record.batchId)||state.batches.find(row=>row.id===record.batchId);
  if(batch?.running)throw jiraError('BUSY','本次提交仍在处理，请完成后再编辑。');
  if(record.status==='uncertain')throw jiraError('UNCERTAIN','请先核对这条工时的提交结果，再进行编辑。');
  return record;
}

export function validateMonthly(issue,scope,user) {
 if(!eligibleMonthly(issue,scope,user)) throw jiraError('TARGET','该月度工单不属于当前账号或项目，请在设置中更换。');
}
function eligibleMonthly(issue,scope,user) {
 return issue.project===scope.project&&['10001','10002'].includes(issue.typeId)&&([user.key,user.name].includes(issue.assignee)||issue.assigneeName===user.name);
}
function selectMonth(issues,month,scope,user) {
 const [year,number]=month.split('-').map(Number);
 const expression=new RegExp('(?:^|[^0-9])'+year+'年0?'+number+'月');
 return issues.filter(issue=>expression.test(issue.title)&&/综合.*工时|工时.*综合|月(?:产品)?工时/.test(issue.title)&&(!scope||eligibleMonthly(issue,scope,user))).sort((a,b)=>String(b.created).localeCompare(String(a.created)))[0];
}
function similarDescription(a,b) {
 const tidy=value=>String(value).replace(/[\s\p{P}]/gu,'').toLowerCase();
 const x=tidy(a),y=tidy(b);
 return x===y||Math.min(x.length,y.length)>=8&&(x.includes(y)||y.includes(x));
}
function requireFields(meta,fields) {
 const missing=Object.entries(meta).filter(([name,definition])=>definition.required&&!definition.hasDefaultValue&&fields[name]===undefined);
 if(missing.length) throw jiraError('METADATA','创建工单还需要 '+missing.map(([name,definition])=>definition.name||name).join('、')+'，请先配置。');
}
