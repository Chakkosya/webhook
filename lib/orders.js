import {purchaseSummary} from './order-quantity.js';
import {createRestockRetries,isRestockRetryable,localOrderConflict} from './order-restock.js';
import {queryRecentOrders} from './order-recent-orders.js';
import {readOrderTimeouts,requestOrderAI,createOrderDeadline,abortable} from './order-timeouts.js';
import {orderFailure} from './order-diagnostics.js';
const ORDER_SAFETY_VERSION=4;
import {validateBusinessWorkflow} from '../automation/agent/model.js';
import {BUSINESS_PROMPT,createPlanner,isFuturePageEvidenceRefusal} from '../automation/agent/planner.js';
import {runCommerceAgent} from '../automation/agent/executor.js';
import {createAssistedPlanner} from '../automation/agent/local-planner.js';
import {createSiteMemory} from '../automation/agent/memory.js';
import { randomUUID, createHash } from 'node:crypto';
import { launchCommerceBrowser as createOrderBrowser } from '../automation/browser/launcher.js';
import {discoverCommerceSite} from '../automation/browser/crawler.js';
import { createOrderExecutionLogs, diagnosticError, diagnosticPage, diagnosticReceipt } from './order-execution-log.js';
import { savedOrderAccount, orderAccountFingerprint } from './order-account.js';
import { ORDER_PAYMENT_PROMPT, validateOrderWorkflow, validateOrderProgramScripts, compileOrderWorkflow, runOrderWorkflow, runOrderPaymentCode } from './order-workflow.js';
import { executeOrderScript } from './order-script.js';
import { normalizePaymentMethod } from './order-payment.js';

const DEFAULT_ORDER_INSTRUCTION='按配置选择该商品，保留默认配置，在提交前核对订单。';
const intentKeys=['url','product','productSelection','instruction','quantity','maxTotal','currency','executionMode','monitorId','affiliateUrl','paymentMethod','couponCode','couponFailurePolicy'];
const orderIntentFingerprint=task=>createHash('sha256').update(JSON.stringify(intentKeys.map(key=>task[key]??null))).digest('hex');
const learnedFlowScope=task=>createHash('sha256').update(JSON.stringify([orderIntentFingerprint(task),task.accountFingerprint])).digest('hex');
const required = (value, name, max = 200) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('请填写有效的' + name); return value.trim(); };
export function validateOrderTask(input, current = null) {
  const url = new URL(required(input.url, '商品网址', 2000));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('商品网址必须使用 HTTP 或 HTTPS，且不能包含账号密码');
  const quantity = Number(input.quantity ?? 1), maxTotal = Number(input.maxTotal);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new Error('购买数量必须是 1 到 10 的整数');
  if (!Number.isFinite(maxTotal) || maxTotal <= 0 || maxTotal > 1_000_000) throw new Error('请设置有效的订单总价上限');
  const currency = String(input.currency || '').trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('币种需要使用三位代码，例如 USD');
  if (!['prepare', 'submit', 'pay'].includes(input.executionMode || current?.executionMode || 'submit')) throw new Error('执行范围无效');
  let affiliateUrl = '';
  if(input.affiliateUrl){const aff=new URL(required(input.affiliateUrl,'AFF 链接',2000));if(!['http:','https:'].includes(aff.protocol)||aff.username||aff.password)throw new Error('AFF 链接必须使用不带凭据的 HTTP 或 HTTPS 地址');affiliateUrl=aff.href;}
  let productSelection = null;
  if(input.productSelection){
    const choice=input.productSelection,choiceUrl=new URL(required(choice.url,'选中商品页面',2000));
    if(choiceUrl.href!==url.href||choiceUrl.username||choiceUrl.password)throw new Error('点选商品的页面已变化，请重新点选');
    productSelection={url:choiceUrl.href,selector:required(choice.selector,'点选商品区域',500),text:required(choice.text,'点选商品内容',300)};
  }
  const couponFailurePolicy=input.couponFailurePolicy??'stop';
  if(!['stop','continue'].includes(couponFailurePolicy))throw new Error('优惠码失败处理需要选择停止或继续下单');
  const couponCode=input.couponCode==null?'':input.couponCode;
  if(typeof couponCode!=='string'||couponCode.length>128||/[\x00-\x1f\x7f]/.test(couponCode))throw new Error('优惠码需要是最多 128 字符的单行文本');
  const product=String(input.product||'').trim();if(product.length>200)throw new Error('商品名称或型号过长');
  const username = String(input.username || '').trim(), password = String(input.password || '');
  if (username.length > 254 || password.length > 512) throw new Error('网站账号信息过长');
  if ((username || password) && url.protocol !== 'https:') throw new Error('录入网站账号密码需要 HTTPS 商品地址');
  const next = { id: current?.id || randomUUID(), label: required(input.label || product.slice(0,60) || '自动下单', '任务名称', 60), url: url.href,
    product, productSelection, verifiedProduct:null, verifiedCurrency:null, paymentMethod:normalizePaymentMethod(input.paymentMethod), verifiedPaymentMethod:null, paymentOptions:[], instruction: required(input.instruction || DEFAULT_ORDER_INSTRUCTION, '下单要求', 2000),
    quantity, maxTotal, currency, couponCode:couponCode.trim(), couponFailurePolicy, executionMode: input.executionMode || current?.executionMode || 'submit', monitorId: required(input.monitorId,'对应监控',100), affiliateUrl, autoRepair:input.autoRepair!==false, accountFingerprint:null,
    credentials: input.clearCredentials ? {} : { ...(current?.url && new URL(current.url).origin === url.origin ? current.credentials || {} : {}), ...(username ? {username} : {}), ...(password ? {password} : {}) },
    monitorFingerprint: null, enabled: false, status: 'draft', program: null, approvedHash: null, trial: null, result: null, validation:null, stockAuthorization:null,preparation:null,failure:null,submissionContract:null,
    createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), revision: (current?.revision || 0) + 1 };
  const sameIntent=current&&orderIntentFingerprint(current)===orderIntentFingerprint(next)&&JSON.stringify(current.credentials||{})===JSON.stringify(next.credentials);
  // Revoke execution approval on edits, but retain useful mappings for the same intent.
  next.program=sameIntent&&current.program?.workflow?.version===2?structuredClone(current.program):null;
  next.flowMemory=sameIntent?structuredClone(current.flowMemory||null):null;
  next.error=null;next.errorCode=null;next.progress=null;next.input=sameIntent?structuredClone(current.input||current.failure?.input||null):null;next.userClarification=sameIntent?structuredClone(current.userClarification||null):null;
  if(input.clarificationAnswer!=null&&String(input.clarificationAnswer).trim()){
    const pending=current?.input||current?.failure?.input;
    const sameProduct=current&&current.url===next.url&&current.monitorId===next.monitorId&&current.product===next.product&&JSON.stringify(current.productSelection||null)===JSON.stringify(next.productSelection);
    // An edited product starts fresh; an answer to the old product must not block saving it.
    if(sameProduct){
      if(!pending)throw new Error('当前没有待回答的问题，请重新准备下单。');
      next.input=null;next.userClarification={question:String(pending.question||'').slice(0,1000),answer:required(input.clarificationAnswer,'当前步骤的回答',1500),url:pending.url||current.url,action:pending.action||null,code:pending.code||null,...(pending.requirement?{requirement:pending.requirement}:{}),at:new Date().toISOString()};
      if(pending.kind?.startsWith('page_')){
        const keep=recipe=>!recipe.scope||new URL(recipe.scope.path+(recipe.scope.query||'')+(recipe.scope.fragment||''),recipe.scope.origin).href!==next.userClarification.url;
        if(next.flowMemory)next.flowMemory.recipes=next.flowMemory.recipes.filter(keep);
        if(next.program?.runtimePlan)next.program.runtimePlan=next.program.runtimePlan.filter(keep);
      }
    }
  }
  return next;
}
export function validateOrderProgram(value,{requireWorkflow=false}={}) {
  if (!value || typeof value !== 'object') throw new Error('AI 没有生成有效的下单程序');
  if(value.workflow?.version===2)return {workflow:validateBusinessWorkflow(value.workflow),summary:required(value.summary,'业务流程说明',1500),generatedAt:new Date().toISOString()};
  const workflow=validateOrderWorkflow(value.workflow,{required:requireWorkflow});
  const fields = ['submitSelector', 'productSelector', 'quantitySelector', 'totalSelector', 'currencySelector', 'confirmationSelector'];
  const checkout = Object.fromEntries(fields.map(key => [key, required(value.checkout?.[key], '订单核对字段 ' + key, 500)]));
  const coupon=value.coupon?Object.fromEntries(['inputSelector','applySelector','appliedCodeSelector','discountSelector'].map(key=>[key,required(value.coupon[key],'优惠码核对字段 '+key,500)])):null;
  const affiliate = value.affiliate ? Object.fromEntries(['queryKey','cookieName','fieldSelector'].filter(key=>value.affiliate[key]).map(key=>[key,required(value.affiliate[key],'AFF 核对字段 '+key,500)])) : null;
  const code=workflow?compileOrderWorkflow(workflow,checkout,coupon):required(value.code,'AI 下单代码',24000);
  return { code, checkout, affiliate, ...(coupon?{coupon}:{}), ...(workflow?{workflow}:{}), summary: required(value.summary, '下单步骤说明', 1500), generatedAt: new Date().toISOString() };
}
export function orderProgramHash(task) {
  return createHash('sha256').update(JSON.stringify([ORDER_SAFETY_VERSION,task.submissionContract||null,task.program, task.url, task.product, task.productSelection || null, task.verifiedProduct || null, task.verifiedCurrency || null, normalizePaymentMethod(task.paymentMethod), task.verifiedPaymentMethod || null, task.instruction, task.userClarification||null, task.quantity, task.maxTotal, task.currency, task.executionMode, task.monitorId, task.monitorFingerprint, task.accountFingerprint, task.affiliateUrl, task.autoRepair, task.revision,...(task.couponCode?[task.couponCode]:[]),...(task.couponCode&&task.couponFailurePolicy==='continue'?['coupon-failure:continue']:[])])).digest('hex');
}
function monitorFingerprint(user, task) {
  if (!task.monitorId) throw new Error('请将自动下单附加到对应监控');
  const monitor = user.monitors.find(item => item.id === task.monitorId && item.kind !== 'reminder');
  if (!monitor) throw new Error('绑定的监控已删除，请重新选择触发监控');
  const fields = ['id','kind','type','url','keyword','mode','path','expectedValue','threshold','plan','condition','target_element','extraction_rule','endpoint'];
  return createHash('sha256').update(JSON.stringify(fields.map(key => monitor[key]))).digest('hex');
}
export function publicOrderTask(task) {
  const { credentials, flowMemory, ...publicValue } = task;
  return { ...publicValue, hasCredentials: Boolean(credentials?.username && credentials?.password) };
}
export function createOrderService({ persist, withProxy = async (_url, fn) => fn(''), sourceOptions = () => ({}), requestAI, openBrowser = createOrderBrowser, runScript = executeOrderScript, notify = async () => {}, isAccountBusy = () => false, executionLogs = createOrderExecutionLogs({persist,sourceOptions}), siteMemory = createSiteMemory(), saveEvidence = async () => null, timeouts = readOrderTimeouts(), aiRetries = 1, aiRetryDelayMs = 1000, recentOrders = queryRecentOrders, retryClock = {} }) {
  const budgets={...readOrderTimeouts(),...timeouts};
  const {aiTimeoutMs,agentTimeoutMs,trialTimeoutMs}=budgets;
  const budgetFor=task=>task.trigger==='restock'?{aiTimeoutMs:budgets.restockAiTimeoutMs,agentTimeoutMs:budgets.restockAgentTimeoutMs,trialTimeoutMs}:{aiTimeoutMs,agentTimeoutMs,trialTimeoutMs};
  const busy = new Set(), cancellations = new Map(), activeLogs = new Map(), pendingTriggers = new Map();
  let queueTimer=null;
  const jobKey = (user, task) => user.id + ':' + task.id;
  const operationLog=(user,task)=>activeLogs.get(jobKey(user,task));
  const logEvent=(user,task,action,data={})=>{
    const current=user.orderTasks.find(item=>item.id===task.id)||task;
    if(current.status==='generating'&&['打开执行浏览器','请求 AI 生成代码','动态计划','动态步骤完成','AI 请求超时，重新请求'].includes(action)){
      current.progress={...(current.progress||{}),...(data.stage?{stage:data.stage}:{}),...(data.step?{step:data.step}:{}),action:data.action||action,at:new Date().toISOString()};persist();
    }
    operationLog(user,task)?.event(action,data);
    if(/^(?:AI 请求|AI 响应|动态步骤失败|重新观察并修复)/.test(action))operationLog(user,task)?.checkpoint();
  };
  const askAI=(user,task,messages,options={})=>requestOrderAI(requestAI,user,messages,{timeoutMs:budgetFor(task).aiTimeoutMs,maxRetries:task.trigger==='restock'?2:aiRetries,retryDelayMs:aiRetryDelayMs,...options,onEvent:(action,data)=>logEvent(user,task,action,data)});
  const phase=(user,task,session,value)=>{session.trace.push({action:'SOP',detail:value,at:new Date().toISOString()});logEvent(user,task,'SOP 阶段',{phase:value});};
  const redact = (user, task, value) => { let text=String(value||'');const account=(user.orderAccounts||[]).find(a=>a.monitorId===task.monitorId);for(const secret of [...Object.values(task.credentials||{}),...Object.values(account?.credentials||{}),...(account?.session?.redactions||[]),user.settings?.aiKey,...(user.settings?.aiKeys||[]).map(item=>item.key),user.settings?.sourceProxy,user.monitors.find(m=>m.id===task.monitorId)?.sourceProxy])if(secret)text=text.split(secret).join('[已隐藏]');return text.slice(0,1000); };
  const available = (user,task,{capacity=true}={}) => { if(busy.has(jobKey(user,task))||user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&busy.has(jobKey(user,t))))throw new Error('此监控的下单任务正在执行');if(isAccountBusy(user,task.monitorId))throw new Error('请先结束当前账户登录操作');if(capacity&&busy.size>=2)throw new Error('下单服务繁忙，请稍后再试'); };
  const browserFor = (user,task,callback,extra={}) => {
    const account=savedOrderAccount(user,task),monitor=user.monitors.find(m=>m.id===task.monitorId);
    return withProxy(sourceOptions(user,monitor||{}).proxyUrl,async proxyUrl=>{
      if(extra.signal?.aborted)throw new Error('操作已停止');
      let session;
      logEvent(user,task,'打开执行浏览器',{stage:extra.logStage||'实际执行'});
      try{
        const siteProfile=await siteMemory.read(memoryScope(user,task),task.url);
        session=await openBrowser({...task,accountId:user.id+':'+task.monitorId,credentials:{...account.credentials,...Object.fromEntries((account.session.redactions||[]).map((value,i)=>['login'+i,value]))}},{proxyUrl,siteProfile,storageState:account.session.state,sessionStorageState:account.session.sessionStorage,loginCheck:account.session.check,...extra,trigger:task.trigger||'scheduled',timeoutMs:Math.max(extra.timeoutMs||0,budgetFor(task).agentTimeoutMs+60000),onEvidence:async evidence=>{const saved=await saveEvidence(user,task,evidence);logEvent(user,task,'页面证据已保存',{stage:evidence.stage,evidenceId:saved?.id});return saved;},onTrace:step=>logEvent(user,task,step.action,{stage:extra.logStage||'实际执行',...step})});
        account.status='saved';account.error='';account.testedAt=new Date().toISOString();
        const originalMethods=session.methods;
        session.methods=Object.fromEntries(Object.entries(originalMethods).map(([name,method])=>[name,async(...args)=>{
          const started=Date.now(),meta={stage:extra.logStage||'实际执行',operation:name,...(args[0]?.ref?{target:{meaning:args[0].meaning,ref:args[0].ref,confidence:args[0].confidence}}:{}),...(typeof args[1]==='string'?{inputLength:args[1].length}:{}),selector:name==='goto'?undefined:typeof args[0]==='string'?args[0]:args[0]?.selector||args[0]?.submitSelector||args[0]?.paySelector||args[0]?.inputSelector,url:name==='goto'?args[0]:undefined};
          logEvent(user,task,'代码操作开始',meta);
          try{const output=await method.apply(originalMethods,args);logEvent(user,task,'代码操作完成',{...meta,durationMs:Date.now()-started,...(name==='exists'?{exists:output}:name==='text'?{textLength:String(output).length}:name==='observe'||name==='snapshot'?{page:diagnosticPage({...output,controls:[]})}:name==='resolveSemantic'?{location:output}:name==='readSemantic'?{textLength:String(output?.text||'').length,valueType:typeof output?.value,valueLength:String(output?.value||'').length}:['submit','pay','invoice','applyCoupon'].includes(name)?{receipt:diagnosticReceipt(output)}:{})});return output;}
          catch(error){logEvent(user,task,'代码操作失败',{...meta,durationMs:Date.now()-started,error:diagnosticError(error)});throw error;}
        }]));
        return await abortable(()=>callback(session),extra.signal);
      }catch(error){let page=error.orderEvidence;try{if(session?.diagnostics)page=await session.diagnostics();}catch{}logEvent(user,task,'浏览器执行失败',{stage:extra.logStage||'实际执行',error:diagnosticError(error),page:diagnosticPage(page)});if(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED'].includes(error.code)){account.status=error.code==='ORDER_LOGIN_REQUIRED'?'expired':'unavailable';account.error=redact(user,task,error.message);persist();}throw error;}
      finally{if(session){if(account.status==='saved'&&session.accountState){const previous=account.session;try{account.session={...previous,...await session.accountState()};persist();}catch(error){account.session=previous;logEvent(user,task,'会话刷新失败',{error:diagnosticError(error)});}}await session.close();logEvent(user,task,'执行浏览器已关闭',{stage:extra.logStage||'实际执行'});operationLog(user,task)?.checkpoint();}}
    });
  };
  const inputFor=task=>({...Object.fromEntries(['url','product','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','productSelection','paymentMethod','verifiedPaymentMethod','couponCode','couponFailurePolicy','userClarification'].map(k=>[k,task[k]])),product:task.product||task.verifiedProduct||'',currency:task.currency||task.verifiedCurrency||''});
  const memoryScope=(user,task)=>user.id+':'+task.monitorId;
  const runProgram=async(user,task,session,signal,{discovery=false}={})=>{
    if(task.program?.workflow?.version!==2)return runOrderWorkflow(task.program,inputFor(task),session.methods,{runScript,onPhase:value=>phase(user,task,session,value)});
    const memory=await siteMemory.read(memoryScope(user,task),task.url);
    const recipes=structuredClone(task.program.runtimePlan||[]);
    const plan=createAssistedPlanner(createPlanner((messages,options)=>askAI(user,task,messages,{stage:'未知流程 AI 辅助',...options})),{recipes,allowAssistance:task.status==='generating'||task.autoRepair!==false,
      onSatisfied:step=>session.methods.registerPreparation?.(step),
      onRemember:value=>{task.flowMemory={scope:learnedFlowScope(task),recipes:structuredClone(value)};if(task.status==='generating')task.program.runtimePlan=structuredClone(value);persist();},
      onEvent:(action,data)=>logEvent(user,task,action,data)
    });
    return (discovery?discoverCommerceSite:runCommerceAgent)(task.program,inputFor(task),session,{
      signal,memory,autoRepair:task.autoRepair,timeoutMs:budgetFor(task).agentTimeoutMs,trigger:task.trigger||'scheduled',plan,
      onEvent:(action,data)=>{session.trace.push({action,detail:JSON.stringify(data),at:new Date().toISOString()});logEvent(user,task,action,data);},
      onLearn:async result=>{try{await siteMemory.record(memoryScope(user,task),task.url,result);}catch(error){logEvent(user,task,'网站记忆保存失败',{error:diagnosticError(error)});}}
    });
  };
  const unchanged=(user,task)=>{
    if(task.monitorFingerprint!==monitorFingerprint(user,task))throw new Error('触发监控条件已变化，请重新启用');
    if(task.accountFingerprint!==orderAccountFingerprint(savedOrderAccount(user,task)))throw new Error('下单账户已变化，请重新启用');
  };
  async function buildProgram(user,task,signal,initialFeedback=null,{preflight=true}={}){
    const intentHash=orderIntentFingerprint(task);
    const previousProgram=task.program?.workflow?.version===2?structuredClone(task.program):null;
    const reusable=previousProgram&&(!previousProgram.intentHash||previousProgram.intentHash===intentHash);
    const remembered=task.flowMemory?.scope===learnedFlowScope(task)?task.flowMemory.recipes:reusable?previousProgram.runtimePlan||[]:[];
    let feedback=initialFeedback?{error:String(initialFeedback.error||'').slice(0,1000)}:null;
    for(let attempt=0;attempt<2;attempt++){
      let preflightStarted=false;
      unchanged(user,task);
      task.validation={syntax:'pending',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};
      let output;
      if(reusable){
        output={summary:previousProgram.summary,workflow:previousProgram.workflow};
        logEvent(user,task,'复用业务流程',{pageAdapters:remembered.length});
      }else if(task.instruction===DEFAULT_ORDER_INSTRUCTION){
        output={summary:'按默认配置准备目标商品，核对数量、总价与执行范围',workflow:{version:2,requirements:[]}};
        logEvent(user,task,'使用默认业务模板',{});
      }else{
        logEvent(user,task,'请求 AI 生成代码',{attempt:attempt+1,stage:'整理业务要求',model:user.settings?.aiModel});
        // This call only translates user requirements; no merchant DOM or historical traces.
        output=await askAI(user,task,[{role:'system',content:BUSINESS_PROMPT},{role:'user',content:JSON.stringify({phase:'business_sop',order:inputFor(task),feedback})}],{signal,stage:'整理业务要求'});
      }
      if(signal.aborted)throw new Error('流程生成已停止');
      try{
        if(output?.clarification){
          const question=required(output.clarification.question,'购买问题',500),error=Object.assign(new Error(question),{code:'ORDER_BUSINESS_REQUIREMENTS_UNCLEAR'});
          error.orderInput={kind:'business_requirements',question:redact(user,task,question),reason:'选好后继续，其他购买要求保持不变。',code:error.code,url:task.url,candidates:[],options:(output.clarification.options||[]).map(option=>required(option,'购买选项',200))};throw error;
        }
        if(output?.error)throw Object.assign(new Error(isFuturePageEvidenceRefusal(output.error)?'业务 SOP 不需要未来页面 DOM；浏览器会逐页探索，请只整理目标与配置要求。':String(output.error)),{code:'ORDER_BUSINESS_PLAN_INVALID'});
        if(output?.workflow?.version!==2)throw Object.assign(new Error('业务辅助必须返回配置要求，不能生成执行脚本'),{code:'ORDER_BUSINESS_PLAN_INVALID'});
        task.program=validateOrderProgram(output,{requireWorkflow:true});
        if(task.program.workflow.version===2){task.program.intentHash=intentHash;task.program.runtimePlan=structuredClone(reusable?remembered:[]);}
        operationLog(user,task)?.program(task.program,orderProgramHash(task));
        logEvent(user,task,'业务流程就绪',{attempt:attempt+1,codeHash:orderProgramHash(task)});
        if(task.executionMode==='pay'&&task.program.workflow.version===1&&!task.program.workflow.paymentCode)throw new Error('自动付款的 SOP 缺少账单定位代码');
        await validateOrderProgramScripts(task.program);
        task.validation={syntax:'passed',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};
        persist();
        if(!preflight)return;
        preflightStarted=task.program.workflow?.version===2;
        task.progress={stage:'准备并核对订单',pass:1,step:0,at:new Date().toISOString()};persist();
        let trial;
        for(let quantity=task.quantity;quantity>=1;){
          const trialTask={...task,quantity,dryRun:true};
          try{trial=await browserFor(user,trialTask,async session=>{
          try{
            const result=await runProgram(user,trialTask,session,signal,{discovery:true});
            if(result.status!=='prepared'||session.receipt?.status!=='prepared')throw new Error('试跑没有到达真实订单核对页面');
            if(task.program.workflow.version===2&&session.receipt.requestContract?.status!=='verified')throw Object.assign(new Error('尚未取得真实提交请求的契约，不能标记为可执行'),{code:'ORDER_CONTRACT_UNVERIFIED'});
            if(session.receipt.requestContract)task.submissionContract=structuredClone(session.receipt.requestContract);
            task.verifiedProduct=session.receipt.review?.product||task.product;task.verifiedCurrency=session.receipt.review?.currency||task.currency;task.verifiedPaymentMethod=session.receipt.paymentMethod||null;task.paymentOptions=session.paymentOptions||[];
            return {...session.receipt,trace:session.trace,passed:true,codeHash:orderProgramHash(task),at:new Date().toISOString()};
          }catch(error){task.paymentOptions=session.paymentOptions||[];if(error.orderPreparation)task.preparation=error.orderPreparation;if(error.orderContract)task.submissionContract=error.orderContract;task.failure=error.orderFailure||orderFailure(error,{stage:'preflight'});try{error.orderEvidence=await session.snapshot();}catch{}throw error;}
          },{signal,logStage:'试跑'});break;
          }catch(error){
            const next=error.code==='ORDER_QUANTITY_LIMIT'?Number(error.availableQuantity):error.code==='ORDER_BUDGET_EXCEEDED'?quantity-1:0;
            if(signal.aborted||!Number.isInteger(next)||next<1||next>=quantity)throw error;
            quantity=next;logEvent(user,task,'试跑调整数量',{quantity,reason:error.message,quote:error.quote});
          }finally{if(trialTask.flowMemory)task.flowMemory={...trialTask.flowMemory,scope:learnedFlowScope(task)};}
        }
        logEvent(user,task,'试跑通过',{attempt:attempt+1,pass:1,review:trial.review});
        unchanged(user,task);task.trial={...trial,preflightPasses:1};task.validation.preflight='passed';task.progress={stage:'试跑完成',pass:1,at:new Date().toISOString()};task.failure=null;task.preparation={verifiedStages:['checkout','configuration','request_contract','preflight'],pending:[],candidates:[],at:new Date().toISOString()};persist();return;
      }catch(error){
        logEvent(user,task,'生成或试跑失败',{attempt:attempt+1,error:diagnosticError(error)});
        feedback={error:redact(user,task,error.message),previousResponse:output};
        if(!preflightStarted&&!error.orderInput){
          error.code||='ORDER_BUSINESS_PLAN_INVALID';
          error.userMessage='购买方案暂时未能整理完成，你填写的要求已保留。请点击“准备下单流程”重试，无需补充技术信息。';
        }
        if(preflightStarted||error.orderInput||signal.aborted||['ORDER_PREPARATION_UNCERTAIN','ORDER_CONTRACT_UNVERIFIED','ORDER_PRODUCT_MISMATCH','ORDER_QUANTITY_MISMATCH','ORDER_OUT_OF_STOCK','ORDER_REQUEST_BLOCKED','ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED','ORDER_BROWSER_BUSY','PROXY_AUTH_FAILED','SITE_HTTP_AUTH_REQUIRED','ORDER_COUPON_REJECTED','ORDER_AI_TIMEOUT','ORDER_TRIAL_TIMEOUT','AGENT_BUDGET_EXCEEDED'].includes(error.code)||attempt===1||reusable)throw error;}
    }
  }
  async function generateImpl(user,task){
    available(user,task);if(task.submissionStartedAt||task.result)throw new Error('已有执行记录，请创建新的下单配置');
    task.monitorFingerprint=monitorFingerprint(user,task);task.accountFingerprint=orderAccountFingerprint(savedOrderAccount(user,task));
    if(task.flowMemory&&task.flowMemory.scope!==learnedFlowScope(task)){task.flowMemory=null;if(task.program?.runtimePlan)task.program.runtimePlan=[];}
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    delete task.error;delete task.errorCode;delete task.startedAt;delete task.attemptId;task.enabled=false;task.approvedHash=null;task.status='generating';task.trial=null;task.submissionContract=null;task.failure=null;task.input=null;task.validation={syntax:'pending',preflight:'pending',payment:task.executionMode==='pay'?'unverified':'not_requested'};task.verifiedProduct=null;task.verifiedCurrency=null;task.verifiedPaymentMethod=null;task.paymentOptions=[];task.progress={stage:'读取商品页面',at:new Date().toISOString()};persist();
    const deadline=createOrderDeadline({signal:controller.signal,timeoutMs:trialTimeoutMs,code:'ORDER_TRIAL_TIMEOUT',stage:'网站探索与试跑'});
    try{await buildProgram(user,task,deadline.signal);deadline.signal.throwIfAborted();task.status='ready';return publicOrderTask(task);}
    catch(error){task.failure=error.orderFailure||orderFailure(error,{stage:task.progress?.stage||'generation'});if(error.orderInput)task.input=error.orderInput;if(error.orderPreparation)task.preparation=error.orderPreparation;task.status=controller.signal.aborted?'draft':error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'needs_validation';if(error.code==='ORDER_OUT_OF_STOCK')task.validation.preflight='waiting_stock';if(error.code==='ORDER_SCRIPT_INVALID')task.validation.syntax='failed';task.error=redact(user,task,error.userMessage||error.message);task.errorCode=error.code||null;throw Object.assign(new Error(task.error),{code:error.code,...(error.slot?{slot:error.slot,actual:error.actual}:{})});}
    finally{deadline.close();busy.delete(key);cancellations.delete(key);persist();}
  }
  function approve(user,task,hash){
    available(user,task,{capacity:false});
    if(hash!=null&&hash!==orderProgramHash(task))throw new Error('配置已变化，请刷新后重新启用');
    if(task.result||task.submissionStartedAt)throw new Error('此任务已有执行记录，请创建新配置，避免重复下单');
    if(user.orderTasks.some(t=>t!==task&&t.monitorId===task.monitorId&&(t.enabled||t.stockAuthorization)))throw new Error('此监控已有启用或等待补货的下单配置，请先暂停它');
    task.monitorFingerprint=monitorFingerprint(user,task);task.accountFingerprint=orderAccountFingerprint(savedOrderAccount(user,task));
    if(task.restockRetry)retries.cancel(user,task,'rearmed');
    task.stockAuthorization=null;task.approvedHash=orderProgramHash(task);task.enabled=true;task.status='armed';delete task.error;delete task.errorCode;persist();return publicOrderTask(task);
  }
  async function executeImpl(user,task,{manual=false,trigger=manual?'manual':'scheduled'}={}){
    available(user,task);
    if(!task.enabled||task.approvedHash!==orderProgramHash(task)||task.result||task.submissionStartedAt)throw new Error('任务未启用、配置已变更或已经执行，不会再次下单');
    try{unchanged(user,task);}catch(error){task.enabled=false;task.approvedHash=null;task.status='ready';task.error=redact(user,task,error.message);persist();throw error;}
    const key=jobKey(user,task),controller=new AbortController();cancellations.set(key,controller);busy.add(key);
    task.trigger=trigger;delete task.executionCancelled;
    const executionDeadline=createOrderDeadline({signal:controller.signal,timeoutMs:task.restockRetry?.state==='active'?Math.max(1,Math.min(budgetFor(task).agentTimeoutMs,task.restockRetry.expiresAt-Date.now())):budgetFor(task).agentTimeoutMs,code:'AGENT_BUDGET_EXCEEDED',stage:'自动下单'}),signal=executionDeadline.signal;
    task.enabled=false;task.status='running';task.attemptId=randomUUID();task.startedAt=new Date().toISOString();task.repairs=[];task.purchases=[];persist();
    let activePurchase=null,attemptTask=null;const receipts=[];
    const options={signal:signal,onBeforeSubmit:async checked=>{unchanged(user,task);if(signal.aborted)throw new Error('下单任务已停止');if(activePurchase?.submissionStartedAt)throw new Error('本笔订单已尝试提交');
      if(checked.quantity!==attemptTask.quantity||!Number.isFinite(checked.total)||checked.total<0||checked.total>attemptTask.maxTotal||attemptTask.currency&&checked.currency!==attemptTask.currency)throw new Error('本笔订单超出剩余数量、预算或币种范围');
      activePurchase={sequence:task.purchases.length+1,status:'submitting',submissionStartedAt:new Date().toISOString(),review:checked};task.purchases.push(activePurchase);
      task.submissionStartedAt=activePurchase.submissionStartedAt;task.submissionReview=checked;logEvent(user,task,'订单提交前记录',{review:checked,submissionStartedAt:task.submissionStartedAt});persist();},onBeforePayment:async checked=>{unchanged(user,task);if(signal.aborted)throw new Error('付款操作已停止');if(activePurchase?.paymentStartedAt)throw new Error('此订单已经尝试付款，不会重复扣款');activePurchase.paymentStartedAt=new Date().toISOString();activePurchase.paymentReview=checked;task.paymentStartedAt=activePurchase.paymentStartedAt;task.paymentReview=checked;logEvent(user,task,'付款前记录',{payment:checked,paymentStartedAt:task.paymentStartedAt});persist();}};
    const structuralError=error=>/网页元素不存在|网页元素定位|Missing .*field|missing .*element|strict mode|waiting for locator|locator\..*Timeout|Unknown .*selector/i.test(error.message);
    const run=()=>browserFor(user,attemptTask,async session=>{
      try{
        let output;
        try{output=await runProgram(user,attemptTask,session,signal);}
        catch(error){
          // Assist only the confirmed original order, before the first payment attempt.
          if(task.program.workflow?.version===2||!task.autoRepair||!structuralError(error)||signal.aborted||session.receipt?.status!=='ordered'||session.paymentStarted||activePurchase?.paymentStartedAt||task.executionMode!=='pay')throw error;
          const page=await session.snapshot();unchanged(user,task);
          const assistance={at:new Date().toISOString(),phase:'payment',error:redact(user,task,error.message)};
          (task.paymentAssistance||=[]).push(assistance);logEvent(user,task,'原订单付款定位辅助',{error:diagnosticError(error)});persist();
          const response=await askAI(user,task,[{role:'system',content:ORDER_PAYMENT_PROMPT},{role:'user',content:JSON.stringify({phase:'payment',order:inputFor(attemptTask),page,receipt:session.receipt,feedback:{error:assistance.error}})}],{signal:signal,stage:'原订单账单定位',timeoutMs:Math.min(aiTimeoutMs,15000),maxRetries:0});
          if(response.error)throw new Error(response.error);
          assistance.code=required(response.paymentCode,'AI 付款定位代码',6000);assistance.summary=required(response.summary,'AI 付款辅助说明',1500);persist();
          unchanged(user,task);
          output=await runOrderPaymentCode(assistance.code,inputFor(attemptTask),{...session.methods,pay:checks=>session.methods.pay({...checks,semantic:true,confirmationSelector:'[data-agent-confirmation="payment"]'})},session.receipt,{runScript,timeoutMs:20000,maxCalls:30});assistance.completedAt=new Date().toISOString();
        }
        const requiredStatus={prepare:'prepared',submit:'ordered',pay:'paid'}[task.executionMode];
        const pending=task.executionMode==='pay'&&output.status==='awaiting_payment'&&session.receipt?.status==='awaiting_payment'&&['insufficient_balance','balance_unverified','method_unverified','external_payment','payment_verification','zero_total'].includes(session.receipt.paymentPending?.reason);
        if(!pending&&(output.status!==requiredStatus||session.receipt?.status!==requiredStatus))throw new Error('程序未取得可验证的执行结果');
        return {...session.receipt,trace:session.trace,manual,at:new Date().toISOString()};
      }catch(error){error.orderReceipt=session.receipt;error.orderTrace=session.trace;try{error.orderEvidence=await session.snapshot();}catch{}throw error;}
    },options).finally(()=>{if(attemptTask.flowMemory){task.flowMemory={...attemptTask.flowMemory,scope:learnedFlowScope(task)};task.program.runtimePlan=structuredClone(attemptTask.flowMemory.recipes);task.approvedHash=orderProgramHash(task);persist();}});
    try{
      if(!task.program){await buildProgram(user,task,signal,null,{preflight:false});task.approvedHash=orderProgramHash(task);persist();}
      await validateOrderProgramScripts(task.program);
      let result,limit=task.quantity,currency=task.currency||task.verifiedCurrency||'';
      while(true){
        signal.throwIfAborted();unchanged(user,task);
        const summary=purchaseSummary(task,receipts),remaining=Math.round((task.maxTotal-summary.total)*1e6)/1e6;
        if(summary.remainingQuantity<=0||remaining<=0){result={...receipts.at(-1),status:summary.remainingQuantity?'partial':receipts.at(-1).status,purchaseSummary:{...summary,reason:summary.remainingQuantity?'累计费用已达到预算上限':''}};break;}
        let quantity=Math.min(limit,summary.remainingQuantity),adjustment='';
        while(true){
          activePurchase=null;
          attemptTask={...task,quantity,maxTotal:remaining,currency};
          task.progress={stage:'核对第 '+(receipts.length+1)+' 笔订单',quantity,remainingBudget:remaining,at:new Date().toISOString()};persist();
          try{result=await run();break;}
          catch(error){
            if(!activePurchase?.submissionStartedAt&&!signal.aborted&&quantity>1&&['ORDER_QUANTITY_LIMIT','ORDER_BUDGET_EXCEEDED'].includes(error.code)){
              const next=error.code==='ORDER_QUANTITY_LIMIT'?Number(error.availableQuantity):quantity-1;
              if(!Number.isInteger(next)||next<1||next>=quantity)throw error;
              quantity=next;adjustment=error.message;if(error.code==='ORDER_QUANTITY_LIMIT')limit=Math.min(limit,next);
              logEvent(user,task,'调整本笔数量',{quantity,reason:adjustment,quote:error.quote,remainingBudget:remaining});continue;
            }
            const structural=structuralError(error);
            if(task.program.workflow?.version!==2&&task.autoRepair&&structural&&!signal.aborted&&!activePurchase?.submissionStartedAt&&task.repairs.length===0){
              unchanged(user,task);task.repairs.push({at:new Date().toISOString(),error:redact(user,task,error.message),previousHash:task.approvedHash});persist();
              await buildProgram(user,task,signal,{error:redact(user,task,error.message),page:error.orderEvidence||null,previousCode:task.program.code},{preflight:false});
              task.approvedHash=orderProgramHash(task);task.repairs.at(-1).repairedHash=task.approvedHash;continue;
            }
            throw error;
          }
        }
        if(result.status==='prepared'){result.purchaseSummary={requestedQuantity:task.quantity,quantity:0,total:0,maxTotal:task.maxTotal,currency:result.review.currency,remainingQuantity:task.quantity,reason:'已核对本笔 '+result.review.quantity+' 件，停在提交前'};break;}
        if(!activePurchase)throw new Error('缺少本笔订单提交记录');
        if(result.orderId&&receipts.some(receipt=>receipt.orderId===result.orderId))throw new Error('商家返回了之前的订单号，无法确认新的订单');
        Object.assign(activePurchase,{...result,adjustment,confirmedAt:new Date().toISOString()});
        receipts.push({...result,adjustment});currency=result.review.currency;
        task.result={...result,purchases:structuredClone(task.purchases),purchaseSummary:purchaseSummary(task,receipts,adjustment)};persist();
        if(!['ordered','paid'].includes(result.status)){result.purchaseSummary=purchaseSummary(task,receipts,result.paymentPending?.message||'本笔付款尚未确认，停止后续购买');break;}
        if(purchaseSummary(task,receipts).remainingQuantity===0){result.purchaseSummary=purchaseSummary(task,receipts);break;}
      }
      result.purchases=structuredClone(task.purchases);
      result.timing={submitMs:task.purchases[0]?.submissionStartedAt?Date.parse(task.purchases[0].submissionStartedAt)-Date.parse(task.startedAt):null,totalMs:Date.now()-Date.parse(task.startedAt),aiRepairs:task.repairs.length+(task.paymentAssistance?.length||0)};task.result=result;task.status=result.status;task.failure=null;task.input=null;delete task.errorCode;if(task.validation)task.validation.preflight='passed';if(task.validation&&task.executionMode==='pay')task.validation.payment=result.status==='paid'?'confirmed':'pending';delete task.error;await notify(user,task).catch(()=>{});
    }catch(error){
      logEvent(user,task,'实际执行失败',{error:diagnosticError(error)});
      task.error=redact(user,task,error.message);
      task.failure=error.orderFailure||orderFailure(error,{stage:'execution',submissionStarted:!!activePurchase?.submissionStartedAt,paymentStarted:!!activePurchase?.paymentStartedAt});task.errorCode=error.code||null;if(error.orderPreparation)task.preparation=error.orderPreparation;if(error.orderInput)task.input=error.orderInput;
      task.status=error.orderReceipt?.status==='paid'?'paid':activePurchase?.paymentStartedAt?'uncertain':error.orderReceipt?.status==='ordered'?'payment_failed':activePurchase?.submissionStartedAt?'uncertain':receipts.length?'partial':'failed';
      const failedAttempt={...(error.orderReceipt||{}),status:task.status,trace:error.orderTrace||[],error:task.error,code:error.code,retryable:error.retryable===true||error.name==='TimeoutError',at:new Date().toISOString(),manual};
      if(!activePurchase?.submissionStartedAt&&!activePurchase?.paymentStartedAt&&!receipts.length){
        task.lastAttempt=failedAttempt;task.result=null;task.trial=null;task.approvedHash=null;
        task.status=error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'needs_validation';
        if(task.validation)task.validation.preflight=error.code==='ORDER_OUT_OF_STOCK'?'waiting_stock':'pending';
        if(error.code==='ORDER_OUT_OF_STOCK'&&!signal.aborted){task.enabled=true;task.approvedHash=orderProgramHash(task);}
        delete task.startedAt;delete task.attemptId;
      }else {if(activePurchase)Object.assign(activePurchase,failedAttempt);const confirmed=[...receipts];if(error.orderReceipt?.review&&!confirmed.some(receipt=>receipt.orderId&&receipt.orderId===error.orderReceipt.orderId)&&['ordered','paid','awaiting_payment'].includes(error.orderReceipt?.status))confirmed.push(error.orderReceipt);task.result={...failedAttempt,purchases:structuredClone(task.purchases),purchaseSummary:purchaseSummary(task,confirmed,task.error)};if(task.validation&&task.executionMode==='pay')task.validation.payment=activePurchase?.paymentStartedAt?'uncertain':'unverified';}
      if(trigger==='restock'&&!task.result&&!localOrderConflict(user,task)&&isRestockRetryable(task)&&!task.executionCancelled)retries.start(user,task);
      await notify(user,task).catch(()=>{});
    }finally{executionDeadline.close();busy.delete(key);cancellations.delete(key);persist();}
    return publicOrderTask(task);
  }
  const loggedOperation=async(kind,user,task,action)=>{
    available(user,task);
    const log=executionLogs.start(user,task.monitorId,{kind,task});activeLogs.set(jobKey(user,task),log);
    log.event('执行预算与配置',{trigger:task.trigger||'scheduled',timeouts:budgetFor(task),aiMaxRetries:task.trigger==='restock'?2:aiRetries,autoRepair:task.autoRepair,workflowVersion:task.program?.workflow?.version||null,approved:Boolean(task.approvedHash),hasProductSelection:Boolean(task.productSelection)});
    if(task.program&&kind!=='generate')log.program(task.program,orderProgramHash(task));
    try{const result=await action();if(task.program)log.program(task.program,orderProgramHash(task));log.finish(['generate','discover'].includes(kind)?'passed':task.status,{result:task.result||task.trial,error:task.error?new Error(task.error):null,submissionStartedAt:task.submissionStartedAt,paymentStartedAt:task.paymentStartedAt});return result;}
    catch(error){log.finish(task.status==='draft'&&kind==='generate'?'stopped':'failed',{result:task.result,error,submissionStartedAt:task.submissionStartedAt,paymentStartedAt:task.paymentStartedAt});throw error;}
    finally{activeLogs.delete(jobKey(user,task));drainPending();}
  };
  const generate=(user,task)=>loggedOperation('generate',user,task,()=>generateImpl(user,task));
  const discover=(user,task)=>loggedOperation('discover',user,task,()=>generateImpl(user,task));
  const profile=(user,task)=>siteMemory.read(memoryScope(user,task),task.url);
  const retries=createRestockRetries({persist,notify,...retryClock,
    check:async(user,task)=>{
      try{available(user,task);}catch{return {busy:true};}
      unchanged(user,task);
      const key=jobKey(user,task),controller=new AbortController();busy.add(key);cancellations.set(key,controller);
      const deadline=createOrderDeadline({signal:controller.signal,timeoutMs:Math.max(1,Math.min(budgetFor(task).agentTimeoutMs,task.restockRetry.expiresAt-Date.now())),code:'AGENT_BUDGET_EXCEEDED',stage:'重试前订单核验'});
      try{
        const checked=await browserFor(user,task,session=>recentOrders(session,task,{since:task.restockRetry.startedAt}),{signal:deadline.signal,accountReadOnly:true,logStage:'重试前订单核验'});
        task.restockRetry.merchantCheck=checked;persist();
        if(checked.matched||checked.unknown)return {safe:false,message:checked.matched?'商家后台已有同参数账单，停止自动重试，请人工核实':'商家后台订单状态未知，停止自动重试，请人工核实'};
        if(!checked.checked){task.restockRetry.merchantNote='未核验商家后台';if(task.lastAttempt)(task.lastAttempt.trace||=[]).push({action:'未核验商家后台',detail:'通用站点仅使用本地交易记录判重',at:new Date().toISOString()});logEvent(user,task,'未核验商家后台',{reason:'通用站点仅使用本地交易记录判重'});}
        return {safe:true};
      }finally{deadline.close();busy.delete(key);cancellations.delete(key);persist();}
    },
    run:async(user,task)=>{
      unchanged(user,task);task.enabled=true;task.approvedHash=orderProgramHash(task);persist();
      await loggedOperation('execute',user,task,()=>executeImpl(user,task,{trigger:'restock'}));
    }
  });
  const execute=async(user,task,options={})=>{
    task.trigger=options.trigger||(options.manual?'manual':'scheduled');
    await loggedOperation('execute',user,task,()=>executeImpl(user,task,options));
    if(task.trigger==='restock'&&!task.result&&!localOrderConflict(user,task)&&isRestockRetryable(task)&&!task.executionCancelled){
      retries.start(user,task);
    }else if(task.restockRetry?.state==='active')retries.cancel(user,task,task.failure?'needs_input':'completed');
    return publicOrderTask(task);
  };
  const stockScope=task=>createHash('sha256').update(JSON.stringify([ORDER_SAFETY_VERSION,...['url','product','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','productSelection','paymentMethod','couponCode','couponFailurePolicy','userClarification'].map(key=>task[key]),task.revision,task.monitorFingerprint,task.accountFingerprint,task.program?.workflow||null])).digest('hex');
  function waitStock(user,task){
    available(user,task);unchanged(user,task);
    if(task.status!=='waiting_stock'||task.result||task.submissionStartedAt||!task.program?.workflow)throw new Error('仅可为缺货且已有业务 SOP 的未交易任务授权等待');
    if(!task.currency)throw new Error('等待补货自动执行前，请明确填写预算币种并重新生成；不从符号猜测');
    if(user.orderTasks.some(other=>other!==task&&other.monitorId===task.monitorId&&(other.enabled||other.stockAuthorization)))throw new Error('此监控已有启用或等待的下单配置');
    task.stockAuthorization={scope:stockScope(task),at:new Date().toISOString(),expiresAt:new Date(Date.now()+24*60*60_000).toISOString()};task.enabled=false;task.approvedHash=null;persist();return publicOrderTask(task);
  }
  async function executeTrigger(user,monitor,source='restock'){
    for(const task of user.orderTasks.filter(t=>t.monitorId===monitor.id&&(t.enabled||t.stockAuthorization))){
      if(task.restockRetry?.state==='active'){await retries.tick(user,task);continue;}
      const authorization=task.stockAuthorization;
      if(authorization){
        try{
          unchanged(user,task);
          if(Date.now()>=Date.parse(authorization.expiresAt)||authorization.scope!==stockScope(task))throw new Error('等待补货授权已过期或范围变化，请重新确认');
          approve(user,task);
        }catch(error){
          if(error.code!=='ORDER_OUT_OF_STOCK'){task.stockAuthorization=null;task.enabled=false;task.approvedHash=null;task.error=redact(user,task,error.message);persist();}
          continue;
        }
      }
      await execute(user,task,{trigger:source}).catch(()=>{});
      if(authorization&&task.enabled&&task.status==='waiting_stock'){task.stockAuthorization=authorization;task.enabled=false;task.approvedHash=null;persist();}
    }
  }
  function drainPending(){
    if(queueTimer){clearTimeout(queueTimer);queueTimer=null;}
    for(const [key,entry] of pendingTriggers){
      const {user,task,monitor,revision,resolve,source}=entry;
      const valid=user.orderTasks.includes(task)&&user.monitors.includes(monitor)&&monitor.enabled!==false&&(task.enabled||task.stockAuthorization)&&task.revision===revision;
      if(!valid){pendingTriggers.delete(key);delete task.pendingTrigger;resolve();continue;}
      try{available(user,task);}catch{continue;}
      pendingTriggers.delete(key);delete task.pendingTrigger;
      void executeTrigger(user,monitor,source).catch(error=>{task.error=redact(user,task,error.message);}).finally(()=>{persist();resolve();drainPending();});
    }
    if(pendingTriggers.size)queueTimer=setTimeout(drainPending,1000).unref();
  }
  async function trigger(user,monitor,{trigger:source='restock'}={}){
    const pending=[];
    for(const task of user.orderTasks.filter(t=>t.monitorId===monitor.id&&(t.enabled||t.stockAuthorization))){
      const key=jobKey(user,task),existing=pendingTriggers.get(key);
      if(existing){pending.push(existing.promise);continue;}
      let resolve;const promise=new Promise(done=>{resolve=done;});
      task.pendingTrigger={revision:task.revision,at:new Date().toISOString()};
      pendingTriggers.set(key,{user,task,monitor,revision:task.revision,resolve,promise,source});pending.push(promise);
    }
    persist();drainPending();await Promise.all(pending);
  }
  function pause(user,task){task.executionCancelled=true;retries.cancel(user,task);const queued=pendingTriggers.get(jobKey(user,task));if(queued){pendingTriggers.delete(jobKey(user,task));queued.resolve();}delete task.pendingTrigger;task.enabled=false;task.stockAuthorization=null;const controller=cancellations.get(jobKey(user,task));if(controller){task.status='stopping';controller.abort(new Error('下单任务已停止'));}else task.status=task.result?.status||(task.trial?.passed?'ready':'draft');persist();return publicOrderTask(task);}
  function isBusy(user,task){return busy.has(jobKey(user,task));}
  function recover(users){executionLogs.recover(users);for(const user of users)for(const task of user.orderTasks||[]){
    const interrupted=['running','generating','stopping'].includes(task.status);
    if(task.restockRetry?.state==='active'){task.restockRetry.state='needs_input';task.restockRetry.nextAt=null;task.enabled=false;task.error='服务重启中断了决战重试，请人工核对订单后重新启用';}
    if(task.enabled&&task.approvedHash!==orderProgramHash(task)){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='下单配置已变化，请重新启用';}}
    if(!task.monitorId||!task.accountFingerprint){task.enabled=false;task.approvedHash=null;if(!task.result){task.status='draft';task.error='请在对应监控中预先登录账户，再重新启用';}}
    if(interrupted){task.stockAuthorization=null;task.enabled=false;task.status=task.startedAt?'uncertain':'draft';task.error='服务重启中断了操作，请核对网站订单记录；不会自动重试。';if(task.startedAt)task.result={status:'uncertain',error:task.error,review:task.submissionReview,payment:task.paymentReview,invoiceId:task.paymentReview?.invoiceId,purchases:structuredClone(task.purchases||[]),purchaseSummary:purchaseSummary(task,(task.purchases||[]).filter(item=>['ordered','paid','awaiting_payment'].includes(item.status)),task.error)};}
  }persist();for(const user of users)for(const task of user.orderTasks||[])if(task.pendingTrigger&&(task.enabled||task.stockAuthorization)){const monitor=user.monitors.find(m=>m.id===task.monitorId);if(monitor)void trigger(user,monitor);}}
  return {generate,discover,profile,approve,waitStock,execute,trigger,pause,isBusy,recover};
}
