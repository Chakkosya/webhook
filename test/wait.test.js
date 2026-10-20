import {BrowserSession} from '../src/browser/session.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {perform,until} from '../src/browser/wait.js';

test('a new action starts its own idle watch while retaining hard timeout bounds',async()=>{
  const progress={last:Date.now()-60000,touch(){this.last=Date.now();},sample:async()=>{}};
  let completed=false;
  await perform(async()=>{await new Promise(resolve=>setTimeout(resolve,20));completed=true;},{absoluteMs:500,idleMs:200},progress);
  assert.equal(completed,true);
  await assert.rejects(()=>perform(()=>new Promise(()=>{}),{absoluteMs:500,idleMs:100},progress),error=>error.code==='TIMEOUT'&&error.details.kind==='idle');
  await assert.rejects(()=>perform(()=>new Promise(()=>{}),{absoluteMs:50,idleMs:500},progress),error=>error.code==='TIMEOUT'&&error.details.kind==='absolute');
});

test('pending browser checks and DOM probes cannot block idle or absolute deadlines',{timeout:2000},async()=>{
  let now=0;
  const progress={last:0,sample:()=>new Promise(()=>{})},clock={now:()=>now,pause:async ms=>{now+=ms;}};
  await assert.rejects(()=>until(()=>new Promise(()=>{}),{absoluteMs:500,idleMs:100},progress,clock),error=>error.code==='TIMEOUT'&&error.details.kind==='idle');
  assert.equal(now,100);
  now=0;progress.last=0;
  const activeClock={now:()=>now,pause:async ms=>{now+=ms;progress.last=now;}};
  await assert.rejects(()=>until(()=>new Promise(()=>{}),{absoluteMs:500,idleMs:100},progress,activeClock),error=>error.code==='TIMEOUT'&&error.details.kind==='absolute');
  assert.equal(now,500);
});

test('cancelling a timed out action does not wait for a blocked browser command',{timeout:2000},async()=>{
  const progress={last:Date.now(),touch(){this.last=Date.now();},sample:async()=>{},cdp:{send:()=>new Promise(()=>{})}};
  await assert.rejects(()=>perform(()=>new Promise(()=>{}),{absoluteMs:50,idleMs:500},progress),{code:'TIMEOUT'});
});

test('navigation cancellation returns even when the page execution context is blocked',{timeout:2000},async()=>{
  const page={goto:()=>new Promise(()=>{}),evaluate:()=>new Promise(()=>{})};
  const progress={last:Date.now(),touch(){this.last=Date.now();},sample:()=>new Promise(()=>{}),cdp:{send:()=>new Promise(()=>{})}};
  const session=new BrowserSession({site:{},kernel:null,dataDir:'.'});
  session.page=page;session.progress=progress;session.gate={lastError:null};
  await assert.rejects(()=>session.goto(page,'https://fixture.example','order',{absoluteMs:50,idleMs:500}),{code:'TIMEOUT'});
});
