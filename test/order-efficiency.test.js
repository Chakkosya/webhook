import test from 'node:test';
import assert from 'node:assert/strict';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createAssistedPlanner} from '../automation/agent/local-planner.js';
import {createOrderService,validateOrderTask,orderProgramHash} from '../lib/orders.js';
import {nativeRequestPermit,matchesNativeRequest,nativeRequestContract} from '../lib/order-contract.js';
const order={url:'https://shop.example/checkout',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit'};
const program={summary:'Use current checkout',workflow:{version:2,requirements:[]}};
const target=(meaning,ref)=>({meaning,ref:/^e\d+$/.test(ref)?ref:({submit:'e0',product:'e1',quantity:'e2',total:'e3',currency:'e4',cart:'e5'})[ref],confidence:0.95});
const review=()=>({action:'review',reason:'Review current order',bindings:Object.fromEntries(['submit','product','quantity','total','currency'].map(name=>[name,target(name,name)]))});
const form={nativeSubmit:true,url:'https://shop.example/create',method:'POST',encoding:'application/x-www-form-urlencoded',entries:[['product','A'],['quantity','1'],['csrf','token']]};
const request=(type,body)=>({method:()=>'POST',url:()=>form.url,headers:()=>({'content-type':type}),postData:()=>body});
function session({quantity='1',product='Product A',dryRun=true,onBeforeSubmit=async()=>{}}={}){
  const state={trace:[],dryRun,receipt:null,submissionStarted:false,paymentStarted:false,submits:0,carts:0};
  state.methods={observe:async()=>({url:order.url,observationId:'current',text:'Product A USD 10',elements:[{ref:'e0',role:'button',tag:'button',text:'Place order'},{ref:'e1',tag:'h1',text:'Product A'},{ref:'e2',role:'spinbutton',tag:'input',name:'quantity',value:quantity},{ref:'e3',tag:'span',text:'USD 10'},{ref:'e4',tag:'span',text:'USD'}]}),resolveSemantic:async value=>({selector:value.ref,strategy:'ref'}),readSemantic:async value=>value.meaning==='product'?{text:product}:{value:quantity},fill:async(_ref,value)=>{quantity=String(value);state.fills=(state.fills||0)+1;},cart:async()=>{state.carts++;return {cartMutation:true};},submit:async()=>{assert.equal(quantity,'1');state.submits++;if(!dryRun){await onBeforeSubmit();state.submissionStarted=true;}state.receipt={status:dryRun?'prepared':'ordered',review:{product:'Product A',quantity:1,total:10,currency:'USD'},requestContract:nativeRequestContract(form)};return state.receipt;}};
  state.snapshot=state.methods.observe;state.close=async()=>{};return state;
}
test('one preflight prepares and approves the current flow; execution creates only one order',async()=>{
  const task=validateOrderTask({...order,monitorId:'m'}),user={id:'efficiency',settings:{},monitors:[{id:'m',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'m',loginUrl:order.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:order.url}}}]};
  let opened=0,assisted=0,submitted=0;
  const service=createOrderService({persist:()=>{},siteMemory:{read:async()=>null,record:async()=>{}},requestAI:async()=>{assisted++;return review();},openBrowser:async(task,options)=>{opened++;return session({dryRun:!!task.dryRun,onBeforeSubmit:async()=>{await options.onBeforeSubmit({product:'Product A',quantity:1,total:10,currency:'USD'});submitted++;}});}});
  await service.generate(user,task);assert.equal(opened,1);assert.equal(task.trial.preflightPasses,1);assert.equal(submitted,0);
  service.approve(user,task,orderProgramHash(task));await service.execute(user,task);assert.equal(task.status,'ordered');assert.equal(opened,2);assert.equal(assisted,1);assert.equal(submitted,1);
  await assert.rejects(service.execute(user,task));assert.equal(submitted,1);
});
test('checkout reuses the cart bindings and still checks quantity before submit',async()=>{
  for(const quantity of ['1','2']){
    const browser=session({quantity}),steps=[{action:'cart',reason:'Add product once',target:target('cart','cart')},review()];
    const run=runCommerceAgent(program,order,browser,{plan:async()=>steps.shift(),autoRepair:false});
    if(quantity==='1'){assert.equal((await run).status,'prepared');assert.equal(browser.submits,1);}else{await assert.rejects(run,{code:'AGENT_STEP_UNVERIFIED'});assert.equal(browser.submits,0);}
    assert.equal(browser.carts,1);
  }
});
test('a second cart mutation is rejected while the first cart is awaiting review',async()=>{
  const browser=session(),step={action:'cart',reason:'Add product once',target:target('cart','cart')};
  await assert.rejects(runCommerceAgent(program,order,browser,{plan:async()=>step,autoRepair:false}),{code:'AGENT_STEP_UNVERIFIED'});assert.equal(browser.carts,1);assert.equal(browser.submits,0);
});
test('AI gets expanded current DOM evidence once when the compact view is insufficient',async()=>{
  let calls=0;const planner=createAssistedPlanner(async input=>{calls++;if(calls===1)return {action:'stop',reason:'Required control was omitted from current summary'};assert.ok(input.observation.elements.length>96);assert.ok(JSON.stringify(input.observation).length<=64000);return {action:'click',reason:'Found the current element',target:target('next','e139')};});
  const input={order,workflow:program.workflow,context:{},observation:{url:order.url,observationId:'current',elements:Array.from({length:140},(_,i)=>({ref:'e'+i,tag:'button',role:'button',text:'Option '+i,visible:true}))}};
  await assert.rejects(planner(input),{code:'AGENT_OBSERVATION_INCOMPLETE'});
  const step=await planner({...input,feedback:{error:{code:'AGENT_OBSERVATION_INCOMPLETE'}}});assert.equal(step.target.ref,'e139');assert.equal(calls,2);
});
test('a form serialized as JSON retains exact product, quantity and complete field checks',()=>{
  const permit=nativeRequestPermit(form);
  assert.equal(matchesNativeRequest(permit,request('application/json',JSON.stringify({product:'A',quantity:1,csrf:'token'}))),true);
  for(const body of [{product:'A',quantity:2,csrf:'token'},{product:'B',quantity:1,csrf:'token'},{quantity:1,csrf:'token'},{product:'A',quantity:1,csrf:'token',autopay:true},{product:'A',quantity:1,csrf:'token',autopay:[]}])assert.equal(matchesNativeRequest(permit,request('application/json',JSON.stringify(body))),false);
  assert.equal(matchesNativeRequest(permit,request('application/x-www-form-urlencoded','quantity=1&csrf=token&product=A')),true);
});

import {matchesOrderConfiguration} from '../lib/order-evidence.js';
import {parseOrderTotal} from '../lib/order-browser.js';
import {resolveValueSource} from '../automation/agent/flow-template.js';
test('decorated configuration labels bind current values without matching another specification',()=>{
  for(const [expected,actual] of [['Monthly','Monthly (USD 10.00)'],['8 GB','8GB'],['Monthly','MONTHLY — $10.00 USD']])assert.equal(matchesOrderConfiguration(expected,actual),true,actual);
  for(const actual of ['Yearly (USD 10.00)','Monthly + backup','Monthly 2 years'])assert.equal(matchesOrderConfiguration('Monthly',actual),false);
  assert.equal(matchesOrderConfiguration('8 GB','128 GB'),false);
  assert.equal(matchesOrderConfiguration('Monthly USD 10.00','Monthly USD 20.00'),false);
  const step=resolveValueSource({action:'select',target:{ref:'e1'},valueFrom:{requirement:'Cycle'}},{workflow:{requirements:[{name:'Cycle',value:'Monthly'}]},observation:{elements:[{ref:'e1',options:[{value:'monthly-v2',text:'Monthly (USD 12.00)'}]}]}});assert.equal(step.value,'monthly-v2');
});
test('checkout amounts accept common decimal and grouping formats but reject ambiguous totals',()=>{
  for(const text of ['USD 1,234.56','EUR 1.234,56','EUR 1 234,56',"CHF 1'234.56"])assert.equal(parseOrderTotal(text),1234.56,text);
  for(const text of ['USD 10.00','EUR 10,00','JPY 10'])assert.equal(parseOrderTotal(text),10,text);
  for(const text of ['USD 10 and USD 20','USD -1','1.23.456','1,23,45','1.234,567','10 20','USD −10'])assert.throws(()=>parseOrderTotal(text),undefined,text);
});

import {confirmationEvidence} from '../automation/adapters/generic-commerce.js';
test('created-order wording and pending payment do not hide an existing order',()=>{
  const page=text=>({elements:[{text,visible:true}]});
  for(const text of ['Order #42 created successfully','Order number: ABC-7 has been received','Order #42 confirmed, payment pending'])assert.ok(confirmationEvidence(page(text),'order'),text);
  for(const text of ['Order #42 not created','Order #42 pending','Order #42 created unsuccessfully'])assert.equal(confirmationEvidence(page(text),'order'),null,text);
  assert.equal(confirmationEvidence(page('Order #42 confirmed, payment pending'),'payment'),null);
  const confirmation={elements:[{text:'Order Confirmation',visible:true},{text:'Your Order Number is: ABC-42',visible:true}]};
  assert.deepEqual(confirmationEvidence(confirmation,'order'),{text:'Order Confirmation',orderId:'ABC-42'});
  assert.equal(confirmationEvidence(confirmation,'payment'),null);
  assert.equal(confirmationEvidence({elements:[confirmation.elements[0]]},'order'),null);
  assert.equal(confirmationEvidence({elements:[confirmation.elements[0],{text:'Your Order Number is:',visible:true}]},'order'),null);
});


test('cart quantity can be corrected in place, with no extra add or premature submit',async()=>{
  for(const kind of ['valid','wrong-product','wrong-quantity','other-control']){
    const browser=session({quantity:'2',product:kind==='wrong-product'?'Product B':'Product A'});
    const correction={action:'fill',reason:'Restore task quantity in the current cart',target:target('quantity',kind==='other-control'?'e3':'e2'),value:kind==='wrong-quantity'?'3':'1',bindings:{product:target('product','e1'),quantity:target('quantity','e2')}};
    const steps=[{action:'cart',reason:'Enter cart once',target:target('cart','cart')},correction,review()];
    const run=runCommerceAgent(program,order,browser,{plan:async()=>steps.shift(),autoRepair:false});
    if(kind==='valid'){assert.equal((await run).status,'prepared');assert.equal(browser.fills,1);assert.equal(browser.submits,1);}
    else{await assert.rejects(run,{code:'AGENT_STEP_UNVERIFIED'});assert.equal(browser.fills||0,0);assert.equal(browser.submits,0);}
    assert.equal(browser.carts,1);
  }
});

test('quantity options bind the authorized count from visible labels, not merchant identifiers',()=>{
  const input={order,workflow:program.workflow,context:{pendingVerification:'cart'},observation:{elements:[{ref:'e2',options:[{value:'sku-count-1',text:'1 item'},{value:'sku-count-2',text:'2 items'}]}]}};
  const step=resolveValueSource({action:'select',target:target('quantity','e2'),valueFrom:'quantity',bindings:{product:target('product','e1'),quantity:target('quantity','e2')}},input);
  assert.equal(step.value,'sku-count-1');assertFlowStep(step,input);
  assert.throws(()=>assertFlowStep({...step,value:'sku-count-2'},input),{code:'AGENT_STEP_UNVERIFIED'});
});

import {assertFlowStep} from '../automation/agent/flow-template.js';
import {agentError} from '../automation/agent/model.js';

test('verified page progress does not replenish the task transient recovery budget',async()=>{
  const browser=session();let phase=0,attempt=0,recoveries=0;
  const observe=browser.methods.observe;
  browser.methods.observe=async()=>{const page=await observe();page.url+='?step='+phase;return page;};
  browser.methods.click=async()=>{phase++;attempt=0;};
  const plan=async()=>{
    if(phase===2)return review();
    if(attempt++<2)throw agentError('AGENT_ELEMENT_MISSING','Page element is still mounting');
    return {action:'click',reason:'Continue to the next verified page',target:target('continue','e0')};
  };
  await assert.rejects(runCommerceAgent(program,order,browser,{plan,onLearn:async value=>{if(value.status==='recovery')recoveries++;}}),{code:'AGENT_ELEMENT_MISSING'});
    assert.equal(recoveries,3);assert.equal(browser.submits,0);
});

test('a successful no-op on an unchanged page cannot replenish recovery attempts',async()=>{
  const browser=session();let calls=0;
  const plan=async()=>{
    calls++;
    if(calls===3)return {action:'fill',reason:'Quantity already has this value',target:target('quantity','e2'),value:'1'};
    throw agentError('AGENT_ELEMENT_MISSING','Same unresolved page');
  };
  await assert.rejects(runCommerceAgent(program,order,browser,{plan}),{code:'AGENT_ELEMENT_MISSING'});
  assert.equal(calls,5);assert.equal(browser.submits,0);
});
