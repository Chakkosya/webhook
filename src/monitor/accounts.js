import {randomUUID} from 'node:crypto';
import {fail} from '../errors.js';
export class MonitorAccounts {
 constructor(store){this.store=store;}
 records(monitorId){return this.store.list('monitor-account').filter(item=>item.monitorId===monitorId);}
 list(monitorId){return this.records(monitorId).map(({password,recipe,...item})=>({...item,learned:!!recipe,hasPassword:!!password}));}
 get(monitorId,id){const record=this.store.get('monitor-account',id);if(record.monitorId!==monitorId)fail('NOT_FOUND','此任务中没有该账户');return record;}
 save(monitor,input){
  const previous=input.id?this.get(monitor.id,input.id):null;
  const loginUrl=new URL(input.loginUrl||previous?.loginUrl||monitor.url);
  if(loginUrl.origin!==new URL(monitor.url).origin||!['https:','http:'].includes(loginUrl.protocol)||loginUrl.username||loginUrl.password)fail('MONITOR_ACCOUNT','登录地址必须与任务网页属于同一站点');
  const username=String(input.username||previous?.username||'').trim(),password=input.password||previous?.password;
  if(!username||typeof password!=='string'||!password)fail('MONITOR_ACCOUNT','请填写商家账号和密码');
  const changed=!previous||username!==previous.username||password!==previous.password||loginUrl.href!==previous.loginUrl;
  this.store.put('monitor-account',{...previous,id:previous?.id||randomUUID(),monitorId:monitor.id,name:String(input.name||username).trim(),username,password,loginUrl:loginUrl.href,selected:input.selected!==false,recipe:changed?null:previous.recipe,health:changed?{status:'unchecked',message:'等待登录验证'}:previous.health});
  return this.list(monitor.id);
 }
 update(monitorId,id,changes){return this.store.put('monitor-account',{...this.get(monitorId,id),...changes});}
 selected(monitorId){return this.records(monitorId).filter(item=>item.selected);}
 delete(monitorId,id){this.get(monitorId,id);this.store.delete('monitor-account',id);}
}
