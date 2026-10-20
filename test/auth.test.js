import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
test('website accounts verify email, isolate workspaces, persist sessions and revoke logout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'website-auth-')),messages=[];
 let app=await serve({runtime:await new Runtime(dir).open(),port:0,sendMail:async message=>messages.push(message)}),base='http://127.0.0.1:'+app.server.address().port;
 const post=async(path,body,cookie)=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});return {response,value:await response.json()};};
 try{
  assert.equal((await fetch(base+'/api/status')).status,401);
  assert.equal((await fetch(base+'/',{redirect:'manual'})).headers.get('location'),'/signin');
  const owner=await post('auth/setup',{email:'owner@example.test',password:'owner-password'});
  assert.equal(owner.response.status,201);
  const ownerCookie=owner.response.headers.get('set-cookie').split(';')[0];
  assert.match(owner.response.headers.get('set-cookie'),/HttpOnly/);assert.match(owner.response.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await post('auth/setup',{email:'other@example.test',password:'other-password'})).response.status,400);
  await post('mail/save',{provider:'resend',from:'robot@example.test',key:'fixture-mail-key'},ownerCookie);
  assert.equal((await post('auth/register',{email:'member@example.test',password:'member-password',code:'123456'})).response.status,400);
  assert.equal((await post('auth/code',{email:'member@example.test'})).response.status,200);
  const code=messages[0].text.match(/\b\d{6}\b/)[0];
  assert.equal((await post('auth/code',{email:'member@example.test'})).response.status,400);
  assert.equal((await post('auth/register',{email:'member@example.test',password:'member-password',code:'000000'})).response.status,400);
  const member=await post('auth/register',{email:'MEMBER@example.test',password:'member-password',code});
  assert.equal(member.response.status,201);
  const cookie=member.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('auth/register',{email:'member@example.test',password:'member-password',code})).response.status,400);
  assert.equal((await post('auth/signin',{email:'member@example.test',password:'wrong-password'})).response.status,400);
  await post('apis/save',{name:'Owner private API',endpoint:'https://api.example.test/v1',model:'fixture',key:'owner-secret'},ownerCookie);
  const personal=await(await fetch(base+'/api/connections',{headers:{Cookie:cookie}})).json();assert.equal(personal.apis.length,0);
  assert.equal((await post('mail/save',{provider:'resend',key:'evil'},cookie)).response.status,403);
  const bytes=await readFile(join(dir,'runtime.sqlite'));assert.equal(bytes.includes(Buffer.from('owner-password')),false);
  await app.close();app=await serve({runtime:await new Runtime(dir).open(),port:0,sendMail:async message=>messages.push(message)});base='http://127.0.0.1:'+app.server.address().port;
  assert.equal((await fetch(base+'/api/status',{headers:{Cookie:cookie}})).status,200);
  await post('auth/signout',{},cookie);assert.equal((await fetch(base+'/api/status',{headers:{Cookie:cookie}})).status,401);
  const cross=await fetch(base+'/api/auth/signin',{method:'POST',headers:{Origin:'https://elsewhere.example'},body:'{}'});assert.equal(cross.status,400);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('failed delivery never creates an account or an active code',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-failure-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0,sendMail:async()=>{throw new Error('Mailbox rejected');}});
 const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const response=await fetch(base+'/api/auth/setup',{method:'POST',body:JSON.stringify({email:'owner@example.test',password:'owner-password'})});await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  await fetch(base+'/api/mail/save',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({provider:'resend',from:'robot@example.test',key:'fixture'})}).then(r=>r.json());
  const result=await fetch(base+'/api/auth/code',{method:'POST',body:JSON.stringify({email:'member@example.test'})});
  assert.equal(result.status,400);assert.match((await result.json()).error.message,/Mailbox rejected/);
  assert.equal(runtime.workspace.list('email-code').length,0);assert.equal(runtime.kernel.db.prepare('SELECT COUNT(*) AS n FROM app_users').get().n,1);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
