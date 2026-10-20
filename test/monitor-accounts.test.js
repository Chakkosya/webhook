import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {idle} from './helpers/monitor-site.js';
test('task accounts have isolated sessions, relogin independently and never permit commerce',async()=>{
 const state={sessions:new Map(),logins:[],writes:0};
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');
  let body='';for await(const chunk of req)body+=chunk;
  if(req.method==='POST'&&req.url==='/login'){
   const data=new URLSearchParams(body),name=data.get('email');
   if(data.get('password')!=='merchant-secret'){res.end('<p>Rejected</p>');return;}
   const token=name+'-'+state.logins.length;state.sessions.set(token,name);state.logins.push(name);
   res.writeHead(302,{'Set-Cookie':'session='+token+'; Path=/','Location':'/catalog'});res.end();return;
  }
  if(req.method==='POST'){state.writes++;res.end('Unexpected');return;}
  const token=/session=([^;]+)/.exec(req.headers.cookie||'')?.[1],name=state.sessions.get(token);
  if(req.url==='/login'||!name){res.end('<form method="post" action="/login"><input id="email" name="email" type="email"><input id="password" name="password" type="password"><button id="signin" type="submit">Sign In</button></form>');return;}
  res.end('<main id="product"><h1 id="title">Server</h1><p id="stock">'+(name==='one@example.test'?'0':'2')+' Available</p></main><a id="logout" href="/logout">Sign Out</a><script>fetch("/buy",{method:"POST"}).catch(()=>{});</script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port,dir=await mkdtemp(join(tmpdir(),'task-accounts-')),runtime=await new Runtime(dir).open();
 try{
  const monitor=runtime.pageMonitors.add({name:'Private stock',url:origin+'/catalog',kind:'stock',intervalMs:600000,verifiedChecks:2,baseline:'0 Available',rule:{type:'stock-count',identity:{selector:'#title',text:'Server'},scope:'#product',selector:'#stock',pattern:'^(\\d+) Available$'}});
  runtime.monitorAccounts.save(monitor,{username:'one@example.test',password:'merchant-secret',loginUrl:origin+'/login'});
  runtime.monitorAccounts.save(monitor,{username:'two@example.test',password:'merchant-secret',loginUrl:origin+'/login'});
  assert.equal(JSON.stringify(runtime.monitorAccounts.list(monitor.id)).includes('merchant-secret'),false);
  assert.equal((await readFile(join(dir,'runtime.sqlite'))).includes(Buffer.from('merchant-secret')),false);
  await runtime.pageMonitors.start(monitor.id);await idle(runtime.pageMonitors,monitor.id);
  let result=runtime.pageMonitors.get(monitor.id).lastResult;
  assert.equal(result.status,'matched',JSON.stringify(result));assert.equal(result.accounts.length,2);
  assert.deepEqual(result.accounts.map(item=>item.status),['clear','matched']);
  assert.deepEqual(state.logins.sort(),['one@example.test','two@example.test']);assert.equal(state.writes,0);
  state.sessions.clear();
  await runtime.pageMonitors.check(monitor.id);
  assert.equal(state.logins.length,4);assert.equal(state.writes,0);
  const other=runtime.pageMonitors.add({name:'Other',url:origin+'/catalog'});
  assert.throws(()=>runtime.monitorAccounts.get(other.id,runtime.monitorAccounts.list(monitor.id)[0].id),{code:'NOT_FOUND'});
  await runtime.pageMonitors.delete(monitor.id);assert.equal(runtime.monitorAccounts.list(monitor.id).length,0);
 }finally{await runtime.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
