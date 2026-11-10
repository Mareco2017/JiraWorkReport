import {packager} from '@electron/packager';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename,dirname,resolve} from 'node:path';
import {rm} from 'node:fs/promises';

const platform=process.argv[2],arch=process.argv[3];
if(!['darwin','win32'].includes(platform))throw Error('请选择 darwin 或 win32');
const paths=await packager({
 electronZipDir:process.argv[4],dir:'.',name:'JIRA工时填报',platform,arch,out:'dist',overwrite:true,asar:true,
 // Finder and Windows require their native multi-size icon containers, derived from the same approved wordmark.
 icon:resolve('assets/branding',platform==='darwin'?'app-icon.icns':'app-icon.ico'),
 ignore:[/^\/docs(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/dist(?:\/|$)/,/^\/scripts(?:\/|$)/]
});
for(const folder of paths){
 console.log(folder);
 // 两个平台均附带 ZIP；Windows 压缩包必须标记 UTF-8，否则系统解压会乱码。
 const archive=resolve(folder+'.zip');
 await rm(archive,{force:true});
 if(process.platform==='darwin'){
  if(platform==='win32'){
   await promisify(execFile)('/usr/bin/bsdtar',['--format','zip','--options','zip:hdrcharset=UTF-8','-cf',archive,basename(folder)],{cwd:dirname(folder)});
  }else{
   await promisify(execFile)('ditto',['-c','-k','--keepParent',folder,archive]);
  }
 }else if(process.platform==='win32'){
  const escaped=value=>"'"+value.replaceAll("'","''")+"'";
  await promisify(execFile)('powershell.exe',['-NoProfile','-Command','Compress-Archive -LiteralPath '+escaped(folder)+' -DestinationPath '+escaped(archive)]);
 }else{
  await promisify(execFile)('zip',['-qr',archive,basename(folder)],{cwd:dirname(folder)});
 }
 console.log(archive);
}
