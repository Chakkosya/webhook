import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistedPlanner,planningObservation} from '../automation/agent/local-planner.js';
import {createPlanner,BUSINESS_PROMPT} from '../automation/agent/planner.js';
import {nativeRequestContract} from '../lib/order-contract.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createOrderService,validateOrderTask,validateOrderProgram,orderProgramHash} from '../lib/orders.js';

const order={url:'https://shop.example/checkout',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit'};
const program=()=>validateOrderProgram({summary:'Purchase monthly',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}});
function fixture({unknown=false,dryRun=true,rejectFill=false,expectedQuantity=1,monthlyCode='m',total=10,initialQuantity='0',initialCycle='y',decorate=page=>page}={}){
  let quantity=initialQuantity,cycle=initialCycle,epoch=0,current;
  const session={dryRun,trace:[],receipt:null,submissionStarted:false,paymentStarted:false,calls:[]};
  session.methods={
    observe:async()=>{
      const elements=[
        {tag:'h1',role:'heading',text:'Product A',accessibleName:'Product A'},
        {tag:'input',role:'spinbutton',name:unknown?'units':'quantity',label:unknown?'Units':'Quantity',value:quantity},
        {tag:'select',role:'combobox',name:'billingcycle',label:unknown?'Plan':'Cycle',value:cycle===monthlyCode?'Monthly':'Yearly',options:[{value:'y',text:'Yearly',selected:cycle==='y'},{value:monthlyCode,text:'Monthly',selected:cycle===monthlyCode}]},
        {tag:'span',id:'total',text:'USD '+total.toFixed(2),accessibleName:'USD '+total.toFixed(2)},
        {tag:'span',text:'USD',accessibleName:'USD'},
        {tag:'button',role:'button',text:'Place order',accessibleName:'Place order'}
      ].map((el,i)=>({...el,ref:'e'+(epoch*10+i),visible:true}));
      current={url:order.url,title:'Checkout',observationId:'page-'+epoch++,text:'Product A USD 10.00',html:'PRIVATE_HTML',domTree:[{private:'PRIVATE_TREE'}],elements};
      current=decorate(current);return structuredClone(current);
    },
    resolveSemantic:async target=>{assert.ok(current.elements.some(el=>el.ref===target.ref),'must bind fresh observed ref');return {selector:target.ref,strategy:'label'};},
    readSemantic:async target=>{const el=current.elements.find(el=>el.ref===target.ref);return {...el,...(el.tag==='select'?{value:cycle===monthlyCode?'Monthly':'Yearly',selectedValue:cycle}:{}),...(el.tag==='input'?{value:quantity}:{})};},
    fill:async(ref,value)=>{assert.equal(current.elements.find(el=>el.ref===ref)?.tag,'input');session.calls.push('fill');if(!rejectFill)quantity=String(value);},
    select:async(ref,value)=>{assert.equal(current.elements.find(el=>el.ref===ref)?.tag,'select');session.calls.push('select');cycle=value;},
    submit:async()=>{
      assert.equal(quantity,String(expectedQuantity));assert.equal(cycle,monthlyCode);
      session.calls.push('review');if(!dryRun)session.submissionStarted=true;
      session.receipt={status:dryRun?'prepared':'ordered',review:{product:'Product A',quantity:expectedQuantity,total,currency:'USD',configuration:[{name:'Cycle',value:'Monthly'}]},requestContract:nativeRequestContract({nativeSubmit:true,url:order.url,method:'POST',encoding:'application/x-www-form-urlencoded',entries:[['quantity',String(expectedQuantity)],['billingcycle',monthlyCode]]})};
      return session.receipt;
    }
  };
  session.snapshot=session.methods.observe;session.close=async()=>{};return session;
}
function batch(page){
  const t=(meaning,el)=>({meaning,ref:el.ref,confidence:0.95});
  const predicates=[el=>['h1','h2'].includes(el.tag),el=>el.role==='spinbutton',el=>el.tag==='select',el=>el.id==='total',el=>el.tag==='span'&&(el.text||el.accessibleName)==='USD',el=>el.role==='button'];
  const el=index=>page.elements.find(predicates[index]);
  return {steps:[
    {action:'fill',reason:'Set authorized quantity',target:t('quantity',el(1)),value:'1'},
    {action:'select',reason:'Select monthly billing',target:t('billing_cycle',el(2)),value:'m'},
    {action:'review',reason:'Check the current checkout',bindings:{submit:t('submit_order',el(5)),product:t('product',el(0)),quantity:t('quantity',el(1)),total:t('total',el(3)),currency:t('currency',el(4))},configuration:[{name:'Cycle',target:t('billing_cycle',el(2))}]}
  ]};
}
function serviceFixture({ambiguous=false,businessReply=()=>program(),stepReply,decorate}={}){
  const task=validateOrderTask({...order,instruction:'Cycle Monthly',monitorId:'m'});
  const user={id:'u',settings:{},monitors:[{id:'m',kind:'webpage'}],orderTasks:[task],orderAccounts:[{monitorId:'m',loginUrl:order.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:order.url}}}]};
  let business=0,assistance=0,opened=0,submitted=0;const sessions=[];
  const service=createOrderService({persist:()=>{},
    requestAI:async(_user,messages)=>{
      if(messages[0].content===BUSINESS_PROMPT){business++;return businessReply(JSON.parse(messages[1].content),business);}
      assistance++;
      const content=typeof messages[1].content==='string'?messages[1].content:messages[1].content[0].text;
      const input=JSON.parse(content),page=input.page;
      assert.equal(page.html,undefined);assert.equal(page.domTree,undefined);
      if(stepReply)return stepReply(input,assistance);
      if(ambiguous)return {action:'fill',reason:'Unsure which quantity control',target:{meaning:'quantity',ref:page.elements[1].ref,confidence:0.6},value:'1'};
      return batch(page);
    },
    openBrowser:async(current,options)=>{
      opened++;const session=fixture({unknown:true,dryRun:!!current.dryRun,decorate});sessions.push(session);
      const submit=session.methods.submit;
      session.methods.submit=async checks=>{if(!current.dryRun){await options.onBeforeSubmit({product:'Product A',quantity:1,total:10,currency:'USD'});submitted++;}return submit(checks);};
      return session;
    }
  });
  return {task,user,service,sessions,get business(){return business;},get assistance(){return assistance;},get opened(){return opened;},get submitted(){return submitted;}};
}
test('a mapped page follows the fixed business template without more AI',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture(),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  let calls=0;const session=fixture(),sources=[];
  const plan=createAssistedPlanner(async()=>{calls++;throw new Error('AI is unnecessary');},{recipes,onEvent:(_action,event)=>sources.push(event.source)});
  const result=await runCommerceAgent(program(),order,session,{plan});
  assert.equal(result.status,'prepared');assert.equal(calls,0);
  assert.deepEqual(session.calls,['fill','select','review']);assert.deepEqual(sources,['learned','learned','learned']);
});
test('one unknown-page AI explanation drives multiple code actions and is reused with fresh refs',async()=>{
  let calls=0;const recipes=[],sources=[];
  const assist=createPlanner(async messages=>{calls++;return batch(JSON.parse(messages[1].content).page);});
  const first=fixture({unknown:true});
  await runCommerceAgent(program(),order,first,{plan:createAssistedPlanner(assist,{recipes,onEvent:(_action,event)=>sources.push(event.source)})});
  assert.equal(calls,1);assert.deepEqual(sources,['ai_assistance','assisted_flow','assisted_flow']);assert.equal(recipes.length,3);
  assert.doesNotMatch(JSON.stringify(recipes),/"ref"|selector|PRIVATE_HTML|PRIVATE_TREE/);
  const second=fixture({unknown:true});
  await runCommerceAgent(program(),order,second,{plan:createAssistedPlanner(async()=>{throw new Error('must reuse discovered flow');},{recipes})});
  assert.deepEqual(second.calls,['fill','select','review']);assert.equal(calls,1);
});
test('one preflight and the approved execution reuse the compiled flow without more AI calls',async()=>{
  const f=serviceFixture();await f.service.generate(f.user,f.task);
  assert.equal(f.business,1);assert.equal(f.assistance,1);assert.equal(f.task.trial.preflightPasses,1);assert.equal(f.task.program.runtimePlan.length,3);assert.equal(f.submitted,0);
  const approved=orderProgramHash(f.task),compiled=JSON.stringify(f.task.program.runtimePlan);
  f.service.approve(f.user,f.task,approved);await f.service.execute(f.user,f.task);
  assert.equal(f.task.status,'ordered');assert.equal(f.assistance,1);assert.equal(f.submitted,1);assert.equal(orderProgramHash(f.task),approved);assert.equal(JSON.stringify(f.task.program.runtimePlan),compiled);
  assert.deepEqual(f.sessions.map(session=>session.calls),Array.from({length:2},()=>['fill','select','review']));
  await assert.rejects(f.service.execute(f.user,f.task),/已经执行/);assert.equal(f.submitted,1);
});
test('repeated internal binding failures preserve the product without asking the user to diagnose the page',async()=>{
  const f=serviceFixture({ambiguous:true});
  await assert.rejects(f.service.generate(f.user,f.task),{code:'AGENT_LOW_CONFIDENCE'});
  assert.equal(f.business,1);assert.equal(f.assistance,2);assert.equal(f.opened,1);assert.equal(f.submitted,0);
  assert.equal(f.task.failure.category,'recoverable');assert.equal(f.task.failure.orderRequestSent,'no');assert.equal(f.task.input,null);assert.equal(f.task.failure.input,undefined);assert.equal(f.task.product,'Product A');assert.match(f.task.error,/动作依据不足/);
  assert.equal(f.task.trial,null);assert.equal(f.task.enabled,false);
});
test('a failed mapped action asks AI to repair only the current obstacle',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture(),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({rejectFill:true});let assistance=0;
  const plan=createAssistedPlanner(async()=>{assistance++;return {action:'stop',reason:'网站拒绝数量修改，请确认是否需要先选择套餐'};},{recipes});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),error=>error.code==='AGENT_PLAN_INVALID'&&!error.orderInput&&/网站拒绝数量修改/.test(error.userMessage));
  assert.equal(assistance,2);assert.deepEqual(session.calls,['fill']);assert.equal(session.receipt,null);
});
test('semantic compression preserves late controls and hidden invoice metadata',()=>{
  const page={url:order.url,html:'huge',domTree:[{}],elements:Array.from({length:1400},(_,i)=>({ref:'e'+i,tag:'span',text:'text '+i,visible:true}))};
  page.elements.push({ref:'e1400',tag:'button',role:'button',text:'Pay invoice',formRef:'eform',visible:true},{ref:'e1401',tag:'input',type:'hidden',name:'invoiceid',value:'private-invoice-id',formRef:'eform',visible:false});
  const compact=planningObservation(page,{context:{submissionStarted:true}});
  assert.ok(compact.elements.length<=96);assert.ok(compact.elements.some(el=>el.ref==='e1400'));assert.ok(compact.elements.some(el=>el.name==='invoiceid'));assert.equal(compact.coverage.complete,false);assert.ok(compact.coverage.omitted>0);assert.equal(compact.html,undefined);assert.equal(compact.domTree,undefined);assert.doesNotMatch(JSON.stringify(compact),/private-invoice-id/);
});
test('ambiguous current controls invalidate learned actions rather than choosing the first match',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(createPlanner(async messages=>batch(JSON.parse(messages[1].content).page)),{recipes})});
  let assisted=0;const session=fixture({unknown:true});
  const observe=session.methods.observe;
  session.methods.observe=async()=>{const page=await observe();page.elements.push({...page.elements[1],ref:'e999'});return page;};
  const plan=createAssistedPlanner(async()=>{assisted++;return {action:'stop',reason:'Two matching quantity inputs; please choose a package'};},{recipes});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),error=>error.code==='AGENT_PLAN_INVALID'&&!error.orderInput);
  assert.equal(assisted,3);assert.deepEqual(session.calls,[]);
});


test('familiar field words never trigger speculative actions before a page is mapped',async()=>{
  const session=fixture();let calls=0;
  const plan=createAssistedPlanner(async()=>{calls++;return {action:'stop',reason:'Please identify the intended offer'};});
  await assert.rejects(runCommerceAgent(program(),order,session,{plan}),error=>error.code==='AGENT_PLAN_INVALID'&&!error.orderInput);
  assert.equal(calls,3);assert.deepEqual(session.calls,[]);
});
test('the same business template works with arbitrary merchant labels',async()=>{
  const recipes=[];let calls=0;
  const decorate=page=>{
    page.title='Ihr Angebot';
    Object.assign(page.elements[1],{name:'p_7a9',label:'Stückzahl'});
    Object.assign(page.elements[2],{name:'p_a14',label:'Vertragsperiode'});
    Object.assign(page.elements[5],{text:'Jetzt verbindlich bestellen',accessibleName:'Jetzt verbindlich bestellen'});
    return page;
  };
  for(let pass=0;pass<2;pass++){
    const session=fixture({decorate});
    await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async input=>{calls++;return batch(input.observation);},{recipes})});
    assert.deepEqual(session.calls,['fill','select','review']);
  }
  assert.equal(calls,1);
});
test('layout, title, tracking query, field names, amounts and option values may change without replanning',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({unknown:true,monthlyCode:'option-current-983',total:12,decorate:page=>{
    page.title='Updated page';page.url+='?utm_source=redesigned&utm_campaign=new';
    page.elements[1].name='generated-field-91';page.elements[2].name='generated-field-92';
    page.elements[0].tag='h2';page.elements[3].tag='div';
    page.elements.unshift({ref:'e9000',role:'link',tag:'a',text:'New help link',accessibleName:'New help link',visible:true,href:'/help'});
    page.elements.reverse();return page;
  }});
  const result=await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async()=>{throw new Error('Layout-only changes do not require AI');},{recipes})});
  assert.equal(result.review.total,12);assert.deepEqual(session.calls,['fill','select','review']);
});
test('task parameters supply values while merchant option identifiers are bound at runtime',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>{
    const result=batch(input.observation);result.steps[0].valueFrom='quantity';result.steps[1].valueFrom={requirement:'Cycle'};return result;
  },{recipes})});
  const session=fixture({unknown:true,expectedQuantity:2,monthlyCode:'monthly-now'});
  const result=await runCommerceAgent(program(),{...order,quantity:2},session,{plan:createAssistedPlanner(async()=>{throw new Error('Values must come from the task');},{recipes})});
  assert.equal(result.review.quantity,2);
});
test('missing bindings in a known page request a local repair before any action',async()=>{
  const recipes=[];
  await runCommerceAgent(program(),order,fixture({unknown:true}),{plan:createAssistedPlanner(async input=>batch(input.observation),{recipes})});
  const session=fixture({unknown:true,decorate:page=>{
    page.elements[1].name='brand-new';page.elements[1].label='別の入力';return page;
  }});
  let calls=0;
  await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async input=>{calls++;assert.deepEqual(session.calls,[]);return batch(input.observation);},{recipes})});
  assert.equal(calls,1);assert.deepEqual(session.calls,['fill','select','review']);
});
test('the fixed template enforces verification boundaries independently of page labels',async()=>{
  const session=fixture({unknown:true}),observation=await session.methods.observe();
  const plan=createAssistedPlanner(async input=>batch(input.observation));
  await assert.rejects(plan({order,workflow:program().workflow,observation,history:[],context:{pendingVerification:'cart'}}),{code:'AGENT_STEP_UNVERIFIED'});
  assert.deepEqual(session.calls,[]);
});


test('a repeated button caption does not transfer an action to another product or form',async()=>{
  const recipes=[],base={order,workflow:program().workflow,history:[],context:{couponApplied:true}};
  const observation={url:'https://shop.example/cart?step=one',elements:[{ref:'e0',role:'button',tag:'button',text:'Continue',accessibleName:'Continue',contextText:'Product A 64 GB',visible:true}]};
  const first=createAssistedPlanner(async()=>({action:'click',reason:'Continue the selected product',target:{meaning:'continue_product',ref:'e0',confidence:0.95}}),{recipes});
  await first({...base,observation});first.remember();
  let repaired=0;
  const next=createAssistedPlanner(async()=>{repaired++;return {action:'stop',reason:'This control now belongs to a different product'};},{recipes});
  const result=await next({...base,observation:{...observation,url:'https://shop.example/cart?step=two',elements:[{...observation.elements[0],ref:'e9',contextText:'Product A 128 GB'}]}});
  assert.equal(result.action,'stop');assert.equal(repaired,1);
});


test('a clarification inside coupon verification remains an explicit question',async()=>{
  const session=fixture({decorate:page=>({...page,elements:[...page.elements,{ref:'e991',tag:'span',text:'满减优惠',visible:true},{ref:'e992',tag:'span',text:'折扣优惠',visible:true}]})}),observed=await session.methods.observe(),t=(meaning,index)=>({meaning,ref:observed.elements[index].ref,confidence:0.95});
  let plans=0;
  session.methods.applyCoupon=async(_coupon,_checkout,{rebind})=>rebind();
  const plan=async input=>{
    plans++;
    if(input.context.pendingVerification==='coupon')return {action:'stop',reason:'两个优惠方案需要选择',clarification:{question:'选择满减优惠还是折扣优惠？',options:['满减优惠','折扣优惠']}};
    const page=input.observation,bind=(meaning,index)=>({...t(meaning,index),ref:page.elements[index].ref});
    return {action:'apply_coupon',reason:'Apply authorized coupon',bindings:{input:bind('coupon_input',1),apply:bind('coupon_apply',5),appliedCode:bind('coupon_proof',0),discount:bind('discount',3),submit:bind('submit_order',5),product:bind('product',0),quantity:bind('quantity',1),total:bind('total',3),currency:bind('currency',4)}};
  };
  await assert.rejects(runCommerceAgent(program(),{...order,couponCode:'SAVE'},session,{plan}),error=>error.code==='AGENT_NEEDS_INPUT'&&error.orderInput.question.includes('满减优惠'));
  assert.equal(plans,2);assert.equal(session.receipt,null);
});


test('AI batches and learned flows register satisfied defaults without rewriting or observing again',async()=>{
  const recipes=[];let assisted=0;
  for(let pass=0;pass<2;pass++){
    const browser=fixture({initialQuantity:'1',initialCycle:'m'}),registered=[];
    const result=await runCommerceAgent(program(),order,browser,{plan:createAssistedPlanner(async input=>{
      assisted++;assert.equal(pass,0);return batch(input.observation);
    },{recipes,onSatisfied:async step=>registered.push(step.action)})});
    assert.equal(result.status,'prepared');assert.deepEqual(browser.calls,['review']);
    assert.deepEqual(registered,['fill','select']);assert.equal((await browser.methods.observe()).observationId,'page-1');
  }
  assert.equal(assisted,1);assert.equal(recipes.length,3);
});

test('business query changes still require a current binding even with identical controls',async()=>{
  const recipes=[],base={order,workflow:program().workflow,history:[],context:{couponApplied:true}};
  const observation={url:order.url+'?pid=A&utm_source=old',elements:[{ref:'e0',tag:'button',role:'button',text:'Continue',visible:true}]};
  const first=createAssistedPlanner(async()=>({action:'click',reason:'Continue this product',target:{meaning:'continue',ref:'e0',confidence:0.95}}),{recipes});
  await first({...base,observation});first.remember();let calls=0;
  const next=createAssistedPlanner(async()=>{calls++;return {action:'stop',reason:'Different product route needs confirmation'};},{recipes});
  const result=await next({...base,observation:{...observation,url:order.url+'?pid=B&utm_source=new'}});
  assert.equal(result.action,'stop');assert.equal(calls,1);
});


test('AI requirement maps and numeric values retain every supplied purchase requirement',()=>{
  const result=validateOrderProgram({summary:'8 cores, monthly',workflow:{version:2,requirements:{Cores:8,Cycle:'Monthly'}}});
  assert.deepEqual(result.workflow.requirements,[{name:'Cores',value:'8'},{name:'Cycle',value:'Monthly'}]);
  for(const item of [{name:'Cycle'},{value:'Monthly'},{name:'Cycle',value:{code:'m'}}])assert.throws(()=>validateOrderProgram({summary:'Monthly',workflow:{version:2,requirements:[item]}}),{code:'ORDER_WORKFLOW_INVALID'});
});

test('a malformed business response is corrected internally using the rejected response',async()=>{
  const malformed={summary:'Purchase monthly',workflow:{version:2,requirements:[{value:'Monthly'}]}};
  const f=serviceFixture({businessReply:(request,attempt)=>{
    if(attempt===1)return malformed;
    assert.deepEqual(request.feedback.previousResponse,malformed);assert.match(request.feedback.error,/name 和 value/);return program();
  }});
  await f.service.generate(f.user,f.task);
  assert.equal(f.business,2);assert.equal(f.assistance,1);assert.equal(f.task.status,'ready');assert.equal(f.task.input,null);assert.equal(f.submitted,0);assert.deepEqual(f.task.program.workflow.requirements,[{name:'Cycle',value:'Monthly'}]);
});

test('repeated format failures do not become a question for the user',async()=>{
  const f=serviceFixture({businessReply:()=>({summary:'Purchase monthly',workflow:{version:2,requirements:[{name:'Cycle'}]}})});
  await assert.rejects(f.service.generate(f.user,f.task),/购买方案暂时未能整理完成/);
  assert.equal(f.business,2);assert.equal(f.opened,0);assert.equal(f.task.input,null);assert.equal(f.task.failure.input,undefined);assert.notEqual(f.task.failure.category,'needs_input');assert.equal(f.task.trial,null);assert.equal(f.task.instruction,'Cycle Monthly');assert.doesNotMatch(f.task.error,/name|value|JSON|SOP/);
  assert.ok(f.user.orderExecutionLogs[0].events.some(event=>event.error?.message.includes('name 和 value')));
});

test('only a concrete purchase choice prompts the user and a plain-language answer resumes preparation',async()=>{
  const f=serviceFixture({businessReply:request=>request.order.userClarification?.answer==='月付'?program():{clarification:{question:'你想按月付费还是按年付费？',options:['月付','年付']}}});
  f.task.instruction='月付或年付，想先确认一下';
  await assert.rejects(f.service.generate(f.user,f.task),{code:'ORDER_BUSINESS_REQUIREMENTS_UNCLEAR'});
  assert.equal(f.business,1);assert.equal(f.opened,0);assert.deepEqual(f.task.input.options,['月付','年付']);assert.equal(f.task.failure.category,'needs_input');
  Object.assign(f.task,validateOrderTask({...f.task,clarificationAnswer:'月付'},f.task));
  await f.service.generate(f.user,f.task);assert.equal(f.task.status,'ready');assert.equal(f.business,2);assert.equal(f.submitted,0);
});


test('a malformed page action receives its rejected output and the already identified product',async()=>{
  let rejected;
  const f=serviceFixture({stepReply:(input,attempt)=>{
    assert.equal(input.order.product,'Product A');assert.equal(input.order.url,order.url);
    assert.equal(input.page.targetProduct.status,'identified');assert.equal(input.page.targetProduct.name,'Product A');
    assert.ok(input.page.targetProduct.refs.every(ref=>input.page.elements.some(el=>el.ref===ref)));
    if(attempt===1){rejected=batch(input.page);rejected.steps[0].target.ref='not-a-current-ref';return rejected;}
    assert.deepEqual(input.feedback.previousPlan,rejected);assert.equal(input.feedback.error.code,'AGENT_PLAN_INVALID');
    return batch(input.page);
  }});
  await f.service.generate(f.user,f.task);
  assert.equal(f.assistance,2);assert.equal(f.opened,1);assert.equal(f.task.status,'ready');assert.equal(f.task.input,null);assert.equal(f.submitted,0);
});

test('a generic request to identify an already supplied product is repaired internally',async()=>{
  const f=serviceFixture({stepReply:(input,attempt)=>{
    if(attempt===1)return {action:'stop',reason:'请确认当前步骤应操作哪个商品、配置项或入口。'};
    assert.equal(input.feedback.previousPlan.action,'stop');assert.equal(input.page.targetProduct.status,'identified');
    return batch(input.page);
  }});
  await f.service.generate(f.user,f.task);assert.equal(f.assistance,2);assert.equal(f.task.status,'ready');assert.equal(f.task.input,null);
});

test('a real page choice resumes with its answer and cannot become the same question again',async()=>{
  const question={action:'stop',reason:'两个不同机房',clarification:{question:'选择哪个机房？',options:['东京','大阪']}};
  const decorate=page=>({...page,elements:[...page.elements,{ref:'e900',tag:'span',text:'东京',visible:true},{ref:'e901',tag:'span',text:'大阪',visible:true}]});
  let repeat=false;
  const f=serviceFixture({decorate,stepReply:input=>!input.userClarification||repeat?question:batch(input.page)});
  await assert.rejects(f.service.generate(f.user,f.task),{code:'AGENT_NEEDS_INPUT'});
  assert.deepEqual(f.task.input.options,['东京','大阪']);assert.equal(f.task.input.question,'选择哪个机房？');
  const current={version:2,scope:{origin:new URL(order.url).origin,path:new URL(order.url).pathname}},prefix={version:2,scope:{origin:new URL(order.url).origin,path:'/catalog'}};
  f.task.program.runtimePlan=[prefix,current];f.task.flowMemory={scope:'fixture',recipes:[prefix,current]};
  Object.assign(f.task,validateOrderTask({...f.task,clarificationAnswer:'东京'},f.task));
  assert.deepEqual(f.task.program.runtimePlan,[prefix]);assert.deepEqual(f.task.flowMemory.recipes,[prefix]);
  // The selected page is replanned with the answer, while the saved business requirements survive.
  f.task.program.runtimePlan=[];f.task.flowMemory=null;
  await f.service.generate(f.user,f.task);assert.equal(f.task.status,'ready');assert.equal(f.task.userClarification.answer,'东京');assert.equal(f.business,1);
  repeat=true;f.task.program.runtimePlan=[];f.task.flowMemory=null;
  await assert.rejects(f.service.generate(f.user,f.task),{code:'AGENT_PLAN_INVALID'});
  assert.equal(f.task.input,null);assert.equal(f.task.failure.input,undefined);assert.equal(f.task.product,'Product A');
});

test('editing the product does not force an answer to an obsolete question',()=>{
  const current=validateOrderTask({...order,monitorId:'m'});
  current.input={kind:'page_step',question:'旧商品确认',url:order.url};
  const next=validateOrderTask({...current,product:'Product B',clarificationAnswer:'Product B'},current);
  assert.equal(next.product,'Product B');assert.equal(next.input,null);assert.equal(next.userClarification,null);assert.equal(next.program,null);
});

test('a product URL alone cannot identify a missing or different product',()=>{
  const page={url:order.url,elements:[{ref:'e0',tag:'h1',role:'heading',text:'Product B',visible:true}]};
  assert.equal(planningObservation(page,{order}).targetProduct.status,'not_found');
  const choices={...page,elements:['r1','r2'].map((regionRef,i)=>({ref:'e'+i,tag:'h1',role:'heading',text:'Product A',regionRef,visible:true}))};
  assert.equal(planningObservation(choices,{order}).targetProduct.status,'multiple_matches');
});


test('page questions cannot ask again for an already specified billing choice',async()=>{
  const f=serviceFixture({stepReply:(input,attempt)=>{
    if(attempt===1)return {action:'stop',reason:'Choose a billing cycle',clarification:{question:'按月还是按年付款？',options:['Monthly','Yearly']}};
    assert.match(input.feedback.error.message,/已明确选择「Monthly」/);return batch(input.page);
  }});
  await f.service.generate(f.user,f.task);
  assert.equal(f.task.status,'ready');assert.equal(f.assistance,2);assert.equal(f.task.input,null);assert.deepEqual(f.task.program.workflow.requirements,[{name:'Cycle',value:'Monthly'}]);
});


test('an explicit product name supplies the current checkout binding without another model question',async()=>{
  const f=serviceFixture({stepReply:input=>{
    const result=batch(input.page);
    result.steps.at(-1).bindings.product={ref:input.page.targetProduct.binding.ref,meaning:'商品',confidence:0.4};
    return result;
  }});
  await f.service.generate(f.user,f.task);
  assert.equal(f.task.status,'ready');assert.equal(f.assistance,1);assert.equal(f.task.input,null);assert.equal(f.submitted,0);
  assert.deepEqual(f.sessions[0].calls,['fill','select','review']);
});

test('a valid live ref is executable even when an unlabelled field cannot produce a reusable locator',async()=>{
  for(const id of ['quantity-control',null]){
    const recipes=[],session=fixture({decorate:page=>{delete page.elements[1].name;delete page.elements[1].label;page.elements[1].id=id;return page;}});
    let calls=0;
    const result=await runCommerceAgent(program(),order,session,{plan:createAssistedPlanner(async input=>{calls++;return batch(input.observation);},{recipes})});
    assert.equal(result.status,'prepared');assert.deepEqual(session.calls,['fill','select','review']);
    assert.equal(calls,id?1:2);assert.ok(recipes.every(recipe=>!recipe.currentOnly));assert.doesNotMatch(JSON.stringify(recipes),/"ref"|observationId/);
  }
});


test('typing the product in the old confirmation box binds it and survives navigation',async()=>{
  const f=serviceFixture({stepReply:input=>{
    assert.equal(input.order.product,'Product A');
    const result=batch(input.page);delete result.steps.at(-1).bindings.product;return result;
  }});
  f.task.product='';f.task.input={kind:'page_step',question:'请确认当前步骤应操作哪个商品、配置项或入口。',url:order.url};
  Object.assign(f.task,validateOrderTask({...f.task,clarificationAnswer:'Product A'},f.task));
  await f.service.generate(f.user,f.task);
  assert.equal(f.task.status,'ready');assert.equal(f.task.verifiedProduct,'Product A');assert.equal(f.task.input,null);assert.equal(f.assistance,1);
  const base={order:{...order,product:'',userClarification:f.task.userClarification},workflow:program().workflow,context:{}};
  const planner=createAssistedPlanner(async input=>{assert.equal(input.order.product,'Product A');return batch(input.observation);});
  const page=await fixture().methods.observe();await planner({...base,observation:page});planner.reject();
  await planner({...base,observation:{...page,url:'https://shop.example/next'}});
});
