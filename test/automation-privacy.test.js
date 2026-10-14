import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {inspectCommerceField,inspectCommercePage} from '../automation/browser/dom-parser.js';
import {planningObservation} from '../automation/agent/observation-context.js';
import {createPlanner} from '../automation/agent/planner.js';

const password='private-password-9731',cookie='session=private-session-9731';
const observation=()=>({observationId:'test',url:'https://shop.example/',title:'Checkout',text:'Checkout '+password+' '+cookie,cookie,elements:[
  {ref:'e1',tag:'input',type:'PASSWORD',role:'textbox',accessibleName:'Password',value:password,rawValue:password,visible:true},
  {ref:'e2',tag:'input',type:'number',role:'spinbutton',accessibleName:'Quantity',value:'2',visible:true},
  {ref:'e3',tag:'button',role:'button',accessibleName:'Continue',text:'Continue',visible:true,contextText:password+' '+cookie},
],forms:[]});

test('planning observations redact credential values and preserve purchase semantics',()=>{
  const source=observation(),result=planningObservation(source);
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(cookie));
  assert.equal(result.elements.find(el=>el.ref==='e2').value,'2');
  assert.equal(result.elements.find(el=>el.ref==='e3').accessibleName,'Continue');
  assert.equal(source.elements[0].value,password);
});

test('AI serialization rejects password values and full cookies even with a raw observation',async()=>{
  let messages;
  const planner=createPlanner(async input=>{messages=input;return {action:'wait',value:100,reason:'Wait for checkout'};});
  await planner({order:{product:'Example',quantity:2,credentials:{cookies:[{name:'session',value:'private-session-9731'}]}},workflow:{version:2,requirements:[]},observation:observation(),history:[],feedback:{previousPlan:{cookie,password}}});
  const serialized=JSON.stringify(messages);
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes('private-session-9731'));
  const page=JSON.parse(messages[1].content).page;
  assert.equal(page.elements[0].value,undefined);
  assert.equal(page.elements[0].accessibleName,'Password');
  assert.equal(page.elements[1].value,'2');
});

const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':null);
test('real DOM snapshots redact password and cookie echoes without changing semantic refs',{skip:!executable},async()=>{
  const browser=await chromium.launch({executablePath:executable,headless:true});
  try{
    const context=await browser.newContext();
    await context.addCookies([{name:'session',value:'private-session-9731',url:'https://shop.example/'}]);
    const page=await context.newPage();
    await page.route('https://shop.example/**',route=>route.fulfill({contentType:'text/html',body:`<form><label>Password<input type="PASSWORD" name="password" value="${password}"></label><label>Quantity<input type="number" value="2"></label><button>Continue</button><p>${password} ${cookie}</p></form>`}));
    await page.goto('https://shop.example/');
    const snapshot=await page.evaluate(inspectCommercePage,{observationId:'privacy'});
    const field=await page.locator('input[type="PASSWORD"]').evaluate(inspectCommerceField);
    assert.equal(field.value,undefined);
    assert.equal(field.rawValue,undefined);
    assert.equal(field.privateField,true);
    assert.ok(!JSON.stringify(snapshot).includes(password));
    assert.ok(!JSON.stringify(snapshot).includes('private-session-9731'));
    const quantity=snapshot.elements.find(el=>el.label==='Quantity'&&el.tag==='input');
    assert.equal(quantity.value,'2');
    assert.equal(await page.locator('[data-agent-ref="privacy:'+quantity.ref+'"]').inputValue(),'2');
    assert.equal(await page.locator('input[type="PASSWORD"]').inputValue(),password);
    assert.ok(snapshot.elements.some(el=>el.accessibleName==='Continue'));
  }finally{await browser.close();}
});
