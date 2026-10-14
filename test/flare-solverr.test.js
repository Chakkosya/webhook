import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlareSolverrClient,flareSolverrClient} from '../lib/flare-solverr.js';

const clearance={name:'cf_clearance',value:'challenge-cookie',domain:'.example.com',path:'/',secure:true,httpOnly:true,sameSite:'None'};
function fixture(options={}){
  const calls=[],env={FLARESOLVERR_ENABLED:'1',...options.env};
  let time=1700000000000,serial=0;
  const client=createFlareSolverrClient({env,now:()=>time,createSessionId:()=>`session-${++serial}`,
    fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body);calls.push({url,body,init});
      if(options.respond)return options.respond(body,init);
      return {ok:true,json:async()=>({status:'ok',solution:{cookies:options.cookies??[clearance],userAgent:'test-agent'}})};
    },...options.client});
  return {client,calls,env,advance:ms=>{time+=ms;}};
}

test('disabled by default, reads enable flag dynamically and never fetches while disabled',async()=>{
  let calls=0;const env={};
  const client=createFlareSolverrClient({env,fetchImpl:()=>{calls++;throw new Error('not expected');}});
  assert.equal(typeof flareSolverrClient.solve,'function');
  assert.equal(client.enabled(),false);
  assert.deepEqual(await client.solve('not a URL'),{cookies:[],userAgent:'',clearanceObtained:false});
  env.FLARESOLVERR_ENABLED='1';assert.equal(client.enabled(),true);
  env.FLARESOLVERR_ENABLED='0';await client.solve('https://example.com');assert.equal(calls,0);
});

test('creates a v1 session and returns normalized Playwright cookies and user agent',async()=>{
  const {client,calls}=fixture();
  assert.deepEqual(await client.solve('https://shop.example.com/login'),{
    cookies:[{...clearance,expires:-1}],userAgent:'test-agent',clearanceObtained:true
  });
  assert.equal(calls[0].url,'http://flaresolverr:8191/v1');
  assert.deepEqual(calls[0].body,{cmd:'sessions.create',session:'session-1'});
  assert.deepEqual(calls[1].body,{cmd:'request.get',session:'session-1',url:'https://shop.example.com/login',maxTimeout:60000,session_ttl_minutes:15});
  assert.equal(calls[1].init.redirect,'error');
});

test('filters unrelated, expired and host-only cookies and ignores non-Playwright fields',async()=>{
  const {client}=fixture({cookies:[
    clearance,{...clearance,name:'other',domain:'.notexample.com'},
    {...clearance,name:'suffix',domain:'.example.com.evil.test'},
    {...clearance,name:'host',domain:'example.com'},
    {...clearance,name:'host-only',hostOnly:true},
    {...clearance,name:'expired',expires:1699999999},
    {...clearance,name:'exact',domain:'shop.example.com',path:'invalid',sameSite:'lax',expiry:1800000000,extra:'ignored'},
    {name:'missing-domain',value:'x'},null
  ]});
  const result=await client.solve('https://shop.example.com');
  assert.deepEqual(result.cookies.map(cookie=>cookie.name),['cf_clearance','exact']);
  assert.deepEqual(result.cookies[1],{name:'exact',value:'challenge-cookie',domain:'shop.example.com',path:'/',sameSite:'Lax',expires:1800000000,secure:true,httpOnly:true});
  const noClearance=fixture({cookies:[{...clearance,name:'ordinary'}]});
  assert.equal((await noClearance.client.solve('https://example.com')).clearanceObtained,false);
});

test('reuses sessions, expires in minutes and destroys before creating a replacement',async()=>{
  const {client,calls,advance}=fixture({env:{FLARESOLVERR_SESSION_TTL:'2'}});
  await client.solve('https://example.com/one');
  advance(119999);await client.solve('https://example.com/two');
  assert.deepEqual(calls.map(call=>call.body.cmd),['sessions.create','request.get','request.get']);
  advance(1);await client.solve('https://example.com/three');
  assert.deepEqual(calls.slice(3).map(call=>call.body.cmd),['sessions.destroy','sessions.create','request.get']);
  assert.equal(calls[3].body.session,'session-1');assert.equal(calls[5].body.session,'session-2');
  assert.equal(calls[5].body.session_ttl_minutes,2);
});

test('separates account, origin and proxy sessions and serializes simultaneous reuse',async()=>{
  const {client,calls}=fixture();
  await Promise.all([client.solve('https://example.com',{sessionKey:'a'}),client.solve('https://example.com',{sessionKey:'a'})]);
  await client.solve('https://example.com',{sessionKey:'b'});
  await client.solve('https://other.example.com',{sessionKey:'a'});
  await client.solve('https://example.com',{sessionKey:'a',proxyUrl:'http://proxy.example:8080'});
  assert.equal(calls.filter(call=>call.body.cmd==='sessions.create').length,4);
  const gets=calls.filter(call=>call.body.cmd==='request.get');
  assert.equal(gets[0].body.session,gets[1].body.session);
});

test('bounded session cache destroys the oldest session before eviction',async()=>{
  const {client,calls}=fixture({client:{maxSessions:1}});
  await client.solve('https://example.com',{sessionKey:'a'});
  await client.solve('https://example.com',{sessionKey:'b'});
  assert.deepEqual(calls.map(call=>call.body.cmd),['sessions.create','request.get','sessions.destroy','sessions.create','request.get']);
});

test('proxy credentials are decoded only into sessions.create; account credentials are never sent',async()=>{
  const {client,calls}=fixture({env:{FLARESOLVERR_URL:'http://solver.example:8191/',FLARESOLVERR_TIMEOUT_MS:'1234'}});
  await client.solve('https://example.com',{proxyUrl:'http://alice:p%40ss@proxy.example:8080',sessionKey:'account-id',credentials:{password:'merchant-secret'}});
  assert.equal(calls[0].url,'http://solver.example:8191/v1');
  assert.deepEqual(calls[0].body.proxy,{url:'http://proxy.example:8080',username:'alice',password:'p@ss'});
  assert.equal(calls[1].body.proxy,undefined);
  assert.equal(calls[1].body.maxTimeout,1234);
  assert.equal(JSON.stringify(calls.map(call=>call.body)).includes('merchant-secret'),false);
  assert.equal(JSON.stringify(calls.map(call=>call.body)).includes('account-id'),false);
});

test('service, transport, JSON and malformed URL errors expose only fixed safe messages',async()=>{
  for(const respond of [
    async()=>({ok:false,json:async()=>({message:'secret-response'})}),
    async()=>({ok:true,json:async()=>({status:'error',message:'secret-cookie'})}),
    async()=>{throw new Error('proxy-password secret');},
    async()=>({ok:true,json:async()=>{throw new Error('secret JSON');}}),
    async()=>({ok:true,json:async()=>({status:'ok'})})
  ]){
    const {client}=fixture({respond});
    await assert.rejects(client.solve('https://example.com'),error=>{
      assert.equal(error.message,'FlareSolverr challenge solving failed');
      assert.equal(error.code,'FLARESOLVERR_FAILED');assert.equal(error.cause,undefined);return true;
    });
  }
  const {client,calls}=fixture();
  await assert.rejects(client.solve('https://account:secret@example.com'),{code:'FLARESOLVERR_FAILED'});
  await assert.rejects(client.solve('https://example.com',{proxyUrl:'invalid-secret'}),{code:'FLARESOLVERR_FAILED'});
  assert.equal(calls.length,0);
});

test('timeout aborts a stuck fetch and returns a fixed error without waiting for fetch cooperation',async()=>{
  const {client,calls}=fixture({env:{FLARESOLVERR_TIMEOUT_MS:'10'},respond:()=>new Promise(()=>{})});
  await assert.rejects(client.solve('https://example.com'),{message:'FlareSolverr request timed out',code:'FLARESOLVERR_TIMEOUT'});
  assert.equal(calls[0].init.signal.aborted,true);
});

test('external abort is sanitized; an already aborted signal does not fetch',async()=>{
  const controller=new AbortController();
  const {client,calls}=fixture({respond:()=>new Promise(()=>{})});
  const solving=client.solve('https://example.com',{signal:controller.signal});
  setImmediate(()=>controller.abort(new Error('secret abort reason')));
  await assert.rejects(solving,{message:'FlareSolverr request cancelled',code:'FLARESOLVERR_ABORTED'});
  await assert.rejects(client.solve('https://example.com',{signal:controller.signal}),{code:'FLARESOLVERR_ABORTED'});
  assert.equal(calls.length,1);assert.equal(calls[0].init.signal.aborted,true);
});

test('overall timeout includes both create and request rather than restarting per command',async()=>{
  const {client,calls}=fixture({env:{FLARESOLVERR_TIMEOUT_MS:'80'},respond:async()=>{
    await new Promise(resolve=>setTimeout(resolve,50));
    return {ok:true,json:async()=>({status:'ok',solution:{cookies:[clearance]}})};
  }});
  await assert.rejects(client.solve('https://example.com'),{code:'FLARESOLVERR_TIMEOUT'});
  assert.equal(calls.length,2);
  assert.equal(calls[1].init.signal.aborted,true);
});

test('queued solves time out without fetching and do not block subsequent accounts',async()=>{
  const {client,calls,env}=fixture({env:{FLARESOLVERR_TIMEOUT_MS:'1000'},respond:async(body)=>{
    if(body.cmd==='request.get'&&body.url==='https://blocked.example.com/')return new Promise(()=>{});
    return {ok:true,json:async()=>({status:'ok',solution:{cookies:[clearance]}})};
  }});
  const controller=new AbortController();
  const first=client.solve('https://blocked.example.com',{signal:controller.signal});
  const firstRejected=assert.rejects(first,{code:'FLARESOLVERR_ABORTED'});
  await new Promise(resolve=>setImmediate(resolve));
  env.FLARESOLVERR_TIMEOUT_MS='15';
  await assert.rejects(client.solve('https://queued.example.com'),{code:'FLARESOLVERR_TIMEOUT'});
  assert.equal(calls.length,2);
  controller.abort();await firstRejected;
  env.FLARESOLVERR_TIMEOUT_MS='1000';
  assert.equal((await client.solve('https://example.com')).clearanceObtained,true);
  assert.equal(calls.some(call=>call.body.url==='https://queued.example.com/'),false);
});

test('failed destruction retires stale sessions instead of blocking account requests',async()=>{
  const {client,calls,advance}=fixture({respond:async(body)=>({ok:body.cmd!=='sessions.destroy',json:async()=>({status:'ok',solution:{cookies:[clearance]}})})});
  await client.solve('https://example.com',{sessionKey:'a'});advance(16*60000);
  assert.equal((await client.solve('https://example.com',{sessionKey:'b'})).clearanceObtained,true);
  assert.equal((await client.solve('https://example.com',{sessionKey:'a'})).clearanceObtained,true);
  assert.equal(calls.filter(call=>call.body.cmd==='sessions.destroy').length,1);
});

test('timed out destruction does not remain at the head of future account requests',async()=>{
  const {client,env,advance}=fixture({respond:async(body)=>{
    if(body.cmd==='sessions.destroy')return new Promise(()=>{});
    return {ok:true,json:async()=>({status:'ok',solution:{cookies:[clearance]}})};
  }});
  await client.solve('https://example.com',{sessionKey:'a'});advance(16*60000);
  env.FLARESOLVERR_TIMEOUT_MS='15';
  await assert.rejects(client.solve('https://example.com',{sessionKey:'b'}),{code:'FLARESOLVERR_TIMEOUT'});
  env.FLARESOLVERR_TIMEOUT_MS='1000';
  assert.equal((await client.solve('https://example.com',{sessionKey:'c'})).clearanceObtained,true);
});

test('disabling an existing client suppresses requests and expired-session cleanup',async()=>{
  const {client,calls,env,advance}=fixture();
  await client.solve('https://example.com');advance(16*60000);env.FLARESOLVERR_ENABLED='0';
  assert.deepEqual(await client.solve('https://example.com'),{cookies:[],userAgent:'',clearanceObtained:false});
  assert.equal(calls.length,2);
});
