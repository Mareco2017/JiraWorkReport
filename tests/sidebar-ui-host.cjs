const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
require('node:fs').mkdirSync(path.join(process.argv[2],'profile'),{recursive:true});app.setPath('userData',path.join(process.argv[2],'profile'));
app.whenReady().then(async()=>{
 const {Store}=await import('../app/store.js'),{WorkbenchService}=await import('../app/service.js');
 const store=new Store(process.argv[2]);await store.saveConfig({jira:{url:'https://fixture.invalid',username:'fixture-user',keyRef:'fixture'},agent:{engine:'Codex CLI'}});
 let initializeCount=0;const service=new WorkbenchService({store,createJira(){throw Error('Unexpected remote call');}});
 ipcMain.handle('workbench:call',async(_,command,payload)=>{if(command==='initialize')initializeCount++;try{return {ok:true,value:await service.call(command,payload)};}catch(error){return {ok:false,error:error.message,code:error.code,field:error.field};}});
 const win=new BrowserWindow({show:false,width:1250,height:750,webPreferences:{preload:path.resolve('app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const run=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout '+code);};
 const ready={daily:'Boolean(document.querySelector("#description"))',todo:'Boolean(document.querySelector("#newTodo"))&&!document.querySelector("#newTodo").disabled',batch:'Boolean(document.querySelector("#localTab"))',history:'Boolean(document.querySelector("#recordList"))',settings:'Boolean(document.querySelector(".setting-panel"))'};
 async function go(page){await run(`document.querySelector('[data-page=${page}]').click()`);await wait(`document.querySelector('[data-page=${page}]').classList.contains('active') && (${ready[page]})`);await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
 const measure=()=>run(`(()=>{
  const style=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return {font:s.font,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,padding:s.padding,margin:s.margin,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,display:s.display,alignItems:s.alignItems,gap:s.gap,x:r.x,y:r.y,width:r.width,height:r.height};};
  return {sidebar:style(document.querySelector('.sidebar')),brand:style(document.querySelector('.brand')),label:style(document.querySelector('.sidebar>.nav-label')),active:style(document.querySelector('.nav-item.active')),inactive:style(document.querySelector('.nav-item:not(.active)')),bottom:style(document.querySelector('.sidebar-bottom')),box:style(document.querySelector('.statusbox')),rows:[...document.querySelectorAll('.status-row')].map(style),values:[...document.querySelectorAll('.status-value')].map(style)};
 })()`);
 await win.loadFile(path.resolve('app/ui/index.html'));await wait("document.querySelector('.status-value').textContent.includes('fixture-user')");await wait(ready.todo);
 for(const size of [[1250,750],[1024,720]]){
  win.setContentSize(...size);await go('daily');const baseline=await measure();
  if(process.argv[3]==='baseline'){
   await fs.writeFile(path.join(process.argv[2],`daily-${size[0]}.png`),(await win.webContents.capturePage()).toPNG());await fs.writeFile(path.join(process.argv[2],`daily-${size[0]}.json`),JSON.stringify(baseline,null,2));continue;
  }
  await run(`window.sidebarRoot=document.querySelector('.sidebar');window.connectionDot=document.querySelector('.status-value i');window.sidebarChanges=[];new MutationObserver(changes=>window.sidebarChanges.push(...changes.map(c=>c.type))).observe(window.sidebarRoot,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});`);
  for(const page of ['batch','history','todo','settings','daily']){
   await run('window.sidebarChanges.length=0');await go(page);
   const current=await measure();
   // 激活菜单位置依路由变化，比较样式本身；各项几何另由菜单布局约束。
   for(const key of ['active','inactive'])for(const obj of [current,baseline]){delete obj[key].y;}
   assert.deepEqual(current,baseline,`sidebar must match daily on ${page} at ${size}`);
   assert.deepEqual(await run('window.sidebarChanges'),[],`unchanged sidebar must not rebuild on ${page}`);
   assert.equal(await run("document.querySelector('.sidebar')===window.sidebarRoot && document.querySelector('.status-value i')===window.connectionDot"),true);
  }
  const count=initializeCount;await go('daily');assert.equal(initializeCount,count,'active menu click should not refresh');
 }
 if(process.argv[3]!=='baseline'){
  await run('window.sidebarChanges.length=0');
  const config=await store.loadConfig();config.jira.username='fixture-updated';config.agent.engine='DSH CLI';await store.saveConfig(config);
  await go('settings');
  assert.equal(await run("document.querySelector('.status-value').textContent.includes('fixture-updated')"),true);
  assert.equal(await run("document.querySelectorAll('.status-value')[1].textContent.includes('DSH CLI')"),true);
  assert.equal(await run("document.querySelector('.status-value i')===window.connectionDot"),true);
  assert.equal(await run("window.sidebarChanges.includes('childList')"),false,'configuration changes update text without replacing status nodes');
 }
 console.log('SIDEBAR_UI_PASS');win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
