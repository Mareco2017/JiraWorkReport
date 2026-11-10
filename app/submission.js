import {randomUUID} from 'node:crypto';
import {validateRecord,validateWorkDetails,monthBounds,monthlyTasks,typeValues,isCompletedItem} from './worklogs.js';
import {jiraError,sameWorklog} from './jira.js';

/** Both entry flows share this coordinator; UI closure never owns the lifetime of a batch. */
export class SubmissionService {
  constructor({store,jira,onUpdate=()=>{},today=()=>new Date().toLocaleDateString('sv-SE')}) {
    Object.assign(this,{store,jira,onUpdate,today});
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
        this.accept(item,recovered);await this.persist(batch);return structuredClone(batch);
      }
      throw jiraError('UNCERTAIN','无法确定上次写入结果，请先在 JIRA 核对。');
    }
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
    const unfinished=batch.items.filter(row=>!isCompletedItem(row));
    await this.store.update(batch.scope,state=>{
      for(const item of unfinished) {
        const {status,error,code,retryable,worklogId,targetId,targetKey,beforeIds,...record}=item;
        const index=state.drafts.findIndex(row=>row.id===record.id);
        if(index<0)state.drafts.push(record);else state.drafts[index]=record;
      }
      // Save the return marker with the drafts so restart never reopens their old frozen batch.
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
    let parent;
    if(monthlyTasks.includes(item.task)) parent=await this.monthlyParent(batch,item);
    else {
      parent=await this.jira.getIssue(item.issue);
      if(parent.typeId!=='10001'||parent.project!==batch.scope.project) throw jiraError('TARGET','请选择本项目的需求故事。');
    }
    item.issue=parent.key;item.issueTitle=parent.title;
    let target=parent.subtasks.find(task=>task.title===item.task);
    if(!target) {
      item.status='creating';item.phase='creating';item.creationLabel='正在创建子任务「'+item.task+'」';await this.persist(batch);
      const meta=await this.jira.getCreateMeta('10003');
      const period=monthBounds(item.day);
      const fields={project:{key:batch.scope.project},issuetype:{id:'10003'},parent:{key:parent.key},summary:item.task,assignee:{name:this.jira.identity.name},customfield_14600:period.start,duedate:period.end,timetracking:{originalEstimate:'0m',remainingEstimate:'0m'}};
      requireFields(meta,fields);
      try { target=await this.jira.createIssue(fields); }
      catch(error) {
        if(!error.uncertain) throw error;
        const refreshed=await this.jira.getIssue(parent.key);
        target=refreshed.subtasks.find(task=>task.title===item.task);
        if(!target) throw jiraError('UNCERTAIN','子任务创建结果待核对。',true);
      }
    }
    item.targetId=target.id;item.targetKey=target.key;item.phase='ready';await this.persist(batch);
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
    let issue=selectMonth(candidates,month);
    let source='自动匹配';
    if(!issue) {
      const prior=new Date(month+'-01T00:00:00Z');prior.setUTCMonth(prior.getUTCMonth()-1);
      const template=selectMonth(candidates,prior.toISOString().slice(0,7));
      const meta=await this.jira.getCreateMeta('10002');
      if(!template?.tenant||!template.businessLine?.id) throw jiraError('MONTHLY_FIELDS','找不到本人上月的租户和业务线，请先在设置指定月度工单。');
      const allowed=meta.customfield_13801?.allowedValues;
      if(allowed&&!allowed.some(value=>String(value.id)===String(template.businessLine.id))) throw jiraError('MONTHLY_FIELDS','上月业务线已失效，请先配置月度工单。');
      const fields={project:{key:batch.scope.project},issuetype:{id:'10002'},summary:Number(month.slice(0,4))+'年'+Number(month.slice(5))+'月产品综合工时管理',assignee:{name:this.jira.identity.name},customfield_10301:String(template.tenant),customfield_13801:{id:String(template.businessLine.id)}};
      requireFields(meta,fields);
      item.status='creating';item.phase='creating';item.creationLabel='正在创建'+fields.summary;await this.persist(batch);
      try { issue=await this.jira.createIssue(fields); }
      catch(error) {
        if(!error.uncertain) throw error;
        issue=selectMonth(await this.jira.searchMonthly(),month);
        if(!issue) throw jiraError('UNCERTAIN','月度工单创建结果待核对。',true);
      }
      source='自动创建';
    }
    validateMonthly(issue,batch.scope,this.jira.identity);
    // Persist the created parent before any child/worklog action, so a later failure cannot create it twice.
    await this.store.update(batch.scope,current=>{current.bindings[month]={month,id:issue.id,key:issue.key,title:issue.title,source};});
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
 if(issue.project!==scope.project||!['10001','10002'].includes(issue.typeId)||![user.key,user.name].includes(issue.assignee)&&issue.assigneeName!==user.name) throw jiraError('TARGET','该月度工单不属于当前账号或项目，请在设置中更换。');
}
function selectMonth(issues,month) {
 const [year,number]=month.split('-').map(Number);
 const expression=new RegExp('(?:^|[^0-9])'+year+'年0?'+number+'月');
 return issues.filter(issue=>expression.test(issue.title)&&/综合.*工时|工时.*综合|月(?:产品)?工时/.test(issue.title)).sort((a,b)=>String(b.created).localeCompare(String(a.created)))[0];
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
