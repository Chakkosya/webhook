import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const dataDir=await fs.mkdtemp(path.join(tmpdir(),'radar-purchase-draft-'));
const errors=[];let child,browser,order={product:'Widget',quantity:3,currency:'CAD',executionMode:'submit'};
const mock=http.createServer(async(req,res)=>{
  if(req.url==='/product'){res.setHeader('content-type','text/html');return res.end('<h1>Widget</h1><main><p>Sold Out</p></main>');}
  if(req.url==='/hook')return res.end('ok');
  for await(const _ of req){}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({status:'ready',goal:{type:'product_stock',condition:{operator:'transition'}},order})}}]}));
});
try{
  const source='http://127.0.0.1:'+await listen(mock),reserved=http.createServer(),port=await listen(reserved);await new Promise(resolve=>reserved.close(resolve));
  const base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),windowsHide:true,stdio:'ignore',env:{...process.env,DATA_DIR:dataDir,PORT:String(port),HOST:'127.0.0.1',SIGNUP_CODE:'',RESEND_API_KEY:'',MAIL_FROM:''}});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  const executablePath=process.env.UI_BROWSER_EXECUTABLE||process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:1000}});
  assert.equal((await context.request.post(base+'/api/auth/register',{data:{username:'draft-user',password:'draft-password-123'}})).status(),201);
  assert.equal((await context.request.put(base+'/api/settings',{data:{aiKey:'test-key',aiModel:'test',aiBaseUrl:source+'/v1',webhooks:[{id:'hook',name:'通知',url:source+'/hook',enabled:true}]}})).status(),200);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/#create');
  await page.locator('#instruction').fill('监控 Widget 补货后购买3件');await page.locator('#instruction-url').fill(source+'/product');await page.locator('#parse-button').click();
  await page.locator('#draft-order-selected').waitFor();assert.equal(await page.locator('#draft-order-selected').isChecked(),true);
  assert.equal(await page.locator('#draft-order-product').inputValue(),'Widget');assert.equal(await page.locator('#draft-order-max-total').inputValue(),'');
  const rejected=page.waitForResponse(r=>r.url().endsWith('/api/monitors')&&r.request().method()==='POST');await page.locator('#create-button').click();assert.equal((await rejected).status(),400);
  assert.equal((await(await context.request.get(base+'/api/state')).json()).monitors.length,0);
  await page.locator('#draft-order-max-total').fill('65');await page.locator('#draft-order-currency').fill('CAD');
  order={quantity:2};await page.locator('#assistant-reply').fill('数量改成2件，保留其他设置');await page.locator('#assistant-reply-button').click();
  await page.waitForFunction(()=>document.querySelector('#draft-order-quantity')?.value==='2');assert.equal(await page.locator('#draft-order-max-total').inputValue(),'65');
  await page.locator('#draft-order-selected').uncheck();assert.equal(await page.locator('#draft-order-fields').isVisible(),false);await page.locator('#draft-order-selected').check();
  const output=process.env.UI_SMOKE_SCREENSHOT_DIR||path.join(process.cwd(),'release','order-draft-ui');await fs.mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'create-with-purchase.png'),fullPage:true});
  await page.locator('#create-button').click();await page.locator('#order-form').waitFor();
  const state=await(await context.request.get(base+'/api/state')).json();assert.equal(state.monitors.length,1);assert.equal(state.orderTasks.length,1);assert.equal(state.orderTasks[0].monitorId,state.monitors[0].id);assert.equal(state.orderTasks[0].quantity,2);assert.equal(state.orderTasks[0].maxTotal,65);assert.equal(state.orderTasks[0].enabled,false);
  assert.equal(await page.locator('#order-product').inputValue(),'Widget');assert.equal(await page.locator('#order-max-total').inputValue(),'65');
  await page.goto(base+'/#create');order=null;await page.locator('#instruction').fill('仅监控 Widget，不下单');await page.locator('#instruction-url').fill(source+'/product');await page.locator('#parse-button').click();await page.locator('#draft-order-selected').waitFor();assert.equal(await page.locator('#draft-order-selected').isChecked(),false);
  await page.setViewportSize({width:390,height:844});await page.locator('#draft-order-selected').check();await page.screenshot({path:path.join(output,'mobile-purchase-draft.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Purchase editor must fit the mobile viewport');
  await page.locator('#draft-order-selected').uncheck();await page.locator('#create-button').click();await page.waitForURL('**/#monitors');
  const final=await(await context.request.get(base+'/api/state')).json();assert.equal(final.monitors.length,2);assert.equal(final.orderTasks.length,1);assert.deepEqual(errors,[]);
  console.log('PASS: AI purchase draft, missing budget, partial edits, atomic save, immediate account setup, monitoring-only and mobile layout');
}finally{
  await browser?.close();if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await new Promise(resolve=>mock.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});
}
