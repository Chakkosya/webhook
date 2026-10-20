import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Runtime} from '../src/runtime.js';
import {merchant} from './helpers/merchant.js';
test('visual workflow capture creates a candidate with both locators for every action and retains admission gates',async()=>{
 const fixture=await merchant(),dir=await mkdtemp(join(tmpdir(),'visual-workflow-')),runtime=await new Runtime(dir).open();
 try{
  await runtime.configure({site:fixture.site,intent:fixture.intent,headless:true,parameters:{}});
  runtime.repository.create(fixture.workflow);
  const candidate=await runtime.captureWorkflow({workflowId:fixture.workflow.id,version:1});
  assert.equal(candidate.state,'candidate');assert.equal(candidate.streak,0);
  for(const step of candidate.document.steps)if(step.action!=='navigate'){assert.ok(step.target.selector);assert.ok(step.target.anchor?.file);}
  assert.throws(()=>runtime.repository.publish(candidate.id,candidate.version),{code:'UNVERIFIED'});
  const first=await runtime.execute({workflowId:candidate.id,version:candidate.version,mode:'trial'}),second=await runtime.execute({workflowId:candidate.id,version:candidate.version,mode:'trial'});
  assert.equal(first.status,'trial-ready',JSON.stringify(first.error));assert.equal(second.status,'trial-ready',JSON.stringify(second.error));
  assert.equal(runtime.repository.publish(candidate.id,candidate.version).state,'verified');
  assert.equal(fixture.state.submitted,0);assert.equal(first.aiInferenceCalls,0);
 }finally{await runtime.close();await fixture.close();await rm(dir,{recursive:true,force:true});}
});
