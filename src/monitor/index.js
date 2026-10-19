import {errorRecord,fail} from '../errors.js';
export class StockMonitor {
  constructor({session,adapter,trigger,onEvent=()=>{}}) {this.session=session;this.adapter=adapter;this.trigger=trigger;this.onEvent=onEvent;this.timer=null;this.busy=false;this.fired=false;this.stopped=false;}
  async check() {
    await this.session.goto(this.session.monitorPage,this.session.site.monitorUrl,'monitor');
    if(await this.session.expired(this.session.monitorPage)){await this.session.ensure(true);await this.session.goto(this.session.monitorPage,this.session.site.monitorUrl,'monitor');}
    return this.adapter.stock(this.session.monitorPage);
  }
  async tick() {
    if(this.busy||this.session.busy||this.fired||this.stopped)return;
    this.busy=true;
    try {
      await this.session.exclusive(async()=>{
        const first=await this.check();this.onEvent({type:'stock',result:first});
        if(first.status!=='in')return;
        const second=await this.check();this.onEvent({type:'stock-confirmation',result:second});
        if(second.status!=='in')return;
        this.fired=true;
      });
      if(this.fired&&!this.stopped) {
        this.stop();this.onEvent({type:'trigger'});
        await this.trigger();
      }
    } catch(error) {this.onEvent({type:'error',error:errorRecord(error)});}
    finally{this.busy=false;}
  }
  start(intervalMs=10000) {
    if(!Number.isFinite(intervalMs)||intervalMs<100)fail('CONFIG','监控间隔无效');
    this.stopped=false;
    const next=async()=>{await this.tick();if(!this.stopped)this.timer=setTimeout(next,intervalMs);};
    void next();
  }
  stop(){this.stopped=true;clearTimeout(this.timer);}
}
