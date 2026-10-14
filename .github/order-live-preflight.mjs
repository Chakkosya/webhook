// Opt-in merchant smoke: anonymous session, preparation only, no order submission.
import assert from 'node:assert/strict';
import {createOrderBrowser} from '../lib/order-browser.js';
import {productEntry} from '../automation/agent/product-binding.js';
import {pageType} from '../automation/adapters/generic-commerce.js';
const order={url:process.env.LIVE_PREFLIGHT_URL||'https://my.frantech.ca/cart.php?gid=38',product:process.env.LIVE_PREFLIGHT_PRODUCT||'NY RYZEN KVM 4GB',quantity:1,maxTotal:30,currency:'USD',executionMode:'prepare',dryRun:true};
const report={at:new Date().toISOString(),origin:new URL(order.url).origin,product:order.product,phases:[],submitted:false};
let session;
try{
  session=await createOrderBrowser(order,{onBeforeSubmit:()=>{throw new Error('Live preflight never creates orders');}});
  let page=await session.methods.observe();report.phases.push({stage:pageType(page),title:page.title});
  const entry=productEntry({observation:page,order,context:{}});assert.ok(entry,'No unique available product entry');
  const region=page.elements.find(el=>el.ref===entry.target.ref)?.contextText||'';
  assert.doesNotMatch(region,/\b0\s+Available|Sold Out|Out of Stock/i);
  await session.methods.click((await session.methods.resolveSemantic(entry.target)).selector);
  page=await session.methods.observe();report.phases.push({stage:pageType(page),priced:/20[.,]00\s*USD|USD\s*20[.,]00/.test(page.text)});
  const buttons=page.elements.filter(el=>el.visible&&!el.disabled&&el.role==='button'&&/^continue$/i.test(el.accessibleName||el.text));
  assert.equal(buttons.length,1,'No unique configuration continuation');
  const target={meaning:'Continue product configuration',ref:buttons[0].ref,confidence:1};
  await session.methods.cart((await session.methods.resolveSemantic(target)).selector,{configuration:true});
  page=await session.methods.observe();const checkout=new URL(page.url).searchParams.get('a')==='checkout';assert.ok(checkout,'Configuration did not reach checkout');
  report.phases.push({stage:pageType(page),checkout:true,loginRequired:/Existing Customer Login/.test(page.text),visiblePrices:[...new Set(page.text.match(/\$\d+[.,]\d{2}\s+USD/g)||[])],finalButton:page.elements.some(el=>el.visible&&el.role==='button'&&/^Checkout$/i.test(el.text))});
  assert.equal(session.submissionStarted,false);
  console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({...report,error:error.message,code:error.code}));process.exitCode=1;}
finally{await session?.close();}
