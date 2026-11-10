import test from 'node:test';
import assert from 'node:assert/strict';
import {JiraClient} from '../app/jira.js';

const user={name:'alice',key:'JIRAUSER1',timeZone:'Asia/Shanghai'};
function response(body,status=200){return {ok:status>=200&&status<300,status,headers:new Headers({'content-type':'application/json'}),json:async()=>body};}
function fixture(routes){const calls=[];return {calls,request:async (url,options)=>{calls.push({url:String(url),...options});const item=routes[new URL(url).pathname];if(!item)throw Error('unexpected '+url);return response(item);}};}

test('TC-019 Basic auth verifies myself and types, and deprecated names remain excluded even when removed is false',async()=>{
 const api=fixture({'/rest/api/2/myself':user,'/rest/api/2/project/DEMO':{id:'10000',key:'DEMO'},'/rest/tempo-core/1/work-attribute':[{id:3,key:'_产品工时类型_',name:'产品工时类型',type:'STATIC_LIST',values:[{name:'需求分析',value:'需求分析会议',removed:false},{name:'例会（作废）',value:'例会',removed:false}]}]});
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'example-token',request:api.request});
 const result=await client.connect();
 assert.equal(result.user.key,user.key);
 assert.equal(result.project.key,'DEMO');
 assert.deepEqual(result.types.map(t=>[t.name,t.value]),[['需求分析','需求分析会议']]);
 assert.equal(api.calls[0].headers.Authorization,'Basic '+Buffer.from('alice:example-token').toString('base64'));
 assert.equal(api.calls[0].redirect,'manual');
});

test('TC-019 refuses redirect and HTML login pages and does not expose returned tokens in messages',async()=>{
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'example-token',request:async()=>response({},302)});
 await assert.rejects(client.connect(),{code:'REDIRECT'});
 const html=new JiraClient({url:'https://jira.example.test',username:'alice',token:'example-token',request:async()=>({ok:true,status:200,headers:new Headers({'content-type':'text/html'}),text:async()=>'<html>login</html>'})});
 await assert.rejects(html.connect(),{code:'INVALID_RESPONSE'});
});

test('TC-029 work date conversion preserves midnight in account time zone',async()=>{
 const {workdayStart,worklogDay}=await import('../app/jira.js');
 assert.equal(workdayStart('2024-02-29','Asia/Shanghai'),'2024-02-29T00:00:00.000+08:00');
 assert.equal(worklogDay('2024-02-28T16:01:00Z','Asia/Shanghai'),'2024-02-29');
});

test('TC-005 Tempo creation sends the storage value and verifies the resulting worklog instead of trusting the response',async()=>{
 const calls=[];
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async(url,options)=>{
   calls.push({url,options});
   const path=new URL(url).pathname;
   if(options.method==='POST')return response([{originId:701}],201);
   if(path.endsWith('/worklog'))return response({total:1,worklogs:[{id:'701',author:{key:'JIRAUSER1'},started:'2024-02-15T00:00:00+0800',timeSpentSeconds:1800,comment:'事项'}]});
   return response({attributes:{'_产品工时类型_':{value:'需求分析会议'}}});
 }});
 client.identity=user;client.types=[{id:3,key:'_产品工时类型_',name:'需求分析',value:'需求分析会议'}];
 const saved=await client.submitWorklog({day:'2024-02-15',title:'事项',seconds:1800,targetId:'101',targetKey:'DEMO-101',type:'需求分析'});
 assert.equal(saved.id,'701');const body=JSON.parse(calls[0].options.body);assert.equal(body.attributes['_产品工时类型_'].value,'需求分析会议');assert.equal(body.started,'2024-02-15');assert.equal(body.remainingEstimate,undefined);assert.equal(body.worker,'alice');
});

test('TC-018 field rejection is actionable and uncertain server write failure cannot be blindly retried',async()=>{
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},400)});
 await assert.rejects(client.createIssue({}),{code:'FIELDS',uncertain:false});
 const failure=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},503)});
 await assert.rejects(failure.createIssue({}),{code:'REMOTE',uncertain:true});
});

test('TC-018 failed read is retryable without claiming an uncertain remote write',async()=>{
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>{throw Error('offline');}});
 await assert.rejects(client.getIssue('DEMO-1'),{code:'NETWORK',uncertain:false});
});

test('worklog deletion uses Tempo on the authenticated origin and accepts its empty 204 response',async()=>{
 const calls=[];
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async(url,options)=>{
  calls.push({url,options});return response(null,204);
 }});
 assert.equal(await client.deleteWorklog('701'),null);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://jira.example.test/rest/tempo-timesheets/4/worklogs/701');
 assert.equal(calls[0].options.method,'DELETE');assert.equal(calls[0].options.body,undefined);
 assert.equal(calls[0].options.headers.Authorization,'Basic '+Buffer.from('alice:sample').toString('base64'));
 assert.equal(calls[0].options.redirect,'manual');
});

test('a rejected worklog deletion preserves the permission error without claiming an uncertain outcome',async()=>{
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},403)});
 await assert.rejects(client.deleteWorklog('701'),{code:'PERMISSION',uncertain:false});
});

test('lost or failed DELETE responses are uncertain while GET and POST keep their established semantics',async()=>{
 for(const method of ['GET','POST','DELETE']){
  const network=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>{throw Error('offline');}});
  await assert.rejects(network.call('/rest/tempo-timesheets/4/worklogs/701',{method}),{code:'NETWORK',uncertain:method!=='GET'});
  const server=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},503)});
  await assert.rejects(server.call('/rest/tempo-timesheets/4/worklogs/701',{method}),{code:'REMOTE',uncertain:method!=='GET'});
 }
});

test('worklog editing updates the same Tempo ID with only the three editable fields',async()=>{
 for(const status of [200,204]){
  const calls=[];
  const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async(url,options)=>{
   calls.push({url,options});return response(status===204?null:{originId:701},status);
  }});
  const result=await client.updateWorklog('701',{title:'调整后的事项',day:'2024-02-16',seconds:5400,hours:1.5,type:'UI设计',task:'UI设计',worker:'OTHER',originTaskId:'999',remainingEstimate:0,attributes:{ignored:true}});
  assert.deepEqual(result,status===204?null:{originId:701});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://jira.example.test/rest/tempo-timesheets/4/worklogs/701');
  assert.equal(calls[0].options.method,'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body),{comment:'调整后的事项',started:'2024-02-16',timeSpentSeconds:5400});
  assert.equal(calls[0].options.headers.Authorization,'Basic '+Buffer.from('alice:sample').toString('base64'));
  assert.equal(calls[0].options.redirect,'manual');
 }
});

test('a rejected worklog edit preserves the permission error as a definite failure',async()=>{
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},403)});
 await assert.rejects(client.updateWorklog('701',{title:'事项',day:'2024-02-15',seconds:1800}),{code:'PERMISSION',uncertain:false});
});

test('lost or failed PUT responses require readback instead of assuming no remote update',async()=>{
 const network=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>{throw Error('offline');}});
 await assert.rejects(network.call('/rest/tempo-timesheets/4/worklogs/701',{method:'PUT'}),{code:'NETWORK',uncertain:true});
 const server=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async()=>response({},503)});
 await assert.rejects(server.call('/rest/tempo-timesheets/4/worklogs/701',{method:'PUT'}),{code:'REMOTE',uncertain:true});
});

test('monthly search finds a story by exact key and title while keeping project and owner filters',async()=>{
 const queries=[];
 const raw={id:'300',key:'DEMO-300',fields:{summary:'2026年11月综合工时',issuetype:{id:'10001'},project:{key:'DEMO'},assignee:{name:'alice',key:'JIRAUSER1'},subtasks:[]}};
 const client=new JiraClient({url:'https://jira.example.test',username:'alice',token:'sample',request:async url=>{
  const jql=new URL(url).searchParams.get('jql');queries.push(jql);
  const acceptsStory=/issuetype in \(10001,\s*10002\)/.test(jql);
  return response({total:acceptsStory?1:0,issues:acceptsStory?[raw]:[]});
 }});
 client.identity={name:'alice',key:'JIRAUSER1'};
 for(const query of ['DEMO-300','2026年11月综合工时','']){
  const rows=await client.searchMonthly(query);assert.equal(rows[0]?.key,'DEMO-300');
 }
 assert(queries.every(jql=>jql.includes('project = "DEMO"')&&jql.includes('assignee = "alice"')));
 assert(queries[0].includes('key = "DEMO-300"'));
 assert(queries[1].includes('summary ~ "2026年11月综合工时"'));
 assert(queries[2].includes('summary ~ "工时"'));
});
