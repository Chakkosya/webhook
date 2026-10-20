import {ObservationBrowser,monitorUrl} from '../browser/observation.js';
import {evaluateRule,ruleDescription} from './rules.js';
import {fail,errorRecord} from '../errors.js';
export class PageMonitors {
  constructor({store,proxies,dataDir,onEvent=()=>{}}){Object.assign(this,{store,proxies,dataDir,onEvent});this.running=new Map();this.closed=false;}
  list(){return this.store.list('monitor').map(({webhook,...record})=>({...record,hasWebhook:!!webhook,ruleDescription:ruleDescription(record.rule),running:this.running.has(record.id)}));}
  get(id){return this.store.get('monitor',id);}
  add(value) {
    const record=this.store.put('monitor',{...value,url:monitorUrl(value.url),enabled:false,createdAt:new Date().toISOString(),observations:[],notifications:[],notificationCount:0,aiInferenceCalls:0});
    return this.list().find(item=>item.id===record.id);
  }
  update(id,changes){const previous=this.get(id);return this.store.put('monitor',{...previous,...changes});}
  async notify(record,result) {
    const notification={at:new Date().toISOString(),value:result.value,status:'sent'};
    if(record.webhook) {
      try {
        const response=await fetch(record.webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:record.name,text:record.name+'：'+result.value+'\n'+record.url,content:record.name+'：'+result.value+'\n'+record.url,url:record.url,value:result.value}),signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error('Webhook HTTP '+response.status);
        await response.body?.cancel();
      }catch(error){notification.status='failed';notification.error=String(error.message).replaceAll(record.webhook,'[redacted]');}
    }
    record.notificationCount=(record.notificationCount||0)+1;
    record.notifications=[notification,...(record.notifications||[])].slice(0,20);
    this.onEvent({type:'monitor-notification',monitorId:record.id,name:record.name,...notification});
  }
  async check(id) {
    const entry=this.running.get(id);
    if(!entry)fail('MONITOR_STOPPED','请先启动监控');
    if(entry.busy)fail('BUSY','该监控正在检查，请稍后重试');
    entry.busy=true;
    let record=this.get(id),result;
    try {
      await entry.opening;
      if(entry.stopped)return;
      await entry.browser.read(record.url,record.policy);
      result=await evaluateRule(entry.browser.page,record.rule,record.baseline);
      if(result.status==='matched') {
        await entry.browser.read(record.url,record.policy);
        const confirmation=await evaluateRule(entry.browser.page,record.rule,record.baseline);
        if(confirmation.status!=='matched'||record.rule.type==='change'&&result.value!==confirmation.value)result={status:'unknown',reason:'两次检查结果不一致，等待下次检查'};
        else if(!entry.stopped&&(!record.triggered||record.rule.type==='change')) {
          await this.notify(record,confirmation);
          record.triggered=true;
          if(record.rule.type==='change')record.baseline=confirmation.value;
          result={...confirmation,confirmed:true};
        } else result={...confirmation,confirmed:true};
      } else if(result.status==='clear')record.triggered=false;
      record.lastResult={...result,at:new Date().toISOString()};
      record.observations=[record.lastResult,...(record.observations||[])].slice(0,20);
      record.aiInferenceCalls=0;
      this.store.put('monitor',record);
      return record.lastResult;
    }catch(error) {
      result={status:'unknown',reason:error.message,category:errorRecord(error).category,at:new Date().toISOString()};
      if(!entry.stopped)this.update(id,{lastResult:result});
      return result;
    }finally{entry.busy=false;}
  }
  async start(id) {
    if(this.closed)fail('MONITOR_STOPPED','服务正在关闭');
    if(this.running.has(id))return this.list().find(item=>item.id===id);
    const record=this.get(id);
    if(record.verifiedChecks<2)fail('MONITOR_UNVERIFIED','需要完成两次实际页面验证后才能启动');
    const browser=new ObservationBrowser({dataDir:this.dataDir,id,profile:this.proxies.get(record.proxyId)});
    const entry={browser,busy:false,stopped:false};
    this.running.set(id,entry);
    entry.opening=browser.open();
    try{await entry.opening;}catch(error){this.running.delete(id);this.update(id,{enabled:false,lastResult:{status:'unknown',reason:error.message}});throw error;}
    if(entry.stopped){await browser.close();return;}
    this.update(id,{enabled:true});
    const next=async()=>{await this.check(id).catch(()=>{});if(!entry.stopped)entry.timer=setTimeout(next,record.intervalMs);};
    entry.task=next();
    return this.list().find(item=>item.id===id);
  }
  async stop(id) {
    const entry=this.running.get(id);
    if(entry){entry.stopped=true;clearTimeout(entry.timer);await entry.opening.catch(()=>{});await entry.browser.context?.close();while(entry.busy)await new Promise(resolve=>setTimeout(resolve,50));await entry.browser.close();this.running.delete(id);}
    this.update(id,{enabled:false});
  }
  async delete(id){await this.stop(id);this.store.delete('monitor',id);}
  async restore(){for(const record of this.store.list('monitor'))if(record.enabled)void this.start(record.id).catch(error=>this.onEvent({type:'monitor-start-failed',monitorId:record.id,message:error.message}));}
  async close(){this.closed=true;for(const [id,entry] of this.running){const enabled=this.get(id).enabled;await this.stop(id);if(enabled)this.update(id,{enabled:true});}}
}
