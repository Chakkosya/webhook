import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';
import {browserExecutable} from '../src/browser/session.js';
test('website Sign In and Sign Up precede the workspace and registration uses a delivered email code',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'auth-ui-')),messages=[],runtime=await new Runtime(dir).open(),app=await serve({runtime,port:0,sendMail:async value=>messages.push(value)}),browser=await chromium.launch({headless:true,executablePath:await browserExecutable()}),base='http://127.0.0.1:'+app.server.address().port;
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.waitForURL('**/signin');assert.equal(await page.locator('nav[aria-label="工作区"]').count(),0);
  await page.locator('#signup-link').click();await page.locator('#auth-submit').filter({hasText:'创建管理员'}).waitFor();
  await page.locator('#auth-email').fill('owner@example.test');await page.locator('#auth-password').fill('owner-password');await page.locator('#auth-submit').click();
  await page.waitForURL(base+'/');await page.locator('#user-email').filter({hasText:'owner@example.test'}).waitFor();
  assert.equal(await page.locator('nav a[href="#/account-login"]').count(),0);
  await page.locator('#user-email').click();await page.locator('#mail-from').fill('robot@example.test');await page.locator('#mail-key').fill('fixture-mail-key');await page.locator('#save-mail').click();
  await page.locator('#mail-feedback').filter({hasText:'已保存'}).waitFor();assert.equal(await page.locator('#mail-key').inputValue(),'');
  await page.locator('#signout').click();await page.waitForURL('**/signin');
  await page.locator('#signup-link').click();await page.locator('#verification-field:visible').waitFor();
  await page.locator('#auth-email').fill('member@example.test');await page.locator('#send-code').click();
  await page.locator('#auth-feedback').filter({hasText:'验证码已发送'}).waitFor();
  await page.locator('#auth-password').fill('member-password');await page.locator('#auth-code').fill(messages[0].text.match(/\b\d{6}\b/)[0]);await page.locator('#auth-submit').click();
  await page.waitForURL(base+'/');await page.locator('#user-email').filter({hasText:'member@example.test'}).waitFor();
  await page.locator('#user-email').click();assert.equal(await page.locator('#mail-settings').isVisible(),false);
  await page.locator('#signout').click();await page.waitForURL('**/signin');
  const output=resolve('release/ui');await mkdir(output,{recursive:true});
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:900});
   for(const path of ['signin','signup']){
    await page.goto(base+'/'+path);await page.locator('#auth-title').filter({hasText:path==='signin'?'Sign In':'Sign Up'}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const brand=await page.locator('.brand').boundingBox(),actions=await page.locator('.auth-actions').boundingBox();assert.ok(actions.x>brand.x);
    if(width!==320)await page.screenshot({path:join(output,'auth-'+path+'-'+width+'.png'),fullPage:true,animations:'disabled'});
   }
  }
  await page.goto(base+'/signin');await page.locator('#auth-email').fill('member@example.test');await page.locator('#auth-password').fill('wrong-password');await page.locator('#auth-submit').click();await page.locator('#auth-feedback').filter({hasText:'邮箱或密码不正确'}).waitFor();
  await page.locator('#auth-password').fill('member-password');await page.locator('#auth-submit').click();await page.waitForURL(base+'/');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await app.close();await rm(dir,{recursive:true,force:true});}
});
