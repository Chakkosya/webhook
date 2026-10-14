import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// Public self-signed localhost TLS fixtures; only smoke contexts accept this certificate.
const key="-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCMZwGphjjAcpKT\nCeqol3I6qfUcTRA+M6mj+uLiwlPBxFRAby2VxdKSe78KI0UJ4WiIcgjbF/43QIqG\nBrDkMLkgBviF7AP5iL93EMYi2mDVNPaRyuEaWEzKhPn9Ap9UsXJK+LKiQJt/ZqNt\nvXGO0lL0mDtUkl+reeegVGQLrUGQ7URy2JLRor5BFJbxTwiP7ArBe17D75QnpvQo\nw817oTeO7UgF/yzEJunrW3eVqXIYd0VoDEpZiuShMBj7MpyGOUmdvr5SHKZ/xA8m\nQv05lGq18HYRWjYNMFtZiMRGSSRs1kG21AFMN07TzxZtFZ1ZDLcmVhIC2QPvixZ2\nS73GhUkvAgMBAAECggEABt4Y++5OcQ5Ae990qSm8ZUoNo7s/QqXrRhzgbKAQCJoc\nDcA5SGE/1Xkmy/umGBHYJVYk5S12ens/faKluIlnAVBBZ1VJa6DBzn3Hn9xg0uGI\nik5dg6sp4mruAW9FVOBp+Pr3XeTK+u1ErDFIPg0/NM95ulGkAemU8RER9tkcLCAt\nh/mkGeUCZeDkaxzxBaUzPQ9RKWLwfMLTiV8GVnQK+CJl8/Ok+eukMdHMd5tfkeqr\ndV9hiFKbq5h/VSkO66x1zXUzDiMuw/E9fHey90RoDv94lVRJB63W4coEWlxG9yEH\nxSA5YTIJXLTgNDz5DpwatVO6jSkdapSJzTv6lKWk3QKBgQDETGvuhnRCMKQj9C+V\nbHVaVyYZdcsWpwHN2ulXqsqeBD/nJUC+j3fqvQ7Iuj7wKiMiCZzfZohLPOn8nUI0\nxLL1GbV3lFhz8Diw5B9Sqvjd/HKucRSD3d8T8/G3ADgpEsC/nbmsbXdmzeeL6Vei\nV8s1sir7tkRJ8tpBdvyL6sudTQKBgQC3GpMJWkWXhxHX+08GDLbsG0A+jtlTBjUV\nW7LFSHoT45C97+6hmfVcVAuBpyZIQsoDuthZUX7CCP+hID1Nn5x4WzSJQRHyu1o4\nd+dq9Sa6ycNb8jrLiwAkjnr1Zl7RiqxHauhbOa/5vPOCjcdhWt4ohNo9SPOB6/g2\ndfUrFreyawKBgAIfpYdGExnoNs5gxOcD7l0U1keuO406L03P0XhuU5TUDPDuOT4W\nhUCX3QIU6btlaU3j9rt/+3d86DcgaGfzvM/kAE+T3kUa0zIutZwKV3jnU0JJ3OP0\nUYaAvBuzt+fR2R35kdmosYL+NUQROS57bqpdDBP/C8wVAYF1zROibaN9AoGAD0ej\nb4td9VgrMAfjv1B+T1Oy18WZ8yi4c1DUqUv0DAbYhFEqa8fqRssorqghNLSGISuN\ndF6tokmX8306QGkKaKzLxIxuj//8dmvjHvTYR4wgxmJ/b47o8yQEtMfXL8tPtyH/\nw+Ubf066T3G/aqtnkKANikG1OGlVrE3JqM/bgoMCgYBGGzbagTbeY1ZYXMDYnm8b\nj46CpW0BZ3rDRBeyIwz42EqH8GN+VpVCyeUESufvmJ0ZRivZwc0hJn0Y6zWhf4Ae\niWokL8S2YLQYdxYTwVztWnJonpYtluty00liSZvMHqbAEUlnznW1aTOv1QKf10RU\nsWTmrYj1kbogeeSgGeYLvQ==\n-----END PRIVATE KEY-----\n";
const cert="-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUJf9TGTWi+5p5nb53GDk9skeW8fQwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwNjAzNDkwOVoXDTM2MTAw\nMzAzNDkwOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEAjGcBqYY4wHKSkwnqqJdyOqn1HE0QPjOpo/ri4sJTwcRU\nQG8tlcXSknu/CiNFCeFoiHII2xf+N0CKhgaw5DC5IAb4hewD+Yi/dxDGItpg1TT2\nkcrhGlhMyoT5/QKfVLFySviyokCbf2ajbb1xjtJS9Jg7VJJfq3nnoFRkC61BkO1E\nctiS0aK+QRSW8U8Ij+wKwXtew++UJ6b0KMPNe6E3ju1IBf8sxCbp61t3lalyGHdF\naAxKWYrkoTAY+zKchjlJnb6+Uhymf8QPJkL9OZRqtfB2EVo2DTBbWYjERkkkbNZB\nttQBTDdO088WbRWdWQy3JlYSAtkD74sWdku9xoVJLwIDAQABo28wbTAdBgNVHQ4E\nFgQUiqg0wOBhXHIiXQcKzq8W9pAq1CgwHwYDVR0jBBgwFoAUiqg0wOBhXHIiXQcK\nzq8W9pAq1CgwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAD1S5R1qpJ40zoNmep/nxvqq2J8zOQOc\nnGY+c0GRb1l0MBPShEQxqqdraQiiNTPv3Q5I0VeE8ZzjStiTuVIOi/6/bBV77yu5\nnszwarCLJEYPYna1VbCXm7eziVe7YqpI/W7/gCuPV6QKl6e3g03zVob5cQh0/e9+\nm92zm4djfmgbnYVawDeiYWJ+i4H0W2nrzMkoCHerr+feiPJ8GC4Oq8GWVurIVpXX\nJZQLEuNuWPgb1/Li0bM0wSTL1AORwYQtfuMHKK40QqQf+HoPoppmGWTughME8bPR\nteUjN9VYc+Huc0pW8aSZXlclJqwyV8TzNfLLJx0RM7AxYHh2BrXgM0k=\n-----END CERTIFICATE-----\n";
const root=process.cwd(), dataRoot=path.resolve(process.env.UI_SMOKE_DATA_ROOT||root), dataDir=await fs.mkdtemp(path.join(dataRoot,'radar-orders-ui-'));
const credentialsKey=randomBytes(32).toString('hex');
const nonce=randomBytes(4).toString('hex'), id=key=>key+'-'+nonce;
let available=false,total=9.5,createdOrders=0,paymentRequests=0,paidOrders=0,invoiceExtra=0,invoiceCurrency="USD",loginRequests=0,affiliateVisits=0,affiliateOrders=0,expired=false,layoutChanged=false,affWorking=true,requireOtp=true,sessionSequence=0,validSession='logged-in';
let stalledAI=0,droppedProgress=0;
const aiRequests=[],messages=[],errors=[],orderRequestTimes=[];let productReads=0,overwriteAffOnSubmit=false,accountBalance=100,hideBalance=false,productCurrency='USD',foreignGateway=false;const invoices=new Map();let actualGateway=false,gatewayRadio=false,paymentConfirmation='Paid',gatewayLabel='Alipay',paymentLayoutChanged=false,externalCashier=false,replayRedirect=false,replayedPayments=0,gatewayFee=false,swapMethodOnPay=false,cashierReads=0;let cashierBase;
const password='private-site-password-'+nonce, username='buyer@example.test';
let sourceBase;
const checkout={submitSelector:'#'+id('submit'),productSelector:'#'+id('product'),quantitySelector:'#'+id('quantity'),totalSelector:'#'+id('total'),currencySelector:'#'+id('currency'),confirmationSelector:'#'+id('confirmation')};
const transactionClick=(extra='')=>'onclick="'+extra+'event.preventDefault();setTimeout(()=>this.form.requestSubmit(),120)" ';
const gatewayMarkup=invoice=>{
 const key=id(invoice?'invoice-choice':'checkout-choice'),name=id('opaque-route'),label=invoice?'支付宝':gatewayLabel;
 return gatewayRadio?'<fieldset><legend>付款方式</legend><label><input type="radio" name="'+name+'" value="route_003" checked>Credit Card</label><label for="'+key+'">'+label+'</label><input type="radio" id="'+key+'" name="'+name+'" value="route_017" '+(invoice&&gatewayFee?'onchange="document.getElementById(&#39;'+id('invoice-total')+'&#39;).textContent=&#39;USD 10.50&#39;"':'')+'></fieldset>':'<label>付款方式 / Payment option<select id="'+key+'" name="'+name+'"><option value="route_003">Credit Card</option><option value="route_017">'+label+'</option><option value="route_025">Account Balance</option></select></label>';
};
const cashier=http.createServer((_req,res)=>{cashierReads++;res.end('Scan QR to pay');});
const mock=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');const authenticated=(req.headers.cookie||'').split(';').some(v=>v.trim()==='shop_session='+validSession);let raw='';for await(const part of req)raw+=part;
  if(url.pathname==='/v1/chat/completions'){
    aiRequests.push(JSON.parse(raw));
    const content=JSON.parse(raw).messages.at(-1).content,evidence=JSON.parse(Array.isArray(content)?content.find(part=>part.type==='text').text:content);
    if(evidence.order.instruction==='timeout-once'&&stalledAI===0){stalledAI++;res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":');return;}
    if(evidence.order.instruction==='hold-to-cancel')await pause(5000);
    let result;
    if(evidence.phase==='business_sop')result={summary:'核对月付商品及授权交易',workflow:{version:2,requirements:[{name:'Cycle',value:'Monthly'}]}};
    else{
      const {page,context,order}=evidence;
      const element=name=>page.elements.find(el=>el.id===id(name)||el.id===id(name)+'-changed');
      const target=(meaning,el)=>{assert.ok(el,'Current observed '+meaning);return {meaning:meaning.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()).replace(/-/g,'_'),ref:el.ref,confidence:0.95};};
      const bind=name=>target(name,element(name));
      const action=(action,details={})=>({action,reason:'Use the observed fixture controls',...details});
      const payment=invoice=>{
        const el=element(invoice?'invoice-choice':'checkout-choice');if(!el)return null;
        const wanted=order.paymentMethod?.kind==='balance'?'route_025':/paypal/i.test(order.paymentMethod?.name)?'missing_paypal':'route_017';
        return {target:target('payment_method',el),value:wanted};
      };
      if(context.submissionStarted){
        if(element('invoice-link'))result=action('invoice',{target:bind('invoice-link')});
        else result=action('pay',{bindings:{pay:target('pay',element('pay')||element('gateway-submit')),invoice:bind('invoice'),total:bind('invoice-total'),currency:bind('invoice-currency'),...(element('balance')?{balance:bind('balance'),balanceCurrency:bind('balance-currency')}:{})},...(payment(true)?{paymentMethod:payment(true)}:{})});
      }else if(element('cart')){
        const cycle=page.elements.find(el=>el.tag==='select'&&el.name==='cycle');
        result=action('configure',{target:bind('cart'),bindings:{product:bind('product')},configuration:[{name:'Cycle',target:target('cycle',cycle)}]});
      }else{
        const steps=[action('fill',{target:bind('quantity'),valueFrom:'quantity'}),action('select',{target:bind('billing'),value:'monthly'}),action('check',{target:bind('terms')})];
        if(order.executionMode==='pay'&&payment(false))steps.push(action('choosePayment',payment(false)));
        steps.push(action('review',{bindings:Object.fromEntries(['submit','product','quantity','total','currency'].map(name=>[name,bind(name)])),configuration:(evidence.workflow.requirements||[]).map(item=>({name:item.name,target:bind('billing')}))}));
        result={steps};
      }
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));return;
  }
  if(url.pathname==='/aff'){affiliateVisits++;res.writeHead(302,{'set-cookie':'partner_credit='+(affWorking?url.searchParams.get('aff'):'wrong')+(overwriteAffOnSubmit?'; Path=/':'; HttpOnly; Path=/'),'location':'/product'});res.end();return;}
  if(url.pathname==='/login'&&req.method==='GET'){
    if(!expired&&authenticated){res.writeHead(302,{location:'/product'});res.end();return;}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<html><head><style>button{position:absolute;left:20px;top:120px;width:100px;height:40px}</style></head><body><form action="/login" method="post"><label>网站账号<input name="username" id="'+id('username')+'"></label><label>网站密码<input name="password" id="'+id('password')+'" type="password"></label><button id="'+id('login')+'">Log in</button></form></body></html>');return;
  }
  if(url.pathname==='/verify-login'&&req.method==='POST'){assert.equal(new URLSearchParams(raw).get('otp'),'123456');expired=false;res.writeHead(302,{'set-cookie':'shop_session='+validSession+'; HttpOnly; Path=/','location':'/product'});res.end();return;}
  if(url.pathname==='/hook'){messages.push(JSON.parse(raw));res.end('ok');return;}
  if(url.pathname==='/pay'){
    paymentRequests++;assert.equal(req.method,'POST');assert.ok(authenticated,'Stored session must track rotating login cookies');const invoiceId=new URLSearchParams(raw).get('invoiceid');assert.equal(invoiceId,String(createdOrders));assert.ok(actualGateway||accountBalance>=invoices.get(invoiceId).total,'Insufficient balance must not reach payment endpoint');
    if(actualGateway)assert.equal(new URLSearchParams(raw).get(id('opaque-route')),'route_017','Actual opaque payment field must carry the selected Alipay value');
    if(externalCashier){res.writeHead(303,{location:'/handoff?id='+invoiceId});res.end();return;}
    if(replayRedirect){res.writeHead(307,{location:'/pay-again'});res.end();return;}
    paidOrders++;invoices.get(invoiceId).paid=true;res.writeHead(303,{location:'/invoice?id='+invoiceId});res.end();return;
  }
  if(url.pathname==='/handoff'){res.writeHead(303,{location:cashierBase+'/cashier?ticket=invoice-'+url.searchParams.get('id')});res.end();return;}
  if(url.pathname==='/pay-again'){replayedPayments++;res.end('wrong replay');return;}
  if(url.pathname==='/complete'){const invoiceId=url.searchParams.get('id');assert.ok(invoices.has(invoiceId));res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1 id="'+id('confirmation')+'">Order #'+invoiceId+' created, unpaid</h1><a id="'+id('invoice-link')+'" href="/invoice?id='+invoiceId+'">View invoice</a>');return;}
  if(url.pathname==='/invoice'){
    const invoiceId=url.searchParams.get('id'),invoice=invoices.get(invoiceId);if(!invoice){res.writeHead(404);res.end();return;}
    res.setHeader('content-type','text/html; charset=utf-8');
    if(invoice.paid){res.end('<h1 id="'+id('paid')+'">Invoice #'+invoiceId+' '+paymentConfirmation+'</h1>');return;}
    res.end('<h1 id="'+id('confirmation')+'">Order #'+invoiceId+' created, unpaid</h1><form method="post" action="/pay"><input type="hidden" id="'+id('invoice')+'" name="invoiceid" value="'+invoiceId+'"><p id="'+id('invoice-total')+'">'+invoice.currency+' '+invoice.total.toFixed(2)+'</p><p id="'+id('invoice-currency')+'">'+invoice.currency+'</p>'+(hideBalance?'':'<p id="'+id('balance')+'">Account balance: '+invoice.currency+' '+accountBalance.toFixed(2)+'</p><span id="'+id('balance-currency')+'">'+invoice.currency+'</span>')+(foreignGateway?'<select name="paymentmethod"><option value="card">Credit Card</option></select>':actualGateway?gatewayMarkup(true):'')+'<button '+transactionClick(swapMethodOnPay?'document.getElementById(&#39;'+id('invoice-choice')+'&#39;).value=&#39;route_003&#39;;':'')+'id="'+id(paymentLayoutChanged?'gateway-submit':'pay')+'">'+(actualGateway?'Continue to payment':'Pay now with account balance')+'</button></form>');return;
  }
  if(url.pathname==='/login'&&req.method==='POST'){
    loginRequests++;const values=new URLSearchParams(raw);assert.equal(values.get('username'),username);assert.equal(values.get('password'),password);
    if(requireOtp){res.setHeader('content-type','text/html; charset=utf-8');res.end('<style>button{position:absolute;left:20px;top:120px;width:100px;height:40px}</style><form action="/verify-login" method="post"><label>验证码<input name="otp" type="text"></label><button>Verify login</button></form>');return;}expired=false;res.writeHead(302,{'set-cookie':'shop_session='+validSession+'; HttpOnly; Path=/','location':url.searchParams.get('next')==='config'?'/config':'/product'});res.end();return;
  }
  if(url.pathname==='/create-order'&&req.method==='POST'){
    orderRequestTimes.push(Date.now());
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);const values=new URLSearchParams(raw);assert.equal(values.get('quantity'),'1');assert.equal(values.get('billing'),'monthly');
    if((req.headers.cookie||'').includes('partner_credit=partner-42'))affiliateOrders++;createdOrders++;invoices.set(String(createdOrders),{total:total+invoiceExtra,currency:invoiceCurrency});res.writeHead(303,{location:'/complete?id='+createdOrders});res.end();return;
  }
  if(url.pathname==='/config'){
    const logged=!expired&&authenticated;if(logged){validSession='logged-in-'+(++sessionSequence);res.setHeader('set-cookie','shop_session='+validSession+'; HttpOnly; Path=/');}
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<h1>Product A</h1>'+(logged?'<div style="display:none"><a href="/logout?token='+sessionSequence+'">Log out</a></div><form action="/change-password" method="post"><input type="password" name="current_password"><button>Change password</button></form>':'<form action="/login?next=config" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/configure-cart" method="post"><h2 id="'+id('product')+'">Product A</h2><select name="cycle"><option value="monthly">Monthly</option></select><button id="'+id('cart')+'">Continue</button></form>');return;
  }
  if(url.pathname==='/configure-cart'&&req.method==='POST'){
    assert.match(req.headers.cookie||'',/shop_session=logged-in/);
    res.setHeader('content-type','text/html; charset=utf-8');res.end('<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><input id="'+id('quantity')+'" name="quantity" value="1"><select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option></select><p id="'+id('total')+(layoutChanged?'-changed':'')+'">'+productCurrency+' '+total.toFixed(2)+'</p><p id="'+id('currency')+'">'+productCurrency+'</p>'+(actualGateway?gatewayMarkup(false):'')+'<input id="'+id('terms')+'" type="checkbox" name="terms"><button '+transactionClick(overwriteAffOnSubmit?'document.cookie=&#39;partner_credit=wrong; Path=/&#39;;':'')+'id="'+id('submit')+'">Submit Order</button></form>');return;
  }
  if(url.pathname==='/product'){productReads++;
    const logged=!expired&&authenticated;if(logged){validSession='logged-in-'+(++sessionSequence);res.setHeader('set-cookie','shop_session='+validSession+'; HttpOnly; Path=/');}
    res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<html><head><title>Fixture cloud product</title></head><body><h1>Product A</h1><p>'+(available?'available':'sold out')+'</p>'+(logged?'<div style="display:none"><a href="/logout?token='+sessionSequence+'">Log out</a></div><form action="/change-password" method="post"><input type="password" name="current_password"><button>Change password</button></form>':'<form action="/login" method="post"><input id="'+id('username')+'" name="username"><input id="'+id('password')+'" name="password" type="password"><button id="'+id('login')+'">Log in</button></form>')+'<form action="/create-order" method="post"><h2 id="'+id('product')+'">Product A</h2><label>Quantity<input id="'+id('quantity')+'" name="quantity" value="1"></label><label>Billing<select id="'+id('billing')+'" name="billing"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label><p id="'+id('total')+(layoutChanged?'-changed':'')+'">'+productCurrency+' '+total.toFixed(2)+'</p><p id="'+id('currency')+'">'+productCurrency+'</p>'+(actualGateway?gatewayMarkup(false):'')+'<input id="'+id('terms')+'" type="checkbox" name="terms" value="accepted"><button '+transactionClick(overwriteAffOnSubmit?'document.cookie=&#39;partner_credit=wrong; Path=/&#39;;':'')+'id="'+id('submit')+'">Submit Order</button></form></body></html>');return;
  }
  res.writeHead(404);res.end();
 }catch(error){errors.push(error.message);res.writeHead(500);res.end(error.message);}
});
let browser,child,page,appPort;
const tlsProxy=https.createServer({key,cert},(req,res)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:appPort,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},response=>{
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
});
try{
  sourceBase='http://127.0.0.1:'+await listen(mock);cashierBase='http://127.0.0.1:'+await listen(cashier);const reserve=http.createServer(),port=await listen(reserve);await new Promise(r=>reserve.close(r));appPort=port;const backend='http://127.0.0.1:'+port,base='https://127.0.0.1:'+await listen(tlsProxy);
  const executable=process.env.MONITOR_BROWSER_EXECUTABLE||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':'/usr/bin/chromium');
  const appEnv={...process.env,NODE_ENV:'production',TRUST_PROXY:'1',CREDENTIALS_KEY:credentialsKey,DATA_DIR:dataDir,MONITOR_TEMP_DIR:path.join(dataDir,'browser'),TMPDIR:dataDir,TMP:dataDir,TEMP:dataDir,HOST:'127.0.0.1',PORT:String(port),MONITOR_BROWSER_EXECUTABLE:executable,ORDER_AI_TIMEOUT_MS:'1000',RESEND_API_KEY:'',MAIL_FROM:'',SIGNUP_CODE:''};
  child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:appEnv});
  for(let i=0;i<100;i++){try{if((await fetch(backend+'/api/auth/status')).ok)break;}catch{}await pause(50);}
  browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox'],env:{...process.env,TMPDIR:dataDir,TMP:dataDir,TEMP:dataDir}});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles'});
  await context.route(/\/api\/order-tasks\/[^/]+$/,async route=>{if(route.request().method()==='GET'&&droppedProgress===0){droppedProgress++;await route.abort('failed');}else await route.continue();});
  const post=async(endpoint,data={})=>{const r=await context.request.post(base+endpoint,{data});assert.ok(r.ok(),await r.text());return r.json();};
  const state=()=>context.request.get(base+'/api/state').then(r=>r.json());
  await post('/api/auth/register',{username:'order-ui-user',password:'order-ui-password-123'});
  const settings=await context.request.put(base+'/api/settings',{data:{aiKey:'ai-fixture-key',aiModel:'fixture',aiBaseUrl:sourceBase+'/v1',webhooks:[{id:'hook',name:'下单通知',format:'generic',enabled:true,url:sourceBase+'/hook'}]}});assert.ok(settings.ok());
  const monitor=(await post('/api/monitors',{kind:'webpage',label:'商品补货',url:sourceBase+'/product',keyword:'available',mode:'contains',intervalMinutes:60,webhookIds:['hook'],fetch:{mode:'http',proxy:'direct'}})).monitors[0];
  const accountPath='/api/monitors/'+monitor.id+'/order-account';
  const cookie=(await context.cookies(base)).map(item=>item.name+'='+item.value).join('; ');
  for(const action of ['start','action','finish']){
    const rejected=await fetch(backend+accountPath+'/'+action,{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});
    assert.equal(rejected.status,403,'Plain HTTP credential '+action+' must be rejected');
  }
  const readEncryptedAccount=async()=>{
    const stored=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));
    const account=stored.users.flatMap(user=>user.orderAccounts||[]).find(account=>account.monitorId===monitor.id);
    assert.equal(account.session.encrypted,'aes-256-gcm');
    assert.equal(JSON.stringify(stored).includes(password),false);
    assert.equal(JSON.stringify(stored).includes(validSession),false);
    return account.session;
  };
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/#monitors');assert.equal(new URL(page.url()).protocol,'https:');
  const openMonitor=async()=>{await page.locator('[data-action="edit"][data-id="'+monitor.id+'"]').click();await page.locator('#order-addon').waitFor();};await openMonitor();
  assert.equal(await page.locator('a[href="#orders"]').count(),0);assert.equal(await page.locator('#order-monitor-choices').count(),0);
  await page.locator('#order-login-url').fill(sourceBase+'/login');await page.locator('[data-order-account-action="start"]').click();await page.locator('#order-login-image').waitFor({timeout:30000});
  await page.locator('[data-login-field]').nth(0).fill(username);await page.locator('[data-login-field]').nth(1).fill(password);
  const clickLogin=async()=>{const image=page.locator('#order-login-image');await image.scrollIntoViewIfNeeded();const box=await image.boundingBox();await image.click({position:{x:50*box.width/1280,y:140*box.width/1280}});};
  await clickLogin();await page.waitForFunction(()=>document.querySelectorAll('[data-login-field]').length===1,{timeout:20000});
  await page.locator('[data-order-account-action="finish"]').click();await page.waitForFunction(()=>document.querySelector('[data-order-account-action="finish"]')?.disabled===false);assert.ok(await page.locator('#order-login-image').isVisible(),'Incomplete login must remain open');assert.doesNotMatch(await page.locator('#order-account-status').innerText(),/正在保存/);assert.match(await page.locator('#order-account-status').innerText(),/登录|二次认证/);
  await page.locator('[data-login-field]').fill('123456');await clickLogin();await page.waitForFunction(()=>document.querySelector('#order-login-address')?.textContent.endsWith('/product'),null,{timeout:20000});
  // The browser action completed, but its response was lost. Saving must still
  // consult the merchant's live authentication rather than a rejected UI queue.
  let droppedAction=0;await page.route('**'+accountPath+'/action',async route=>{const response=await route.fetch();droppedAction++;assert.equal((await response.json()).view.loginStatus,'authenticated');await route.abort('failed');});
  await page.locator('[data-login-action="refresh"]').click();await page.waitForFunction(()=>/连接|响应|请求失败/.test(document.querySelector('#order-account-status')?.textContent||''));await page.unroute('**'+accountPath+'/action');assert.equal(droppedAction,1);
  const revisionBeforeSave=(await state()).orderAccounts[0].revision;let finishResponses=0;
  await page.route('**'+accountPath+'/finish',async route=>{
    const response=await route.fetch();finishResponses++;
    if(finishResponses===1){
      assert.equal(await page.locator('#order-addon button:enabled').count(),0,'All related actions must be locked while saving');
      await route.abort('failed');
    }else await route.fulfill({response});
  });
  await page.locator('[data-order-account-action="finish"]').click();await page.waitForFunction(()=>!document.querySelector('#order-login-image'),null,{timeout:15000});
  await page.unroute('**'+accountPath+'/finish');assert.equal(finishResponses,2);assert.equal((await state()).orderAccounts[0].revision,revisionBeforeSave+1);
  assert.match(await page.locator('#order-account-status').innerText(),/登录状态已保存/);console.log('PASS lost login-action and save responses recover with one authoritative save, no duplicate writes or stuck progress');
  let current=await state();assert.equal(current.orderAccounts[0].status,'saved');assert.equal(current.orderAccounts[0].session,undefined);assert.equal(JSON.stringify(current).includes(password),false);assert.equal(loginRequests,1);console.log('PASS private prelogin and 2FA');
  expired=true;await page.locator('[data-order-account-action="check"]').click();await page.waitForFunction(()=>document.querySelector('[data-order-account-action="check"]')?.disabled===false);
  assert.equal((await state()).orderAccounts[0].status,'expired');assert.doesNotMatch(await page.locator('#order-account-status').innerText(),/登录状态已保存|正在验证/);
  expired=false;await page.locator('[data-order-account-action="check"]').click();await page.waitForFunction(()=>document.querySelector('#order-account-status')?.textContent.includes('登录状态已保存'));console.log('PASS failed login check displays authoritative account state and recovers without reopening login');
  const fillForm=async(label,max=20,mode='submit',aff='')=>{await page.locator('#order-label').fill(label);await page.locator('#order-instruction').fill('Monthly billing');await page.locator('#order-product').fill('Product A');await page.locator('#order-url').fill(sourceBase+'/product');await page.locator('#order-max-total').fill(String(max));await page.locator('#order-affiliate-url').fill(aff);await page.locator('[data-order-mode="'+mode+'"]').click();};
  const generate=async()=>{
    const finished=page.waitForResponse(response=>/\/api\/order-tasks\/[^/]+\/generate$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST',{timeout:90000});
    await page.locator('[data-order-editor-action="generate"]').click();
    try{const response=await finished;assert.equal(response.status(),202,await response.text());assert.equal(response.request().postDataJSON().background,true);await page.locator('[data-order-editor-action="enable"]').waitFor();}
    catch(error){const logs=await context.request.get(base+'/api/monitors/'+monitor.id+'/order-execution-logs');console.error('Generation diagnostics:',JSON.stringify(await logs.json()));throw error;}
  };
  const enable=async()=>{await page.locator('[data-order-editor-action="enable"]').click();await page.locator('[data-order-editor-action="run"]').waitFor();};
  const newConfig=async()=>{
    if(await page.locator('[data-order-editor-action="new"]').count()){await page.locator('[data-order-editor-action="new"]').click();return;}
    // Pre-submit failures now reuse their configuration instead of inventing an order.
    const task=(await state()).orderTasks[0];assert.equal(task.status,'needs_validation');assert.equal(task.result,null);assert.equal(task.submissionStartedAt,undefined);
    await page.locator('[data-order-editor-action="generate"]').waitFor();
  };
  const run=async()=>{
    const finished=page.waitForResponse(response=>/\/api\/order-tasks\/[^/]+\/run$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST',{timeout:90000});
    await page.locator('[data-order-editor-action="run"]').click();const response=await finished;assert.equal(response.status(),200);const task=(await response.json()).task;
    if(task.status==='needs_validation'){assert.equal(task.result,null);assert.equal(task.approvedHash,null);assert.equal(task.submissionStartedAt,undefined);await page.locator('[data-order-editor-action="generate"]').waitFor();assert.match(await page.locator('.order-validation').innerText(),/没有提交订单/);}
    else await page.locator('[data-order-editor-action="new"]').waitFor({timeout:90000});
    console.log('PASS execution outcome: '+task.label+' → '+task.status);
  };
  await fillForm('Product A 自动下单',20,'submit',sourceBase+'/aff?aff=partner-42');
  assert.equal(await page.locator('#order-currency').getAttribute('list'),'order-currencies');
  assert.ok(await page.locator('#order-currencies option').count()>=30);
  assert.match(await page.locator('#order-currencies option[value="CAD"]').getAttribute('label'),/加拿大元.*Canadian Dollar/);
  await page.locator('#order-currency').fill('CAD');
  assert.equal(await page.locator('#order-currency').inputValue(),'CAD');
  await page.locator('#order-currency').fill('');
  assert.equal(await page.locator('#order-coupon-code').inputValue(),'');
  assert.equal(await page.locator('[data-order-coupon-failure="stop"]').getAttribute('aria-checked'),'true');
  await page.locator('[data-order-coupon-failure="continue"]').click();
  await page.locator('#order-coupon-code').fill('Save-UI20');const savedCoupon=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/order-tasks'&&response.request().method()==='POST');
  await page.locator('[data-order-editor-action="save"]').click();const couponTask=(await (await savedCoupon).json()).task;assert.equal(couponTask.couponCode,'Save-UI20');assert.equal(couponTask.couponFailurePolicy,'continue');
  await page.reload();await openMonitor();assert.equal(await page.locator('#order-coupon-code').inputValue(),'Save-UI20');assert.equal(await page.locator('[data-order-coupon-failure="continue"]').getAttribute('aria-checked'),'true');
  await page.locator('[data-order-coupon-failure="stop"]').click();
  await page.locator('#order-coupon-code').fill('');await page.locator('#order-product').fill('');
  console.log('PASS optional coupon configuration persists across reload and can be cleared');
  assert.equal(await page.locator('#order-currency').inputValue(),'');assert.equal(await page.locator('#order-currency').getAttribute('required'),null);assert.equal(await page.locator('#order-product').getAttribute('required'),null);
  const ordersBeforePick=createdOrders;
  const previewResponse=page.waitForResponse(response=>response.url().endsWith('/order-product/preview')&&response.request().method()==='POST');
  await page.locator('[data-order-product-pick]').click();const previewId=(await (await previewResponse).json()).id;await page.frameLocator('#order-product-window iframe').locator('h2').click();
  const discarded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/element-preview'&&response.request().method()==='DELETE');await page.locator('[data-order-product-confirm]').click();assert.ok((await discarded).ok());
  assert.equal((await context.request.post(base+'/api/monitors/'+monitor.id+'/order-product/select',{data:{previewId,index:0,url:sourceBase+'/product'}})).status(),404,'Confirmed previews are no longer retained');
  const canceledResponse=page.waitForResponse(response=>response.url().endsWith('/order-product/preview')&&response.request().method()==='POST');await page.locator('[data-order-product-pick]').click();const canceledId=(await (await canceledResponse).json()).id;
  const canceledDiscard=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/element-preview'&&response.request().method()==='DELETE');await page.locator('[data-order-product-close]').click();assert.ok((await canceledDiscard).ok());assert.equal(await page.locator('#order-product-window iframe').count(),0);
  assert.equal((await context.request.post(base+'/api/monitors/'+monitor.id+'/order-product/select',{data:{previewId:canceledId,index:0,url:sourceBase+'/product'}})).status(),404,'Canceled previews are released');

  await page.waitForFunction(()=>document.querySelector('#order-product-selection')?.textContent.includes('已点选'));assert.equal(createdOrders,ordersBeforePick);assert.equal(paymentRequests,0);
  await page.locator('#order-instruction').fill('timeout-once');const requestsBeforeTimeout=aiRequests.length;
  await page.locator('[data-order-editor-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-order-editor-action="generate"]')?.disabled===false,null,{timeout:30000});
  assert.equal((await state()).orderTasks[0].errorCode,'ORDER_AI_TIMEOUT');assert.equal(aiRequests.length-requestsBeforeTimeout,1);assert.equal(stalledAI,1);
  await generate();assert.equal(droppedProgress,1);assert.equal(aiRequests.length-requestsBeforeTimeout,3);assert.equal(createdOrders,ordersBeforePick);assert.equal(paymentRequests,0);console.log('PASS a stalled AI body stops without replay; manual retry and lost progress polling remain usable');
  await page.locator('[data-order-coupon-failure="continue"]').click();await enable();
  assert.equal((await state()).orderTasks[0].couponFailurePolicy,'continue');assert.equal((await state()).orderTasks[0].trial,null);
  await page.locator('[data-order-editor-action="pause"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor();
  await page.locator('[data-order-coupon-failure="stop"]').click();
  await page.locator('#order-coupon-code').fill('Changed-after-trial');await enable();
  assert.equal((await state()).orderTasks[0].couponCode,'Changed-after-trial');assert.equal((await state()).orderTasks[0].trial,null);
  await page.locator('[data-order-editor-action="pause"]').click();await page.locator('[data-order-editor-action="enable"]').waitFor();
  await page.locator('#order-coupon-code').fill('');await generate();console.log('PASS enable saves edited coupon settings without requiring another trial');
  assert.equal(createdOrders,0);assert.equal(paymentRequests,0);assert.equal(loginRequests,1,'Generation reuses saved session');current=await state();let task=current.orderTasks[0];assert.equal(task.monitorId,monitor.id);assert.equal(task.product,'');assert.equal(task.currency,'');assert.equal(task.verifiedProduct,'Product A');assert.equal(task.verifiedCurrency,'USD');assert.ok(task.productSelection);assert.equal(task.trial.affiliate.status,'verified');assert.equal(task.trial.affiliate.name,'partner_credit');
  const orderLogPath='/api/monitors/'+monitor.id+'/order-execution-logs';
  const readLogs=async()=>{const response=await context.request.get(base+orderLogPath);assert.ok(response.ok());return (await response.json()).report;};
  await page.locator('[data-order-log-action="view"]').click();await page.waitForFunction(()=>document.querySelector('[data-order-log-content]')?.value.includes('webhook-radar/order-execution-log'));
  let logReport=JSON.parse(await page.locator('[data-order-log-content]').inputValue());
  assert.equal(logReport.timeZone,'Asia/Shanghai');assert.equal(logReport.schemaVersion,2);assert.match(logReport.exportedAt,/\+08:00$/);
  for(const operation of logReport.operations){assert.match(operation.startedAt,/\+08:00$/);for(const event of operation.events)assert.match(event.at,/\+08:00$/);}
  const aiStart=logReport.operations.flatMap(operation=>operation.events).find(event=>event.action==='AI 请求开始');assert.ok(aiStart.requestId);assert.equal(aiStart.model,'fixture');assert.ok(aiStart.input.textChars>0);
  assert.ok(logReport.operations.some(operation=>operation.events.some(event=>event.action==='AI 传输信息'&&event.httpStatus===200)));
  assert.equal(logReport.operations.length,1);assert.equal(logReport.operations[0].kind,'generate');const generationLog=logReport.operations.find(log=>log.kind==='generate'&&log.taskId===task.id);assert.equal(generationLog.status,'passed');assert.deepEqual(generationLog.events.filter(event=>event.action==='试跑通过').map(event=>event.pass),[1]);assert.equal(generationLog.program.workflow.version,2);
  for(const secret of [username,password,'logged-in'])assert.ok(!JSON.stringify(logReport).includes(secret));
  const writesBeforeLog=createdOrders,paymentsBeforeLog=paymentRequests,aiBeforeLog=aiRequests.length;
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedOrderLog=text;}}}));
  await page.locator('[data-order-log-action="copy"]').click();await page.waitForFunction(()=>window.__copiedOrderLog?.includes('webhook-radar/order-execution-log'));assert.equal(await page.evaluate(()=>window.__copiedOrderLog),await page.locator('[data-order-log-content]').inputValue());
  const downloading=page.waitForEvent('download');await page.locator('[data-order-log-action="download"]').click();const download=await downloading;assert.ok(download.suggestedFilename().endsWith('-Asia-Shanghai.txt'));const downloaded=JSON.parse(await fs.readFile(await download.path(),'utf8'));await download.delete();assert.equal(downloaded.format,'webhook-radar/order-execution-log');assert.deepEqual(downloaded.operations,(await readLogs()).operations);assert.equal(downloaded.timeZone,'Asia/Shanghai');
  assert.ok(await page.locator('.order-trace time').count());const displayTime=await page.locator('.order-trace time').first().textContent();assert.match(displayTime,/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
  await page.locator('[data-order-log-action="refresh"]').click();assert.equal(createdOrders,writesBeforeLog);assert.equal(paymentRequests,paymentsBeforeLog);assert.equal(aiRequests.length,aiBeforeLog);assert.ok(!Object.hasOwn(await state(),'orderExecutionLogs'));
  const logScreenshots=process.env.UI_SMOKE_SCREENSHOT_DIR?path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR):path.join(root,'release','orders-ui-smoke');await fs.mkdir(logScreenshots,{recursive:true});
  await page.setViewportSize({width:1440,height:1000});await page.locator('.order-execution-log').screenshot({path:path.join(logScreenshots,'desktop-execution-log.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('.order-execution-log').screenshot({path:path.join(logScreenshots,'mobile-execution-log.png')});await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-order-log-action="close"]').click();assert.equal(await page.locator('[data-order-log-panel]').isVisible(),false);
  console.log('PASS execution log view, copy and UTF-8 download include the preflight, redact login secrets and never execute code');
  assert.equal(JSON.stringify(aiRequests).includes(password),false);assert.equal(JSON.stringify(aiRequests).includes(username),false);assert.equal(JSON.stringify(aiRequests).includes('logged-in'),false);
  const output=process.env.UI_SMOKE_SCREENSHOT_DIR?path.resolve(process.env.UI_SMOKE_SCREENSHOT_DIR):path.join(root,'release','orders-ui-smoke');await fs.mkdir(output,{recursive:true});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(output,'desktop-monitor-orders.png'),fullPage:true});
  for(const width of[768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Integrated order page overflow at '+width);}
  await page.screenshot({path:path.join(output,'mobile-monitor-orders.png'),fullPage:true});assert.equal(await page.locator('#order-addon details,#order-addon dialog,#order-addon select:visible').count(),0);await page.setViewportSize({width:1440,height:1000});
  await enable();available=true;const triggeredAt=Date.now(),readsBefore=productReads,aiBeforeTrigger=aiRequests.length;await post('/api/monitors/'+monitor.id+'/check');
  for(let i=0;i<200;i++){current=await state();if(current.orderTasks.find(t=>t.id===task.id).result)break;await pause(50);}
  task=current.orderTasks.find(t=>t.id===task.id);assert.equal(task.status,'ordered',task.error||JSON.stringify(task.result));assert.equal(task.result.affiliate.status,'sent');assert.equal(affiliateOrders,1);assert.equal(createdOrders,1);assert.equal(loginRequests,1);
  await post('/api/monitors/'+monitor.id+'/check');await pause(100);assert.equal(createdOrders,1);assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),400);
  const triggerMs=orderRequestTimes[0]-triggeredAt;assert.equal(aiRequests.length,aiBeforeTrigger,'Normal trigger cannot wait for AI');assert.ok(productReads-readsBefore-2<=2,'Fast path must avoid duplicate product GETs');console.log('ORDER SPEED: '+triggerMs+' ms to actual merchant POST, '+(productReads-readsBefore-2)+' checkout page reads (excluding monitor checks)');console.log('PASS AFF attributed one-shot monitor trigger');if(!process.env.ORDER_SPEED_ONLY){await page.reload();await openMonitor();await newConfig();await fillForm('付款与页面自动修复',20,'pay');await generate();await enable();const beforeRepair=aiRequests.length;layoutChanged=true;await run();
  current=await state();task=current.orderTasks[0];assert.equal(task.status,'paid',task.error||JSON.stringify(task.result));assert.equal(task.repairs.length,0);assert.equal(aiRequests.length,beforeRepair+2);assert.equal(createdOrders,2);assert.equal(paymentRequests,1);assert.equal(paidOrders,1);const executionLog=(await readLogs()).operations.find(log=>log.kind==='execute'&&log.taskId===task.id);assert.equal(executionLog.status,'paid');assert.ok(executionLog.events.some(e=>e.action==='步骤来源'&&e.source==='learned'));assert.ok(executionLog.events.some(e=>e.action==='许可请求已发出'&&e.transaction==='submission'));assert.ok(executionLog.events.some(e=>e.action==='许可请求已发出'&&e.transaction==='payment'));assert.equal(executionLog.result.receipt.invoiceId,'2');console.log('PASS AI repair and payment with durable execution diagnostics');assert.equal(task.result.invoiceId,'2');assert.equal(task.result.payment.total,9.5);
  assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),400);assert.equal(paymentRequests,1);
  await newConfig();await fillForm('预算保护');await generate();await enable();total=50;const beforeBudget=aiRequests.length;await run();assert.match((await state()).orderTasks[0].error,/总价超过/);assert.equal(aiRequests.length,beforeBudget,'Current price is rebound by the observed element ID and checked against the budget without another AI call');assert.equal(createdOrders,2);total=9.5;
  await newConfig();await fillForm('付款金额保护',20,'pay');await generate();await enable();invoiceExtra=1;const beforeInvoice=aiRequests.length;await run();current=await state();assert.equal(current.orderTasks[0].status,'payment_failed');assert.match(current.orderTasks[0].error,/付款金额/);assert.equal(aiRequests.length,beforeInvoice+2);assert.equal(createdOrders,3);assert.equal(paymentRequests,1);invoiceExtra=0;
  await newConfig();await fillForm('AFF 错误保护',20,'submit',sourceBase+'/aff?aff=partner-42');await generate();await enable();affWorking=false;await run();current=await state();assert.match(current.orderTasks[0].error,/AFF/);assert.equal(createdOrders,3);assert.equal(affiliateOrders,1);affWorking=true;
  await newConfig();await fillForm('真实请求归因变化保护',20,'submit',sourceBase+'/aff?aff=partner-42');await generate();await enable();overwriteAffOnSubmit=true;const beforeLost=createdOrders;await run();current=await state();assert.match(current.orderTasks[0].error,/AFF.*请求/);assert.equal(createdOrders,beforeLost,'Missing attribution must be blocked before merchant POST');assert.equal(affiliateOrders,1);overwriteAffOnSubmit=false;
  await newConfig();await fillForm('登录过期保护');await generate();await enable();expired=true;await run();current=await state();assert.match(current.orderTasks[0].error,/登录/);assert.equal(current.orderAccounts[0].status,'expired');assert.equal(createdOrders,3);assert.equal(loginRequests,1);expired=false;
  await page.locator('[data-order-account-action="check"]').click();await page.waitForFunction(()=>document.querySelector('#order-account-status')?.textContent.includes('已保存'));
  await newConfig();await fillForm('跨页面修复');await page.locator('#order-url').fill(sourceBase+'/config');const beforeCart=aiRequests.length;await generate();assert.equal(aiRequests.length-beforeCart,3);assert.equal(createdOrders,3);await enable();await run();assert.equal(createdOrders,4);
  await newConfig();await fillForm('可停止生成');await page.locator('#order-instruction').fill('hold-to-cancel');const pending=aiRequests.length;await page.locator('[data-order-editor-action="generate"]').click();for(let i=0;i<150&&aiRequests.length===pending;i++)await pause(50);assert.ok(aiRequests.length>pending);await page.locator('#order-cancel').click();await page.waitForFunction(()=>document.querySelector('[data-order-editor-action="generate"]')?.disabled===false,{timeout:20000});assert.equal((await state()).orderTasks[0].enabled,false);assert.equal(createdOrders,4);
  const other=await browser.newContext({ignoreHTTPSErrors:true});await other.request.post(base+'/api/auth/register',{data:{username:'order-ui-other',password:'order-ui-password-123'}});assert.equal((await other.request.get(base+accountPath)).status(),404);assert.equal((await other.request.get(base+orderLogPath)).status(),404);assert.equal((await other.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),404);await other.close();
  const operationIdsBeforeRestart=(await readLogs()).operations.map(log=>log.id);
  await readEncryptedAccount();
  // Saved credentials survive an app restart; interrupted operations never resume.
  child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:appEnv});
  for(let i=0;i<100;i++){try{if((await fetch(backend+'/api/auth/status')).ok)break;}catch{}await pause(50);}
  assert.deepEqual((await readLogs()).operations.map(log=>log.id),operationIdsBeforeRestart,'Logs survive service restart');
  await readEncryptedAccount();
  await post(accountPath+'/check');assert.equal((await state()).orderAccounts[0].status,'saved');assert.equal(createdOrders,4);assert.equal(loginRequests,1);assert.ok(affiliateVisits>=4);
  const pendingConfig=await post('/api/order-tasks',{label:'余额不足保留账单',url:sourceBase+'/product',product:'',quantity:1,maxTotal:20,executionMode:'pay',monitorId:monitor.id});
  await page.reload();await openMonitor();await generate();await enable();accountBalance=0;const paymentsBeforePending=paymentRequests;await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'awaiting_payment',task.error||JSON.stringify(task.result));assert.equal(task.result.paymentPending.reason,'insufficient_balance');assert.equal(task.result.invoiceId,'5');assert.match(task.result.url,/\/invoice\?id=5$/);assert.equal(task.paymentStartedAt,undefined);
  assert.equal(paymentRequests,paymentsBeforePending);assert.equal(createdOrders,5);assert.ok(await page.locator('#order-addon a[href="'+task.result.url+'"]').isVisible());assert.ok((await context.request.get(task.result.url)).ok());
  await post('/api/monitors/'+monitor.id+'/check');assert.equal(createdOrders,5);assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/run',{data:{}})).status(),400);
  await newConfig();await fillForm('自动识别币种后变更会拦截');await generate();await enable();productCurrency='EUR';await run();current=await state();assert.match(current.orderTasks[0].error,/币种/);assert.equal(createdOrders,5);productCurrency='USD';
  await newConfig();await fillForm('无法核实余额保留账单',20,'pay');await generate();await enable();accountBalance=100;hideBalance=true;await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'awaiting_payment',task.error||JSON.stringify(task.result));assert.equal(task.result.paymentPending.reason,'balance_unverified');assert.equal(task.result.invoiceId,'6');assert.equal(paymentRequests,paymentsBeforePending);assert.equal(createdOrders,6);hideBalance=false;
  const otherProduct=await browser.newContext({ignoreHTTPSErrors:true});await otherProduct.request.post(base+'/api/auth/register',{data:{username:'product-other',password:'product-other-password-123'}});assert.equal((await otherProduct.request.post(base+'/api/monitors/'+monitor.id+'/order-product/preview',{data:{url:sourceBase+'/product'}})).status(),404);await otherProduct.close();
  await page.screenshot({path:path.join(output,'desktop-balance-pending.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(output,'mobile-balance-pending.png'),fullPage:true});
  await newConfig();await fillForm('禁止改用银行卡付款',20,'pay');await generate();await enable();foreignGateway=true;await run();current=await state();assert.equal(current.orderTasks[0].status,'awaiting_payment');assert.equal(createdOrders,7);assert.equal(paymentRequests,paymentsBeforePending);foreignGateway=false;
  await newConfig();await fillForm('自动识别 EUR 并用余额支付',20,'pay');await page.locator('#order-product').fill('');productCurrency='EUR';invoiceCurrency='EUR';await generate();current=await state();assert.equal(current.orderTasks[0].verifiedCurrency,'EUR');await enable();await run();current=await state();assert.equal(current.orderTasks[0].status,'paid',JSON.stringify(current.orderTasks[0].result));assert.equal(current.orderTasks[0].result.payment.currency,'EUR');assert.equal(createdOrders,8);assert.equal(paymentRequests,paymentsBeforePending+1);productCurrency='USD';invoiceCurrency='USD';

  actualGateway=true;
  await newConfig();await fillForm('中英文付款方式预选',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();
  const beforeGatewayGeneration=aiRequests.length;await generate();current=await state();task=current.orderTasks[0];assert.equal(task.verifiedPaymentMethod.label,'Alipay');assert.equal(task.verifiedPaymentMethod.value,'route_017');assert.equal(createdOrders,8);assert.equal(paymentRequests,paymentsBeforePending+1);
  assert.equal(await page.locator('#order-addon select').count(),0,'App payment choices never add a dropdown');assert.ok(await page.locator('[data-order-payment-name="Alipay"]').isVisible());
  await enable();await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'paid',task.error||JSON.stringify(task.result));assert.equal(task.result.payment.paymentMethod.label,'支付宝');assert.equal(createdOrders,9);assert.equal(paymentRequests,paymentsBeforePending+2);assert.equal(aiRequests.length,beforeGatewayGeneration+4,'Two preparation calls and two original-invoice planning calls');
  await page.screenshot({path:path.join(output,'mobile-payment-choice.png'),fullPage:true});
  await newConfig();await fillForm('不支持的方式启用前发现',20,'pay');await page.locator('[data-order-payment-name="PayPal"]').click();await page.locator('[data-order-editor-action="generate"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-order-editor-action="generate"]')?.disabled===false,{timeout:30000});current=await state();assert.equal(current.orderTasks[0].status,'needs_validation');assert.equal(current.orderTasks[0].result,null);assert.equal(current.orderTasks[0].submissionStartedAt,undefined);assert.equal(current.orderTasks[0].enabled,false);assert.equal(createdOrders,9);assert.equal(paymentRequests,paymentsBeforePending+2);
  await page.locator('[data-order-payment-name="Alipay"]').click();await generate();await enable();paymentLayoutChanged=true;const beforePaymentAssist=aiRequests.length;await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'paid',task.error||JSON.stringify(task.result));assert.equal(aiRequests.length,beforePaymentAssist+2);assert.equal(createdOrders,10);assert.equal(paymentRequests,paymentsBeforePending+3);paymentLayoutChanged=false;
  await newConfig();await fillForm('收银台待扫码',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();await enable();externalCashier=true;await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'awaiting_payment',task.error||JSON.stringify(task.result));assert.equal(task.result.paymentPending.reason,'external_payment');assert.ok(task.result.paymentPending.cashierUrl.startsWith(cashierBase+'/cashier'));assert.equal(cashierReads,0,'Server never performs payment actions at the external cashier');assert.ok(await page.locator('#order-addon a[href="'+task.result.paymentPending.cashierUrl+'"]').isVisible());assert.equal(createdOrders,11);assert.equal(paymentRequests,paymentsBeforePending+4);externalCashier=false;
  await newConfig();await fillForm('付款请求选择被替换',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();await enable();swapMethodOnPay=true;const beforeTamper=aiRequests.length;await run();current=await state();task=current.orderTasks[0];
  assert.equal(task.status,'uncertain',task.error||JSON.stringify(task.result));assert.match(task.error,/付款方式/);assert.equal(aiRequests.length,beforeTamper+2);assert.equal(createdOrders,12);assert.equal(paymentRequests,paymentsBeforePending+4);swapMethodOnPay=false;

  gatewayRadio=true;
  await newConfig();await fillForm('实际 radio 标签核对',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();current=await state();assert.equal(current.orderTasks[0].verifiedPaymentMethod.control,'radio');await enable();await run();current=await state();assert.equal(current.orderTasks[0].status,'paid',JSON.stringify(current.orderTasks[0].result));assert.equal(createdOrders,13);assert.equal(paymentRequests,paymentsBeforePending+5);
  await newConfig();await fillForm('失败提示不能当支付成功',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();await enable();paymentConfirmation='Payment unsuccessful';const beforeBadConfirmation=aiRequests.length;await run();current=await state();assert.equal(current.orderTasks[0].status,'uncertain',JSON.stringify(current.orderTasks[0].result));assert.match(current.orderTasks[0].error,/缺少本次付款成功提示/);assert.equal(aiRequests.length,beforeBadConfirmation+2);assert.equal(createdOrders,14);assert.equal(paymentRequests,paymentsBeforePending+6);paymentConfirmation='Paid';

  await newConfig();await fillForm('付款跳转不能重发 POST',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();await enable();replayRedirect=true;const beforeReplay=aiRequests.length;await run();current=await state();assert.equal(current.orderTasks[0].status,'uncertain',JSON.stringify(current.orderTasks[0].result));assert.match(current.orderTasks[0].error,/重发/);assert.equal(replayedPayments,0);assert.equal(aiRequests.length,beforeReplay+2);assert.equal(createdOrders,15);assert.equal(paymentRequests,paymentsBeforePending+7);replayRedirect=false;

  await newConfig();await fillForm('付款选项不能偷偷变更金额',20,'pay');await page.locator('[data-order-payment-name="支付宝"]').click();await generate();await enable();gatewayFee=true;const beforeFee=aiRequests.length;await run();current=await state();assert.equal(current.orderTasks[0].status,'payment_failed',JSON.stringify(current.orderTasks[0].result));assert.match(current.orderTasks[0].error,/金额发生变化/);assert.equal(aiRequests.length,beforeFee+2);assert.equal(createdOrders,16);assert.equal(paymentRequests,paymentsBeforePending+7);gatewayFee=false;
  console.log('PASS preselected Alipay/支付宝 with opaque fields, unsupported method blocked during trial, same-order AI payment assistance, external cashier handoff and actual POST method binding');
  console.log('PASS blank product/currency, private manual product selection, hidden logout login proof, currency change guard, insufficient/unknown balance and reachable pending invoice without payment or repeat orders');

  }

  actualGateway=true;gatewayRadio=true;
  available=false;await post('/api/monitors/'+monitor.id+'/check');
  await page.reload();await openMonitor();await newConfig();await fillForm('补货直接下单');
  const directOrders=createdOrders,directReads=productReads;await enable();current=await state();task=current.orderTasks[0];
  assert.equal(task.enabled,true);assert.equal(task.trial,null);assert.equal(task.program,null);assert.equal(productReads,directReads);
  assert.equal((await context.request.post(base+'/api/order-tasks/'+task.id+'/enable',{data:{expectedRevision:task.revision-1}})).status(),409);
  available=true;await post('/api/monitors/'+monitor.id+'/check');
  for(let i=0;i<400;i++){current=await state();if(current.orderTasks.find(item=>item.id===task.id).result)break;await pause(50);}
  task=current.orderTasks.find(item=>item.id===task.id);assert.equal(task.status,'ordered',task.error);assert.equal(task.trial,null);assert.equal(createdOrders,directOrders+1);
  const directLog=(await readLogs()).operations[0];assert.equal(directLog.kind,'execute');assert.equal(directLog.events.filter(event=>event.action==='打开执行浏览器').length,1);
  await post('/api/monitors/'+monitor.id+'/check');assert.equal(createdOrders,directOrders+1);
  console.log('PASS direct enable with no trial, one browser session and one order on restock');
  assert.deepEqual(errors,[]);console.log('PASS integrated monitor ordering, private interactive prelogin with 2FA and restart, real AFF Cookie on order request, AI-generated DOM repair before submission, actual scoped payment, budget/invoice/AFF/login protections, cancellation, tenant isolation, mobile layout');
}catch(error){if(page)console.error('Order smoke UI state:',await page.locator('#order-status,#order-account-status,#toast').allTextContents());throw error;}finally{
  await browser?.close();if(child){child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
  tlsProxy.closeAllConnections();await new Promise(r=>tlsProxy.close(r));mock.closeAllConnections?.();cashier.closeAllConnections?.();await Promise.all([new Promise(r=>mock.close(r)),new Promise(r=>cashier.close(r))]);const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(dataRoot+path.sep)&&path.basename(resolved).startsWith('radar-orders-ui-'));await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
