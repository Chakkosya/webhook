import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {createFlareSolverrClient} from '../lib/flare-solverr.js';
import {orderFailure} from '../lib/order-diagnostics.js';
import {runCommerceAgent} from '../automation/agent/executor.js';

const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':null);
test('challenge solving preserves trial boundaries, clearance sessions and human fallback',{skip:!executable},async t=>{
  let writes=0,calls=0;
  const secret='test-clearance-not-for-trace',userAgent='RadarSolverTest/1.0';
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','text/html; charset=utf-8');
    if(req.method==='POST')writes++;
    if(!req.headers.cookie?.includes('cf_clearance='+secret)||req.headers['user-agent']!==userAgent)return res.end('<html><title>Just a moment</title><div id="challenge-form">Cloudflare</div></html>');
    res.end('<html><a href="/logout">Log out</a><h1>Product A</h1><p>Echo '+secret+'</p><p id="total">USD 10.00</p><p id="currency">USD</p><form method="post" action="/create"><label>Quantity<input type="number" name="quantity" value="1"></label><button>Place order</button></form></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const launch=options=>chromium.launch({...options,executablePath:executable});
  const task={url,accountId:'test-account',product:'Product A',quantity:1,currency:'USD',maxTotal:20,executionMode:'submit',dryRun:true};
  const solver=createFlareSolverrClient({env:{FLARESOLVERR_ENABLED:'1'},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.cmd==='request.get'){calls++;return {ok:true,json:async()=>({status:'ok',solution:{cookies:[{name:'cf_clearance',value:secret,domain:'127.0.0.1',path:'/',httpOnly:true}],userAgent}})};}
    return {ok:true,json:async()=>({status:'ok'})};
  }});
  try{
    await t.test('disabled keeps the original challenge error and never calls solver',async()=>{
      await assert.rejects(createOrderBrowser(task,{launch,challengeSolver:{enabled:()=>false,solve:()=>{throw new Error('unexpected solver');}}}),error=>error.message==='目标网站正在要求验证，请更换可用出口或稍后重试'&&!error.code);
      assert.equal(calls,0);
    });
    await t.test('enabled clears challenge and completes a full dry-run without writes',async()=>{
      const trace=[],browser=await createOrderBrowser(task,{launch,challengeSolver:solver,onTrace:step=>trace.push(step)});
      let saved;
      try{
        const result=await runCommerceAgent({summary:'Trial',workflow:{version:2,requirements:[]}},task,browser,{plan:async({observation})=>{
          assert.ok(!JSON.stringify(observation).includes(secret));
          const bind=predicate=>{const field=observation.elements.find(predicate);assert.ok(field);return {meaning:'trial field',ref:field.ref,confidence:0.99};};
          return {action:'review',reason:'Review dry-run',bindings:{submit:bind(el=>el.tag==='button'),product:bind(el=>el.tag==='h1'),quantity:bind(el=>el.name==='quantity'),total:bind(el=>el.id==='total'),currency:bind(el=>el.id==='currency')}};
        }});
        assert.equal(result.status,'prepared');assert.equal(browser.submissionStarted,false);assert.equal(browser.paymentStarted,false);assert.equal(writes,0);
        saved=await browser.accountState();
        assert.equal(saved.state.radarUserAgent,userAgent);assert.ok(saved.state.cookies.some(cookie=>cookie.name==='cf_clearance'));
        const event=trace.find(step=>step.action==='FlareSolverr 解验证');assert.equal(event.success,true);assert.equal(event.clearanceObtained,true);assert.ok(event.durationMs>=0);assert.ok(!JSON.stringify(trace).includes(secret));
      }finally{await browser.close();}
      const reused=await createOrderBrowser(task,{launch,challengeSolver:solver,storageState:saved.state});
      try{assert.equal(calls,1);assert.doesNotMatch(await reused.productHtml(),/challenge-form/);}finally{await reused.close();}
    });
    for(const failing of [false,true])await t.test(failing?'service failure requires human input':'unsolved challenge requires human input',async()=>{
      const trace=[];
      await assert.rejects(createOrderBrowser(task,{launch,onTrace:step=>trace.push(step),challengeSolver:{enabled:()=>true,solve:async()=>{if(failing)throw new Error(secret);return {cookies:[],userAgent,clearanceObtained:false};}}}),error=>error.code==='ORDER_CHALLENGE_REQUIRED'&&orderFailure(error).category==='needs_input');
      assert.equal(trace.find(step=>step.action==='FlareSolverr 解验证').success,false);assert.ok(!JSON.stringify(trace).includes(secret));assert.equal(writes,0);
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
