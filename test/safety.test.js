import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SafetyKernel, assertMoney, verifyPayment} from '../src/safety/kernel.js';

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'whmcs-safety-'));
  const kernel=new SafetyKernel(join(dir,'ledger.sqlite'));
  t.after(()=>{kernel.close();rmSync(dir,{recursive:true,force:true});});
  return {kernel,file:join(dir,'ledger.sqlite')};
}
const intent={key:'purchase-1',account:'main',product:'5',quantity:1,currency:'USD',budgetMinor:15000,paymentMethod:'credit'};
const request={url:'https://shop.example/cart.php?a=checkout',method:'POST',body:'token=abc&pid=5&quantity=1'};
const quote={totalMinor:15000,currency:'USD',product:'5',quantity:1,paymentMethod:'credit'};

test('budget and currency are hard gates; invalid money fails closed',()=>{
  assertMoney(quote,intent);
  for(const value of [{...quote,totalMinor:15001},{...quote,currency:'EUR'},{...quote,totalMinor:NaN},{...quote,totalMinor:-1},{...quote,quantity:2},{...quote,product:'6'},{...quote,paymentMethod:'other'}])
    assert.throws(()=>assertMoney(value,intent));
});
test('insufficient credit blocks payment but does not block creating an invoice',()=>{
  assertMoney(quote,intent);
  assert.throws(()=>verifyPayment({...quote,invoiceId:'9',balanceMinor:4200,balanceCurrency:'USD'}, {...intent,invoiceId:'9',totalMinor:15000}),{code:'FUNDS'});
  assert.throws(()=>verifyPayment({...quote,totalMinor:14000,invoiceId:'9',balanceMinor:20000,balanceCurrency:'USD'}, {...intent,invoiceId:'9',totalMinor:15000}),{code:'PAYMENT_MISMATCH'});
  assert.throws(()=>verifyPayment({...quote,invoiceId:'8',balanceMinor:20000,balanceCurrency:'USD'}, {...intent,invoiceId:'9',totalMinor:15000}),{code:'PAYMENT_MISMATCH'});
});
test('a write permit binds its exact request and is consumed once before dispatch',t=>{
  const {kernel}=setup(t);kernel.begin(intent,'run-1',[]);
  const permit=kernel.issue({intentKey:intent.key,runId:'run-1',operation:'submit',mode:'live',request,quote,intent});
  assert.throws(()=>kernel.consume(permit,{...request,body:request.body+'&extra=1'}),{code:'REQUEST_MISMATCH'});
  kernel.consume(permit,request);
  assert.throws(()=>kernel.consume(permit,request),{code:'REPLAY'});
  assert.equal(kernel.status(intent.key).state,'uncertain');
});
test('trial cannot obtain a submit or payment permit',t=>{
  const {kernel}=setup(t);
  for(const operation of ['submit','pay'])
    assert.throws(()=>kernel.issue({operation,mode:'trial',request,quote,intent}),{code:'TRIAL_BLOCKED'});
});
test('uncertain and completed purchases remain blocked across restarts',t=>{
  const {kernel,file}=setup(t);kernel.begin(intent,'run-1',[]);
  const p=kernel.issue({intentKey:intent.key,runId:'run-1',operation:'submit',mode:'live',request,quote,intent});kernel.consume(p,request);
  const second=new SafetyKernel(file);
  assert.throws(()=>second.begin(intent,'run-2',[]),{code:'DUPLICATE'});
  kernel.confirm(intent.key,'run-1',{invoiceId:'9'});
  assert.throws(()=>second.begin(intent,'run-3',[]),{code:'DUPLICATE'});second.close();
});
test('local and merchant checks both reject duplicates, unreadable merchant history stops',t=>{
  const {kernel}=setup(t);
  assert.throws(()=>kernel.begin(intent,'run-1',null),{code:'MERCHANT_HISTORY'});
  assert.throws(()=>kernel.begin(intent,'run-1',[{product:'5',quantity:1,currency:'USD',invoiceId:'7',account:'main'}]),{code:'DUPLICATE'});
  kernel.begin(intent,'run-1',[]);
  assert.throws(()=>kernel.begin(intent,'run-2',[]),{code:'DUPLICATE'});
});
test('failed pre-submit attempts can retry; dispatched writes need manual resolution',t=>{
  const {kernel}=setup(t);kernel.begin(intent,'run-1',[]);kernel.release(intent.key,'run-1');
  kernel.begin(intent,'run-2',[]);const p=kernel.issue({intentKey:intent.key,runId:'run-2',operation:'submit',mode:'live',request,quote,intent});kernel.consume(p,request);
  assert.throws(()=>kernel.release(intent.key,'run-2'),{code:'UNCERTAIN'});
  assert.throws(()=>kernel.resolve(intent.key,{outcome:'not-created',note:''}));
  kernel.resolve(intent.key,{outcome:'not-created',note:'已核对商家账单，无新订单'});
  kernel.begin(intent,'run-3',[]);
});
test('coupon permits cannot be replayed and another run cannot use a reserved intent',t=>{
  const {kernel}=setup(t);kernel.begin(intent,'run-1',[]);
  assert.throws(()=>kernel.issue({intentKey:intent.key,runId:'run-2',operation:'submit',mode:'live',request,quote,intent}),{code:'RUN_MISMATCH'});
  const p=kernel.issue({intentKey:intent.key,runId:'run-1',operation:'coupon',mode:'trial',request,quote,intent});
  kernel.consume(p,request);assert.throws(()=>kernel.consume(p,request),{code:'REPLAY'});
  assert.throws(()=>kernel.issue({intentKey:intent.key,runId:'run-1',operation:'coupon',mode:'trial',request,quote,intent}),{code:'UNCERTAIN'});
  kernel.verified(p,{accepted:false});kernel.release(intent.key,'run-1');
});
test('intent identity cannot change',t=>{
  const {kernel}=setup(t);kernel.begin(intent,'run-1',[]);
  assert.throws(()=>kernel.issue({intentKey:intent.key,runId:'run-1',operation:'submit',mode:'live',request,quote,intent:{...intent,key:'different'}}),{code:'RUN_MISMATCH'});
});

test('merchant duplicate windows compare actual times across timezone offsets',t=>{
  const {kernel}=setup(t);
  const windowed={...intent,historySince:'2026-10-19T00:00:00Z'};
  const row={account:'main',product:'5',quantity:1,currency:'USD',invoiceId:'10',createdAt:'2026-10-19T07:00:00+08:00'};
  kernel.begin(windowed,'run-1',[row]);kernel.release(intent.key,'run-1');
  assert.throws(()=>kernel.begin(windowed,'run-2',[{...row,createdAt:'2026-10-19T09:00:00+08:00'}]),{code:'DUPLICATE'});
});
test('a permit from a closed kernel is unusable after reopening the ledger',t=>{
  const dir=mkdtempSync(join(tmpdir(),'whmcs-restart-')),file=join(dir,'ledger.sqlite'),first=new SafetyKernel(file);
  first.begin(intent,'run-1',[]);
  const permit=first.issue({intentKey:intent.key,runId:'run-1',operation:'submit',mode:'live',request,quote,intent});first.close();
  const second=new SafetyKernel(file);t.after(()=>{second.close();rmSync(dir,{recursive:true,force:true});});
  assert.throws(()=>second.consume(permit,request),{code:'REPLAY'});
  assert.throws(()=>second.begin(intent,'run-2',[]),{code:'DUPLICATE'});
});
