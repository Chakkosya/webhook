import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser,parseOrderTotal} from '../lib/order-browser.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);

test('ambiguous amounts expose a stable guard code',()=>{
  for(const value of ['USD 10 and 20','1,23,456','-10'])assert.throws(()=>parseOrderTotal(value),{code:'ORDER_TOTAL_UNVERIFIED'});
});

test('local merchant form guards and request permits',{skip:!executable},async t=>{
  const received=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','text/html; charset=utf-8');
    if(url.pathname!=='/product'){received.push({path:url.pathname,query:url.search,method:req.method,body});return res.end('<h1>Cart updated</h1>');}
    const mode=url.searchParams.get('mode')||'native';
    const danger=mode==='password'?'<input name="password" type="password">':mode==='payment'?'<input name="paymentmethod" type="hidden" value="paypal">':'';
    const fields=mode==='empty'?'':'<label>Quantity<input type="number" name="quantity" value="1"></label><label>Cycle<select name="cycle"><option value="monthly">Monthly</option></select></label>';
    const changed=mode==='query'?'/basket?nonce=fresh':mode==='path'?'/other':mode==='origin'?'http://localhost:'+server.address().port+'/basket?nonce=fresh':'/basket?nonce=original';
    const script=['query','path','origin','body','method','twice'].includes(mode)?`<script>const form=document.querySelector('form');form.addEventListener('submit',async event=>{event.preventDefault();const values=new URLSearchParams(new FormData(form));${mode==='body'?"values.set('quantity','2');":''}${mode==='method'?`location.href='${changed}';`:`const response=await fetch('${changed}',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:values});${mode==='twice'?`await fetch('${changed}',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:values});`:''}document.body.innerHTML=await response.text();`}});</script>`:'';
    res.end('<main><h1>Product A</h1><form method="post" action="/basket?nonce=original">'+fields+danger+'<button id="next">'+(mode==='continue'?'Continue':'Next')+'</button></form></main>'+script);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const open=async(mode,extra={})=>createOrderBrowser({url:base+'/product?mode='+mode,product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit',program:{workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}}},{launch:options=>chromium.launch({...options,executablePath:executable}),...extra});
  try{
    await t.test('Continue clicked as a generic action is stopped before any request',async()=>{
      const before=received.length,browser=await open('continue');
      try{await assert.rejects(browser.methods.click('#next'),{code:'ORDER_FORM_GUARD'});assert.equal(received.length,before);}finally{await browser.close();}
    });
    await t.test('Next proceeds from product and configuration structure without cart wording',async()=>{
      const before=received.length,browser=await open('native');
      try{assert.deepEqual(await browser.methods.cart('#next'),{cartMutation:true});assert.equal(received.length,before+1);assert.equal(received.at(-1).body,'quantity=1&cycle=monthly');}finally{await browser.close();}
    });
    await t.test('query changes retain diagnostics and permit the bound POST body',async()=>{
      const trace=[],before=received.length,browser=await open('query',{onTrace:step=>trace.push(step)});
      try{await browser.methods.cart('#next');assert.equal(received.length,before+1);assert.equal(received.at(-1).query,'?nonce=fresh');assert.ok(trace.some(step=>step.urlMatches===true&&step.queryMatches===false));}finally{await browser.close();}
    });
    await t.test('site profile cart wording supplements configuration continuation',async()=>{
      const browser=await open('native',{siteProfile:{origin:base,formPatterns:{cart:'^Next$'}}});
      try{assert.deepEqual(await browser.methods.configure('#next'),{cartMutation:true});}finally{await browser.close();}
    });
    for(const mode of ['empty','payment','password'])await t.test(mode+' form remains unverified',async()=>{
      const before=received.length,browser=await open(mode);
      try{await assert.rejects(browser.methods.cart('#next'),{code:'ORDER_CART_UNVERIFIED'});assert.equal(received.length,before);}finally{await browser.close();}
    });
    for(const mode of ['path','origin','body','method'])await t.test(mode+' mismatch is blocked without sending a request',async()=>{
      const before=received.length,trace=[],browser=await open(mode,{onTrace:step=>trace.push(step)});
      try{await assert.rejects(browser.methods.cart('#next'),error=>['ORDER_REQUEST_BLOCKED','ORDER_CONTRACT_UNVERIFIED','ORDER_ORIGIN_BLOCKED'].includes(error.code));assert.equal(received.length,before);if(mode==='path')assert.ok(trace.some(step=>step.permits?.some(permit=>permit.urlMatches===false)));}finally{await browser.close();}
    });
    await t.test('a used cart permit cannot authorize another write',async()=>{
      const before=received.length,browser=await open('twice');
      try{await assert.rejects(browser.methods.cart('#next'),{code:'ORDER_PREPARATION_UNCERTAIN'});assert.equal(received.length,before+1);}finally{await browser.close();}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
