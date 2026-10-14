import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistedPlanner,planningObservation} from '../automation/agent/local-planner.js';
import {runCommerceAgent} from '../automation/agent/executor.js';

const target=(meaning='continue_to_cart',ref='e0',confidence=0.95)=>({meaning,ref,confidence});
const observation={observationId:'configuration',url:'https://shop.test/configure',elements:[
  {ref:'e0',tag:'button',role:'button',type:'submit',text:'Continue'},
  {ref:'e1',tag:'h1',role:'heading',text:'Product A'},
  {ref:'e2',tag:'input',role:'spinbutton',name:'quantity',value:'1'}
]};
const input={order:{url:observation.url,product:'Product A',quantity:1,executionMode:'prepare'},workflow:{version:2,requirements:[]},observation,history:[],context:{}};
const cart=()=>({action:'cart',reason:'Continue the selected product',target:target()});
const invalidTarget=()=>({...cart(),target:target('Continue to cart')});
const missingElement=()=>({...cart(),target:target('continue_to_cart','e99')});

async function rejection(plan,context,expected){
  let received;
  await assert.rejects(plan(context),error=>{
    assert.equal(error.code,expected.code);
    if(expected.slot)assert.equal(error.slot,expected.slot);
    received=error;return true;
  });
  return received;
}

test('two format errors at different slots leave the next valid same-page plan available',async()=>{
  const replies=[invalidTarget(),{...cart(),bindings:{product:target('Product A','e1')}},cart()];
  let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return replies.shift();});
  await rejection(plan,input,{code:'AGENT_PLAN_INVALID',slot:'target'});
  await rejection(plan,input,{code:'AGENT_PLAN_INVALID',slot:'bindings.product'});
  const accepted=await plan(input);
  assert.equal(accepted.action,'cart');assert.equal(accepted.bindings.product.ref,'e1');
  assert.equal(calls,3);
});

test('format and binding failures do not consume each other recovery budget',async()=>{
  for(const replies of [[invalidTarget(),missingElement(),cart()],[missingElement(),invalidTarget(),cart()]]){
    let calls=0;
    const plan=createAssistedPlanner(async()=>{calls++;return replies.shift();});
    await assert.rejects(plan(input));await assert.rejects(plan(input));
    assert.equal((await plan(input)).action,'cart');assert.equal(calls,3);
  }
});

test('format budget exhaustion preserves the last code, slot, actual values and reason',async()=>{
  const lowConfidence={...cart(),target:target('continue_to_cart','e0',0.4)};
  const replies=[invalidTarget(),lowConfidence];let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return replies.shift();});
  await rejection(plan,input,{code:'AGENT_PLAN_INVALID',slot:'target'});
  const last=await rejection(plan,input,{code:'AGENT_LOW_CONFIDENCE',slot:'target'});
  const exhausted=await rejection(plan,input,{code:'AGENT_LOW_CONFIDENCE',slot:'target'});
  assert.equal(calls,2);
  assert.deepEqual(exhausted.actual,last.actual);assert.deepEqual(exhausted.rejectedPlan,lowConfidence);
  assert.ok(exhausted.message.includes('AGENT_LOW_CONFIDENCE'));
  assert.ok(exhausted.message.includes('slot=target'));assert.ok(exhausted.message.includes(last.message));
  assert.equal(exhausted.userMessage,exhausted.message);
});

test('two genuine binding failures still stop assistance and retain the final binding slot',async()=>{
  const missingQuantity={...cart(),bindings:{quantity:target('quantity','e98')}};
  const replies=[missingElement(),missingQuantity];let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return replies.shift();});
  await rejection(plan,input,{code:'AGENT_ELEMENT_MISSING',slot:'target'});
  const last=await rejection(plan,input,{code:'AGENT_ELEMENT_MISSING',slot:'bindings.quantity'});
  const exhausted=await rejection(plan,input,{code:'AGENT_ELEMENT_MISSING',slot:'bindings.quantity'});
  assert.equal(calls,2);assert.deepEqual(exhausted.rejectedPlan,missingQuantity);
  assert.ok(exhausted.message.includes('AGENT_ELEMENT_MISSING'));
  assert.ok(exhausted.message.includes('slot=bindings.quantity'));assert.ok(exhausted.message.includes(last.message));
});

test('unverified flow binding retains its existing two-failure limit',async()=>{
  let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return {action:'choosePayment',reason:'Choose payment',target:target('payment_method','e0')};});
  const last=await rejection(plan,input,{code:'AGENT_STEP_UNVERIFIED'});
  await rejection(plan,input,{code:'AGENT_STEP_UNVERIFIED'});
  const exhausted=await rejection(plan,input,{code:'AGENT_STEP_UNVERIFIED',slot:'step'});
  assert.equal(calls,2);assert.ok(exhausted.message.includes('AGENT_STEP_UNVERIFIED'));
  assert.ok(exhausted.message.includes('slot=step'));assert.ok(exhausted.message.includes(last.message));
});

test('verified progress resets both format and binding failure budgets for the page',async()=>{
  const replies=[invalidTarget(),missingElement(),cart(),invalidTarget(),missingElement(),{...cart(),action:'configure'}];let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return replies.shift();});
  const context={...input,feedback:{error:{code:'AGENT_PLAN_INVALID'}}};
  await rejection(plan,context,{code:'AGENT_PLAN_INVALID'});
  await rejection(plan,context,{code:'AGENT_ELEMENT_MISSING'});
  const verified=await plan(context);plan.remember({step:verified,input:context});
  await rejection(plan,context,{code:'AGENT_PLAN_INVALID'});
  await rejection(plan,context,{code:'AGENT_ELEMENT_MISSING'});
  assert.equal((await plan(context)).action,'configure');assert.equal(calls,6);
});

test('known product omitted from compact planning view expands before the first assistance call',async()=>{
  const page={...observation,elements:[
    ...Array.from({length:100},(_,index)=>({ref:'e'+index,tag:'button',role:'button',text:'Option '+index,regionRef:'product-region'})),
    {ref:'e100',tag:'h1',role:'heading',text:'Product A',regionRef:'product-region'},
    {ref:'e101',tag:'button',role:'button',text:'Open account'}
  ]};
  const context={...input,observation:page};
  const compact=planningObservation(page,context);
  assert.equal(compact.coverage.limits.elements,96);
  assert.equal(compact.elements.some(element=>element.ref==='e100'),false);
  let calls=0;
  const plan=createAssistedPlanner(async current=>{
    calls++;
    assert.equal(current.observation.coverage.limits.elements,288);
    assert.ok(current.observation.elements.length>96);
    assert.ok(current.observation.elements.some(element=>element.ref==='e100'));
    return cart();
  });
  const accepted=await plan(context);
  assert.equal(accepted.action,'cart');assert.equal(accepted.bindings.product.ref,'e100');assert.equal(calls,1);
});


test('executor completes a valid third plan after different-slot format failures within its existing budget',async()=>{
  const page={...observation,elements:[...observation.elements,
    {ref:'e3',tag:'span',text:'USD 10'},
    {ref:'e4',tag:'span',text:'USD'}
  ]};
  const review={action:'review',reason:'Review the current checkout',bindings:{
    submit:target('submit_order','e0'),product:target('product','e1'),quantity:target('quantity','e2'),total:target('total','e3'),currency:target('currency','e4')
  }};
  const replies=[invalidTarget(),{...cart(),bindings:{product:target('Product A','e1')}},review];
  let calls=0,submits=0;const repairs=[];
  const session={receipt:null,submissionStarted:false,paymentStarted:false};
  session.methods={
    observe:async()=>structuredClone(page),
    resolveSemantic:async value=>{assert.ok(page.elements.some(element=>element.ref===value.ref));return {selector:value.ref,strategy:'ref'};},
    cart:async()=>assert.fail('Rejected plans must not write to the cart'),
    submit:async checks=>{
      assert.deepEqual([checks.submitSelector,checks.productSelector,checks.quantitySelector,checks.totalSelector,checks.currencySelector],['e0','e1','e2','e3','e4']);
      submits++;session.receipt={status:'prepared',review:{product:'Product A',quantity:1,total:10,currency:'USD'}};return session.receipt;
    }
  };
  const plan=createAssistedPlanner(async current=>{
    calls++;
    if(calls===2)assert.equal(current.feedback.error.slot,'target');
    if(calls===3)assert.equal(current.feedback.error.slot,'bindings.product');
    return replies.shift();
  });
  const receipt=await runCommerceAgent({workflow:input.workflow},{...input.order,maxTotal:20,currency:'USD'},session,{
    plan,onEvent:(action,event)=>{if(action==='重新观察并修复')repairs.push(event);}
  });
  assert.equal(receipt.status,'prepared');assert.equal(calls,3);assert.equal(submits,1);
  assert.deepEqual(repairs.map(event=>event.attempt),[1,2]);
  assert.deepEqual(repairs.map(event=>event.maxAttempts),[2,2]);
  assert.deepEqual(repairs.map(event=>event.kind),['deterministic','deterministic']);
});
