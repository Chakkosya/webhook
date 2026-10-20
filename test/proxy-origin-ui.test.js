import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {request} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
import {browserExecutable} from '../src/browser/session.js';

for(const forwarded of [true,false])test('HTTPS browser creates and signs in as administrator through '+(forwarded?'forwarding':'Host-rewriting')+' proxy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'https-proxy-ui-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0});
 const backend='127.0.0.1:'+app.server.address().port,seen=[];
 const proxy=createServer({key:await readFile(new URL('./fixtures/https/localhost-key.pem',import.meta.url)),cert:await readFile(new URL('./fixtures/https/localhost-cert.pem',import.meta.url))},(req,res)=>{
  const headers={...req.headers,host:backend};
  if(forwarded){headers['x-forwarded-proto']='https';headers['x-forwarded-host']=req.headers.host;delete headers['sec-fetch-site'];}
  if(req.method==='POST')seen.push({origin:req.headers.origin,site:req.headers['sec-fetch-site']});
  const upstream=request({hostname:'127.0.0.1',port:app.server.address().port,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',error=>{res.writeHead(502);res.end(error.message);});req.pipe(upstream);
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,executablePath:await browserExecutable()}),context=await browser.newContext({ignoreHTTPSErrors:true}),base='https://127.0.0.1:'+proxy.address().port;
 try{
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/signup');await page.locator('#auth-submit').filter({hasText:'创建管理员'}).waitFor();
  await page.locator('#auth-email').fill('owner@example.test');await page.locator('#auth-password').fill('owner-password');
  const response=page.waitForResponse(response=>response.url().endsWith('/api/auth/setup'));
  await page.locator('#auth-submit').click();assert.equal((await response).status(),201);
  await page.waitForURL(base+'/');await page.locator('#user-email').filter({hasText:'owner@example.test'}).waitFor();
  const cookies=await context.cookies();assert.equal(cookies.find(cookie=>cookie.name==='workflow_session').secure,true);
  await page.locator('#user-email').click();await page.locator('#mail-from').fill('robot@example.test');await page.locator('#mail-key').fill('fixture-key');await page.locator('#save-mail').click();
  await page.locator('#mail-feedback').filter({hasText:'已保存'}).waitFor();
  await page.locator('#signout').click();await page.waitForURL('**/signin');
  await page.locator('#auth-email').fill('owner@example.test');await page.locator('#auth-password').fill('owner-password');await page.locator('#auth-submit').click();
  await page.waitForURL(base+'/');await page.waitForFunction(()=>document.querySelector('#connection').textContent==='本机已连接');
  assert.ok(seen.length>=4);assert.ok(seen.every(item=>item.origin===base&&item.site==='same-origin'));assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(resolve=>proxy.close(resolve));await app.close();await rm(dir,{recursive:true,force:true});}
});
