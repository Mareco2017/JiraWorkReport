/* Actual Electron renderer + preload, backed by a temporary, controlled service.
   This host cannot send any request to the real JIRA instance. */
const {app,BrowserWindow,ipcMain,dialog,safeStorage}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
app.whenReady().then(async()=>{
 const {Store}=await import('../app/store.js');
 const {Secrets}=await import('../app/secrets.js');
 const {WorkbenchService}=await import('../app/service.js');
 const {SubmissionService}=await import('../app/submission.js');
 const {WeekNotes}=await import('../app/week-notes.js');
 const {typeMapping,typeValues}=await import('../app/worklogs.js');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'jira-product-e2e-'));
 const store=new Store(directory),secrets=new Secrets(path.join(directory,'credentials'),safeStorage);
 const ref=await secrets.put('fictional-token');
 const notes=path.join(directory,'notes');await fs.mkdir(notes);
 await fs.writeFile(path.join(notes,'2月第3周.md'),'weekStart: 2024-02-12\n## 本周工时记录\n周一：\n2.5h 梳理报表筛选需求\n1.5h 评审报表异常交互\n周二：\n2h 编写需求规格\n## 本周待办事项\n无关链接 DEMO-999\n');
 await store.saveConfig({jira:{url:'https://fixture.invalid',username:'tester',userKey:'tester',timeZone:'Asia/Shanghai',keyRef:ref},notesDirectory:notes});
 let worklogs=[],counter=100;
 const issues=[
  {id:'1',key:'DEMO-100',title:'报表筛选体验优化',project:'DEMO',typeId:'10001',assignee:'tester',assigneeName:'tester',created:'2024-02-01',subtasks:[]},
  {id:'2',key:'DEMO-200',title:'2024年1月产品综合工时管理',project:'DEMO',typeId:'10002',assignee:'tester',assigneeName:'tester',created:'2024-01-01',tenant:'888',businessLine:{id:'1'},subtasks:[]},
  {id:'3',key:'DEMO-300',title:'2024年2月综合工时',project:'DEMO',typeId:'10001',assignee:'tester',assigneeName:'tester',created:'2024-02-01',subtasks:[]}
 ];
 const jira={
  url:'https://fixture.invalid',projectKey:'DEMO',identity:{name:'tester',key:'tester',timeZone:'Asia/Shanghai'},
  project:{id:'1',key:'DEMO'},
  types:Object.entries(typeValues).map(([name,value])=>({name,value,id:3,key:'_产品工时类型_'})),
  async connect(){return {user:this.identity,project:this.project,types:this.types};},
  async listTypes(){return this.types;},
  async searchIssues(query){return issues.filter(row=>row.typeId==='10001'&&(row.key+' '+row.title).includes(query));},
  async searchMonthly(query=''){return issues.filter(row=>['10001','10002'].includes(row.typeId)&&(query?(row.key+' '+row.title).includes(query):row.title.includes('工时')));},
  async getIssue(key){const row=issues.find(row=>row.key===key);if(!row)throw Error('工单不存在');return structuredClone(row);},
  async getCreateMeta(){return {};},
  async createIssue(fields){
   const parent=issues.find(row=>row.key===fields.parent?.key||row.id===fields.parent?.id);
   const row={id:String(++counter),key:'DEMO-'+counter,title:fields.summary,project:'DEMO',typeId:fields.issuetype.id,assignee:'tester',assigneeName:'tester',created:'2024-02-01',subtasks:[],...{tenant:fields.customfield_10301,businessLine:fields.customfield_13801}};
   issues.push(row);if(parent)parent.subtasks.push({id:row.id,key:row.key,title:row.title});return structuredClone(row);
  },
  async listWorklogs({issue,day}){return worklogs.filter(row=>row.issue===issue&&(!day||row.day===day));},
  async submitWorklog(item){
   const row={id:String(++counter),issue:item.targetKey,day:item.day,seconds:item.seconds,title:item.title,author:'tester',typeValue:typeValues[item.type]};worklogs.push(row);return row;
  },
  async getWorklog(id){return worklogs.find(row=>row.id===id);},
  async updateWorklog(id,record){const row=worklogs.find(row=>row.id===id);Object.assign(row,{title:record.title,day:record.day,seconds:record.seconds});},
  async deleteWorklog(id){worklogs=worklogs.filter(row=>row.id!==id);}
 };
 let window;
 const service=new WorkbenchService({
  store,secrets,agent:{async test(){return {ok:true};},async suggest(records){return records.map(row=>({id:row.id,type:'需求分析',task:typeMapping['需求分析']}));}},
  createJira:()=>jira,createSubmission:jira=>new SubmissionService({store,jira,today:()=> '2024-02-20',onUpdate:batch=>window.webContents.send('workbench:update',batch)}),
  today:()=> '2024-02-20',notesFactory:directory=>new WeekNotes({directory}),chooseDirectory:async()=>notes,chooseExecutable:async()=>'/fixture/cli',openExternal:async url=>{console.log('Fixture opened URL '+url);}
 });
 window=new BrowserWindow({width:1280,height:800,webPreferences:{preload:path.resolve('app/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 ipcMain.handle('workbench:call',async(_,name,payload)=>{try{return {ok:true,value:await service.call(name,payload)};}catch(error){return {ok:false,error:error.message,code:error.code,field:error.field};}});
 await window.loadFile(path.resolve('app/ui/index.html'));
 console.log('Controlled test data directory '+directory);
});
app.on('window-all-closed',()=>app.quit());
