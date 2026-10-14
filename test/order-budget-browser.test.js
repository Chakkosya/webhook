import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {createOrderService,validateOrderTask} from '../lib/orders.js';
const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);

test('local merchant: catalog, configuration, actual pricing, split orders and original invoices',{skip:!executable},async t=>{
  let scenario,base;const orders=[],payments=[],catalogChoices=[];
  const quote=(q,coupon)=>scenario.price(q)-(coupon?2:0);
  const checkout=(q,coupon=false)=>'<a href="/logout">Log out</a><h1>DS.CN.HK.BGP.V2</h1><p id="cycle-proof">Monthly</p><p id="total">CAD '+quote(q,coupon)+'</p><p id="currency">CAD</p><form method="post" action="/create"><input type="hidden" name="quantity" value="'+q+'"><input type="hidden" name="discounted" value="'+Number(coupon)+'"><span id="quantity">'+q+'</span><button>Place order</button></form><form method="post" action="/discount"><input type="hidden" name="quantity" value="'+q+'"><label>Coupon<input name="coupon"></label><button>Apply coupon</button></form><p id="applied">'+(coupon?'SAVE2':'None')+'</p><p id="discount">CAD '+(coupon?2:0)+'</p>';
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=new URLSearchParams(raw),url=new URL(req.url,'http://localhost');res.setHeader('content-type','text/html; charset=utf-8');
    if(url.pathname==='/store')return res.end('<title>Shopping Cart - VMISS</title><a href="/logout">Log out</a><article><h2>DS.CN.HK.BGP.V2</h2><p>32G · 0 Available</p><a href="/configure?variant=32">Order Now</a></article><article><h2>DS.CN.HK.BGP.V2</h2><p>64G · 5 Available</p><a href="/configure?variant=64">Order Now</a></article>');
    if(url.pathname==='/configure'){
      catalogChoices.push(url.searchParams.get('variant'));
      return res.end('<a href="/logout">Log out</a><main><h1>DS.CN.HK.BGP.V2</h1><form method="post" action="/basket"><label>Quantity<input type="number" name="quantity" value="1" min="1" max="'+scenario.limit+'"></label><label>Cycle<select name="cycle"><option value="year">Yearly</option><option value="month">Monthly</option></select></label><button>Continue</button></form></main>');
    }
    if(url.pathname==='/basket'){const q=Number(body.get('quantity'));assert.ok(q<=scenario.limit);res.writeHead(303,{location:'/checkout?q='+q});return res.end();}
    if(url.pathname==='/checkout')return res.end(checkout(Number(url.searchParams.get('q'))));
    if(url.pathname==='/discount'){assert.equal(body.get('coupon'),'SAVE2');return res.end(checkout(Number(body.get('quantity')),true));}
    if(url.pathname==='/create'){
      const q=Number(body.get('quantity')),total=quote(q,body.get('discounted')==='1'),id=String(orders.length+1);orders.push({id,quantity:q,total});
      return res.end('<h1>Order Confirmation</h1><p>Order Number: '+id+'</p><a href="/invoice?id='+id+'">View invoice</a>');
    }
    if(url.pathname==='/invoice'){
      const id=url.searchParams.get('id'),order=orders.find(order=>order.id===id);
      return res.end('<h1>Invoice '+id+'</h1><p id="total">CAD '+order.total+'</p><p id="currency">CAD</p><p id="balance">CAD 1000</p><p id="balance-currency">CAD</p><form method="post" action="/pay"><input type="hidden" name="invoiceid" value="'+id+'"><button>Pay with Account Balance</button></form>');
    }
    if(url.pathname==='/pay'){const id=body.get('invoiceid');assert.ok(orders.some(order=>order.id===id));assert.ok(!payments.includes(id));payments.push(id);return res.end('<h1>Payment successful</h1>');}
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  const requestAI=async(_user,messages)=>{
    const input=JSON.parse(messages.at(-1).content);if(!input.page)return {summary:'Monthly 64G product',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}};
    const page=input.page,path=new URL(page.url).pathname;
    const bind=(meaning,match)=>{const el=page.elements.filter(match);assert.equal(el.length,1,meaning+' '+path);return {meaning,ref:el[0].ref,confidence:0.93};};
    if(path==='/store')return {action:'click',reason:'Available 64G variant matches the requested product',target:bind('Order Now link for the available DS.CN.HK.BGP.V2 64G variant',el=>el.href==='/configure?variant=64')};
    if(path==='/configure'){
      const quantity=bind('商品数量',el=>el.name==='quantity'),cycle=bind('Monthly billing cycle',el=>el.name==='cycle');
      return {steps:[{action:'fill',reason:'Use requested quantity',target:quantity,valueFrom:'quantity'},{action:'select',reason:'Use requested cycle',target:cycle,valueFrom:{requirement:'Cycle'}},{action:'configure',reason:'Continue current product',target:bind('继续当前配置',el=>el.tag==='button'),bindings:{product:bind('商品名称',el=>el.tag==='h1'),quantity},configuration:[{name:'Cycle',target:cycle}]}]};
    }
    if(path==='/create')return {action:'invoice',reason:'Open the current order invoice',target:bind('当前订单账单',el=>el.role==='link')};
    if(path==='/invoice')return {action:'pay',reason:'Pay original invoice using balance',bindings:{pay:bind('账户余额付款',el=>el.tag==='button'),invoice:bind('账单编号',el=>el.name==='invoiceid'),...Object.fromEntries(['total','currency','balance'].map(key=>[key,bind(key,el=>el.id===key)])),balanceCurrency:bind('余额币种',el=>el.id==='balance-currency')}};
    const bindings={submit:bind('提交订单',el=>el.tag==='button'&&(el.text||el.accessibleName)==='Place order'),product:bind('商品名称',el=>el.tag==='h1'),...Object.fromEntries(['quantity','total','currency'].map(key=>[key,bind(key,el=>el.id===key)]))};
    if(input.order.couponCode)Object.assign(bindings,{input:bind('优惠输入',el=>el.name==='coupon'),apply:bind('应用优惠',el=>el.tag==='button'&&(el.text||el.accessibleName)==='Apply coupon'),appliedCode:bind('优惠回显',el=>el.id==='applied'),discount:bind('实际减免',el=>el.id==='discount')});
    const action=input.context.pendingVerification==='coupon'?'verify_coupon':input.order.couponCode&&!input.context.couponApplied?'apply_coupon':'review';
    return {action,reason:'Verify current product and final total',bindings,configuration:[{name:'Cycle',target:bind('月付方案',el=>el.id==='cycle-proof')}]};
  };
  try{
    for(const config of [
      {name:'taxed total reduces quantity',quantity:4,maxTotal:25,limit:10,price:q=>q*10+2,expected:[2],total:22,status:'partial'},
      {name:'quantity discount fits exact budget',quantity:3,maxTotal:25,limit:10,price:q=>q===3?25:q*12,expected:[3],total:25,status:'ordered'},
      {name:'single-order limits create and pay three original invoices',quantity:3,maxTotal:30,limit:1,price:q=>q*10,expected:[1,1,1],total:30,mode:'pay',status:'paid'},
      {name:'coupon reprices the actual order',quantity:2,maxTotal:18,limit:10,price:q=>q*10,expected:[2],total:18,couponCode:'SAVE2',status:'ordered'},
      {name:'one item exceeds the budget',quantity:2,maxTotal:5,limit:10,price:q=>q*10,expected:[],total:0,status:'needs_validation'}
    ])await t.test(config.name,async()=>{
      scenario=config;const start=orders.length,paid=payments.length;
      const task=validateOrderTask({url:base+'/store',product:'DS.CN.HK.BGP.V2',instruction:'64G Monthly',quantity:config.quantity,maxTotal:config.maxTotal,currency:'CAD',couponCode:config.couponCode,executionMode:config.mode||'submit',monitorId:'monitor'});
      const user={id:'browser-budget',monitors:[{id:'monitor',kind:'webpage',enabled:true}],orderTasks:[task],orderAccounts:[{monitorId:'monitor',loginUrl:task.url,revision:1,status:'saved',session:{state:{cookies:[],origins:[]},check:{url:task.url}}}]};
      const service=createOrderService({persist:()=>{},requestAI,siteMemory:{read:async()=>null,record:async()=>{}},openBrowser:(current,options)=>createOrderBrowser(current,{...options,launch:options=>chromium.launch({...options,executablePath:executable})})});
      service.approve(user,task);assert.equal(task.trial,null);await service.trigger(user,user.monitors[0]);
      assert.equal(task.status,config.status,task.error);assert.deepEqual(orders.slice(start).map(order=>order.quantity),config.expected);assert.equal(orders.slice(start).reduce((sum,order)=>sum+order.total,0),config.total);
      assert.equal(payments.length-paid,config.mode==='pay'?3:0);assert.ok(catalogChoices.every(choice=>choice==='64'));
      if(config.expected.length)assert.equal(task.result.purchaseSummary.quantity,config.expected.reduce((a,b)=>a+b,0));
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
