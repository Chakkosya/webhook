import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTarget,agentError} from '../automation/agent/model.js';
import {resolveSemanticTarget} from '../automation/browser/locator.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
const target={meaning:'buy',ref:'e0',confidence:0.95};
const observation={observationId:'now',url:'https://shop.example',elements:[{ref:'e0',text:'buy',visible:true}]};
const order={url:observation.url,quantity:1,executionMode:'prepare'};
const program={workflow:{requirements:[]}};
const review={action:'review',reason:'review',bindings:Object.fromEntries(['submit','product','quantity','total','currency'].map(name=>[name,{...target,meaning:name}]))};
function fixture(){
  const session={methods:{observe:async()=>observation,resolveSemantic:async()=>({selector:'#x',strategy:'css'}),submit:async()=>session.receipt={status:'prepared'}}};return session;
}
test('meaning and ref trim strings without converting malformed values',()=>{
  assert.deepEqual(validateTarget({...target,meaning:' buy ',ref:' e0 '}),target);
  for(const patch of [{meaning:42},{ref:0},{ref:'E0'},{ref:'e 0'},{confidence:'0.95'}])assert.throws(()=>validateTarget({...target,...patch}),{code:'AGENT_PLAN_INVALID'});
});
test('hanging candidate probes time out and advance to the next strategy',async()=>{
  const timeouts=[];
  const page={locator:selector=>({count:async options=>{timeouts.push(options.timeout);return 1;},getAttribute:()=>selector.startsWith('xpath=')?Promise.resolve('now:e0'):new Promise(()=>{}),isVisible:async options=>{timeouts.push(options.timeout);return true;}})};
  const found=await resolveSemanticTarget(page,observation,target,{probeTimeoutMs:15});
  assert.equal(found.strategy,'xpath');assert.deepEqual(found.attempts.map(item=>item.outcome),['timeout','matched']);assert.ok(timeouts.every(value=>value===15));
});
test('hanging runtime count is bounded and falls back to XPath',async()=>{
  const page={locator:selector=>({count:()=>selector.startsWith('xpath=')?Promise.resolve(1):new Promise(()=>{}),getAttribute:async()=> 'now:e0',isVisible:async()=>true})};
  const found=await resolveSemanticTarget(page,observation,target,{probeTimeoutMs:15});
  assert.equal(found.strategy,'xpath');assert.deepEqual(found.attempts.map(item=>item.outcome),['timeout','matched']);
});
test('executor forwards normal and restock probe timeouts to independent bindings',async()=>{
  for(const [trigger,expected] of [['manual',3000],['restock',10000]]){
    const session=fixture(),timeouts=[];
    session.methods.resolveSemantic=async(_target,options)=>{timeouts.push(options.probeTimeoutMs);return {selector:'#x'};};
    await runCommerceAgent(program,order,session,{trigger,plan:async()=>review});
    assert.deepEqual(timeouts,Array(5).fill(expected));
  }
});
test('stale runtime selector requests a fresh observation before fallback',async()=>{
  await assert.rejects(resolveSemanticTarget({locator:()=>({count:async()=>0})},observation,target),{code:'AGENT_OBSERVATION_STALE'});
});
test('review bindings resolve concurrently and report the failing field',async()=>{
  const session=fixture(),started=[];let release;
  const gate=new Promise(resolve=>release=resolve);
  session.methods.resolveSemantic=async value=>{started.push(value.meaning);if(started.length===5)release();await gate;if(value.meaning==='total')throw agentError('AGENT_ELEMENT_MISSING','missing');return {selector:'#x'};};
  await assert.rejects(runCommerceAgent(program,order,session,{autoRepair:false,plan:async()=>review,timeoutMs:500}),error=>error.binding==='total'&&error.message.includes('total'));
  assert.equal(started.length,5);assert.equal(session.receipt,undefined);
});
test('stale observations refresh without planning or spending a repair',async()=>{
  const session=fixture();let checks=0,plans=0,refreshes=0;
  session.methods.isObservationCurrent=async()=>++checks>1;
  session.methods.observe=async()=>{refreshes++;return observation;};
  session.methods.resolveSemantic=async()=>{if(refreshes===2)throw agentError('AGENT_OBSERVATION_STALE','stale');return {selector:'#x'};};
  const events=[];
  const result=await runCommerceAgent(program,order,session,{autoRepair:false,plan:async()=>{plans++;return review;},onEvent:(action,data)=>events.push({action,...data})});
  assert.equal(result.status,'prepared');assert.equal(plans,2);assert.equal(refreshes,3);assert.equal(events.filter(event=>event.action==='重新观察并修复').length,0);
});
test('deterministic and transient repairs have independent task budgets',async()=>{
  for(const trigger of ['manual','restock']){
    const session=fixture(),events=[];let plans=0;
    const transientLimit=trigger==='restock'?5:3;
    await assert.rejects(runCommerceAgent(program,order,session,{trigger,plan:async()=>{plans++;throw agentError(plans<=2?'AGENT_PLAN_INVALID':'AGENT_ELEMENT_MISSING','retry');},onEvent:(action,data)=>events.push({action,...data})}),{code:'AGENT_ELEMENT_MISSING'});
    assert.equal(plans,2+transientLimit+1);
    assert.deepEqual(events.filter(event=>event.action==='重新观察并修复').map(event=>event.maxAttempts),[2,2,...Array(transientLimit).fill(transientLimit)]);
  }
});
test('successful progress does not replenish deterministic task repairs',async()=>{
  const session=fixture();let plans=0,observed=0;
  session.methods.observe=async()=>({...observation,text:String(++observed)});
  session.methods.click=async()=>{};
  await assert.rejects(runCommerceAgent(program,order,session,{plan:async()=>{plans++;if(plans%2)throw agentError('AGENT_PLAN_INVALID','invalid');return {action:'click',reason:'next',target};}}),{code:'AGENT_PLAN_INVALID'});
  assert.equal(plans,5);
});
