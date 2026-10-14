const RETRY_INTERVAL_MS=3*60_000;
const RETRY_WINDOW_MS=2*60*60_000;
const transientCodes=new Set(['ORDER_OUT_OF_STOCK','AGENT_ELEMENT_MISSING','AGENT_PROBE_TIMEOUT','AGENT_OBSERVATION_INCOMPLETE','AGENT_BINDING_FAILED','ORDER_NAVIGATION_UNSTABLE','AGENT_BUDGET_EXCEEDED','ORDER_AI_TIMEOUT','ORDER_BROWSER_BUSY','ORDER_BROWSER_TIMEOUT','ORDER_BROWSER_CLOSED','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE']);
export function isRestockRetryable(task){
  if(task.input||task.failure?.category==='needs_input')return false;
  const code=task.errorCode||task.failure?.code;
  return transientCodes.has(code)||code==='TimeoutError'||task.lastAttempt?.retryable===true;
}
export function localOrderConflict(user,task){
  const same=other=>other===task||other.monitorId===task.monitorId&&other.url===task.url&&(other.product||other.verifiedProduct)===(task.product||task.verifiedProduct)&&other.quantity===task.quantity&&other.maxTotal===task.maxTotal&&other.currency===task.currency&&other.paymentMethod===task.paymentMethod&&other.couponCode===task.couponCode&&JSON.stringify(other.productSelection||null)===JSON.stringify(task.productSelection||null)&&other.instruction===task.instruction;
  const committed=value=>value&&(value.orderId||value.invoiceId||value.submissionStartedAt||value.paymentStartedAt||value.submissionStarted===true||value.paymentStarted===true||['ordered','paid','awaiting_payment','uncertain','payment_failed','partial'].includes(value.status));
  return user.orderTasks.find(other=>same(other)&&(committed(other)||committed(other.result)||committed(other.lastAttempt)||(other.purchases||[]).some(committed)||(other.result?.purchases||[]).some(committed)));
}
export function createRestockRetries({persist,run,check,notify,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
  const timers=new Map(),running=new Set();
  const key=(user,task)=>user.id+':'+task.id;
  function cancel(user,task,reason='cancelled'){
    const id=key(user,task);if(timers.has(id))clearTimer(timers.get(id));timers.delete(id);
    if(task.restockRetry)Object.assign(task.restockRetry,{state:reason,nextAt:null});
    task.enabled=false;task.stockAuthorization=null;
    if(reason!=='completed')task.approvedHash=null;
    persist();
  }
  async function stop(user,task,reason,message){
    cancel(user,task,reason);task.error=message;persist();await notify(user,task).catch(()=>{});
  }
  function schedule(user,task){
    const state=task.restockRetry;
    if(!state||state.state!=='active'||timers.has(key(user,task)))return;
    if(now()>=state.expiresAt){void stop(user,task,'expired','决战重试已达到两小时上限，请人工核实');return;}
    state.nextAt=Math.min(now()+RETRY_INTERVAL_MS,state.expiresAt);persist();
    const timer=setTimer(()=>{timers.delete(key(user,task));void tick(user,task).catch(error=>stop(user,task,'needs_input',error.message));},state.nextAt-now());
    timer?.unref?.();timers.set(key(user,task),timer);
  }
  async function tick(user,task){
      const id=key(user,task);
      if(running.has(id))return;
      if(timers.has(id)){clearTimer(timers.get(id));timers.delete(id);}
      running.add(id);
      try{await attempt(user,task);}finally{running.delete(id);}
    }
    async function attempt(user,task){
      const state=task.restockRetry;
    if(!state||state.state!=='active')return;
    if(now()>=state.expiresAt)return stop(user,task,'expired','决战重试已达到两小时上限，请人工核实');
    if(!user.orderTasks.includes(task)||task.revision!==state.revision)return cancel(user,task,'cancelled');
    if(localOrderConflict(user,task))return stop(user,task,'needs_input','已有订单或提交/付款记录，停止自动重试，请人工核实');
    const result=await check(user,task);
    if(state.state!=='active')return;
    if(result?.busy){schedule(user,task);return;}
    if(!result?.safe)return stop(user,task,'needs_input',result?.message||'无法确认订单状态，停止自动重试，请人工核实');
    if(localOrderConflict(user,task))return stop(user,task,'needs_input','已有订单或提交/付款记录，停止自动重试，请人工核实');
    if(now()>=state.expiresAt)return stop(user,task,'expired','决战重试已达到两小时上限，请人工核实');
    state.attempts++;state.nextAt=null;persist();
    await run(user,task);
    if(state.state!=='active')return;
    if(localOrderConflict(user,task)||task.result){cancel(user,task,task.failure?'needs_input':'completed');return;}
    if(!isRestockRetryable(task)){cancel(user,task,'needs_input');return;}
    if(state.attempts>=5){state.warning='连续失败告警：决战模式保持重试，可随时暂停';persist();await notify(user,task).catch(()=>{});}
    schedule(user,task);
  }
  function start(user,task){
    if(task.restockRetry?.state==='active')return;
    task.restockRetry={state:'active',startedAt:now(),expiresAt:now()+RETRY_WINDOW_MS,revision:task.revision,attempts:0,nextAt:null};schedule(user,task);
  }
  return {start,cancel,tick};
}
