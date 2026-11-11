import {app,BrowserWindow,ipcMain,dialog,shell,safeStorage} from 'electron';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {access} from 'node:fs/promises';
import {Store} from './store.js';
import {Secrets} from './secrets.js';
import {DocumentDirectory} from './documents.js';
import {JiraClient} from './jira.js';
import {SubmissionService} from './submission.js';
import {AgentService} from './agent.js';
import {WorkbenchService} from './service.js';
import {discoverRuntimes} from './runtimes.js';
import {loadSiteDefaults} from './site-defaults.js';

const directory=dirname(fileURLToPath(import.meta.url));
let window;
app.whenReady().then(async()=>{
const siteDefaults=await loadSiteDefaults(directory);
const dataRoot=app.getPath('userData');
const store=new Store(dataRoot);
const config=await store.loadConfig();
if(!config.notesDirectory && siteDefaults.notesRelativeDirectory){
  const folder=join(app.getPath('documents'),siteDefaults.notesRelativeDirectory,new Date().getFullYear()+'工作安排');
  try{await access(folder);config.notesDirectory=folder;await store.saveConfig(config);}catch{}
}
const secrets=new Secrets(join(dataRoot,'credentials'),safeStorage);
const agent=new AgentService({secrets});
const service=new WorkbenchService({
  store,secrets,agent,
  discoverRuntimes:()=>discoverRuntimes({home:app.getPath('home')}),
  defaultProject:siteDefaults.projectKey,
  // 真实事项只交给本机配置中已核实的模型来源；公开示例不信任任何网关。
  trustedModelOrigins:siteDefaults.trustedModelOrigins,
  createJira: config=>new JiraClient(config),
  createSubmission: jira=>new SubmissionService({store,jira,onUpdate:batch=>window?.webContents.send('workbench:update',batch)}),
  documentsFactory: directory=>new DocumentDirectory({directory}),
  chooseDirectory: async()=>{
    const selected=await dialog.showOpenDialog(window,{properties:['openDirectory']});
    return selected.canceled ? null : selected.filePaths[0];
  },
  chooseExecutable: async()=>{
    const selected=await dialog.showOpenDialog(window,{properties:['openFile']});
    return selected.canceled ? null : selected.filePaths[0];
  },
  openExternal: url=>shell.openExternal(url)
});
async function createWindow(){
window=new BrowserWindow({width:1250,height:750,minWidth:1024,minHeight:720,title:'JIRA工时填报',backgroundColor:'#fff',webPreferences:{preload:join(directory,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',event=>event.preventDefault());
await window.loadFile(join(directory,'ui/index.html'));
}
app.on('activate',()=>{if(!window || window.isDestroyed())createWindow();else window.show();});
ipcMain.handle('workbench:call',async(event,command,payload)=>{
  if(event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame) throw new Error('不支持的页面来源');
  try{return {ok:true,value:await service.call(command,payload)};}
  catch(error){return {ok:false,error:error.message,code:error.code,field:error.field};}
});
await createWindow();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
