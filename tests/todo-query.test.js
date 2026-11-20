import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesQuery,compareTodos,monthCells} from '../app/ui/todo/query.js';
test('TODO query uses AND, searches description but never comments',()=>{
 const todo={title:'Report',description:'ALPHA detail',groupId:'g',status:'待处理',priority:'高',dueDate:'2026-11-12',comments:[{content:'secret'}]};
 const q={status:'待处理',priority:'高',dateMode:'range',from:'2026-11-12',to:'2026-11-12',keyword:' alpha '};
 assert.equal(matchesQuery(todo,q,'g'),true);
 for(const changed of [{groupId:'other'},{status:'已完成'},{priority:'中'},{dueDate:'2026-11-13'}])assert.equal(matchesQuery({...todo,...changed},q,'g'),false);
 assert.equal(matchesQuery(todo,{keyword:'secret'},''),false);
 assert.equal(matchesQuery({...todo,dueDate:''},{dateMode:'range',from:'2026-11-12'},''),false);
});
test('TODO missing values stay last in either direction; ties use newer creation',()=>{
 const rows=[{id:'a',priority:'高',dueDate:'2026-11-12',createdAt:'2026-11-01'},{id:'b',priority:'高',dueDate:'2026-11-12',createdAt:'2026-11-02'},{id:'c',priority:'',dueDate:'',createdAt:'2026-11-03'}];
 for(const sort of ['priority-asc','priority-desc','due-asc','due-desc'])assert.deepEqual([...rows].sort((a,b)=>compareTodos(a,b,sort)).map(x=>x.id),['b','a','c']);
 assert.deepEqual([...rows].sort((a,b)=>compareTodos(a,b,'created-asc')).map(x=>x.id),['a','b','c']);
});
test('TODO calendar starts Monday and keeps local dates across year',()=>{
 const cells=monthCells(new Date(2026,10,1));assert.equal(cells.length,42);assert.equal(cells[0],'2026-10-26');assert.equal(cells.at(-1),'2026-12-06');
 assert.equal(monthCells(new Date(2027,0,1))[0],'2026-12-28');
});

const rows=[
 ['A','Alpha budget','方案甲','g1','待处理','高','2026-11-12'],
 ['B','接口说明','alpha在说明中','g1','进行中','中','2026-11-12'],
 ['C','已归档','普通内容','g2','已完成','低','2026-11-11'],
 ['D','ALPHA budget补充','方案乙','g1','待处理','高','2026-11-13'],
 ['E','未定期限','普通内容','','待处理','',''],
 ['F','Alpha lower','普通内容','g2','待处理','低','2026-11-12'],
 ['G','无优先级','alpha在说明中','g1','已完成','','2026-11-10'],
 ['H','队列说明','普通内容','g1','进行中','中','']
].map(([id,title,description,groupId,status,priority,dueDate],i)=>({id,title,description,groupId,status,priority,dueDate,createdAt:`2026-11-0${i+1}`,comments:[{content:'Alpha 评论专用'}]}));
const ids=(q={},group='')=>rows.filter(row=>matchesQuery(row,q,group)).sort((a,b)=>compareTodos(a,b,'created-desc')).map(row=>row.id).join('');
test('TODO Q8 all six sort directions match confirmed sequence',()=>{
 const expected={'created-desc':'HGFEDCBA','created-asc':'ABCDEFGH','due-asc':'GCFBADHE','due-desc':'DFBACGHE','priority-desc':'DAHBFCGE','priority-asc':'FCHBDAGE'};
 for(const [sort,result] of Object.entries(expected))assert.equal([...rows].sort((a,b)=>compareTodos(a,b,sort)).map(row=>row.id).join(''),result,sort);
});
test('TODO Q8 filter branches include date endpoints and missing values',()=>{
 for(const [q,want] of [[{status:'待处理'},'FEDA'],[{status:'进行中'},'HB'],[{status:'已完成'},'GC'],[{priority:'高'},'DA'],[{priority:'中'},'HB'],[{priority:'低'},'FC'],[{priority:'unset'},'GE'],[{dateMode:'range',from:'2026-11-11',to:'2026-11-12'},'FCBA'],[{dateMode:'range',from:'2026-11-12'},'FDBA'],[{dateMode:'range',to:'2026-11-11'},'GC'],[{dateMode:'undated'},'HE'],[{keyword:'  aLpHa  '},'GFDBA'],[{keyword:'方案甲'},'A']])assert.equal(ids(q),want,JSON.stringify(q));
 assert.equal(ids({status:'待处理',priority:'高',dateMode:'range',from:'2026-11-12',to:'2026-11-12',keyword:'alpha'},'g1'),'A');
 assert.equal(ids({keyword:'   '}),'HGFEDCBA');
 assert.equal(ids({dateMode:'range',from:'',to:''}),'HGFEDCBA');
});
