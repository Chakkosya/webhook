let ui,latest={monitors:[],profiles:{apis:[],proxies:[]}},apiEdit=null,proxyEdit=null,monitorEdit=null,preview=null,monitorPage=1,sessionTouched=false;
const prompts={stock:'关注这款商品，有可购买库存时提醒我。',price:'当这款商品的价格低于 100 时提醒我。',change:'关注页面的主要内容，内容更新后提醒我。',text:'当页面出现「开放购买」时提醒我。'};
const stateLabel=value=>({matched:'条件命中',clear:'条件尚未命中',unknown:'暂时无法确认'})[value]||'等待首次检查';
function feedback(id,text,error=false){const el=ui.$(id);el.textContent=text;el.dataset.error=String(error);}
function chooseOptions(selector,records,placeholder) {
  const select=ui.$(selector),value=select.value;
  const current=[...select.options].map(option=>[option.value,option.textContent]);
  const desired=[['',placeholder],...records.map(item=>[item.id,item.name+(item.isDefault?' · 默认':'')])];
  if(JSON.stringify(current)===JSON.stringify(desired))return;
  select.replaceChildren(...desired.map(([value,text])=>{const option=ui.node('option',text);option.value=value;return option;}));
  if(desired.some(([id])=>id===value))select.value=value;
}
function tab(name) {
  for(const item of ['api','proxy']){ui.$('#'+item+'-settings').hidden=item!==name;ui.$('#'+item+'-tab').setAttribute('aria-selected',String(item===name));}
}
function resetApi() {
  apiEdit=null;ui.$('#api-form').reset();ui.$('#api-key').required=true;ui.$('#api-key').placeholder='粘贴服务商提供的密钥';ui.$('#api-form-title').textContent='添加 AI API';ui.$('#cancel-api').hidden=true;
}
function resetProxy() {
  proxyEdit=null;ui.$('#proxy-form').reset();ui.$('#proxy-manual').hidden=true;ui.$('#proxy-link-field').hidden=false;ui.$('#proxy-form-title').textContent='添加网络出口';ui.$('#proxy-url').placeholder='ss://… 或 http://…';ui.$('#cancel-proxy').hidden=true;
}
function openBuilder(record) {
  monitorEdit=record?.id||null;preview=null;ui.$('#monitor-form').reset();ui.$('#monitor-preview').hidden=true;ui.$('#monitor-builder').hidden=false;ui.$('#monitor-onboarding').hidden=true;
  ui.$('#builder-title').textContent=record?'重新配置监控':'创建智能监控';
  feedback('#monitor-feedback','');
  if(record) {
    for(const [id,value] of Object.entries({'monitor-url':record.url,'monitor-kind':record.kind,'monitor-name':record.name,'monitor-requirement':record.requirement,'monitor-api':record.apiId||'','monitor-proxy':record.proxyId||'','monitor-interval':record.intervalMs/1000}))ui.$('#'+id).value=value;
    ui.$('#monitor-webhook').placeholder=record.hasWebhook?'已保存通知地址；留空保留':'https://…';
  }
  ui.$('#monitor-builder').scrollIntoView({block:'start',behavior:'smooth'});
}
function renderApis() {
  const list=ui.$('#api-list');list.replaceChildren();ui.$('#api-empty').hidden=!!latest.profiles.apis.length;ui.$('#api-count').textContent=latest.profiles.apis.length+' 个';
  for(const item of latest.profiles.apis) {
    const card=ui.node('article',undefined,'connection-item'),head=ui.node('div',undefined,'section-head'),actions=ui.node('div',undefined,'actions');
    head.append(ui.node('h3',item.name));if(item.isDefault)head.append(ui.node('span','默认','badge'));
    card.append(head,ui.node('p',item.endpoint),ui.node('p','模型 · '+item.model+'　密钥已保存'));
    actions.append(ui.button('测试连接',async()=>{feedback('#api-feedback','正在测试 '+item.name+'…');let result;try{result=await ui.api('apis/test',{id:item.id});}catch(error){feedback('#api-feedback',error.message,true);throw error;}feedback('#api-feedback','连接成功 · '+result.model);ui.notice('API 连接测试通过');}),
      ui.button('编辑',()=>{apiEdit=item.id;ui.$('#api-name').value=item.name;ui.$('#api-endpoint').value=item.endpoint;ui.$('#api-model').value=item.model;ui.$('#api-key').value='';ui.$('#api-key').required=false;ui.$('#api-key').placeholder='留空保留原密钥';ui.$('#api-form-title').textContent='编辑 AI API';ui.$('#cancel-api').hidden=false;ui.$('#api-form').scrollIntoView({block:'center',behavior:'smooth'});}),
      ui.button('设为默认',async()=>{await ui.api('apis/default',{id:item.id});ui.notice('已设为默认 API');}),
      ui.button('删除',async()=>{await ui.api('apis/delete',{id:item.id});if(apiEdit===item.id)resetApi();ui.notice('API 已删除');}));
    card.append(actions);list.append(card);
  }
}
function renderProxies() {
  const list=ui.$('#proxy-list');list.replaceChildren();ui.$('#proxy-empty').hidden=!!latest.profiles.proxies.length;ui.$('#proxy-count').textContent=latest.profiles.proxies.length+' 个';
  for(const item of latest.profiles.proxies) {
    const card=ui.node('article',undefined,'connection-item'),head=ui.node('div',undefined,'section-head'),actions=ui.node('div',undefined,'actions');
    head.append(ui.node('h3',item.name),ui.node('span',item.type==='ss'?'Shadowsocks':'HTTP','badge'));
    card.append(head,ui.node('p',item.endpoint),ui.node('p',item.method||'支持用户名和密码'));
    actions.append(ui.button('测试出口',async()=>{feedback('#proxy-feedback','正在通过 '+item.name+' 打开测试页面…');let result;try{result=await ui.api('proxies/test',{id:item.id,url:ui.$('#proxy-test-url').value||undefined});}catch(error){feedback('#proxy-feedback',error.message,true);throw error;}feedback('#proxy-feedback','浏览器连接成功 · '+(result.ip?'出口 IP '+result.ip+' · ':'')+result.elapsedMs+' ms');ui.notice('出口连接测试通过');}),
      ui.button('编辑',()=>{proxyEdit=item.id;ui.$('#proxy-name').value=item.name;ui.$('#proxy-url').value='';ui.$('#proxy-password').value='';ui.$('#proxy-form-title').textContent='编辑网络出口';ui.$('#proxy-url').placeholder='留空保留原节点';ui.$('#cancel-proxy').hidden=false;if(item.type==='ss'){ui.$('#proxy-mode').value='manual';ui.$('#proxy-server').value=item.server;ui.$('#proxy-port').value=item.port;ui.$('#proxy-method').value=item.method;}else ui.$('#proxy-mode').value='link';ui.$('#proxy-mode').dispatchEvent(new Event('change'));ui.$('#proxy-form').scrollIntoView({block:'center',behavior:'smooth'});}),
      ui.button('删除',async()=>{await ui.api('proxies/delete',{id:item.id});if(proxyEdit===item.id)resetProxy();ui.notice('出口已删除');}));
    card.append(actions);list.append(card);
  }
}
function renderMonitors() {
  const items=latest.monitors,list=ui.$('#monitor-list'),pages=Math.max(1,Math.ceil(items.length/10));
  monitorPage=Math.min(monitorPage,pages);
  const signature=JSON.stringify([items,monitorPage,latest.profiles.proxies,!ui.$('#monitor-builder').hidden]);
  if(signature===renderMonitors.signature)return;
  renderMonitors.signature=signature;
  const expanded=new Set([...list.querySelectorAll('.monitor-card')].filter(card=>card.querySelector('details')?.open).map(card=>card.dataset.id));
  list.replaceChildren();
  ui.$('#monitor-onboarding').hidden=!!items.length||!ui.$('#monitor-builder').hidden;ui.$('#monitor-list-pagination').hidden=pages===1;
  ui.$('#monitor-list-page').textContent='第 '+monitorPage+' / '+pages+' 页 · 共 '+items.length+' 个监控';
  ui.$('#monitor-list-prev').disabled=monitorPage===1;ui.$('#monitor-list-next').disabled=monitorPage===pages;
  for(const item of items.slice((monitorPage-1)*10,monitorPage*10)) {
    const card=ui.node('article',undefined,'monitor-card'),head=ui.node('div',undefined,'section-head'),actions=ui.node('div',undefined,'actions'),details=ui.node('details'),link=ui.node('a',item.url);
    card.dataset.id=item.id;link.href=item.url;link.target='_blank';link.rel='noreferrer';
    head.append(ui.node('h3',item.name),ui.node('span',item.running?'监控中':'已暂停','badge'));
    const result=item.lastResult||item.preview;
    card.append(head,link,ui.node('p',item.ruleDescription),ui.node('p',stateLabel(result?.status)+' · '+(result?.value||result?.reason||'等待检查'),'monitor-result'));
    const route=latest.profiles.proxies.find(profile=>profile.id===item.proxyId)?.name||'直连';
    card.append(ui.node('p',route+' · 每 '+item.intervalMs/1000+' 秒 · 已提醒 '+(item.notificationCount||0)+' 次','muted'));
    actions.append(ui.button(item.running?'暂停':'启动',async()=>{await ui.api(item.running?'monitors/stop':'monitors/start',{id:item.id});ui.notice(item.running?'监控已暂停':'监控已启动');}));
    if(item.running)actions.append(ui.button('立即检查',async()=>{const result=await ui.api('monitors/check',{id:item.id});ui.notice(stateLabel(result.status)+(result.reason?'：'+result.reason:''));}));
    actions.append(ui.button('重新配置',async()=>{if(item.running)await ui.api('monitors/stop',{id:item.id});openBuilder(item);}),ui.button('删除',async()=>{await ui.api('monitors/delete',{id:item.id});if(monitorEdit===item.id){preview=null;ui.$('#monitor-builder').hidden=true;}ui.notice('监控已删除');}));
    details.open=expanded.has(item.id);
    details.append(ui.node('summary','监控详情与提醒'));
    details.append(ui.node('p',item.explanation),ui.node('p','实际页面验证 '+item.verifiedChecks+' 次 · 日常检查推理调用 '+item.aiInferenceCalls+' 次'));
    if(item.lastResult?.at)details.append(ui.node('p','最近检查 · '+ui.time(item.lastResult.at)));
    for(const notification of item.notifications||[])details.append(ui.node('p',ui.time(notification.at)+' · '+(notification.status==='failed'?'通知发送失败：'+notification.error:'已记录提醒')+' · '+notification.value));
    card.append(actions,details);list.append(card);
  }
}
export function refreshWorkspace(status) {
  if(!ui)return;
  latest={monitors:status.monitors||[],profiles:status.profiles||{apis:[],proxies:[]}};
  chooseOptions('#monitor-api',latest.profiles.apis,'默认 API');chooseOptions('#monitor-proxy',latest.profiles.proxies,'直连');chooseOptions('#session-proxy',latest.profiles.proxies,'直连');
  if(!sessionTouched)ui.$('#session-proxy').value=latest.profiles.sessionProxyId||'';
  ui.$('#save-session-proxy').disabled=!status.configured;
  const signature=JSON.stringify(latest.profiles);
  if(signature!==refreshWorkspace.signature){renderApis();renderProxies();refreshWorkspace.signature=signature;}
  renderMonitors();
}
export function setupWorkspace(helpers) {
  ui=helpers;
  ui.$('#api-tab').onclick=()=>tab('api');ui.$('#proxy-tab').onclick=()=>tab('proxy');
  ui.$('#cancel-api').onclick=resetApi;ui.$('#cancel-proxy').onclick=resetProxy;
  ui.$('#proxy-mode').onchange=()=>{const manual=ui.$('#proxy-mode').value==='manual';ui.$('#proxy-manual').hidden=!manual;ui.$('#proxy-link-field').hidden=manual;};
  ui.$('#api-form').onsubmit=async event=>{
    event.preventDefault();const button=ui.$('#save-api');button.disabled=true;
    try {
      await ui.api('apis/save',{id:apiEdit,name:ui.$('#api-name').value,endpoint:ui.$('#api-endpoint').value,key:ui.$('#api-key').value,model:ui.$('#api-model').value});
      resetApi();feedback('#api-feedback','API 已保存，可以测试连接或创建监控。');await ui.refresh();
    }catch(error){feedback('#api-feedback',error.message,true);}finally{button.disabled=false;}
  };
  ui.$('#proxy-form').onsubmit=async event=>{
    event.preventDefault();const button=ui.$('#save-proxy');button.disabled=true;
    try {
      const input={id:proxyEdit,name:ui.$('#proxy-name').value};
      if(ui.$('#proxy-mode').value==='manual')Object.assign(input,{type:'ss',server:ui.$('#proxy-server').value,port:Number(ui.$('#proxy-port').value),method:ui.$('#proxy-method').value,password:ui.$('#proxy-password').value});
      else input.url=ui.$('#proxy-url').value;
      await ui.api('proxies/save',input);resetProxy();feedback('#proxy-feedback','出口已保存，可以测试连接或在创建监控时选用。');await ui.refresh();
    }catch(error){feedback('#proxy-feedback',error.message,true);}finally{button.disabled=false;}
  };
  ui.$('#new-monitor').onclick=()=>openBuilder();ui.$('#close-builder').onclick=()=>{ui.$('#monitor-builder').hidden=true;renderMonitors();};
  ui.$('.hero-actions a[href="#/monitors"]').addEventListener('click',()=>openBuilder());
  for(const button of document.querySelectorAll('[data-prompt]'))button.onclick=()=>{ui.$('#monitor-kind').value=button.dataset.prompt;ui.$('#monitor-requirement').value=prompts[button.dataset.prompt];};
  ui.$('#monitor-kind').onchange=()=>{if(!ui.$('#monitor-requirement').value||Object.values(prompts).includes(ui.$('#monitor-requirement').value))ui.$('#monitor-requirement').value=prompts[ui.$('#monitor-kind').value];};
  ui.$('#monitor-form').onsubmit=async event=>{
    event.preventDefault();const button=ui.$('#analyze-monitor');button.disabled=true;ui.$('#monitor-preview').hidden=true;
    feedback('#monitor-feedback','正在打开网页、分析实际内容并完成两次验证，请保持页面开启。');
    try {
      preview=await ui.api('monitors/analyze',{id:monitorEdit,url:ui.$('#monitor-url').value,name:ui.$('#monitor-name').value,requirement:ui.$('#monitor-requirement').value,kind:ui.$('#monitor-kind').value,apiId:ui.$('#monitor-api').value||undefined,proxyId:ui.$('#monitor-proxy').value||undefined,intervalSeconds:Number(ui.$('#monitor-interval').value),webhook:ui.$('#monitor-webhook').value});
      monitorEdit=preview.id;ui.$('#monitor-preview').hidden=false;
      ui.$('#preview-name').textContent=preview.name;ui.$('#preview-description').textContent=preview.explanation;ui.$('#preview-rule').textContent=preview.ruleDescription;ui.$('#preview-value').textContent=preview.preview.value||'已确认目标元素';ui.$('#preview-state').textContent=stateLabel(preview.preview.status);
      feedback('#monitor-feedback','实际页面解析完成。核对预览后即可启动监控。');await ui.refresh();ui.$('#monitor-preview').scrollIntoView({block:'nearest',behavior:'smooth'});
    }catch(error){feedback('#monitor-feedback',error.message,true);}finally{button.disabled=false;}
  };
  ui.$('#confirm-monitor').onclick=()=>ui.action(ui.$('#confirm-monitor'),async()=>{if(!preview)return;await ui.api('monitors/start',{id:preview.id});ui.$('#monitor-builder').hidden=true;ui.notice('监控已启动，命中后会再次确认并记录提醒');});
  ui.$('#monitor-list-prev').onclick=()=>{monitorPage--;renderMonitors();};
  ui.$('#monitor-list-next').onclick=()=>{monitorPage++;renderMonitors();};
  ui.$('#session-proxy').onchange=()=>{sessionTouched=true;};
  ui.$('#save-session-proxy').onclick=()=>ui.action(ui.$('#save-session-proxy'),async()=>{await ui.api('session/proxy',{id:ui.$('#session-proxy').value});sessionTouched=false;ui.notice('站点会话出口已保存，下次启动浏览器时使用');});
}
