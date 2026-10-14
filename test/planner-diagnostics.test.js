import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTarget} from '../automation/agent/model.js';
import {createPlanner,validateStep} from '../automation/agent/planner.js';
import {createAssistedPlanner} from '../automation/agent/local-planner.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {bindKnownProduct} from '../automation/agent/product-binding.js';
import {recoveryContext} from '../automation/agent/recovery.js';
import {diagnosticAIInput,diagnosticError} from '../lib/order-execution-log.js';

const target=(meaning='continue_to_cart',ref='e0',confidence=0.95)=>({meaning,ref,confidence});
const observation={observationId:'configuration',url:'https://shop.test/configure',elements:[
  {ref:'e0',tag:'button',role:'button',type:'submit',text:'Continue',regionRef:'e2'},
  {ref:'e1',tag:'h1',role:'heading',text:'Product A',regionRef:'e2'}
]};
const input={order:{url:observation.url,product:'Product A',quantity:1,executionMode:'prepare'},workflow:{version:2,requirements:[]},observation,history:[],context:{}};
const step=(meaning='continue_to_cart')=>({action:'cart',reason:'Continue the selected product',target:target(meaning)});
function rejected(fn){
  try{fn();}catch(error){return error;}
  assert.fail('Expected the invalid target to be rejected');
}
function assertDiagnostic(error,{slot,actual,code='AGENT_PLAN_INVALID'}){
  assert.equal(error.code,code);assert.equal(error.slot,slot);assert.deepEqual(error.actual,actual);
  assert.ok(error.message.includes(slot));
  for(const value of Object.values(actual))assert.ok(error.message.includes(JSON.stringify(value)),String(value));
  return true;
}

test('continue_to_cart and continue_configuration remain valid outer targets',async()=>{
  for(const meaning of ['continue_to_cart','continue_configuration']){
    const value=step(meaning);
    assert.deepEqual(validateTarget(value.target),value.target);
    assert.deepEqual(validateStep(value),value);
    const planned=await createPlanner(async()=>value)(input);
    assert.deepEqual(planned.target,value.target);
    assert.equal(planned.bindings.product.ref,'e1');
  }
});

test('invalid product meaning reports bindings.product while the outer target is valid',()=>{
  for(const meaning of ['continue_to_cart','continue_configuration']){
    const actual=target('  Product A  ',' e1 ');
    const error=rejected(()=>validateStep({...step(meaning),bindings:{product:actual}}));
    assertDiagnostic(error,{slot:'bindings.product',actual});
  }
});

test('configuration and payment targets identify their exact slots',()=>{
  const actual=target('invalid meaning','e1');
  for(const [slot,patch] of [
    ['configuration[0].target',{configuration:[{name:'RAM',target:actual}]}],
    ['paymentMethod.target',{paymentMethod:{target:actual,value:'balance'}}]
  ])assertDiagnostic(rejected(()=>validateStep({...step(),...patch})),{slot,actual});
  assertDiagnostic(rejected(()=>validateStep({...step(),target:actual})),{slot:'target',actual});
});

test('diagnostic actual values preserve received types and truncate strings to 200 characters',()=>{
  const received={meaning:'Bad '.repeat(70),ref:'not-a-ref'.repeat(30),confidence:'0.95'.repeat(60)};
  const actual=Object.fromEntries(Object.entries(received).map(([key,value])=>[key,value.slice(0,200)]));
  const error=rejected(()=>validateTarget(received,'bindings.product'));
  assertDiagnostic(error,{slot:'bindings.product',actual});
  for(const value of Object.values(received))assert.ok(!error.message.includes(value));
  const malformed={meaning:42,ref:0,confidence:'0.95'};
  assertDiagnostic(rejected(()=>validateTarget(malformed,'target')),{slot:'target',actual:malformed});
});

test('missing target fields remain explicit in serializable diagnostics',()=>{
  const received={meaning:'product',confidence:0.95};
  const actual={meaning:'product',ref:null,confidence:0.95};
  const error=rejected(()=>validateTarget(received,'bindings.product'));
  assertDiagnostic(error,{slot:'bindings.product',actual});
  assert.deepEqual(JSON.parse(JSON.stringify(error)).actual,actual);
});

test('low confidence includes the same slot and received values',()=>{
  const actual=target(' product ',' e1 ',0.4);
  assertDiagnostic(rejected(()=>validateTarget(actual,'bindings.product')),{slot:'bindings.product',actual,code:'AGENT_LOW_CONFIDENCE'});
});

test('known product binding fills missing evidence and preserves supplied model fields for validation',()=>{
  assert.deepEqual(bindKnownProduct(step(),observation,input.order).bindings.product,target('product','e1',1));
  const supplied=target('  Product A  ','e1');
  const value={...step(),bindings:{product:supplied}};
  assert.deepEqual(bindKnownProduct(value,observation,input.order).bindings.product,supplied);
  assertDiagnostic(rejected(()=>validateStep(bindKnownProduct(value,observation,input.order))),{slot:'bindings.product',actual:supplied});
  assert.equal(bindKnownProduct({...step(),bindings:{product:null}},observation,input.order).bindings.product,null);
});

test('AI and assisted planners reject invalid supplied product fields instead of masking them',async()=>{
  for(const meaning of ['continue_to_cart','continue_configuration']){
    for(const product of [target('Product A','e1'),null]){
      const actual=product||{meaning:null,ref:null,confidence:null},value={...step(meaning),bindings:{product}};
      for(const make of [()=>createPlanner(async()=>value),()=>createAssistedPlanner(async()=>value)]){
        await assert.rejects(make()(input),error=>{
          assertDiagnostic(error,{slot:'bindings.product',actual});
          assert.deepEqual(error.rejectedPlan,value);
          return true;
        });
      }
    }
  }
});

test('recovery feedback and logged errors retain slot and actual values through the AI boundary',async()=>{
  const actual=target('  Product A  ',' e1 '),invalid={...step(),bindings:{product:actual}};
  const error=rejected(()=>validateStep(invalid));error.rejectedPlan=invalid;
  const recovered=await recoveryContext(error,{methods:{observe:async()=>observation}},[]);
  assert.equal(recovered.feedback.error.slot,'bindings.product');assert.deepEqual(recovered.feedback.error.actual,actual);
  assert.equal(recovered.feedback.error.message,error.message);
  const logged=diagnosticError(error);
  assert.equal(logged.slot,'bindings.product');assert.deepEqual(logged.actual,actual);
  let messages;
  await createPlanner(async value=>{messages=value;return step();})({...input,feedback:recovered.feedback});
  const payload=JSON.parse(messages.at(-1).content);
  assert.equal(payload.feedback.error.slot,'bindings.product');assert.deepEqual(payload.feedback.error.actual,actual);
  assert.equal(payload.feedback.error.message,error.message);
  assert.deepEqual(payload.feedback.previousPlan,invalid);
  assert.deepEqual(diagnosticAIInput(messages).feedback.error,payload.feedback.error);
});

test('recovery feedback retains every truncated actual value when the diagnostic message exceeds 600 characters',async()=>{
  const received={meaning:'M'.repeat(240),ref:'R'.repeat(240),confidence:'C'.repeat(240)};
  const actual=Object.fromEntries(Object.entries(received).map(([key,value])=>[key,value.slice(0,200)]));
  const error=rejected(()=>validateTarget(received,'bindings.product'));
  assert.ok(error.message.length>600);
  const recovered=await recoveryContext(error,{methods:{observe:async()=>observation}},[]);
  let payload;
  await createPlanner(async messages=>{payload=JSON.parse(messages.at(-1).content);return step();})({...input,feedback:recovered.feedback});
  assert.equal(payload.feedback.error.slot,'bindings.product');assert.deepEqual(payload.feedback.error.actual,actual);
});
test('timeout text in target diagnostics preserves the deterministic repair budget',async()=>{
  for(const trigger of ['manual','restock']){
    for(const [meaning,confidence,code] of [['Timeout',0.95,'AGENT_PLAN_INVALID'],['timeout',0.4,'AGENT_LOW_CONFIDENCE']]){
      const actual=target(meaning,'e0',confidence),events=[];
      let plans=0;
      const session={methods:{observe:async()=>observation,resolveSemantic:async()=>assert.fail('Invalid plans must not resolve elements')}};
      const plan=createPlanner(async()=>{plans++;return {...step(),target:actual};});
      await assert.rejects(runCommerceAgent({workflow:input.workflow},input.order,session,{
        trigger,plan,onEvent:(action,data)=>events.push({action,...data})
      }),error=>assertDiagnostic(error,{slot:'target',actual,code}));
      assert.equal(plans,3);
      const repairs=events.filter(event=>event.action==='重新观察并修复');
      assert.deepEqual(repairs.map(event=>event.kind),['deterministic','deterministic']);
      assert.deepEqual(repairs.map(event=>event.maxAttempts),[2,2]);
    }
  }
});

test('invalid bindings containers remain intact and are rejected before product injection',async()=>{
  for(const bindings of [false,0,'',null]){
    const value={...step(),bindings};
    assert.equal(bindKnownProduct(value,observation,input.order).bindings,bindings);
    for(const make of [()=>createPlanner(async()=>value),()=>createAssistedPlanner(async()=>value)]){
      await assert.rejects(make()(input),error=>{
        assert.equal(error.code,'AGENT_PLAN_INVALID');assert.deepEqual(error.rejectedPlan,value);
        return true;
      });
    }
  }
});