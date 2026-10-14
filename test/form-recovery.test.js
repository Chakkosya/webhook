import test from 'node:test';
import assert from 'node:assert/strict';
import {STEP_PROMPT,createPlanner} from '../automation/agent/planner.js';
import {agentError,validateTarget} from '../automation/agent/model.js';
import {canRecover,recoveryContext,recoveryKind} from '../automation/agent/recovery.js';
import {runCommerceAgent} from '../automation/agent/executor.js';

const target={meaning:'continue_to_cart',ref:'e0',confidence:0.95};
const page={url:'https://shop.test/configure',elements:[{ref:'e0',tag:'button',type:'submit',formRef:'e5',text:'Continue'}]};
const review={action:'review',reason:'Verify checkout',bindings:Object.fromEntries(['submit','product','quantity','total','currency'].map(meaning=>[meaning,{...target,meaning}]))};
function fixture(){
  const session={trace:[],methods:{observe:async()=>page,resolveSemantic:async()=>({selector:'#continue',strategy:'css'}),click:async()=>{throw agentError('ORDER_FORM_GUARD','表单按钮不能使用 click');},cart:async()=>({}),submit:async()=>session.receipt={status:'prepared'},readSemantic:async value=>value.meaning==='product'?{text:'Product A'}:{value:'1'}}};
  return session;
}
const program={workflow:{version:2,requirements:[]}},order={url:page.url,product:'Product A',quantity:1,executionMode:'prepare'};

test('prompt and validator agree on snake_case and form actions',()=>{
  for(const meaning of ['purchase_entry','continue_to_cart','quantity_2'])assert.equal(validateTarget({...target,meaning}).meaning,meaning);
  for(const meaning of ['购买入口','Order Now','quantity__2','_purchase','purchase_'])assert.throws(()=>validateTarget({...target,meaning}),{code:'AGENT_PLAN_INVALID'});
  assert.equal(validateTarget({...target,meaning:' continue_to_cart '}).meaning,'continue_to_cart');
  assert.match(STEP_PROMPT,/snake_case/);assert.match(STEP_PROMPT,/type=submit/);assert.match(STEP_PROMPT,/禁止用 click/);
});
test('click guard provides cart guidance through the actual AI planner payload',async()=>{
  const session=fixture(),error=agentError('ORDER_FORM_GUARD','提交按钮');
  const recovered=await recoveryContext(error,session,[]);
  assert.match(recovered.feedback.guidance,/改用 cart/);
  let payload;
  const plan=createPlanner(async messages=>{payload=JSON.parse(messages.at(-1).content);return review;});
  await plan({order,workflow:program.workflow,observation:page,history:[],context:{},feedback:recovered.feedback});
  assert.match(payload.feedback.guidance,/改用 cart/);
  assert.equal(recoveryKind(error),'deterministic');
  assert.equal(canRecover(error,session,{attempts:1}),true);
  assert.equal(canRecover(error,session,{attempts:2}),false);
  assert.equal(canRecover(error,{...session,paymentStarted:true},{attempts:0}),false);
});
test('mistaken click recovers with cart and reaches prepared checkout',async()=>{
  const session=fixture();let plans=0,carts=0;
  session.methods.cart=async()=>{carts++;return {};};
  const result=await runCommerceAgent(program,order,session,{plan:async({feedback})=>{
    plans++;
    if(plans===1)return {action:'click',reason:'Continue',target};
    if(plans===2){assert.match(feedback.guidance,/改用 cart/);return {action:'cart',reason:'Submit configuration',target};}
    return review;
  }});
  assert.equal(result.status,'prepared');assert.equal(carts,1);assert.equal(plans,3);
});
test('Chinese meaning rejection is corrected by the model on the next attempt',async()=>{
  const session=fixture();let calls=0;
  const plan=createPlanner(async messages=>{
    const input=JSON.parse(messages.at(-1).content);calls++;
    if(calls===1)return {...review,bindings:{...review.bindings,submit:{...target,meaning:'提交订单'}}};
    assert.equal(input.feedback.error.code,'AGENT_PLAN_INVALID');assert.match(input.feedback.error.message,/snake_case/);return review;
  });
  assert.equal((await runCommerceAgent(program,order,session,{plan})).status,'prepared');assert.equal(calls,2);
});
