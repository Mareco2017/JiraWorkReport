import {packager} from '@electron/packager';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename,dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';

const platform=process.argv[2],arch=process.argv[3];
if(!['darwin','win32'].includes(platform))throw Error('请选择 darwin 或 win32');
const appName='JIRA工时填报';
// 根目录可能留有上一次的构建文件夹；按产物命名排除，避免把 Electron 本体再套进 asar。
const outputFolder=new RegExp('^/'+appName+'-'+platform+'-'+arch+'(?:/|$)');
const paths=await packager({
 electronZipDir:process.argv[4],dir:'.',name:appName,platform,arch,out:process.env.WORKBENCH_OUT||'dist',overwrite:true,asar:true,
 // Finder and Windows require their native multi-size icon containers, derived from the same approved wordmark.
 icon:resolve('assets/branding',platform==='darwin'?'app-icon.icns':'app-icon.ico'),
 ignore:[/^\/docs(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/dist/,/^\/scripts(?:\/|$)/,/^\/bugs(?:\/|$)/,/^\/\.git(?:\/|$)/,outputFolder]
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
  // Compress-Archive 会丢失中文名的 UTF-8 标记，且失败只写非终止错误；改用系统自带 bsdtar 并显式指定 hdrcharset。
  const tar=join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  await promisify(execFile)(tar,['--format','zip','--options','zip:hdrcharset=UTF-8','-cf',archive,'-C',dirname(folder),basename(folder)]);
 }else{
  await promisify(execFile)('zip',['-qr',archive,basename(folder)],{cwd:dirname(folder)});
 }
 if(!existsSync(archive))throw Error('压缩包未生成：'+archive);
 console.log(archive);
}
