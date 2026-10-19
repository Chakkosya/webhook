import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {StockMonitor} from '../src/monitor/index.js';
import {createAdapter} from '../src/adapters/index.js';
import {until} from '../src/browser/wait.js';
import {errorRecord} from '../src/errors.js';
import {learnedMerchant} from './helpers/learned-merchant.js';
async function setup(t) {
  const f=await learnedMerchant({requireLogin:true}),dir=await mkdtemp(join(tmpdir(),'session-login-'));
  let runtime=await new Runtime(dir).open();
  t.after(async()=>{await runtime.close();await f.close();await rm(dir,{recursive:true,force:true});});
  await runtime.configure({site:f.site,intent:f.intent,headless:true});
  runtime.saveCredentials({username:'fixture-user',password:'fixture-secret'});
  runtime.repository.create(f.workflow);
  return {...f,dir,get runtime(){return runtime;},ref:{workflowId:f.workflow.id,version:1},
    restart:async()=>{await runtime.close();runtime=await new Runtime(dir).open();}};
}
test('saved credentials log in and persistent cookies survive a runtime restart',async t=>{
  const f=await setup(t);await f.runtime.warm();assert.equal(f.state.logins,1);
  await f.restart();await f.runtime.warm();assert.equal(f.state.logins,1);
  const run=await f.runtime.execute({...f.ref,mode:'trial'});
  assert.equal(run.status,'trial-ready',JSON.stringify(run.error));assert.equal(run.bindings.accountUsername,'fixture-user');
  assert.equal(JSON.stringify(run).includes('fixture-secret'),false);assert.equal(f.state.submissions,0);
});
test('periodic detection automatically logs in after server-side expiry',async t=>{
  const f=await setup(t);await f.runtime.warm();
  f.state.loggedIn=false;f.runtime.session.keepAlive(1000);
  await until(()=>f.state.logins===2&&f.runtime.session.lastHealth.status==='ready',{absoluteMs:7000,idleMs:7000});
  assert.equal(f.runtime.status().browser.status,'ready');assert.equal(f.state.submissions,0);
  assert.ok(f.runtime.events.some(e=>e.type==='session-expired'));
});
test('monitor login redirects are recovered before double confirmation',async t=>{
  const f=await setup(t);await f.runtime.warm();f.state.loggedIn=false;f.state.protectCatalog=true;
  let triggers=0;const monitor=new StockMonitor({session:f.runtime.session,adapter:createAdapter(f.site),trigger:async()=>triggers++});
  await monitor.tick();assert.equal(f.state.logins,2);assert.equal(triggers,1);assert.equal(f.state.submissions,0);
});
test('preflight merchant-history expiry is recovered before any transaction starts',async t=>{
  const f=await setup(t);await f.runtime.warm();f.state.loggedIn=false;
  const run=await f.runtime.execute({...f.ref,mode:'trial'});
  assert.equal(run.status,'trial-ready',JSON.stringify(run.error));assert.equal(f.state.logins,2);assert.equal(f.state.submissions,0);
});
test('relogin does not replay a submission with an unverified result',async t=>{
  const f=await setup(t);
  for(let i=0;i<2;i++)assert.equal((await f.runtime.execute({...f.ref,mode:'trial'})).status,'trial-ready');
  f.runtime.repository.publish(f.workflow.id,1);f.state.expireOnSubmit=true;
  const run=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(run.status,'failed');assert.equal(run.error.category,'SESSION');assert.equal(f.state.submissions,1);
  assert.equal(f.runtime.kernel.status(f.intent.key).state,'uncertain');
  await f.runtime.checkSession();assert.equal(f.runtime.status().browser.status,'ready');
  assert.equal(f.runtime.kernel.status(f.intent.key).state,'uncertain');
  const retry=await f.runtime.execute({...f.ref,mode:'live'});
  assert.equal(retry.error.category,'DUPLICATE');assert.equal(f.state.submissions,1);
});
test('rejected credentials report the cause without exposing the password',async t=>{
  const f=await setup(t);await f.runtime.warm();
  f.runtime.saveCredentials({username:'fixture-user',password:'private-wrong-password'});f.state.loggedIn=false;
  await assert.rejects(()=>f.runtime.checkSession(),error=>error.code==='SESSION'&&error.cause.code==='LOGIN_REJECTED');
  assert.equal(f.runtime.status().browser.status,'failed');assert.equal(f.state.loginAttempts,2);assert.equal(f.state.submissions,0);
  assert.equal(JSON.stringify(f.runtime.status()).includes('private-wrong-password'),false);
});
test('changing the login account invalidates an earlier real-order admission',async t=>{
  const f=await setup(t);
  for(let i=0;i<2;i++)assert.equal((await f.runtime.execute({...f.ref,mode:'trial'})).status,'trial-ready');
  f.runtime.repository.publish(f.workflow.id,1);
  f.runtime.saveCredentials({username:'another-account',password:'another-password'});
  await assert.rejects(()=>f.runtime.execute({...f.ref,mode:'live'}),{code:'UNVERIFIED'});
  assert.equal(f.runtime.credentials.needsLogin(f.site.origin,f.site.account),true);assert.equal(f.state.submissions,0);
});
test('browser fill failures redact passwords from the complete error chain and events',async t=>{
  const f=await setup(t);await f.runtime.warm();
  const page=f.runtime.session.page,original=page.locator.bind(page);
  page.locator=selector=>{const locator=original(selector);if(selector==='#password')locator.fill=async()=>{throw Object.assign(new Error('locator.fill("fixture-secret") failed'),{details:{timeoutMs:2500,note:'fixture-secret'}});};return locator;};
  try{await f.runtime.session.login();assert.fail('login should fail');}
  catch(error){assert.equal(error.code,'SESSION');assert.equal(JSON.stringify(errorRecord(error)).includes('fixture-secret'),false);assert.equal(error.cause.details.timeoutMs,2500);}
  assert.equal(JSON.stringify(f.runtime.events).includes('fixture-secret'),false);
});
