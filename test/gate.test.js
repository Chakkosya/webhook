import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RequestGate} from '../src/browser/gate.js';
const site={origin:'https://shop.example',reads:[{path:'/cart.php',query:{gid:'5'}}],writes:[{method:'GET',path:'/cart.php',query:{a:'add'},allowQuery:['pid']},{method:'POST',path:'/cart.php',query:{a:'checkout'}}]};
async function dispatch(gate,{url,method='GET',body='',resourceType='document'}) {
  let continued=0,aborted=0;
  await gate.route({request:()=>({url:()=>url,method:()=>method,postData:()=>body,resourceType:()=>resourceType}),continue:async()=>continued++,abort:async()=>aborted++});
  return {continued,aborted};
}
test('read URLs pass; action GET, unknown POST and changed bodies are blocked',async()=>{
  const gate=new RequestGate(site,{consume:()=>{throw Object.assign(new Error('tampered'),{code:'REQUEST_MISMATCH'});}});
  assert.equal((await dispatch(gate,{url:site.origin+'/cart.php?gid=5'})).continued,1);
  for(const req of [{url:site.origin+'/cart.php?a=add&pid=5'},{url:site.origin+'/cart.php?a=checkout',method:'POST'},{url:site.origin+'/unknown',method:'POST'},{url:site.origin+'/cart.php?gid=5&a=add'}])
    assert.equal((await dispatch(gate,req)).aborted,1);
  gate.arm('permit',{url:site.origin+'/cart.php?a=checkout',method:'POST',body:'pid=5'});
  assert.equal((await dispatch(gate,{url:site.origin+'/cart.php?a=checkout',method:'POST',body:'pid=6'})).aborted,1);
  assert.equal(gate.lastError.code,'REQUEST_MISMATCH');
});
test('permit is consumed before dispatch and cannot pass a second write',async()=>{
  let consumed=false;const gate=new RequestGate(site,{consume:()=>{assert.equal(gate.sent,0);consumed=true;}});
  const request={url:site.origin+'/cart.php?a=checkout',method:'POST',body:'pid=5'};gate.arm('once',request);
  assert.equal((await dispatch(gate,request)).continued,1);assert.equal(consumed,true);
  assert.equal((await dispatch(gate,request)).aborted,1);assert.equal(gate.sent,1);
});
