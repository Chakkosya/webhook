import {randomUUID} from 'node:crypto';
import {ObservationBrowser,monitorUrl} from '../browser/observation.js';
import {validateRule,evaluateRule,ruleDescription} from '../monitor/rules.js';
import {fail} from '../errors.js';
const instructions=[
  '根据用户要求和真实浏览器页面元素生成一个确定性的只读监控规则，不输出代码，不点击按钮，不推测不存在的选择器。',
  '输出 {name,explanation,rule}。如果证据不足，输出 {error,missingEvidence}，用中文说明。',
  'rule.identity 必须是 {selector,text}，使用页面上长期稳定的商品名称或标题，text 必须与采集文字完全相同；不能使用会变化的库存、价格或目标正文作为身份文字。',
  '所有 selector、scope、fields、submit 必须逐字选自 evidence.elements；不得编造。fields 是选择器字符串数组。',
  'kind=stock 时只允许 type=stock-form 或 stock-count，不得用宽松文字或价格推断有货。',
  'stock-form 使用 {type,identity,scope,fields,submit}；同一商品区域内必须实际出现表单字段与可提交按钮。',
  'stock-count 使用 {type,identity,scope,selector,pattern}，scope 必须是包含商品名称和库存元素的同一商品区域；pattern 是带 ^ 和 $ 的完整匹配正则，第一捕获组只能提取库存整数。必须出现明确库存数字，Monthly、Continue、价格不构成库存证据。',
  'kind=price 使用 {type:"number",identity,selector,operator:"below"或"above",value:数字阈值}，目标区域只能含一个金额。',
  'kind=text 使用 {type:"text",identity,selector,operator:"contains"或"equals",value:"用户要求的文字"}。',
  'kind=change 使用 {type:"change",identity,selector}。',
  '只创建监控与通知，不创建订单或付款；日常检查不调用 AI。'
].join('\n');
export async function buildMonitor(runtime,input,assistant) {
  const url=monitorUrl(input.url),requirement=String(input.requirement||'').trim(),kind=input.kind;
  if(!requirement||!['stock','price','text','change'].includes(kind))fail('MONITOR_INPUT','请填写监控要求并选择监控类型');
  const intervalMs=Number(input.intervalSeconds||30)*1000;
  if(!Number.isFinite(intervalMs)||intervalMs<10000||intervalMs>86400000)fail('MONITOR_INPUT','检查间隔需为 10 秒至 24 小时');
  let webhook=String(input.webhook||'').trim();
  if(webhook){let value;try{value=new URL(webhook);}catch{fail('MONITOR_INPUT','通知 Webhook 地址无效');}if(!['http:','https:'].includes(value.protocol))fail('MONITOR_INPUT','通知地址需使用 HTTP 或 HTTPS');webhook=value.href;}
  const previous=input.id?runtime.pageMonitors.get(input.id):null;
  if(previous&&runtime.pageMonitors.running.has(previous.id))fail('BUSY','请先暂停监控再重新配置');
  if(previous&&!webhook)webhook=previous.webhook||'';
  if(previous&&runtime.pageMonitors.preparing.has(previous.id))fail('BUSY','该任务正在分析页面或检测登录，请等待完成');
  const id=previous?.id||randomUUID(),accounts=runtime.monitorAccounts.selected(id);
  if(runtime.monitorAccounts.records(id).length&&!accounts.length)fail('MONITOR_ACCOUNT','请至少选择一个账户参与监控');
  for(const account of accounts)if(new URL(account.loginUrl).origin!==new URL(url).origin)fail('MONITOR_ACCOUNT','任务地址与已保存账户不属于同一站点，请更新账户');
  const browsers=(accounts.length?accounts:[null]).map(account=>new ObservationBrowser({dataDir:runtime.dataDir,id:account?id+'/'+account.id:id,profile:runtime.proxies.get(input.proxyId),account,onAccount:changes=>runtime.monitorAccounts.update(id,account.id,changes)}));
  const browser=browsers[0];runtime.pageMonitors.preparing.set(id,input.proxyId||null);
  try {
    await browser.open();
    const samples=[await browser.read(url)],evidence=await browser.snapshot();
    const output=await assistant.request('create-monitor',{url,requirement,kind,evidence},instructions);
    if(output.error)fail('MONITOR_EVIDENCE',String(output.error)+(output.missingEvidence?'：'+String(output.missingEvidence):''));
    const rule=validateRule(output.rule,kind,evidence);
    const first=await evaluateRule(browser.page,rule);
    if(first.status==='unknown')fail('MONITOR_EVIDENCE','第一次页面验证未通过：'+first.reason);
    samples.push(await browser.read(url));
    const second=await evaluateRule(browser.page,rule,first.value);
    if(second.status==='unknown')fail('MONITOR_EVIDENCE','第二次页面验证未通过：'+second.reason);
    if(rule.type==='change'&&first.value!==second.value)fail('MONITOR_EVIDENCE','页面目标持续变化，请缩小监控范围后重新分析');
    const accountStates={};
    if(accounts.length)accountStates[accounts[0].id]={baseline:second.value,triggered:false};
    for(let index=1;index<browsers.length;index++){
      const other=browsers[index];await other.open();
      samples.push(await other.read(url));validateRule(rule,kind,await other.snapshot());
      const first=await evaluateRule(other.page,rule);
      samples.push(await other.read(url));
      const checked=await evaluateRule(other.page,rule,first.value);
      if(first.status==='unknown'||checked.status==='unknown'||rule.type==='change'&&first.value!==checked.value)fail('MONITOR_EVIDENCE','账户「'+accounts[index].name+'」两次页面验证未通过');
      accountStates[accounts[index].id]={baseline:checked.value,triggered:false};
    }
    const maximum=Math.max(...samples),policy={absoluteMs:maximum+45000,idleMs:maximum+30000,samplesMs:samples};
    return runtime.pageMonitors.add({id,name:String(input.name||output.name||evidence.title).trim(),url,requirement,kind,rule,proxyId:input.proxyId||null,apiId:input.apiId||null,intervalMs,webhook,explanation:String(output.explanation||ruleDescription(rule)),verifiedChecks:2,accountStates,baseline:second.value,preview:second,policy});
  }finally{await Promise.allSettled(browsers.map(browser=>browser.close()));runtime.pageMonitors.preparing.delete(id);}
}
