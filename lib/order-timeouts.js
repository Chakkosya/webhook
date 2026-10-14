import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {diagnosticError,diagnosticAIInput,diagnosticAIOutput,diagnosticUrl} from './order-execution-log.js';

export const DEFAULT_ORDER_TIMEOUTS=Object.freeze({aiTimeoutMs:120000,agentTimeoutMs:600000,trialTimeoutMs:1500000,restockAiTimeoutMs:180000,restockAgentTimeoutMs:1800000});
export function readOrderTimeouts(env=process.env){
  const duration=(name,fallback,max)=>{const value=Number(env[name]);return Number.isFinite(value)&&value>=1000&&value<=max?Math.round(value):fallback;};
  return {aiTimeoutMs:duration('ORDER_AI_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.aiTimeoutMs,300000),agentTimeoutMs:duration('ORDER_AGENT_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.agentTimeoutMs,1800000),trialTimeoutMs:duration('ORDER_TRIAL_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.trialTimeoutMs,3600000),restockAiTimeoutMs:duration('ORDER_RESTOCK_AI_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.restockAiTimeoutMs,300000),restockAgentTimeoutMs:duration('ORDER_RESTOCK_AGENT_TIMEOUT_MS',DEFAULT_ORDER_TIMEOUTS.restockAgentTimeoutMs,1800000)};
}
export function getOrderTimeouts(trigger='manual',env=process.env){
  const restock=trigger==='restock',normal=readOrderTimeouts(env);
  return {...normal,...(restock?{aiTimeoutMs:normal.restockAiTimeoutMs,agentTimeoutMs:normal.restockAgentTimeoutMs}:{}),
    aiRetries:restock?2:1,probeTimeoutMs:restock?10000:3000,loginVerificationTimeoutMs:restock?30000:12000,couponVerificationTimeoutMs:restock?30000:12000,
    pageTimeoutMs:restock?60000:8000,navigationTimeoutMs:restock?120000:15000,submitRequestTimeoutMs:restock?20000:8000,submitResponseTimeoutMs:restock?120000:15000,redirectTimeoutMs:restock?120000:15000};
}
export function orderTimeoutError(code,stage,timeoutMs){
  return Object.assign(new Error(stage+'超时（等待 '+Number((timeoutMs/1000).toFixed(2))+' 秒），请查看执行日志后重试'),{code,stage,timeoutMs});
}
export function createOrderDeadline({signal,timeoutMs,code,stage}){
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>controller.abort(orderTimeoutError(code,stage,timeoutMs)),timeoutMs);
  return {signal:controller.signal,close:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
}
// Racing reads also bounds injected transports that fail to honor cancellation.
// Late replies never authorize an action, and their rejections remain handled.
export async function abortable(operation,signal){
  signal?.throwIfAborted();let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  try{const result=await Promise.race([Promise.resolve().then(()=>{signal?.throwIfAborted();return operation();}),cancelled]);signal?.throwIfAborted();return result;}
  finally{signal?.removeEventListener('abort',abort);}
}
export async function requestOrderAI(requestAI,user,messages,{signal,trigger='manual',timeoutMs=getOrderTimeouts(trigger).aiTimeoutMs,stage='页面规划',maxRetries=getOrderTimeouts(trigger).aiRetries,retryDelayMs=1000,onEvent=()=>{}}={}){
  const requestId=randomUUID(),emit=(action,data)=>{try{onEvent(action,{requestId,stage,...data});}catch{/* Logging cannot alter a request or authorize a retry. */}};
  const input=diagnosticAIInput(messages);
  for(let attempt=0;attempt<=maxRetries;attempt++){
    signal?.throwIfAborted();
    const deadline=createOrderDeadline({signal,timeoutMs,code:'ORDER_AI_TIMEOUT',stage:stage+'：AI 响应'});
    const started=Date.now();
    emit('AI 请求开始',{attempt:attempt+1,maxAttempts:maxRetries+1,timeoutMs,retryDelayMs,model:user.settings?.aiModel||null,endpoint:user.settings?.aiBaseUrl?diagnosticUrl(user.settings.aiBaseUrl):null,input});
    try{
      const output=await abortable(()=>requestAI(user,messages,{signal:deadline.signal,timeoutMs,stage,onMetadata:metadata=>{if(!deadline.signal.aborted)emit('AI 传输信息',{attempt:attempt+1,...metadata});}}),deadline.signal);
      emit('AI 响应完成',{attempt:attempt+1,durationMs:Date.now()-started,response:diagnosticAIOutput(output)});return output;
    }
    catch(error){
      if(signal?.aborted){emit('AI 请求取消',{attempt:attempt+1,durationMs:Date.now()-started,error:diagnosticError(signal.reason)});throw signal.reason;}
      const timedOut=deadline.signal.aborted||/timeout|timed out|aborted due to timeout/i.test([error.code,error.name,error.networkCode,error.cause?.code,error.message].join(' '));
      const status=Number(error.status||error.statusCode||error.responseStatus||error.response?.status||String(error.message).match(/\b(?:HTTP\s*)?(401|429|5\d\d)\b/i)?.[1]);
      const connectionReset=/ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_SOCKET|socket hang up|connection (?:reset|closed)/i.test([error.code,error.networkCode,error.cause?.code,error.message,error.cause?.message].join(' '));
      const retryReason=status===401?null:timedOut?'timeout':status===429?'HTTP 429':status>=500&&status<=599?'HTTP '+status:connectionReset?'connection reset':null;
      if(!retryReason){emit('AI 请求失败',{attempt:attempt+1,durationMs:Date.now()-started,error:diagnosticError(error)});throw error;}
      const failure=timedOut?orderTimeoutError('ORDER_AI_TIMEOUT',stage+'：AI 响应',timeoutMs):error;
      failure.retryable=true;failure.attempts=attempt+1;failure.elapsedMs=Date.now()-started;
      if(attempt===maxRetries){emit(timedOut?'AI 请求超时':'AI 请求失败',{attempt:attempt+1,timeoutMs,elapsedMs:failure.elapsedMs,retryReason,error:diagnosticError(error)});throw failure;}
      const backoffMs=retryDelayMs*2**attempt;
      emit(timedOut?'AI 请求超时，重新请求':'AI 请求失败，重新请求',{attempt:attempt+1,nextAttempt:attempt+2,timeoutMs,elapsedMs:failure.elapsedMs,retryDelayMs:backoffMs,retryReason,error:diagnosticError(error)});
      deadline.close();
      try{await delay(backoffMs,undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason;throw error;}
    }finally{deadline.close();}
  }
}
