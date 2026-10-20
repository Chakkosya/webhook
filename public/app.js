import {setupWorkspace,refreshWorkspace} from './workspace.js';
const $=selector=>document.querySelector(selector);
const labels={candidate:'待验证',verified:'已验证',stale:'已过期',running:'执行中','trial-ready':'试运行通过',ordered:'已创建订单',paid:'已支付',failed:'失败'};
const time=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(value));
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const views=[...document.querySelectorAll('[data-page]')],links=[...document.querySelectorAll('nav a')];
const lists={workflow:{page:1,items:[]},runs:{page:1,items:[]}};
function showPage() {
  const view=views.find(el=>el.id===location.hash.slice(2))||views[0];
  $('#run-detail').close();
  for(const el of views)el.hidden=el!==view;
  $('.hero').hidden=view.id!=='overview';
  const current=links.find(link=>link.hash==='#/'+view.id);
  for(const link of links)if(link===current)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  $('#page-context').textContent='工作台 / '+current.textContent;
  $('#page-context').hidden=view.id==='overview';
  document.title=current.textContent+' · 确定性工作流';
  current.scrollIntoView({block:'nearest',inline:'nearest'});
  window.scrollTo(0,0);
}
window.addEventListener('hashchange',showPage);
showPage();
function pageRows(name) {
  const list=lists[name],pages=Math.max(1,Math.ceil(list.items.length/10));
  list.page=Math.min(list.page,pages);
  $('#'+name+'-pagination').hidden=pages===1;
  $('#'+name+'-page').textContent='第 '+list.page+' / '+pages+' 页 · 共 '+list.items.length+' 条';
  $('#'+name+'-prev').disabled=list.page===1;
  $('#'+name+'-next').disabled=list.page===pages;
  return list.items.slice((list.page-1)*10,list.page*10);
}
for(const name of ['workflow','runs'])for(const direction of ['prev','next'])$('#'+name+'-'+direction).onclick=()=>{
  lists[name].page+=direction==='prev'?-1:1;
  if(name==='workflow')renderWorkflows();else renderRuns();
  window.scrollTo(0,0);
};
let noticeTimer;
$('#notice').onclick=()=>{$('#notice').style.display='none';clearTimeout(noticeTimer);};
function notice(text){$('#notice').textContent=text;$('#notice').style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').style.display='none',7000);}
async function api(path,body) {
  const response=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.error?.message||result.error);return result;
}
function button(text,fn){const el=node('button',text,'subtle');el.addEventListener('click',()=>action(el,fn));return el;}
async function action(el,fn) {el.disabled=true;try{await fn();await refresh();}catch(error){notice(error.message);}finally{el.disabled=false;}}
async function run(row,mode) {
  const result=await api('run',{workflowId:row.id,version:row.version,mode});
  notice(labels[result.status]+(result.error?'：'+result.error.message:result.receipt?' · 凭证 '+result.receipt.invoiceId:''));
}
function renderWorkflows() {
  const tbody=$('#workflow-rows');tbody.replaceChildren();$('#workflow-empty').hidden=!!lists.workflow.items.length;
  for(const row of pageRows('workflow')) {
    const tr=node('tr');tr.append(node('td',row.id+' / v'+row.version),node('td',labels[row.state]||row.state),node('td',row.streak+' / 2'));
    const td=node('td'),actions=node('div',undefined,'actions');
    actions.append(button('试运行',()=>run(row,'trial')),button('发布',async()=>{await api('publish',row);notice('版本已发布');}),button('真实下单',()=>run(row,'live')),button('监控触发',async()=>{await api('monitor/start',{workflowId:row.id,version:row.version,mode:'live'});notice('监控已启动');}),button('回滚',async()=>{await api('rollback',row);notice('发布版本已切换');}));
    td.append(actions);tr.append(td);tbody.append(tr);
  }
}
function renderRuns() {
  const runs=$('#run-rows');runs.replaceChildren();$('#runs-empty').hidden=!!lists.runs.items.length;
  for(const run of pageRows('runs')) {
    const row=node('div',undefined,'run-row'),content=node('div');
    content.append(node('strong',run.workflowId+' / v'+run.version+' · '+(labels[run.status]||run.status),'status-'+run.status));
    content.append(node('p',time(run.startedAt)+' · '+(run.mode==='trial'?'试运行':'真实执行')+' · 推理 '+run.aiInferenceCalls+' 次'+(run.error?' · '+run.error.category+'：'+run.error.message:'')));
    const actions=node('div',undefined,'actions');
    actions.append(button('查看步骤',async()=>{$('#detail').textContent=JSON.stringify(run,null,2);$('#run-detail').showModal();}));
    if(run.status==='failed')actions.append(button('场外诊断',async()=>{const report=await api('diagnose',{runId:run.id});$('#detail').textContent=JSON.stringify(report,null,2);$('#run-detail').showModal();}),button('生成修补版本',async()=>{const candidate=await api('repair',{runId:run.id});notice('已保存待验证版本 v'+candidate.version);}));
    row.append(content,actions);runs.append(row);
  }
}
function renderOverview() {
  const recent=$("#overview-run-list");recent.replaceChildren();$("#overview-run-empty").hidden=!!lists.runs.items.length;
  for(const run of lists.runs.items.slice(0,3)) {
    const row=node("a",undefined,"preview-row"),content=node("div");row.href="#/runs";
    content.append(node("strong",run.workflowId+" / v"+run.version),node("p",time(run.startedAt)+" · "+(run.mode==="trial"?"试运行":"真实执行")));
    row.append(content,node("span",labels[run.status]||run.status,"preview-status status-"+run.status));recent.append(row);
  }
  const library=$("#overview-workflow-list");library.replaceChildren();$("#overview-workflow-empty").hidden=!!lists.workflow.items.length;
  for(const workflow of lists.workflow.items.slice(0,3)) {
    const row=node("a",undefined,"preview-row"),content=node("div");row.href="#/workflows";
    content.append(node("strong",workflow.id),node("p","v"+workflow.version+" · 连续试跑 "+workflow.streak+" 次"));
    row.append(content,node("span",labels[workflow.state]||workflow.state,"preview-status"));library.append(row);
  }
}
async function refresh() {
  const status=await api('status');
  $('#connection').textContent='本机已连接';$('#browser').textContent=status.browser?.status==='ready'?'热备就绪':status.browser?.status==='failed'?'登录异常':status.browser?.status==='reconnecting'?'正在重登':'未启动';
  $('#credential-state').textContent=status.credentials.saved?'已保存账号':'尚未保存';
  $('#account-scope').textContent=status.account?status.account.origin+' · '+status.account.name:'先保存站点配置，再保存该站点的账号密码。';
  $('#login-health').textContent=status.browser?.message||'';
  $('#save-login').disabled=!status.configured;$('#check-login').disabled=!status.configured;$('#delete-login').disabled=!status.credentials.saved;
  $('#workflow-count').textContent=status.workflows.length;
  const metrics=Object.values(status.metrics);$('#success-count').textContent=metrics.reduce((a,m)=>a+m.successes,0)+' / '+metrics.reduce((a,m)=>a+m.attempts,0);
  $('#monitor-state').textContent=status.monitoring?'监控中':'已停止';
  lists.workflow.items=status.workflows;renderWorkflows();
  lists.runs.items=status.runs;renderRuns();renderOverview();
  $('#events').textContent=JSON.stringify(status.events,null,2);
  refreshWorkspace(status);
  const activeMonitors=(status.monitors||[]).filter(item=>item.running).length;if(activeMonitors)$('#monitor-state').textContent=activeMonitors+' 个监控中';
}
async function loadCredentials(){const value=await api('credentials');$('#login-username').value=value.username||'';$('#login-password').value='';}
$('#save-login').onclick=()=>action($('#save-login'),async()=>{
  await api('credentials',{username:$('#login-username').value,password:$('#login-password').value});
  $('#login-password').value='';await refresh();await api('session/check',{});notice('账号已加密保存，登录状态已确认');
});
$('#check-login').onclick=()=>action($('#check-login'),async()=>{await api('session/check',{});notice('登录状态已确认');});
$('#delete-login').onclick=()=>action($('#delete-login'),async()=>{await api('credentials/delete',{});await loadCredentials();notice('已删除保存的账号密码');});
$('#warm').onclick=()=>action($('#warm'),async()=>{await api('warm',{});notice('会话已登录并预热');});
$('#stop').onclick=()=>action($('#stop'),async()=>{await api('monitor/stop',{});for(const monitor of await api('monitors'))if(monitor.running)await api('monitors/stop',{id:monitor.id});notice('监控已停止');});
$('#save').onclick=()=>action($('#save'),async()=>{await api('config',JSON.parse($('#config-json').value));await loadCredentials();notice('配置已保存');});
$('#import').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;await api('workflows',JSON.parse(await file.text()));notice('候选版本已导入');await refresh();}catch(error){notice(error.message);}finally{event.target.value='';}};
$('#close-detail').onclick=()=>$('#run-detail').close();
setupWorkspace({$,api,button,action,notice,node,refresh,time});
try{const config=await api('config');if(config)$('#config-json').value=JSON.stringify(config,null,2);await loadCredentials();await refresh();}catch(error){notice(error.message);$('#connection').textContent='连接失败';}
setInterval(()=>refresh().catch(()=>{$('#connection').textContent='连接中断';}),5000);
