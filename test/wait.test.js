import {test} from 'node:test';
import assert from 'node:assert/strict';
import {perform} from '../src/browser/wait.js';

test('a new action starts its own idle watch while retaining hard timeout bounds',async()=>{
  const progress={last:Date.now()-60000,touch(){this.last=Date.now();},sample:async()=>{}};
  let completed=false;
  await perform(async()=>{await new Promise(resolve=>setTimeout(resolve,20));completed=true;},{absoluteMs:500,idleMs:200},progress);
  assert.equal(completed,true);
  await assert.rejects(()=>perform(()=>new Promise(()=>{}),{absoluteMs:500,idleMs:100},progress),error=>error.code==='TIMEOUT'&&error.details.kind==='idle');
  await assert.rejects(()=>perform(()=>new Promise(()=>{}),{absoluteMs:50,idleMs:500},progress),error=>error.code==='TIMEOUT'&&error.details.kind==='absolute');
});
