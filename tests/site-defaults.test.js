import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSiteDefaults} from '../app/site-defaults.js';

// 每例使用隔离目录，避免测试读取开发电脑的私有部署配置。
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'jira-site-defaults-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await copyFile(new URL('../app/site-defaults.example.json',import.meta.url),join(directory,'site-defaults.example.json'));
  return directory;
}

test('fresh checkout uses the public example without trusting a model gateway',async t=>{
  const settings=await loadSiteDefaults(await fixture(t));
  assert.equal(settings.projectKey,'DEMO');
  assert.deepEqual(settings.trustedModelOrigins,[]);
  assert.equal(settings.notesRelativeDirectory,'');
});

test('private deployment settings preserve the project, gateway and note location',async t=>{
  const directory=await fixture(t);
  const settings={projectKey:'TEAM',trustedModelOrigins:['https://models.example.test'],notesRelativeDirectory:'知识库/工作笔记'};
  await writeFile(join(directory,'site-defaults.local.json'),JSON.stringify(settings));
  assert.deepEqual(await loadSiteDefaults(directory),settings);
});

test('damaged private settings fail instead of silently switching the workspace to the example',async t=>{
  const directory=await fixture(t);
  await writeFile(join(directory,'site-defaults.local.json'),'{broken');
  await assert.rejects(loadSiteDefaults(directory),SyntaxError);
});

test('deployment settings reject malformed trusted origins at the file boundary',async t=>{
  const directory=await fixture(t);
  const settings={projectKey:'TEAM',trustedModelOrigins:['https://models.example.test/v1'],notesRelativeDirectory:''};
  await writeFile(join(directory,'site-defaults.local.json'),JSON.stringify(settings));
  await assert.rejects(loadSiteDefaults(directory),/站点配置格式/);
});
