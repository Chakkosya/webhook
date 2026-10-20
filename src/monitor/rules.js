import {fail} from '../errors.js';
function stockNumber(value) {
  const patterns=[/^(?:.*?\b)?(\d+)\s+(?:available|in stock|remaining|left)\b/i,/(?:available|stock)\s*[:：]?\s*(\d+)\b/i,/(?:库存|剩余|可用|余量|在库|在庫)[^\d]{0,8}(\d+)/];
  for(const pattern of patterns){const match=pattern.exec(value);if(match)return Number(match[1]);}
  return NaN;
}
const types={stock:['stock-form','stock-count'],price:['number'],text:['text'],change:['change']};
const text=async locator=>String(await locator.innerText()).trim();
export function validateRule(rule,kind,evidence) {
  if(!rule||!types[kind]?.includes(rule.type))fail('MONITOR_RULE','生成的规则与监控类型不符，请重新分析');
  const allowed=new Set(evidence.elements.map(element=>element.selector));
  const selectors=[rule.selector,rule.identity?.selector,rule.scope,rule.submit,...(rule.fields||[])].filter(Boolean);
  if(!selectors.length||selectors.some(selector=>typeof selector!=='string'||!allowed.has(selector)))fail('MONITOR_RULE','规则引用了实际页面中没有采集到的元素，请重新分析');
  if(!rule.identity?.selector||!rule.identity.text)fail('MONITOR_RULE','缺少用于确认页面身份的实际文字');
  if(rule.type==='stock-form'&&(!rule.scope||!rule.submit||!rule.fields?.length))fail('MONITOR_RULE','库存规则必须同时核对商品区域、加购字段和提交按钮');
  if(rule.type==='stock-count'&&!rule.scope)fail('MONITOR_RULE','库存数字必须属于已学习的商品区域');
  if(rule.type==='stock-count'&&(!rule.pattern?.startsWith('^')||!rule.pattern.endsWith('$')||rule.pattern.length>300))fail('MONITOR_RULE','库存数字规则需使用完整匹配模式');
  if(rule.type==='number'&&(!['below','above'].includes(rule.operator)||!Number.isFinite(rule.value)))fail('MONITOR_RULE','价格条件需包含明确的阈值');
  if(rule.type==='text'&&(!['contains','equals'].includes(rule.operator)||typeof rule.value!=='string'||!rule.value.trim()))fail('MONITOR_RULE','关键词条件不能为空');
  if(rule.type==='stock-count')try{new RegExp(rule.pattern);}catch{fail('MONITOR_RULE','库存数字格式无效');}
  return rule;
}
export async function evaluateRule(page,rule,baseline) {
  try {
    const identity=page.locator(rule.identity.selector);
    if(await identity.count()!==1||!await identity.isVisible()||await text(identity)!==rule.identity.text)return {status:'unknown',reason:'页面身份与学习记录不符，可能需要登录或页面已变化'};
    if(rule.type==='stock-form') {
      const scope=page.locator(rule.scope);
      if(await scope.count()!==1||!await scope.isVisible())return {status:'unknown',reason:'找不到已学习的商品区域'};
      const fields=rule.fields.map(selector=>page.locator(selector)),submit=page.locator(rule.submit);
      if(await submit.count()!==1||!await submit.isVisible()||!await submit.isEnabled())return {status:'unknown',reason:'加购表单或按钮尚未出现'};
      for(const field of fields)if(await field.count()!==1)return {status:'unknown',reason:'加购字段缺失'};
      const identityInScope=await scope.evaluate((container,selector)=>{const element=document.querySelector(selector);return element&&container.contains(element);},rule.identity.selector);
      if(!identityInScope)return {status:'unknown',reason:'商品名称不在已学习的商品区域中'};
      for(const field of fields)if(await field.getAttribute('type')==='password')return {status:'unknown',reason:'登录表单不能作为库存信号'};
      const inScope=await scope.evaluate((container,selectors)=>selectors.every(selector=>{const element=document.querySelector(selector);return element&&container.contains(element);}),[...rule.fields,rule.submit]);
      const form=await submit.evaluate(element=>{const form=element.form||element.closest('form');return !!form&&!form.querySelector('input[type="password"]');});
      if(!inScope||!form)return {status:'unknown',reason:'字段和按钮不属于同一商品的加购表单'};
      const sameForm=await submit.evaluate((element,selectors)=>{const form=element.form||element.closest('form');return selectors.every(selector=>{const field=document.querySelector(selector);return field&&(field.form||field.closest('form'))===form;});},rule.fields);
      return sameForm?{status:'matched',value:'加购表单完整可用'}:{status:'unknown',reason:'加购字段和按钮未归属于同一表单'};
    }
    const locator=page.locator(rule.selector);
    if(await locator.count()!==1||!await locator.isVisible())return {status:'unknown',reason:'目标元素缺失或不唯一'};
    const value=await text(locator);
    if(rule.type==='stock-count') {
      const scope=page.locator(rule.scope);
      if(await scope.count()!==1||!await scope.isVisible()||!await scope.evaluate((container,selectors)=>selectors.every(selector=>{const element=document.querySelector(selector);return element&&container.contains(element);}),[rule.selector,rule.identity.selector]))return {status:'unknown',reason:'库存数字与商品名称不属于同一区域'};
      const match=new RegExp(rule.pattern).exec(value),quantity=match?Number(match[1]):NaN;
      if(!Number.isSafeInteger(quantity)||quantity<0||quantity!==stockNumber(value))return {status:'unknown',reason:'页面未提供可核验的库存数字'};
      return {status:quantity>0?'matched':'clear',value,quantity};
    }
    if(rule.type==='number') {
      const matches=value.replaceAll(',','').match(/-?\d+(?:\.\d+)?/g);
      if(matches?.length!==1)return {status:'unknown',reason:'价格区域中无法识别唯一金额'};
      const amount=Number(matches[0]),matched=rule.operator==='below'?amount<rule.value:amount>rule.value;
      return {status:matched?'matched':'clear',value,amount};
    }
    if(rule.type==='text')return {status:(rule.operator==='equals'?value===rule.value:value.includes(rule.value))?'matched':'clear',value};
    if(rule.type==='change')return {status:baseline!==undefined&&value!==baseline?'matched':'clear',value};
    return {status:'unknown',reason:'未知规则类型'};
  }catch(error){return {status:'unknown',reason:'页面元素读取失败：'+error.message};}
}
export function ruleDescription(rule) {
  if(rule.type==='stock-form')return '商品区域内，加购字段与可点击按钮同时存在';
  if(rule.type==='stock-count')return '商品库存数字大于 0';
  if(rule.type==='number')return '价格'+(rule.operator==='below'?'低于 ':'高于 ')+rule.value;
  if(rule.type==='text')return (rule.operator==='equals'?'文字等于「':'文字包含「')+rule.value+'」';
  return '目标内容发生变化，并经再次检查确认';
}
