import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Runtime} from './runtime.js';
import {extractWorkflow} from './extractor/index.js';
import {OfflineAssistant} from './ai/index.js';
import {healthcheck} from './healthcheck/index.js';
import {errorRecord,fail} from './errors.js';
const [command,...args]=process.argv.slice(2),flags={};
for(let i=0;i<args.length;i++){if(!args[i].startsWith('--'))fail('CLI','参数必须使用 --name value');flags[args[i].slice(2)]=args[i+1]?.startsWith('--')||!args[i+1]?true:args[++i];}
const json=async file=>JSON.parse(await readFile(resolve(file),'utf8'));
const out=value=>console.log(JSON.stringify(value,null,2));
if(!command||command==='help') {
  console.log('configure --file config.json | import --file workflow.json | trial --id ID --version N | publish --id ID --version N | run --id ID --version N | watch --id ID --version N [--mode trial|live] | rollback --id ID --version N | diff --id ID --a N --b N | extract --file extraction.json | login | check-login | inspect [--url URL] | anchors --id ID --version N | anchor --selector CSS --name NAME | generate --file evidence.json | diagnose --run ID | repair --run ID | healthcheck --file ssh.json | status | resolve --key KEY --outcome not-created|created --note TEXT [--invoice ID]');
} else {
  const runtime=await new Runtime(flags['data-dir']).open();
  let keep=false;
  const stop=async()=>{await runtime.close();process.exit();};
  try {
    const ref={workflowId:flags.id,version:Number(flags.version)};
    if(command==='configure'){await runtime.configure(await json(flags.file));out({saved:true});}
    else if(command==='import')out(runtime.repository.create(await json(flags.file)));
    else if(command==='status')out(runtime.status());
    else if(command==='publish')out(runtime.repository.publish(flags.id,Number(flags.version)));
    else if(command==='rollback')out(runtime.repository.rollback(flags.id,Number(flags.version)));
    else if(command==='diff')out(runtime.repository.diff(flags.id,Number(flags.a),Number(flags.b)));
    else if(command==='trial'||command==='run'){const run=await runtime.execute({...ref,mode:command==='trial'?'trial':'live'});out(run);if(run.status==='failed')process.exitCode=1;}
    else if(command==='watch') {
      await runtime.watch({...ref,mode:flags.mode||'trial',intervalMs:Number(flags.interval||10000)});
      keep=true;process.on('SIGINT',stop);process.on('SIGTERM',stop);
      console.log('浏览器监控已启动。命中后复查一次；同一购买意图只触发一次。');
    } else if(command==='check-login') {out(await runtime.checkSession());
    } else if(command==='login') {
      const session=await runtime.warm({manual:true});
      const reader=createInterface({input:process.stdin,output:process.stdout});
      await reader.question('请在浏览器中完成登录，然后按 Enter 保存会话。');reader.close();
      if(!await session.authenticated(session.page))fail('SESSION','页面尚未出现已学习的登录证据');
      out({saved:true});
    } else if(command==='inspect') {
      await runtime.warm();if(flags.url)await runtime.session.goto(runtime.session.page,flags.url);
      const {inspectPage}=await import('./browser/inspect.js');out(await inspectPage(runtime.session.page));
    } else if(command==='anchors') {
      out(await runtime.captureWorkflow(ref));
    } else if(command==='anchor') {
      await runtime.warm();
      const {VisualAnchors}=await import('./locators/visual.js');
      out(await new VisualAnchors(runtime.session.page,join(runtime.dataDir,'anchors')).capture(flags.selector,flags.name));
    } else if(command==='extract')out(runtime.repository.create(extractWorkflow(await json(flags.file))));
    else if(['generate','diagnose','repair'].includes(command)) {
      const ai=new OfflineAssistant(runtime.config?.ai||{});
      if(command==='generate')out(runtime.repository.create(await ai.generate(await json(flags.file))));
      else {
        const run=runtime.repository.run(flags.run);
        if(command==='diagnose'){const result=await ai.diagnose(run);runtime.repository.saveDiagnosis(run.id,result);out(result);}
        else {const workflow=runtime.repository.get(run.workflowId,run.version).document;const candidate=runtime.repository.create(await ai.repair(workflow,run));runtime.repository.saveDiagnosis(run.id,{category:run.error.category},{id:candidate.id,version:candidate.version});out(candidate);}
      }
    } else if(command==='resolve'){runtime.kernel.resolve(flags.key,{outcome:flags.outcome,note:flags.note,invoiceId:flags.invoice});out({resolved:true});}
    else if(command==='healthcheck')out(await healthcheck(await json(flags.file)));
    else fail('CLI','未知命令 '+command);
  } catch(error){out({error:errorRecord(error)});process.exitCode=1;}
  finally{if(!keep)await runtime.close();}
}
