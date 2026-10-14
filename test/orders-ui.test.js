import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/orders-ui.js',import.meta.url),'utf8');
test('order editor renders optional login verification inputs for new and saved accounts',()=>{
  for(const account of [undefined,{monitorId:'monitor',loginUrl:'https://shop.example/login',checkUrl:'https://shop.example/account',loggedInSelector:'#account-name',status:'saved'}]){
    const root={innerHTML:'',querySelectorAll:()=>[]};
    const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},appState:{monitors:[{id:'monitor',url:'https://shop.example/product'}],orderAccounts:account?[account]:[]},$:selector=>selector==='#order-addon'?root:null,escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;')});
    vm.runInContext(source,context);
    vm.runInContext("orderMonitorId='monitor';openOrderEditor();",context);
    for(const [id,value] of [['order-login-url',account?.loginUrl||'https://shop.example/product'],['order-check-url',account?.checkUrl||''],['order-login-selector',account?.loggedInSelector||'']]){
      const input=root.innerHTML.match(new RegExp('<input id="'+id+'"[^>]*>','g'));
      assert.equal(input?.length,1,id+' must exist exactly once before starting login');
      assert.ok(input[0].includes('value="'+value+'"'));
    }
    assert.match(root.innerHTML,/data-order-login-settings-panel class="hidden"/);
  }
});

test('generation polling retries lost progress responses without resubmitting generation',async()=>{
  const calls=[],responses=[Object.assign(new Error('lost response'),{code:'RADAR_CONNECTION_FAILED'}),{task:{status:'generating'}},{task:{status:'ready'}}];
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},AbortSignal,setTimeout:callback=>callback(),api:async(...args)=>{calls.push(args);const next=responses.shift();if(next instanceof Error)throw next;return next;}});
  vm.runInContext(source,context);
  const result=await context.waitForOrderGeneration('/api/order-tasks/task',{task:{status:'generating'}},()=>true);
  assert.equal(result.task.status,'ready');assert.equal(calls.length,3);
  for(const [path,method] of calls){assert.equal(path,'/api/order-tasks/task');assert.equal(method,'GET');}
  assert.match(source,/api\(path\+'\/generate','POST',\{background:true\}\)/);
});

test('unresolved steps show a concrete confirmation question and candidates',()=>{
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;')});
  vm.runInContext(source,context);
  const html=context.orderValidationReport({status:'needs_validation',executionMode:'prepare',validation:{syntax:'passed'},input:{question:'请选择套餐',reason:'两个同名购买按钮',options:['月付','年付'],candidates:[{label:'购买 <script>',context:'套餐 A',options:['月付','年付']}]},failure:{stage:'planning',category:'needs_input',orderRequestSent:'no',suggestion:'请确认'}});
  assert.match(html,/需要你确认/);assert.match(html,/请选择套餐/);assert.match(html,/套餐 A/);assert.match(html,/月付、年付/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-order-clarification-choice="月付"/);assert.doesNotMatch(html,/阶段：|分类：|代码语法/);
});


test('saved internal format errors no longer ask the user to repair technical fields',()=>{
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},escapeHtml:value=>String(value??'')});
  vm.runInContext(source,context);
  const task={status:'needs_validation',errorCode:'ORDER_WORKFLOW_INVALID',error:'配置要求必须包含 name 和 value',input:{question:'请确认要购买的规格、套餐和周期。',reason:'配置要求必须包含 name 和 value'},failure:{stage:'generation',category:'needs_input',orderRequestSent:'no',suggestion:'请回答当前问题'}};
  const html=context.orderValidationReport(task)+context.orderTaskError(task);
  assert.doesNotMatch(html,/name|value|需要你确认|回答上面|order-clarification-answer|generation|needs_input/);assert.match(html,/购买方案暂时未能整理完成/);assert.match(html,/购买要求已保留/);
});


test('old generic binding questions show the saved product and a retry without an answer box',()=>{
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},escapeHtml:value=>String(value??'').replaceAll('<','&lt;')});
  vm.runInContext(source,context);
  for(const errorCode of ['AGENT_NEEDS_INPUT','AGENT_BINDING_FAILED']){
    const task={status:'needs_validation',product:'Product <A>',errorCode,error:'当前步骤的动态绑定仍不确定，需要你确认。',input:{question:'请确认当前步骤应操作哪个商品、配置项或入口。',reason:'当前步骤的动态绑定仍不确定，需要你确认。'}};
    const html=context.orderValidationReport(task)+context.orderTaskError(task);
    assert.match(html,/已填写的商品：Product &lt;A>/);assert.match(html,/无需重复填写/);
    assert.doesNotMatch(html,/需要你确认|动态绑定|order-clarification-answer|回答上面/);
  }
});

test('choosing a concrete option saves that answer and starts preparation with one click',async()=>{
  let handler,continued=0;const answer={value:''};
  const button={disabled:false,hasAttribute:name=>name==='data-order-clarification-choice',dataset:{orderClarificationChoice:'东京'},closest:()=>({querySelector:()=>({click:()=>continued++})})};
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(type,listener){if(type==='click')handler=listener;}},$:selector=>selector==='#order-clarification-answer'?answer:{}});
  vm.runInContext(source,context);await handler({target:{closest:()=>button}});
  assert.equal(answer.value,'东京');assert.equal(continued,1);
});


test('new, untested and out-of-stock tasks all offer direct enable with optional trial',()=>{
  for(const status of [null,'draft','waiting_stock','needs_validation','ready']){
    const root={innerHTML:'',querySelectorAll:()=>[]},task=status?{id:'task',monitorId:'monitor',status,product:'Product A',executionMode:'submit'}:null;
    const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},appState:{monitors:[{id:'monitor',url:'https://shop.example/product'}],orderTasks:task?[task]:[]},$:selector=>selector==='#order-addon'?root:null,escapeHtml:value=>String(value??'')});
    vm.runInContext(source,context);context.task=task;
    vm.runInContext("orderMonitorId='monitor';openOrderEditor(task);",context);
    assert.match(root.innerHTML,/data-order-editor-action="enable"/);assert.match(root.innerHTML,/可选试跑/);assert.doesNotMatch(root.innerHTML,/补货后请重新生成并验证/);
  }
});

test('enable saves new or changed fields and arms without generating or requiring a trial',async()=>{
  const payload={label:'Product A',url:'https://shop.example/product',product:'Product A',quantity:1,maxTotal:20,currency:'USD',executionMode:'submit',monitorId:'monitor',instruction:'',couponCode:'',couponFailurePolicy:'stop',affiliateUrl:'',autoRepair:true,paymentMethod:{kind:'balance',name:'账户余额'},productSelection:null};
  for(const mode of ['new','saved','edited']){
    const task=mode==='new'?null:{...payload,id:'task',revision:1,status:'waiting_stock',trial:null,instruction:'按配置选择该商品，保留默认配置，在提交前核对订单。'};
    const input={...payload,...(task?{expectedRevision:task.revision}:{}),...(mode==='edited'?{maxTotal:30}:{})};
    const calls=[],toasts=[];let handler,rendered;
    const form={isConnected:true,querySelector:()=>null,querySelectorAll:()=>[]},status={textContent:''},cancel={classList:{add(){},remove(){}}};
    const button={id:'',disabled:false,hasAttribute:()=>false,dataset:{orderEditorAction:'enable'}};
    const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(type,listener){if(type==='click')handler=listener;}},workspaceEpoch:0,appState:{orderTasks:task?[task]:[]},$:selector=>({'#order-form':form,'#order-status':status,'#order-cancel':cancel}[selector]),toast:(text,error)=>toasts.push({text,error}),api:async(path,method,body)=>{
      calls.push({path,method,body});return {task:{...(task||{}),...input,id:'task',revision:mode==='saved'?1:2,trial:null,status:path.endsWith('/enable')?'armed':'draft'}};
    }});
    vm.runInContext(source,context);context.collectOrderForm=()=>input;context.openOrderEditor=value=>{rendered=value;};
    vm.runInContext("orderEditorId="+JSON.stringify(task?.id||null)+";orderMonitorId='monitor';",context);
    await handler({target:{closest:()=>button}});
    assert.equal(toasts.some(item=>item.error),false,JSON.stringify(toasts));assert.equal(rendered.status,'armed');
    assert.equal(calls.length,mode==='saved'?1:2);assert.equal(calls.at(-1).path,'/api/order-tasks/task/enable');assert.equal(calls.at(-1).body.codeHash,undefined);
    assert.equal(calls.at(-1).body.expectedRevision,mode==='saved'?1:2);
    if(mode!=='saved'){assert.equal(calls[0].method,mode==='new'?'POST':'PUT');assert.equal(calls[0].body.maxTotal,mode==='edited'?30:20);}
    assert.ok(calls.every(call=>!call.path.endsWith('/generate')));
  }
});

test('currency chooser exposes searchable codes and bilingual names, defaults to submission',()=>{
  const root={innerHTML:'',querySelectorAll:()=>[]};
  const context=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){}},appState:{monitors:[{id:'monitor',url:'https://shop.example/product'}]},$:selector=>selector==='#order-addon'?root:null,escapeHtml:value=>String(value??'')});
  vm.runInContext(source,context);vm.runInContext("orderMonitorId='monitor';openOrderEditor();",context);
  assert.match(root.innerHTML,/list="order-currencies"/);assert.match(root.innerHTML,/value="CAD" label="加拿大元 · Canadian Dollar"/);assert.match(root.innerHTML,/data-order-mode="submit" aria-checked="true"/);
  for(const code of ['USD','CNY','HKD','EUR','JPY','GBP','AUD','SGD'])assert.match(root.innerHTML,new RegExp('<option value="'+code+'"'));
  assert.match(context.orderCurrencyField('CAD'),/value="CAD"/);
  assert.equal(context.orderTaskError({errorCode:'AGENT_PLAN_INVALID',error:'动作缺少有效 ref'}),'动作缺少有效 ref');
});
