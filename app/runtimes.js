import {access,readdir} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {constants} from 'node:fs';

// 检查现有安装，不安装程序或改写用户 PATH；用于减少首次选择 CLI 的操作。
export async function discoverRuntimes({home,platform=process.platform,path=process.env.PATH||'',appData=process.env.APPDATA,probe=access,listDirectory=readdir}){
 const windows=platform==='win32',paths=windows?win32:{join};
 const folders=path.split(windows?';':':').filter(Boolean).map(folder=>folder.replace(/^"(.*)"$/,'$1'));
 const candidates={};
 for(const [engine,command] of [['Codex CLI','codex'],['DSH CLI','dsh']]){
  // 从桌面打开时 PATH 可能不含用户 npm 目录；只补查位置，不改系统配置。
  const searchFolders=[...folders,paths.join(home,'.local','bin')];
  if(windows)searchFolders.push(paths.join(appData||paths.join(home,'AppData','Roaming'),'npm'));
  candidates[engine]=searchFolders.flatMap(folder=>(windows?['.exe','.com','.cmd','.bat']:['']).map(extension=>paths.join(folder,command+extension)));
 }
 if(platform==='darwin'){
  candidates['DSH CLI'].unshift('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  try{
   const versions=await listDirectory(join(home,'.nvm','versions','node'));
   for(const version of versions.sort().reverse())candidates['Codex CLI'].push(join(home,'.nvm','versions','node',version,'bin','codex'));
  }catch{}
 }
 const found={};
 for(const [engine,paths] of Object.entries(candidates)){
  for(const file of paths){
   try{await probe(file,windows?constants.F_OK:constants.X_OK);found[engine]=file;break;}catch{}
  }
 }
 return found;
}
