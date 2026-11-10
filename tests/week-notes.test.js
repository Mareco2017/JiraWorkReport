import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WeekNotes} from '../app/week-notes.js';

async function workspace(t) {
 const directory=await mkdtemp(join(tmpdir(),'jira-week-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 return {directory,notes:new WeekNotes({directory})};
}
test('weekly files are previewed without parsing other sections',async t=>{
 const {directory,notes}=await workspace(t);
 await writeFile(join(directory,'2月第3周.md'),'## 本周待办事项\n- DEMO-1 unrelated\n## 本周工时记录\n周一：\n- 2.5h 需求讨论\n- 1.5 h 文档整理\n周二：\n- 补充原型\n## 下周工作\n- 3h 不应导入\n');
 await writeFile(join(directory,'README.md'),'not a week');
 const files=await notes.list();assert.equal(files.length,1);assert.equal(files[0].name,'2月第3周.md');
 const preview=await notes.read(files[0].id);assert.match(preview,/DEMO-1 unrelated/);
 const result=await notes.parse(files[0].id,{weekStart:'2024-02-12'});
 assert.equal(result.records.length,3);
 assert.deepEqual(result.records.map(r=>[r.day,r.hours,r.title]),[['2024-02-12',2.5,'需求讨论'],['2024-02-12',1.5,'文档整理'],['2024-02-13','','补充原型']]);
 assert.ok(result.records.every(r=>r.issue===''&&r.type===''&&r.task===''));
 assert.match(result.records[2].sourceText,/补充原型/);assert.ok(result.records[2].sourceLine>0);
});
test('unknown source week leaves dates blank instead of guessing from month and week filename',async t=>{
 const {directory,notes}=await workspace(t);await writeFile(join(directory,'2月第3周.md'),'## 本周工时记录\n周一：\n- 1h 答疑\n');
 const {records}=await notes.parse('2月第3周.md');assert.equal(records[0].day,'');assert.equal(records[0].hours,1);
});
test('explicit source dates survive and invalid time remains a missing value',async t=>{
 const {directory,notes}=await workspace(t);await writeFile(join(directory,'2月第3周.md'),'## 本周工时记录\n2024-02-15 周四：\n- 0.5h 对齐事项\n- 1.3h 非标准时间\n2024-02-30：\n- 2h 日期非法\n');
 const {records}=await notes.parse('2月第3周.md');assert.equal(records[0].day,'2024-02-15');assert.equal(records[1].hours,'');assert.match(records[1].sourceText,/1.3h/);assert.equal(records[2].day,'');
});
test('missing work section retains readable content and does not invent records',async t=>{
 const {directory,notes}=await workspace(t);await writeFile(join(directory,'2月第3周.md'),'## 本周待办事项\n- 2h 计划工作\n');
 const result=await notes.parse('2月第3周.md');assert.equal(result.records.length,0);assert.match(result.content,/计划工作/);assert.equal(result.warnings[0].code,'MISSING_SECTION');
});
test('week reads are restricted to selected directory and reject symlink escape',async t=>{
 const {directory,notes}=await workspace(t);await mkdir(join(directory,'inside'));await writeFile(join(directory,'inside','2月第3周.md'),'abc');
 await assert.rejects(notes.read('../private.md'),error=>error.code==='INVALID_FILE');
 await symlink('/etc/hosts',join(directory,'2月第3周.md'));await assert.rejects(notes.read('2月第3周.md'),error=>error.code==='INVALID_FILE');
});
