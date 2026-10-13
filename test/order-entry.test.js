import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';
import {planningObservation,createAssistedPlanner} from '../automation/agent/local-planner.js';

const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);
const workflow={version:2,requirements:[{name:'RAM',value:'64 GB'}]};
const target=(meaning,el)=>({meaning,ref:el.ref,confidence:0.95});

test('purchase entries stay attached to their product regions through observation and navigation',{skip:!executable},async t=>{
  const requests=[];
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');requests.push({method:req.method,path:url.pathname,url:req.url});res.setHeader('content-type','text/html; charset=utf-8');
    const login='<a href="/logout">Log out</a>';
    if(url.pathname==='/catalog'){
      const tag=url.searchParams.get('markup')==='semantic'?'article':'div';
      const cards=['B','C','A'].map(product=>'<'+tag+'><p>'+'A lengthy merchant introduction. '.repeat(70)+'</p><h2>Product '+product+'</h2><p>'+(product==='A'?'64':'32')+' GB RAM</p>'+'<div>'.repeat(8)+Array.from({length:6},(_,i)=>'<a href="/details?product='+product+'&tab='+i+'">Details '+i+'</a>').join('')+'<a href="/configure?product='+product+'">立即购买</a>'+'</div>'.repeat(8)+'</'+tag+'>').join('');
      const noise='<aside>'+Array.from({length:130},(_,i)=>'<p>Product A comparison note '+i+'</p>').join('')+'</aside>';
      return res.end(login+noise+'<main><h1>Catalog</h1>'+cards+'</main>');
    }
    if(url.pathname==='/controls')return res.end(login+'<main><h1>Product A</h1><a id="complete" href="/complete">立即购买</a><a id="charge" href="/charge">继续</a><a id="pay-labeled" href="/invoice.php?id=42">Pay now</a><a id="submit-labeled" href="/checkout?confirm=1">确认订单</a><form method="get" action="/create"><button id="submit-get">提交订单</button></form><form method="post" action="/create"><input name="quantity" value="1"><button id="final">立即购买</button></form><form method="get" action="/configured"><label>Quantity<input id="quantity" name="quantity" value="1"></label><button id="configure">立即购买</button></form></main>');
    res.end(login+'<h1>Product '+(url.searchParams.get('product')||'A')+'</h1><p>Configure your product</p>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const launch=options=>chromium.launch({...options,executablePath:executable});
  const order={product:'Product A',quantity:1,currency:'USD',maxTotal:20,executionMode:'submit',dryRun:true,program:{workflow}};
  try{
    for(const markup of ['semantic','generic'])await t.test(markup+' long cards keep deep purchase links and specifications in the compact view',async()=>{
      const task={...order,url:base+'/catalog?markup='+markup},session=await createOrderBrowser(task,{launch});
      try{
        const page=await session.methods.observe(),heading=page.elements.find(el=>el.tag==='h2'&&el.text==='Product A'),purchase=page.elements.find(el=>el.href==='/configure?product=A');
        assert.ok(heading.regionRef);assert.equal(purchase.regionRef,heading.regionRef);assert.match(purchase.contextText,/Product A/);assert.doesNotMatch(purchase.contextText,/Product B|Product C/);assert.ok(purchase.contextText.length<=1200);
        const compact=planningObservation(page,{order:task,workflow});
        assert.ok(compact.elements.length<=96);assert.ok(JSON.stringify(compact).length<=24000);
        assert.ok(compact.elements.some(el=>el.ref===heading.ref));assert.ok(compact.elements.some(el=>el.ref===purchase.ref));assert.ok(compact.elements.some(el=>el.regionRef===heading.regionRef&&(el.text||el.accessibleName)==='64 GB RAM'));
        for(const product of ['A','B','C']){
          const link=page.elements.find(el=>el.href==='/configure?product='+product);
          if(compact.elements.some(el=>el.regionRef===link.regionRef)){
            assert.ok(compact.elements.some(el=>el.ref===link.ref));assert.ok(compact.elements.some(el=>el.regionRef===link.regionRef&&el.tag==='h2'));
          }
        }
        const planner=createAssistedPlanner(async({observation})=>{
          const name=observation.elements.find(el=>el.tag==='h2'&&(el.text||el.accessibleName)==='Product A');
          const link=observation.elements.find(el=>el.regionRef===name.regionRef&&el.href==='/configure?product=A');
          return {action:'click',reason:'Open the purchase entry in the selected product region',target:target('purchase',link)};
        });
        const step=await planner({order:task,workflow,observation:page,context:{}}),located=await session.methods.resolveSemantic(step.target);
        await session.methods.click(located.selector);
        assert.equal(requests.findLast(request=>request.path==='/configure').url,'/configure?product=A');assert.ok((await session.methods.observe()).elements.some(el=>el.tag==='h1'&&el.text==='Product A'));assert.equal(session.submissionStarted,false);
      }finally{await session.close();}
    });
    await t.test('GET configuration uses the form operation while final submission and payment entries remain separate',async()=>{
      const task={...order,url:base+'/controls'},session=await createOrderBrowser(task,{launch});
      try{
        for(const key of ['#complete','#charge','#pay-labeled','#submit-labeled','#submit-get','#final','#configure'])await assert.rejects(session.methods.click(key),/提交表单只能/);
        await assert.rejects(session.methods.cart('#final'),/独立的商品配置或购物车操作/);
        await assert.rejects(session.methods.configure('#submit-get'),/独立的商品配置或购物车操作/);
        const page=await session.methods.observe(),quantity=page.elements.find(el=>el.id==='quantity');
        await session.methods.registerPreparation({action:'fill',target:target('quantity',quantity),value:'1'});
        await session.methods.configure('#configure',{productSelector:'h1'});
        assert.equal((await session.methods.observe()).url,base+'/configured?quantity=1');assert.equal(session.submissionStarted,false);
        assert.ok(!requests.some(request=>['/complete','/charge','/create','/invoice.php','/checkout'].includes(request.path)||request.method==='POST'));
      }finally{await session.close();}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
