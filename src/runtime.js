import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {SafetyKernel} from './safety/kernel.js';
import {WorkflowRepository} from './workflow/repository.js';
import {CredentialStore} from './browser/credentials.js';
import {BrowserSession,browserExecutable} from './browser/session.js';
import {createAdapter,validateSite} from './adapters/index.js';
import {Engine} from './engine/index.js';
import {StockMonitor} from './monitor/index.js';
import {VisualAnchors} from './locators/visual.js';
import {fail} from './errors.js';
export class Runtime {
  constructor(dataDir=process.env.DATA_DIR||'.data/workflow'){this.dataDir=resolve(dataDir);this.events=[];}
  async open() {
    await mkdir(this.dataDir,{recursive:true});
    this.kernel=new SafetyKernel(join(this.dataDir,'runtime.sqlite'));this.repository=new WorkflowRepository(this.kernel.db);
    this.credentials=await new CredentialStore(this.kernel.db,this.dataDir).open();
    try{this.config=JSON.parse(await readFile(join(this.dataDir,'config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    return this;
  }
  event(value){this.events.unshift({at:new Date().toISOString(),...value});this.events.length=Math.min(this.events.length,100);}
  async configure(config) {
    validateSite(config.site);
    if(!config.intent?.key||config.intent.account!==config.site.account||config.intent.product!==config.site.product)fail('CONFIG','购买意图与站点账户、商品不一致');
    if(this.monitor||this.session?.busy||this.starting)fail('BUSY','请先停止监控并等待执行结束再更改配置');
    await this.session?.close();this.session=null;this.engine=null;this.lastBrowserHealth=null;
    this.config=config;await writeFile(join(this.dataDir,'config.json'),JSON.stringify(config,null,2));
  }
  credentialStatus(){const site=this.config?.site;return site?this.credentials.status(site.origin,site.account):{saved:false,username:null};}
  accountUsername(){return this.credentialStatus().username||process.env[this.config?.site.login?.usernameEnv]||null;}
  saveCredentials(value) {
    if(!this.config)fail('CONFIG','请先保存站点与账户配置');
    if(this.session?.busy||this.starting)fail('BUSY','浏览器正在操作，请在操作结束后保存账号');
    const site=this.config.site;return this.credentials.save(site.origin,site.account,value);
  }
  deleteCredentials(){
    if(this.session?.busy||this.starting)fail('BUSY','浏览器正在操作，请在操作结束后删除账号');
    if(this.config)this.credentials.delete(this.config.site.origin,this.config.site.account);
    return this.credentialStatus();
  }
  async checkSession(){const session=await this.warm();await session.exclusive(()=>session.ensure(true));return session.lastHealth;}
  async warm(options={}) {
    if(this.starting)return this.starting;
    if(this.session)return this.session;
    this.starting=this.openBrowser(options);
    try{return await this.starting;}finally{this.starting=null;}
  }
  async openBrowser({manual=false}={}) {
    if(!this.config)fail('CONFIG','请先配置真实站点学习资料');
    if(this.session)return this.session;
    const config=this.config;
    const session=new BrowserSession({site:config.site,kernel:this.kernel,dataDir:this.dataDir,headless:manual?false:config.headless!==false,
      getCredentials:()=>{const saved=this.credentials.get(config.site.origin,config.site.account);return saved?{...saved,needsLogin:this.credentials.needsLogin(config.site.origin,config.site.account)}:null;},
      onAuthenticated:username=>this.credentials.loggedIn(config.site.origin,config.site.account,username),onEvent:event=>this.event(event),executablePath:await browserExecutable(process.env.BROWSER_EXECUTABLE)});
    try{await session.open({manual});}catch(error){this.lastBrowserHealth=session.lastHealth||{at:new Date().toISOString(),status:'failed',message:error.message,category:error.code};await session.close();throw error;}
    this.session=session;
    this.engine=new Engine({session,adapter:createAdapter(config.site),kernel:this.kernel,repository:this.repository,dataDir:this.dataDir,visual:new VisualAnchors(session.page,join(this.dataDir,'anchors'))});
    if(!manual)session.keepAlive(config.keepAliveMs||60000);
    return session;
  }
  async execute({workflowId,version,mode='trial',goal=this.config?.goal||'invoice',captureAnchors=false}) {
    await this.warm();
    const result=await this.engine.execute({workflowId,version,mode,goal,intent:this.config.intent,parameters:this.config.parameters||{},accountUsername:this.accountUsername(),captureAnchors});
    this.event({type:'run',id:result.id,status:result.status});
    return result;
  }
  async watch({workflowId,version,mode='trial',goal=this.config?.goal||'invoice',intervalMs=10000}) {
    if(this.monitor)fail('BUSY','监控已经启动');
    await this.warm();
    if(mode==='live')this.repository.admitted(workflowId,version,{intent:this.config.intent,parameters:this.config.parameters||{},goal,site:this.config.site,accountUsername:this.accountUsername()});
    this.monitor=new StockMonitor({session:this.session,adapter:createAdapter(this.config.site),trigger:()=>this.execute({workflowId,version,mode,goal}),onEvent:e=>this.event(e)});
    this.monitor.start(intervalMs);
  }
  stop(){this.monitor?.stop();this.monitor=null;}
  status(){return {configured:!!this.config,credentials:this.credentialStatus(),account:this.config?{origin:this.config.site.origin,name:this.config.site.account}:null,browser:this.session?.lastHealth||this.lastBrowserHealth||null,monitoring:!!this.monitor&&!this.monitor.stopped,workflows:this.repository.list(),runs:this.repository.runs(),metrics:this.repository.metrics(),repairs:this.repository.repairs(),events:this.events};}
  async close(){this.stop();if(this.starting)await this.starting.catch(()=>{});await this.session?.close();this.kernel?.close();}
}
