import {agentError,validateTarget} from '../agent/model.js';
export const LOCATOR_PRIORITY=Object.freeze(['css','xpath','id','aria','text','label','placeholder','name']);
export function locatorCandidates(element){
  const values={css:element.runtimeSelector,xpath:element.runtimeXPath,id:element.id,aria:element.role&&element.accessibleName,text:element.text,label:element.label,placeholder:element.placeholder,name:element.name};
  return LOCATOR_PRIORITY.filter(strategy=>values[strategy]).map(strategy=>({strategy,value:values[strategy],...(strategy==='aria'?{role:element.role}:{})}));
}
export async function probeLocator(operation,{probeTimeoutMs=3000,signal}={}){
  signal?.throwIfAborted();
  let timer,onAbort;
  try{
    return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(agentError('AGENT_PROBE_TIMEOUT','页面定位探针超时')),probeTimeoutMs);
      onAbort=()=>reject(signal.reason);signal?.addEventListener('abort',onAbort,{once:true});
    })]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
export async function resolveSemanticTarget(page,observation,target,{probeTimeoutMs=3000,signal}={}){
  target=validateTarget(target);
  const probe=operation=>probeLocator(operation,{probeTimeoutMs,signal});
  const element=observation?.elements.find(el=>el.ref===target.ref);
  if(!element)throw agentError('AGENT_ELEMENT_MISSING','语义元素不在当前观察中');
  const marker=observation.observationId+':'+element.ref;
  const runtimeSelector='[data-agent-ref='+JSON.stringify(marker)+']';
  const candidates=locatorCandidates({...element,runtimeSelector,runtimeXPath:'xpath=//*[@data-agent-ref='+JSON.stringify(marker)+']'});
  const direct=page.locator(runtimeSelector),attempts=[];
  try{
    if(await probe(()=>direct.count({timeout:probeTimeoutMs}))!==1)throw agentError('AGENT_OBSERVATION_STALE','当前页面观察已失效，请重新观察');
  }catch(error){
    if(error.code!=='AGENT_PROBE_TIMEOUT'&&error.name!=='TimeoutError')throw error;
    attempts.push({strategy:'css',outcome:'timeout'});
  }
  for(const candidate of candidates){
    const locator=candidate.strategy==='aria'?page.getByRole(candidate.role,{name:candidate.value,exact:true}):candidate.strategy==='text'?page.getByText(candidate.value,{exact:true}):candidate.strategy==='label'?page.getByLabel(candidate.value,{exact:true}):candidate.strategy==='placeholder'?page.getByPlaceholder(candidate.value,{exact:true}):candidate.strategy==='name'?page.locator('[name='+JSON.stringify(candidate.value)+']'):candidate.strategy==='id'?page.locator('[id='+JSON.stringify(candidate.value)+']'):page.locator(candidate.value);
    if(candidate.strategy==='css'&&attempts.some(attempt=>attempt.strategy==='css'&&attempt.outcome==='timeout'))continue;
    try{
      const attempt=await probe(async()=>{
        const matchCount=await locator.count({timeout:probeTimeoutMs});
        if(matchCount!==1)return {matchCount,outcome:matchCount?'ambiguous':'missing'};
        if(await locator.getAttribute('data-agent-ref',{timeout:probeTimeoutMs})!==marker)return {matchCount,outcome:'different_observed_element'};
        if(element.visible&&!await locator.isVisible({timeout:probeTimeoutMs}))return {matchCount,outcome:'hidden'};
        return {matchCount,outcome:'matched'};
      });
      attempts.push({strategy:candidate.strategy,...attempt});
      if(attempt.outcome==='matched')return {selector:runtimeSelector,strategy:candidate.strategy,meaning:target.meaning,confidence:target.confidence,attempts};
    }catch(error){
      if(error.code!=='AGENT_PROBE_TIMEOUT'&&error.name!=='TimeoutError')throw error;
      attempts.push({strategy:candidate.strategy,outcome:'timeout'});
    }
  }
  throw Object.assign(agentError('AGENT_ELEMENT_MISSING','当前页面语义元素已变化或不唯一：'+target.meaning),{locatorAttempts:attempts,target:{meaning:target.meaning,ref:target.ref,confidence:target.confidence}});
}
