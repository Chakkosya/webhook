import {Fault} from '../errors.js';
export class Progress {
  constructor(page) {
    this.last=Date.now();this.active=0;
    this.onRequest=request=>{if(['document','xhr','fetch','script'].includes(request.resourceType())){this.active++;this.touch();}};
    this.onDone=request=>{if(['document','xhr','fetch','script'].includes(request.resourceType())){this.active=Math.max(0,this.active-1);this.touch();}};
    page.on('request',this.onRequest);page.on('requestfinished',this.onDone);page.on('requestfailed',this.onDone);this.page=page;this.dom=null;
  }
  async connect(){this.cdp=await this.page.context().newCDPSession(this.page);await this.cdp.send('Network.enable');this.cdp.on('Network.dataReceived',()=>this.touch());this.cdp.on('Network.responseReceived',()=>this.touch());}
  touch(){this.last=Date.now();}
  async sample() {
    try {const value=await this.page.evaluate(()=>{if(!window.__workflowProgress){window.__workflowProgress={changes:0};new MutationObserver(()=>window.__workflowProgress.changes++).observe(document,{childList:true,characterData:true,subtree:true});}return {url:location.href,length:document.body?.innerText.length||0,nodes:document.getElementsByTagName('*').length,changes:window.__workflowProgress.changes};});const next=JSON.stringify(value);if(next!==this.dom){this.dom=next;this.touch();}}catch {}
  }
  close(){this.page.off('request',this.onRequest);this.page.off('requestfinished',this.onDone);this.page.off('requestfailed',this.onDone);}
}
export async function until(check,policy,progress,{now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const started=now();let cause;
  while(now()-started<policy.absoluteMs) {
    try{if(await check())return;}catch(error){if(error.code)throw error;cause=error;}
    if(progress) {
      await progress.sample();
      if(now()-progress.last>=policy.idleMs)throw new Fault('TIMEOUT','页面长时间无进展',{cause,details:{kind:'idle',elapsedMs:now()-started}});
    }
    await pause(Math.min(100,Math.max(1,policy.absoluteMs-(now()-started))));
  }
  throw new Fault('TIMEOUT','页面等待达到实测预算的绝对上限',{cause,details:{kind:'absolute',absoluteMs:policy.absoluteMs}});
}
export async function condition(page,c) {
  if(c.kind==='url')return page.url().includes(String(c.includes));
  const el=page.locator(c.selector);
  if(c.kind==='absent')return await el.count()===0||!await el.first().isVisible();
  if(await el.count()!==1||!await el.isVisible())return false;
  if(c.kind==='visible')return true;
  if(c.kind==='checked')return await el.isChecked()===c.equals;
  const value=c.kind==='value'?await el.inputValue():String(await el.textContent()).trim();
  return c.pattern?new RegExp(c.pattern).test(value):value===String(c.equals);
}
export async function conditions(page,checks) {for(const c of checks)if(!await condition(page,c))return false;return true;}

export async function perform(action,policy,progress){
  let done=false,error;const task=Promise.resolve().then(action).then(()=>{done=true;},e=>{error=e;done=true;});
  try{await until(()=>done,policy,progress);await task;if(error)throw error;}
  catch(error){await progress?.cdp?.send('Page.stopLoading').catch(()=>{});throw error;}
}
