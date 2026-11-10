/** Jira Server and Tempo share one authenticated origin; raw responses never reach renderer code. */
export class JiraClient {
  constructor({url,username,token,project='DEMO',request=fetch,timeout=15000}) {
    const base=new URL(url);
    if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw jiraError('INVALID_SITE','请使用有效的 HTTPS JIRA 地址。');
    this.url=base.href.replace(/\/$/,'');
    this.username=username;
    this.token=token;
    this.projectKey=project;
    this.request=request;
    this.timeout=timeout;
  }

  async call(path,{method='GET',body}={}) {
    const target=new URL(this.url+'/'+path.replace(/^\//,''));
    const headers={Accept:'application/json',Authorization:'Basic '+Buffer.from(this.username+':'+this.token).toString('base64')};
    if(body!==undefined) headers['Content-Type']='application/json';
    // Writes may have completed before a lost reply; the coordinator must reconcile their uncertain outcome.
    const writesRemote=['POST','PUT','DELETE'].includes(method);
    let result;
    try {
      result=await this.request(target.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(this.timeout)});
    } catch {
      throw jiraError('NETWORK','JIRA 请求未收到确定结果，请检查连接后核对。',writesRemote);
    }
    if(result.status>=300&&result.status<400) throw jiraError('REDIRECT','JIRA 地址发生跳转，请核对站点。');
    if(!result.ok) {
      const reason={400:['FIELDS','JIRA 字段不合法，请返回填报修正。'],401:['AUTH','JIRA 登录已过期，请更新 Token。'],403:['PERMISSION','当前账号没有执行此操作的权限。'],404:['NOT_FOUND','工单不存在或当前账号不可访问。']}[result.status];
      throw jiraError(reason?.[0]||'REMOTE',reason?.[1]||'JIRA 未接受请求，请核对字段或稍后重试。',writesRemote&&result.status>=500);
    }
    if(result.status===204) return null;
    if(!String(result.headers.get('content-type')||'').includes('json')) throw jiraError('INVALID_RESPONSE','JIRA 返回了登录页或无法识别的内容。');
    try { return await result.json(); }
    catch { throw jiraError('INVALID_RESPONSE','JIRA 返回内容无法读取。'); }
  }

  async connect() {
    const user=await this.call('/rest/api/2/myself');
    if(!user.name || !user.key || !user.timeZone) throw jiraError('IDENTITY','无法确认当前 JIRA 账号及工作时区。');
    const project=await this.call('/rest/api/2/project/'+encodeURIComponent(this.projectKey));
    const types=await this.listTypes();
    this.identity={name:user.name,key:user.key,timeZone:user.timeZone,displayName:user.displayName||user.name};
    this.project={id:project.id,key:project.key};
    this.types=types;
    return {user:this.identity,project:this.project,types};
  }

  async listTypes() {
    const payload=await this.call('/rest/tempo-core/1/work-attribute');
    const attributes=Array.isArray(payload)?payload:(payload.workAttributes||payload.values||[]);
    const attribute=attributes.find(value=>value.key==='_产品工时类型_');
    if(!attribute) throw jiraError('TYPE_MISSING','该 JIRA 站点没有产品工时类型。');
    const values=attribute.values||attribute.staticListValues||[];
    return values.filter(item=>!item.removed&&!item.disabled&&!/作废/.test(item.name)).map(item=>({id:attribute.id,key:attribute.key,name:item.name,value:item.value}));
  }

  async search(jql,fields) {
    const query=new URLSearchParams({jql,fields:fields||'summary,issuetype,parent,subtasks,project,assignee,reporter,created',maxResults:'100'});
    const result=[];
    let start=0;
    do {
      query.set('startAt',String(start));
      const page=await this.call('/rest/api/2/search?'+query);
      result.push(...page.issues);
      start+=page.issues.length;
      if(!page.issues.length || start>=page.total) break;
    } while(true);
    return result;
  }

  async searchIssues(query) {
    const escaped=jqlText(String(query).trim());
    const term=/^[A-Z][A-Z0-9_]*-\d+$/i.test(query.trim())?'key = '+escaped:'summary ~ '+escaped;
    const issues=await this.search('project = '+jqlText(this.projectKey)+' AND issuetype = 10001 AND ('+term+') ORDER BY updated DESC');
    return issues.map(normalizeIssue);
  }

  async searchMonthly(query='') {
    const value=query.trim();
    const condition=/^[A-Z][A-Z0-9_]*-\d+$/i.test(value)?'key = '+jqlText(value):'summary ~ '+jqlText(value);
    const term=value?' AND ('+condition+')':' AND summary ~ "工时"';
    // 已有月单可能是故事类型，新建月单则使用任务类型，查询时需要同时包含两者。
    const issues=await this.search('project = '+jqlText(this.projectKey)+' AND issuetype in (10001,10002) AND assignee = '+jqlText(this.identity.name)+term+' ORDER BY created DESC','summary,issuetype,project,assignee,created,customfield_10301,customfield_13801,subtasks');
    return issues.map(normalizeIssue);
  }

  async getIssue(key) { return normalizeIssue(await this.call('/rest/api/2/issue/'+encodeURIComponent(key))); }

  async getCreateMeta(typeId) {
    const query=new URLSearchParams({projectKeys:this.projectKey,issuetypeIds:String(typeId),expand:'projects.issuetypes.fields'});
    const result=await this.call('/rest/api/2/issue/createmeta?'+query);
    return result.projects[0]?.issuetypes[0]?.fields||{};
  }

  async createIssue(fields) {
    const result=await this.call('/rest/api/2/issue',{method:'POST',body:{fields}});
    return this.getIssue(result.key);
  }

  async listWorklogs({issue,day}) {
    const entries=[];
    let start=0;
    do {
      const page=await this.call('/rest/api/2/issue/'+encodeURIComponent(issue)+'/worklog?startAt='+start+'&maxResults=100');
      entries.push(...page.worklogs);
      start+=page.worklogs.length;
      if(!page.worklogs.length || start>=page.total) break;
    } while(true);
    const records=[];
    for(const entry of entries) {
      const localDay=worklogDay(entry.started,this.identity.timeZone);
      if(day && day!==localDay) continue;
      const tempo=await this.call('/rest/tempo-timesheets/4/worklogs/'+encodeURIComponent(entry.id));
      const attribute=tempo.attributes?.['_产品工时类型_'];
      records.push({id:String(entry.id),issue,day:localDay,seconds:entry.timeSpentSeconds,title:entry.comment||'',author:entry.author?.key||entry.author?.name,typeValue:typeof attribute==='string'?attribute:attribute?.value||''});
    }
    return records;
  }

  async getWorklog(id,issue) {
    const records=await this.listWorklogs({issue});
    return records.find(record=>record.id===String(id))||null;
  }

  /** Delete through Tempo so its period and permission rules also apply to workbench records. */
  async deleteWorklog(id) {
    return this.call('/rest/tempo-timesheets/4/worklogs/'+encodeURIComponent(id),{method:'DELETE'});
  }

  /** Edit the original worklog without changing its worker, type, task or Tempo estimate handling. */
  async updateWorklog(id,record) {
    const body={comment:record.title,started:record.day,timeSpentSeconds:record.seconds};
    return this.call('/rest/tempo-timesheets/4/worklogs/'+encodeURIComponent(id),{method:'PUT',body});
  }

  async submitWorklog(record) {
    const type=this.types.find(value=>value.name===record.type);
    if(!type) throw jiraError('TYPE_MISSING','产品工时类型已失效，请重新选择。');
    const body={originTaskId:String(record.targetId),worker:this.identity.name,started:record.day,timeSpentSeconds:record.seconds,comment:record.title,attributes:{[type.key]:{workAttributeId:type.id,value:type.value}}};
    const created=await this.call('/rest/tempo-timesheets/4/worklogs/',{method:'POST',body});
    // Tempo DC 的单日创建也会返回单元素数组，仍须按唯一 ID 回读。
    const entry=Array.isArray(created) && created.length===1?created[0]:created;
    const id=String(entry.originId||entry.id||'');
    if(!id) throw jiraError('UNCERTAIN','未取得工时 ID，请先核对 JIRA 结果。');
    const saved=await this.getWorklog(id,record.targetKey);
    if(!saved || !sameWorklog(saved,{...record,author:this.identity.key,typeValue:type.value,issue:record.targetKey})) throw jiraError('UNCERTAIN','JIRA 回读与提交内容不一致，请先核对。');
    return saved;
  }
}

function jqlText(value) { return '"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'; }
function normalizeIssue(value) {
  const f=value.fields||{};
  return {id:String(value.id),key:value.key,title:f.summary||'',typeId:f.issuetype?.id,project:f.project?.key,assignee:f.assignee?.key||f.assignee?.name,assigneeName:f.assignee?.name,parent:f.parent?.key,subtasks:(f.subtasks||[]).map(item=>({id:String(item.id),key:item.key,title:item.fields?.summary||'',typeId:item.fields?.issuetype?.id})),created:f.created,tenant:f.customfield_10301,businessLine:f.customfield_13801};
}
export function jiraError(code,message,uncertain=false) { return Object.assign(new Error(message),{code,uncertain}); }
export function worklogDay(started,timeZone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(started));
  const field=type=>parts.find(part=>part.type===type).value;
  return field('year')+'-'+field('month')+'-'+field('day');
}
/** Convert the selected work date to the account's midnight, including seasonal UTC offsets. */
export function workdayStart(day,timeZone) {
  let instant=Date.parse(day+'T00:00:00Z');
  let offset=0;
  for(let n=0;n<2;n++) {
    const parts=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'}).formatToParts(new Date(instant));
    const zone=parts.find(part=>part.type==='timeZoneName').value;
    const match=/GMT([+-])(\d\d):(\d\d)/.exec(zone);
    offset=match?(Number(match[2])*60+Number(match[3]))*(match[1]==='+'?1:-1):0;
    instant=Date.parse(day+'T00:00:00Z')-offset*60000;
  }
  const sign=offset>=0?'+':'-';
  return day+'T00:00:00.000'+sign+String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')+':'+String(Math.abs(offset)%60).padStart(2,'0');
}
export function sameWorklog(saved,expected) {
 return saved.author===expected.author && saved.issue===expected.issue && saved.day===expected.day && saved.seconds===expected.seconds && saved.title===expected.title && saved.typeValue===expected.typeValue;
}
