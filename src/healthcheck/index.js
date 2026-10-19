import {spawn} from 'node:child_process';
import {fail} from '../errors.js';
const scripts={
  cpu:'LC_ALL=C; uname -a; lscpu',
  io:'LC_ALL=C; df -h /; f=$(mktemp); trap \'rm -f "$f"\' EXIT; dd if=/dev/zero of="$f" bs=1M count=128 conv=fdatasync 2>&1',
  network:'LC_ALL=C; ip -brief address; ip route',
  route:'LC_ALL=C; if command -v tracepath >/dev/null 2>&1; then tracepath -m 12 1.1.1.1; else ping -c 4 -W 3 1.1.1.1; fi'
};
export async function healthcheck({host,user,port=22,identityFile,checks=['cpu','io','network','route'],timeoutMs=120000}) {
  if(!host||host.startsWith('-')||!user||user.startsWith('-')||!Number.isInteger(port)||port<1||port>65535||checks.some(c=>!scripts[c]))fail('HEALTHCHECK','SSH 主机、用户、端口或检查项无效');
  const results=[];
  for(const check of checks) {
    const args=['-o','BatchMode=yes','-o','ConnectTimeout=15','-p',String(port),...(identityFile?['-i',identityFile]:[]),user+'@'+host,'sh','-s'];
    results.push(await new Promise(resolve=>{
      const started=Date.now(),child=spawn('ssh',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill();resolve({check,status:'timeout',durationMs:Date.now()-started,stdout,stderr});},timeoutMs);
      child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
      child.on('error',e=>{clearTimeout(timer);resolve({check,status:'failed',message:e.message});});
      child.on('exit',code=>{clearTimeout(timer);resolve({check,status:code===0?'passed':'failed',exitCode:code,durationMs:Date.now()-started,stdout,stderr});});
      child.stdin.on('error',()=>{});child.stdin.end(scripts[check]+'\n');
    }));
  }
  return {host,at:new Date().toISOString(),results};
}
