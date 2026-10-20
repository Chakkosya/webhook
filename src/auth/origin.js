import {fail} from '../errors.js';

const firstHeader=value=>String(value||'').split(',')[0].trim();
function parseOrigin(value){
 try{const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.origin;}catch{}
 return null;
}
export function requestOrigin(req){
 const protocol=firstHeader(req.headers['x-forwarded-proto'])||(req.socket.encrypted?'https':'http');
 const host=firstHeader(req.headers['x-forwarded-host'])||req.headers.host;
 return parseOrigin(protocol+'://'+host);
}
export function secureRequest(req){
 return !!req.socket.encrypted||firstHeader(req.headers['x-forwarded-proto'])==='https'||
  req.headers['sec-fetch-site']==='same-origin'&&parseOrigin(req.headers.origin)?.startsWith('https://')===true;
}
export function assertSameOrigin(req){
 if(req.method!=='POST')return;
 const site=req.headers['sec-fetch-site'],origin=req.headers.origin;
 if(site==='cross-site'||site==='same-site')fail('ORIGIN','仅接受工作台自身发起的操作');
 if(!origin)return;
 const source=parseOrigin(origin);
 if(!source||site!=='same-origin'&&source!==requestOrigin(req))fail('ORIGIN','仅接受工作台自身发起的操作');
}
