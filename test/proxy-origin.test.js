import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';

test('HTTPS reverse proxy requests create an administrator, sign in and save settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'proxy-origin-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0}),base='http://127.0.0.1:'+app.server.address().port;
 const headers={Origin:'https://watch.example.test','X-Forwarded-Proto':'https','X-Forwarded-Host':'watch.example.test'};
 const post=(path,body,cookie,overrides={})=>fetch(base+'/api/'+path,{method:'POST',headers:{...headers,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...overrides},body:JSON.stringify(body)});
 try{
  const setup=await post('auth/setup',{email:'owner@example.test',password:'owner-password'});
  assert.equal(setup.status,201,JSON.stringify(await setup.json()));
  const cookie=setup.headers.get('set-cookie').split(';')[0];assert.match(setup.headers.get('set-cookie'),/; Secure/);
  const saved=await post('apis/save',{name:'API',endpoint:'https://api.example.test/v1',model:'fixture',key:'fixture-key'},cookie);
  assert.equal(saved.status,200,JSON.stringify(await saved.json()));
  const logout=await post('auth/signout',{},cookie);assert.equal(logout.status,200);await logout.json();
  const signin=await post('auth/signin',{email:'owner@example.test',password:'owner-password'},null,{'X-Forwarded-Host':'watch.example.test:443','X-Forwarded-Proto':'https, http'});
  assert.equal(signin.status,200,JSON.stringify(await signin.json()));assert.match(signin.headers.get('set-cookie'),/; Secure/);
  for(const origin of ['https://elsewhere.example','http://watch.example.test','https://watch.example.test:8443','null']){
   const denied=await post('auth/signout',{},cookie,{Origin:origin});assert.equal(denied.status,400);assert.equal((await denied.json()).error.code,'ORIGIN');
  }
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('browser same-origin metadata supports proxies that rewrite Host without forwarding headers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'proxy-browser-origin-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0}),base='http://127.0.0.1:'+app.server.address().port;
 try{
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{Origin:'https://watch.example.test','Sec-Fetch-Site':'same-origin'},body:JSON.stringify({email:'owner@example.test',password:'owner-password'})});
  assert.equal(setup.status,201,JSON.stringify(await setup.json()));assert.match(setup.headers.get('set-cookie'),/; Secure/);
  const cookie=setup.headers.get('set-cookie').split(';')[0];
  for(const site of ['cross-site','same-site']){
   const denied=await fetch(base+'/api/auth/signout',{method:'POST',headers:{Cookie:cookie,Origin:base,'Sec-Fetch-Site':site},body:'{}'});
   assert.equal(denied.status,400);assert.equal((await denied.json()).error.code,'ORIGIN');
  }
  const denied=await fetch(base+'/api/auth/signout',{method:'POST',headers:{Cookie:cookie,Origin:'null','Sec-Fetch-Site':'same-origin'},body:'{}'});
  assert.equal(denied.status,400);assert.equal((await denied.json()).error.code,'ORIGIN');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
