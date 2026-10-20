import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {buildMonitor} from '../src/ai/monitor-builder.js';
import {ApiAssistant} from '../src/ai/client.js';
import {ObservationBrowser,monitorUrl} from '../src/browser/observation.js';
import {evaluateRule,validateRule} from '../src/monitor/rules.js';
import {monitorSite,idle} from './helpers/monitor-site.js';

async function setup(t) {
  const site=await monitorSite(),dir=await mkdtemp(join(tmpdir(),'smart-monitor-')),runtime=await new Runtime(dir).open();
  const cleanup=[];
  t.after(async()=>{for(const close of cleanup)await close();if(runtime.kernel.db.isOpen)await runtime.close();await site.close();await rm(dir,{recursive:true,force:true});});
  const api=runtime.apis.save({name:'Local fixture',endpoint:site.origin+'/v1',model:'fixture-model',key:'fixture-private-api-key'});
  return {site,dir,runtime,cleanup,assistant:new ApiAssistant(runtime.apis.resolve(api.id))};
}
test('natural language creates a verified stock monitor, double confirmation notifies once, and checks use no AI',async t=>{
  const {site,runtime,assistant}=await setup(t);
  const monitor=await buildMonitor(runtime,{url:site.origin,kind:'stock',requirement:'提醒服务器补货',intervalSeconds:10,webhook:site.origin+'/notify'},assistant);
  assert.equal(monitor.verifiedChecks,2);assert.equal(monitor.preview.status,'clear');assert.equal(site.state.aiCalls,1);
  assert.equal(JSON.stringify(site.state.aiRequests).includes('fixture-private-api-key'),false);
  await runtime.pageMonitors.start(monitor.id);await idle(runtime.pageMonitors,monitor.id);
  site.state.quantity=3;
  const before=site.state.reads,result=await runtime.pageMonitors.check(monitor.id);
  assert.equal(result.status,'matched');assert.equal(result.confirmed,true);assert.equal(site.state.reads-before,2);
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,1);
  assert.equal(site.state.notifications.length,1);assert.equal(site.state.notifications[0].value,'3 Available');
  assert.equal(JSON.stringify(site.state.aiRequests).includes('/notify'),false);
  await runtime.pageMonitors.check(monitor.id);
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,1);
  site.state.abnormal=true;
  assert.equal((await runtime.pageMonitors.check(monitor.id)).status,'unknown');
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,1);
  assert.equal(site.state.aiCalls,1);assert.equal(site.state.writes,0);
  assert.equal(runtime.pageMonitors.get(monitor.id).aiInferenceCalls,0);
  await runtime.pageMonitors.stop(monitor.id);
  assert.equal(runtime.pageMonitors.list()[0].running,false);
});

test('fabricated selectors and price text cannot be accepted as stock evidence',async t=>{
  const {site,runtime,assistant}=await setup(t);
  site.state.invented=true;
  await assert.rejects(()=>buildMonitor(runtime,{url:site.origin,kind:'stock',requirement:'提醒补货'},assistant),{code:'MONITOR_RULE'});
  site.state.invented=false;site.state.priceAsStock=true;
  await assert.rejects(()=>buildMonitor(runtime,{url:site.origin,kind:'stock',requirement:'提醒补货'},assistant),{code:'MONITOR_EVIDENCE'});
  assert.equal(runtime.pageMonitors.list().length,0);
  assert.equal(site.state.writes,0);
});
test('a change monitor establishes a baseline and requires the new value twice',async t=>{
  const {site,runtime,assistant}=await setup(t);
  const monitor=await buildMonitor(runtime,{url:site.origin,kind:'change',requirement:'内容更新时提醒'},assistant);
  await runtime.pageMonitors.start(monitor.id);await idle(runtime.pageMonitors,monitor.id);
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,0);
  site.state.content='New announcement';
  assert.equal((await runtime.pageMonitors.check(monitor.id)).confirmed,true);
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,1);
  assert.equal(runtime.pageMonitors.get(monitor.id).baseline,'New announcement');
  assert.equal((await runtime.pageMonitors.check(monitor.id)).status,'clear');
  assert.equal(site.state.aiCalls,1);
});
test('stock forms require a shared form, product scope, fields and a usable button',async t=>{
  const {site,dir,cleanup}=await setup(t),browser=await new ObservationBrowser({dataDir:dir,id:'form-rules'}).open();
  cleanup.push(()=>browser.close());
  await browser.read(site.origin);
  const rule={type:'stock-form',identity:{selector:'#product-name',text:'Fixture server'},scope:'#product-card',fields:['#product-id'],submit:'#buy'};
  validateRule(rule,'stock',await browser.snapshot());
  assert.equal((await evaluateRule(browser.page,rule)).status,'matched');
  await browser.page.locator('#buy').evaluate(element=>element.disabled=true);
  assert.equal((await evaluateRule(browser.page,rule)).status,'unknown');
  await browser.page.locator('#buy').evaluate(element=>element.disabled=false);
  await browser.page.locator('#product-id').evaluate(element=>document.body.append(element));
  assert.equal((await evaluateRule(browser.page,rule)).status,'unknown');
  assert.throws(()=>monitorUrl(site.origin+'/cart.php?a=checkout'),{code:'MONITOR_URL'});
  assert.equal(site.state.writes,0);
});
test('API secrets survive a runtime restart without plaintext in the data file',async t=>{
  const {runtime,dir}=await setup(t);
  const bytes=await readFile(join(dir,'runtime.sqlite'));
  assert.equal(bytes.includes(Buffer.from('fixture-private-api-key')),false);
  const same=await new Runtime(dir).open();
  try {assert.equal(same.apis.resolve().key,'fixture-private-api-key');} finally {await same.close();}
});

test('enabled monitors resume after a service restart without repeating an existing alert',async t=>{
  const {runtime,dir,site,assistant,cleanup}=await setup(t);
  site.state.quantity=3;
  const monitor=await buildMonitor(runtime,{url:site.origin,kind:'stock',requirement:'补货提醒'},assistant);
  await runtime.pageMonitors.start(monitor.id);await idle(runtime.pageMonitors,monitor.id);
  assert.equal(runtime.pageMonitors.get(monitor.id).notifications.length,1);
  await runtime.close();
  const reopened=await new Runtime(dir).open();cleanup.push(()=>reopened.close());
  const entry=reopened.pageMonitors.running.get(monitor.id);
  assert.ok(entry);await entry.opening;await idle(reopened.pageMonitors,monitor.id);
  assert.equal(reopened.pageMonitors.get(monitor.id).enabled,true);
  assert.equal(reopened.pageMonitors.get(monitor.id).notifications.length,1);
  assert.equal(site.state.aiCalls,1);
});

test('price and keyword monitors evaluate their saved conditions without further AI calls',async t=>{
  const {runtime,site,assistant}=await setup(t);
  const price=await buildMonitor(runtime,{url:site.origin,kind:'price',requirement:'价格低于 100 时提醒'},assistant);
  const keyword=await buildMonitor(runtime,{url:site.origin,kind:'text',requirement:'出现 Available 时提醒'},assistant);
  assert.equal(price.preview.status,'clear');assert.equal(keyword.preview.status,'clear');
  await runtime.pageMonitors.start(price.id);await idle(runtime.pageMonitors,price.id);
  await runtime.pageMonitors.start(keyword.id);await idle(runtime.pageMonitors,keyword.id);
  site.state.price=90;site.state.content='Available now';
  assert.equal((await runtime.pageMonitors.check(price.id)).confirmed,true);
  assert.equal((await runtime.pageMonitors.check(keyword.id)).confirmed,true);
  assert.equal(runtime.pageMonitors.get(price.id).notificationCount,1);
  assert.equal(runtime.pageMonitors.get(keyword.id).notificationCount,1);
  assert.equal(site.state.aiCalls,2);assert.equal(site.state.writes,0);
});
