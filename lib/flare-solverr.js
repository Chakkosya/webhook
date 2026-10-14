import {randomUUID} from 'node:crypto';

const emptyResult=()=>({cookies:[],userAgent:'',clearanceObtained:false});
const failure=(code='FLARESOLVERR_FAILED')=>Object.assign(new Error({
  FLARESOLVERR_FAILED:'FlareSolverr challenge solving failed',
  FLARESOLVERR_TIMEOUT:'FlareSolverr request timed out',
  FLARESOLVERR_ABORTED:'FlareSolverr request cancelled'
}[code]),{code});
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback;

function normalizeCookies(cookies,host,now){
  if(!Array.isArray(cookies))return [];
  return cookies.flatMap(cookie=>{
    if(!cookie||typeof cookie.name!=='string'||!cookie.name||typeof cookie.value!=='string'||typeof cookie.domain!=='string')return [];
    const domain=cookie.domain.toLowerCase(),bare=domain.replace(/^\./,'');
    if(host!==bare&&!(domain.startsWith('.')&&cookie.hostOnly!==true&&host.endsWith(`.${bare}`)))return [];
    const rawExpires=cookie.expires??cookie.expiry;
    const expires=Number.isFinite(rawExpires)&&rawExpires>0?rawExpires:-1;
    if(expires!==-1&&expires<=now/1000)return [];
    const sameSite={strict:'Strict',lax:'Lax',none:'None'}[String(cookie.sameSite||'').toLowerCase()];
    return [{name:cookie.name,value:cookie.value,domain:cookie.hostOnly?bare:domain,
      path:typeof cookie.path==='string'&&cookie.path.startsWith('/')?cookie.path:'/',
      expires,httpOnly:cookie.httpOnly===true,secure:cookie.secure===true,...(sameSite?{sameSite}:{})}];
  });
}

export function createFlareSolverrClient({fetchImpl=fetch,env=process.env,now=Date.now,createSessionId=randomUUID,maxSessions=32}={}){
  const sessions=new Map();
  let queue=Promise.resolve(),cleanupTimer,cleanupQueued=false;
  const enabled=()=>String(env.FLARESOLVERR_ENABLED??'0')==='1';
  const enqueue=operation=>{
    const result=queue.then(operation);
    queue=result.catch(()=>{});
    return result;
  };
  async function request(body,signal,background=false){
    if(!enabled())throw failure();
    if(signal?.aborted)throw failure('FLARESOLVERR_ABORTED');
    const controller=new AbortController();
    let timer,onAbort;
    try{
      const endpoint=new URL(env.FLARESOLVERR_URL||'http://flaresolverr:8191/v1');
      if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw failure();
      const path=endpoint.pathname.replace(/\/+$/,'');
      endpoint.pathname=path.endsWith('/v1')?path:`${path}/v1`;
      const interruption=new Promise((_,reject)=>{
        onAbort=()=>{controller.abort();reject(failure('FLARESOLVERR_ABORTED'));};
        signal?.addEventListener('abort',onAbort,{once:true});
        timer=setTimeout(()=>{controller.abort();reject(failure('FLARESOLVERR_TIMEOUT'));},positive(env.FLARESOLVERR_TIMEOUT_MS,60000));
        if(background)timer.unref?.();
      });
      return await Promise.race([interruption,(async()=>{
        const response=await fetchImpl(endpoint.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
        if(!response.ok)throw failure();
        const result=await response.json();
        if(result?.status!=='ok')throw failure();
        return result;
      })()]);
    }catch(error){
      if(error?.code==='FLARESOLVERR_ABORTED'||error?.code==='FLARESOLVERR_TIMEOUT')throw failure(error.code);
      throw failure();
    }finally{
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
    }
  }
  async function destroy(key,entry,signal,background=false){
    try{
      await request({cmd:'sessions.destroy',session:entry.id},signal,background);
    }catch(error){
      if(signal?.aborted)throw error;
    }finally{
      sessions.delete(key);
      if(!sessions.size){clearInterval(cleanupTimer);cleanupTimer=undefined;}
    }
  }
  async function cleanup(signal,background=false){
    for(const [key,entry] of sessions){
      if(entry.expires<=now())await destroy(key,entry,signal,background);
    }
  }
  function startCleanup(){
    if(cleanupTimer)return;
    cleanupTimer=setInterval(()=>{
      if(enabled()&&!cleanupQueued){
        cleanupQueued=true;
        void enqueue(()=>enabled()?cleanup(undefined,true):undefined).catch(()=>{}).finally(()=>{cleanupQueued=false;});
      }
    },60000);
    cleanupTimer.unref?.();
  }
  async function solve(url,{proxyUrl='',signal,sessionKey=''}={}){
    if(!enabled())return emptyResult();
    if(signal?.aborted)throw failure('FLARESOLVERR_ABORTED');
    const externalSignal=signal,controller=new AbortController();
    signal=controller.signal;
    let timer,onAbort;
    const interruption=new Promise((_,reject)=>{
      onAbort=()=>{reject(failure('FLARESOLVERR_ABORTED'));controller.abort();};
      externalSignal?.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{reject(failure('FLARESOLVERR_TIMEOUT'));controller.abort();},positive(env.FLARESOLVERR_TIMEOUT_MS,60000));
    });
    const operation=enqueue(async()=>{
      if(!enabled())return emptyResult();
      try{
        if(signal?.aborted)throw failure('FLARESOLVERR_ABORTED');
        const target=new URL(url);
        if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw failure();
        let proxy;
        if(proxyUrl){
          const parsed=new URL(proxyUrl);
          if(!['http:','https:','socks4:','socks5:'].includes(parsed.protocol))throw failure();
          proxy={url:`${parsed.protocol}//${parsed.host}`};
          if(parsed.username)proxy.username=decodeURIComponent(parsed.username);
          if(parsed.password)proxy.password=decodeURIComponent(parsed.password);
        }
        const key=JSON.stringify([String(sessionKey),target.origin,proxyUrl]);
        const ttl=positive(env.FLARESOLVERR_SESSION_TTL,15);
        await cleanup(signal);
        let entry=sessions.get(key);
        if(!entry){
          if(sessions.size>=positive(maxSessions,32)){
            const [oldKey,oldEntry]=sessions.entries().next().value;
            await destroy(oldKey,oldEntry,signal);
          }
          const id=createSessionId();
          await request({cmd:'sessions.create',session:id,...(proxy?{proxy}:{})},signal);
          entry={id,expires:now()+ttl*60000};
          sessions.set(key,entry);
          startCleanup();
        }
        const result=await request({cmd:'request.get',url:target.href,session:entry.id,
          maxTimeout:positive(env.FLARESOLVERR_TIMEOUT_MS,60000),session_ttl_minutes:ttl},signal);
        if(!result.solution||!Array.isArray(result.solution.cookies))throw failure();
        const cookies=normalizeCookies(result.solution.cookies,target.hostname.toLowerCase(),now());
        return {cookies,userAgent:typeof result.solution.userAgent==='string'?result.solution.userAgent:'',
          clearanceObtained:cookies.some(cookie=>cookie.name==='cf_clearance'&&cookie.value.length>0)};
      }catch(error){
        if(error?.code==='FLARESOLVERR_ABORTED'||error?.code==='FLARESOLVERR_TIMEOUT')throw failure(error.code);
        throw failure();
      }
    });
    try{
      return await Promise.race([interruption,operation]);
    }finally{
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort',onAbort);
    }
  }
  return {enabled,solve};
}

export const flareSolverrClient=createFlareSolverrClient();
