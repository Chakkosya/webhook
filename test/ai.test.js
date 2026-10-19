import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfflineAssistant} from '../src/ai/index.js';
test('offline AI gets classified logs without account configuration or screenshots',async()=>{
  const command=new OfflineAssistant({command:process.execPath,args:['-e',"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))));"]});
  const result=await command.diagnose({bindings:{password:'must-not-send'},error:{category:'TIMEOUT',message:'original timeout'},steps:[{id:'cart',action:'cart',status:'failed',durationMs:21000}],evidence:{screenshot:'private.png',structure:[{tag:'BUTTON',id:'submit'}]}});
  assert.equal(result.task,'diagnose');assert.equal(result.input.error.message,'original timeout');assert.equal(result.input.bindings,undefined);assert.equal(result.input.screenshot,undefined);
});
