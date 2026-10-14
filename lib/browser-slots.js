// Reserve capacity for triggered orders. Closing still owns a slot until exit,
// but immediate follow-up operations may wait briefly for that exit.
export function readBrowserSlotLimits(env=process.env){
  const limit=(name,fallback)=>{const value=Number(env[name]);return Number.isSafeInteger(value)&&value>0?value:fallback;};
  return {max:limit('BROWSER_MAX_SLOTS',4),backgroundMax:limit('BROWSER_BACKGROUND_MAX',2),verificationMax:limit('BROWSER_VERIFY_MAX',1)};
}
export function createBrowserSlots({max=readBrowserSlotLimits().max,backgroundMax=readBrowserSlotLimits().backgroundMax,verificationMax=readBrowserSlotLimits().verificationMax}={}) {
  let active=0,background=0,closing=0,verifying=0;
  const waiters=new Set();
  const slots={
    acquire(financial=false,{verification=false,priority=false}={}) {
      if(active>=max || verification&&verifying>=verificationMax || !financial&&!verification&&background>=backgroundMax || !priority&&[...waiters].some(wake=>wake.priority)) throw Object.assign(new Error('浏览器服务繁忙，请关闭不需要的登录页面后重试'),{code:'ORDER_BROWSER_BUSY'});
      active++;if(verification)verifying++;else if(!financial)background++;
      let released=false,isClosing=false;
      const release=()=>{if(released)return;released=true;active--;if(verification)verifying--;else if(!financial)background--;if(isClosing)closing--;for(const wake of [...waiters].sort((a,b)=>Number(b.priority)-Number(a.priority)))wake();};
      release.closing=()=>{if(!released&&!isClosing){isClosing=true;closing++;}};
      return release;
    },
    async acquireWhenClosing(financial=false,{signal,timeoutMs=5000,verification=false,priority=false}={}) {
      const deadline=Date.now()+timeoutMs;let queued=false;
      for(;;){signal?.throwIfAborted();try{return slots.acquire(financial,{verification,priority});}catch(error){
        const remaining=deadline-Date.now();if(!queued&&!closing&&!verifying||remaining<=0||waiters.size>=8)throw error;
        queued=true;
        await new Promise((resolve,reject)=>{
          let timer;const cleanup=()=>{clearTimeout(timer);waiters.delete(wake);signal?.removeEventListener('abort',abort);};
          const wake=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason);};
          wake.priority=priority;waiters.add(wake);timer=setTimeout(()=>{cleanup();reject(error);},remaining);timer.unref?.();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        });
      }}
    },
    get active(){return active;},get background(){return background;},get waiting(){return waiters.size;}
  };return slots;
}
