import {chromium} from 'playwright-core';
import {mkdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {RequestGate,formRequest} from './gate.js';
import {Progress,until,conditions,perform} from './wait.js';
import {timing} from '../workflow/schema.js';
import {fail,Fault,errorRecord} from '../errors.js';
function hideCredentials(error,values) {
  const hide=value=>values.filter(Boolean).reduce((text,secret)=>text.replaceAll(secret,'[redacted]').replaceAll(JSON.stringify(secret).slice(1,-1),'[redacted]'),String(value));
  const result=new Error(hide(error.message));result.name=error.name;result.code=error.code;result.stack=hide(error.stack||error.message);
  const scrub=value=>typeof value==='string'?hide(value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value;
  result.details=scrub(error.details);
  if(error.cause)result.cause=hideCredentials(error.cause,values);
  return result;
}
export class BrowserSession {
  constructor({site,kernel,dataDir,executablePath,headless=true,getCredentials=()=>null,onAuthenticated=()=>{},onEvent=()=>{}}) {
    Object.assign(this,{site,kernel,dataDir,executablePath,headless,getCredentials,onAuthenticated,onEvent});
    this.busy=false;this.timer=null;this.lastHealth=null;
  }
  async open({manual=false}={}) {
    const profile=join(this.dataDir,'browser',this.site.account);await mkdir(profile,{recursive:true});
    this.gate=new RequestGate(this.site,this.kernel);
    this.context=await chromium.launchPersistentContext(profile,{headless:this.headless,executablePath:this.executablePath,serviceWorkers:'block',viewport:{width:1280,height:900},proxy:this.site.proxy?{server:this.site.proxy.server,username:process.env[this.site.proxy.usernameEnv],password:process.env[this.site.proxy.passwordEnv]}:undefined});
    await this.context.route('**/*',route=>this.gate.route(route));
    this.page=this.context.pages()[0]||await this.context.newPage();this.monitorPage=await this.context.newPage();
    this.progress=new Progress(this.page);this.monitorProgress=new Progress(this.monitorPage);
    await Promise.all([this.progress.connect(),this.monitorProgress.connect()]);
    if(manual){this.gate.manualLogin=true;await this.goto(this.page,this.site.login?.url||this.site.accountUrl);return this;}
    await this.warm();return this;
  }
  async goto(page,url,kind='order',override) {
    const policy=override||timing(this.site.timing,kind),progress=page===this.page?this.progress:this.monitorProgress;
    this.gate.lastError=null;progress.touch();
    const started=Date.now();let done=false,error;
    const task=page.goto(url,{waitUntil:'domcontentloaded',timeout:policy.absoluteMs}).then(()=>{done=true;},e=>{error=e;done=true;});
    try {
      await until(()=>done,policy,progress);await task;if(error)throw this.gate.lastError||error;
      if(this.site.challenge?.length)await until(async()=>!await conditions(page,this.site.challenge),{...policy,absoluteMs:Math.max(1,policy.absoluteMs-(Date.now()-started))},progress);
    }catch(error){await page.evaluate(()=>window.stop()).catch(()=>{});throw this.gate.lastError||error;}
  }
  ready(){this.lastHealth={at:new Date().toISOString(),status:'ready'};}
  async resetAuthentication() {
    const client=await this.context.newCDPSession(this.page);
    try{await client.send('Storage.clearDataForOrigin',{origin:this.site.origin,storageTypes:'all'});}finally{await client.detach();}
  }
  async warm() {
    if(this.getCredentials()?.needsLogin){await this.resetAuthentication();await this.login();}
    else {await this.goto(this.page,this.site.accountUrl);if(!await this.authenticated(this.page))await this.login();}
    for(const url of this.site.warmupUrls||[])await this.goto(this.page,url);
    await this.goto(this.page,this.site.accountUrl);
    if(!await this.authenticated(this.page))fail('SESSION','预热后会话未登录');
    this.ready();
  }
  async authenticated(page){return conditions(page,this.site.authenticated);}
  async expired(page) {
    if(await this.authenticated(page))return false;
    if(this.site.loggedOut?.length&&await conditions(page,this.site.loggedOut))return true;
    const login=this.site.login;if(!login)return false;
    const username=page.locator(login.usernameSelector),password=page.locator(login.passwordSelector);
    return await username.count()===1&&await password.count()===1&&await username.isVisible()&&await password.isVisible();
  }
  async login() {
    const login=this.site.login;
    if(!login)fail('SESSION','会话已过期，请配置本站点登录步骤或使用 login 窗口登录');
    const saved=this.getCredentials();
    const username=saved?.username||process.env[login.usernameEnv],password=saved?.password||process.env[login.passwordEnv];
    if(!username||!password)fail('SESSION','请保存本站点账号密码，或配置登录环境变量');
    const policy=timing(this.site.timing),started=Date.now();
    const remaining=()=>{const absoluteMs=policy.absoluteMs-(Date.now()-started);if(absoluteMs<=0)fail('TIMEOUT','登录达到实测等待上限');return {...policy,absoluteMs};};
    this.lastHealth={at:new Date().toISOString(),status:'reconnecting'};
    this.onEvent({type:'session-login-started',account:this.site.account});
    try {
      await this.page.bringToFront();
      await this.goto(this.page,login.url,'order',remaining());
      await perform(()=>this.page.locator(login.usernameSelector).fill(username,{timeout:remaining().absoluteMs}),remaining(),this.progress);
      await perform(()=>this.page.locator(login.passwordSelector).fill(password,{timeout:remaining().absoluteMs}),remaining(),this.progress);
      const button=this.page.locator(login.submitSelector),request=await formRequest(button,this.site,login.request);
      this.gate.auth=request;this.gate.lastError=null;
      await perform(()=>button.click({timeout:remaining().absoluteMs,noWaitAfter:false}),remaining(),this.progress);
      await until(async()=>{
        if(this.gate.lastError)throw this.gate.lastError;
        if(login.failed?.length&&await conditions(this.page,login.failed))fail('LOGIN_REJECTED','站点拒绝登录，请核对账号密码');
        return this.authenticated(this.page);
      },remaining(),this.progress);
      this.onAuthenticated(username);this.ready();this.onEvent({type:'session-login-succeeded',account:this.site.account});
    } catch(error) {
      const cause=hideCredentials(this.gate.lastError||error,[password,username]);
      const failure=new Fault('SESSION','登录失败：'+cause.message,{cause});
      this.lastHealth={at:new Date().toISOString(),status:'failed',message:failure.message,category:failure.code};
      this.onEvent({type:'session-login-failed',error:errorRecord(failure)});throw failure;
    }finally{this.gate.auth=null;}
  }
  async ensure(force=false) {
    if(this.getCredentials()?.needsLogin){await this.resetAuthentication();await this.login();return;}
    if(!force&&await this.authenticated(this.page))return;
    await this.goto(this.page,this.site.accountUrl);
    if(!await this.authenticated(this.page)){this.onEvent({type:'session-expired',account:this.site.account});await this.login();}
    this.ready();
  }
  async exclusive(fn) {
    if(this.busy)fail('BUSY','该账户浏览器正在执行任务');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  keepAlive(intervalMs=60000) {
    if(!Number.isFinite(intervalMs)||intervalMs<1000)fail('CONFIG','会话保活间隔无效');
    clearInterval(this.timer);
    this.timer=setInterval(()=>{
      if(this.busy)return;
      this.exclusive(()=>this.ensure(true)).then(()=>this.ready(),error=>{
        this.lastHealth={at:new Date().toISOString(),status:'failed',message:error.message,category:error.code};
        this.onEvent({type:'session-check-failed',error:errorRecord(error)});
      });
    },intervalMs);this.timer.unref();
  }
  async close(){clearInterval(this.timer);this.progress?.close();this.monitorProgress?.close();await this.context?.close();}
}
export async function browserExecutable(configured) {
  if(configured)return configured;
  const local=join(process.cwd(),'.data','playwright');
  if(!process.env.PLAYWRIGHT_BROWSERS_PATH)try{await access(local);process.env.PLAYWRIGHT_BROWSERS_PATH=local;}catch{}
  return chromium.executablePath();
}
