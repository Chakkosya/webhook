import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StockMonitor} from '../src/monitor/index.js';
function setup(sequence) {
  let triggers=0,navigations=0;
  const session={site:{monitorUrl:'https://shop.example/cart.php?gid=5'},monitorPage:{},expired:async()=>false,goto:async()=>{navigations++;},exclusive:async fn=>fn()};
  return {monitor:new StockMonitor({session,adapter:{stock:async()=>({status:sequence.shift()||'unknown'})},trigger:async()=>triggers++}),counts:()=>({triggers,navigations})};
}
test('one positive followed by unknown or out never triggers',async()=>{
  for(const value of ['unknown','out']) {const f=setup(['in',value]);await f.monitor.tick();assert.deepEqual(f.counts(),{triggers:0,navigations:2});}
});
test('two positive browser checks trigger only once',async()=>{
  const f=setup(['in','in','in','in']);await f.monitor.tick();await f.monitor.tick();assert.deepEqual(f.counts(),{triggers:1,navigations:2});
});
test('an abnormal/unknown page never triggers a purchase',async()=>{
  const f=setup(['unknown']);await f.monitor.tick();assert.deepEqual(f.counts(),{triggers:0,navigations:1});
});
