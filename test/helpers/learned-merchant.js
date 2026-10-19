import {createServer} from 'node:http';
export async function learnedMerchant({requireLogin=false}={}) {
  const state={stock:2,orders:[],submissions:0,loggedIn:!requireLogin,logins:0,loginAttempts:0,protectCatalog:false,expireOnSubmit:false};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    const authenticated=!requireLogin||state.loggedIn&&(req.headers.cookie||'').includes('session=fixture-auth');
    const loginForm='<form id="login-form" method="post" action="/session"><input id="username" name="username"><input id="password" name="password" type="password"><button id="login-submit">登录</button></form>';

    const input=(id,value)=>'<input id="'+id+'" value="'+value+'" readonly>';
    const quote=()=>input('sku','edge-s')+input('quantity','1')+input('amount','12.50')+input('currency','CNY')+input('method','wallet');
    const send=html=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><meta charset="utf-8"><body>'+(authenticated?'<a id="account" href="/account">账户</a>':'')+html+'</body></html>');};
    if(url.pathname==='/login')return send(loginForm);
    if(url.pathname==='/session'&&req.method==='POST') {
      state.loginAttempts++;const values=new URLSearchParams(body);
      if(values.get('username')!=='fixture-user'||values.get('password')!=='fixture-secret')return send('<p id="login-error">账号或密码不正确</p>'+loginForm);
      state.logins++;state.loggedIn=true;
      res.writeHead(303,{Location:'/account','Set-Cookie':'session=fixture-auth; Path=/; HttpOnly; Max-Age=3600'});return res.end();
    }
    if(requireLogin&&!authenticated&&(url.pathname.startsWith('/account')||url.pathname.startsWith('/checkout')||url.pathname==='/basket'||state.protectCatalog&&url.pathname.startsWith('/catalog'))) {
      res.writeHead(303,{Location:'/login'});return res.end();
    }
    if(url.pathname==='/account')return send('<h1>账户</h1>');
    if(url.pathname==='/catalog/edge-s')return send('<section id="product"><h1>Edge S</h1><p id="available">剩余 '+state.stock+' 件</p><form method="post" action="/basket"><input name="sku" value="edge-s" type="hidden"><button id="buy">加入购物车</button></form></section>');
    if(url.pathname==='/basket'&&req.method==='POST')return send('<section id="checkout">'+quote()+'<form method="post" action="/checkout/place"><input name="sku" value="edge-s" type="hidden"><input name="method" value="wallet" type="hidden"><button id="place">提交订单</button></form></section>');
    if(url.pathname==='/checkout/place'&&req.method==='POST') {
      state.submissions++;state.orders.push('ORDER-A'+state.submissions);
      if(state.expireOnSubmit){state.loggedIn=false;res.writeHead(303,{Location:'/login'});}else res.writeHead(303,{Location:'/checkout/complete'});return res.end();
    }
    if(url.pathname==='/checkout/complete')return send('<section id="completed"><span id="reference">'+state.orders.at(-1)+'</span></section>');
    if(url.pathname==='/account/orders')return send('<table>'+state.orders.map(id=>'<tr class="order"><td class="reference">'+id+'</td><td class="sku">edge-s</td><td class="quantity">1</td><td class="currency">CNY</td></tr>').join('')+'</table><p id="orders-complete">完整订单记录</p>');
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const timing={order:{samplesMs:[50],marginMs:2500,idleMs:1500},monitor:{samplesMs:[50],marginMs:1500,idleMs:1000}};
  const site={adapter:'learned',account:'main',product:'edge-s',origin,provenance:{source:'local independent store DOM'},currencyDecimals:2,
    accountUrl:origin+'/account',historyUrl:origin+'/account/orders',monitorUrl:origin+'/catalog/edge-s',orderUrl:origin+'/basket',timing,
    authenticated:[{kind:'visible',selector:'#account'}],reads:[{path:'/account'},{path:'/account/orders'},{path:'/catalog/edge-s'},{path:'/checkout/complete'}],
    writes:[{operation:'cart',method:'POST',path:'/basket'},{operation:'submit',method:'POST',path:'/checkout/place'}],
    stock:{scope:'#product',page:[{kind:'text',selector:'#product h1',equals:'Edge S'}],available:'#available',availablePattern:'^剩余 (\\d+) 件$'},
    quote:{product:'#sku',quantity:'#quantity',total:'#amount',currency:'#currency',paymentMethod:'#method'},
    history:{complete:[{kind:'visible',selector:'#orders-complete'}],rows:'.order',fields:{reference:'.reference',product:'.sku',quantity:'.quantity',currency:'.currency'}},
    confirmation:{url:{path:'/checkout/complete'},ready:[{kind:'visible',selector:'#completed'}],id:'#reference',idPattern:'^ORDER-[A-Z0-9]+$'},
    payment:{balanceMethod:'wallet'}};
  if(requireLogin) {
    site.reads.push({path:'/login'});
    site.login={url:origin+'/login',usernameSelector:'#username',passwordSelector:'#password',submitSelector:'#login-submit',request:{method:'POST',path:'/session'},failed:[{kind:'visible',selector:'#login-error'}]};
    site.loggedOut=[{kind:'visible',selector:'#login-form'}];
  }
  const workflow={schema:1,id:'edge-s-order',provenance:{kind:'site-recording',source:'local independent store DOM'},steps:[
    {id:'product',action:'navigate',url:site.monitorUrl,pre:[{kind:'visible',selector:'#account'}],post:[{kind:'visible',selector:'#product'}],timing},
    {id:'cart',action:'cart',target:{selector:'#buy'},request:site.writes[0],pre:[{kind:'visible',selector:'#buy'}],post:[{kind:'visible',selector:'#checkout'}],timing},
    {id:'submit',action:'submit',target:{selector:'#place'},request:site.writes[1],pre:[{kind:'visible',selector:'#checkout'}],post:[{kind:'visible',selector:'#completed'}],timing}
  ]};
  const intent={key:'edge-purchase-1',account:'main',product:'edge-s',quantity:1,currency:'CNY',budgetMinor:1250,paymentMethod:'credit'};
  return {state,site,workflow,intent,close:()=>new Promise(r=>server.close(r))};
}
