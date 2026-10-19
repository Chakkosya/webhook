import {createServer} from 'node:http';
export async function merchant() {
  const state={accountReads:0,stock:'in',logged:true,balance:4200,total:15000,submitted:0,paid:0,cart:0,coupons:0,removed:0,invoices:[],nextId:101,couponInvalid:false,uncertain:false,delayMs:0,layoutChanged:false,completePage:false};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let body='';for await(const chunk of req)body+=chunk;
    const field=(id,value)=>'<input id="'+id+'" value="'+value+'" readonly>';
    const quote=()=>field('product','5')+field('quantity',1)+field('total',(state.total/100).toFixed(2))+field('currency','USD')+field('payment','credit')+field('balance',(state.balance/100).toFixed(2))+field('balance-currency','USD');
    const wrap=html=>'<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px Arial;padding:30px}button{padding:12px;background:#176459;color:white;border:2px solid #123;border-radius:4px}input{display:block;margin:8px}</style></head><body>'+(state.logged?'<a id="account" href="/clientarea.php">Account</a>':'<h1 id="login">Login</h1>')+html+'</body></html>';
    const send=html=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(wrap(html));};
    const redirect=location=>{res.writeHead(303,{Location:location});res.end();};
    const review=()=>'<main id="checkout">'+quote()+'<form method="post" action="/cart.php?a=applypromo"><input id="promo" name="promocode"><button id="apply">Apply</button></form>'+(state.couponInvalid?'<div id="coupon-error">Invalid coupon</div>':'<div id="coupon-ok">Ready</div>')+'<form method="post" action="/cart.php?a=removepromo"><button id="remove">Remove</button></form><form id="submit-form" method="post" action="/cart.php?a=checkout"><input name="pid" value="5" type="hidden"><input name="quantity" value="1" type="hidden"><input name="token" value="csrf-1" type="hidden"><button id="'+(state.layoutChanged?'submit-new':'submit')+'">Create invoice</button></form></main>';
    if(url.pathname==='/clientarea.php'&&url.searchParams.get('action')==='invoices') {
      return send('<section id="history"><table>'+state.invoices.map(r=>'<tr class="invoice-row"><td class="invoice-id">'+r.invoiceId+'</td><td class="product">'+(r.product||'5')+'</td><td class="quantity">1</td><td class="currency">USD</td><td><a class="invoice-link" href="/viewinvoice.php?id='+r.invoiceId+'">Invoice</a></td></tr>').join('')+'</table><p id="history-complete">Complete</p></section>');
    }
    if(url.pathname==='/clientarea.php'){state.accountReads++;return send('<h1>Client area</h1>');}
    if(url.pathname==='/cart.php'&&url.searchParams.has('gid')) {
      const controls=state.stock==='in'?'<form id="stock" method="get" action="/cart.php"><input type="hidden" name="a" value="add"><input name="pid" value="5" type="hidden"><button type="submit">Order now</button></form>':state.stock==='out'?'<p id="sold-out">Out of Stock</p>':'<p>Starting from $150 Monthly Continue</p>';
      return send('<section id="product-card"><h1 id="product-name">Server 5</h1>'+controls+'</section>');
    }
    if(url.pathname==='/cart.php'&&url.searchParams.get('a')==='add') {state.cart++;return send(review());}
    if(url.pathname==='/cart.php'&&url.searchParams.get('a')==='applypromo') {state.coupons++;return send(review());}
    if(url.pathname==='/cart.php'&&url.searchParams.get('a')==='removepromo') {state.removed++;state.couponInvalid=false;return send(review());}
    if(url.pathname==='/cart.php'&&url.searchParams.get('a')==='checkout') {
      state.submitted++;const invoiceId=String(state.nextId++);state.invoices.push({invoiceId});
      if(state.delayMs)await new Promise(r=>setTimeout(r,state.delayMs));
      if(state.uncertain)return send('<p id="pending">Pending</p>');
      return redirect(state.completePage?'/cart.php?a=complete&invoice='+invoiceId:'/viewinvoice.php?id='+invoiceId);
    }
    if(url.pathname==='/cart.php'&&url.searchParams.get('a')==='complete')return send('<main id="complete"><a id="invoice-link" href="/viewinvoice.php?id='+url.searchParams.get('invoice')+'">Invoice</a></main>');
    if(url.pathname==='/viewinvoice.php') {
      const id=url.searchParams.get('id');
      if(req.method==='POST'){state.paid++;state.balance-=state.total;}
      return send('<main id="invoice">'+field('invoice-id',id)+quote()+(state.paid?'<p id="paid">Paid</p>':'<form method="post" action="/viewinvoice.php?id='+id+'"><input type="hidden" name="invoiceid" value="'+id+'"><button id="pay">Pay invoice</button></form>')+'</main>');
    }
    res.writeHead(404);res.end('Not found');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const times={order:{samplesMs:[50],marginMs:3000,idleMs:2000},monitor:{samplesMs:[50],marginMs:1500,idleMs:1000}};
  const site={adapter:'whmcs',account:'main',product:'5',origin,provenance:{source:'local WHMCS fixture DOM'},currencyDecimals:2,accountUrl:origin+'/clientarea.php',historyUrl:origin+'/clientarea.php?action=invoices',monitorUrl:origin+'/cart.php?gid=5',orderUrl:origin+'/cart.php?a=add&pid=5',timing:times,authenticated:[{kind:'visible',selector:'#account'}],
    reads:[{path:'/clientarea.php'},{path:'/clientarea.php',query:{action:'invoices'}},{path:'/cart.php',query:{gid:'5'}},{path:'/viewinvoice.php',query:{id:'$digits'}}],
    writes:[{operation:'cart',method:'GET',path:'/cart.php',query:{a:'add',pid:'5'}},{operation:'coupon',method:'POST',path:'/cart.php',query:{a:'applypromo'}},{operation:'coupon-remove',method:'POST',path:'/cart.php',query:{a:'removepromo'}},{operation:'submit',method:'POST',path:'/cart.php',query:{a:'checkout'}},{operation:'pay',method:'POST',path:'/viewinvoice.php',query:{id:'$digits'}}],
    stock:{scope:'#product-card',page:[{kind:'text',selector:'#product-name',equals:'Server 5'}],form:'#stock',fields:[{selector:'input[name="pid"]',value:'5'}],submit:'button[type="submit"]',soldOut:[{kind:'visible',selector:'#sold-out'}]},
    history:{complete:[{kind:'visible',selector:'#history-complete'}],rows:'.invoice-row',fields:{invoiceId:'.invoice-id',product:'.product',quantity:'.quantity',currency:'.currency'}},
    quote:{product:'#product',quantity:'#quantity',total:'#total',currency:'#currency',paymentMethod:'#payment'},
    invoice:{url:{path:'/viewinvoice.php',query:{id:'$digits'}},id:'#invoice-id',idQuery:'id'},
    payment:{balance:'#balance',balanceCurrency:'#balance-currency',reviewBalance:'#balance',reviewBalanceCurrency:'#balance-currency',paid:[{kind:'visible',selector:'#paid'}]},
    coupon:{invalid:[{kind:'visible',selector:'#coupon-error'}],remove:{target:{selector:'#remove'},request:{method:'POST',path:'/cart.php',query:{a:'removepromo'}},post:[{kind:'absent',selector:'#coupon-error'}]}}
  };
  const workflow={schema:1,id:'whmcs-server-5',provenance:{kind:'site-recording',source:'local WHMCS fixture DOM'},couponPolicy:'remove-and-continue',steps:[
    {id:'catalog',action:'navigate',url:site.monitorUrl,pre:[{kind:'visible',selector:'#account'}],post:[{kind:'visible',selector:'#product-card'}],timing:times},
    {id:'cart',action:'cart',target:{selector:'#stock button'},request:site.writes[0],pre:[{kind:'visible',selector:'#stock'}],post:[{kind:'visible',selector:'#checkout'}],timing:times},
    {id:'submit',action:'submit',target:{selector:'#submit'},request:site.writes[3],pre:[{kind:'visible',selector:'#submit-form'}],post:[{kind:'visible',selector:'#invoice'}],timing:times}
  ]};
  const intent={key:'purchase-1',account:'main',product:'5',quantity:1,currency:'USD',budgetMinor:15000,paymentMethod:'credit'};
  return {state,site,workflow,intent,close:()=>new Promise(r=>server.close(r))};
}
