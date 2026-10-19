import {isDeepStrictEqual} from 'node:util';
import {validateWorkflow} from '../workflow/schema.js';
import {fail} from '../errors.js';
const semantics=step=>{const value=structuredClone(step);delete value.timing;return value;};
export function extractWorkflow({id,source,runs,parameters={},orderMarginMs,idleMs}) {
  if(!runs?.length||runs.some(r=>!['ordered','paid'].includes(r.status)))fail('EXTRACTION','提炼需要实际提交成功的完整执行记录');
  const reference=runs[0].steps;
  if(runs.some(r=>!isDeepStrictEqual(r.steps.map(s=>semantics(s.recipe)),reference.map(s=>semantics(s.recipe)))))fail('EXTRACTION','合并样本必须来自相同步骤与定位语义');
  const steps=[];
  for(const entry of reference) {
    if(entry.status!=='verified'||!entry.recipe)fail('EXTRACTION','轨迹存在未核验步骤或缺少定位语义');
    const samples=runs.map(r=>r.steps.find(s=>s.id===entry.id)).map(s=>{
      if(s.status!=='verified'||!Number.isFinite(s.durationMs)||s.durationMs<=0)fail('MEASUREMENTS','每步都必须有成功实测耗时');
      if(['submit','pay'].includes(s.action)&&!s.verified?.invoiceId)fail('EXTRACTION','资金操作缺少账单证据');
      return s.durationMs;
    });
    const previous=steps.at(-1),recipe=structuredClone(entry.recipe);
    if(previous&&['fill','select','check'].includes(recipe.action)&&previous.action===recipe.action&&isDeepStrictEqual(previous.target,recipe.target)) {
      steps.pop();recipe.pre=previous.pre;
      for(let i=0;i<samples.length;i++)samples[i]+=previous.timing.order.samplesMs[i];
    }
    recipe.timing={order:{samplesMs:samples,marginMs:orderMarginMs,idleMs}};
    steps.push(recipe);
  }
  const parameterize=value=>{
    if(typeof value==='string') {
      const match=Object.entries(parameters).find(([,v])=>typeof v==='string'&&v===value&&v.length>0);
      return match?'{{'+match[0]+'}}':value;
    }
    if(Array.isArray(value))return value.map(parameterize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,parameterize(v)]));
    return value;
  };
  return validateWorkflow({schema:1,id,provenance:{kind:'site-recording',source},couponPolicy:runs[0].couponPolicy||'remove-and-continue',steps:parameterize(steps)});
}
