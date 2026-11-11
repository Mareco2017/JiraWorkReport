/* 实际 renderer/preload 的隔离 UI 测试；仅替换主进程动作，不访问模型或 JIRA。 */
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
app.whenReady().then(async()=>{
 const record={id:'r1',title:'梳理需求',day:'2026-11-09',hours:2,type:'需求分析',task:'需求调研及分析',issue:'DEMO-100' ,source:'批量填报',importSourceId:'file-key'};
 const state={drafts:[],history:[],batches:[],settings:{},bindings:{}};
 const commands=[];let parseFailure=false,registered=false,legacyInitial=false,suspendParse=false,releaseParse=null;const recoveryBatches=new Map();let resubmission=0;
 ipcMain.handle('workbench:call',async(_,name,payload)=>{
  commands.push({name,payload});let value;
  if(name==='initialize')value={config:{notesDirectory:'/fictional/documents',commonTypes:[]},state,today:'2026-11-10',runtimes:{}};
  else if(name==='listDocuments')value={files:[{id:'work.md',name:'work.md',extension:'.md',modifiedAt:'2026-11-10T00:00:00Z'}]};
  else if(name==='readDocument')value={source:{id:'file-key',kind:'file',name:'work.md',contentHash:'hash1',fileName:'work.md'},content:'2026-11-09 花2小时梳理需求'};
  else if(name==='parseImport'){
   if(suspendParse)await new Promise(resolve=>{releaseParse=resolve;});
   if(parseFailure)return {ok:false,error:'Agent 识别超时，当前内容已保留，请重试。',code:'CLI_TIMEOUT'};
   const paste=payload.kind==='paste';
   const source={id:paste?'paste-key':'file-key',kind:payload.kind,name:paste?'手动粘贴内容':'work.md',contentHash:paste?'hash2':'hash1'};
   if(registered)return {ok:true,value:{source,records:[],outcome:'registered',batchId:'original-batch'}};
   const rows=[legacyInitial?{...record,id:createHash('sha256').update('work.md\n4\n2h 梳理需求').digest('hex').slice(0,24),importSourceId:undefined,sourceFile:'work.md'}:{...record,id:paste?'p1':'r1',importSourceId:source.id}];state.drafts=rows;value={source,records:rows,outcome:'extracted'};
  }else if(name==='getBatch')value=recoveryBatches.get(payload.id)||{id:'original-batch',running:false,items:[{...record,id:'p1',importSourceId:'paste-key',status:'success',worklogId:'fixture-existing'}]};
  else if(name==='retry')value=recoveryBatches.get(payload.batchId);
  else if(name==='returnToDrafts'){const batch=recoveryBatches.get(payload.batchId);batch.returnedToDrafts=true;state.drafts=batch.items.map(item=>({...item}));value=state;}
  else if(name==='startSubmission'){value={id:'resubmitted-'+(++resubmission),running:false,items:payload.records.map(item=>({...item,status:'success',worklogId:'recovered-worklog'}))};recoveryBatches.set(value.id,value);state.batches.push(value);}
  else if(name==='saveDraft'){const index=state.drafts.findIndex(row=>row.id===payload.record.id);if(index>=0)state.drafts[index]=payload.record;value=state;}
  else return {ok:false,error:'unexpected '+name};
  return {ok:true,value};
 });
 const window=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 await window.loadFile(path.resolve('app/ui/index.html'));
 const run=code=>window.webContents.executeJavaScript(code);
 const wait=async code=>{for(let n=0;n<100;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('UI wait failed: '+code);};
 await wait("Boolean(document.querySelector('[data-page=todo].active'))");await run("document.querySelector('[data-page=daily]').click()");await wait("Boolean(document.querySelector('[data-open-batch]'))");
 await run("document.querySelector('[data-page=batch]').click()");
 await wait("Boolean(document.querySelector('#localTab'))");
 assert.equal(await run("document.querySelector('#read').disabled"),true);
 await wait("Boolean(document.querySelector('.week-file'))");
 await run("document.querySelector('.week-file').click()");
 await wait("document.querySelector('#previewBody').textContent.includes('花2小时')");
 parseFailure=true;
 await run("document.querySelector('#read').click()");
 await wait("!document.querySelector('#readError').hidden");
 assert.match(await run("document.querySelector('#readError').textContent"),/超时/);
 assert.match(await run("document.querySelector('#previewBody').textContent"),/花2小时/);
 assert.equal(await run("document.querySelector('#confirmPanel').hidden"),true);
 parseFailure=false;
 await run("document.querySelector('#read').click()");
 await wait("!document.querySelector('#confirmPanel').hidden");
 await run("var h=document.querySelector('[data-field=hours]');h.value='';h.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-field=hours]').classList.contains('missing')");
 assert.equal(await run("document.querySelector('[data-field=hours]').classList.contains('invalid')"),false);
 assert.equal(await run("getComputedStyle(document.querySelector('[data-field=hours]')).backgroundColor"),'rgb(255, 248, 236)');
 await run("var h=document.querySelector('[data-field=hours]');h.value='1.3';h.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-field=hours]').nextElementSibling?.textContent.includes('0.5h倍数')");
 assert.equal(await run("document.querySelector('[data-field=hours]').classList.contains('invalid')"),true);
 assert.equal(await run("document.querySelector('[data-field=hours]').classList.contains('missing')"),false);
 assert.equal(await run("getComputedStyle(document.querySelector('[data-field=hours]')).borderTopColor"),'rgb(198, 120, 102)');
 assert.equal(await run("getComputedStyle(document.querySelector('[data-field=hours]')).backgroundColor"),'rgb(255, 255, 255)');
 assert.match(await run("document.querySelector('[data-field=hours]').nextElementSibling.textContent"),/0.5h倍数/);
 await run("document.querySelector('#nextReview').click()");
 assert.equal(await run("document.querySelector('#submit').disabled"),true);
 await run("document.querySelector('#editAgain').click();var h=document.querySelector('[data-field=hours]');h.value='2';h.dispatchEvent(new Event('change'));");
 await wait("!document.querySelector('[data-field=hours]').classList.contains('missing')");
 await run("var type=document.querySelector('[data-field=type]');type.value='';type.dispatchEvent(new Event('change'));");
 await wait("document.querySelector('[data-field=type]').classList.contains('missing')");
 assert.equal(await run("document.querySelector('[data-task]').textContent"),'选择工时类型');
 await run("var type=document.querySelector('[data-field=type]');type.value='需求分析';type.dispatchEvent(new Event('change'));");
 await wait("!document.querySelector('[data-field=type]').classList.contains('missing')");
 await run("const t=document.querySelector('[data-field=title]');t.value='';t.dispatchEvent(new Event('change'));");
 await run("document.querySelector('#back').click();document.querySelector('.week-file').click()");
 await wait("document.querySelector('#previewBody').textContent.includes('花2小时')");
 await run("document.querySelector('#read').click()");
 await wait("!document.querySelector('#confirmPanel').hidden");
 assert.equal(await run("document.querySelector('[data-field=title]').value"),'');
 assert.equal(await run("document.querySelector('[data-field=title]').classList.contains('missing')"),true);
 assert.equal(commands.filter(c=>c.name==='saveDraft'&&c.payload.record.title==='').length,0);
 await run("document.querySelector('button[data-day]').click()");
 assert.equal(await run("Boolean(document.querySelector('.row-calendar'))"),true,JSON.stringify({errors,toast:await run("document.querySelector('#toast').textContent")}));
 await run("document.querySelector('.row-calendar [data-prev]').click()");
 assert.match(await run("document.querySelector('.row-calendar .calendar-nav strong').textContent"),/10月/);
 await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
 assert.equal(await run("Boolean(document.querySelector('.row-calendar'))"),false);
 await run("document.querySelector('#back').click();document.querySelector('#pasteTab').click()");
 assert.equal(await run("document.querySelector('#read').disabled"),true);
 await run("const p=document.querySelector('#pasteInput');p.value='手动内容';p.dispatchEvent(new Event('input'));document.querySelector('#read').click()");
 await wait("!document.querySelector('#confirmPanel').hidden");
 assert.equal(commands.filter(c=>c.name==='parseImport').at(-1).payload.content,'手动内容');
 assert.equal(commands.some(c=>['listNotes','readNote','parseNote','suggest'].includes(c.name)),false);
 registered=true;
 await run("document.querySelector('#back').click();document.querySelector('#read').click()");
 await wait("!document.querySelector('#readError').hidden");
 assert.match(await run("document.querySelector('#readError').textContent"),/已全部登记/);
 assert.equal(await run("[...document.querySelectorAll('#choosePanel button')].some(button=>button.textContent==='查看本次提交'&&button.getBoundingClientRect().height>0)"),true);
 await run("[...document.querySelectorAll('#choosePanel button')].find(button=>button.textContent==='查看本次提交').click()");
 await wait("document.querySelector('#submissionView').open");
 assert.match(await run("document.querySelector('#submissionView').textContent"),/fixture-existing/);
 assert.equal(commands.some(command=>command.name==='startSubmission'),false);
 assert.ok(commands.filter(command=>command.name==='getBatch'&&command.payload.id==='original-batch').length>=2);
 await run("document.querySelector('#submissionView .result-close').click()");
 // 旧ID草稿首次导入没有旧批次，新返回批次仍须挂到本次确切来源，而非从记录文件名推定。
 registered=false;legacyInitial=true;
 await run("document.querySelector('#localTab').click();document.querySelector('.week-file').click()");
 await wait("document.querySelector('#previewBody').textContent.includes('花2小时')");
 await run("document.querySelector('#read').click()");
 await wait("!document.querySelector('#confirmPanel').hidden");
 await run("document.querySelector('#nextReview').click();document.querySelector('#submit').click()");
 await wait("document.querySelector('#submissionView').open");
 await run("document.querySelector('#submissionView .result-close').click();document.querySelector('[data-page=history]').click()");
 await wait("Boolean(document.querySelector('#recordList'))");
 await run("document.querySelector('[data-page=batch]').click()");
 await wait("Boolean(document.querySelector('#reviewPanel'))&&!document.querySelector('#reviewPanel').hidden");
 assert.equal(await run("document.querySelector('#submit').textContent"),'查看本次提交','legacy ID first import keeps the newly created batch at exact request source');
 const submittedLegacy=commands.filter(command=>command.name==='startSubmission').at(-1).payload.records[0];
 assert.equal(submittedLegacy.importSourceId,undefined);assert.equal(submittedLegacy.sourceFile,'work.md');
 legacyInitial=false;
 for(const [caseName,metadata] of [
  ['legacy',{importSourceId:undefined,sourceFile:'11月第1周.md'}],
  ['new-file',{importSourceId:'recovered-file',sourceKind:'file',sourceName:'恢复文档.md',sourceHash:'recovered-hash',sourceFile:'恢复文档.md'}],
  ['new-paste',{importSourceId:'recovered-paste',sourceKind:'paste',sourceName:'手动粘贴内容',sourceHash:'recovered-paste-hash'}]
 ]){
  const failed={...record,...metadata,id:caseName+'-row',status:'failed',error:'待修正后提交',batchId:caseName+'-batch',retryable:true};
  const original={id:failed.batchId,running:false,items:[failed]};recoveryBatches.set(original.id,original);state.history=[failed];state.batches.push(original);
  await run("document.querySelector('[data-page=history]').click()");
  await wait("Boolean(document.querySelector('[data-record-open]'))");
  await run("document.querySelector('[data-record-open]').click()");
  await wait("document.querySelector('#submissionView').open");
  await run("document.querySelector('#submissionView [data-return]').click()");
  await wait("Boolean(document.querySelector('#confirmPanel'))&&!document.querySelector('#confirmPanel').hidden");
  assert.equal(await run("document.querySelector('#sourceName').textContent"),metadata.sourceName||metadata.sourceFile);
  await run("document.querySelector('#back').click()");
  assert.equal(await run("document.querySelector('#read').disabled"),true,caseName+' must not parse another source preview');
  assert.equal(await run("document.querySelector('#previewBody').textContent.includes('花2小时')"),false);
  assert.equal(await run("document.querySelector('#pasteInput').value"),'');
  assert.equal(await run("document.querySelector('#pasteSource').hidden"),metadata.sourceKind!=='paste');
  await run("document.querySelector('#step2').click()");
  await run("document.querySelector('#nextReview').click();document.querySelector('#submit').click()");
  await wait("document.querySelector('#submissionView').open");
  assert.match(await run("document.querySelector('#submissionView').textContent"),/recovered-worklog/);
  await run("document.querySelector('#submissionView .result-close').click()");
  assert.equal(await run("document.querySelector('#submit').textContent"),'查看本次提交',caseName);
  assert.equal(commands.filter(command=>command.name==='startSubmission').at(-1).payload.records[0].importSourceId,metadata.importSourceId,caseName);
 }
 // 正常导航离开不会取消识别；后台结束后，缓存批量页必须恢复真实成功或失败状态。
 for(const outcome of ['success','failure']){
  parseFailure=outcome==='failure';suspendParse=true;releaseParse=null;const existingDrafts=structuredClone(state.drafts);
  await run("document.querySelector('#step1').click();document.querySelector('#localTab').click();document.querySelector('.week-file').click()");
  await wait("document.querySelector('#previewBody').textContent.includes('花2小时')");
  await run("document.querySelector('#read').click()");
  await wait("!document.querySelector('#readProgress').hidden");
  for(let n=0;!releaseParse&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(releaseParse);
  await run("document.querySelector('[data-page=history]').click()");
  await wait("Boolean(document.querySelector('#recordList'))");
  releaseParse();suspendParse=false;
  await new Promise(resolve=>setTimeout(resolve,150));
  await run("document.querySelector('[data-page=batch]').click()");
  await wait("Boolean(document.querySelector('#read'))");
  assert.equal(await run("document.querySelector('#read').hidden"),false,outcome+' completed background parse must restore button');
  assert.equal(await run("document.querySelector('#readProgress').hidden"),true,outcome+' completed background parse must clear spinner');
  assert.match(await run("document.querySelector('#previewBody').textContent"),/花2小时/);
  if(outcome==='success')assert.equal(await run("document.querySelector('#confirmPanel').hidden"),false);
  else {assert.deepEqual(state.drafts,existingDrafts);assert.equal(await run("document.querySelector('#choosePanel').hidden"),false);assert.match(await run("document.querySelector('#readError').textContent"),/超时/);assert.equal(await run("document.querySelector('#read').disabled"),false);}
 }
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('BATCH_UI_PASS');window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
