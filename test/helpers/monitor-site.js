import {createServer} from 'node:http';
export async function monitorSite() {
  const state={quantity:0,price:150,content:'Initial announcement',writes:0,reads:0,aiCalls:0,aiRequests:[],invented:false,priceAsStock:false,abnormal:false,notifications:[]};
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    if(req.url==='/v1/chat/completions') {
      const body=JSON.parse(text),request=JSON.parse(body.messages[1].content);state.aiCalls++;state.aiRequests.push(request);
      let result={ok:true};
      if(request.task==='create-monitor') {
        const {kind}=request.input,identity={selector:'#product-name',text:'Fixture server'};
        const rule=kind==='stock'?{type:'stock-count',identity,scope:'#product-card',selector:state.priceAsStock?'#price':'#stock-count',pattern:state.priceAsStock?'^\\$(\\d+)$':'^(\\d+) Available$'}:
          kind==='price'?{type:'number',identity,selector:'#price',operator:'below',value:100}:
          kind==='text'?{type:'text',identity,selector:'#announcement',operator:'contains',value:'Available'}:{type:'change',identity,selector:'#announcement'};
        if(state.invented)rule.selector='#invented';
        result={name:'Fixture monitor',explanation:'关注所选商品，命中后复查并提醒。',rule};
      }
      res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
    }
    if(req.url==='/notify'&&req.method==='POST'){state.notifications.push(JSON.parse(text));res.end('ok');return;}
    if(req.method==='POST'||req.url?.includes('a=checkout')){state.writes++;res.end('Unexpected write');return;}
    state.reads++;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    if(state.abnormal)return res.end('<h1>Sign in required</h1>');
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Fixture catalog</title></head><body><main id="product-card"><h1 id="product-name">Fixture server</h1><p id="stock-count">'+state.quantity+' Available</p><p id="price">$'+state.price+'</p><p id="announcement">'+state.content+'</p><form id="cart"><input type="hidden" name="pid" id="product-id" value="5"><button id="buy" type="submit">Order now</button></form></main><script>fetch("/order",{method:"POST"}).catch(()=>{});fetch("/cart.php?a=checkout").catch(()=>{});</script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {state,origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
export async function idle(manager,id) {
  const deadline=Date.now()+10000;
  while(manager.running.get(id)?.busy){if(Date.now()>deadline)throw new Error('Monitor did not finish its check');await new Promise(resolve=>setTimeout(resolve,30));}
}
