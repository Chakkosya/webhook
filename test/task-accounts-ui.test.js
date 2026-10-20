import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
import {browserExecutable} from '../src/browser/session.js';
import {loginPage} from './helpers/auth.js';
import {idle} from './helpers/monitor-site.js';
test('a task manages and selects multiple merchant accounts without code or a separate account page',async()=>{
 const logins=[],sessions=new Set();
 const merchant=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  if(req.url==='/v1/chat/completions'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'Private stock',explanation:'按账户分别检查库存。',rule:{type:'stock-count',identity:{selector:'#title',text:'Private server'},scope:'#product',selector:'#stock',pattern:'^(\\d+) Available$'}})}}]}));return;
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/login'&&req.method==='POST'){
   const data=new URLSearchParams(text);if(data.get('password')!=='merchant-secret'){res.end('<p>Rejected</p>');return;}
   const id=data.get('email');sessions.add(id);logins.push(id);res.writeHead(302,{'Set-Cookie':'account='+id+'; Path=/','Location':'/catalog'});res.end();return;
  }
  const account=/account=([^;]+)/.exec(req.headers.cookie||'')?.[1];
  if(req.url==='/login'||!sessions.has(account)){res.end('<form action="/login" method="post"><input type="email" id="email" name="email"><input id="password" type="password" name="password"><button id="signin">Sign In</button></form>');return;}
  res.end('<main id="product"><h1 id="title">Private server</h1><p id="stock">2 Available</p></main><a id="logout" href="/logout">Sign Out</a>');
 });
 await new Promise(resolve=>merchant.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+merchant.address().port,dir=await mkdtemp(join(tmpdir(),'task-accounts-ui-')),runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0}),browser=await chromium.launch({headless:true,executablePath:await browserExecutable()});
 runtime.apis.save({name:'Fixture',endpoint:origin+'/v1',key:'fixture-key',model:'fixture-model'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await loginPage(page,app);
  await page.goto('http://127.0.0.1:'+app.server.address().port+'/#/monitors');await page.locator('#new-monitor').click();
  await page.locator('#monitor-url').fill(origin+'/catalog');await page.locator('#monitor-requirement').fill('有库存时提醒');
  await page.locator('#builder-accounts-tab').click();
  for(const [name,username] of [['主账户','one@example.test'],['备用账户','two@example.test']]){
   await page.locator('#add-task-account').click();await page.locator('#task-account-name').fill(name);await page.locator('#task-account-url').fill(origin+'/login');await page.locator('#task-account-username').fill(username);await page.locator('#task-account-password').fill('merchant-secret');
   const response=page.waitForResponse(response=>response.url().endsWith('/api/monitors/accounts/save'));await page.locator('#save-task-account').click();assert.equal((await response).status(),200);
   await page.locator('#task-account-list').getByText(name,{exact:true}).waitFor();
  }
  assert.equal(await page.locator('#task-account-password').inputValue(),'');
  assert.equal(await page.locator('#task-account-list input:checked').count(),2);
  await page.locator('#analyze-monitor').click();await page.locator('#monitor-preview:visible').waitFor({timeout:30000});
  assert.equal(logins.length,2);
  await page.locator('#confirm-monitor').click();await page.waitForFunction(()=>document.querySelector('#monitor-list').textContent.includes('监控中'));
  const monitor=runtime.pageMonitors.list()[0];await idle(runtime.pageMonitors,monitor.id);
  assert.equal(runtime.pageMonitors.get(monitor.id).lastResult.accounts.length,2);
  await page.locator('#monitor-list').getByRole('button',{name:'管理账户',exact:true}).click();await page.locator('#monitor-builder:visible').waitFor();
  assert.equal(await page.locator('#task-account-list .task-account-row').count(),2);
  const response=page.waitForResponse(response=>response.url().endsWith('/api/monitors/accounts/select'));
  await page.getByRole('checkbox',{name:'使用账户 备用账户'}).uncheck();assert.equal((await response).status(),200);
  assert.equal(runtime.monitorAccounts.selected(monitor.id).length,1);assert.equal(runtime.pageMonitors.get(monitor.id).verifiedChecks,0);
  assert.equal(await page.locator('#monitor-preview').isVisible(),false);
  const output=resolve('release/ui');await mkdir(output,{recursive:true});
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.evaluate(()=>window.scrollTo(0,0));
   if(width!==320)await page.screenshot({path:join(output,'task-accounts-'+width+'.png'),fullPage:true,animations:'disabled'});
  }
 }finally{await browser.close();await app.close();await new Promise(resolve=>merchant.close(resolve));await rm(dir,{recursive:true,force:true});}
});
