import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OfflineAssistant} from '../src/ai/index.js';
test('the bundled offline provider sends JSON protocol and returns a diagnosis',async t=>{
  let received;
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;received=JSON.parse(text);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({category:'TIMEOUT',report:'页面导航超时',fix:'重新采集导航耗时'})}}]}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const saved={AI_ENDPOINT:process.env.AI_ENDPOINT,AI_MODEL:process.env.AI_MODEL,AI_API_KEY:process.env.AI_API_KEY};
  process.env.AI_ENDPOINT='http://127.0.0.1:'+server.address().port+'/chat/completions';process.env.AI_MODEL='fixture-model';process.env.AI_API_KEY='fixture-key';
  t.after(async()=>{await new Promise(r=>server.close(r));for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const ai=new OfflineAssistant({command:process.execPath,args:['src/ai/provider.js']});
  const result=await ai.diagnose({error:{category:'TIMEOUT',message:'page.goto exceeded observed cap'},steps:[]});
  assert.equal(result.category,'TIMEOUT');assert.equal(received.model,'fixture-model');
  assert.equal(received.response_format.type,'json_object');assert.equal(JSON.parse(received.messages[1].content).task,'diagnose');
});
