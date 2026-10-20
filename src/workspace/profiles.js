import {fail} from '../errors.js';
function endpoint(value) {
  let url;
  try{url=new URL(String(value||'').trim());}catch{fail('AI_CONFIG','请填写有效的 API 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('AI_CONFIG','API 地址需使用 HTTP 或 HTTPS，不包含密钥和查询参数');
  const path=url.pathname.replace(/\/+$/,'');
  url.pathname=path.endsWith('/chat/completions')?path:path+'/chat/completions';
  return url.href;
}
const publicProfile=({id,name,endpoint,model,key})=>({id,name,endpoint,model,hasKey:!!key});
export class ApiProfiles {
  constructor(store){this.store=store;}
  list(){const active=this.store.preference('default-api');return this.store.list('api').map(value=>({...publicProfile(value),isDefault:value.id===active}));}
  save(input) {
    const previous=input.id?this.store.get('api',input.id):{};
    const value={id:previous.id,name:String(input.name||'').trim(),endpoint:endpoint(input.endpoint),model:String(input.model||'').trim(),key:String(input.key||previous.key||'').trim()};
    if(!value.name||!value.model||!value.key)fail('AI_CONFIG','请填写名称、模型名称和 API Key');
    const saved=this.store.put('api',value);
    if(!this.store.preference('default-api'))this.store.preference('default-api',saved.id);
    return publicProfile(saved);
  }
  setDefault(id){this.store.get('api',id);this.store.preference('default-api',id);}
  resolve(id) {
    const records=this.store.list('api'),selected=id||this.store.preference('default-api');
    const value=records.find(record=>record.id===selected)||(!id?records[0]:null);
    if(value)return value;
    if(!id&&process.env.AI_ENDPOINT&&process.env.AI_MODEL&&process.env.AI_API_KEY)return {endpoint:endpoint(process.env.AI_ENDPOINT),model:process.env.AI_MODEL,key:process.env.AI_API_KEY};
    fail('AI_CONFIG','先在「API 与出口」中添加一个 AI API');
  }
  delete(id){this.store.get('api',id);this.store.delete('api',id);if(this.store.preference('default-api')===id)this.store.preference('default-api',this.store.list('api')[0]?.id||'');}
}
