import test from 'node:test';
import assert from 'node:assert/strict';
import {typeMapping,typeValues,validateRecord,monthBounds,totals} from '../app/worklogs.js';

const valid = {id:'record-a',day:'2024-02-15',title:'需求讨论',hours:1.5,type:'需求分析',task:'需求调研及分析',issue:'DEMO-1'};
test('24 types carry display values and eight fixed task targets',()=>{
  assert.equal(Object.keys(typeMapping).length,24);
  assert.equal(new Set(Object.values(typeMapping)).size,8);
  assert.equal(typeValues['需求分析'],'需求分析会议');
  assert.equal(typeValues['售前及实施支持'],'实施支持');
  for(const type of ['素材设计','平面设计','其他设计'])assert.equal(typeMapping[type],'日常综合');
  assert.equal(typeMapping['需求答疑（作废）'],undefined);
});
test('UI design has its own task while UI review keeps the design review task',()=>{
 assert.equal(typeMapping['UI设计'],'UI设计');assert.equal(typeValues['UI设计'],'产品UI设计');
 assert.equal(typeMapping['ui评审'],'概要设计及评审');
 assert.equal(validateRecord({...valid,type:'UI设计',task:'UI设计'}).task,'UI设计');
 assert.throws(()=>validateRecord({...valid,type:'UI设计',task:'概要设计及评审'}),error=>error.field==='task');
});
test('record entry rejects each invalid field while accepting half-hour steps',()=>{
  assert.equal(validateRecord(valid,{today:'2024-02-15'}).seconds,5400);
  for(const hours of [undefined,'',0,0.25,1.3,'abc',Infinity])assert.throws(()=>validateRecord({...valid,hours},{today:'2024-02-15'}),error=>error.field==='hours');
  for(const day of ['2024-02-30','2024-02-16','2024-13-01','bad'])assert.throws(()=>validateRecord({...valid,day},{today:'2024-02-15'}),error=>error.field==='day');
  assert.throws(()=>validateRecord({...valid,title:' '},{today:'2024-02-15'}),error=>error.field==='title');
  assert.throws(()=>validateRecord({...valid,issue:''},{today:'2024-02-15'}),error=>error.field==='issue');
  assert.throws(()=>validateRecord({...valid,type:'未知'},{today:'2024-02-15'}),error=>error.field==='type');
  assert.throws(()=>validateRecord({...valid,task:'日常综合'},{today:'2024-02-15'}),error=>error.field==='task');
  assert.equal(validateRecord({...valid,hours:3.5},{today:'2024-02-15'}).seconds,12600);
  assert.equal(validateRecord({...valid,type:'日常综合',task:'日常综合',issue:''},{today:'2024-02-15'}).task,'日常综合');
});
test('month dates use the work month including leap February',()=>{
  assert.deepEqual(monthBounds('2024-02-15'),{month:'2024-02',start:'2024-02-01',end:'2024-02-29'});
  assert.deepEqual(monthBounds('2024-04-30'),{month:'2024-04',start:'2024-04-01',end:'2024-04-30'});
  assert.deepEqual(monthBounds('2024-12-31'),{month:'2024-12',start:'2024-12-01',end:'2024-12-31'});
});
test('daily and weekly totals keep undated hours separate',()=>{
  const actual=totals([{day:'2024-02-12',hours:2.5},{day:'2024-02-12',hours:1.5},{day:'2024-02-13',hours:2},{day:'',hours:1},{day:'2024-02-14',hours:''}]);
  assert.equal(actual.hours,6);assert.equal(actual.seconds,21600);assert.equal(actual.pendingHours,1);
  assert.equal(actual.byDay['2024-02-12'].hours,4);assert.equal(actual.byDay['2024-02-13'].hours,2);
});

test('project management and presales may use a requirement task or their original monthly task',()=>{
 for(const [type,requirementTask,monthlyTask] of [
  ['项目管理','开发协同及验收','迭代项目管理'],
  ['售前及实施支持','需求调研及分析','工单及线上问题处理']
 ]) {
  assert.equal(validateRecord({...valid,type,task:requirementTask}).task,requirementTask);
  assert.equal(validateRecord({...valid,type,task:monthlyTask,issue:''}).task,monthlyTask);
  // A returned monthly draft may already contain its resolved parent key; task preserves that original destination.
  assert.equal(validateRecord({...valid,type,task:monthlyTask,issue:'DEMO-OLD-MONTH'}).task,monthlyTask);
  assert.throws(()=>validateRecord({...valid,type,task:requirementTask,issue:''}),error=>error.field==='issue');
  assert.throws(()=>validateRecord({...valid,type,task:'规格撰写及评审'}),error=>error.field==='task');
 }
});
