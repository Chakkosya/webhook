import {spawn} from 'node:child_process';
import {createServer,connect,isIP} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fail,Fault} from '../errors.js';
const methods=new Set(['aes-128-gcm','aes-256-gcm','chacha20-ietf-poly1305','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305']);
export function parseProxy(input) {
  let url;
  const value=String(input||'').trim();
  if(value.startsWith('ss://')) {
    try {
      let address=value.slice(5).split('#')[0],at=address.lastIndexOf('@'),credentials;
      if(at<0){address=Buffer.from(address,'base64url').toString('utf8');at=address.lastIndexOf('@');}
      if(at<0)throw new Error();
      credentials=address.slice(0,at);
      if(!credentials.includes(':'))credentials=Buffer.from(decodeURIComponent(credentials),'base64url').toString('utf8');
      const colon=credentials.indexOf(':'),method=decodeURIComponent(credentials.slice(0,colon)),password=decodeURIComponent(credentials.slice(colon+1));
      url=new URL('ss://'+address.slice(at+1));
      if(url.searchParams.get('plugin'))fail('PROXY_CONFIG','此 SS 节点需要插件，请改用客户端提供的 HTTP 代理地址');
      if(colon<1||!methods.has(method)||!password||!url.hostname||!url.port||(Number(url.port)<1||Number(url.port)>65535)||!['','/'].includes(url.pathname))throw new Error();
      if(method.startsWith('2022-')) {
        const size=method.includes('aes-128')?16:32;
        if(password.split(':').some(key=>Buffer.from(key,'base64').length!==size))fail('PROXY_CONFIG','SS 2022 密钥长度与加密方式不符');
      }
      return {type:'ss',endpoint:'ss://'+url.host,node:{server:url.hostname.replace(/^\[|\]$/g,''),server_port:Number(url.port),method,password}};
    } catch(error){if(error.code)throw error;fail('PROXY_CONFIG','SS 分享链接无效，请核对服务器、端口、加密方式和密码');}
  }
  try{url=new URL(value);}catch{fail('PROXY_CONFIG','请填写 ss://、HTTP 或 HTTPS 代理地址');}
  if(!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)fail('PROXY_CONFIG','HTTP 代理地址格式不正确');
  return {type:'http',endpoint:url.origin,proxy:{server:url.origin,username:decodeURIComponent(url.username),password:decodeURIComponent(url.password)}};
}
export class ProxyProfiles {
  constructor(store){this.store=store;}
  public(value){return {id:value.id,name:value.name,type:value.type,endpoint:value.endpoint,method:value.node?.method,server:value.node?.server,port:value.node?.server_port};}
  list(){return this.store.list('proxy').map(value=>this.public(value));}
  get(id){return id?this.store.get('proxy',id):null;}
  save(input) {
    const previous=input.id?this.get(input.id):null;
    let value=previous;
    if(input.type==='ss'&&input.server) {
      const host=String(input.server).trim(),port=Number(input.port);
      if(!Number.isInteger(port)||port<1||port>65535)fail('PROXY_CONFIG','端口需为 1–65535 的整数');
      const password=input.password||previous?.node?.password;
      if(!password)fail('PROXY_CONFIG','请填写 SS 密码');
      value=parseProxy('ss://'+encodeURIComponent(input.method)+':'+encodeURIComponent(password)+'@'+(isIP(host)===6?'['+host+']':host)+':'+port);
    } else if(input.url?.trim())value=parseProxy(input.url);
    if(!value)fail('PROXY_CONFIG','请填写代理地址或 SS 节点');
    const name=String(input.name||'').trim();if(!name)fail('PROXY_CONFIG','请为出口填写名称');
    return this.public(this.store.put('proxy',{...value,id:previous?.id,name}));
  }
  delete(id){this.get(id);this.store.delete('proxy',id);}
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listening(port) {
  return new Promise(resolve=>{
    const socket=connect(port,'127.0.0.1');
    const finish=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(200,()=>finish(false));
  });
}
async function stop(child) {
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  const closed=new Promise(resolve=>child.once('close',resolve));
  child.kill();await Promise.race([closed,pause(1500)]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}
}
export async function openProxy(profile,{executable=process.env.SSLOCAL_EXECUTABLE}={}) {
  if(!profile)return {proxy:undefined,close:async()=>{}};
  if(profile.type==='http')return {proxy:profile.proxy,close:async()=>{}};
  if(!executable)fail('PROXY_CLIENT','SS 客户端不可用；Docker 镜像内置客户端，本机运行需设置 SSLOCAL_EXECUTABLE');
  const directory=await mkdtemp(join(tmpdir(),'workflow-ss-'));
  let child;
  try {
    const socket=createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});
    const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const config=join(directory,'client.json');
    await writeFile(config,JSON.stringify({...profile.node,locals:[{protocol:'http',local_address:'127.0.0.1',local_port:port,mode:'tcp_only'}]}),{mode:0o600});
    let launchError,detail='';
    child=spawn(executable,['-c',config],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    child.on('error',error=>{launchError=error;});child.stderr.on('data',data=>{detail=(detail+data).slice(-2000);});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      if(launchError||child.exitCode!==null||child.signalCode!==null)throw new Error('SS 客户端启动失败'+(launchError?.code?'：'+launchError.code:': '+detail.replaceAll(profile.node.password,'[redacted]')));
      if(await listening(port))return {proxy:{server:'http://127.0.0.1:'+port},close:async()=>{await stop(child);await rm(directory,{recursive:true,force:true});}};
      await pause(100);
    }
    throw new Error('SS 客户端启动超时');
  } catch(error){await stop(child);await rm(directory,{recursive:true,force:true});throw new Fault('PROXY_CLIENT',error.message);}
}
