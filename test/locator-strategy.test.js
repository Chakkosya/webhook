import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Locators} from '../src/locators/index.js';
test('a selector is attempted once, immediately falls back, and observed success rates reorder later lookups',async()=>{
 const records=[],rates=[];let selectorCalls=0,visualCalls=0,pointingCalls=0;
 const target={count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true};
 const page={locator:selector=>{if(selector==='#old'){selectorCalls++;return {...target,count:async()=>0};}return target;},screenshot:async()=>Buffer.from('screen'),evaluate:async()=>{pointingCalls++;return '[data-workflow-anchor="active"]';}};
 const repository={ranking:()=>rates,locator:(...args)=>records.push(args)};
 const visual={locate:async()=>{visualCalls++;return {x:20,y:20};}},locators=new Locators(repository,{visual}),step={id:'submit',target:{selector:'#old',anchor:{file:'button.png'}}};
 assert.equal((await locators.resolve(page,'test',step)).strategy,'visual');
 assert.equal(selectorCalls,1);assert.equal(visualCalls,1);assert.equal(pointingCalls,1);assert.deepEqual(records.map(item=>[item[2],item[3]]),[['selector',false],['visual',true]]);
 rates.push({strategy:'selector',rate:0},{strategy:'visual',rate:1});
 assert.equal((await locators.resolve(page,'test',step)).strategy,'visual');assert.equal(selectorCalls,1);assert.equal(visualCalls,2);
});
