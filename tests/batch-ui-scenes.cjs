/* 开发者UI自查：实际产品renderer，主进程使用虚构资料；不连接模型/JIRA。 */
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 const {typeMapping}=await import('../app/worklogs.js');
 const directory=process.argv[3]||await fs.mkdtemp(path.join(os.tmpdir(),'jira-batch-ui-selfcheck-'));
 let scene='default',batch=null;
 const source={id:'file-key',kind:'file',name:'产品工作记录.md',fileName:'产品工作记录.md',contentHash:'fixturehash'};
 const text='# 产品工作记录\n\n2026-11-09\n- 2.5 小时：梳理报表筛选场景与需求边界\n- 90 分钟：整理需求规格说明\n\n2026-11-10\n- 评审移动审批页面异常流程\n\n未注明日期\n- 1 小时：同步项目进展与风险';
 const rows=()=>['梳理报表筛选场景与需求边界','整理需求规格说明','评审移动审批页面异常流程','同步项目进展与风险'].map((title,i)=>{
  const complete=['editing_ready','summary_ready','submitting','submitted','registered','registered_reopened'].includes(scene),type=['需求分析','规格撰写','需求分析评审','项目管理'][i];
  return {id:'r'+i,title,day:i===3?(complete?'2026-11-10':''):i<2?'2026-11-09':'2026-11-10',hours:i===2?(complete?2:''):[2.5,1.5,0,1][i],type,task:typeMapping[type],issue:i<3&&complete?'DEMO-1024':'',source:'批量填报',importSourceId:source.id,sourceName:source.name,issueTitle:i<3&&complete?'报表筛选体验优化':''};
 });
 const state={drafts:[],history:[],batches:[],settings:{},bindings:{}};
 const issues=[{id:'1',key:'DEMO-1024',title:'报表筛选体验优化',subtasks:[]}];
 ipcMain.handle('workbench:call',async(_,name,payload)=>{
  let value;
  if(name==='initialize')value={config:{notesDirectory:scene==='directory_unconfigured'?'':'/Users/demo/Documents/工作记录',jira:{username:'演示连接'},agent:scene==='agent_unconfigured'?null:{engine:'已配置'}},state,today:'2026-11-10',runtimes:{}};
  else if(name==='listDocuments'){
   if(scene==='directory_failed')return {ok:false,error:'目录不存在',code:'ENOENT'};
   value={files:scene==='directory_empty'?[]:[{id:'work.md',name:source.name,modifiedAt:'2026-11-10T01:30:00Z'},{id:'review.docx',name:'需求评审纪要.docx',modifiedAt:'2026-11-09T09:20:00Z'},{id:'notes.txt',name:'沟通事项.txt',modifiedAt:'2026-11-06T08:10:00Z'},{id:'intro.md',name:'项目说明.md',modifiedAt:'2026-11-05T02:00:00Z'}]};
  }else if(name==='readDocument'){
   if(scene==='read_failed')return {ok:false,error:'文件已移动或暂时无法读取',code:'ENOENT'};
   value={source:scene==='no_records'?{...source,name:'项目说明.md',fileName:'项目说明.md'}:source,content:scene==='no_records'?'# 项目说明\n\n此文档用于介绍项目背景与术语。\n\n## 文件约定\n支持 Markdown、文本和 Word 文档。\n\n这里没有实际工作事项、日期或耗时记录。':text};
  }else if(name==='parseImport'){
   if(scene==='parsing')return new Promise(()=>{});
   if(['parse_failed','paste_failed'].includes(scene))return {ok:false,error:'Agent 识别失败：响应超时。当前内容已保留，请重试。',code:'CLI_TIMEOUT'};
   if(scene==='agent_unconfigured')return {ok:false,error:'尚未配置 Agent。请完成配置后，再解析当前内容。',code:'AGENT_UNCONFIGURED'};
   if(scene==='agent_unverified')return {ok:false,error:'当前模型服务尚未满足内容调用条件，请核对现有 Agent 配置。',code:'DESTINATION_UNVERIFIED'};
   if(['registered','registered_reopened'].includes(scene)){batch={id:'original-batch',items:rows().map((row,i)=>({...row,status:'success',targetKey:'DEMO-1024',worklogId:'existing-'+i})),running:false};value={source,records:[],outcome:'registered',batchId:batch.id};}
   else value={source:payload.kind==='paste'?{...source,id:'paste-key',kind:'paste',name:'手动粘贴内容'}:source,records:scene==='no_records'?[]:rows(),outcome:scene==='no_records'?'empty':'extracted'};
  }else if(name==='searchIssues')value=issues;
  else if(name==='getIssue')value=issues[0];
  else if(name==='saveDraft')value=state;
  else if(name==='startSubmission'){
   batch={id:'fixture-batch',items:payload.records.map((row,i)=>({...row,status:scene==='submitting'?'submitting':'success',targetKey:'DEMO-1024',worklogId:'fixture-'+i})),running:scene==='submitting',createdAt:'2026-11-10T10:00:00Z'};value=batch;
  }else if(name==='getBatch')value=batch;
  else if(name==='chooseNotes')value=null;
  else return {ok:false,error:'fixture unsupported '+name};
  return {ok:true,value};
 });
 const window=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 window.showInactive();
 const errors=[];window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 const run=code=>window.webContents.executeJavaScript(code),action=code=>run('(()=>{'+code+'})()');
 const wait=async code=>{for(let n=0;n<150;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error(scene+' timed out '+code);};
 const scenes=['default','file_selected','directory_unconfigured','directory_empty','directory_failed','directory_dialog','read_failed','paste','paste_empty','paste_invalid','parsing','parse_failed','paste_failed','agent_unconfigured','agent_unverified','no_records','editing','editing_ready','invalid_fields','summary','summary_ready','calendar','hours','issue_candidates','submitting','submitted','registered','registered_reopened'];
 const manifest=[];
 const selectedScenes=process.argv[2]?scenes.filter(value=>process.argv[2].split(',').includes(value)):scenes;
 for(const viewport of [{name:'baseline',width:1250,height:750},{name:'compact',width:1024,height:720}])for(scene of selectedScenes){
  batch=null;window.setContentSize(viewport.width,viewport.height);
  await window.loadFile(path.resolve('app/ui/index.html'));await wait("Boolean(document.querySelector('[data-page=todo].active'))");await action("document.querySelector('[data-page=daily]').click()");await wait("Boolean(document.querySelector('[data-open-batch]'))");
  await action("document.querySelector('[data-page=batch]').click()");await wait("Boolean(document.querySelector('#localTab'))");
  if(!scene.startsWith('directory_')&&!['default','paste_empty','paste','paste_invalid','paste_failed'].includes(scene)){
   await wait("Boolean(document.querySelector('.week-file'))");
   await action("document.querySelector("+JSON.stringify(scene==='no_records'?'.week-file[data-file="intro.md"]':'.week-file')+").click()");
   await wait(scene==='read_failed'?"!document.querySelector('#readError').hidden":scene==='no_records'?"document.querySelector('#previewBody').textContent.includes('项目说明')":"document.querySelector('#previewBody').textContent.includes('梳理报表')");
  }
  if(['paste_empty','paste','paste_invalid','paste_failed'].includes(scene)){
   await action("document.querySelector('#pasteTab').click()");
   if(['paste','paste_failed'].includes(scene))await action("document.querySelector('#pasteInput').value="+JSON.stringify(text)+";document.querySelector('#pasteInput').dispatchEvent(new Event('input'));");
   if(scene==='paste_invalid')await action("document.querySelector('#read').disabled=false;document.querySelector('#read').click()");
  }
  if(['parsing','parse_failed','paste_failed','agent_unconfigured','agent_unverified','no_records','editing','editing_ready','invalid_fields','summary','summary_ready','calendar','hours','issue_candidates','submitting','submitted','registered','registered_reopened'].includes(scene)){
   await action("document.querySelector('#read').click()");
   await wait(scene==='parsing'?"!document.querySelector('#readProgress').hidden":['parse_failed','paste_failed','agent_unconfigured','agent_unverified','no_records','registered','registered_reopened'].includes(scene)?"!document.querySelector('#readError').hidden":"!document.querySelector('#confirmPanel').hidden");
  }
  if(scene==='invalid_fields')await action("const a=document.querySelectorAll('[data-field=title]');a[0].value='';a[0].dispatchEvent(new Event('change'));const h=document.querySelector('[data-field=hours]');h.value='1.3';h.dispatchEvent(new Event('change'));const t=document.querySelectorAll('[data-field=type]')[1];t.value='';t.dispatchEvent(new Event('change'));");
  if(['summary','summary_ready','submitting','submitted'].includes(scene))await action("document.querySelector('#nextReview').click()");
  if(scene==='calendar')await action("document.querySelector('button[data-day]').click()");
  if(scene==='hours')await action("document.querySelector('[data-field=hours]').focus();document.querySelector('[data-field=hours]').click()");
  if(scene==='issue_candidates'){await action("const i=document.querySelector('[data-issue]');i.value='报表';i.dispatchEvent(new Event('input'));");await wait("Boolean(document.querySelector('.issue-results'))");}
  if(['submitting','submitted'].includes(scene)){await action("document.querySelector('#submit').click()");await wait("document.querySelector('#submissionView').open");}
  if(scene==='registered_reopened'){await action("document.querySelector('[data-reopen-batch]').click()");await wait("document.querySelector('#submissionView').open");}
  if(scene==='directory_dialog')await action("document.querySelector('#changeDirectory').click()");
  await new Promise(r=>setTimeout(r,450));
  const file=path.join(directory,scene+'-'+viewport.name+'.png');await fs.writeFile(file,(await window.webContents.capturePage()).toPNG());
  const metrics=await run("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,drawer:{rect:document.querySelector('#submissionView').getBoundingClientRect().toJSON(),transform:getComputedStyle(document.querySelector('#submissionView')).transform,inset:getComputedStyle(document.querySelector('#submissionView')).inset,animation:getComputedStyle(document.querySelector('#submissionView')).animationName}})");
  manifest.push({scene,viewport,file,metrics,nativeChooserException:scene==='directory_dialog'});
 }
 await fs.writeFile(path.join(directory,process.argv[2]?'manifest-targeted.json':'manifest.json'),JSON.stringify({manifest,errors},null,2));
 console.log('UI_SELFCHECK_DIRECTORY '+directory);console.log('SCENES '+manifest.length+' ERRORS '+errors.length);window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
