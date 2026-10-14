import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {inspectCommercePage} from '../automation/browser/dom-parser.js';

const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);
const checkout={submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'};
const payment={paySelector:'#pay',invoiceSelector:'#invoice',totalSelector:'#invoice-total',currencySelector:'#invoice-currency',balanceSelector:'#balance',balanceCurrencySelector:'#balance-currency',confirmationSelector:'#paid'};
const stale=()=>Object.assign(new Error('Current observation has expired'),{code:'AGENT_OBSERVATION_STALE'});

test('write verification refreshes expired observations without replaying requests',{skip:!executable,timeout:90000},async t=>{
  const requests=[];
  const product='<h1 id="product">Product A</h1><span id="total">USD 10.00</span><span id="currency">USD</span>';
  const checkoutPage=product+'<form method="post" action="/create"><label>Quantity<input id="quantity" name="quantity" value="1"></label><button id="submit">Place order</button></form>';
  const invoicePage='<p id="confirmation">Order confirmed: write-42</p><p>Order number: write-42</p><form method="post" action="/pay"><input id="invoice" type="hidden" name="invoiceid" value="write-42"><p id="invoice-total">USD 10.00</p><p id="invoice-currency">USD</p><p id="balance">USD 20.00</p><p id="balance-currency">USD</p><p id="pending">Payment status</p><button id="pay">Pay now with account balance</button></form>';
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    requests.push({path:url.pathname,method:req.method,body});
    res.setHeader('content-type','text/html; charset=utf-8');
    if(url.pathname==='/basket'||url.pathname==='/checkout')return res.end('<main>'+(url.searchParams.get('pay')==='ajax'?checkoutPage.replace('action="/create"','action="/create?pay=ajax"'):checkoutPage)+'</main>');
    if(url.pathname==='/create'){
      const script=url.searchParams.get('pay')!=='ajax'?'':'<script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();const response=await fetch("/pay",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(event.target))});await response.text();document.querySelector("#pending").textContent="Scan QR code to complete payment";};</script>';
      return res.end('<main>'+invoicePage+'</main>'+script);
    }
    if(url.pathname==='/pay')return res.end('<main><h1 id="paid">Payment successful: write-42 Paid</h1></main>');
    const mode=url.searchParams.get('mode')||'native';
    const replacement=mode==='replace'?'document.body.innerHTML=await response.text();':'await response.text();';
    const script=mode==='native'?'':'<script>document.querySelector("form").onsubmit=async event=>{event.preventDefault();const response=await fetch("/basket",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(event.target))});'+replacement+'};</script>';
    const details=url.searchParams.has('long')?'<div>'+Array.from({length:500},(_,index)=>'<span id="detail-'+index+'">Configuration detail '+index+'</span>').join(' ')+'</div>':'';
    res.end('<main>'+product+'<form method="post" action="/basket"><label>Quantity<input name="quantity" value="1"></label><button id="next">Continue</button></form>'+details+'</main>'+script);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const posts=path=>requests.filter(request=>request.method==='POST'&&request.path===path).length;
  const open=async(path='/configure?mode=native',options={})=>{
    const state={page:null,observations:[],readFault:null,readsAfterWrite:0};
    const before=requests.length;
    const launch=async options=>{
      const browser=await chromium.launch({...options,executablePath:executable}),newContext=browser.newContext.bind(browser);
      browser.newContext=async options=>{
        const context=await newContext(options),newPage=context.newPage.bind(context);
        context.newPage=async()=>{
          const page=await newPage(),evaluate=page.evaluate.bind(page),content=page.content.bind(page);
          state.page=page;
          page.evaluate=async(fn,arg)=>{
            const result=await evaluate(fn,arg);
            if(fn===inspectCommercePage&&typeof arg==='string')state.observations.push(result);
            return result;
          };
          page.content=async()=>{
            if(state.readFault&&requests.slice(before).some(request=>request.method==='POST')){
              const error=await state.readFault({observations:state.observations.length,read:++state.readsAfterWrite});
              if(error)throw error;
            }
            return content();
          };
          return page;
        };
        return context;
      };
      return browser;
    };
    state.browser=await createOrderBrowser({url:base+path,product:'Product A',quantity:1,maxTotal:10,currency:'USD',executionMode:'pay',paymentMethod:{kind:'balance',name:'账户余额'},program:{checkout}},{launch,...options});
    return state;
  };
  try{
    for(const action of ['cart','configure'])await t.test(action+' refreshes the configuration observation after navigation',async()=>{
      const before=posts('/basket'),session=await open();
      try{
        const previous=await session.browser.methods.observe();
        assert.deepEqual(await session.browser.methods[action]('#next'),{cartMutation:action==='cart'});
        assert.equal(posts('/basket'),before+1);
        assert.equal(session.observations.length,2);
        assert.equal(session.observations.at(-1).url,base+'/basket');
        assert.notEqual(session.observations.at(-1).observationId,previous.observationId);
        assert.equal(await session.browser.methods.isObservationCurrent(),true);
        assert.equal(await session.browser.methods.isObservationCurrent({observation:previous}),false);
      }finally{await session.browser.close();}
    });
    await t.test('cart refreshes replaced DOM markers while the URL stays unchanged',async()=>{
      const before=posts('/basket'),session=await open('/configure?mode=replace');
      try{
        const previous=await session.browser.methods.observe();
        assert.deepEqual(await session.browser.methods.cart('#next'),{cartMutation:true});
        assert.equal(posts('/basket'),before+1);
        assert.equal(session.observations.length,2);
        assert.equal(session.observations.at(-1).url,session.observations[0].url);
        assert.notEqual(session.observations.at(-1).observationId,previous.observationId);
        assert.match(session.observations.at(-1).text,/Place order/);
        assert.equal(await session.browser.methods.isObservationCurrent(),true);
      }finally{await session.browser.close();}
    });
    await t.test('a long replaced page probes expired refs once and refreshes without replaying',async()=>{
      const before=posts('/basket'),session=await open('/configure?mode=replace&long=1');
      try{
        const previous=await session.browser.methods.observe();
        assert.ok(previous.elements.length>=500);
        await session.page.evaluate(()=>document.querySelectorAll('[data-agent-ref]').forEach(element=>element.removeAttribute('data-agent-ref')));
        const locate=session.page.locator.bind(session.page);let freshnessReads=0;
        session.page.locator=(selector,...args)=>{
          const locator=locate(selector,...args);
          if(selector.startsWith('[data-agent-ref')){
            const count=locator.count.bind(locator);
            locator.count=async(...args)=>{freshnessReads++;return count(...args);};
          }
          return locator;
        };
        try{
          assert.equal(await session.browser.methods.isObservationCurrent({observation:previous}),false);
          assert.equal(freshnessReads,1);
        }finally{session.page.locator=locate;}
        await session.browser.methods.observe();
        const beforeSnapshots=session.observations.length;
        assert.deepEqual(await session.browser.methods.cart('#next'),{cartMutation:true});
        assert.equal(posts('/basket'),before+1);
        assert.equal(session.observations.length,beforeSnapshots+1);
        assert.equal(session.observations.at(-1).url,session.observations[0].url);
        assert.match(session.observations.at(-1).text,/Place order/);
        assert.equal(await session.browser.methods.isObservationCurrent(),true);
      }finally{await session.browser.close();}
    });
    await t.test('observation freshness uses the URL captured with the snapshot',async()=>{
      const before=requests.filter(request=>request.method==='POST').length,session=await open('/checkout');
      try{
        const evaluate=session.page.evaluate.bind(session.page);let changed=false;
        session.page.evaluate=async(fn,arg)=>{
          const result=await evaluate(fn,arg);
          if(!changed&&fn===inspectCommercePage&&typeof arg==='string'){
            changed=true;
            await evaluate(()=>history.replaceState({},'','/checkout?later=1'));
          }
          return result;
        };
        const previous=await session.browser.methods.observe();
        assert.equal(previous.url,base+'/checkout');
        assert.equal(session.page.url(),base+'/checkout?later=1');
        assert.equal(await session.browser.methods.isObservationCurrent(),false);
        const current=await session.browser.methods.observe();
        assert.notEqual(current.observationId,previous.observationId);
        assert.equal(await session.browser.methods.isObservationCurrent({observation:current}),true);
        assert.equal(await session.browser.methods.isObservationCurrent({observation:previous}),false);
        assert.equal(requests.filter(request=>request.method==='POST').length,before);
      }finally{await session.browser.close();}
    });
    await t.test('an unchanged observation does not require another snapshot',async()=>{
      const before=posts('/basket'),session=await open('/configure?mode=unchanged');
      try{
        await session.browser.methods.observe();
        assert.deepEqual(await session.browser.methods.cart('#next'),{cartMutation:true});
        assert.equal(posts('/basket'),before+1);
        assert.equal(session.observations.length,1);
      }finally{await session.browser.close();}
    });
    await t.test('a stale verification read refreshes once and confirms the existing write',async()=>{
      const before=posts('/basket'),session=await open('/configure?mode=unchanged');let staleReads=0;
      try{
        await session.browser.methods.observe();
        session.readFault=({read})=>read===1?(staleReads++,stale()):null;
        assert.deepEqual(await session.browser.methods.cart('#next'),{cartMutation:true});
        assert.equal(staleReads,1);
        assert.equal(posts('/basket'),before+1);
        assert.equal(session.observations.length,2);
      }finally{await session.browser.close();}
    });
    await t.test('an unconfirmed fresh snapshot remains uncertain without a second write',async()=>{
      const before=posts('/basket'),session=await open('/configure?mode=unchanged');let failedReads=0;
      try{
        await session.browser.methods.observe();
        session.readFault=({read,observations})=>{
          if(read===1)return stale();
          if(observations===2){failedReads++;return Object.assign(new Error('The new page does not confirm the result'),{code:'ORDER_CONFIRMATION_UNVERIFIED'});}
          return null;
        };
        await assert.rejects(session.browser.methods.cart('#next'),{code:'ORDER_PREPARATION_UNCERTAIN'});
        assert.equal(failedReads,1);
        assert.equal(session.observations.length,2);
        assert.equal(posts('/basket'),before+1);
      }finally{await session.browser.close();}
    });
    for(const semantic of [false,true])await t.test((semantic?'semantic':'selector')+' order and payment confirmation use fresh observations and one POST each',async()=>{
      let submissions=0,payments=0;
      const beforeOrders=posts('/create'),beforePayments=posts('/pay'),session=await open('/checkout',{onBeforeSubmit:async()=>submissions++,onBeforePayment:async()=>payments++});
      try{
        const previous=await session.browser.methods.observe();
        const ordered=await session.browser.methods.submit({...checkout,semantic});
        assert.equal(ordered.status,'ordered');
        assert.equal(ordered.url,base+'/create');
        assert.equal(submissions,1);
        assert.equal(posts('/create'),beforeOrders+1);
        assert.ok(session.observations.some(observation=>observation.url===base+'/create'&&observation.observationId!==previous.observationId));
        if(semantic)assert.equal(ordered.orderId,'write-42');
        const beforeSnapshots=session.observations.length,prepay=session.observations.at(-1),pending=prepay.elements.find(element=>element.id==='pending');
        assert.ok(pending);
        const pendingSelector='[data-agent-ref='+JSON.stringify(prepay.observationId+':'+pending.ref)+']';
        const paid=await session.browser.methods.pay({...payment,semantic,...(semantic?{pendingSelector}:{})});
        assert.equal(paid.status,'paid');
        assert.equal(paid.invoiceId,'write-42');
        assert.equal(paid.url,base+'/pay');
        assert.equal(payments,1);
        assert.equal(posts('/create'),beforeOrders+1);
        assert.equal(posts('/pay'),beforePayments+1);
        assert.ok(session.observations.slice(beforeSnapshots).some(observation=>observation.url===base+'/pay'));
        assert.match(paid.confirmation,/Payment successful/);
      }finally{await session.browser.close();}
    });
    await t.test('semantic payment retains a pending node across a stale-read refresh without replaying',async()=>{
      const beforeOrders=posts('/create'),beforePayments=posts('/pay'),session=await open('/checkout?pay=ajax');let staleReads=0;
      try{
        await session.browser.methods.observe();
        assert.equal((await session.browser.methods.submit({...checkout,semantic:true})).status,'ordered');
        const prepay=session.observations.at(-1),pending=prepay.elements.find(element=>element.id==='pending');
        assert.ok(pending);
        const pendingSelector='[data-agent-ref='+JSON.stringify(prepay.observationId+':'+pending.ref)+']';
        session.readFault=async()=>{
          if(posts('/pay')===beforePayments||staleReads)return null;
          await session.page.locator('#pending').filter({hasText:'Scan QR code to complete payment'}).waitFor({state:'visible',timeout:3000});
          staleReads++;return stale();
        };
        const beforeSnapshots=session.observations.length;
        const result=await session.browser.methods.pay({...payment,semantic:true,pendingSelector});
        assert.equal(result.status,'awaiting_payment');
        assert.equal(result.paymentPending.reason,'payment_verification');
        assert.equal(result.invoiceId,'write-42');
        assert.equal(session.page.url(),base+'/create?pay=ajax');
        assert.equal(staleReads,1);
        assert.equal(session.observations.length,beforeSnapshots+1);
        assert.match(session.observations.at(-1).text,/Scan QR code to complete payment/);
        assert.equal(posts('/create'),beforeOrders+1);
        assert.equal(posts('/pay'),beforePayments+1);
      }finally{await session.browser.close();}
    });
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
