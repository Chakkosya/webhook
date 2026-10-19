import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Runtime} from './runtime.js';
import {OfflineAssistant} from './ai/index.js';
import {errorRecord,fail} from './errors.js';
export async function serve({runtime,port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1'}={}) {
  runtime??=await new Runtime().open();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    try {
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)) {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1),types={'index.html':'text/html','app.js':'text/javascript','style.css':'text/css'};
        return send(200,await readFile(fileURLToPath(new URL('../public/'+file,import.meta.url)),'utf8'),types[file]+'; charset=utf-8');
      }
      if(req.method==='GET'&&url.pathname==='/api/health')return send(200,{status:'ok'});
      if(req.method==='GET'&&url.pathname==='/api/status')return send(200,runtime.status());
      if(req.method==='GET'&&url.pathname==='/api/credentials')return send(200,runtime.credentialStatus());
      if(req.method==='GET'&&url.pathname==='/api/config')return send(200,runtime.config||null);
      if(req.method==='GET'&&url.pathname==='/api/workflow')return send(200,runtime.repository.get(url.searchParams.get('id'),url.searchParams.get('version')));
      if(req.method==='GET'&&url.pathname==='/api/diff')return send(200,runtime.repository.diff(url.searchParams.get('id'),url.searchParams.get('a'),url.searchParams.get('b')));
      if(req.method!=='POST')return send(404,{error:'接口不存在'});
      if(req.headers.origin&&req.headers.origin!==new URL(req.url,'http://'+req.headers.host).origin)fail('ORIGIN','仅接受工作台自身发起的操作');
      let text='';for await(const chunk of req){text+=chunk;if(text.length>2_000_000)fail('INPUT','请求内容过大');}
      const body=JSON.parse(text||'{}');
      if(['/api/diagnose','/api/repair'].includes(url.pathname)) {
        const run=runtime.repository.run(body.runId),ai=new OfflineAssistant(runtime.config?.ai||{});
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
