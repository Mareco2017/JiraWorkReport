import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {AgentService} from '../app/agent.js';

// 在隔离子进程中走跨平台库的 Windows 分支；这里只验证启动参数，不能替代 Windows 实机运行。
test('Windows launcher routes CMD through cmd.exe and launches EXE directly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jira cli 空格 '));
 try{
  for(const extension of ['cmd','exe'])await writeFile(join(root,'codex.'+extension),'');
  const result=execFileSync(process.execPath,['--input-type=commonjs','-e',`
   Object.defineProperty(process,'platform',{value:'win32'});
   process.env.PATHEXT='.COM;.EXE;.BAT;.CMD';
   const spawn=require('cross-spawn');
   const parsed=spawn._parse(process.argv[1],['-c','model_provider="workbench"','--model','team-model'],{shell:false,windowsHide:true});
   const native=spawn._parse(process.argv[2],['exec'],{shell:false});
   process.stdout.write(JSON.stringify({parsed,native}));
  `,join(root,'codex.cmd'),join(root,'codex.exe')],{encoding:'utf8'});
  const {parsed,native}=JSON.parse(result);
  assert.match(parsed.command,/cmd\.exe$/i);
  assert.deepEqual(parsed.args.slice(0,3),['/d','/s','/c']);
  assert(parsed.args[3].includes('model_provider='));
  assert.equal(parsed.options.windowsVerbatimArguments,true);
  assert.equal(parsed.options.windowsHide,true);
  assert.equal(native.command,join(root,'codex.exe'));
  assert.deepEqual(native.args,['exec']);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const engine of ['Codex CLI','DSH CLI']){
 test(`${engine} real child process preserves structured input, quoted config and paths with spaces`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'jira cli 空格 '));
  try{
   const script=join(root,'fixture.cjs');
   await writeFile(script,`#!${process.execPath}\nconst fs=require('node:fs');
    const args=process.argv.slice(2),engine=${JSON.stringify(engine)};
    if(engine==='Codex CLI'){
     const url=args.find(arg=>arg.startsWith('model_providers.workbench.base_url='));
     if(JSON.parse(url.split('=').slice(1).join('='))!=='https://fixture.invalid/v1')process.exit(2);
     JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
    }else JSON.parse(fs.readFileSync(args[args.indexOf('--patch')+1],'utf8'));
    let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
     const data=JSON.parse(input),text=JSON.stringify({suggestions:data.records.map(row=>({id:row.id,type:'需求分析',task:'需求调研及分析'}))});
     if(!data.records[0].title.includes('含有空格'))process.exit(3);
     process.stdout.write(JSON.stringify(engine==='Codex CLI'?{type:'item.completed',item:{type:'agent_message',text}}:{type:'final',text})+'\\n');
    });`,{mode:0o700});
   let executable=script;
   if(process.platform==='win32'){
    executable=join(root,'fixture.cmd');
    await writeFile(executable,'@echo off\r\n"'+process.execPath+'" "'+script+'" %*\r\n');
   }
   const agent=new AgentService({secrets:{get:async()=>'fictional-key'}});
   const result=await agent.suggest([{id:'r1',title:'含有空格 和 "引号" 的事项'}],{engine,executable,mode:'custom',url:'https://fixture.invalid/v1',model:'team-model',keyRef:'fixture',approvedInternal:true});
   assert.deepEqual(result,[{id:'r1',type:'需求分析',task:'需求调研及分析'}]);
  }finally{await rm(root,{recursive:true,force:true});}
 });
}
