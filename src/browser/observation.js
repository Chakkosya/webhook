import {chromium} from 'playwright-core';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {browserExecutable} from './session.js';
import {openProxy} from './proxy.js';
import {Progress,perform,until} from './wait.js';
import {fail} from '../errors.js';
const bootstrap={absoluteMs:180000,idleMs:45000};
function actionUrl(url) {
  const value=new URL(url);
  return /\/(?:checkout|logout|addtocart|delete|purchase|pay)(?:[/.]|$)/i.test(value.pathname)||['a','action','do'].some(key=>/^(?:add|checkout|complete|logout|delete|pay|applypromo|removepromo)$/i.test(value.searchParams.get(key)||''));
}
export function monitorUrl(value) {
  let url;try{url=new URL(value);}catch{fail('MONITOR_URL','请填写完整的网页地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||actionUrl(url))fail('MONITOR_URL','请使用只读的商品或内容页面，不使用下单、付款或退出地址');
  url.hash='';return url.href;
}
export class ObservationBrowser {
  constructor({dataDir,id,profile,headless=true}){Object.assign(this,{dataDir,id,profile,headless});}
  async open() {
    this.route=await openProxy(this.profile);
    try {
      const directory=join(this.dataDir,'monitor-browser',this.id);await mkdir(directory,{recursive:true});
      this.context=await chromium.launchPersistentContext(directory,{headless:this.headless,executablePath:await browserExecutable(process.env.BROWSER_EXECUTABLE),proxy:this.route.proxy,args:this.route.proxy?['--proxy-bypass-list=<-loopback>']:[],serviceWorkers:'block',viewport:{width:1280,height:900}});
      await this.context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        const challenge=url.pathname.startsWith('/cdn-cgi/challenge-platform/');
        if(!challenge&&(!['GET','HEAD'].includes(request.method())||actionUrl(url)))return route.abort('blockedbyclient');
        return route.continue();
      });
      this.page=this.context.pages()[0]||await this.context.newPage();
      this.page.on('response',response=>{if(response.request().isNavigationRequest()&&response.frame()===this.page.mainFrame())this.documentStatus=response.status();});
      this.progress=new Progress(this.page);await this.progress.connect();
      return this;
    } catch(error){await this.close();throw error;}
  }
  async read(url,policy=bootstrap) {
    url=monitorUrl(url);const started=Date.now();this.progress.touch();
    await perform(()=>this.page.goto(url,{waitUntil:'domcontentloaded',timeout:policy.absoluteMs}),policy,this.progress);
    const remaining={...policy,absoluteMs:Math.max(1,policy.absoluteMs-(Date.now()-started))};
    await until(async()=>{
      const ready=await this.page.evaluate(()=>{
        const title=document.title.toLowerCase();
        return !!document.body?.innerText.trim()&&!title.includes('just a moment')&&!title.includes('attention required')&&!document.querySelector('#challenge-running,#cf-challenge-running');
      });
      return ready&&this.progress.active===0&&Date.now()-this.progress.last>=400;
    },remaining,this.progress);
    if(this.documentStatus>=400)fail('NETWORK','监控页面返回 HTTP '+this.documentStatus);
    return Date.now()-started;
  }
  async snapshot() {
    return this.page.evaluate(()=>{
      const selector=element=>{
        if(element.id){const value='#'+CSS.escape(element.id);if(document.querySelectorAll(value).length===1)return value;}
        const parts=[];for(let node=element;node&&node!==document.body;node=node.parentElement){const siblings=[...node.parentElement.children].filter(item=>item.tagName===node.tagName);parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');}
        return 'body > '+parts.join(' > ');
      };
      const visible=element=>!!element.getBoundingClientRect().width&&!!element.getBoundingClientRect().height;
      const candidates=[...document.body.querySelectorAll('h1,h2,h3,p,span,div,section,article,main,form,button,input,select,a,td,th,li,strong,output')];
      const elements=candidates.filter(element=>!element.closest('script,style,noscript')&&(visible(element)||element.matches('input[type="hidden"]'))).filter(element=>element.matches('form,button,input,select')||element.textContent.trim().length<800).slice(0,700).map(element=>({
        selector:selector(element),tag:element.tagName.toLowerCase(),type:element.getAttribute('type'),name:element.getAttribute('name'),
        text:element.matches('input,select')?undefined:element.textContent.trim().slice(0,800),
        disabled:element.matches('button,input,select')?element.disabled:undefined,
        form:element.form?selector(element.form):undefined,
        fields:element.matches('form')?[...element.querySelectorAll('input,select')].filter(item=>item.type!=='password').map(selector):undefined
      }));
      return {url:location.origin+location.pathname,title:document.title,elements};
    });
  }
  async close(){this.progress?.close();await this.context?.close();await this.route?.close();}
}
