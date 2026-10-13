import {matchesProductSelection,matchesOrderConfiguration} from '../../lib/order-evidence.js';
import {agentError} from './model.js';
const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();

// A browser binding failure is an implementation problem, not missing user intent.
export function bindingFailure(){
  return agentError('AGENT_BINDING_FAILED','暂时未能识别这个页面的购买步骤。商品链接、名称和购买要求已保留，无需重复填写。可以重新准备，或点选页面中的商品后再试。');
}
export function stopError(step,observation,order={},workflow={}){
  if(/out\s+of\s+stock|sold\s+out|缺货|无货|售罄/i.test(step.reason))return agentError('ORDER_OUT_OF_STOCK',step.reason);
  if(/captcha|验证码|人机验证|二次验证/i.test(step.reason))return agentError('ORDER_CHALLENGE_REQUIRED',step.reason);
  const choice=step.clarification;
  if(!choice) return agentError('AGENT_PLAN_INVALID','当前步骤未识别成功：'+step.reason+'。请先使用用户已提供的商品网址、名称和购买要求，根据当前页面继续识别；只有具体购买选择才能向用户提问。');
  const elements=(observation.elements||[]).filter(el=>el.visible!==false&&!el.disabled&&!['hidden','password'].includes(el.type));
  const labels=new Set(elements.flatMap(el=>[el.label,el.accessibleName,el.text,...(el.options||[]).filter(option=>!option.disabled).map(option=>option.text)]).filter(Boolean).map(normalize));
  const options=choice.options||[],field=elements.find(el=>el.ref===choice.fieldRef);
  const choices=Array.isArray(options)&&options.length>=2&&options.length<=8&&new Set(options.map(normalize)).size===options.length&&options.every(option=>typeof option==='string'&&option.length<=200&&labels.has(normalize(option)));
  const requiredField=field?.required&&['input','textarea'].includes(field.tag)&&['textbox','spinbutton'].includes(field.role)&&!String(field.value||'').trim()&&(field.label||field.accessibleName);
  if(typeof choice.question!=='string'||!choice.question.trim()||choice.question.length>500||!choices&&!requiredField)throw agentError('AGENT_PLAN_INVALID','确认问题必须包含当前页面真实可选的不同选项，或一个尚未填写的必填项；不能让用户解释页面结构或重复提供商品。');
  const previous=order.userClarification;
  const expected=(workflow.requirements||[]).map(item=>item.value);
  if(previous?.url===observation.url)expected.push(previous.answer);
  const decided=choices?options.filter(option=>matchesProductSelection(order.product,option)||expected.some(value=>matchesOrderConfiguration(value,option))):[];
  if(decided.length===1)throw agentError('AGENT_PLAN_INVALID','用户已明确选择「'+decided[0]+'」，请按已有商品、购买要求或回答继续，不要再次询问相同选择。');
  if(previous?.url===observation.url&&normalize(previous.question)===normalize(choice.question))throw agentError('AGENT_PLAN_INVALID','用户已经回答这个问题：'+previous.answer+'。请使用保存的回答处理当前选择，不要重复询问。');
  const error=agentError('AGENT_NEEDS_INPUT',choice.question);
  error.orderInput={kind:choices?'page_choice':'page_value',question:choice.question.trim(),reason:'只需确认这一项，其他购买要求保持不变。',url:observation.url,action:step.action,code:error.code,options:choices?options:[],candidates:requiredField?[{label:field.label||field.accessibleName}]:[]};
  return error;
}
