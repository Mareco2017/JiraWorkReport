import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {typeMapping} from './worklogs.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(new Error('Agent 未返回有效的原文证据，请核对内容后重试'),{code:'INVALID_EXTRACTION'});
const normalize=value=>value.replace(/\r\n?/g,'\n');

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
  const records=this.locate(extracted,source,content);
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
 /** Locate exact snippets instead of trusting model array order or invented character offsets. */
 locate(items,source,content){
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
   const day=/^\d{4}-\d{2}-\d{2}$/.test(rawDay)&&!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===rawDay?rawDay:'';
   const hours=item.hours??'',type=item.type;
   return {identityKey:[source.id,rawDay,evidence].join('\n'),title:item.title.trim(),day,hours,type,task:typeMapping[type]||'',issue:'',source:'批量填报',importSourceId:source.id,sourceKind:source.kind,sourceName:source.name,sourceHash:source.contentHash,sourceFile:source.fileName||'',sourceLine:startLine+region.slice(0,position).split('\n').length-1,sourceStart,sourceEnd,sourceText:evidence,missing:[...(!day?['day']:[]),...(hours===''?['hours']:[])],...(rawDay&&!day?{warning:'原文日期无效，请核对'}:{})};
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
