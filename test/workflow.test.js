import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {WorkflowRepository} from '../src/workflow/repository.js';
import {validateWorkflow,timing,bind} from '../src/workflow/schema.js';
import {until} from '../src/browser/wait.js';
import {extractWorkflow} from '../src/extractor/index.js';
function fixture() {return {schema:1,id:'w',provenance:{kind:'site-recording',source:'recording'},steps:[{id:'submit',action:'submit',target:{selector:'#submit'},request:{path:'/cart.php',method:'POST'},pre:[{kind:'visible',selector:'#checkout'}],post:[{kind:'url',includes:'viewinvoice.php'}],timing:{order:{samplesMs:[19000,21000],marginMs:45000,idleMs:40000}}}]};}
test('successful maximum plus margin permits a 21-second page; idle and absolute limits differ',async()=>{
  assert.deepEqual(timing(fixture().steps[0].timing),{absoluteMs:66000,idleMs:40000});
  assert.throws(()=>timing({order:{samplesMs:[],marginMs:5,idleMs:5}}),{code:'MEASUREMENTS'});
  let now=0;const clock={now:()=>now,pause:async ms=>{now+=ms;}};
  await until(()=>now>=21000,{absoluteMs:66000,idleMs:40000},{last:0,sample:async()=>{}},clock);assert.equal(now,21000);
  now=0;await assert.rejects(()=>until(()=>false,{absoluteMs:500,idleMs:100},{last:0,sample:async()=>{}},clock),e=>e.details.kind==='idle');
  now=0;const progress={last:0,sample:async()=>{progress.last=now;}};
  await assert.rejects(()=>until(()=>false,{absoluteMs:500,idleMs:100},progress,clock),e=>e.details.kind==='absolute');
});
test('learned provenance, complete checks and all parameters are required',()=>{
  validateWorkflow(fixture());assert.throws(()=>validateWorkflow({...fixture(),provenance:null}),{code:'PROVENANCE'});
  const doc=fixture();doc.steps[0].post=[];assert.throws(()=>validateWorkflow(doc),{code:'WORKFLOW'});
  assert.equal(bind('{{intent.quantity}}',{intent:{quantity:2}}),2);assert.throws(()=>bind('{{missing}}',{}),{code:'BINDING'});
});
test('versions, diff, rollback and staleness enforce admission',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=new WorkflowRepository(db);repo.create(fixture());
  assert.throws(()=>repo.publish('w',1),{code:'UNVERIFIED'});
  const record=(id,status,bindings={product:5})=>repo.record({id,workflowId:'w',version:1,mode:'trial',status,bindings});
  record('a','trial-ready');record('b','failed');assert.throws(()=>repo.publish('w',1),{code:'UNVERIFIED'});
  record('c','trial-ready');record('d','trial-ready');repo.publish('w',1);
  assert.throws(()=>repo.admitted('w',1,{product:6}),{code:'UNVERIFIED'});
  const next=fixture();next.steps[0].target.selector='#new-submit';repo.create(next);
  assert.ok(repo.diff('w',1,2).some(c=>c.path==='steps.0.target.selector'));assert.throws(()=>repo.rollback('w',2),{code:'UNVERIFIED'});repo.rollback('w',1);
  record('e','failed');record('f','failed');record('g','failed');assert.equal(repo.get('w',1).state,'stale');
  assert.throws(()=>repo.admitted('w',1,{product:5}),{code:'UNVERIFIED'});
});
test('different trial bindings reset consecutive success',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=new WorkflowRepository(db);repo.create(fixture());
  for(const [id,product] of [['a',5],['b',6]])repo.record({id,workflowId:'w',version:1,mode:'trial',status:'trial-ready',bindings:{product}});
  assert.equal(repo.get('w',1).streak,1);
});
test('failed or unmeasured logs cannot become a workflow',()=>{
  assert.throws(()=>extractWorkflow({id:'w',source:'r',runs:[{status:'failed'}]}),{code:'EXTRACTION'});
  assert.throws(()=>extractWorkflow({id:'w',source:'r',runs:[{status:'ordered',steps:[{id:'submit',status:'verified',recipe:fixture().steps[0]}]}],orderMarginMs:100,idleMs:50}),{code:'MEASUREMENTS'});
});

test('a trial mapping duration cannot be used as a measured checkout duration',()=>{
  assert.throws(()=>extractWorkflow({id:'w',source:'trial',runs:[{status:'trial-ready',steps:[]}],orderMarginMs:100,idleMs:50}),{code:'EXTRACTION'});
});
