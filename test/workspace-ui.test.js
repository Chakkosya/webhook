import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
import {browserExecutable} from '../src/browser/session.js';
import {monitorSite,idle} from './helpers/monitor-site.js';

test('users add API providers and SS exits, test an HTTP route, and create a monitor without JSON',async()=>{
  const site=await monitorSite(),dir=await mkdtemp(join(tmpdir(),'workspace-ui-')),runtime=await new Runtime(dir).open();
  const proxyReads=[];
  const proxy=createServer(async(req,res)=>{
    if(!req.url.startsWith(site.origin)){res.writeHead(403);res.end();return;}
    proxyReads.push(req.url);
    try{const response=await fetch(req.url);res.writeHead(response.status,{'Content-Type':response.headers.get('Content-Type')});res.end(await response.text());}
    catch{res.writeHead(502);res.end();}
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const app=await serve({runtime,port:0}),browser=await chromium.launch({headless:true,executablePath:await browserExecutable()});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+app.server.address().port);
    await page.waitForFunction(()=>document.querySelector('#connection').textContent==='本机已连接');
    await page.getByRole('link',{name:'添加 API 与出口',exact:true}).click();
    await page.locator('#api-name').fill('常用 API');await page.locator('#api-endpoint').fill(site.origin+'/v1');await page.locator('#api-key').fill('fixture-private-ui-key');await page.locator('#api-model').fill('fixture-model');
    await page.locator('#save-api').click();
    await page.waitForFunction(()=>document.querySelectorAll('#api-list .connection-item').length===1);
    assert.equal(await page.locator('#api-key').inputValue(),'');
    await page.locator('#api-list').getByRole('button',{name:'测试连接',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#api-feedback').textContent.includes('连接成功'));
    await page.locator('#api-name').fill('备用 API');await page.locator('#api-endpoint').fill(site.origin+'/v1');await page.locator('#api-key').fill('fixture-backup-ui-key');await page.locator('#api-model').fill('fixture-model');
    await page.locator('#save-api').click();await page.waitForFunction(()=>document.querySelectorAll('#api-list .connection-item').length===2);
    await page.locator('#proxy-tab').click();
    await page.locator('#proxy-name').fill('东京 SS');await page.locator('#proxy-url').fill('ss://'+Buffer.from('aes-256-gcm:fixture-ss-password').toString('base64url')+'@ss.example:8388');
    await page.locator('#save-proxy').click();await page.waitForFunction(()=>document.querySelectorAll('#proxy-list .connection-item').length===1);
    assert.equal(await page.locator('#proxy-url').inputValue(),'');
    assert.equal((await page.locator('#proxy-list').textContent()).includes('fixture-ss-password'),false);
    await page.locator('#proxy-name').fill('本地测试出口');await page.locator('#proxy-url').fill('http://127.0.0.1:'+proxy.address().port);
    await page.locator('#save-proxy').click();await page.waitForFunction(()=>document.querySelectorAll('#proxy-list .connection-item').length===2);
    await page.locator('#proxy-test-url').fill(site.origin);
    await page.locator('#proxy-list .connection-item').last().getByRole('button',{name:'测试出口',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#proxy-feedback').textContent.includes('浏览器连接成功'));
    assert.ok(proxyReads.length>0);
    await page.locator('nav').getByRole('link',{name:'监控任务',exact:true}).click();await page.locator('#new-monitor').click();
    await page.locator('#monitor-url').fill(site.origin);await page.locator('#monitor-name').fill('服务器补货提醒');await page.locator('[data-prompt="stock"]').click();
    await page.locator('#monitor-proxy').selectOption({label:'本地测试出口'});
    const before=site.state.aiCalls;
    await page.locator('#analyze-monitor').click();await page.locator('#monitor-preview:visible').waitFor({timeout:30000});
    assert.match(await page.locator('#preview-state').textContent(),/尚未命中/);
    assert.match(await page.locator('#preview-value').textContent(),/0 Available/);
    assert.equal(site.state.aiCalls,before+1);
    await page.locator('#confirm-monitor').click();
    await page.waitForFunction(()=>document.querySelector('#monitor-list')?.textContent.includes('监控中'));
    const monitor=runtime.pageMonitors.list()[0];await idle(runtime.pageMonitors,monitor.id);
    assert.equal(monitor.name,'服务器补货提醒');assert.ok(monitor.proxyId);
    await page.locator('nav').getByRole('link',{name:'API 与出口',exact:true}).click();
    await page.locator('#proxy-list .connection-item').last().getByRole('button',{name:'编辑',exact:true}).click();
    await page.locator('#proxy-name').fill('正在使用的出口');
    await page.locator('#save-proxy').click();
    await page.waitForFunction(()=>document.querySelector('#proxy-feedback').textContent.includes('请先暂停'));
    await page.locator('#cancel-proxy').click();
    await page.locator('nav').getByRole('link',{name:'监控任务',exact:true}).click();
    site.state.quantity=2;
    const checkResponse=page.waitForResponse(response=>response.url().endsWith('/api/monitors/check'));
    await page.locator('#monitor-list').getByRole('button',{name:'立即检查',exact:true}).click();
    const checked=await(await checkResponse).json();
    assert.equal(checked.status,'matched',JSON.stringify(checked));
    await page.waitForFunction(()=>document.querySelector('#monitor-list').textContent.includes('已提醒 1 次'));
    assert.equal(site.state.aiCalls,before+1);assert.equal(site.state.writes,0);
    await page.locator('#monitor-list').getByRole('button',{name:'暂停',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#monitor-list').textContent.includes('已暂停'));
    await page.locator('#monitor-list summary').click();
    await page.waitForResponse(response=>response.url().endsWith('/api/status')&&response.ok());
    assert.equal(await page.locator('#monitor-list details').evaluate(element=>element.open),true);
    await page.locator('#new-monitor').click();await page.locator('#monitor-url').fill(site.origin);
    const output=resolve('release/ui');await mkdir(output,{recursive:true});
    for(const width of [1440,390,320]) {
      await page.setViewportSize({width,height:width===1440?1100:844});
      for(const view of ['monitors','connections']) {
        await page.locator('nav a[href="#/'+view+'"]').click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),view+' / '+width);
        if(width!==320)await page.screenshot({path:join(output,'workspace-'+view+'-'+width+'.png'),fullPage:true,animations:'disabled'});
      }
    }
    assert.deepEqual(errors,[]);
    const response=await page.request.get('http://127.0.0.1:'+app.server.address().port+'/api/status');
    const text=await response.text();
    assert.equal(text.includes('fixture-private-ui-key'),false);assert.equal(text.includes('fixture-ss-password'),false);
  } finally {
    await browser.close();await app.close();await site.close();await new Promise(resolve=>proxy.close(resolve));await rm(dir,{recursive:true,force:true});
  }
});
