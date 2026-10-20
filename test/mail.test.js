import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {WebsiteAuth} from '../src/auth/index.js';
test('SMTP registration delivers a real protocol message and codes expire or stop after five failed attempts',async()=>{
 let message='',clock=Date.now();
 const server=createServer(socket=>{
  socket.write('220 localhost ESMTP\r\n');let buffer='',data=false,body='';
  socket.on('data',chunk=>{
   buffer+=chunk.toString();
   while(buffer.includes('\r\n')){
    const index=buffer.indexOf('\r\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+2);
    if(data){if(line==='.'){message=body;body='';data=false;socket.write('250 queued\r\n');}else body+=line+'\r\n';continue;}
    if(/^(?:EHLO|HELO)/.test(line))socket.write('250-localhost\r\n250 OK\r\n');
    else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}
    else if(line==='QUIT')socket.end('221 Bye\r\n');
    else socket.write('250 OK\r\n');
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(join(tmpdir(),'smtp-auth-')),runtime=await new Runtime(dir).open(),auth=new WebsiteAuth(runtime,{now:()=>clock});
 try{
  auth.saveMail({provider:'smtp',host:'127.0.0.1',port:server.address().port,from:'robot@example.test'});
  await auth.code({email:'member@example.test'});
  assert.match(message,/To: member@example.test/);
  const code=runtime.workspace.get('email-code','member@example.test').code;
  const payload=message.slice(message.indexOf('\r\n\r\n')+4);
  const decoded=/Content-Transfer-Encoding: base64/i.test(message)?Buffer.from(payload,'base64').toString('utf8'):payload.replace(/=\r\n/g,'');
  assert.ok(decoded.includes(code));
  clock+=600001;
  await assert.rejects(()=>auth.create({email:'member@example.test',password:'member-password',code}),{code:'AUTH_CODE'});
  await auth.code({email:'member@example.test'});const next=runtime.workspace.get('email-code','member@example.test').code;
  for(let i=0;i<5;i++)await assert.rejects(()=>auth.create({email:'member@example.test',password:'member-password',code:'000000'}),{code:'AUTH_CODE'});
  await assert.rejects(()=>auth.create({email:'member@example.test',password:'member-password',code:next}),{code:'AUTH_CODE'});
  assert.equal(auth.users().length,0);
 }finally{await runtime.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
