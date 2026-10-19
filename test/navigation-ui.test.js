import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
import {browserExecutable} from '../src/browser/session.js';
import {learnedMerchant} from './helpers/learned-merchant.js';

test('workspace pages preserve drafts and history, and paginate workflows and runs',async t=>{
  const f=await learnedMerchant(),dir=await mkdtemp(join(tmpdir(),'workflow-navigation-')),runtime=await new Runtime(dir).open();
  await runtime.configure({site:f.site,intent:f.intent,headless:true});
  for(let i=1;i<=23;i++)runtime.repository.create({...f.workflow,id:'workflow-'+String(i).padStart(2,'0')});
  for(let i=1;i<=23;i++)runtime.repository.record({id:'run-'+i,workflowId:'workflow-01',version:1,mode:'trial',status:'trial-ready',bindings:{},startedAt:new Date().toISOString(),aiInferenceCalls:0});
  const app=await serve({runtime,port:0}),browser=await chromium.launch({headless:true,executablePath:await browserExecutable()});
  t.after(async()=>{await browser.close();await app.close();await f.close();await rm(dir,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+app.server.address().port+'/#/config');
  await page.waitForFunction(()=>document.querySelector('#connection').textContent==='本机已连接');
  const active=async id=>{
    await page.locator('#'+id+':visible').waitFor();
    assert.equal(await page.locator('[data-page]:visible').count(),1);
    assert.equal(await page.locator('[data-page]:visible').getAttribute('id'),id);
    assert.equal(await page.locator('nav a[aria-current="page"]').getAttribute('href'),'#/'+id);
    assert.equal(await page.evaluate(()=>window.scrollY),0);
  };
  await active('config');assert.equal(await page.locator('.hero').isVisible(),false);
  assert.equal(await page.locator('#overview-run-list .preview-row').count(),3);
  assert.equal(await page.locator('#overview-workflow-list .preview-row').count(),3);
  await page.locator('#config-json').fill('{"draft":true}');
  await page.getByRole('link',{name:'登录账户',exact:true}).click();
  await page.locator('#login-username').fill('未保存的账号');
  await page.getByRole('link',{name:'工作流仓库',exact:true}).click();
  await active('workflows');
  await page.goBack();await active('account-login');
  assert.equal(await page.locator('#login-username').inputValue(),'未保存的账号');
  await page.goBack();await active('config');
  assert.equal(await page.locator('#config-json').inputValue(),'{"draft":true}');
  await page.goForward();await active('account-login');
  await page.goForward();await active('workflows');
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#workflow-rows tr').length===10);
  await active('workflows');assert.match(await page.title(),/工作流仓库/);
  assert.equal(await page.locator('#workflow-prev').isDisabled(),true);
  await page.locator('#workflow-next').click();
  assert.match(await page.locator('#workflow-page').textContent(),/第 2 \/ 3 页 · 共 23 条/);
  assert.match(await page.locator('#workflow-rows tr').first().textContent(),/workflow-11/);
  await page.waitForResponse(r=>r.url().endsWith('/api/status')&&r.ok());
  assert.match(await page.locator('#workflow-page').textContent(),/第 2 \/ 3 页/);
  await page.locator('#workflow-next').click();
  assert.equal(await page.locator('#workflow-rows tr').count(),3);
  assert.equal(await page.locator('#workflow-next').isDisabled(),true);
  await page.locator('#workflow-prev').click();assert.equal(await page.locator('#workflow-rows tr').count(),10);
  await page.getByRole('link',{name:'执行记录',exact:true}).click();
  await active('runs');assert.equal(await page.locator('.run-row').count(),10);
  assert.equal(await page.locator('#runs-prev').isDisabled(),true);
  await page.locator('#runs-next').click();await page.locator('#runs-next').click();
  assert.equal(await page.locator('.run-row').count(),3);
  assert.equal(await page.locator('#runs-next').isDisabled(),true);
  await page.getByRole('button',{name:'查看步骤',exact:true}).first().click();
  await page.locator('#run-detail[open]').waitFor();
  assert.match(await page.locator('#detail').textContent(),/"id": "run-3"/);
  await page.goBack();await active('workflows');assert.equal(await page.locator('#run-detail').isVisible(),false);
  const names={'overview':'运行概况','account-login':'登录账户','workflows':'工作流仓库','runs':'执行记录','config':'站点与购买配置'};
  const screenshots=resolve('release/ui');await mkdir(screenshots,{recursive:true});
  for(const width of [1440,768,390,320]){
    await page.setViewportSize({width,height:width===1440?1100:844});
    for(const [id,name] of Object.entries(names)){
      await page.getByRole('link',{name,exact:true}).click();await active(id);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),id+' / '+width);
      if(width===1440||width===390)await page.screenshot({path:join(screenshots,'pages-'+id+'-'+(width===1440?'desktop':'mobile')+'.png'),fullPage:true,animations:'disabled'});
    }
  }
  assert.deepEqual(errors,[]);assert.equal(f.state.submissions,0);
});
