import {matchesUrl} from '../workflow/schema.js';
import {Fault,fail} from '../errors.js';
export const requestData=request=>({url:request.url(),method:request.method(),body:request.postData()||''});
export class RequestGate {
  constructor(site,kernel) {this.site=site;this.kernel=kernel;this.pending=null;this.lastError=null;this.sent=0;this.auth=null;}
  arm(permit,request){if(this.pending)fail('UNCERTAIN','已有等待发送的写操作');this.pending={permit,request};this.lastError=null;}
  disarm(){const result=this.pending;this.pending=null;return result;}
  async route(route) {
    const request=route.request(),data=requestData(request),url=new URL(data.url);
    try {
      if(this.pending&&data.url===this.pending.request.url&&data.method===this.pending.request.method) {
        this.kernel.consume(this.pending.permit,data);this.pending=null;this.sent++;return await route.continue();
      }
      if(this.manualLogin&&this.site.login&&url.origin===this.site.origin&&data.method===this.site.login.request.method&&matchesUrl(this.site.login.request,data.url)){this.manualLogin=false;return await route.continue();}
      if(this.auth&&data.url===this.auth.url&&data.method===this.auth.method&&data.body===this.auth.body) {this.auth=null;return await route.continue();}
      const commerce=url.origin===this.site.origin&&(this.site.writes||[]).some(rule=>rule.method===data.method&&matchesUrl(rule,data.url));
      if(commerce)fail('NO_PERMIT','写请求没有单次操作许可');
      if(data.method==='GET'&&((url.origin===this.site.origin&&(this.site.reads||[]).some(rule=>matchesUrl(rule,data.url)))||['script','stylesheet','image','font','media'].includes(request.resourceType())))
        return await route.continue();
      if((this.site.browserRequests||[]).some(rule=>url.origin===(rule.origin||this.site.origin)&&data.method===rule.method&&matchesUrl(rule,data.url)))return await route.continue();
      fail('REQUEST_BLOCKED','请求不在站点已学习的只读或验证请求范围',{url:url.origin+url.pathname,method:data.method});
    } catch(error) {
      this.lastError=error instanceof Fault?error:new Fault(error.code||'NETWORK',error.message,{cause:error});
      await route.abort('blockedbyclient');
    }
  }
}
export async function formRequest(locator,site,rule) {
  const result=await locator.evaluate((button)=>{
    if(button.tagName==='A')return {url:new URL(button.href,location.href).href,method:'GET',body:''};
    const form=button.form||button.closest('form');if(!form)throw new Error('操作按钮不属于原生表单');
    const method=(button.getAttribute('formmethod')||form.getAttribute('method')||'GET').toUpperCase();
    const encoding=button.getAttribute('formenctype')||form.getAttribute('enctype')||'application/x-www-form-urlencoded';
    if(method==='POST'&&encoding!=='application/x-www-form-urlencoded')throw new Error('当前链路仅支持原生 URL 编码表单');
    const values=[...new FormData(form)].map(([k,v])=>{if(typeof v!=='string')throw new Error('交易表单不支持文件字段');return [k,v.replace(/\r?\n/g,'\r\n')];});
    if(button.name&&!button.disabled)values.push([button.name,button.value]);
    const url=new URL(button.getAttribute('formaction')||form.getAttribute('action')||location.href,location.href);url.hash='';
    const body=new URLSearchParams(values).toString();
    if(method==='GET')url.search=body;
    return {url:url.href,method,body:method==='GET'?'':body};
  });
  if(new URL(result.url).origin!==site.origin||result.method!==rule.method||!matchesUrl(rule,result.url))fail('REQUEST_MISMATCH','表单动作与本站点实测请求不一致');
  return result;
}
