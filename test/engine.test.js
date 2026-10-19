import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {merchant} from './helpers/merchant.js';
import {extractWorkflow} from '../src/extractor/index.js';
import {VisualAnchors} from '../src/locators/visual.js';
async function setup(t,edit=()=>{}) {
  const fixture=await merchant(),dir=await mkdtemp(join(tmpdir(),'whmcs-engine-'));
  edit(fixture);
  const runtime=await new Runtime(dir).open();
  t.after(async()=>{await runtime.close();await fixture.close();await rm(dir,{recursive:true,force:true});});
  await runtime.configure({site:fixture.site,intent:fixture.intent,headless:true,parameters:{}});
  const version=runtime.repository.create(fixture.workflow).version;
  return {...fixture,runtime,version,ref:{workflowId:fixture.workflow.id,version},dir};
}
test('two genuine browser trials admit an invoice workflow; low credit still creates one invoice',async t=>{
  const f=await setup(t);
  await assert.rejects(()=>f.runtime.execute({...f.ref,mode:'live'}),{code:'UNPUBLISHED'});
  const a=await f.runtime.execute({...f.ref,mode:'trial'}),b=await f.runtime.execute({...f.ref,mode:'trial'});
  assert.equal(a.status,'trial-ready',JSON.stringify(a.error));assert.equal(b.status,'trial-ready',JSON.stringify(b.error));
  assert.equal(f.state.submitted,0);assert.equal(f.state.paid,0);assert.equal(a.submitted,false);
  assert.equal(f.state.accountReads,2);await f.runtime.session.ensure(true);assert.equal(f.state.accountReads,3);
  f.runtime.repository.publish(f.workflow.id,f.version);
  const live=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(live.status,'ordered',JSON.stringify(live.error));assert.equal(live.submitted,true);assert.ok(live.receipt.invoiceId);
  assert.equal(live.aiInferenceCalls,0);assert.equal(f.state.submitted,1);assert.equal(f.state.paid,0);
  const duplicate=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(duplicate.error.category,'DUPLICATE');assert.equal(f.state.submitted,1);
  const candidate=extractWorkflow({id:'extracted',source:live.id,runs:[live],orderMarginMs:5000,idleMs:4000});
  assert.equal(candidate.steps.length,3);assert.equal(candidate.steps[2].timing.order.samplesMs.length,1);
  const metrics=f.runtime.repository.metrics()[f.workflow.id+'@1'];assert.equal(metrics.attempts,2);assert.equal(metrics.successes,1);
});
test('budget gate stops before submit and changed purchase parameters revoke admission',async t=>{
  const f=await setup(t);
  await f.runtime.execute({...f.ref,mode:'trial'});await f.runtime.execute({...f.ref,mode:'trial'});f.runtime.repository.publish(f.workflow.id,1);
  f.runtime.config.intent={...f.intent,budgetMinor:14999};
  await assert.rejects(()=>f.runtime.execute({...f.ref,mode:'live'}),{code:'UNVERIFIED'});
  const run=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(run.error.category,'BUDGET');assert.equal(f.state.submitted,0);
});
test('unknown stock, out of stock and expired sessions are blocked before cart actions',async t=>{
  const f=await setup(t);
  for(const stock of ['unknown','out']) {
    f.state.stock=stock;const run=await f.runtime.execute({...f.ref,mode:'trial'});
    assert.equal(run.error.category,stock==='out'?'STOCK':'STOCK_UNKNOWN');
  }
  f.state.stock='in';f.state.logged=false;
  const run=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(run.error.category,'SESSION');assert.equal(f.state.cart,0);
});
test('unverified submission remains uncertain and cannot be replayed',async t=>{
  const f=await setup(t);
  await f.runtime.execute({...f.ref,mode:'trial'});await f.runtime.execute({...f.ref,mode:'trial'});f.runtime.repository.publish(f.workflow.id,1);
  f.state.uncertain=true;
  const run=await f.runtime.execute({...f.ref,mode:'live'});assert.equal(run.status,'failed');assert.equal(run.error.category,'TIMEOUT');
  assert.equal(f.runtime.kernel.status(f.intent.key).state,'uncertain');assert.equal(f.state.submitted,1);
  const retry=await f.runtime.execute({...f.ref,mode:'live'});assert.equal(retry.error.category,'DUPLICATE');assert.equal(f.state.submitted,1);
});
test('coupon rejection either removes the coupon or stops before submission',async t=>{
  const f=await setup(t,fixture=>{
    const base=fixture.workflow.steps[0].timing;
    fixture.workflow.steps.splice(2,0,{id:'coupon-input',action:'fill',target:{selector:'#promo'},value:'EXPIRED',pre:[{kind:'visible',selector:'#promo'}],post:[{kind:'value',selector:'#promo',equals:'EXPIRED'}],timing:base},
      {id:'coupon',action:'coupon',target:{selector:'#apply'},request:fixture.site.writes[1],pre:[{kind:'visible',selector:'#promo'}],post:[{kind:'visible',selector:'#coupon-ok'}],timing:base});
  });
  f.state.couponInvalid=true;
  const run=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(run.status,'trial-ready',JSON.stringify(run.error));assert.equal(f.state.coupons,1);assert.equal(f.state.removed,1);
  const doc={...f.workflow,id:'stop-coupon',couponPolicy:'stop'};f.runtime.repository.create(doc);f.state.couponInvalid=true;
  const stopped=await f.runtime.execute({workflowId:doc.id,version:1,mode:'trial'});assert.equal(stopped.error.category,'COUPON');assert.equal(f.state.removed,1);assert.equal(f.state.submitted,0);
});
test('visual anchor locates a learned button when its selector changes',async t=>{
  const f=await setup(t);
  await f.runtime.warm();
  await f.runtime.session.goto(f.runtime.session.page,f.site.monitorUrl);
  const locator=f.runtime.session.page.locator('#stock button');
  const anchors=new VisualAnchors(f.runtime.session.page,join(f.dir,'anchors'));
  const anchor=await anchors.capture('#stock button','order-button');
  await locator.evaluate(el=>el.id='new-order-id');
  const resolved=await f.runtime.engine.locators.resolve(f.runtime.session.page,f.workflow.id,{id:'visual-demo',target:{selector:'#missing',anchor}});
  assert.equal(resolved.strategy,'visual');assert.equal(await resolved.locator.textContent(),'Order now');
});
test('automatic balance payment is checked before submit and paid evidence belongs to new invoice',async t=>{
  const f=await setup(t,fixture=>{
    fixture.state.balance=30000;
    fixture.state.invoices.push({invoiceId:'50',product:'probe'});
    fixture.site.history.fields.product='.product';
    fixture.site.payment.probeUrl=fixture.site.origin+'/viewinvoice.php?id=50';
    fixture.workflow.steps.push({id:'pay',action:'pay',target:{selector:'#pay'},request:fixture.site.writes[4],pre:[{kind:'visible',selector:'#invoice'}],post:[{kind:'visible',selector:'#paid'}],timing:fixture.workflow.steps[0].timing});
  });
  const first=await f.runtime.execute({...f.ref,mode:'trial',goal:'pay'}),second=await f.runtime.execute({...f.ref,mode:'trial',goal:'pay'});
  assert.equal(first.status,'trial-ready',JSON.stringify(first.error));assert.equal(second.status,'trial-ready',JSON.stringify(second.error));assert.equal(f.state.paid,0);
  f.runtime.repository.publish(f.workflow.id,1);
  f.state.balance=4200;
  const insufficient=await f.runtime.execute({...f.ref,mode:'live',goal:'pay'});
  assert.equal(insufficient.error.category,'FUNDS');assert.equal(f.state.submitted,0);
  f.state.balance=30000;
  const paid=await f.runtime.execute({...f.ref,mode:'live',goal:'pay'});
  assert.equal(paid.status,'paid',JSON.stringify(paid.error));assert.equal(f.state.submitted,1);assert.equal(f.state.paid,1);assert.notEqual(paid.receipt.invoiceId,'50');
});

test('WHMCS completion page supplies a unique new invoice link',async t=>{
  const f=await setup(t,fixture=>{
    fixture.state.completePage=true;
    fixture.site.reads.push({path:'/cart.php',query:{a:'complete',invoice:'$digits'}});
    fixture.site.receipt={url:{path:'/cart.php',query:{a:'complete',invoice:'$digits'}},ready:[{kind:'visible',selector:'#complete'}],invoiceLink:'#invoice-link'};
    fixture.workflow.steps.at(-1).post=[{kind:'visible',selector:'#complete'}];
  });
  await f.runtime.execute({...f.ref,mode:'trial'});await f.runtime.execute({...f.ref,mode:'trial'});f.runtime.repository.publish(f.workflow.id,1);
  const run=await f.runtime.execute({...f.ref,mode:'live'});assert.equal(run.status,'ordered',JSON.stringify(run.error));assert.match(run.receipt.url,/viewinvoice\.php\?id=101$/);assert.equal(f.state.submitted,1);
});
test('merchant history can read product evidence from individual WHMCS invoices',async t=>{
  const f=await setup(t,fixture=>{
    fixture.state.invoices.push({invoiceId:'50'});
    fixture.site.history.fields={invoiceId:'.invoice-id'};
    fixture.site.history.detail={link:'.invoice-link',complete:[{kind:'visible',selector:'#invoice'}],fields:{invoiceId:'#invoice-id',product:'#product',quantity:'#quantity',currency:'#currency'}};
  });
  const run=await f.runtime.execute({...f.ref,mode:'trial'});assert.equal(run.error.category,'DUPLICATE',JSON.stringify(run.error));assert.equal(f.state.cart,0);
});
