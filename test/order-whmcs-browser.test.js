import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {createOrderService,validateOrderTask} from '../lib/orders.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);

test('WHMCS configuration quotes, AJAX continuation, coupons and checkout',{skip:!executable},async t=>{
  let scenario,base;const requests=[],orders=[];
  const checkout=discounted=>'<a href="/logout">Log out</a><h1 id="product">Dedicated Server - DS.CN.HK.BGP</h1><p id="quantity">1</p><p id="total">CAD '+(discounted?135:150)+'</p><p id="currency">CAD</p><form method="post" action="/cart.php?a=complete"><input name="quantity" type="hidden" value="1"><input name="discounted" type="hidden" value="'+Number(discounted)+'"><button id="submit">Complete order</button></form><form method="post" action="/cart.php?a=view"><input id="coupon" name="promocode"><button id="apply">Apply coupon</button></form><p id="applied">'+(discounted?'10%OFF':'None')+'</p><p id="discount">CAD '+(discounted?15:0)+'</p>';
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=new URLSearchParams(raw),url=new URL(req.url,'http://localhost');
    requests.push({method:req.method,path:url.pathname,action:body.get('a')||url.searchParams.get('a'),quote:body.get('calctotal'),recommendations:body.get('addproductajax')});res.setHeader('content-type','text/html; charset=utf-8');
    if(url.pathname==='/store')return res.end('<title>Shopping Cart - VMISS</title><a href="/logout">Log out</a><article><h2>DS.CN.HK.BGP</h2><p>CAD 150 Monthly · 1 Available</p><a href="/store/dedicated-server/cn-hk-bgp">Order Now</a></article>');
    if(url.pathname==='/store/dedicated-server/cn-hk-bgp'){res.writeHead(302,{location:'/cart.php?a=confproduct&i=0'});return res.end();}
    if(req.method==='GET'&&url.searchParams.get('a')==='confproduct')return res.end(`<a href="/logout">Log out</a><main><form id="frmConfigureProduct"><h1>Dedicated Server - DS.CN.HK.BGP</h1><input name="configure" type="hidden" value="true"><input name="i" type="hidden" value="0"><input name="token" type="hidden" value="private-csrf"><label>Billing cycle<select name="billingcycle"><option value="monthly">Monthly</option><option value="annually">Annually</option></select></label><label>Memory<select name="configoption[40]"><option value="64">64G</option></select></label><label>Root password<input name="rootpw" type="password" value=""></label><div id="producttotal">Calculating</div><button id="continue">Continue</button></form></main><script>
      const form=document.getElementById('frmConfigureProduct');
      const send=async prefix=>{const response=await fetch('/cart.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:prefix+'&'+new URLSearchParams(new FormData(form))});return response.text();};
      const quote=async()=>{document.getElementById('producttotal').innerHTML=await send('ajax=1&a=confproduct&calctotal=true');};
      form.elements.billingcycle.onchange=async()=>{await fetch('/cart.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'a=cyclechange&ajax=1&i=0&billingcycle='+form.elements.billingcycle.value}).then(response=>response.text());await quote();};
      form.onsubmit=async event=>{event.preventDefault();await send('addproductajax=1&a=confproduct');const error=await send('ajax=1&a=confproduct');if(!error)location.href='/cart.php?a=view';};
      quote();navigator.sendBeacon('/cdn-cgi/rum','page-load');
    </script>`);
    if(req.method==='POST'&&body.get('a')==='confproduct'){
      if(body.get('calctotal')==='true'){if(scenario.quoteStatus)res.statusCode=scenario.quoteStatus;setTimeout(()=>res.end('<span>CAD '+(body.get('billingcycle')==='annually'?1500:150)+'</span>'),scenario.quoteDelay||0);return;}
      if(body.get('addproductajax')==='1')return res.end('{}');
      setTimeout(()=>res.end(''),scenario.configurationDelay||0);return;
    }
    if(req.method==='POST'&&body.get('a')==='cyclechange')return res.end('');
    if(url.searchParams.get('a')==='view')return res.end(checkout(req.method==='POST'));
    if(url.searchParams.get('a')==='complete'){orders.push({quantity:Number(body.get('quantity')),total:body.get('discounted')==='1'?135:150});return res.end('<h1>Order Confirmation</h1><p>Order Number: whmcs-'+orders.length+'</p>');}
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  const requestAI=async(_user,messages)=>{
    const input=JSON.parse(messages.at(-1).content);if(!input.page)return {summary:'Use the default product configuration',workflow:{version:2,requirements:[]}};
    const page=input.page,action=new URL(page.url).searchParams.get('a');
    const bind=(meaning,predicate)=>{const el=page.elements.filter(predicate);assert.equal(el.length,1,meaning);return {meaning,ref:el[0].ref,confidence:0.99};};
    if(action==='confproduct')return {action:'configure',reason:'Keep the current product defaults and continue',target:bind('Continue',el=>el.id==='continue'),bindings:{product:bind('Product',el=>el.tag==='h1')}};
    const bindings={submit:bind('Submit',el=>el.id==='submit'),product:bind('Product',el=>el.id==='product'),quantity:bind('Quantity',el=>el.id==='quantity'),total:bind('Total',el=>el.id==='total'),currency:bind('Currency',el=>el.id==='currency'),input:bind('Coupon',el=>el.id==='coupon'),apply:bind('Apply',el=>el.id==='apply'),appliedCode:bind('Applied coupon',el=>el.id==='applied'),discount:bind('Discount',el=>el.id==='discount')};
    return {action:input.context.pendingVerification==='coupon'?'verify_coupon':input.context.couponApplied?'review':'apply_coupon',reason:'Check the current product and discounted amount',bindings};
  };
  try{
    for(const dryRun of [true,false])await t.test(dryRun?'optional trial reaches checkout without creating an order':'restock submits once without a previous trial',async()=>{
      scenario={dryRun,quoteDelay:120,configurationDelay:750};const start=requests.length,before=orders.length;
      const task=validateOrderTask({url:base+'/store',product:'DS.CN.HK.BGP',quantity:1,maxTotal:160,currency:'CAD',couponCode:'10%OFF',executionMode:'submit',monitorId:'monitor'});
      const user={id:'whmcs-test',monitors:[{id:'monitor',kind:'webpage',enabled:true}],orderTasks:[task],orderAccounts:[{monitorId:'monitor',loginUrl:task.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:task.url}}}]};
      const service=createOrderService({persist:()=>{},requestAI,siteMemory:{read:async()=>null,record:async()=>{}},openBrowser:(task,options)=>createOrderBrowser(task,{...options,launch:options=>chromium.launch({...options,executablePath:executable})})});
      if(dryRun){await service.generate(user,task);assert.equal(task.status,'ready');assert.equal(task.trial.review.total,135);}
      else{service.approve(user,task);await service.trigger(user,user.monitors[0]);assert.equal(task.status,'ordered',task.error);assert.equal(task.result.review.total,135);}
      assert.equal(orders.length-before,dryRun?0:1);
      const current=requests.slice(start);assert.ok(current.some(request=>request.quote==='true'));assert.ok(!current.some(request=>request.path==='/cdn-cgi/rum'));assert.equal(current.filter(request=>request.recommendations==='1').length,1);assert.equal(current.filter(request=>request.method==='POST'&&request.action==='confproduct'&&!request.quote&&!request.recommendations).length,1);
    });
    await t.test('changing billing cycle waits for the current quote without consuming an order permit',async()=>{
      scenario={quoteDelay:200};const start=requests.length;
      const browser=await createOrderBrowser({url:base+'/store',product:'DS.CN.HK.BGP',quantity:1,maxTotal:160,currency:'CAD',executionMode:'submit',dryRun:true},{launch:options=>chromium.launch({...options,executablePath:executable})});
      try{
        await browser.methods.click('a[href="/store/dedicated-server/cn-hk-bgp"]');
        assert.match(await browser.methods.text('#producttotal'),/150/);
        await browser.methods.select('[name=billingcycle]','annually');
        assert.match(await browser.methods.text('#producttotal'),/1500/);
        await browser.methods.select('[name=billingcycle]','monthly');
        assert.equal(await browser.methods.text('#producttotal'),'CAD 150');
        await browser.methods.cart('#continue',{configuration:true});
        assert.equal(await browser.methods.matchesProduct('DS.CN.HK.BGP','Dedicated Server - DS.CN.HK.BGP'),true);
        assert.equal(await browser.methods.matchesProduct('DS.CN.HK.BGP','Dedicated Server - DS.CN.HK.BGP V2'),false);
        assert.equal(await browser.methods.matchesProduct('Another product','Dedicated Server - DS.CN.HK.BGP'),false);
        assert.equal(requests.slice(start).filter(request=>request.action==='cyclechange').length,2);
        assert.ok(!requests.slice(start).some(request=>request.action==='complete'));
        assert.ok(!JSON.stringify(browser.trace).includes('private-csrf'));
      }finally{await browser.close();}
    });
    await t.test('failed repricing stops before configuration and order submission',async()=>{
      scenario={quoteStatus:500};const start=requests.length;
      const browser=await createOrderBrowser({url:base+'/store',product:'DS.CN.HK.BGP',quantity:1,maxTotal:160,currency:'CAD',executionMode:'submit',dryRun:true},{launch:options=>chromium.launch({...options,executablePath:executable})});
      try{
        await assert.rejects(browser.methods.click('a[href="/store/dedicated-server/cn-hk-bgp"]'),error=>error.code==='ORDER_PRICING_FAILED');
        assert.ok(!requests.slice(start).some(request=>request.action==='complete'||request.action==='confproduct'&&!request.quote&&request.method==='POST'));
      }finally{await browser.close();}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
