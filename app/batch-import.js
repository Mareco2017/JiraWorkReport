import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {typeMapping} from './worklogs.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(new Error('Agent 未返回有效的原文证据，请核对内容后重试'),{code:'INVALID_EXTRACTION'});
const normalize=value=>value.replace(/\r\n?/g,'\n');
const todoError=()=>Object.assign(new Error('请选择要载入的已完成待办'),{code:'INVALID_TODOS'});
// 完成日期只取本机日历日，和待办页显示的日期保持一致。
export function todoEntryRecordId(entryId) {return hash('todo-entry\n'+entryId).slice(0,24);}
const projectIssue=(title,project)=>new RegExp('(?:^|[^A-Z0-9_])('+project.replace(/[^A-Z0-9_]/g,'')+'-\\d+)(?![0-9])').exec(String(title||''))?.[1]||'';
const pad2=value=>String(value).padStart(2,'0');
const validIso=(year,month,day)=>{const iso=year+'-'+pad2(month)+'-'+pad2(day),date=new Date(iso+'T12:00:00Z');return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===iso?iso:'';};
function parsePasteDate(text){
 const source=String(text||'');
 const full=/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(source);
 if(full)return validIso(Number(full[1]),Number(full[2]),Number(full[3]));
 const short=/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(source);
 return short?validIso(new Date().getFullYear(),Number(short[1]),Number(short[2])):'';
}
/** 手动粘贴：模型没给出日期/工单时，从该条证据所在原文里兜底提取，用户仍可在确认页修改。 */
function pasteMeta(text,project){
 const source=String(text||'');
 return {issue:projectIssue(source,project)||projectIssue(source,'EXEPD'),day:parsePasteDate(source)};
}

/** Owns preview identity, evidence and atomic draft restoration; it never submits worklogs. */
export class BatchImportService {
 constructor(dependencies){Object.assign(this,dependencies);this.preview=null;}
 clearPreview(){this.preview=null;}
 async read(file,config,scope){
  this.clearPreview();
  if(!config.notesDirectory)throw new Error('请先选择文档所在文件夹');
  const directory=this.documentsFactory(config.notesDirectory);
  const content=await directory.read(file);
  const root=await realpath(config.notesDirectory);
  const source={id:hash(join(root,file)),kind:'file',name:file,fileName:file,contentHash:hash(content)};
  this.preview={source,content,scope:JSON.stringify(scope)};
  return {source,content};
 }
 /** Reuses the exact displayed content; disk changes require a fresh preview. */
 prepare(data,scope){
  if(data.kind==='file'){
   if(!this.preview||data.sourceId!==this.preview.source.id||this.preview.scope!==JSON.stringify(scope))throw new Error('请重新选择文档并预览后解析');
   return this.preview;
  }
  if(data.kind!=='paste'||typeof data.content!=='string'||!data.content.trim())throw new Error('请粘贴需要识别的文字内容');
  const content=normalize(data.content),digest=hash(content);
  return {content,source:{id:hash('paste\n'+digest),kind:'paste',name:'手动粘贴',contentHash:digest}};
 }
 async parse(data,config,scope){
  const {source,content}=this.prepare(data,scope);
  const key=source.id+':'+source.contentHash;
  const state=await this.store.load(scope);
  const cached=state.settings.batchImports?.[key];
  if(cached)return this.restore(cached.source,cached.records,state,scope,'restored');
  if(!config.agent)throw Object.assign(new Error('尚未配置 Agent，请先配置后解析'),{code:'AGENT_UNCONFIGURED'});
  const extracted=await this.agent.extract(content,config.agent);
  const records=this.locate(extracted,source,content,scope.project);
  if(!records.length)return {source,records:[],outcome:'empty'};
  // All evidence is checked before a single Store transaction; failures cannot leave half an import.
  const next=await this.store.update(scope,current=>{
   const base=this.legacyRecords(records,source,content,current);
   (current.settings.batchImports ||= {})[key]={source,records:base};
   this.mergeDrafts(base,current);
  });
  const base=next.settings.batchImports[key].records;
  return this.result(source,base,next,'extracted');
 }
 /** 已完成待办的工时账本：一笔工时生成一条记录，类型留空由用户在第 2 步选择。 */
 async importTodos(data,todos,scope){
  const todoIds=Array.isArray(data?.ids)?data.ids:[];
  const entryIds=Array.isArray(data?.entryIds)?data.entryIds:[];
  if(!todoIds.length&&!entryIds.length)throw todoError();
  for(const list of [todoIds,entryIds]){
   if(list.length>200)throw Object.assign(new Error('一次最多载入 200 笔工时'),{code:'INVALID_TODOS'});
   if(list.some(id=>typeof id!=='string'||!id)||new Set(list).size!==list.length)throw todoError();
  }
  const byId=new Map((todos||[]).map(todo=>[todo.id,todo]));
  const selected=todoIds.length?todoIds.map(id=>byId.get(id)):(todos||[]);
  if(selected.some(todo=>!todo))throw Object.assign(new Error('部分待办已不存在，请重新载入'),{code:'INVALID_TODOS'});
  const project=String(scope.project||'').replace(/[^A-Z0-9_]/g,'');
  const wanted=entryIds.length?new Set(entryIds):null;
  // 只带入未登记的工时笔；已登记的在删除对应填报记录后会自动回到 recorded。
  const entries=[];
  for(const todo of selected){
   for(const entry of todo.workLogs||[]){
    if(entry.state==='submitted')continue;
    if(wanted&&!wanted.has(entry.id))continue;
    entries.push({todo,entry});
   }
  }
  if(wanted&&entries.length!==wanted.size)throw Object.assign(new Error('部分工时记录已不存在或已登记，请刷新后重试'),{code:'INVALID_TODOS'});
  const source={id:'todo',kind:'todo',name:'待办工时',contentHash:hash(entries.map(row=>row.entry.id).sort().join('\n'))};
  if(!entries.length)return {source,records:[],outcome:'registered'};
  entries.sort((a,b)=>String(b.entry.day||'').localeCompare(String(a.entry.day||''))||String(a.todo.title||'').localeCompare(String(b.todo.title||'')));
  const records=entries.map(({todo,entry},index)=>{
   const title=String(todo.title||'').trim();
   const issue=project?projectIssue(title,project):'';
   return {id:todoEntryRecordId(entry.id),todoId:todo.id,todoEntryId:entry.id,title,day:entry.day,hours:entry.hours,type:'',task:'',issue,issueTitle:'',issueQuery:issue,source:'批量填报',importSourceId:'todo:'+todo.id,sourceKind:'todo',sourceName:'已完成待办',sourceHash:source.contentHash,sourceFile:'',sourceLine:index+1,sourceStart:0,sourceEnd:title.length,sourceText:title,missing:['type']};
  });
  const next=await this.store.update(scope,current=>{this.mergeDrafts(records,current);});
  return this.result(source,records,next,'loaded');
 }
 /** Locate exact snippets instead of trusting model array order or invented character offsets. */
 locate(items,source,content,project=''){
  const lines=content.split('\n'),offsets=[];let offset=0;
  for(const line of lines){offsets.push(offset);offset+=line.length+1;}
  const seen=new Set();
  const records=items.map(item=>{
   const {startLine,endLine,evidence,evidenceOccurrence}=item;
   // AgentService has already validated structure; only source-dependent evidence is checked here.
   if(endLine>lines.length)throw invalid();
   const region=lines.slice(startLine-1,endLine).join('\n');let position=-1;
   for(let n=0;n<evidenceOccurrence;n++){position=region.indexOf(evidence,position+1);if(position<0)throw invalid();}
   const sourceStart=offsets[startLine-1]+position,sourceEnd=sourceStart+evidence.length;
   const rawDay=item.day || '',identity=sourceStart+':'+sourceEnd+':'+rawDay;
   if(seen.has(identity))throw invalid();seen.add(identity);
   const parsed=new Date(rawDay+'T12:00:00Z');
   let day=/^\d{4}-\d{2}-\d{2}$/.test(rawDay)&&!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===rawDay?rawDay:'';
   const hours=item.hours??'',type=item.type;
   // 手动粘贴：模型缺日期/工单时按原文兜底提取，结果仍可在确认页修改。
   const meta=source.kind==='paste'?pasteMeta(region,project):{issue:'',day:''};
   if(!day&&meta.day)day=meta.day;
   // 日期常写在记录上方的标题行；本行没有时，向上取最近的日期。
   if(!day&&source.kind==='paste'){
    for(let line=startLine-2;line>=0;line--){
     const found=parsePasteDate(lines[line]);
     if(found){day=found;break;}
    }
   }
   const issue=meta.issue;
   return {identityKey:[source.id,rawDay,evidence].join('\n'),title:item.title.trim(),day,hours,type,task:typeMapping[type]||'',issue,issueQuery:issue,source:'批量填报',importSourceId:source.id,sourceKind:source.kind,sourceName:source.name,sourceHash:source.contentHash,sourceFile:source.fileName||'',sourceLine:startLine+region.slice(0,position).split('\n').length-1,sourceStart,sourceEnd,sourceText:evidence,missing:[...(!day?['day']:[]),...(hours===''?['hours']:[]),...(!type?['type']:[])],...(rawDay&&!day?{warning:'原文日期无效，请核对'}:{})};
  });
  // A preceding explanatory paragraph must not create a second copy of an existing task.
  // Rank repeated snippets in source order, never in model output order or absolute character offsets.
  const occurrences=new Map();
  return records.sort((a,b)=>a.sourceStart-b.sourceStart||a.day.localeCompare(b.day)).map(({identityKey,...row})=>{
   const occurrence=(occurrences.get(identityKey)||0)+1;
   occurrences.set(identityKey,occurrence);
   return {...row,id:hash(identityKey+'\n'+occurrence).slice(0,24)};
  });
 }
 /** A legacy whole-line record may represent several new snippets; preserve its original unit. */
 legacyRecords(records,source,content,state){
  if(source.kind!=='file')return records;
  const lines=content.split('\n'),existing=[...state.drafts,...state.history.filter(x=>x.status==='success'),...state.batches.filter(b=>!b.returnedToDrafts).flatMap(b=>b.items.filter(x=>x.status!=='deleted'))];
  const handled=new Set(),result=[];
  for(const row of records){
   const line=row.sourceLine;
   if(handled.has(line))continue;
   const oldId=hash(source.fileName+'\n'+line+'\n'+lines[line-1]).slice(0,24);
   const old=existing.find(x=>x.id===oldId&&x.sourceFile===source.fileName&&x.sourceLine===line&&x.sourceText===lines[line-1]);
   if(old){handled.add(line);result.push({...old});}
   else result.push(row);
  }
  return result;
 }
 mergeDrafts(records,state){
  for(const row of records){
   const submitted=state.history.some(x=>x.id===row.id&&x.status==='success');
   const active=state.batches.some(b=>!b.returnedToDrafts&&b.items.some(x=>x.id===row.id&&x.status!=='deleted'));
   if(!submitted&&!active&&!state.drafts.some(x=>x.id===row.id))state.drafts.push({...row});
  }
 }
 async restore(source,records,state,scope,outcome){
  const next=await this.store.update(scope,current=>{this.mergeDrafts(records,current);});
  return this.result(source,records,next,outcome);
 }
 result(source,records,state,outcome){
  const ids=new Set(records.map(x=>x.id));
  const batch=state.batches.find(b=>!b.returnedToDrafts&&b.items.some(x=>ids.has(x.id)&&x.status!=='deleted'));
  const pending=records.filter(row=>!state.history.some(x=>x.id===row.id&&x.status==='success')).map(row=>state.drafts.find(x=>x.id===row.id)||row);
  return {source,records:pending,outcome:pending.length?outcome:'registered',...(batch?{batchId:batch.id}:{})};
 }
}
