import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../app/store.js';
import {BatchImportService} from '../app/batch-import.js';
const scope={site:'https://fixture.invalid',project:'DEMO',user:'test'};
const content='2026-11-09，需求讨论2h；文档整理1h';
const extracted=[{title:'需求讨论',day:'2026-11-09',hours:2,type:'需求分析',startLine:1,endLine:1,evidence:'需求讨论2h',evidenceOccurrence:1},{title:'文档整理',day:null,hours:1.3,type:'',startLine:1,endLine:1,evidence:'文档整理1h',evidenceOccurrence:1}];
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jira-import-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new Store(root);let calls=0;const agent={extract:async()=>{calls++;return structuredClone(extracted);}};const service=new BatchImportService({store,agent,documentsFactory:()=>({read:async()=>content})});return {store,service,agent,calls:()=>calls,config:{notesDirectory:root,agent:{mode:'custom',approvedInternal:true}}};}
test('paste persists whole result, blank missing fields and unrounded hours, restores latest manual draft',async t=>{const f=await fixture(t);const result=await f.service.parse({kind:'paste',content},f.config,scope);assert.equal(result.records.length,2);assert.equal(result.records[1].day,'2026-11-09','同一行日期兜底到该行记录');assert.equal(result.records[1].hours,1.3);assert.equal(result.records[0].sourceText,'需求讨论2h');assert.equal(result.records[0].task,'需求调研及分析');await f.store.update(scope,s=>{s.drafts[0].title='人工标题';});const again=await f.service.parse({kind:'paste',content},f.config,scope);assert.equal(f.calls(),1);assert.equal(again.records[0].title,'人工标题');assert.equal((await f.store.load(scope)).drafts.length,2);});
test('paste 从原文兜底提取 EXEPD 工单与日期，且不覆盖模型已给值',async t=>{
 const f=await fixture(t);
 const text='2026-11-09 需求讨论2h EXEPD-103\n2026年11月10日 文档整理1h EXEPD-104';
 f.agent.extract=async()=>[
  {title:'需求讨论',day:null,hours:2,type:'需求分析',startLine:1,endLine:1,evidence:'需求讨论2h EXEPD-103',evidenceOccurrence:1},
  {title:'文档整理',day:'2026-11-11',hours:1,type:'需求分析',startLine:2,endLine:2,evidence:'文档整理1h EXEPD-104',evidenceOccurrence:1}
 ];
 const result=await f.service.parse({kind:'paste',content:text},f.config,scope);
 assert.equal(result.records[0].issue,'EXEPD-103');
 assert.equal(result.records[0].day,'2026-11-09');
 assert.equal(result.records[1].issue,'EXEPD-104');
 assert.equal(result.records[1].day,'2026-11-11','模型给出的有效日期优先');
 assert.equal(result.records[0].missing.includes('day'),false);
});

test('粘贴日期写在独立标题行时，记录向上继承最近的日期',async t=>{
 const f=await fixture(t);
 const text='2026/11/19\nEXEPD-107 示例项目的报表字段验证, 1.5h\nEXEPD-102 日志工具试验，1h';
 const lines=text.split('\n');
 f.agent.extract=async()=>[
  {title:'示例报表需求验证',day:null,hours:1.5,type:'需求分析',startLine:2,endLine:2,evidence:lines[1],evidenceOccurrence:1},
  {title:'日志工具试验',day:null,hours:1,type:'需求分析',startLine:3,endLine:3,evidence:lines[2],evidenceOccurrence:1}
 ];
 const result=await f.service.parse({kind:'paste',content:text},f.config,scope);
 assert.equal(result.records[0].day,'2026-11-19','应继承上方日期');
 assert.equal(result.records[1].day,'2026-11-19');
 assert.equal(result.records[0].issue,'EXEPD-107');
 assert.equal(result.records[1].issue,'EXEPD-102');
});

test('多段日期按最近的上文日期继承，行内日期优先',async t=>{
 const f=await fixture(t);
 const text='2026/11/18\nEXEPD-1 甲 1h\n2026/11/19\nEXEPD-2 乙 1h\n2026/11/20 EXEPD-3 丙 1h';
 const lines=text.split('\n');
 f.agent.extract=async()=>[
  {title:'甲',day:null,hours:1,type:'需求分析',startLine:2,endLine:2,evidence:lines[1],evidenceOccurrence:1},
  {title:'乙',day:null,hours:1,type:'需求分析',startLine:4,endLine:4,evidence:lines[3],evidenceOccurrence:1},
  {title:'丙',day:null,hours:1,type:'需求分析',startLine:5,endLine:5,evidence:lines[4],evidenceOccurrence:1}
 ];
 const result=await f.service.parse({kind:'paste',content:text},f.config,scope);
 assert.equal(result.records[0].day,'2026-11-18');
 assert.equal(result.records[1].day,'2026-11-19');
 assert.equal(result.records[2].day,'2026-11-20','本行日期优先于上方日期');
});

test('invalid evidence/duplicate position rejects whole batch without writes',async t=>{const f=await fixture(t);for(const records of [[{...extracted[0],evidence:'虚构'}],[extracted[0],extracted[0]]]){f.agent.extract=async()=>records;await assert.rejects(f.service.parse({kind:'paste',content},f.config,scope),/有效|证据/);assert.equal((await f.store.load(scope)).drafts.length,0);}});
test('same source success is excluded, deletion permits restoring base record',async t=>{const f=await fixture(t);const r=await f.service.parse({kind:'paste',content},f.config,scope);await f.store.update(scope,s=>{s.history=r.records.map(x=>({...x,status:'success'}));s.drafts=[];});assert.equal((await f.service.parse({kind:'paste',content},f.config,scope)).outcome,'registered');await f.store.update(scope,s=>{s.history=[];});assert.equal((await f.service.parse({kind:'paste',content},f.config,scope)).records.length,2);});
test('file parsing uses exact preview; stale handle rejects after failed read',async t=>{const f=await fixture(t);const preview=await f.service.read('任意.md',f.config,scope);f.agent.extract=async text=>{assert.equal(text,content);return extracted;};assert.equal((await f.service.parse({kind:'file',sourceId:preview.source.id},f.config,scope)).records.length,2);f.service.documentsFactory=()=>({read:async()=>{throw Error('读取失败');}});await assert.rejects(f.service.read('坏.md',f.config,scope));await assert.rejects(f.service.parse({kind:'file',sourceId:preview.source.id},f.config,scope),/预览/);});
test('legacy whole-line record represents split tasks and keeps original ID and manual fields',async t=>{const f=await fixture(t);const id=createHash('sha256').update('任意.md\n1\n'+content).digest('hex').slice(0,24);await f.store.update(scope,s=>{s.drafts.push({id,title:'原人工整行',sourceFile:'任意.md',sourceLine:1,sourceText:content,day:'2026-11-01',hours:8});});const p=await f.service.read('任意.md',f.config,scope);const result=await f.service.parse({kind:'file',sourceId:p.source.id},f.config,scope);assert.equal(result.records.length,1);assert.equal(result.records[0].id,id);assert.equal(result.records[0].title,'原人工整行');assert.equal((await f.store.load(scope)).drafts.length,1);});
test('model failure and empty result preserve old drafts and snapshot',async t=>{const f=await fixture(t);await f.service.parse({kind:'paste',content},f.config,scope);const before=await f.store.load(scope);f.agent.extract=async()=>{throw Error('识别失败');};await assert.rejects(f.service.parse({kind:'paste',content:content+'\n新增说明'},f.config,scope),/识别失败/);assert.deepEqual(await f.store.load(scope),before);f.agent.extract=async()=>[];assert.equal((await f.service.parse({kind:'paste',content:content+'\n空'},f.config,scope)).outcome,'empty');assert.deepEqual(await f.store.load(scope),before);});
test('same snippet with distinct explicit dates is allowed and model order cannot change identity',async t=>{const f=await fixture(t);const text='11月2日、3日各花2小时整理规格';const rows=['2026-11-02','2026-11-03'].map(day=>({...extracted[0],day,evidence:'整理规格'}));f.agent.extract=async()=>rows;const a=await f.service.parse({kind:'paste',content:text},f.config,scope);await f.store.update(scope,s=>{s.settings.batchImports={};});f.agent.extract=async()=>[...rows].reverse();const b=await f.service.parse({kind:'paste',content:text},f.config,scope);assert.deepEqual(b.records.map(x=>x.id),a.records.map(x=>x.id));assert.equal(new Set(a.records.map(x=>x.id)).size,2);});
test('source directory and account isolate same filename and cached state',async t=>{const f=await fixture(t);const other=await mkdtemp(join(tmpdir(),'jira-other-'));t.after(()=>rm(other,{recursive:true,force:true}));const first=await f.service.read('同名.md',f.config,scope);const a=await f.service.parse({kind:'file',sourceId:first.source.id},f.config,scope);const second=await f.service.read('同名.md',{...f.config,notesDirectory:other},scope);assert.notEqual(first.source.id,second.source.id);const b=await f.service.parse({kind:'file',sourceId:second.source.id},f.config,scope);assert.notEqual(a.records[0].id,b.records[0].id);await assert.rejects(f.service.parse({kind:'file',sourceId:second.source.id},f.config,{...scope,user:'other'}),/预览/);});
test('active original batch is returned without creating new drafts',async t=>{const f=await fixture(t);const r=await f.service.parse({kind:'paste',content},f.config,scope);await f.store.update(scope,s=>{s.batches=[{id:'original',running:false,items:r.records.map(x=>({...x,status:'uncertain'}))}];s.drafts=[];});const again=await f.service.parse({kind:'paste',content},f.config,scope);assert.equal(again.batchId,'original');assert.equal((await f.store.load(scope)).drafts.length,0);});
test('evidence beginning later within a declared range uses its actual source line',async t=>{const f=await fixture(t);f.agent.extract=async()=>[{...extracted[0],startLine:1,endLine:3,evidence:'需求讨论2h'}];const r=await f.service.parse({kind:'paste',content:'说明\n\n需求讨论2h'},f.config,scope);assert.equal(r.records[0].sourceLine,3);});
test('TC-026 adding nonwork prose before same source snippet preserves ID and manual draft',async t=>{const f=await fixture(t);let text=content;f.service.documentsFactory=()=>({read:async()=>text});let p=await f.service.read('记录.md',f.config,scope);const first=await f.service.parse({kind:'file',sourceId:p.source.id},f.config,scope);await f.store.update(scope,s=>{s.drafts[0].title='人工保留标题';s.drafts[0].hours=3;});text='这是说明，不是工作记录\n'+content;f.agent.extract=async()=>extracted.map(x=>({...x,startLine:2,endLine:2}));p=await f.service.read('记录.md',f.config,scope);const next=await f.service.parse({kind:'file',sourceId:p.source.id},f.config,scope);assert.equal(next.records[0].id,first.records[0].id);assert.equal(next.records[0].title,'人工保留标题');assert.equal(next.records[0].hours,3);assert.equal((await f.store.load(scope)).drafts.length,2);});

test('TC-017 evidence outside declared range is rejected even when it exists elsewhere, then exact range recovers',async t=>{
 const f=await fixture(t),text='普通说明\n\n需求讨论2h\n另一段说明';
 await f.store.update(scope,state=>{state.drafts.push({id:'previous',title:'已有人工稿'});});
 const before=await f.store.load(scope);
 f.agent.extract=async()=>[{...extracted[0],startLine:1,endLine:1}];
 await assert.rejects(f.service.parse({kind:'paste',content:text},f.config,scope),{code:'INVALID_EXTRACTION'});
 assert.deepEqual(await f.store.load(scope),before);
 f.agent.extract=async()=>[{...extracted[0],startLine:3,endLine:3}];
 const result=await f.service.parse({kind:'paste',content:text},f.config,scope);
 assert.equal(result.records.length,1);assert.equal(result.records[0].sourceLine,3);
 assert.equal(result.records[0].sourceStart,text.indexOf('需求讨论2h'));
 assert.equal((await f.store.load(scope)).drafts.find(row=>row.id==='previous').title,'已有人工稿');
});

test('粘贴记录只取各自工单，宽证据范围不会串用上一个日期',async t=>{
 const f=await fixture(t);
 const text='2024-02-14\nDEMO-111 甲 1h；DEMO-222 乙 1h；没有工单 1h\n2024-02-15\nDEMO-333 丙 1h';
 f.agent.extract=async()=>['DEMO-111 甲 1h','DEMO-222 乙 1h','没有工单 1h','DEMO-333 丙 1h'].map(evidence=>({...extracted[0],day:'',startLine:1,endLine:4,evidence}));
 const {records}=await f.service.parse({kind:'paste',content:text},f.config,scope);
 assert.deepEqual(records.map(row=>[row.issue,row.day]),[['DEMO-111','2024-02-14'],['DEMO-222','2024-02-14'],['','2024-02-14'],['DEMO-333','2024-02-15']]);
});
