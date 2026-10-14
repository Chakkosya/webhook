import {flowContext,assertFlowStep} from '../automation/agent/flow-template.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrderService,validateOrderTask} from '../lib/orders.js';
import {validateTarget} from '../automation/agent/model.js';
import {pageType} from '../automation/adapters/generic-commerce.js';
import {diagnosticAIOutput} from '../lib/order-execution-log.js';
import {quantityLimit,checkQuantityCapacity,checkStockCapacity} from '../lib/order-quantity.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({quantity=3,maxTotal=100,limit=10,price=q=>q*10,mode='submit',unknownAt=0,pendingAt=0,currency='USD',hold=false}={}){
  const user={id:'budget-user',monitors:[],orderAccounts:[],orderTasks:[]},orders=[],attempts=[],gates=[];let payments=0;
  const add=()=>{
    const monitor={id:'m'+user.monitors.length,kind:'webpage',enabled:true};user.monitors.push(monitor);
    const task=validateOrderTask({monitorId:monitor.id,url:'https://shop.example/product',product:'Product A',quantity,maxTotal,currency,executionMode:mode});user.orderTasks.push(task);
    user.orderAccounts.push({monitorId:monitor.id,loginUrl:task.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:task.url}}});return task;
  };
  const service=createOrderService({persist:()=>{},siteMemory:{read:async()=>null,record:async()=>{}},requestAI:async(_user,messages)=>{
    const input=JSON.parse(messages.at(-1).content);if(!input.page)return {summary:'Purchase product',workflow:{version:2,requirements:[]}};
    const target=i=>({ref:'e'+i,meaning:'field_'+i,confidence:0.93});
    return input.context.submissionStarted?{action:'pay',reason:'Pay confirmed original invoice',bindings:{pay:target(0),invoice:target(1),total:target(3),currency:target(4)}}:{action:'review',reason:'Check current order',bindings:{submit:target(0),product:target(1),quantity:target(2),total:target(3),currency:target(4)}};
  },openBrowser:async(current,options)=>{
    attempts.push({id:current.id,quantity:current.quantity,budget:current.maxTotal,currency:current.currency});if(hold)await new Promise(resolve=>gates.push(resolve));
    const total=price(current.quantity),review={product:current.product,quantity:current.quantity,total,currency:currency||'CAD'},page={url:current.url,text:'Product A',elements:Array.from({length:5},(_,i)=>({ref:'e'+i,tag:i===0?'button':'span',role:i===0?'button':null,text:i===0?'Place order':String(i)}))};
    const session={dryRun:!!current.dryRun,trace:[],receipt:null,submissionStarted:false,paymentStarted:false,snapshot:async()=>page,close:async()=>{},methods:{observe:async()=>page,resolveSemantic:async target=>({selector:target.ref}),submit:async()=>{
      if(current.quantity>limit)throw quantityLimit(limit,'商家单笔限购 '+limit+' 件');
      if(total>current.maxTotal)throw Object.assign(new Error('实际报价 '+review.currency+' '+total+' 超过剩余预算 '+current.maxTotal),{code:'ORDER_BUDGET_EXCEEDED',quote:review});
      if(current.dryRun||mode==='prepare')return session.receipt={status:'prepared',review,requestContract:{status:'verified'}};
      await options.onBeforeSubmit(review);session.submissionStarted=true;orders.push(review);
      assert.equal(user.orderTasks.find(t=>t.id===current.id).purchases.at(-1).status,'submitting');
      if(orders.length===unknownAt)throw new Error('confirmation lost');
      return session.receipt={status:'ordered',orderId:String(orders.length),review};
    },pay:async()=>{
      if(orders.length===pendingAt)return session.receipt={...session.receipt,status:'awaiting_payment',paymentPending:{reason:'insufficient_balance',message:'余额不足'}};
      await options.onBeforePayment({invoiceId:session.receipt.orderId,total,currency:review.currency});session.paymentStarted=true;payments++;
      return session.receipt={...session.receipt,status:'paid',invoiceId:session.receipt.orderId};
    }}};return session;
  }});
  const task=add();return {user,task,service,orders,attempts,gates,add,get payments(){return payments;},async execute(t=task){service.approve(user,t);return service.execute(user,t);}};
}

test('VMISS action requires snake_case meaning and keeps ref/confidence validation',()=>{
  const target={meaning:'purchase_entry',ref:'e201',confidence:0.93};
  assert.deepEqual(validateTarget(target),target);
  for(const bad of [{ref:'old-ref'},{ref:201},{confidence:0.4},{meaning:''},{meaning:'购买入口'},{meaning:'Order Now'},{meaning:'continue__to_cart'},{meaning:'x'.repeat(301)}])assert.throws(()=>validateTarget({...target,...bad}));
  assert.equal(diagnosticAIOutput({steps:[{action:'click',target}]}).steps[0].target.ref,'e201');
});
test('catalog product cards outrank a Shopping Cart title and navigation',()=>{
  const page={title:'Shopping Cart - VMISS',text:'Shopping Cart',elements:[{ref:'e1',role:'link',text:'Shopping Cart'},{ref:'e2',role:'link',text:'Order Now',regionRef:'r1'},{ref:'e3',role:'link',text:'Order Now',regionRef:'r2'}]};
  assert.equal(pageType(page),'catalog');assert.equal(pageType({title:'Shopping Cart',elements:[]}), 'product_or_other');
  assert.equal(pageType({elements:[{role:'button',text:'Checkout'},{tag:'p',text:'Quantity 2 Total CAD 130'}]}),'cart');
});
test('quantity capacity uses visible option counts and number input limits',()=>{
  for(const field of [{tag:'input',max:'2'},{tag:'select',options:[{value:'a',text:'1 item'},{value:'b',text:'2 items'},{value:'c',text:'3 items',disabled:true}]}])assert.throws(()=>checkQuantityCapacity(field,3),{code:'ORDER_QUANTITY_LIMIT',availableQuantity:2});
});
test('budget uses actual taxed quotes descending and stops before an unaffordable remaining item',async()=>{
  const f=fixture({quantity:4,maxTotal:25,price:q=>q*10+2});await f.execute();
  assert.deepEqual(f.attempts.map(a=>a.quantity),[4,3,2,2,1]);assert.deepEqual(f.orders.map(r=>r.quantity),[2]);
  assert.equal(f.task.status,'partial');assert.deepEqual([f.task.result.purchaseSummary.quantity,f.task.result.purchaseSummary.total],[2,22]);assert.match(f.task.result.purchaseSummary.reason,/12.*3/);assert.equal(f.task.quantity,4);assert.equal(f.task.maxTotal,25);
});
test('exact budget and quantity discount are checked as merchant totals',async()=>{
  const f=fixture({quantity:3,maxTotal:25,price:q=>q===3?25:q*12});await f.execute();assert.deepEqual(f.orders.map(r=>r.quantity),[3]);assert.equal(f.task.result.purchaseSummary.total,25);assert.equal(f.task.status,'ordered');
});
test('single-order limits split only after confirmation, sharing cumulative budget and detected currency',async()=>{
  const f=fixture({quantity:3,limit:1,maxTotal:25,currency:''});await f.execute();
  assert.deepEqual(f.orders.map(r=>r.quantity),[1,1]);assert.deepEqual(f.attempts.map(a=>a.budget),[25,25,15,5]);assert.equal(f.attempts.at(-1).currency,'CAD');
  assert.equal(f.task.purchases.length,2);assert.equal(f.task.result.purchaseSummary.quantity,2);assert.equal(f.task.result.purchaseSummary.total,20);
});
test('each confirmed order may be paid once; pending payment stops the next purchase',async()=>{
  for(const pendingAt of [0,2]){const f=fixture({quantity:3,limit:1,mode:'pay',pendingAt});await f.execute();assert.equal(f.orders.length,pendingAt||3);assert.equal(f.payments,pendingAt?1:3);assert.equal(f.task.status,pendingAt?'awaiting_payment':'paid');assert.equal(f.task.purchases.filter(p=>p.paymentStartedAt).length,f.payments);}
});
test('unknown second submission preserves the first receipt and prevents all later transactions',async()=>{
  const f=fixture({limit:1,unknownAt:2});await f.execute();assert.equal(f.orders.length,2);assert.equal(f.task.status,'uncertain');assert.equal(f.task.result.purchaseSummary.quantity,1);assert.equal(f.task.result.purchases[1].status,'uncertain');
  await f.service.trigger(f.user,f.user.monitors[0]);f.service.recover([f.user]);assert.equal(f.orders.length,2);await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);
});
test('one unaffordable item and prepare mode never submit an order',async()=>{
  for(const mode of ['submit','prepare']){const f=fixture({quantity:2,maxTotal:5,mode});await f.execute();assert.equal(f.orders.length,0);assert.equal(f.task.errorCode,'ORDER_BUDGET_EXCEEDED');assert.match(f.task.error,/10/);}
  const f=fixture({quantity:3,maxTotal:25,mode:'prepare'});await f.execute();assert.equal(f.orders.length,0);assert.equal(f.task.result.review.quantity,2);
});
test('busy stock triggers are retained, deduplicated, and drained immediately after a slot is released',async()=>{
  const f=fixture({quantity:1,hold:true}),tasks=[f.task,f.add(),f.add()];for(const task of tasks)f.service.approve(f.user,task);
  const first=f.service.trigger(f.user,f.user.monitors[0]),second=f.service.trigger(f.user,f.user.monitors[1]);while(f.gates.length<2)await turn();
  const third=f.service.trigger(f.user,f.user.monitors[2]),duplicate=f.service.trigger(f.user,f.user.monitors[2]);assert.ok(tasks[2].pendingTrigger);assert.equal(f.attempts.length,2);
  f.gates[0]();while(f.gates.length<3)await turn();assert.equal(f.attempts.length,3);assert.equal(tasks[2].pendingTrigger,undefined);f.gates[1]();f.gates[2]();await Promise.all([first,second,third,duplicate]);assert.equal(f.orders.length,3);
});
test('pause or editing a queued task cancels its pending stock trigger',async()=>{
  for(const change of ['pause','edit']){const f=fixture({quantity:1,hold:true}),tasks=[f.task,f.add(),f.add()];for(const task of tasks)f.service.approve(f.user,task);
    const runs=[0,1,2].map(i=>f.service.trigger(f.user,f.user.monitors[i]));while(f.gates.length<2)await turn();
    if(change==='pause')f.service.pause(f.user,tasks[2]);else Object.assign(tasks[2],validateOrderTask({...tasks[2],maxTotal:90},tasks[2]));
    f.gates[0]();f.gates[1]();await Promise.all(runs);assert.equal(f.orders.length,2);assert.equal(f.attempts.length,2);
  }
});

test('stock reduction uses the chosen card count and ignores conflicting region counts',()=>{
  assert.throws(()=>checkStockCapacity('DS.CN.HK.BGP.V2 64G 5 Available',7),{code:'ORDER_QUANTITY_LIMIT',availableQuantity:5});
  assert.throws(()=>checkStockCapacity('0 Available',1),{code:'ORDER_OUT_OF_STOCK'});
  assert.doesNotThrow(()=>checkStockCapacity('0 Available 5 Available',7));
});

test('optional preparation reduces quantity using the same live quote without creating an order',async()=>{
  const f=fixture({quantity:3,maxTotal:25});await f.service.generate(f.user,f.task);
  assert.equal(f.task.status,'ready');assert.equal(f.task.trial.review.quantity,2);assert.equal(f.task.quantity,3);assert.equal(f.orders.length,0);
});

test('submission-only planning excludes payment selection even when a merchant displays payment controls',()=>{
  for(const executionMode of ['prepare','submit']){const input={order:{executionMode},context:{}};assert.ok(!flowContext(input).allowedActions.includes('choosePayment'));assert.throws(()=>assertFlowStep({action:'choosePayment'},input),{code:'AGENT_STEP_UNVERIFIED'});}
  assert.ok(flowContext({order:{executionMode:'pay'}}).allowedActions.includes('choosePayment'));
});
