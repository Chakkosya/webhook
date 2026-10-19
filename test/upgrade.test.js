import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime} from '../src/runtime.js';
import {serve} from '../src/server.js';

test('runtime starts with a hexadecimal key and leaves legacy state untouched',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-upgrade-')),runtime=new Runtime(dir);
  const key=randomBytes(32).toString('hex')+'\n',state=JSON.stringify({users:[]});
  let app;
  try {
    await writeFile(join(dir,'credentials.key'),key);
    await writeFile(join(dir,'state.json'),state);
    await runtime.open();
    app=await serve({runtime,port:0,host:'127.0.0.1'});
    const base='http://127.0.0.1:'+app.server.address().port;
    const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(5000)});
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{status:'ok'});
    const status=await fetch(base+'/api/status',{signal:AbortSignal.timeout(5000)});
    assert.equal(status.status,200);
    assert.equal((await status.json()).configured,false);
    assert.equal(await readFile(join(dir,'credentials.key'),'utf8'),key);
    assert.equal(await readFile(join(dir,'state.json'),'utf8'),state);
  } finally {
    if(app)await app.close();else await runtime.close();
    await rm(dir,{recursive:true,force:true});
  }
});
