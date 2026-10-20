import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Runtime} from './runtime.js';
import {OfflineAssistant} from './ai/index.js';
import {ApiAssistant} from './ai/client.js';
import {buildMonitor} from './ai/monitor-builder.js';
import {ObservationBrowser,monitorUrl} from './browser/observation.js';
import {randomUUID} from 'node:crypto';
import {errorRecord,fail} from './errors.js';
export async function serve({runtime,port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1'}={}) {
  runtime??=await new Runtime().open();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    try {
      if(req.method==='GET'&&['/','/app.js','/workspace.js','/style.css'].includes(url.pathname)) {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1),types={'index.html':'text/html','app.js':'text/javascript','workspace.js':'text/javascript','style.css':'text/css'};
        return send(200,await readFile(fileURLToPath(new URL('../public/'+file,import.meta.url)),'utf8'),types[file]+'; charset=utf-8');
      }
      if(req.method==='GET'&&url.pathname==='/api/health')return send(200,{status:'ok'});
      if(req.method==='GET'&&url.pathname==='/api/status')return send(200,runtime.status());
      if(req.method==='GET'&&url.pathname==='/api/credentials')return send(200,runtime.credentialStatus());
      if(req.method==='GET'&&url.pathname==='/api/config')return send(200,runtime.config||null);
      if(req.method==='GET'&&url.pathname==='/api/workflow')return send(200,runtime.repository.get(url.searchParams.get('id'),url.searchParams.get('version')));
      if(req.method==='GET'&&url.pathname==='/api/diff')return send(200,runtime.repository.diff(url.searchParams.get('id'),url.searchParams.get('a'),url.searchParams.get('b')));
      if(req.method==='GET'&&url.pathname==='/api/connections')return send(200,{apis:runtime.apis.list(),proxies:runtime.proxies.list()});
      if(req.method==='GET'&&url.pathname==='/api/monitors')return send(200,runtime.pageMonitors.list());
      if(req.method!=='POST')return send(404,{error:'接口不存在'});
      if(req.headers.origin&&req.headers.origin!==new URL(req.url,'http://'+req.headers.host).origin)fail('ORIGIN','仅接受工作台自身发起的操作');
      let text='';for await(const chunk of req){text+=chunk;if(text.length>2_000_000)fail('INPUT','请求内容过大');}
      const body=JSON.parse(text||'{}');
      if(url.pathname==='/api/apis/save')return send(200,runtime.apis.save(body));
      if(url.pathname==='/api/apis/default'){runtime.apis.setDefault(body.id);return send(200,{saved:true});}
      if(url.pathname==='/api/apis/delete'){runtime.apis.delete(body.id);return send(200,{deleted:true});}
      if(url.pathname==='/api/apis/test')return send(200,await new ApiAssistant(runtime.apis.resolve(body.id)).test());
      if(url.pathname==='/api/proxies/save'){
        const selected=body.id&&(runtime.config?.proxyId===body.id||runtime.config?.site.proxyId===body.id);
        if(body.id&&runtime.pageMonitors.list().some(item=>item.running&&item.proxyId===body.id))fail('BUSY','请先暂停使用此出口的监控，再修改节点');
        if(selected&&(runtime.session?.busy||runtime.starting||runtime.monitor))fail('BUSY','请先停止站点监控并等待执行结束，再修改出口');
        const saved=runtime.proxies.save(body);
        if(selected&&runtime.session)await runtime.configure(runtime.config);
        return send(200,saved);
      }
      if(url.pathname==='/api/proxies/delete'){
        if(runtime.config?.proxyId===body.id||runtime.config?.site.proxyId===body.id||runtime.pageMonitors.list().some(item=>item.proxyId===body.id))fail('PROXY_IN_USE','出口正在被站点或监控使用，请先切换出口或删除对应监控');
        runtime.proxies.delete(body.id);return send(200,{deleted:true});
      }
      if(url.pathname==='/api/proxies/test'){
        const browser=new ObservationBrowser({dataDir:runtime.dataDir,id:'proxy-test-'+randomUUID(),profile:runtime.proxies.get(body.id)});
        try{
          await browser.open();const elapsedMs=await browser.read(monitorUrl(body.url||'https://api.ipify.org/?format=json'));
          const value=await browser.page.locator('body').innerText();
          let ip;try{ip=JSON.parse(value).ip;}catch{}
          return send(200,{ok:true,elapsedMs,ip:ip||null,title:await browser.page.title()});
        }finally{await browser.close();}
      }
      if(url.pathname==='/api/session/proxy'){
        if(!runtime.config)fail('CONFIG','请先保存站点配置');
        if(body.id)runtime.proxies.get(body.id);
        await runtime.configure({...runtime.config,proxyId:body.id||null,site:{...runtime.config.site,proxyId:null,proxy:undefined}});
        return send(200,{saved:true});
      }
      if(url.pathname==='/api/monitors/analyze')return send(201,await buildMonitor(runtime,body,new ApiAssistant(runtime.apis.resolve(body.apiId))));
      if(url.pathname==='/api/monitors/start')return send(200,await runtime.pageMonitors.start(body.id));
      if(url.pathname==='/api/monitors/stop'){await runtime.pageMonitors.stop(body.id);return send(200,{stopped:true});}
      if(url.pathname==='/api/monitors/check')return send(200,await runtime.pageMonitors.check(body.id));
      if(url.pathname==='/api/monitors/delete'){await runtime.pageMonitors.delete(body.id);return send(200,{deleted:true});}
      if(['/api/diagnose','/api/repair'].includes(url.pathname)) {
        const run=runtime.repository.run(body.runId),ai=runtime.config?.ai?.command?new OfflineAssistant(runtime.config.ai):new ApiAssistant(runtime.apis.resolve(body.apiId));
        if(url.pathname==='/api/diagnose'){const report=await ai.diagnose(run);runtime.repository.saveDiagnosis(run.id,report);return send(200,report);}
        const workflow=runtime.repository.get(run.workflowId,run.version).document;
        const candidate=runtime.repository.create(await ai.repair(workflow,run));
        runtime.repository.saveDiagnosis(run.id,{category:run.error.category},{id:candidate.id,version:candidate.version});
        return send(201,candidate);
      }
      if(url.pathname==='/api/credentials')return send(200,runtime.saveCredentials(body));
      if(url.pathname==='/api/credentials/delete')return send(200,runtime.deleteCredentials());
      if(url.pathname==='/api/session/check')return send(200,await runtime.checkSession());
      if(url.pathname==='/api/config'){await runtime.configure(body);return send(200,{saved:true});}
      if(url.pathname==='/api/workflows')return send(201,runtime.repository.create(body));
      if(url.pathname==='/api/publish')return send(200,runtime.repository.publish(body.id,body.version));
      if(url.pathname==='/api/rollback')return send(200,runtime.repository.rollback(body.id,body.version));
      if(url.pathname==='/api/warm'){await runtime.warm();return send(200,{ready:true});}
      if(url.pathname==='/api/run')return send(200,await runtime.execute(body));
      if(url.pathname==='/api/monitor/start'){await runtime.watch(body);return send(200,{started:true});}
      if(url.pathname==='/api/monitor/stop'){runtime.stop();return send(200,{stopped:true});}
      if(url.pathname==='/api/resolve'){runtime.kernel.resolve(body.key,body);return send(200,{resolved:true});}
      return send(404,{error:'接口不存在'});
    }catch(error){send(400,{error:errorRecord(error)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,runtime,close:async()=>{await new Promise(r=>server.close(r));await runtime.close();}};
}
