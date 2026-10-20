import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
test('analyzing or checking login prevents changes to the task accounts and active exit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'task-editing-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0}),base='http://127.0.0.1:'+app.server.address().port;
 try{
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',body:JSON.stringify({email:'owner@example.test',password:'owner-password'})});await setup.json();const cookie=setup.headers.get('set-cookie').split(';')[0];
  const proxy=runtime.proxies.save({name:'Exit',url:'http://127.0.0.1:8888'}),monitor=runtime.pageMonitors.add({name:'Task',url:'https://example.test/catalog',proxyId:proxy.id,verifiedChecks:2});
  runtime.pageMonitors.preparing.set(monitor.id,proxy.id);
  for(const [path,body] of [['monitors/accounts/save',{monitorId:monitor.id,username:'one',password:'secret',loginUrl:'https://example.test/login'}],['monitors/start',{id:monitor.id}],['monitors/delete',{id:monitor.id}],['proxies/save',{id:proxy.id,name:'Changed',url:'http://127.0.0.1:9999'}]]){
   const response=await fetch(base+'/api/'+path,{method:'POST',headers:{Cookie:cookie},body:JSON.stringify(body)});
   assert.equal(response.status,400);assert.equal((await response.json()).error.code,'BUSY');
  }
  assert.equal(runtime.monitorAccounts.list(monitor.id).length,0);assert.equal(runtime.proxies.get(proxy.id).name,'Exit');runtime.pageMonitors.preparing.delete(monitor.id);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
