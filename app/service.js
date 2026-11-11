import {BatchImportService} from './batch-import.js';
import { randomUUID } from 'node:crypto';

// 桌面页面只调用这里列出的业务动作。凭据读取和远端请求留在主进程。
export class WorkbenchService {
  constructor(dependencies) { Object.assign(this, dependencies); this.submission = null; this.verifiedJira = null; }
  async scope(config) {
    const jira = config.jira || {};
    // 旧连接配置没有项目字段，沿用本机原项目，确保仍读取原来的草稿和历史分区。
    return {site:jira.url || 'https://unconfigured.invalid',project:jira.projectKey || this.defaultProject || 'DEMO',user:jira.userKey || jira.username || 'unconfigured'};
  }
  async client(config) {
    if (!config.jira?.keyRef) throw new Error('请先配置 JIRA 连接');
    return this.createJira({...config.jira,project:(await this.scope(config)).project,token:await this.secrets.get(config.jira.keyRef)});
  }
  publicConfig(config) {
    const copy = structuredClone(config);
    for (const section of ['jira','agent']) {
      if (copy[section]) {
        copy[section].hasToken = Boolean(copy[section].keyRef);
        delete copy[section].keyRef;
      }
    }
    for (const service of copy.modelServices || []) {
      service.hasToken = Boolean(service.keyRef);
      delete service.keyRef;
    }
    return copy;
  }
  async submitter(config) {
    if (!this.submission) this.submission = this.createSubmission(await this.client(config));
    return this.submission;
  }
  async call(command, data = {}) {
    const commands = new Set(['initialize','saveDraft','deleteDraft','deleteRecord','updateRecord','saveCommonTypes','searchIssues','getIssue','listTypes','searchMonthly','testJira','saveJira','listDocuments','readDocument','parseImport','chooseNotes','chooseExecutable','testAgent','saveAgent','suggest','bindMonth','startSubmission','getBatch','retry','returnToDrafts','openIssue']);
    if (!commands.has(command)) throw new Error('不支持的工作台操作');
    const config = await this.store.loadConfig();
    // Earlier UI drafts saved a misspelled engine label. Normalize at the configuration boundary, retaining credential references.
    for (const setting of [config.agent, ...(config.modelServices || [])]) {
      if (setting?.engine === 'DSC CLI') setting.engine = 'DSH CLI';
    }
    const scope = await this.scope(config);
    if (command === 'initialize') {
      return {config:this.publicConfig(config),runtimes:this.discoverRuntimes?await this.discoverRuntimes():{},state:await this.store.load(scope),today:this.today?.() || new Date().toLocaleDateString('sv-SE')};
    }
    if (command === 'testJira') {
      this.verifiedJira=null;
      const token = data.token || (data.url === config.jira?.url && data.username === config.jira?.username && config.jira.keyRef ? await this.secrets.get(config.jira.keyRef) : '');
      if (!token) throw new Error('请填写该站点账号的 API Token');
      const candidate = {url:data.url,username:data.username,token};
      const connection = await this.createJira({...candidate,project:scope.project}).connect();
      this.verifiedJira = {...candidate,connection};
      return connection;
    }
    if (command === 'saveJira') {
      const candidate = this.verifiedJira;
      if (!candidate || candidate.url !== data.url || candidate.username !== data.username) throw new Error('请先测试当前连接');
      const keyRef = await this.secrets.put(candidate.token);
      const user = candidate.connection.user;
      config.jira = {url:candidate.url,projectKey:candidate.connection.project?.key || scope.project,username:user.name,keyRef,userKey:user.key || user.name,timeZone:user.timeZone,typeNames:(candidate.connection.types || []).map(type=>type.name)};
      await this.store.saveConfig(config);
      this.verifiedJira = null;
      this.submission = null;
      return this.publicConfig(config);
    }
    if (command === 'saveDraft') {
      const record = {...data.record,id:data.record.id || randomUUID()};
      if (!record.title?.trim()) throw new Error('请填写工作事项');
      return this.store.update(scope,state=>{
        const index=state.drafts.findIndex(row=>row.id===record.id);
        if(index<0) state.drafts.push(record); else state.drafts[index]=record;
      });
    }
    if (command === 'deleteDraft') return this.store.update(scope,state=>{state.drafts=state.drafts.filter(row=>row.id!==data.id);});
    if (command === 'deleteRecord') {
      if(typeof data.id!=='string'||!data.id.trim())throw new Error('请选择需要删除的填报记录');
      return (await this.submitter(config)).deleteRecord(data.id);
    }
    if (command === 'updateRecord') {
      if(typeof data.id!=='string'||!data.id.trim()||!data.changes||typeof data.changes!=='object'||Array.isArray(data.changes))throw new Error('请填写需要修改的记录内容');
      return (await this.submitter(config)).updateRecord(data.id,data.changes);
    }
    if (command === 'saveCommonTypes') { config.commonTypes=data.types;await this.store.saveConfig(config);return this.publicConfig(config); }
    if (command === 'chooseNotes') {
      const directory=await this.chooseDirectory();
      if(directory){config.notesDirectory=directory;await this.store.saveConfig(config);this.batchImport?.clearPreview();}
      return directory;
    }
    if (command === 'chooseExecutable') return this.chooseExecutable();
    if (['listDocuments','readDocument','parseImport'].includes(command)) {
      this.batchImport ||= new BatchImportService({store:this.store,agent:this.agent,documentsFactory:this.documentsFactory});
      if(command==='parseImport')return this.batchImport.parse(data,config,scope);
      if(!config.notesDirectory)throw new Error('请先选择文档所在文件夹');
      if(command==='listDocuments')return {files:await this.documentsFactory(config.notesDirectory).list()};
      return this.batchImport.read(data.file,config,scope);
    }
    if (command==='testAgent') {
      this.verifiedAgent=null;
      const candidate={...data.config,approvedInternal:false};
      // 可信目的地来自主进程中已核实的单位网关，页面字段无法自行授予权限。
      if(candidate.mode==='custom'){
        const origin=new URL(candidate.url).origin;
        candidate.approvedInternal=(this.trustedModelOrigins||[]).includes(origin);
      }
      if(data.key) candidate.keyRef=await this.secrets.put(data.key);
      else {
        const saved=(config.modelServices||[]).find(service=>service.url===candidate.url && service.model===candidate.model);
        candidate.keyRef=saved?.keyRef || (candidate.url===config.agent?.url?config.agent.keyRef:undefined);
      }
      const result=await this.agent.test(candidate);
      this.verifiedAgent={candidate,fingerprint:JSON.stringify(data.config)};
      return result;
    }
    if(command==='saveAgent'){
      if(!this.verifiedAgent || this.verifiedAgent.fingerprint!==JSON.stringify(data.config)) throw new Error('请先检测当前引擎与模型');
      config.agent=this.verifiedAgent.candidate;
      if(config.agent.mode==='custom'){
        const services=config.modelServices ||= [];
        const saved=services.find(row=>row.url===config.agent.url && row.model===config.agent.model);
        if(saved) Object.assign(saved,config.agent);else services.push({...config.agent});
      }
      await this.store.saveConfig(config);this.verifiedAgent=null;return this.publicConfig(config);
    }
    if(command==='suggest'){
      if(!config.agent) throw new Error('尚未配置 Agent，可以继续手动填写');
      return this.agent.suggest(data.records,config.agent);
    }
    if(command==='bindMonth'){
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)) throw new Error('请选择有效月份');
      const jira=await this.client(config), connection=await jira.connect(), issue=await jira.getIssue(data.issue);
      const fields=issue.fields || issue;
      const kind=fields.issuetype?.id || fields.typeId;
      const project=typeof fields.project==='string'?fields.project:fields.project?.key;
      const owner=fields.assigneeName || fields.assignee?.name;
      if(!['10001','10002'].includes(String(kind)) || project!==scope.project || owner!==connection.user.name) throw new Error('请选择当前账号在配置项目中经办的综合工时工单');
      return this.store.update(scope,state=>{state.bindings[data.month]={month:data.month,id:issue.id,key:issue.key,title:fields.summary || issue.title,source:'手动指定'};});
    }
    if(command==='startSubmission') return (await this.submitter(config)).start(data.records);
    if(command==='getBatch') return (await this.submitter(config)).getBatch(data.id);
    if(command==='retry') return (await this.submitter(config)).retry(data.batchId,data.itemId,{allowDuplicate:data.allowDuplicate===true});
    if(command==='returnToDrafts') return (await this.submitter(config)).returnToDrafts(data.batchId);
    const jira=await this.client(config);
    if(command==='searchIssues') return jira.searchIssues(data.query || '');
    if(command==='searchMonthly'){await jira.connect();return jira.searchMonthly(data.query || '');}
    if(command==='getIssue') return jira.getIssue(data.key);
    if(command==='listTypes') return jira.listTypes();
    if(command==='openIssue') {
      if(!/^[A-Z][A-Z0-9_]*-\d+$/.test(data.key) || !data.key.startsWith(scope.project+'-')) throw new Error('工单号无效');
      return this.openExternal(new URL('/browse/'+data.key,config.jira.url).href);
    }
  }
}
