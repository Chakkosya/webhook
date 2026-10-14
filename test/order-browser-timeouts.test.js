import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':null);

test('优惠证据延迟超过五秒仍核验成功，补货仅刷新明确失效的登录',{skip:!executable,timeout:45000},async t=>{
 let coupons=0,logins=0,orders=0;
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  res.setHeader('content-type','text/html; charset=utf-8');
  if(req.url==='/login'&&req.method==='POST'){logins++;assert.equal(new URLSearchParams(body).get('username'),'saved-user');res.writeHead(303,{'set-cookie':'logged=1; Path=/','location':'/account'});return res.end();}
  if(req.url==='/account'&&!req.headers.cookie?.includes('logged=1'))return res.end('<form method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password"><button>Log in</button></form>');
  if(req.url==='/account')return res.end('<a href="/logout">Log out</a>');
  if(req.url==='/coupon'){coupons++;return res.end('ok');}
  if(req.url==='/create'){orders++;return res.end('unexpected');}
  res.end('<h1 id="product">Product A</h1><span id="total">USD 10</span><span id="currency">USD</span><form method="post" action="/create"><input id="quantity" name="quantity" value="1"><button id="submit">Place order</button></form><form id="promo" method="post" action="/coupon"><input id="code" name="coupon"><button id="apply">Apply coupon</button></form><span id="applied" hidden>SAVE2</span><span id="discount" hidden>USD 2</span><script>document.querySelector("#promo").onsubmit=async e=>{e.preventDefault();await fetch("/coupon",{method:"POST",body:new URLSearchParams(new FormData(e.target))});setTimeout(()=>{document.querySelector("#applied").hidden=false;document.querySelector("#discount").hidden=false;document.querySelector("#total").textContent="USD 8";},5500);};</script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port,launch=options=>chromium.launch({...options,executablePath:executable});
 try{
  await t.test('普通优惠核验等待十二秒',async()=>{
   const session=await createOrderBrowser({url:base+'/',product:'Product A',quantity:1,currency:'USD',couponCode:'SAVE2',dryRun:true},{launch});
   try{const result=await session.methods.applyCoupon({inputSelector:'#code',applySelector:'#apply',appliedCodeSelector:'#applied',discountSelector:'#discount'},{submitSelector:'#submit',productSelector:'#product',quantitySelector:'#quantity',totalSelector:'#total',currencySelector:'#currency',confirmationSelector:'#confirmation'});assert.equal(result.discount,2);assert.equal(coupons,1);assert.equal(orders,0);}finally{await session.close();}
  });
  await t.test('补货恢复登录后仍验证账户并返回商品页',async()=>{
   const session=await createOrderBrowser({url:base+'/',credentials:{username:'saved-user',password:'saved-password'},dryRun:true},{launch,trigger:'restock',loginCheck:{url:base+'/account'}});
   try{assert.equal(logins,1);const saved=await session.accountState();assert.equal(saved.check.url,base+'/account');assert.ok(saved.state.cookies.some(cookie=>cookie.name==='logged'));assert.ok(session.trace.some(event=>event.action==='账户预热'));assert.equal(orders,0);}finally{await session.close();}
  });
 }finally{await new Promise(resolve=>server.close(resolve));}
});
