import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ObservationBrowser} from './src/browser/observation.js';
import {parseProxy} from './src/browser/proxy.js';
const dir=await mkdtemp(join(tmpdir(),'ss-browser-smoke-'));
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1 id="proof">Encrypted route works</h1>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
const good=new ObservationBrowser({dataDir:dir,id:'correct-key',profile:parseProxy('ss://aes-256-gcm:workflow-ci-password@127.0.0.1:18389')});
const bad=new ObservationBrowser({dataDir:dir,id:'incorrect-key',profile:parseProxy('ss://aes-256-gcm:incorrect-ci-password@127.0.0.1:18389')});
try {
  await good.open();await good.read(url,{absoluteMs:15000,idleMs:10000});
  assert.equal(await good.page.locator('#proof').innerText(),'Encrypted route works');
  await good.close();
  await bad.open();
  await assert.rejects(()=>bad.read(url,{absoluteMs:4000,idleMs:2500}));
  console.log('SS encrypted browser route works; incorrect credentials fail without direct fallback');
}finally{
  await good.close();await bad.close();
  await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
}
