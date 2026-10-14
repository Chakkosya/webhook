import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createAssistedPlanner} from '../automation/agent/local-planner.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);
test('local merchant: one preparation, default values, JSON forms and transaction boundaries',{skip:!executable},async t=>{
  const counts={orders:0,carts:0};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');res.setHeader('content-type','text/html; charset=utf-8');
    if(url.pathname==='/create'){let body='';for await(const chunk of req)body+=chunk;counts.lastOrder=Object.fromEntries(new URLSearchParams(body));counts.orders++;return res.end('<h1 id="confirmation">Order Confirmation</h1><p>Your Order Number is: ABC-42</p>');}
    if(url.pathname==='/basket'){counts.carts++;res.writeHead(303,{location:'/checkout'+(url.searchParams.get('mode')==='radio'?'?mode=radio':url.searchParams.get('quantity')==='2'?'?quantity=2':'')});return res.end();}
    const configuring=url.pathname==='/configure',mode=url.searchParams.get('mode')||'native';
    const script=['native','get','required','cart-quantity','quantity-select','radio','radio-unchecked','payment'].includes(mode)?'':`<script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();document.body.dataset.clicked='yes';const form=e.target;const data=Object.fromEntries(new FormData(form));${mode==='tamper'?'data.quantity="2";':''}const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});document.body.innerHTML=await response.text();});</script>`;
    const quantity=url.searchParams.get('quantity')==='2'?'2':'1';
    const quantityField=configuring&&mode==='radio'?'<span id="quantity">1</span>':mode==='quantity-select'?'<select name="quantity"><option value="merchant-units-1">1 item</option><option value="merchant-units-2">2 items</option></select>':'<input name="quantity" type="number" value="'+quantity+'">';
    const cycleField=mode.startsWith('radio')?'<fieldset><legend>Cycle</legend><label><input type="radio" name="cycle" value="merchant-cycle-monthly" '+(mode==='radio'?'checked':'')+'>Monthly (USD 10.00)</label><label><input type="radio" name="cycle" value="merchant-cycle-yearly" '+(mode==='radio-unchecked'?'checked':'')+'>Yearly</label></fieldset>':'<label>Cycle<select name="cycle"><option value="monthly">Monthly (USD 10.00)</option></select></label>';
    const paymentField=mode==='payment'?'<label>Payment method<select name="paymentmethod" onchange="document.body.dataset.paymentChanges=Number(document.body.dataset.paymentChanges||0)+1"><option value="paypal">PayPal</option><option value="alipay">Alipay</option></select></label>':'';
    res.end('<a href="/logout">Log out</a><main><h1>Product A</h1><p id="total">USD 10.00</p><p id="currency">USD</p><form method="'+(mode==='get'?'get':'post')+'" action="'+(configuring?'/basket'+(mode==='radio'?'?mode=radio':mode==='cart-quantity'?'?quantity=2':''):'/create')+'">'+(mode==='required'?'<input name="hostname" required>':'')+'<input type="hidden" name="csrf" value="rotating-token"><label>Quantity'+quantityField+'</label>'+cycleField+paymentField+'<button>'+ (configuring?'Continue':'Place order')+'</button></form></main>'+script);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const launch=options=>chromium.launch({...options,executablePath:executable});
  const workflow={summary:'Monthly product',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}};
  const task={url:base+'/checkout',product:'Product A',quantity:1,currency:'USD',maxTotal:20,executionMode:'submit',program:workflow};
  const plan=async({observation:page})=>{
    const bind=(meaning,predicate)=>{const els=page.elements.filter(predicate);assert.equal(els.length,1,meaning);return {meaning,ref:els[0].ref,confidence:0.95};};
    const product=bind('product',el=>el.tag==='h1'),quantity=bind('quantity',el=>el.name==='quantity'||el.id==='quantity'),cycle=bind('cycle',el=>el.name==='cycle'&&(el.type!=='radio'||el.value==='merchant-cycle-monthly'));
    if(new URL(page.url).pathname==='/configure')return {action:'configure',reason:'Continue using current authorized defaults',target:bind('configure',el=>el.tag==='button'),bindings:{product,quantity},configuration:[{name:'Cycle',target:cycle}]};
    return {action:'review',reason:'Review current order',bindings:{submit:bind('submit',el=>el.tag==='button'),product,quantity,total:bind('total',el=>el.id==='total'),currency:bind('currency',el=>el.id==='currency')},configuration:[{name:'Cycle',target:cycle}]};
  };
  try{

    for(const mode of ['native','json','quantity-select'])await t.test(mode+' submits directly with no saved trial or request contract',async()=>{
      const before=counts.orders;let started=0;
      const order={...task,url:base+'/checkout?mode='+mode,product:'',currency:''},browser=await createOrderBrowser(order,{launch,onBeforeSubmit:async()=>{started++;}});
      try{const result=await runCommerceAgent(workflow,order,browser,{plan});assert.equal(result.status,'ordered');assert.equal(result.review.product,'Product A');assert.equal(result.review.currency,'USD');assert.equal(started,1);assert.equal(counts.orders,before+1);}finally{await browser.close();}
    });
    await t.test('a product discovered during configuration reaches checkout and submits in one session',async()=>{
      const before=counts.orders,beforeCarts=counts.carts,order={...task,url:base+'/configure',product:''},browser=await createOrderBrowser(order,{launch});
      try{assert.equal((await runCommerceAgent(workflow,order,browser,{plan})).status,'ordered');assert.equal(counts.carts,beforeCarts+1);assert.equal(counts.orders,before+1);}finally{await browser.close();}
    });
    for(const mismatch of [{product:'Product B'},{quantity:2},{currency:'CNY'},{maxTotal:5}])await t.test('direct execution rejects '+Object.keys(mismatch)[0]+' mismatch before submission',async()=>{
      const before=counts.orders;let started=0;const order={...task,...mismatch},browser=await createOrderBrowser(order,{launch,onBeforeSubmit:async()=>{started++;}});
      try{await assert.rejects(runCommerceAgent(workflow,order,browser,{plan,autoRepair:false}));assert.equal(started,0);assert.equal(counts.orders,before);}finally{await browser.close();}
    });
    for(const mode of ['native','json','quantity-select'])await t.test(mode+' preflight has zero submit clicks or screenshots; execution sends one order',async()=>{
      let captures=0,started=0;const before=counts.orders,order={...task,url:base+'/checkout?mode='+mode};
      let browser=await createOrderBrowser({...order,dryRun:true},{launch,onEvidence:async()=>{captures++;}}),trial;
      try{trial=await runCommerceAgent(workflow,order,browser,{plan});assert.equal(trial.status,'prepared');assert.equal(counts.orders,before);assert.equal(captures,0);assert.doesNotMatch(await browser.productHtml(),/data-clicked="yes"/);}finally{await browser.close();}
      browser=await createOrderBrowser({...order,submissionContract:trial.requestContract},{launch,onBeforeSubmit:async()=>{started++;},onEvidence:async()=>{captures++;}});
      try{const result=await runCommerceAgent(workflow,order,browser,{plan});assert.equal(result.status,'ordered');assert.equal(started,1);assert.equal(counts.orders,before+1);assert.equal(captures,0);await assert.rejects(browser.methods.submit(),/重复提交/);assert.equal(counts.orders,before+1);}finally{await browser.close();}
    });
    for(const mode of ['native','get','quantity-select'])await t.test(mode+' unchanged default configuration proceeds without a synthetic fill or select',async()=>{
      const order={...task,url:base+'/configure?mode='+mode,dryRun:true},before=counts.carts,browser=await createOrderBrowser(order,{launch});
      try{assert.equal((await runCommerceAgent(workflow,order,browser,{plan})).status,'prepared');assert.equal(counts.carts,before+1);assert.ok(!browser.trace.some(step=>['填写','选择'].includes(step.action)));}finally{await browser.close();}
    });
    await t.test('an AI batch with satisfied defaults performs only one observation and no field writes',async()=>{
      const order={...task,dryRun:true},browser=await createOrderBrowser(order,{launch});
      let observations=0,assisted=0;const observe=browser.methods.observe;
      browser.methods.observe=async()=>{observations++;return observe();};
      const assistedPlan=createAssistedPlanner(async input=>{
        assisted++;const review=await plan(input),quantity=review.bindings.quantity,cycle=review.configuration[0].target;
        return {steps:[{action:'fill',reason:'Use authorized quantity',target:quantity,valueFrom:'quantity'},
          {action:'select',reason:'Use monthly cycle',target:cycle,valueFrom:{requirement:'Cycle'}},review]};
      },{onSatisfied:step=>browser.methods.registerPreparation(step)});
      try{assert.equal((await runCommerceAgent(workflow,order,browser,{plan:assistedPlan})).status,'prepared');assert.equal(assisted,1);assert.equal(observations,1);assert.ok(!browser.trace.some(step=>['填写','选择'].includes(step.action)));}finally{await browser.close();}
    });
    await t.test('a cart quantity mismatch is repaired locally without another cart request',async()=>{
      const order={...task,url:base+'/configure?mode=cart-quantity',dryRun:true},before=counts.carts,beforeOrders=counts.orders,browser=await createOrderBrowser(order,{launch});let corrections=0;
      const correctingPlan=async input=>{
        const quantity=input.observation.elements.find(el=>el.name==='quantity');
        if(input.context.pendingVerification==='cart'&&quantity?.value==='2'){
          corrections++;const review=await plan(input);
          return {action:'fill',reason:'Correct the current cart to the authorized count',target:review.bindings.quantity,value:'1',bindings:{product:review.bindings.product,quantity:review.bindings.quantity}};
        }
        const step=await plan(input);if(new URL(input.observation.url).pathname==='/configure')step.action='cart';return step;
      };
      try{assert.equal((await runCommerceAgent(workflow,order,browser,{plan:correctingPlan})).status,'prepared');assert.equal(corrections,1);assert.equal(counts.carts,before+1);assert.equal(counts.orders,beforeOrders);}finally{await browser.close();}
    });
    await t.test('selected radio labels support preparation and submission with merchant values',async()=>{
      const order={...task,url:base+'/configure?mode=radio'},before=counts.orders,beforeCarts=counts.carts;
      let browser=await createOrderBrowser({...order,dryRun:true},{launch}),trial;
      try{trial=await runCommerceAgent(workflow,order,browser,{plan,autoRepair:false});assert.equal(trial.status,'prepared');assert.equal(counts.orders,before);assert.ok(!browser.trace.some(step=>step.action==='勾选'));}finally{await browser.close();}
      browser=await createOrderBrowser({...order,submissionContract:trial.requestContract},{launch});
      try{const result=await runCommerceAgent(workflow,order,browser,{plan,autoRepair:false});assert.equal(result.status,'ordered');assert.equal(result.orderId,'ABC-42');assert.equal(counts.orders,before+1);assert.equal(counts.carts,beforeCarts+2);assert.equal(counts.lastOrder.cycle,'merchant-cycle-monthly');}finally{await browser.close();}
    });
    await t.test('an unchecked radio label is not selected configuration evidence',async()=>{
      const order={...task,url:base+'/checkout?mode=radio-unchecked',dryRun:true},browser=await createOrderBrowser(order,{launch});
      try{await assert.rejects(runCommerceAgent(workflow,order,browser,{plan,autoRepair:false}),{code:'AGENT_CONFIGURATION_UNVERIFIED'});await browser.methods.check('[name="cycle"][value="merchant-cycle-monthly"]');assert.equal((await runCommerceAgent(workflow,order,browser,{plan,autoRepair:false})).status,'prepared');}finally{await browser.close();}
    });
    await t.test('registering an already selected payment method does not dispatch change',async()=>{
      const order={...task,url:base+'/checkout?mode=payment',executionMode:'pay',paymentMethod:{kind:'website',name:'PayPal'},dryRun:true},browser=await createOrderBrowser(order,{launch});
      const choice={selector:'[name="paymentmethod"]',value:'paypal'};
      try{await browser.methods.choosePayment(choice);await browser.methods.choosePayment(choice);assert.doesNotMatch(await browser.productHtml(),/data-payment-changes/);const result=await runCommerceAgent(workflow,order,browser,{plan,autoRepair:false});assert.equal(result.paymentMethod.value,'paypal');await browser.methods.select(choice.selector,'alipay');await browser.methods.choosePayment(choice);assert.match(await browser.productHtml(),/data-payment-changes="2"/);}finally{await browser.close();}
    });
    await t.test('a JavaScript quantity change never reaches the merchant',async()=>{
      const order={...task,url:base+'/checkout?mode=tamper'},before=counts.orders;let browser=await createOrderBrowser({...order,dryRun:true},{launch}),trial;
      try{trial=await runCommerceAgent(workflow,order,browser,{plan});}finally{await browser.close();}
      browser=await createOrderBrowser({...order,submissionContract:trial.requestContract},{launch});
      try{await assert.rejects(runCommerceAgent(workflow,order,browser,{plan}),{code:'ORDER_CONTRACT_UNVERIFIED'});assert.equal(counts.orders,before);}finally{await browser.close();}
    });
    await t.test('required native controls are read before any trial click',async()=>{
      const before=counts.orders,order={...task,url:base+'/checkout?mode=required',dryRun:true},browser=await createOrderBrowser(order,{launch});
      try{await assert.rejects(runCommerceAgent(workflow,order,browser,{plan,autoRepair:false}),{code:'AGENT_CONFIGURATION_UNVERIFIED'});assert.equal(counts.orders,before);await browser.methods.fill('[name=hostname]','fixture-host');assert.equal((await runCommerceAgent(workflow,order,browser,{plan})).status,'prepared');assert.equal(counts.orders,before);}finally{await browser.close();}
    });
    await t.test('over-budget checkout stops before a transaction record or request',async()=>{
      let started=0;const before=counts.orders,order={...task,maxTotal:5,dryRun:true},browser=await createOrderBrowser(order,{launch,onBeforeSubmit:async()=>{started++;}});
      try{await assert.rejects(runCommerceAgent(workflow,order,browser,{plan}),/总价超过上限/);assert.equal(started,0);assert.equal(counts.orders,before);}finally{await browser.close();}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
