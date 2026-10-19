import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {inspectPage} from '../src/browser/inspect.js';
import {learnedMerchant} from './helpers/learned-merchant.js';
async function setup(t) {
  const fixture=await learnedMerchant(),dir=await mkdtemp(join(tmpdir(),'learned-site-')),runtime=await new Runtime(dir).open();
  t.after(async()=>{await runtime.close();await fixture.close();await rm(dir,{recursive:true,force:true});});
  await runtime.configure({site:fixture.site,intent:fixture.intent,headless:true});
  runtime.repository.create(fixture.workflow);
  return {...fixture,runtime,ref:{workflowId:fixture.workflow.id,version:1}};
}
test('a learned non-WHMCS store passes two trials and confirms an alphanumeric order reference',async t=>{
  const f=await setup(t);
  for(let i=0;i<2;i++){const run=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(run.status,'trial-ready',JSON.stringify(run.error));}
  const inspected=await inspectPage(f.runtime.session.page);assert.equal(inspected.elements.find(e=>e.selector==='#checkout > form:nth-of-type(1)'||e.request?.path==='/checkout/place').request.method,'POST');
  assert.equal(f.state.submissions,0);f.runtime.repository.publish(f.workflow.id,1);
  const run=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(run.status,'ordered',JSON.stringify(run.error));assert.equal(run.receipt.invoiceId,'ORDER-A1');assert.equal(f.state.submissions,1);assert.equal(run.aiInferenceCalls,0);
  const duplicate=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(duplicate.error.category,'DUPLICATE');assert.equal(f.state.submissions,1);
});
test('learned stock patterns retain strong-signal checks and budget gates',async t=>{
  const f=await setup(t);f.state.stock=0;
  const noStock=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(noStock.error.category,'STOCK');assert.equal(f.state.submissions,0);
  f.state.stock=2;f.runtime.config.intent.budgetMinor=1249;
  const overBudget=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(overBudget.error.category,'BUDGET');assert.equal(f.state.submissions,0);
});
