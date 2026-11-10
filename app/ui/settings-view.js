import {attachIssueClear,refreshIssueClear} from './issue-input.js';

const text = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const field = (label,id,value='',options='') => `<label class="setting-field"><span>${label}</span><input class="setting-control" id="${id}" value="${text(value)}" ${options}></label>`;
const facts = pairs => '<dl class="setting-facts">'+pairs.map(([label,value])=>'<div><dt>'+label+'</dt><dd>'+text(value)+'</dd></div>').join('')+'</dl>';

/** Mounts only the settings task. All account checks, secret storage and JIRA writes remain in the host API. */
export async function mountSettings({host,call,refresh,getSnapshot,toast,onResume,editJira=false}) {
  if(!document.getElementById('settingsViewStyle')) {
    const link=document.createElement('link');link.id='settingsViewStyle';link.rel='stylesheet';link.href=new URL('./settings-view.css',import.meta.url).href;document.head.append(link);
  }
  host.classList.add('settings-product');
  const jiraHost=host.querySelector('#jiraHost'),agentHost=host.querySelector('#agentHost');
  let jiraEditing=editJira||!getSnapshot().config.jira, jiraTested=false, jiraBusy=false, jiraMessage='',jiraTone='';
  let jiraDraft={url:getSnapshot().config.jira?.url || '',username:getSnapshot().config.jira?.username || '',token:''};
  let agentEditing=false,agentTested=false,agentBusy=false,agentMessage='',agentTone='';
  let agentDraft,agentKey='',selectedService='',agentPathEditing=false;
  let month=getSnapshot().today.slice(0,7),monthEditing=false,monthSelected=null,monthRows=[],monthMessage='',monthTimer;
  const $ = selector=>host.querySelector(selector);
  function notice(message,tone='') {return message?'<div class="setting-notice '+tone+'" role="status">'+text(message)+'</div>':'';}
  function watchError(action) {return async event=>{try{await action(event);}catch(error){toast(error.message);}};}
  async function updateSnapshot(){await refresh();}

  function paintJira() {
    const saved=getSnapshot().config.jira;
    const status=jiraBusy?'测试中':jiraTested?'待保存':saved?'已连接':'未配置';
    jiraHost.innerHTML='<section class="setting-panel"><header class="setting-head"><div class="setting-heading"><h2>JIRA 连接</h2><span class="setting-badge '+(saved&&!jiraEditing?'ready':'')+'">'+status+'</span></div><div class="setting-actions" data-jira-actions></div></header><div class="setting-body" data-jira-body></div><footer class="setting-foot" data-jira-footer></footer></section><section class="setting-month" id="monthHost"></section>';
    const actions=$('[data-jira-actions]'),body=$('[data-jira-body]'),footer=$('[data-jira-footer]');
    if(jiraEditing) {
      body.innerHTML='<div class="setting-form">'+field('站点地址','jiraUrl',jiraDraft.url,'type="url" placeholder="https://jira.example.com" autocomplete="off"')+field('用户名','jiraUsername',jiraDraft.username,'autocomplete="off"')+field('API Token','jiraToken',jiraDraft.token,'type="password" autocomplete="new-password" placeholder="'+(saved?'沿用当前账号已保存的凭据':'填写个人 API Token')+'"')+'</div>'+notice(jiraMessage,jiraTone);
      footer.innerHTML='<button class="setting-button" data-test-jira>测试连接</button><button class="setting-button setting-primary" data-save-jira '+(!jiraTested||jiraBusy?'disabled':'')+'>保存</button>'+(saved?'<button class="setting-link" data-cancel-jira>取消</button>':'');
      for(const [id,key] of [['jiraUrl','url'],['jiraUsername','username'],['jiraToken','token']]) $("#"+id).oninput=event=>{
        jiraDraft[key]=event.target.value;jiraTested=false;
        $('[data-save-jira]').disabled=true;
        if(jiraMessage){jiraMessage='';body.querySelector('.setting-notice')?.remove();}
      };
      $('[data-save-jira]').onclick=saveJira;
      if(saved) $('[data-cancel-jira]').onclick=()=>{jiraEditing=false;jiraTested=false;jiraDraft.token='';jiraMessage='';paintJira();};
    } else {
      body.innerHTML=facts([['站点地址',saved.url],['用户名',saved.username],['API Token','已保存']])+notice(jiraMessage,jiraTone);
      actions.innerHTML='<button class="setting-button" data-edit-jira>编辑连接</button><button class="setting-button" data-test-jira>测试连接</button>'+(onResume?'<button class="setting-button setting-primary" data-resume>返回本次提交</button>':'');
      footer.hidden=true;
      $('[data-edit-jira]').onclick=()=>{jiraDraft={url:saved.url,username:saved.username,token:''};jiraEditing=true;jiraTested=false;jiraMessage='';paintJira();};
      if(onResume) $('[data-resume]').onclick=watchError(()=>onResume());
    }
    $('[data-test-jira]').disabled=jiraBusy;
    $('[data-test-jira]').onclick=testJira;
    for(const input of body.querySelectorAll('input'))input.disabled=jiraBusy;
    paintMonth();
  }
  async function testJira() {
    jiraBusy=true;jiraMessage='';paintJira();
    try {
      const result=await call('testJira',{...jiraDraft});
      jiraTested=jiraEditing;jiraTone='success';jiraMessage='连接成功 · '+result.user.name;
    } catch(error) {jiraTone='error';jiraMessage=error.message;jiraTested=false;}
    finally {jiraBusy=false;paintJira();}
  }
  async function saveJira() {
    try {
      await call('saveJira',{url:jiraDraft.url,username:jiraDraft.username});
      await updateSnapshot();jiraEditing=false;jiraDraft.token='';jiraTested=false;jiraTone='success';jiraMessage='JIRA 连接已保存。';paintJira();
    } catch(error) {jiraTone='error';jiraMessage=error.message;paintJira();}
  }

  function paintMonth() {
    const connected=Boolean(getSnapshot().config.jira),binding=getSnapshot().state.bindings?.[month];
    const monthHost=$('#monthHost');
    const currentYear=Number(getSnapshot().today.slice(0,4));
    monthHost.innerHTML='<div class="setting-month-head"><h3>月度工单</h3><div class="setting-month-controls"><select aria-label="年份" id="monthYear">'+Array.from({length:Math.max(1,currentYear-2019)},(_,i)=>currentYear-i).map(year=>'<option '+(year===Number(month.slice(0,4))?'selected':'')+'>'+year+'</option>').join('')+'</select><select aria-label="月份" id="monthNumber">'+Array.from({length:12},(_,i)=>'<option value="'+String(i+1).padStart(2,'0')+'" '+(i+1===Number(month.slice(5))?'selected':'')+'>'+(i+1)+' 月</option>').join('')+'</select></div></div>';
    if(monthEditing&&connected) {
      const editor=document.createElement('div');editor.className='setting-month-editor';
      editor.innerHTML='<div class="setting-month-query">'+field('关联工单','monthlySearch','','placeholder="输入工单号或名称" autocomplete="off"')+'</div><div class="setting-month-results" role="group" aria-label="候选工单"></div><p class="setting-help" role="status">'+text(monthMessage)+'</p><div class="setting-actions setting-month-actions"><button class="setting-link" data-cancel-month>取消</button><button class="setting-button setting-primary" data-save-month disabled>确认</button></div>';
      monthHost.append(editor);
      attachIssueClear($('#monthlySearch'));
      $('#monthlySearch').oninput=event=>{
        clearTimeout(monthTimer);monthSelected=null;$('[data-save-month]').disabled=true;
        $('.setting-month-results').replaceChildren();monthMessage='';$('.setting-month-editor .setting-help').textContent='';
        const query=event.target.value;
        // Clearing withdraws the current choice; it must not expand a fresh list of every monthly issue.
        if(query.trim())monthTimer=setTimeout(()=>searchMonth(query),250);
      };
      $('#monthlySearch').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(monthTimer);if(event.target.value.trim())searchMonth(event.target.value);}};
      $('[data-cancel-month]').onclick=()=>{clearTimeout(monthTimer);monthEditing=false;monthMessage='';paintMonth();};
      $('[data-save-month]').onclick=async()=>{
        try {await call('bindMonth',{month,issue:monthSelected.key});await updateSnapshot();monthEditing=false;monthMessage='';paintMonth();}
        catch(error){monthMessage=error.message;$('.setting-month-editor .setting-help').textContent=monthMessage;}
      };
    } else {
      const row=document.createElement('div');row.className='setting-month-row';
      row.innerHTML=binding?'<div class="setting-month-description"><span class="setting-month-key">'+text(binding.key)+'</span><strong>'+text(binding.title)+'</strong><span class="setting-source">'+text(binding.source)+'</span></div>':'<p class="setting-help">'+(connected?'尚未关联。提交时将查找该月工单，缺少时自动创建。':'连接 JIRA 后可配置月度工单。')+'</p>';
      const edit=document.createElement('button');edit.className='setting-button';edit.textContent=binding?'更换工单':'配置工单';edit.disabled=!connected;
      edit.onclick=async()=>{monthEditing=true;monthSelected=null;paintMonth();await searchMonth('');$('#monthlySearch')?.focus();};row.append(edit);monthHost.append(row);
    }
    for(const select of monthHost.querySelectorAll('select')) select.onchange=()=>{clearTimeout(monthTimer);month=$('#monthYear').value+'-'+$('#monthNumber').value;monthEditing=false;monthSelected=null;paintMonth();};
  }
  async function searchMonth(query) {
    if($('.setting-month-editor .setting-help'))$('.setting-month-editor .setting-help').textContent='正在查询…';
    try {
      monthRows=await call('searchMonthly',{query});
      const results=$('.setting-month-results');if(!results)return;
      if($('#monthlySearch').value!==query)return;
      results.replaceChildren();
      for(const row of monthRows) {
        const button=document.createElement('button');button.type='button';button.className='setting-month-option';button.textContent=row.key+'　'+(row.title||row.fields?.summary||'');
        button.onclick=()=>{
          monthSelected=row;const input=$('#monthlySearch');input.value=row.key+' · '+(row.title||row.fields?.summary||'');refreshIssueClear(input);
          results.replaceChildren();monthMessage='';$('.setting-month-editor .setting-help').textContent='';$('[data-save-month]').disabled=false;
        };results.append(button);
      }
      $('.setting-month-editor .setting-help').textContent=monthRows.length?'':'未找到可关联的本人综合工时工单。';
    } catch(error){if($('.setting-month-editor .setting-help'))$('.setting-month-editor .setting-help').textContent=error.message;}
  }

  function resetAgentDraft(service) {
    const current=service || getSnapshot().config.agent || {};
    const engine=current.engine||'Codex CLI';
    agentDraft={engine,executable:current.executable||getSnapshot().runtimes?.[engine]||'',mode:current.mode||'default',url:current.url||'',model:current.model||''};
    agentPathEditing=!agentDraft.executable;
    agentKey='';agentTested=false;agentMessage='';
  }
  function agentConfig(){return {...agentDraft};}
  function paintAgent() {
    const saved=getSnapshot().config.agent;
    agentHost.innerHTML='<section class="setting-panel setting-agent"><header class="setting-head"><div class="setting-heading"><h2>Agent</h2><span class="setting-badge '+(saved&&!agentEditing?'ready':'')+'">'+(agentEditing?'配置中':saved?'已启用':'未配置')+'</span></div><div class="setting-actions" data-agent-actions></div></header><div class="setting-body" data-agent-body></div><footer class="setting-foot" data-agent-footer></footer></section>';
    const body=$('[data-agent-body]'),footer=$('[data-agent-footer]');
    if(!agentEditing) {
      body.innerHTML=saved?facts([['执行引擎',saved.engine],['模型',saved.mode==='custom'?saved.model:'CLI 默认模型'],...(saved.mode==='custom'?[['服务地址',saved.url]]:[])]):'<p class="setting-help">可稍后配置，手动填报仍可使用。</p>';
      $('[data-agent-actions]').innerHTML='<button class="setting-button" data-edit-agent>'+(saved?'更改配置':'选择执行引擎')+'</button>';
      $('[data-edit-agent]').onclick=()=>{resetAgentDraft();agentEditing=true;paintAgent();};footer.hidden=true;return;
    }
    const services=getSnapshot().config.modelServices||[];
    body.innerHTML='<div class="setting-agent-form"><fieldset><legend>执行引擎</legend><div class="setting-engine-options">'+['DSH CLI','Codex CLI'].map(engine=>'<label><input type="radio" name="agentEngine" value="'+engine+'" '+(engine===agentDraft.engine?'checked':'')+'>'+engine+'</label>').join('')+'</div></fieldset>'+(agentPathEditing?'<div class="setting-field"><label for="agentExecutable">程序位置</label><div class="setting-path"><input class="setting-control" id="agentExecutable" value="'+text(agentDraft.executable)+'" placeholder="选择 CLI 的可执行程序"><button class="setting-button" data-choose-executable>选择程序</button></div></div>':'<div class="setting-runtime-status"><span>'+text(agentDraft.engine)+(getSnapshot().runtimes?.[agentDraft.engine]?' · 已检测到':' · 已配置')+'</span><button class="setting-link" data-choose-executable>更换程序</button></div>')+'<fieldset><legend>模型</legend><div class="setting-model-options"><label><input type="radio" name="agentMode" value="default" '+(agentDraft.mode==='default'?'checked':'')+'>使用 CLI 默认模型</label><label><input type="radio" name="agentMode" value="custom" '+(agentDraft.mode==='custom'?'checked':'')+'>自定义模型服务</label></div><div class="setting-model-service" '+(agentDraft.mode==='custom'?'':'hidden')+'>'+(services.length?'<div class="setting-field"><label for="savedModelService">已保存的服务</label><div class="setting-service-select"><select class="setting-control" id="savedModelService"><option value="">新增模型服务</option>'+services.map((service,index)=>'<option value="'+index+'" '+(selectedService===String(index)?'selected':'')+'>'+text(service.model)+' · '+text(service.url)+'</option>').join('')+'</select><button class="setting-link" data-new-service>新增模型服务</button></div></div>':'')+'<div class="setting-custom-grid">'+field('服务地址','agentServiceUrl',agentDraft.url,'type="url" placeholder="https://api.example.com/v1" autocomplete="off"')+field('模型名称','agentModel',agentDraft.model,'placeholder="模型标识" autocomplete="off"')+field('API Key','agentKey',agentKey,'type="password" placeholder="'+((saved?.url===agentDraft.url&&saved.hasToken)?'沿用已保存的凭据':'填写 API Key')+'" autocomplete="new-password"')+'</div></div></fieldset></div>'+notice(agentMessage,agentTone);
    footer.innerHTML='<button class="setting-link" data-cancel-agent>取消</button><div class="setting-actions"><button class="setting-button" data-test-agent>'+(agentBusy?'正在检测…':'检测可用性')+'</button><button class="setting-button setting-primary" data-save-agent '+(!agentTested||agentBusy?'disabled':'')+'>启用配置</button></div>';
    function invalidate() {agentTested=false;agentMessage='';$('[data-save-agent]').disabled=true;body.querySelector('.setting-notice')?.remove();}
    for(const [id,key] of [['agentExecutable','executable'],['agentServiceUrl','url'],['agentModel','model']]) if($('#'+id)) $('#'+id).oninput=event=>{agentDraft[key]=event.target.value;if(key==='url'){agentKey='';$('#agentKey').value='';}invalidate();};
    $('#agentKey').oninput=event=>{agentKey=event.target.value;invalidate();};
    body.querySelectorAll('[name=agentEngine]').forEach(radio=>radio.onchange=()=>{agentDraft.engine=radio.value;agentDraft.mode='default';agentDraft.executable=getSnapshot().runtimes?.[radio.value]||'';agentPathEditing=!agentDraft.executable;agentDraft.url='';agentDraft.model='';agentKey='';selectedService='';agentTested=false;agentMessage='';paintAgent();});
    body.querySelectorAll('[name=agentMode]').forEach(radio=>radio.onchange=()=>{agentDraft.mode=radio.value;invalidate();paintAgent();});
    $('[data-choose-executable]').onclick=watchError(async()=>{const path=await call('chooseExecutable');if(path){agentDraft.executable=path;agentPathEditing=false;invalidate();paintAgent();}});
    if(services.length) {
      $('#savedModelService').onchange=event=>{selectedService=event.target.value;if(selectedService!=='')resetAgentDraft(services[Number(selectedService)]);else{agentDraft.mode='custom';agentDraft.url='';agentDraft.model='';agentKey='';agentTested=false;}paintAgent();};
      $('[data-new-service]').onclick=()=>{selectedService='';agentDraft.mode='custom';agentDraft.url='';agentDraft.model='';agentKey='';agentTested=false;agentMessage='';paintAgent();};
    }
    $('[data-cancel-agent]').onclick=()=>{agentEditing=false;agentKey='';agentMessage='';paintAgent();};
    $('[data-test-agent]').onclick=async()=>{
      agentBusy=true;agentMessage='';paintAgent();
      try{await call('testAgent',{config:agentConfig(),key:agentKey});agentTested=true;agentTone='success';agentMessage='检测通过，可以启用此配置。';}
      catch(error){agentTested=false;agentTone='error';agentMessage=error.message;}
      finally{agentBusy=false;paintAgent();}
    };
    $('[data-save-agent]').onclick=async()=>{
      try{await call('saveAgent',{config:agentConfig()});await updateSnapshot();agentEditing=false;agentKey='';agentTested=false;paintAgent();}
      catch(error){agentTone='error';agentMessage=error.message;paintAgent();}
    };
    for(const input of body.querySelectorAll('input,button,select'))input.disabled=agentBusy;
    $('[data-test-agent]').disabled=agentBusy;
    $('[data-cancel-agent]').disabled=agentBusy;
  }
  paintJira();paintAgent();
}
