import {fail} from '../errors.js';
export const WRITES=['cart','configure','coupon','coupon-remove','submit','pay'];
export function bind(value,parameters) {
  if(typeof value==='string') {
    const whole=/^\{\{([\w.]+)\}\}$/.exec(value);
    const get=key=>{const result=key.split('.').reduce((a,k)=>a?.[k],parameters);if(result===undefined)fail('BINDING','缺少参数 '+key);return result;};
    return whole?get(whole[1]):value.replace(/\{\{([\w.]+)\}\}/g,(_,key)=>String(get(key)));
  }
  if(Array.isArray(value))return value.map(item=>bind(item,parameters));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,bind(v,parameters)]));
  return value;
}
export function timing(policy,kind='order') {
  const p=policy?.[kind];
  if(!p||!Array.isArray(p.samplesMs)||!p.samplesMs.length||p.samplesMs.some(n=>!Number.isFinite(n)||n<=0)||!Number.isFinite(p.marginMs)||p.marginMs<=0||!Number.isFinite(p.idleMs)||p.idleMs<=0)
    fail('MEASUREMENTS','超时策略必须有成功实测样本、余量和无进展上限');
  const absoluteMs=Math.ceil(Math.max(...p.samplesMs)+p.marginMs);
  if(p.idleMs>absoluteMs)fail('MEASUREMENTS','无进展上限不能超过绝对上限');
  return {absoluteMs,idleMs:p.idleMs};
}
const conditions=new Set(['visible','absent','text','value','url','checked']);
export function validateWorkflow(workflow) {
  if(workflow.schema!==1||!workflow.id||!Array.isArray(workflow.steps)||!workflow.steps.length)fail('WORKFLOW','工作流结构无效');
  if(workflow.provenance?.kind!=='site-recording'||!workflow.provenance.source)fail('PROVENANCE','工作流必须关联站点学习记录');
  const ids=new Set();let submits=0,pays=0,submitted=false;
  for(const step of workflow.steps) {
    if(!step.id||ids.has(step.id))fail('WORKFLOW','步骤标识缺失或重复');ids.add(step.id);
    if(!['navigate','fill','select','check',...WRITES].includes(step.action))fail('WORKFLOW','不支持的动作 '+step.action);
    if(!step.pre?.length||!step.post?.length)fail('WORKFLOW','每步必须提供前置检查和后置验证');
    for(const c of [...step.pre,...step.post]) {
      if(!conditions.has(c.kind)||(c.kind==='url'?!c.includes:!c.selector))fail('WORKFLOW','核验条件不完整');
      if(['text','value'].includes(c.kind)&&c.equals===undefined&&!c.pattern)fail('WORKFLOW','文本核验必须有精确值或明确模式');
    }
    timing(step.timing);
    if(step.action!=='navigate'&&!step.target?.selector)fail('WORKFLOW','动作缺少站点实测选择器');
    if(step.action==='navigate'&&!step.url)fail('WORKFLOW','导航缺少地址');
    if(WRITES.includes(step.action)&&(!step.request||!step.request.path||!step.request.method))fail('WORKFLOW','写操作缺少实测请求结构');
    if(step.action==='submit'){submits++;submitted=true;}
    if(step.action==='pay'){pays++;if(!submitted)fail('WORKFLOW','付款必须在本次提交之后');}
    if(submitted&&!['submit','pay','navigate'].includes(step.action))fail('WORKFLOW','提交后只能读取账单或支付');
  }
  if(submits!==1||pays>1)fail('WORKFLOW','工作流必须有一次提交，最多一次付款');
  if(workflow.couponPolicy&&!['remove-and-continue','stop'].includes(workflow.couponPolicy))fail('WORKFLOW','优惠失败策略无效');
  return workflow;
}
export function matchesUrl(rule,value) {
  const url=new URL(value);if(rule.pathPrefix?!url.pathname.startsWith(rule.pathPrefix):url.pathname!==rule.path)return false;
  const expected=rule.query||{};
  if(!Object.entries(expected).every(([key,v])=>v==='$digits'?/^\d+$/.test(url.searchParams.get(key)||''):url.searchParams.get(key)===String(v)))return false;
  return rule.allowAnyQuery===true||[...url.searchParams.keys()].every(key=>key in expected||(rule.allowQuery||[]).includes(key));
}
