import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {chromium} from 'playwright-core';
import {createOrderBrowser} from '../lib/order-browser.js';

const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'&&fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':null);

test('slow preparation waits for responses, redirects and quote reads without replay',{skip:!executable,timeout:120000},async t=>{
  const writes=[];let scenario;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const url=new URL(req.url,'http://localhost');
    res.setHeader('content-type','text/html; charset=utf-8');
    if(req.method==='POST'){
      writes.push({url:req.url,body});
      if(scenario.httpError){res.statusCode=503;return res.end('Unavailable');}
      await new Promise(resolve=>setTimeout(resolve,scenario.responseDelay||0));
      res.writeHead(303,{location:'/domains'});return res.end();
    }
    if(url.pathname==='/domains'){
      await new Promise(resolve=>setTimeout(resolve,scenario.redirectDelay||0));
      res.writeHead(303,{location:'/checkout'});return res.end();
    }
    if(url.pathname==='/quote'){
      await new Promise(resolve=>setTimeout(resolve,scenario.quoteDelay||0));
      return res.end('USD 10');
    }
    if(url.pathname==='/checkout')return res.end('<main><h1>Product A</h1><p id="total">Calculating</p></main><script>fetch("/quote").then(response=>response.text()).then(total=>document.querySelector("#total").textContent=total);</script>');
    res.end('<main><h1>Product A</h1><form method="post" action="/basket"><label>Quantity<input name="quantity" value="1"></label><button id="continue">Continue</button></form></main>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const open=async()=>{
    let readStarted=0;
    const launch=async options=>{
      const browser=await chromium.launch({...options,executablePath:executable}),newContext=browser.newContext.bind(browser);
      browser.newContext=async options=>{
        const context=await newContext(options),newPage=context.newPage.bind(context);
        context.newPage=async()=>{
          const page=await newPage(),content=page.content.bind(page);
          page.content=async()=>{
            if(scenario.readDelay&&new URL(page.url()).pathname==='/checkout'){
              readStarted||=Date.now();
              if(Date.now()-readStarted<scenario.readDelay)throw new Error('Execution context was destroyed');
            }
            return content();
          };
          return page;
        };
        return context;
      };
      return browser;
    };
    const session=await createOrderBrowser({url:base+'/product',product:'Product A',quantity:1,maxTotal:10,currency:'USD',dryRun:true},{launch,timeoutMs:110000});
    return session;
  };
  try{
    await t.test('a 21 second POST and redirect chain settles its later quote before verification',async()=>{
      scenario={responseDelay:21000,redirectDelay:21000,quoteDelay:11000};
      const before=writes.length,session=await open();
      try{
        await session.methods.observe();
        assert.deepEqual(await session.methods.cart('#continue'),{cartMutation:true});
        assert.equal(await session.methods.text('#total'),'USD 10');
        assert.equal(writes.length,before+1);
        assert.equal(writes.at(-1).body,'quantity=1');
        assert.ok(!session.trace.some(event=>event.action==='准备核验失败原文'));
      }finally{await session.close();}
    });
    await t.test('navigation reads remain valid beyond the previous five second window',async()=>{
      scenario={readDelay:5500};const before=writes.length,session=await open();
      try{await session.methods.cart('#continue');assert.equal(writes.length,before+1);}
      finally{await session.close();}
    });
    await t.test('the configured read window preserves the original failure and sends once',async()=>{
      const previous=process.env.ORDER_READ_PAGE_TIMEOUT_MS;process.env.ORDER_READ_PAGE_TIMEOUT_MS='1000';
      scenario={readDelay:2000};const before=writes.length;let session;
      try{
        session=await open();
        await assert.rejects(session.methods.cart('#continue'),{code:'ORDER_PREPARATION_UNCERTAIN'});
        assert.equal(writes.length,before+1);
        assert.ok(session.trace.some(event=>event.action==='准备核验失败原文'&&event.detail.startsWith('ORDER_NAVIGATION_UNSTABLE: ')));
      }finally{await session?.close();if(previous===undefined)delete process.env.ORDER_READ_PAGE_TIMEOUT_MS;else process.env.ORDER_READ_PAGE_TIMEOUT_MS=previous;}
    });
    await t.test('merchant response failures retain their original code and HTTP status',async()=>{
      scenario={httpError:true};const before=writes.length,session=await open();
      try{
        await assert.rejects(session.methods.cart('#continue'),{code:'ORDER_PREPARATION_UNCERTAIN'});
        assert.equal(writes.length,before+1);
        assert.ok(session.trace.some(event=>event.action==='准备核验失败原文'&&event.detail.startsWith('ORDER_REQUEST_HTTP_ERROR: ')&&event.detail.includes('503')));
      }finally{await session.close();}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});
