import {settledPageAction} from '../automation/browser/action-settle.js';
import {quantityLimit} from './order-quantity.js';
import {inspectWhmcsConfiguration,whmcsConfigurationPermit,whmcsPreparationRequest,whmcsProductMatches} from './order-whmcs.js';
import {inspectCommercePage,inspectCommerceField} from '../automation/browser/dom-parser.js';
import {resolveSemanticTarget,probeLocator} from '../automation/browser/locator.js';
import {getOrderTimeouts} from './order-timeouts.js';
import {shanghaiTimestamp} from './log-time.js';
import {confirmationEvidence} from '../automation/adapters/generic-commerce.js';
import {diagnosticUrl} from './order-execution-log.js';
import { browserOperation, isBrowserClosedError, settledBrowserRead } from './browser-operation.js';
import { orderRequestKind, describeOrderRequest, isOrderAccountAction } from './order-request.js';
import { diagnosticPage } from './order-execution-log.js';
import { installProxyAuthentication, browserAuthenticationError, browserAuthenticatedNavigation } from './browser-proxy-auth.js';
import { createBrowserSlots } from './browser-slots.js';
import { matchesProductSelection, productIdentityText, parseOrderQuantity, explicitOrderCurrency, matchesOrderConfiguration } from './order-evidence.js';
import {createFrontendClues} from './order-frontend.js';
import {inspectRequestStructure} from './order-request.js';
import {nativeRequestPermit,matchesNativeRequest,formRequestEntries,nativeRequestContract} from './order-contract.js';
const browserSlots = createBrowserSlots();
const orderGuardError=(message,code)=>Object.assign(new Error(message),{code});
const permitUrlMatches=(expected,actual)=>{try{const left=new URL(expected),right=new URL(actual);return left.origin===right.origin&&left.pathname===right.pathname;}catch{return false;}};
const matchesPermittedNativeRequest=(permit,request)=>permitUrlMatches(permit.url,request.url())&&matchesNativeRequest({...permit,url:request.url().split('#')[0]},request);
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { isChallengePage } from './source-fetch.js';
import { flareSolverrClient } from './flare-solverr.js';
import { normalizePaymentMethod, paymentBrand, paymentMatchesIntent, samePaymentChoice } from './order-payment.js';

const selector = input => { if (typeof input !== 'string' || !input.trim() || input.length > 500) throw orderGuardError('网页元素定位无效','ORDER_LOCATOR_INVALID'); return input; };
const paymentWords = /pay(?:\s+now|\s+invoice|ment)?|支付|付款|扣款|complete\s+(?:order|purchase)|place\s+order|submit\s+order|确认订单|提交订单|确认购买/i;
const purchaseWords=/立即购买/i;
export function parseOrderTotal(text) {
  const values=String(text).normalize('NFKC').replace(/−/g,'-').match(/-?\d(?:[\d.,'’ ]*\d)?/g);
  if(values?.length!==1)throw orderGuardError('无法唯一确认订单总价，请重新生成','ORDER_TOTAL_UNVERIFIED');
  let token=values[0];
  if(/[ '’]/.test(token)){
    if(!/^-?\d{1,3}(?:[ '’]\d{3})+(?:[.,]\d{1,2})?$/.test(token))throw orderGuardError('订单金额分隔格式不明确','ORDER_TOTAL_UNVERIFIED');
    token=token.replace(/[ '’]/g,'');
  }
  const separators=token.match(/[.,]/g)||[],last=separators.at(-1);
  if(last){
    const fraction=token.slice(token.lastIndexOf(last)+1),decimal=fraction.length<=2;
    const integer=decimal?token.slice(0,token.lastIndexOf(last)):token;
    const groups=integer.split(/[.,]/);
    if(groups.length>1&&(!/^-?\d{1,3}$/.test(groups[0])||groups.slice(1).some(group=>!/^\d{3}$/.test(group)))||!decimal&&(fraction.length!==3||new Set(separators).size>1)||decimal&&integer.includes(last)&&new Set(separators).size>1)throw orderGuardError('订单金额分隔格式不明确','ORDER_TOTAL_UNVERIFIED');
    token=groups.join('')+(decimal?'.'+fraction:'');
  }
  const value=Number(token);
  if(!Number.isFinite(value)||value<0)throw orderGuardError('订单总价无效','ORDER_TOTAL_UNVERIFIED');
  return value;
}
// Native submit buttons can override the enclosing form's target and method.
// Every cart, order and payment phase uses this same effective form inspection.
function inspectOrderForm(el,{kind,selector}={}){
  const form=el.form;if(!form)return null;
  const target={url:el.hasAttribute('formaction')?el.formAction:form.action,method:(el.hasAttribute('formmethod')?el.formMethod:form.method).toUpperCase(),encoding:el.hasAttribute('formenctype')?el.formEnctype:form.enctype};
  const fields=[...form.elements],payment=fields.some(field=>/(?:cardnumber|card_number|ccnumber|cvv|cvc|usecredit|applycredit|autopay|savedpayment)/i.test(field.name||field.id)&&(field.type==='checkbox'||field.type==='radio'?field.checked:!!field.value));
  const nativeSubmit=(el.tagName==='BUTTON'||el.tagName==='INPUT')&&el.type==='submit'&&!el.disabled;
  let entries=null;
  if(nativeSubmit&&['cart','submit'].includes(kind)){try{const data=[...new FormData(form,el)];if(data.every(([,value])=>typeof value==='string'))entries=data;}catch{/* Unsupported form data cannot authorize a request. */}}
  if(kind==='cart'){
    const container=form.closest('main,article,section,[role="main"]')||form.parentElement||form;
    const productTexts=[...container.querySelectorAll('*')].filter(node=>!node.matches('input,select,textarea,button,script,style')&&node.getClientRects().length).map(node=>(node.innerText||'').trim()).filter(text=>text&&text.length<=300).slice(0,2000);
    return {...target,nativeSubmit,entries,text:el.innerText||el.value||'',content:(form.innerText||'').slice(0,12000),payment,
      productTexts,fields:fields.map(field=>({name:field.name,type:field.type,disabled:field.disabled,visible:!!field.getClientRects().length,autocomplete:field.autocomplete||'',marker:field.getAttribute('data-order-configured'),value:String(field.value||''),checked:field.checked,display:field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.textContent.trim()).join(' '):['radio','checkbox'].includes(field.type)?field.checked?(field.getAttribute('aria-label')||(field.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||[...(field.labels||[])].map(label=>label.textContent).join(' ')).replace(/\s+/g,' ').trim():'':String(field.value||'')}))};
  }
  if(kind==='coupon'){
    const input=document.querySelector(selector),bound=input?.form===form&&input.name&&!input.disabled&&!input.readOnly;
    return {...target,text:el.innerText||el.value||'',payment:payment||fields.some(field=>field.type==='password'),coupon:bound?{name:input.name,value:String(input.value),type:input.type}:null};
  }
  if(kind==='submit'){
    const quantity=document.querySelector(selector),bound=quantity?.form===form&&quantity.name&&!quantity.disabled;
    return {...target,nativeSubmit,entries,payment,invalidFields:form.noValidate||el.formNoValidate?[]:fields.filter(field=>field.willValidate&&!field.validity.valid).map(field=>(field.labels?.[0]?.textContent||field.name||field.id||field.type).trim().slice(0,120)),quantity:bound?{name:quantity.name,value:String(quantity.value),display:quantity.tagName==='SELECT'?[...quantity.selectedOptions].map(option=>option.textContent.trim()).join(' '):String(quantity.value)}:null};
  }
  const label=field=>field.tagName==='SELECT'?[...field.selectedOptions].map(option=>option.textContent.trim()).join(' '):(field.labels?.[0]?.innerText||field.getAttribute('aria-label')||'').trim();
  return {...target,invoiceMatches:document.querySelector(selector)?.form===form,
    controls:fields.filter(field=>field.tagName==='SELECT'||field.type==='radio'&&field.checked).map(field=>({name:field.name,value:field.value,label:label(field)})),
    hiddenMethods:fields.filter(field=>field.type==='hidden'&&/paymentmethod|payment_method|gateway|savedpayment|autopay/i.test(field.name||field.id)).map(field=>({name:field.name,value:field.value})),
    cardData:fields.some(field=>field.type==='password'||/(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(field.name||field.id)&&!!field.value)};
}
async function closeOrderBrowser(browser){
  let timer;try{await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,250);})]);}finally{clearTimeout(timer);}
}
// Runs in the merchant page; never treats an unrelated change-password form as logout.
function inspectOrderLogin(proof) {
  const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
  const loginWords=/\blog[\s-]?in\b|\bsign[\s-]?in\b|登录|登入/i;
  const explicitLoginForms=new Set();
  const loginForms=[...document.forms].filter(form=>{
    const fields=[...form.elements].filter(visible);
    const password=fields.some(el=>el.type==='password'&&el.autocomplete!=='new-password');
    const otp=fields.some(el=>/otp|one.?time|two.?factor|verification|验证码/i.test(el.name+' '+el.autocomplete+' '+el.getAttribute('aria-label')));
    const buttons=fields.filter(el=>el.tagName==='BUTTON'||['submit','button'].includes(el.type));
    const action=new URL(form.getAttribute('action')||location.href,location.href);
    const loginAction=/login|signin|sign-in|authenticate|verify-login|dologin/i.test(action.pathname);
    const username=fields.some(el=>el.type==='email'||/username|email|login/i.test(el.name+' '+el.autocomplete));
    const changingPassword=fields.some(el=>el.autocomplete==='new-password')||/change.?password|reset.?password|修改密码|重置密码/i.test(action.pathname+' '+form.innerText);
    const explicit=(password||otp)&&(loginAction||buttons.some(el=>loginWords.test(el.innerText||el.value||el.textContent||''))||password&&username&&!changingPassword);
    if(explicit)explicitLoginForms.add(form);return explicit||otp;
  });
  document.querySelectorAll('[data-order-login-form]').forEach(el=>el.removeAttribute('data-order-login-form'));
  loginForms.forEach(el=>el.setAttribute('data-order-login-form','true'));
  const nodes=[...document.querySelectorAll('a,button,input[type="submit"]')].filter(el=>{
    const href=el.getAttribute('href')||'',text=el.innerText||el.value||el.textContent||'';
    if(!/log.?out|sign.?out|退出|注销/i.test(href+' '+text))return false;
    if(href){try{const url=new URL(href,location.href);if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))return false;}catch{return false;}}
    return visible(el)||el.tagName==='A'&&/log.?out|sign.?out/i.test(href);
  });
  document.querySelectorAll('[data-order-account-marker]').forEach(el=>el.removeAttribute('data-order-account-marker'));
  if(loginForms.length)return {status:explicitLoginForms.size?'logged_out':'unverified',url:location.href};
  let explicitMarker=null;
  if(proof?.selector){
    const matches=document.querySelectorAll(proof.selector);
    if(matches.length===1&&visible(matches[0])&&matches[0].textContent.trim()&&(!proof.text||matches[0].textContent.replace(/\s+/g,' ').trim()===proof.text))explicitMarker=matches[0];
  }
  const node=proof?.selector?explicitMarker:nodes.find(visible)||nodes[0];
  if(!node)return {status:'unverified',url:location.href};
  node.setAttribute('data-order-account-marker','true');
  return {status:'authenticated',url:location.href,ready:document.readyState!=='loading',check:{loggedInSelector:'[data-order-account-marker="true"]',...(explicitMarker?{proof:{selector:proof.selector,text:node.textContent.replace(/\s+/g,' ').trim()}}:{}),href:node.getAttribute('href')?new URL(node.getAttribute('href'),location.href).href:null}};
}
export async function createOrderBrowser(task, { proxyUrl = '', launch = chromium.launch.bind(chromium), timeoutMs = 60_000, trigger = 'manual', signal, storageState, sessionStorageState, loginCheck, loginProof, loginOnly = false, restoringSession = false, accountReadOnly = false, loginVerificationTimeoutMs = getOrderTimeouts(trigger).loginVerificationTimeoutMs, onBeforeSubmit = async () => {}, onBeforePayment = async () => {}, onTrace = () => {}, stateTimeoutMs = 10000, couponVerificationTimeoutMs = getOrderTimeouts(trigger).couponVerificationTimeoutMs, onEvidence = async () => null, challengeSolver = flareSolverrClient, siteProfile = null } = {}) {
  const timeouts=getOrderTimeouts(trigger);
  if (signal?.aborted) throw orderGuardError('下单操作已停止','ORDER_ABORTED');
  const origin = new URL(task.url).origin;
  const readOnlyAccount = restoringSession || accountReadOnly;
  let verifiedLoginCheck=null,refreshingLogin=false,blockedAccountBackground = false,verifyingAccount=Boolean(loginCheck)||restoringSession||accountReadOnly;
  let expectedProduct=task.product||task.verifiedProduct||'';
  const configuredProductTitles=new Set();
  const productMatches=(expected,observed)=>matchesProductSelection(expected,observed)||matchesProductSelection(expected,expectedProduct)&&[...configuredProductTitles].some(title=>matchesProductSelection(title,observed));
  const expectedCurrency=task.currency||task.verifiedCurrency||'';
  const paymentIntent=normalizePaymentMethod(task.paymentMethod);
  let paymentChoice=null,paymentFormMarker=null,approvedPaymentRequest=null,approvedSubmissionRequest=null,approvedCouponRequest=null,gatewayHandoff=null,paymentOptions=[],financialRedirects=new Map();
  const affiliateUrl = task.affiliateUrl ? new URL(task.affiliateUrl) : null;
  let checkout = task.program?.checkout, remoteFieldCounter = 0;
  let affiliatePhase = false, affiliateEvidence = null, affiliateProof = null, affiliateCookie = null, affiliateField = null, accountBeforeAffiliate = null;
  const proxy = proxyUrl ? new URL(proxyUrl) : null;
  const releaseSlot = await browserSlots.acquireWhenClosing(!loginOnly && !task.dryRun && Boolean(task.program) && ['submit','pay'].includes(task.executionMode),{signal,verification:restoringSession,priority:trigger==='restock'});
  let browser;
  try { browser = await launch({ executablePath: process.env.MONITOR_BROWSER_EXECUTABLE || undefined, timeout:15000, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], ...(proxy ? { proxy: { server: proxy.origin, bypass: '' } } : {}) }); } catch(error) { releaseSlot();signal?.throwIfAborted();if(isBrowserClosedError(error))throw Object.assign(new Error('浏览器启动时意外关闭，请稍后重试'),{code:'ORDER_BROWSER_CLOSED'});if(error.name==='TimeoutError')throw Object.assign(new Error('浏览器启动超时，请检查运行资源'),{code:'ORDER_BROWSER_TIMEOUT'});throw error; }
  let context, watchdog, storageSeed, seedMarker, timedOut=false, mutationPermit = false, committed = false, submissionStarted = false, paymentStarted = false, blockedRequest = '', receipt = null, submissionPermit = null, paymentPermit = null, couponPermit=null,couponChecks=null,couponProof=null,couponFailure=null,couponAttempted=false, orderPage = '', freshProductNavigation = false;
  const trace = [],loginValues=[],challengeSecrets=(storageState?.cookies||[]).map(cookie=>cookie.value).filter(Boolean);let authentication={},blockedRequestCode='',blockedRequestNotes=0,orderInteraction=0,contractProbe=null;
  let clearanceUserAgent=storageState?.radarUserAgent||'',challengeAttempted=false;
  const solverSessionKey=task.accountId||randomUUID();
  const frontendClues=createFrontendClues(origin),configuredFields=new Map();
  const blockedError=()=>Object.assign(new Error(blockedRequest),{code:blockedRequestCode||undefined});
  const clean = input => {
    let value = String(input || '');
    for (const secret of [...Object.values(task.credentials || {}), ...loginValues, ...challengeSecrets, proxy ? decodeURIComponent(proxy.username) : '', proxy ? decodeURIComponent(proxy.password) : '']) if (secret) value = value.split(String(secret)).join('[已隐藏]');
    return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi, '$1[已隐藏]').slice(0, 800);
  };
  const appendTrace=step=>{const safe={...step,at:shanghaiTimestamp(step.at)||shanghaiTimestamp(),detail:clean(step.detail)};trace.push(safe);if(trace.length>400)trace.shift();try{onTrace(safe);}catch{};};
  const sameOrigin = value => { const url = new URL(value, task.url); if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw orderGuardError('下单程序只能访问配置的商品网站','ORDER_ORIGIN_BLOCKED'); return url.href; };
  let browserClosing;
  const stop=()=>{releaseSlot.closing();clearTimeout(watchdog);signal?.removeEventListener('abort',stop);return browserClosing||=browser.close().catch(()=>{}).finally(releaseSlot);};
  let watchdogDeadline=0;
  const armWatchdog=milliseconds=>{clearTimeout(watchdog);watchdogDeadline=Date.now()+milliseconds;watchdog=setTimeout(()=>{timedOut=true;void stop();},milliseconds);watchdog.unref();};
  try {
    appendTrace({action:'浏览器版本',detail:browser.version?.()||'unknown',at:new Date().toISOString()});
    context = await browserOperation(()=>browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', ...(storageState ? {storageState:{cookies:storageState.cookies,origins:storageState.origins}} : {}), ...(clearanceUserAgent ? {userAgent:clearanceUserAgent} : {}) }),{signal,timeoutMs:15000,code:'ORDER_BROWSER_TIMEOUT',message:'浏览器恢复登录数据超时，请稍后重试',onTimeout:stop});
    // HTTP request permits cannot authorize a separate WebSocket transaction channel.
    // Install this before any merchant page exists; service workers are blocked above.
    if(!loginOnly&&!readOnlyAccount){
      if(typeof context.routeWebSocket!=='function')throw Object.assign(new Error('浏览器缺少订单通信隔离能力，请更新浏览器依赖'),{code:'AGENT_UNAVAILABLE'});
      await context.routeWebSocket('**/*',socket=>socket.close({code:1008,reason:'Order automation permits HTTP forms only'}));
    }
    if(sessionStorageState){
      seedMarker='__radar_session_seed_'+randomUUID();
      storageSeed=await context.addInitScript(({origin,values,marker})=>{if(location.origin===origin&&!sessionStorage.getItem(marker)){for(const [key,value]of Object.entries(values))sessionStorage.setItem(key,value);sessionStorage.setItem(marker,'1');}},{origin,values:sessionStorageState,marker:seedMarker});
    }
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) { await closeOrderBrowser({close:stop}); throw orderGuardError('下单操作已停止','ORDER_ABORTED'); }
    armWatchdog(timeoutMs);
    const preparationReads=new Set();let preparationReadError=null;
    await context.route('**/*', async route => {
      const request = route.request();
      let same = false;
      try { same = new URL(request.url()).origin === origin; } catch {}
      const kind=orderRequestKind(request.url()),isTransaction=kind==='submission',isPayment=kind==='payment';
      if(contractProbe){
        // Every request is blocked, including navigations and GET-based transactions.
        if(request.isNavigationRequest()||!['GET','HEAD'].includes(request.method())||['xhr','fetch'].includes(request.resourceType())){
          contractProbe.count++;
          if(contractProbe.requests.length<4)contractProbe.requests.push({structure:inspectRequestStructure(request),matches:same&&!!contractProbe.permit&&matchesPermittedNativeRequest(contractProbe.permit,request)});
        }
        await route.abort();return;
      }
      if(same&&!loginOnly&&!readOnlyAccount&&!submissionStarted&&!paymentStarted&&request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/cart.php')&&['xhr','fetch'].includes(request.resourceType())){
        let inspected;const inspection=new Promise(resolve=>{inspected=resolve;});preparationReads.add(inspection);
        try{
          const configuration=await request.frame().evaluate(inspectWhmcsConfiguration).catch(()=>null);
          const preparation=whmcsPreparationRequest(request,configuration,{recommendations:!!submissionPermit?.whmcs&&!submissionPermit.recommendationsUsed});
          if(preparation){
            if(preparation==='recommendations')submissionPermit.recommendationsUsed=true;
            appendTrace({action:'配置辅助请求',detail:describeOrderRequest(request.method(),request.url()),operation:preparation,structure:inspectRequestStructure(request),at:new Date().toISOString()});
            const completed=browserOperation(async()=>{
              const response=await request.response();
              if(!response||response.status()>=400)throw Object.assign(new Error('商品配置或计价请求失败'+(response?'：HTTP '+response.status():'')),{code:'ORDER_PRICING_FAILED'});
              const failure=await response.finished();if(failure)throw failure;
            },{signal,timeoutMs:15000,code:'ORDER_PRICING_TIMEOUT',message:'商品配置或计价响应超时，未提交订单'}).catch(error=>{preparationReadError=error;}).finally(()=>preparationReads.delete(completed));
            preparationReads.add(completed);await route.continue();return;
          }
        }finally{preparationReads.delete(inspection);inspected();}
      }
      if(submissionPermit?.entries&&!submissionPermit.used&&request.isNavigationRequest()&&(request.method()!==submissionPermit.method||!permitUrlMatches(submissionPermit.url,request.url()))){
        blockedRequest='当前按钮的实际跳转与核对的原生表单不一致，已拦截';blockedRequestCode='ORDER_CONTRACT_UNVERIFIED';await route.abort();return;
      }
      const dryRunFinancial=task.dryRun&&(isTransaction||isPayment);
      let allowedMutation = !readOnlyAccount && (mutationPermit || loginOnly) && !submissionStarted, allowedPayment = false;
      for (const permit of [couponPermit,submissionPermit, paymentPermit]) {
        if (!dryRunFinancial && !readOnlyAccount && same && permit && (!permit.expiresAt||Date.now()<permit.expiresAt) && request.method() === (permit.method||'POST') && permitUrlMatches(permit.url,request.url()) && !permit.used) {
          if(request.url().split('#')[0]!==permit.url)appendTrace({action:'许可请求参数变化',detail:describeOrderRequest(request.method(),request.url()),urlMatches:true,queryMatches:false,at:new Date().toISOString()});
          if(permit.contentType&&!permit.entries&&String(request.headers()['content-type']||'').split(';')[0].trim().toLowerCase()!==permit.contentType){blockedRequest='实际请求内容类型与许可不符';blockedRequestCode='ORDER_REQUEST_BLOCKED';await route.abort();return;}
          if(permit.entries&&!matchesPermittedNativeRequest(permit,request)){appendTrace({action:'请求字段不匹配',detail:describeOrderRequest(request.method(),request.url()),structure:inspectRequestStructure(request),at:new Date().toISOString()});blockedRequest='实际提交字段或值与刚核对的表单不一致，已拦截';blockedRequestCode='ORDER_CONTRACT_UNVERIFIED';await route.abort();return;}
          const body=new URLSearchParams(permit.entries?formRequestEntries(request):request.postData() || '');
          if(permit.coupon){
            let values=body.getAll(permit.coupon.name);
            if(permit===couponPermit&&/application\/json/i.test(request.headers()['content-type']||'')){try{const json=JSON.parse(request.postData()||'');values=typeof json?.[permit.coupon.name]==='string'?[json[permit.coupon.name]]:[];}catch{values=[];}}
            if(JSON.stringify(values)!==JSON.stringify([permit.coupon.value])){blockedRequest='实际优惠码与配置不符，已停止';blockedRequestCode='ORDER_COUPON_UNVERIFIED';note('拦截请求','优惠码发生变化');await route.abort();return;}
          }
          if(permit.quantity && JSON.stringify(body.getAll(permit.quantity.name))!==JSON.stringify([permit.quantity.value])){blockedRequest='实际订单数量与已核对的数量不符，已停止';blockedRequestCode='ORDER_REQUEST_BLOCKED';note('拦截请求','订单数量发生变化');await route.abort();return;}
          if(permit.methodField && JSON.stringify(body.getAll(permit.methodField))!==JSON.stringify([permit.methodValue])){blockedRequest='实际付款方式与已核对的选择不符，已停止';blockedRequestCode='ORDER_PAYMENT_UNVERIFIED';await route.abort();return;}
          // Payment approval also binds the actual HTTP body to this invoice.
          if (permit === paymentPermit && JSON.stringify(new URLSearchParams(request.postData() || '').getAll(permit.invoiceField)) !== JSON.stringify([permit.invoiceId])) continue;
          if (permit === submissionPermit && committed && task.affiliateUrl) {
            const cookieHeader = (await request.allHeaders()).cookie || '';
            const affiliateHeaders=affiliateCookie?cookieHeader.split(';').map(item=>item.trim()).filter(item=>item.startsWith(affiliateCookie.name+'=')):[];
            const cookieOK=!affiliateCookie||affiliateHeaders.length===1&&affiliateHeaders[0]===affiliateCookie.name+'='+affiliateCookie.value;
            const fieldOK = !affiliateField || JSON.stringify(body.getAll(affiliateField.name)) === JSON.stringify([affiliateField.value]);
            if (!affiliateProof || !cookieOK || !fieldOK) { blockedRequest = 'AFF 归因未随订单请求提交，已停止';blockedRequestCode='ORDER_AFFILIATE_UNVERIFIED'; await route.abort(); return; }
            affiliateProof = {...affiliateProof,status:'sent',sentAt:new Date().toISOString()};
          }
          permit.used = true; permit.request=request; permit.onUsed?.(); allowedMutation = true; allowedPayment = permit === paymentPermit;
          appendTrace({action:'许可请求已发出',detail:describeOrderRequest(request.method(),request.url()),transaction:allowedPayment?'payment':submissionStarted?'submission':permit===couponPermit?'coupon':'cart',at:new Date().toISOString()});if(permit===couponPermit)approvedCouponRequest=request;else if(allowedPayment)approvedPaymentRequest=request;else if(submissionStarted&&permit===submissionPermit)approvedSubmissionRequest=request;
        }
      }
      const externalAsset = !request.isNavigationRequest() && ['GET','HEAD'].includes(request.method());
      const affiliateRead = affiliatePhase && new URL(request.url()).origin === affiliateUrl.origin && ['GET','HEAD'].includes(request.method());
      if (dryRunFinancial || (!same && !externalAsset && !affiliateRead) || isPayment && !allowedPayment || isTransaction && (!allowedMutation || loginOnly) || !['GET', 'HEAD'].includes(request.method()) && !allowedMutation) {
        if (same) {
          // Account pages can issue background requests to any endpoint. Aborting
          // one cannot invalidate separate, genuine evidence of authentication.
          const preparingBackground=!submissionStarted&&!paymentStarted&&!orderInteraction&&!mutationPermit&&!couponPermit&&!submissionPermit&&!paymentPermit;
          const telemetry=request.method()==='POST'&&!isTransaction&&!isPayment&&new URL(request.url()).pathname==='/cdn-cgi/rum';
          const background = (loginOnly||readOnlyAccount||verifyingAccount||preparingBackground||telemetry) && !request.isNavigationRequest();
          const phase=loginOnly?'登录':readOnlyAccount||verifyingAccount?'会话验证':task.dryRun?'试跑':paymentStarted?'付款':submissionStarted?'提交订单':'商品准备';
          const detail=clean(phase+'；'+describeOrderRequest(request.method(),request.url()));
          if(blockedRequestNotes++<20)appendTrace({action:background?'拦截后台请求':'拦截请求',detail,structure:inspectRequestStructure(request),reason:isPayment&&!allowedPayment?'付款请求没有对应的单次许可':isTransaction?'订单请求没有对应的单次许可':'未核对的写入请求',permits:[couponPermit,submissionPermit,paymentPermit].filter(Boolean).map(permit=>({target:describeOrderRequest('POST',permit.url),used:permit.used,urlMatches:permitUrlMatches(permit.url,request.url())})),at:new Date().toISOString()});
          if (background) blockedAccountBackground = true;
          else {blockedRequest=(isTransaction||isPayment?'程序尝试了未授权的提交或付款请求':'网页尝试发送未核实的写入请求，已拦截')+'（'+detail+'）';blockedRequestCode='ORDER_REQUEST_BLOCKED';}
        }
        if(!same&&!externalAsset&&!affiliateRead&&(couponPermit||submissionPermit||paymentPermit)){
          blockedRequest='已核对的操作尝试访问其他网站，已拦截';blockedRequestCode='ORDER_ORIGIN_BLOCKED';
          appendTrace({action:'拦截请求',detail:describeOrderRequest(request.method(),request.url()),reason:blockedRequest,permits:[couponPermit,submissionPermit,paymentPermit].filter(Boolean).map(permit=>({target:describeOrderRequest(permit.method||'POST',permit.url),used:permit.used,urlMatches:permitUrlMatches(permit.url,request.url())})),at:new Date().toISOString()});
        }
        await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('response',response=>{void frontendClues.observeResponse(response);});
    let currentObservation=null,currentObservationUrl='';
    const networkStatus=[];
    page.setDefaultTimeout(timeouts.pageTimeoutMs); page.setDefaultNavigationTimeout(timeouts.navigationTimeoutMs);
    const financialResponses=['submit','pay'].includes(task.executionMode)||Boolean(task.couponCode);
    const proxyCredentials=proxy&&(proxy.username||proxy.password);
    if(financialResponses||proxyCredentials){
      // Playwright route handles only the first URL of an HTTP redirect chain.
      // Pause the actual response before any external navigation or POST replay.
      // Response-only Fetch interception cancels authenticated HTTPS proxy
      // challenges. Handle request-stage authentication on this same session.
      const responses=await context.newCDPSession(page);
      if(proxyCredentials)authentication=installProxyAuthentication(responses,proxy,{onRejected:stop});
      responses.on('Fetch.requestPaused',event=>{void (async()=>{
        const headers=event.responseHeaders||[],location=headers.find(header=>header.name.toLowerCase()==='location')?.value;
        const phase=event.request.method==='POST'?(event.request.url===approvedPaymentRequest?.url()?'payment':event.request.url===approvedSubmissionRequest?.url()?'submission':event.request.url===approvedCouponRequest?.url()?'coupon':null):['GET','HEAD'].includes(event.request.method)?financialRedirects.get(event.request.url):null;
        const financial=Boolean(phase);
        if(financial&&event.responseStatusCode>=400){
          blockedRequest='商家请求返回 HTTP '+event.responseStatusCode+'，请核对原订单记录；不会重新提交或付款';
          blockedRequestCode='ORDER_REQUEST_HTTP_ERROR';
        }
        if(financial&&[301,302,303,307,308].includes(event.responseStatusCode)&&location){
          const target=new URL(location,event.request.url),payment=phase==='payment';
          let intercepted=false;
          if(event.request.method==='POST'&&[307,308].includes(event.responseStatusCode)){blockedRequest=phase==='coupon'?'网站要求重发优惠码请求，已停止':'网站要求重发订单或付款请求，已停止；请核对原订单记录';intercepted=true;}
          else if(target.origin!==origin){
            intercepted=true;
            if(payment&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password&&target.href.length<=4000)gatewayHandoff={url:target.href,source:'payment_redirect'};
            else blockedRequest='订单提交跳转到其他网站，已停止；请核对原订单记录';
          }
          if(!intercepted){if(financialRedirects.size>=10){blockedRequest='商家跳转次数过多，请核对原订单';intercepted=true;}else financialRedirects.set(target.href,phase);}
          if(intercepted){
            await responses.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[...headers.filter(header=>!['location','content-length','content-encoding','content-type'].includes(header.name.toLowerCase())),{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from('<main><p>请在工作台查看本次订单或付款结果。</p></main>').toString('base64')});return;
          }
        }
        await responses.send('Fetch.continueRequest',{requestId:event.requestId});
      })().catch(async()=>{if(browser.isConnected()&&financialResponses&&event.responseStatusCode&&!authentication.proxyRejected&&!authentication.websiteRequired){blockedRequest||='无法核对商家跳转响应，已停止';await responses.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}});});
      await responses.send('Fetch.enable',{...(proxyCredentials?{handleAuthRequests:true}:{}),patterns:[...(proxyCredentials?[{urlPattern:'*',requestStage:'Request'}]:[]),...(financialResponses?['Document','XHR','Fetch'].map(resourceType=>({resourceType,requestStage:'Response'})):[])]});
    }

    context.on('page', extra => { if (extra !== page) extra.close().catch(() => {}); });
    const navigate=(url,options)=>browserAuthenticatedNavigation(()=>page.goto(url,options),authentication,Boolean(proxy));
    // Allow slower multi-hop WHMCS navigation when reading the current page.
    const readPageTimeoutMs=Number(process.env.ORDER_READ_PAGE_TIMEOUT_MS)>=1000?Math.round(Number(process.env.ORDER_READ_PAGE_TIMEOUT_MS)):60000;
    const readPage=operation=>settledBrowserRead(operation,{signal,timeoutMs:readPageTimeoutMs,code:'ORDER_NAVIGATION_UNSTABLE',message:'网页跳转尚未稳定，请核对网站订单记录'});
    const ensure = async (allowChallenge = loginOnly, inspectPage = true) => {
      if (signal?.aborted) throw orderGuardError('下单操作已停止','ORDER_ABORTED');
      sameOrigin(page.url());
      if (blockedRequest) throw blockedError();
      if(authentication.proxyRejected||authentication.websiteRequired)throw browserAuthenticationError(new Error('浏览器认证未完成'),authentication,Boolean(proxy));
      if (inspectPage && (!allowChallenge||challengeSolver.enabled()) && isChallengePage(await readPage(()=>page.content()), {})) {
        if(challengeSolver.enabled()&&!challengeAttempted&&!submissionStarted&&!paymentStarted&&!isOrderAccountAction(page.url())){
          challengeAttempted=true;
          const started=Date.now(),remaining=Math.max(1,watchdogDeadline-started);let clearanceObtained=false,solved=false;
          clearTimeout(watchdog);
          try{
            const result=await challengeSolver.solve(page.url(),{proxyUrl,signal,sessionKey:solverSessionKey});
            clearanceObtained=Boolean(result.clearanceObtained);
            for(const cookie of result.cookies||[])if(cookie.value)challengeSecrets.push(cookie.value);
            if(result.userAgent){
              const session=await context.newCDPSession(page);
              await session.send('Network.setUserAgentOverride',{userAgent:result.userAgent});
              clearanceUserAgent=result.userAgent;
            }
            await context.addCookies(result.cookies||[]);
            await navigate(page.url(),{waitUntil:'domcontentloaded'});
            sameOrigin(page.url());
            if(blockedRequest)throw blockedError();
            solved=!isChallengePage(await readPage(()=>page.content()),{});
          }catch{signal?.throwIfAborted();}
          finally{if(!browserClosing)armWatchdog(remaining);appendTrace({action:'FlareSolverr 解验证',success:solved,clearanceObtained,durationMs:Date.now()-started,detail:solved?'挑战已解除':'挑战未解除，请在账户登录窗口完成人工验证'});}
          if(blockedRequest)throw blockedError();
          if(solved)return ensure(allowChallenge,inspectPage);
        }
        if(!allowChallenge){
          const error=new Error('目标网站正在要求验证，请更换可用出口或稍后重试');
          if(challengeSolver.enabled()){error.code='ORDER_CHALLENGE_REQUIRED';error.message='目标网站仍要求验证，请打开账户登录窗口完成人工验证并保存会话后重试';}
          throw error;
        }
      }
      if(new URL(page.url()).searchParams.get('a')==='confproduct')await readPage(()=>page.evaluate(()=>document.readyState));
      while(preparationReads.size)await Promise.all([...preparationReads]);
      if(preparationReadError)throw preparationReadError;
    };
    const one = async key => { await ensure(loginOnly,false); const field = page.locator(selector(key)); if (await field.count() !== 1) throw orderGuardError('网页元素不存在或不唯一：' + key,'ORDER_LOCATOR_UNVERIFIED'); return field; };
    const note = (action, detail) => { appendTrace({ action, detail, at: new Date().toISOString() }); };
    page.on('response',response=>{const request=response.request();if(request.isNavigationRequest()||!['GET','HEAD'].includes(request.method()))appendTrace({action:'网页响应',detail:describeOrderRequest(request.method(),request.url())+'；HTTP '+response.status(),httpStatus:response.status(),method:request.method(),url:diagnosticUrl(request.url()),durationMs:request.timing().responseEnd>=0?Math.round(request.timing().responseEnd):null,at:new Date().toISOString()});});
    page.on('requestfailed',request=>appendTrace({action:'请求失败',detail:describeOrderRequest(request.method(),request.url())+'；'+(request.failure()?.errorText||''),method:request.method(),url:diagnosticUrl(request.url()),failure:request.failure()?.errorText,at:new Date().toISOString()}));
    const sendPermittedRequest=async(button,permit)=>{
      let used,rejected;const sent=new Promise((resolve,reject)=>{used=resolve;rejected=reject;});sent.catch(()=>{});permit.onUsed=used;
      const failed=request=>{if(!permit.used&&(blockedRequest||request.method()===(permit.method||'POST')&&permitUrlMatches(permit.url,request.url())))rejected(blockedRequest?blockedError():orderGuardError('已核对的网站请求发送失败，请核对网站订单记录','ORDER_REQUEST_FAILED'));};page.on('requestfailed',failed);
      let navigated;const navigation=new Promise(resolve=>{navigated=frame=>{if(frame===page.mainFrame())resolve();};page.on('framenavigated',navigated);});
      // Response and redirect waits below own navigation; clicking retains its actionability timeout.
      try{await button.click({noWaitAfter:true});if(!permit.used)await browserOperation(()=>sent,{signal,timeoutMs:timeouts.submitRequestTimeoutMs,code:'ORDER_REQUEST_NOT_SENT',message:'网站没有发出已核对的请求，请核对网站订单记录'});
        const response=await browserOperation(()=>permit.request.response(),{signal,timeoutMs:timeouts.submitResponseTimeoutMs,code:'ORDER_REQUEST_RESPONSE_TIMEOUT',message:'网站尚未返回已核对请求的响应，请核对网站订单记录'});
        if(!response)throw Object.assign(new Error('网站请求未取得响应，请核对网站订单记录'),{code:'ORDER_REQUEST_RESPONSE_MISSING'});
        if(response.status()>=400)throw Object.assign(new Error('商家请求返回 HTTP '+response.status()+'，请核对原订单记录；不会重新提交或付款'),{code:'ORDER_REQUEST_HTTP_ERROR'});
        // A POST response can precede the remaining redirects. Wait for the
        // committed main document before examining payment or order evidence.
        if(permit.request.isNavigationRequest()){
          await browserOperation(()=>navigation,{signal,timeoutMs:timeouts.redirectTimeoutMs,code:'ORDER_REDIRECT_TIMEOUT',message:'网站跳转尚未完成，请核对网站订单记录'});
          await browserOperation(()=>page.waitForLoadState('domcontentloaded',{timeout:timeouts.redirectTimeoutMs}),{signal,timeoutMs:timeouts.redirectTimeoutMs,code:'ORDER_REDIRECT_TIMEOUT',message:'网站跳转尚未完成，请核对网站订单记录'});
        }
      }
      finally{delete permit.onUsed;page.removeListener('requestfailed',failed);page.removeListener('framenavigated',navigated);}
    };
    const actionText = field => field.evaluate(el=>el.innerText||el.value||'');
    const fieldValue = async field => { const info=await field.evaluate(inspectCommerceField);return info.value??info.text; };
    const verifyCurrency = async key => {
      const currencies = String(await fieldValue(await one(key))).toUpperCase().match(/\b[A-Z]{3}\b/g);
      if (currencies?.length !== 1 || currencies[0] !== (expectedCurrency || receipt?.review?.currency)) throw orderGuardError('无法确认订单币种，已停止','ORDER_CURRENCY_UNVERIFIED');
    };
    const beforeOrder = () => { freshProductNavigation=false; if (submissionStarted) throw orderGuardError('订单已提交，不能再修改商品或跳转到其他订单','ORDER_ALREADY_SUBMITTED'); };
    const snapshot = async scope => {
      await ensure();
      if(scope)await one(scope);
      const evidence = await readPage(()=>page.evaluate(scope => {
        const root=scope?document.querySelector(scope):document.body;
        const candidates=[root,...root.querySelectorAll('a,button,input,select,textarea,form,[id],label,h1,h2,h3')].filter(el=>el.getClientRects().length||el.tagName==='INPUT'&&el.type==='hidden');
        const priority=el=>el.closest('nav,header,footer,[role="navigation"]')?0:el.matches('form,input,select,textarea,button,label')?4:el.closest('form,main,[role="main"]')?3:el.matches('h1,h2,h3')?2:1;
        candidates.sort((a,b)=>priority(b)-priority(a));
        const textRoot=scope?root:document.querySelector('main,[role="main"]')||root;
        const text=textRoot.innerText||'';
        return {url:location.origin+location.pathname+location.search.replace(/([?&](?:token|key|password|secret)=)[^&]*/gi,'$1[hidden]'),title:document.title,text:text.slice(0,12000),scope:scope||null,
          truncated:{elements:candidates.length>160,text:text.length>12000},totalElements:candidates.length,
          elements:candidates.slice(0,160).map(el=>({tag:el.tagName.toLowerCase(),id:el.id,class:el.getAttribute('class'),name:el.getAttribute('name'),type:el.getAttribute('type'),text:(el.tagName==='INPUT'?'':el.textContent||'').trim().slice(0,120),href:el.tagName==='A'?el.getAttribute('href'):undefined,action:el.tagName==='FORM'?el.getAttribute('action'):undefined,method:el.tagName==='FORM'?el.method:undefined,disabled:Boolean(el.disabled),form:el.form?.id||undefined,label:(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||'').trim().slice(0,120),value:el.tagName==='INPUT'&&el.type==='radio'?el.value:undefined,checked:el.tagName==='INPUT'&&el.type==='radio'?el.checked:undefined,options:el.tagName==='SELECT'?[...el.options].slice(0,30).map(o=>({value:o.value,text:o.textContent})):undefined}))};
      },scope||null));
      const scrub = value => {
        if (typeof value === 'string') {
          for (const secret of [...Object.values(task.credentials || {}),...loginValues,...challengeSecrets]) if(secret)value=value.split(String(secret)).join('[已隐藏]');
          return value.replace(/([?&](?:token|key|password|secret)=)[^&\s]*/gi,'$1[已隐藏]');
        }
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)]));
        return value;
      };
      return {...scrub(evidence), ...(affiliateEvidence ? {affiliate:{...affiliateEvidence,proof:affiliateProof}} : {})};
    };
    const scrubObservation=value=>{
      if(typeof value==='string'){
        for(const secret of [...Object.values(task.credentials||{}),...loginValues,...challengeSecrets])if(secret)value=value.split(String(secret)).join('[已隐藏]');
        return value.replace(/\bhttps?:\/\/[^\s"'<>]+/g,diagnosticUrl).replace(/([?&](?:token|key|password|secret|csrf|session)[^=]*)=[^&\s"'<>]*/gi,'$1=[已隐藏]');
      }
      if(Array.isArray(value))return value.map(scrubObservation);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrubObservation(item)]));
      return value;
    };
    const observe=async()=>{
      await ensure();const evidence=await readPage(()=>page.evaluate(inspectCommercePage,randomUUID()));currentObservationUrl=evidence.url;
      let choiceProof=null;
      if(paymentChoice?.url===page.url()){
        const field=page.locator(paymentChoice.selector);
        if(await field.count()===1)choiceProof=await field.evaluate((el,{choice,observationId,formMarker})=>{
          const marker=el.getAttribute('data-agent-ref')||'';
          if(!el.form||el.form.getAttribute('data-agent-payment-form')!==formMarker||el.disabled||el.name!==choice.field||String(el.value)!==choice.value||(choice.control==='select'?el.tagName!=='SELECT':el.type!=='radio'||!el.checked)||!marker.startsWith(observationId+':'))return null;
          return {ref:marker.slice(observationId.length+1),value:String(el.value),url:location.href};
        },{choice:paymentChoice,observationId:evidence.observationId,formMarker:paymentFormMarker}).catch(()=>null);
      }
      currentObservation=scrubObservation({...evidence,paymentChoice:choiceProof,frontend:frontendClues.snapshot(),network:networkStatus.slice(-50),...(affiliateEvidence?{affiliate:{...affiliateEvidence,proof:affiliateProof}}:{})});
      return currentObservation;
    };
    page.on('response',response=>{networkStatus.push({url:diagnosticUrl(response.url()),status:response.status(),method:response.request().method()});if(networkStatus.length>50)networkStatus.shift();});
    page.on('requestfailed',request=>{networkStatus.push({url:diagnosticUrl(request.url()),method:request.method(),error:clean(request.failure()?.errorText)});if(networkStatus.length>50)networkStatus.shift();});
    const resolveSemantic=(target,options={})=>resolveSemanticTarget(page,currentObservation,target,{probeTimeoutMs:timeouts.probeTimeoutMs,signal,...options});
    const isObservationCurrent=({observation=currentObservation,...options}={})=>probeLocator(async()=>{
      if(!observation||observation.observationId!==currentObservation?.observationId||currentObservationUrl!==page.url())return false;
      if(!(observation.elements||[]).some(element=>element.ref))return true;
      return await page.locator('[data-agent-ref^='+JSON.stringify(observation.observationId+':')+']').count()>0;
    },{probeTimeoutMs:timeouts.probeTimeoutMs,signal,...options});
    // Only retry result reads; the write request stays outside this callback.
    const verifyWriteResult=async verify=>{
      const confirm=async observation=>{
        if(observation&&!await isObservationCurrent({observation}))throw orderGuardError('当前页面观察已失效，请重新观察','AGENT_OBSERVATION_STALE');
        return verify(observation);
      };
      try{return await confirm(currentObservation);}
      catch(error){
        if(error.code!=='AGENT_OBSERVATION_STALE')throw error;
        return confirm(await observe());
      }
    };
    const readSemantic=async (target,options={})=>{
      const located=await resolveSemantic(target,options),field=await one(located.selector);
      const info=await probeLocator(()=>field.evaluate(inspectCommerceField),{probeTimeoutMs:timeouts.probeTimeoutMs,signal,...options});
      if(info.privateField)throw orderGuardError('私密字段不能用于 AI 配置核验','ORDER_FORM_GUARD');
      const {tag,type,checked,selectedValue,value,text}=info;
      return scrubObservation({tag,type,checked,selectedValue,value,text});
    };
    const captureEvidence=async stage=>{
      await ensure();
      const observation={...scrubObservation(await readPage(()=>page.evaluate(inspectCommercePage,{observationId:randomUUID(),assignRefs:false}))),network:networkStatus.slice(-50)};
      const image='data:image/png;base64,'+(await page.screenshot({mask:[page.locator('input,textarea,[contenteditable="true"],[data-private]')],timeout:5000})).toString('base64');
      const stored=await onEvidence({stage,observation,image});
      note('页面证据',stage+(stored?.id?' · '+stored.id:''));
      return {...stored,image};
    };
    // Read fresh financial evidence without replacing the refs already bound to the form.
    const readConfirmationEvidence=async kind=>confirmationEvidence(scrubObservation(await readPage(()=>page.evaluate(inspectCommercePage,{observationId:randomUUID(),assignRefs:false}))),kind);
    const waitSemanticConfirmation=async(kind,before,observation)=>{
      const until=Date.now()+8000;
      do{
        const observed=confirmationEvidence(observation||await observe(),kind);observation=null;
        if(observed&&(kind==='order'?observed.orderId!==before?.orderId:observed.text!==before?.text))return observed;
        await page.waitForTimeout(150);
      }while(Date.now()<until);
      throw Object.assign(new Error('缺少本次'+(kind==='order'?'订单编号及成功提示':'付款成功提示')+'，请核对网站记录；不会重复操作'),{code:'ORDER_CONFIRMATION_UNVERIFIED'});
    };
    const verifyLogin = async saved => {
      const deadline=Date.now()+loginVerificationTimeoutMs;let observed,stableUrl='';
      do {
        await ensure(true);
        try{observed=await page.evaluate(inspectOrderLogin,saved?.proof||loginProof);}
        catch(error){if(!/Execution context was destroyed|Cannot find context/i.test(error.message))throw error;observed=null;}
        if(observed?.status==='authenticated'&&observed.ready){
          if(stableUrl===observed.url){verifiedLoginCheck={...observed.check,url:sameOrigin(observed.url)};return verifiedLoginCheck;}
          stableUrl=observed.url;
        }else stableUrl='';
        if(Date.now()>=deadline)break;
        await page.waitForTimeout(100);
      }while(Date.now()<deadline);
      await ensure(false);
      const expired=saved&&observed?.status==='logged_out'&&!blockedAccountBackground;
      const detail=blockedAccountBackground?'；验证期间已拦截网页后台写入请求；若账户信息依赖这些请求，请设置同网站可直接读取的登录后账户页面；原会话仍保留':'';
      throw Object.assign(new Error((expired?'网站已返回登录或二次认证页面，请重新登录并保存会话':saved?'当前网页暂时无法确认登录状态；已保存的会话仍保留，请稍后验证':'尚未确认网站登录，请完成登录或二次认证后再保存；当前窗口会保留')+detail),{code:expired?'ORDER_LOGIN_REQUIRED':'ORDER_LOGIN_UNVERIFIED'});
    };
    const visitAffiliate = async () => {
      if(!affiliateUrl)return;
      const before = await context.cookies(task.url);accountBeforeAffiliate=await context.storageState({indexedDB:true});
      affiliatePhase=true;
      try {
        const response=await navigate(affiliateUrl.href,{waitUntil:'domcontentloaded'});
        if(!response || response.status()>=400)throw orderGuardError('AFF 入口不可用，已停止','ORDER_AFFILIATE_UNVERIFIED');
        if(new URL(page.url()).origin!==origin)throw orderGuardError('AFF 入口没有返回下单网站，请使用可到达商家网站的推广链接','ORDER_AFFILIATE_UNVERIFIED');
        const queryKey=task.program?.affiliate?.queryKey||[...affiliateUrl.searchParams.keys()].find(key=>/^(?:aff|affid|affiliate|affiliate_id|ref|refid|referral|partner)$/i.test(key));
        const expected=queryKey&&affiliateUrl.searchParams.get(queryKey),cookieName=task.program?.affiliate?.cookieName;
        const tracked=(await context.cookies(task.url)).some(cookie=>(cookieName?cookie.name===cookieName:/aff|referral|referrer|partner/i.test(cookie.name))&&expected&&(cookie.value===expected||(()=>{try{return decodeURIComponent(cookie.value)===expected;}catch{return false;}})()));
        if(!tracked)await page.waitForTimeout(250);await ensure();
      } finally { affiliatePhase=false; }
      const after=await context.cookies(task.url);
      affiliateEvidence={url:affiliateUrl.href,visitedAt:new Date().toISOString(),landingUrl:clean(page.url()),cookieNames:after.map(c=>c.name),changedCookieNames:after.filter(c=>!before.some(old=>old.name===c.name&&old.domain===c.domain&&old.path===c.path&&old.value===c.value)).map(c=>c.name)};
      note('AFF 入口', '已访问指定入口，等待实际归因核对');
    };
    const verifyAffiliate = async (form, checks) => {
      if(!affiliateUrl)return;
      const proposed=checks || task.program?.affiliate || {};
      const queryKey=proposed.queryKey || [...affiliateUrl.searchParams.keys()].find(key=>/^(?:aff|affid|affiliate|affiliate_id|ref|refid|referral|partner)$/i.test(key));
      const expected=queryKey ? affiliateUrl.searchParams.get(queryKey) : '';
      if(!expected)throw orderGuardError('无法确认 AFF 标识，请重新生成脚本核对推广参数','ORDER_AFFILIATE_UNVERIFIED');
      const cookies=await context.cookies(sameOrigin(form.url));
      const candidate=cookies.find(c=>(proposed.cookieName ? c.name===proposed.cookieName : /aff|referral|referrer|partner/i.test(c.name)) && (c.value===expected || (()=>{try{return decodeURIComponent(c.value)===expected;}catch{return false;}})()));
      if(candidate){if(cookies.filter(cookie=>cookie.name===candidate.name).length!==1)throw orderGuardError('AFF Cookie 存在冲突，无法确定归因，已停止','ORDER_AFFILIATE_UNVERIFIED');affiliateCookie=candidate;affiliateField=null;affiliateProof={status:'verified',via:'cookie',name:candidate.name,affiliateId:expected,visitedAt:affiliateEvidence.visitedAt};}
      else if(proposed.fieldSelector){
        const field=await one(proposed.fieldSelector);
        const value=await field.evaluate((el,submit)=>({name:el.name,value:el.value,belongs:!!el.form&&el.form===document.querySelector(submit)?.form}),checkout.submitSelector);
        if(!value.belongs||!value.name||String(value.value)!==expected)throw orderGuardError('订单中的 AFF 标识与指定推广链接不符，已停止','ORDER_AFFILIATE_UNVERIFIED');
        affiliateCookie=null;affiliateField={name:value.name,value:expected};affiliateProof={status:'verified',via:'field',name:value.name,affiliateId:expected,visitedAt:affiliateEvidence.visitedAt};
      }else throw orderGuardError('无法验证指定 AFF 的归因 Cookie 或订单字段，已停止在提交前','ORDER_AFFILIATE_UNVERIFIED');
      note('AFF 核对','已确认 '+affiliateProof.name+' 对应指定推广标识');
    };
    const couponError=(message,code='ORDER_COUPON_UNVERIFIED')=>Object.assign(new Error(message),{code});
    // Only failed discount evidence can use the configured fallback. Request
    // binding, authentication and transaction errors always retain their guard.
    const couponOutcomeError=(message,code)=>Object.assign(couponError(message,code),{couponOutcome:true});
    const readCouponProof=async(checks,configured=true)=>{
      await ensure();
      const code=page.locator(selector(checks.appliedCodeSelector)),discount=page.locator(selector(checks.discountSelector));
      if(await code.count()!==1||await discount.count()!==1||!await code.isVisible()||!await discount.isVisible())throw couponOutcomeError('无法确认优惠码已生效及实际减免金额，已停止在下单前');
      const evidence=await code.evaluate((el,total)=>({value:'value' in el?String(el.value):el.innerText,editable:el.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(el.tagName)&&!el.disabled&&!el.readOnly,sameTotal:el===document.querySelector(total)}),checkout.totalSelector);
      if(evidence.editable||evidence.sameTotal)throw couponOutcomeError('优惠码生效证据不能使用可编辑输入或订单总价');
      const label=String(evidence.value||'').trim(),escaped=Array.from(task.couponCode,c=>'.*+?^$(){}|[]'.includes(c)||c.charCodeAt(0)===92?String.fromCharCode(92)+c:c).join('');
      if(/invalid|expired|reject|not.{0,12}(?:valid|applied)|fail|无效|过期|失败|未.{0,5}生效|不.{0,5}适用/i.test(label.split(task.couponCode).join('')))throw couponOutcomeError('网站未接受优惠码，已停止在下单前','ORDER_COUPON_REJECTED');
      if(configured&&!new RegExp('(^|[^\\p{L}\\p{N}_-])'+escaped+'($|[^\\p{L}\\p{N}_-])','iu').test(label))throw couponOutcomeError('网站已应用的优惠码与配置不符，已停止在下单前');
      const amount=await discount.evaluate((el,total)=>({text:el.innerText,sameTotal:el===document.querySelector(total)}),checkout.totalSelector);
      if(amount.sameTotal)throw couponOutcomeError('优惠金额必须是实际减免金额，不能使用百分比或订单总价');
      let value;try{value=parseOrderTotal(String(amount.text).replace(/\d+(?:[.,]\d+)?\s*(?:%|percent\b|个百分点)/gi,'').replace(/[−-]/g,''));}catch{throw couponOutcomeError('无法唯一确认优惠减免金额');}
      if(value<=0)throw couponOutcomeError('优惠码没有产生可确认的减免金额，已停止在下单前','ORDER_COUPON_REJECTED');
      return {code:configured?task.couponCode:label,discount:value};
    };
    const preserveCouponPayment=async()=>{
      if(!paymentChoice||task.executionMode!=='pay'||parseOrderTotal(await (await one(checkout.totalSelector)).innerText())===0)return;
      // A coupon response can recreate the form and discard host DOM markers.
      // Rebind only the same field/value within the newly reviewed checkout form.
      if(await page.locator(paymentChoice.selector).count()!==1){
        const marker=randomUUID(),button=await one(checkout.submitSelector);
        const rebound=await button.evaluate((button,{choice,marker})=>{
          const candidates=[...(button.form?.elements||[])].filter(el=>el.name===choice.field&&(el.tagName==='SELECT'?'select':el.type)===choice.control&&!el.disabled&&(el.type!=='radio'||el.value===choice.value));
          if(candidates.length!==1)return false;
          candidates[0].setAttribute('data-agent-coupon-payment',marker);return true;
        },{choice:paymentChoice,marker});
        if(!rebound)throw Object.assign(new Error('优惠后无法唯一恢复原付款方式，请重新识别当前付款控件'),{code:'AGENT_ELEMENT_MISSING'});
        await choosePayment({selector:'[data-agent-coupon-payment="'+marker+'"]',value:paymentChoice.value});return;
      }
      const {info}=await readPaymentChoice(paymentChoice.selector,paymentChoice.value);
      if(info.value!==paymentChoice.value||info.type==='radio'&&!info.checked)await choosePayment({selector:paymentChoice.selector,value:paymentChoice.value});
      else paymentChoice={...paymentChoice,url:page.url(),field:info.name,control:info.type,label:info.label};
    };
    const continueWithoutCoupon=async error=>{
      if(task.couponFailurePolicy!=='continue'||!error.couponOutcome)throw error;
      await ensure();
      couponProof=null;
      couponFailure={code:task.couponCode,status:error.code==='ORDER_COUPON_REJECTED'?'rejected':'unverified',failurePolicy:'continue',errorCode:error.code,reason:clean(error.message).replace(/，已停止(?:在下单前)?$/, '')};
      note('优惠码失败继续',couponFailure.reason+'；按用户预选继续，仍核对网站实际总价和预算上限');
      await preserveCouponPayment();
      return {couponFailure:{...couponFailure}};
    };
    const applyCoupon=async(checks,liveChecks,{rebind}={})=>{
      beforeOrder();
      if(!task.couponCode||loginOnly||readOnlyAccount||verifyingAccount)throw couponError('当前阶段没有配置可应用的优惠码');
      if(couponAttempted)throw couponError('同一次流程不重复应用优惠码');couponAttempted=true;
      if(liveChecks){for(const key of ['submitSelector','productSelector','quantitySelector','totalSelector','currencySelector','confirmationSelector'])selector(liveChecks[key]);checkout={...liveChecks};}
      try{
      if(!checks||typeof checks!=='object'||Array.isArray(checks))throw couponOutcomeError('缺少优惠码实际控件，无法确认生效');
      for(const key of ['inputSelector','applySelector','appliedCodeSelector','discountSelector'])selector(checks[key]);
      couponChecks={...checks};
      try{couponProof=await readCouponProof(couponChecks);note('优惠码','已核验同一优惠码和减免金额，复用已应用优惠');await preserveCouponPayment();return couponProof;}catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;}
      let previousDiscount=0;try{previousDiscount=(await readCouponProof(couponChecks,false)).discount;}catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;}
      const beforeTotal=parseOrderTotal(await (await one(checkout.totalSelector)).innerText())+previousDiscount;
      await ensure();
      const input=page.locator(checks.inputSelector),button=page.locator(checks.applySelector);
      if(await input.count()!==1||await button.count()!==1||!await input.isVisible()||!await button.isVisible())throw couponOutcomeError('优惠码控件不存在、不唯一或不可见，无法确认生效');
      const form=await button.evaluate(inspectOrderForm,{kind:'coupon',selector:checks.inputSelector});
      if(!form?.coupon||form.payment||!['text','search'].includes(form.coupon.type)||form.method!=='POST'||form.encoding!=='application/x-www-form-urlencoded'||(paymentWords.test(form.text)||purchaseWords.test(form.text))||!/(?:apply|redeem|validat|coupon|promo|discount|应用|使用|兑换|优惠|折扣)/i.test(form.text)||checks.applySelector===checkout.submitSelector)throw couponError('无法核对优惠码输入和独立应用按钮，已停止在下单前');
      const target=sameOrigin(form.url).split('#')[0],orderButton=await one(checkout.submitSelector),orderForm=await orderButton.evaluate(inspectOrderForm,{kind:'submit',selector:checkout.quantitySelector});
      if(orderRequestKind(target)||orderForm&&target===sameOrigin(orderForm.url).split('#')[0])throw couponError('优惠码操作指向订单提交或付款地址，已停止在下单前');
      await input.fill(task.couponCode);
      const bound=await button.evaluate(inspectOrderForm,{kind:'coupon',selector:checks.inputSelector});
      if(!bound?.coupon||bound.coupon.value!==task.couponCode||sameOrigin(bound.url).split('#')[0]!==target||bound.method!=='POST')throw couponError('优惠码表单在填写后发生变化，已停止');
      const permit={url:target,used:false,coupon:{name:bound.coupon.name,value:task.couponCode}};couponPermit=permit;
      note('优惠码','正在应用配置中的优惠码');
      try{await sendPermittedRequest(button,permit);}finally{couponPermit=null;}
      await verifyWriteResult(()=>ensure());
      if(!permit.used)throw couponError('网站没有发送已核对的优惠码请求');
      if(rebind){const fresh=await rebind();couponChecks={...fresh.coupon};checkout={...checkout,...fresh.checkout};}
      const deadline=Date.now()+couponVerificationTimeoutMs;let lastError;
      do{
        await ensure();
        try{const proof=await readCouponProof(couponChecks),afterTotal=parseOrderTotal(await (await one(checkout.totalSelector)).innerText());
          if(Math.round(afterTotal*100)<Math.round(beforeTotal*100)){couponProof=proof;break;}
          lastError=couponOutcomeError('优惠码应用后总价没有降低，已停止在下单前','ORDER_COUPON_REJECTED');
        }catch(error){if(!['ORDER_COUPON_UNVERIFIED','ORDER_COUPON_REJECTED'].includes(error.code))throw error;lastError=error;}
        if(Date.now()>=deadline)break;await page.waitForTimeout(100);
      }while(Date.now()<deadline);
      if(!couponProof)throw lastError||couponOutcomeError('网站未确认优惠码生效，已停止在下单前');
      note('优惠码','已核验实际优惠 '+couponProof.discount+'，按优惠后总价核对');await preserveCouponPayment();return couponProof;
      }catch(error){return await continueWithoutCoupon(error);}
    };
    const review = async () => {
      await ensure();
      const checks=checkout;
      const read=async(key,input=false)=>{const field=page.locator(selector(key));if(await field.count()!==1)throw orderGuardError('网页元素不存在或不唯一：'+key,'ORDER_LOCATOR_UNVERIFIED');return input?fieldValue(field):field.innerText();};
      for(const item of checkout.configuration||[]){const field=await one(item.selector),actual=await fieldValue(field);if(!matchesOrderConfiguration(item.value,actual))throw Object.assign(new Error('提交前商品配置发生变化：'+item.name),{code:'AGENT_CONFIGURATION_UNVERIFIED'});}
      const [productText,totalText,quantityText,currencyText]=await Promise.all([read(checks.productSelector),read(checks.totalSelector),read(checks.quantitySelector,true),read(checks.currencySelector,true)]);
      if(!productText.trim()||productText.trim().length>200)throw orderGuardError('无法确认当前订单的商品，已停止','ORDER_PRODUCT_UNVERIFIED');
      if(expectedProduct&&!productMatches(expectedProduct,productText))throw Object.assign(new Error('订单中的商品与配置不符，已停止'),{code:'ORDER_PRODUCT_MISMATCH'});
      const total=parseOrderTotal(totalText),currency=explicitOrderCurrency(currencyText);
      if(!currency||expectedCurrency&&currency!==expectedCurrency)throw Object.assign(new Error('无法确认订单币种，已停止'),{code:'ORDER_CURRENCY_UNVERIFIED'});
      const observedQuantity=parseOrderQuantity(quantityText);
      if(observedQuantity<task.quantity&&observedQuantity>=1){
        const field=await one(checks.quantitySelector),fixed=await field.evaluate(el=>!['INPUT','SELECT','TEXTAREA'].includes(el.tagName)||el.readOnly||el.disabled||el.type==='hidden');
        if(fixed)throw quantityLimit(observedQuantity,'网站当前单笔订单支持 '+observedQuantity+' 件，将按该数量重新核价');
      }
      if(observedQuantity!==task.quantity)throw Object.assign(new Error('订单数量与配置不符，已停止'),{code:'ORDER_QUANTITY_MISMATCH'});
      if(task.couponCode&&!couponFailure&&(!couponAttempted||!couponChecks||!couponProof))throw couponError('配置了优惠码但尚未核验生效，已停止');
      if(total>task.maxTotal)throw Object.assign(new Error('订单总价超过上限：'+currency+' '+total+'，剩余预算 '+task.maxTotal),{code:'ORDER_BUDGET_EXCEEDED',quote:{quantity:task.quantity,total,currency}});
      let coupon=null;
      if(task.couponCode&&!couponFailure){
        if(!couponAttempted||!couponChecks||!couponProof)throw couponError('配置了优惠码但尚未核验生效，已停止');
        try{coupon=await readCouponProof(couponChecks);if(coupon.discount!==couponProof.discount)throw couponOutcomeError('优惠减免金额发生变化，已停止');}
        catch(error){await continueWithoutCoupon(error);return review();}
      }
      if(total===0&&!coupon)throw orderGuardError('零金额订单缺少已核验的优惠依据，已停止','ORDER_TOTAL_UNVERIFIED');
      return {product:expectedProduct||productText.trim(),quantity:task.quantity,total,currency:expectedCurrency||currency,...(checkout.semantic?{configuration:(checkout.configuration||[]).map(({name,value})=>({name,value}))}:{}),...(coupon?{coupon}:{}),...(couponFailure?{couponFailure:{...couponFailure}}:{})};
    };
    const readPaymentChoice=async (key,value)=>{
      const field=await one(key);
      const info=await field.evaluate((el,wanted)=>{
        const readable=node=>(node?.innerText||node?.textContent||'').replace(/\s+/g,' ').trim();
        if(el.tagName==='SELECT'){
          const options=[...el.options].filter(option=>!option.disabled).map(option=>({value:option.value,label:readable(option)}));
          const chosen=options.filter(option=>option.value===(wanted ?? el.value));
          return {type:'select',name:el.name,value:el.value,label:chosen.length===1?chosen[0].label:'',options,valid:chosen.length===1&&!el.disabled,form:!!el.form};
        }
        if(el.tagName==='INPUT'&&el.type==='radio'){
          const radios=[...document.querySelectorAll('input[type=radio]')].filter(radio=>radio.form===el.form&&radio.name===el.name&&!radio.disabled);
          const options=radios.map(radio=>({value:radio.value,label:readable(radio.labels?.[0])||radio.getAttribute('aria-label')||''}));
          return {type:'radio',name:el.name,value:el.value,label:readable(el.labels?.[0])||el.getAttribute('aria-label')||'',options,valid:!el.disabled&&(!wanted||el.value===wanted)&&options.filter(option=>option.value===el.value).length===1,form:!!el.form,checked:el.checked};
        }
        return {valid:false};
      },value==null?null:String(value));
      if(info.form&&info.options?.some(option=>paymentBrand(option.label)||paymentMatchesIntent(option.label,paymentIntent)))paymentOptions=info.options.slice(0,30).map(option=>({...option,label:String(option.label).slice(0,150),kind:paymentBrand(option.label)==='balance'?'balance':'website'}));
      if(!info.valid||!info.form||!info.name||info.name.length>200||String(info.value).length>300||!info.label||info.label.length>150||!paymentMatchesIntent(info.label,paymentIntent))throw Object.assign(new Error('网页付款选项与预选方式不符，无法确认 '+paymentIntent.name),{code:'ORDER_PAYMENT_UNVERIFIED'});
      return {field,info};
    };
    const choosePayment=async checks=>{
      if(task.executionMode!=='pay')throw orderGuardError('该任务没有允许自动付款','ORDER_PAYMENT_UNVERIFIED');
      if(paymentStarted||submissionStarted&&(receipt?.status!=='ordered'||page.url()!==orderPage))throw orderGuardError('只能为本次订单选择预先指定的付款方式','ORDER_PAYMENT_UNVERIFIED');
      if(!checks||typeof checks!=='object')throw orderGuardError('缺少付款方式定位','ORDER_PAYMENT_UNVERIFIED');
      const key=selector(checks.selector),{field,info}=await readPaymentChoice(key,checks.value);
      if(info.type==='select'){
        const wanted=String(checks.value ?? info.value);
        if(info.value!==wanted)await field.selectOption(wanted);
      }else if(!info.checked)await field.check();
      const observed=await readPaymentChoice(key);
      if(observed.info.type==='radio'&&!observed.info.checked)throw orderGuardError('网站没有接受预选的付款方式','ORDER_PAYMENT_UNVERIFIED');
      paymentChoice={kind:paymentIntent.kind,name:paymentIntent.name,label:observed.info.label,value:observed.info.value,field:observed.info.name,control:observed.info.type,selector:key,url:page.url(),options:observed.info.options.slice(0,30).map(option=>({...option,kind:paymentBrand(option.label)==='balance'?'balance':'website'}))};
      const identity=randomUUID();await field.evaluate((el,id)=>{el.setAttribute('data-agent-payment',id);el.form.setAttribute('data-agent-payment-form',id);},identity);
      paymentChoice.selector='[data-agent-payment="'+identity+'"]';paymentFormMarker=identity;
      if(task.verifiedPaymentMethod&&!samePaymentChoice(task.verifiedPaymentMethod,paymentChoice))throw orderGuardError('网站付款方式已变化，请重新试跑','ORDER_PAYMENT_UNVERIFIED');
      note('付款方式',paymentChoice.label+' · 已按实际网页选中');return {...paymentChoice,url:undefined};
    };
    const bindPaymentChoice=async(button)=>{
      if(!paymentChoice||paymentChoice.url!==page.url())return null;
      const {info}=await readPaymentChoice(paymentChoice.selector);
      const belongs=await button.evaluate((el,key)=>el.form===document.querySelector(key)?.form,paymentChoice.selector);
      if(!belongs||info.value!==paymentChoice.value||info.name!==paymentChoice.field||info.type==='radio'&&!info.checked)throw orderGuardError('实际付款方式已变化，已停止','ORDER_PAYMENT_UNVERIFIED');
      return paymentChoice;
    };
    const rememberConfiguration=async field=>{
      const marker=randomUUID(),proof=await field.evaluate((el,marker)=>{
        if(!el.form||!el.name)return null;
        el.setAttribute('data-order-configured',marker);
        return {name:el.name,type:el.type,value:String(el.value||''),checked:el.checked};
      },marker);
      if(proof)configuredFields.set(marker,{...proof,url:page.url()});
    };
    const cartError=(message,buttonText)=>Object.assign(preparationInput(message,buttonText),{code:'ORDER_CART_UNVERIFIED'});
    const preparationInput=(message,buttonText)=>Object.assign(new Error(message),{code:'AGENT_NEEDS_INPUT',orderInput:{question:message,url:clean(page.url()),candidates:buttonText?[{label:String(buttonText).slice(0,200)}]:[]}});
    const contractError=(message,transport,requests=[])=>Object.assign(new Error(message),{code:'ORDER_CONTRACT_UNVERIFIED',orderContract:{status:'unverified',transport,requests,verified:false},orderInput:{question:message+' 请确认当前页面是否已到最终提交页，或提供该网站的下单步骤；现有商品、数量和预算要求保持不变。',url:clean(page.url()),candidates:[]}});
    const probeSubmission=async(button,form)=>{
      // Keep the fence until close: a probed page must never later send a transaction.
      contractProbe={requests:[],count:0,permit:form?nativeRequestPermit(form):null};
      await button.click({timeout:3000}).catch(()=>{});
      await page.waitForTimeout(500);
      const observed=contractProbe.requests;
      if(contractProbe.count!==1||observed.length!==1||!observed[0].matches)throw contractError('已阻止探测请求：当前按钮未发出唯一且与已核对表单完全一致的原生请求；不能确认 JavaScript 或 AJAX 改写后的提交。',form?'native':'ajax_candidate',observed.map(item=>item.structure));
      return nativeRequestContract(form);
    };
    const matchesPreparation=value=>parseOrderQuantity(value)===task.quantity||(task.program?.workflow?.requirements||[]).some(item=>matchesOrderConfiguration(item.value,value));
    const registerPreparation=async step=>{
      if(!['fill','select','check','uncheck'].includes(step?.action))return false;
      const located=await resolveSemantic(step.target),field=await one(located.selector);
      const info=await field.evaluate(inspectCommerceField);
      if(!info.form||!info.name||info.disabled||info.type==='password')return false;
      const matched=['check','uncheck'].includes(step.action)?info.checked===(step.action==='check'):step.value!==undefined&&info.rawValue===String(step.value);
      if(!matched)throw preparationInput('当前配置控件的实际值已经变化，请重新识别该控件及用户要求。');
      if(!matchesPreparation(info.value))return false;
      await rememberConfiguration(field);return true;
    };
    const methods = {
      choosePayment,applyCoupon,observe,resolveSemantic,readSemantic,isObservationCurrent,registerPreparation,
      matchesProduct:async(expected,observed)=>productMatches(expected,observed),
      pause:async milliseconds=>{beforeOrder();if(!Number.isInteger(milliseconds)||milliseconds<100||milliseconds>2000)throw orderGuardError('等待超出预算','ORDER_WAIT_BUDGET_EXCEEDED');await page.waitForTimeout(milliseconds);await ensure();return true;},
      configure:async (key,checks={})=>methods.cart(key,{...checks,configuration:true}),
      rebindCoupon:async checks=>{if(!couponProof&&!couponFailure)throw couponError('尚未验证优惠');for(const key of ['appliedCodeSelector','discountSelector'])selector(checks[key]);couponChecks={...couponChecks,...checks};return true;},
      screenshot:async()=>{await ensure();return 'data:image/png;base64,'+(await page.screenshot({mask:[page.locator('input,textarea,[contenteditable="true"],[data-private]')],timeout:5000})).toString('base64');},
      goto: async url => { const fresh=freshProductNavigation,target=sameOrigin(url);beforeOrder();if(!fresh||target!==task.url||page.url()!==target)await navigate(target, { waitUntil: 'domcontentloaded' }); await ensure(); note('访问', page.url()); return true; },
      snapshot, exists: async key => { await ensure(); return await page.locator(selector(key)).count() === 1; },
      text: async key => clean(await (await one(key)).innerText()),
      fill: async (key, value) => {
        beforeOrder();
        if (typeof value !== 'string' && typeof value !== 'number' || String(value).length > 2000) throw orderGuardError('填写内容无效','ORDER_INPUT_INVALID');
        const field = await one(key);
        if (await field.evaluate(el => el.type === 'password' || /(?:cardnumber|card_number|ccnumber|cvv|cvc)/i.test(el.name || el.id))) throw orderGuardError('账号凭据只能使用 login，银行卡信息不能交给 AI 填写','ORDER_LOGIN_UNVERIFIED');
        await field.fill(String(value)); await rememberConfiguration(field); note('填写', key); return true;
      },
      select: async (key, value) => { beforeOrder(); const field=await one(key); await settledPageAction(page,()=>field.selectOption(String(value)),{timeoutMs:stateTimeoutMs,signal}); await ensure(); await rememberConfiguration(field); note('选择', key); return true; },
      check: async key => { beforeOrder(); const field=await one(key); await field.check(); await rememberConfiguration(field); note('勾选', key); return true; },
      uncheck: async key => { beforeOrder(); const field=await one(key); await field.uncheck(); await rememberConfiguration(field); note('取消勾选', key); return true; },
      click: async key => {
        beforeOrder();
        const field = await one(key);
        const description = await field.evaluate(el => ({ text: el.innerText || el.value || '', href:el.tagName==='A'?el.getAttribute('href'):null, submit: !!el.form && (el.tagName === 'BUTTON' && (!el.type || el.type === 'submit') || el.tagName === 'INPUT' && ['submit','image'].includes(el.type)) }));
        const destination=description.href?new URL(description.href,page.url()):null,current=new URL(page.url());
        const transaction=destination&&orderRequestKind(destination.href);
        const navigation=destination&&['http:','https:'].includes(destination.protocol)&&destination.origin===origin&&destination.pathname+destination.search!==current.pathname+current.search&&!transaction;
        if (key === task.program?.checkout?.submitSelector || description.submit || transaction || paymentWords.test(description.text) || purchaseWords.test(description.text)&&!navigation) throw orderGuardError('提交表单只能通过受控的 login、cart、submit 或 pay 操作','ORDER_FORM_GUARD');
        await settledPageAction(page,()=>field.click(),{timeoutMs:stateTimeoutMs,signal}); await ensure(); note('点击', key); return true;
      },
      cart: async (key,{configuration=false,productSelector}={}) => {
        beforeOrder();
        const button = await one(key),form=await button.evaluate(inspectOrderForm,{kind:'cart'}),whmcs=await button.evaluate(inspectWhmcsConfiguration);
        const mapped=whmcs?whmcsConfigurationPermit(whmcs):null;
        if(!form?.nativeSubmit||!form.entries||key===checkout?.submitSelector||paymentWords.test(form.text)||form.method!=='GET'&&purchaseWords.test(form.text)||form.payment||/terms|条件|条款|billing\s+address|payment\s+method|最终结算|确认订单|提交订单/i.test(form.content)||form.fields.some(field=>field.type==='password'&&!(whmcs&&field.name==='rootpw')||/paymentmethod|payment_method|gateway|cardnumber|card_number|ccnumber|cvv|cvc|usecredit|applycredit|autopay|savedpayment/i.test(field.name)||/(?:^|\s)(?:billing\b|cc-|transaction-)/i.test(field.autocomplete)))throw cartError('无法把当前按钮确认成独立的商品配置或购物车操作，请指出配置入口或最终提交入口。',form?.text);
        const target = sameOrigin(mapped?.url||form.url).split('#')[0];
        if(orderRequestKind(target))throw cartError('当前表单指向订单或付款地址，请先进入结算核对流程。',form.text);
        if(!['GET','POST'].includes(form.method)||form.method==='POST'&&form.encoding!=='application/x-www-form-urlencoded')throw contractError('当前配置使用的请求格式缺少可绑定的原生表单，请确认该网站的配置步骤。','preparation');
        let identity=expectedProduct||task.productSelection?.text;
        // A blank product name can be discovered during preparation, but only from
        // a current semantic binding owned by this actual product/form region.
        if(!identity&&productSelector){
          const product=await one(selector(productSelector)),text=(await product.innerText()).replace(/\s+/g,' ').trim();
          const belongs=await button.evaluate((button,key)=>{
            const form=button.form,node=document.querySelector(key),region=form?.closest('main,article,section,[role="main"]')||form?.parentElement||form;
            return !!node&&!!region&&region.contains(node)&&(form.contains(node)||region.querySelectorAll('form').length===1)&&!!node.getClientRects().length&&!node.closest('nav,header,footer,[role="navigation"]');
          },productSelector);
          if(belongs&&text&&text.length<=200)identity=text;
        }
        const productBound=!!identity&&(form.productTexts.some(text=>matchesProductSelection(identity,text))||whmcsProductMatches(identity,whmcs));
        const configured=form.fields.some(field=>{
          const proof=configuredFields.get(field.marker);
          return !field.disabled&&proof?.url===page.url()&&proof.name===field.name&&proof.type===field.type&&proof.value===field.value&&proof.checked===field.checked&&matchesPreparation(field.display);
        });
        // Site wording supplements the product and configuration structure.
        const cartPattern=siteProfile?.origin===origin?siteProfile.formPatterns?.cart:null;
        let explicitCart=false;
        if(typeof cartPattern==='string'&&cartPattern.length<=500){try{explicitCart=new RegExp(cartPattern,'i').test(form.text);}catch{throw cartError('网站购物车文案配置无效，请核对站点配置。',form.text);}}
        const selected=form.fields.some(field=>!field.disabled&&field.name&&['text','number','select-one','select-multiple','radio'].includes(field.type)&&(!['radio'].includes(field.type)||field.checked)&&matchesPreparation(field.display));
        if(!productBound||!configured&&!selected&&!(whmcs&&!(task.program?.workflow?.requirements||[]).length))throw cartError('当前表单缺少目标商品与用户配置的对应证据。请确认商品区域及数量／规格控件，不能仅凭按钮名称发送准备请求。',form.text);
        if(!expectedProduct&&identity)expectedProduct=identity;
        for(const title of whmcs?.productTitles||[])if(whmcsProductMatches(identity,{productTitles:[title]}))configuredProductTitles.add(title);
        const cartMutation=!configuration||explicitCart;
        submissionPermit={...(mapped||nativeRequestPermit({...form,url:target})),...(whmcs?{whmcs:true}:{}),used:false,expiresAt:Date.now()+8000};
        try { await settledPageAction(page,()=>sendPermittedRequest(button,submissionPermit),{timeoutMs:Math.max(stateTimeoutMs,readPageTimeoutMs),signal}); await verifyWriteResult(()=>ensure()); }
        catch(error){
          if(submissionPermit?.used){
            note('准备核验失败原文',(error.code||error.name||'Error')+': '+(error.message||''));
            throw Object.assign(new Error('准备写请求已发出但结果未核验，请检查购物车后重新试跑；不会自动重放'),{code:'ORDER_PREPARATION_UNCERTAIN'});
          }
          throw error;
        }
        finally { submissionPermit = null; }
        note(cartMutation?'购物车':'配置继续', key); return {cartMutation};
      },
      login: async (usernameSelector, passwordSelector, buttonSelector) => {
        beforeOrder();
        if(loginCheck&&!refreshingLogin)throw orderGuardError('请在监控的下单账户区重新登录，不在下单时切换账户','ORDER_LOGIN_UNVERIFIED');
        if (!task.credentials?.username || !task.credentials?.password) throw orderGuardError('网站需要登录，请在任务中保存该网站账号','ORDER_LOGIN_UNVERIFIED');
        const userField = await one(usernameSelector), passwordField = await one(passwordSelector), button = await one(buttonSelector);
        if (await passwordField.getAttribute('type') !== 'password' || buttonSelector === task.program?.checkout?.submitSelector) throw orderGuardError('登录表单无效','ORDER_LOGIN_UNVERIFIED');
        if (!await passwordField.evaluate((el, key) => !!el.form && !!el.form.querySelector(key), selector(buttonSelector))) throw orderGuardError('登录按钮必须属于密码表单','ORDER_LOGIN_UNVERIFIED');
        await userField.fill(task.credentials.username); await passwordField.fill(task.credentials.password);
        mutationPermit = true;
        try { await button.click(); await page.waitForTimeout(400); await ensure(); }
        finally { mutationPermit = false; }
        note('登录', '使用已保存的网站账号'); return true;
      },
      wait: async key => { await page.locator(selector(key)).waitFor({ state: 'visible' }); await ensure(); return true; },
      submit: async liveChecks => {
        if(liveChecks){for(const key of ['submitSelector','productSelector','quantitySelector','totalSelector','currencySelector','confirmationSelector'])selector(liveChecks[key]);checkout={...liveChecks};}
        if (committed) throw orderGuardError('同一任务不得重复提交','ORDER_ALREADY_SUBMITTED');
        const checked = await review();
        const button = await one(checkout.submitSelector);
        if (/pay\s*(?:now|invoice)|支付|付款|扣款/i.test(await actionText(button))) throw orderGuardError('下单和付款需要分步核对，已停在提交前','ORDER_PAYMENT_UNVERIFIED');
        const form=await button.evaluate(inspectOrderForm,{kind:'submit',selector:checkout.quantitySelector});
        if(!form?.nativeSubmit||!form.entries||form.method!=='POST'||form.encoding!=='application/x-www-form-urlencoded'||form.payment){
          if((task.dryRun||task.executionMode==='prepare')&&!form)await probeSubmission(button,null);
          throw contractError('当前提交缺少可绑定的原生表单。AJAX、JSON 或合并付款操作需要明确的请求映射，不能根据字段名猜测许可。',form?'native':'ajax_candidate');
        }
        if(form.invalidFields?.length)throw Object.assign(new Error('请先完成网站必填或格式要求：'+form.invalidFields.join('、')),{code:'AGENT_CONFIGURATION_UNVERIFIED'});
        const target=sameOrigin(form.url).split('#')[0];
        if(orderRequestKind(target)==='payment')throw orderGuardError('订单表单指向付款地址，已停止在提交前','ORDER_PAYMENT_UNVERIFIED');
        if(form.quantity&&parseOrderQuantity(form.quantity.display)!==task.quantity)throw orderGuardError('订单表单的数量与已核对的数量不符，已停止','ORDER_QUANTITY_MISMATCH');
        const beforeConfirmation=checkout.semantic?await readConfirmationEvidence('order'):null;
        if(!checkout.semantic&&await page.locator(selector(checkout.confirmationSelector)).isVisible())throw Object.assign(new Error('订单确认元素在提交前已经存在，无法验证新订单成功状态'),{code:'ORDER_CONFIRMATION_UNVERIFIED'});
        await verifyAffiliate(form);
        const choice=task.executionMode==='pay'&&checked.total>0?await bindPaymentChoice(button):null;
        if(task.executionMode==='pay'&&checked.total>0&&paymentIntent.kind==='website'&&!choice)throw Object.assign(new Error('请先在当前结算页面选择网站付款方式：'+paymentIntent.name),{code:'ORDER_PAYMENT_UNVERIFIED'});
        const requestContract=nativeRequestContract(form);
        if(task.executionMode==='prepare'||task.dryRun){
          const reviewedUrl=clean(page.url());
          note('提交契约','已核对当前表单地址、方式及完整参数；实际发送时匹配本次字段，不试点提交按钮');
          receipt={status:'prepared',review:checked,url:reviewedUrl,affiliate:affiliateProof,requestContract,paymentMethod:choice?{...choice,url:undefined}:null,paymentVerification:task.executionMode==='pay'?(checked.total===0?'not_required_zero_total':choice?'verified':'invoice_only'):null};return receipt;
        }
        let submittedCoupon=null;
        if(task.couponCode&&couponChecks){const field=page.locator(selector(couponChecks.inputSelector));if(await field.count()>1)throw couponError('优惠码输入不唯一');if(await field.count()===1)submittedCoupon=await field.evaluate((el,key)=>el.form===document.querySelector(key)?.form&&el.name&&!el.disabled?{name:el.name,value:String(el.value)}:null,checkout.submitSelector);if(submittedCoupon&&submittedCoupon.value!==task.couponCode)throw couponError('提交表单中的优惠码发生变化，已停止');}
        committed = true;
        await onBeforeSubmit({...checked,affiliate:affiliateProof});
        submissionStarted = true;
        submissionPermit = { ...nativeRequestPermit({...form,url:target}), used:false,expiresAt:Date.now()+8000,quantity:form.quantity,...(submittedCoupon?{coupon:submittedCoupon}:{}),...(choice?{methodField:choice.field,methodValue:choice.value}:{}) };
        note('提交', '正在提交一次订单');
        const permit = submissionPermit;
        try { await sendPermittedRequest(button,permit); }
        finally { submissionPermit = null; }
        if (!permit.used) throw orderGuardError(blockedRequest || '网站没有提交已核对的订单请求','ORDER_REQUEST_NOT_SENT');
        return verifyWriteResult(async observation=>{
          const semanticConfirmation=checkout.semantic?await waitSemanticConfirmation('order',beforeConfirmation,observation):null;
          if(!checkout.semantic)await page.locator(selector(checkout.confirmationSelector)).waitFor({ state: 'visible' });
          await ensure(); orderPage = page.url();
          receipt = { status: 'ordered', review: checked, confirmation: clean(semanticConfirmation?.text||await page.locator(checkout.confirmationSelector).innerText()),...(semanticConfirmation?{orderId:semanticConfirmation.orderId}:{}), url: clean(orderPage), affiliate:affiliateProof };
          if(task.executionMode==='pay'&&checked.total===0){receipt={...receipt,status:'awaiting_payment',paymentPending:{reason:'zero_total',message:'优惠后金额为 0，已提交订单且无需发起付款；请在商家页面确认免费订单状态'}};note('零金额订单',receipt.paymentPending.message);}
          return receipt;
        });
      },
      invoice: async key => {
        if(paymentStarted||receipt?.status!=='ordered'||page.url()!==orderPage)throw orderGuardError('只能打开本次新订单页面明确关联的账单','ORDER_PAYMENT_UNVERIFIED');
        const link=await one(key),observed=await link.evaluate(el=>({tag:el.tagName,href:el.getAttribute('href'),text:el.innerText}));
        if(observed.tag!=='A'||!observed.href||!/invoice|bill|账单|发票/i.test(observed.href+' '+observed.text))throw orderGuardError('所选链接不是订单账单','ORDER_PAYMENT_UNVERIFIED');
        const href=sameOrigin(new URL(observed.href,orderPage).href),target=new URL(href),invoiceId=target.searchParams.get('invoiceid')||target.searchParams.get('id');
        if(!/^[\w-]{1,100}$/.test(invoiceId||'')||!/invoice|bill|账单|发票/i.test(target.pathname))throw orderGuardError('无法绑定新订单账单号','ORDER_PAYMENT_UNVERIFIED');
        const links=await page.locator('a[href]').evaluateAll(nodes=>nodes.filter(el=>el.getClientRects().length&&/invoice|bill|账单|发票/i.test(el.getAttribute('href')+' '+el.innerText)).map(el=>new URL(el.href)).filter(url=>url.origin===location.origin&&/invoice|bill|账单|发票/i.test(url.pathname)&&(url.searchParams.has('invoiceid')||url.searchParams.has('id'))).map(url=>url.href));
        if(new Set(links).size!==1||links[0]!==href)throw orderGuardError('新订单页面存在多个账单，无法确定应付款的账单','ORDER_PAYMENT_UNVERIFIED');
        await navigate(href,{waitUntil:'domcontentloaded'});await ensure();
        if(page.url()!==href)throw orderGuardError('账单地址发生变化，已停止','ORDER_PAYMENT_UNVERIFIED');
        orderPage=page.url();receipt={...receipt,invoiceId,url:clean(orderPage)};note('打开账单','已打开本次订单关联的账单 '+invoiceId);return receipt;
      },
      pay: async checks => {
        if (task.executionMode !== 'pay') throw orderGuardError('该任务没有允许自动付款','ORDER_PAYMENT_UNVERIFIED');
        if (task.dryRun) { if (receipt?.status !== 'prepared') throw orderGuardError('付款前必须核对订单','ORDER_PAYMENT_UNVERIFIED'); return receipt; }
        if (paymentStarted || receipt?.status !== 'ordered' || page.url() !== orderPage) throw orderGuardError('只能支付本次刚创建的订单一次','ORDER_PAYMENT_UNVERIFIED');
        if (!checks || typeof checks !== 'object') throw orderGuardError('缺少付款核对字段','ORDER_PAYMENT_UNVERIFIED');
        for (const key of ['paySelector','invoiceSelector','totalSelector','currencySelector','confirmationSelector']) selector(checks[key]);
        const invoiceField=await one(checks.invoiceSelector),invoice=await invoiceField.evaluate(el=>({id:String(el.value||'').trim(),name:el.name,form:!!el.form}));
        const invoiceFromUrl=new URL(orderPage).searchParams.get('invoiceid')||new URL(orderPage).searchParams.get('id')||receipt.invoiceId;
        if(!invoice.form||!invoice.name||!/^[\w-]{1,100}$/.test(invoice.id)||(invoiceFromUrl?invoice.id!==invoiceFromUrl:!/(?:invoice|invid|orderid|order_id)/i.test(invoice.name||'')||!String(receipt.confirmation||'').includes(invoice.id)))throw orderGuardError('无法确认当前订单的付款账单号，已停止','ORDER_PRODUCT_UNVERIFIED');
        receipt={...receipt,invoiceId:invoice.id};
        const total=parseOrderTotal(await (await one(checks.totalSelector)).innerText());await verifyCurrency(checks.currencySelector);
        if(total>task.maxTotal||Math.round(total*100)!==Math.round(receipt.review.total*100))throw orderGuardError('付款金额与已核对的订单总价不符，已停止','ORDER_PAYMENT_UNVERIFIED');
        const currency=receipt.review.currency;
        const defer=(reason,message,extra={})=>{note('保留待付款订单',message);receipt={...receipt,status:'awaiting_payment',paymentPending:{reason,message,...extra}};return receipt;};
        if(checks.paymentMethod)await choosePayment(checks.paymentMethod);
        const button=await one(checks.paySelector),form=await button.evaluate(inspectOrderForm,{kind:'pay',selector:checks.invoiceSelector});
        if(!form||form.method!=='POST'||form.encoding!=='application/x-www-form-urlencoded'||!form.invoiceMatches||form.cardData)throw orderGuardError('付款表单无法与本次账单核对，已停止','ORDER_PAYMENT_UNVERIFIED');
        const target=sameOrigin(form.url).split('#')[0];
        if(orderRequestKind(target)==='submission')throw orderGuardError('付款表单指向创建订单地址，已停止在付款前','ORDER_PAYMENT_UNVERIFIED');
        let choice=await bindPaymentChoice(button);
        const selectedMethods=form.controls.filter(control=>paymentBrand(control.label)||paymentMatchesIntent(control.label,paymentIntent));
        if(selectedMethods.some(control=>!paymentMatchesIntent(control.label,paymentIntent)))return defer('method_unverified','当前网页选中的付款方式与预选方式不符，已保留账单');
        if(!choice&&selectedMethods.length===1){const selected=selectedMethods[0];choice={kind:paymentIntent.kind,name:paymentIntent.name,label:selected.label,field:selected.name,value:selected.value,control:'selected'};}
        const methodText=await actionText(button);
        if(!choice&&paymentIntent.kind==='balance'&&paymentMatchesIntent(methodText,paymentIntent)&&!form.hiddenMethods.some(field=>field.value))choice={kind:'balance',name:paymentIntent.name,label:methodText,control:'button'};
        if(!choice||!paymentMatchesIntent(choice.label,paymentIntent)||task.verifiedPaymentMethod&&!samePaymentChoice(task.verifiedPaymentMethod,choice))return defer('method_unverified','无法从网页确认预选付款方式，已保留账单，请在网站付款');
        if(form.hiddenMethods.some(field=>field.value&&(field.name!==choice.field||field.value!==choice.value)))return defer('method_unverified','付款表单存在未核实的其他支付设置，已保留账单');
        let balance;
        if(paymentIntent.kind==='balance'){
          if(!checks.balanceSelector||!checks.balanceCurrencySelector)return defer('balance_unverified','无法核实账户余额，已保留待付款订单');
          try{
            balance=parseOrderTotal(await fieldValue(await one(checks.balanceSelector)));
            const balanceCurrencies=String(await fieldValue(await one(checks.balanceCurrencySelector))).toUpperCase().match(/\b[A-Z]{3}\b/g);
            if(balanceCurrencies?.length!==1||balanceCurrencies[0]!==currency)return defer('balance_unverified','账户余额币种无法与本次账单核对，已保留订单');
          }catch{return defer('balance_unverified','账户余额无法读取，已保留待付款订单');}
          if(Math.round(balance*100)<Math.round(total*100))return defer('insufficient_balance','余额不足，已保留待付款订单；不会改用其他付款方式',{balance,total,currency,shortfall:Math.round((total-balance)*100)/100});
        }
        const finalTotal=parseOrderTotal(await (await one(checks.totalSelector)).innerText());await verifyCurrency(checks.currencySelector);
        if(finalTotal>task.maxTotal||Math.round(finalTotal*100)!==Math.round(total*100))throw orderGuardError('选择付款方式后账单金额发生变化，已停止付款','ORDER_PAYMENT_UNVERIFIED');
        const checked={invoiceId:invoice.id,total,currency,paymentMethod:{...choice,url:undefined},...(balance===undefined?{}:{balance})};
        const beforeConfirmation=checks.semantic?await readConfirmationEvidence('payment'):null;
        if(!checks.semantic&&await page.locator(checks.confirmationSelector).isVisible())throw orderGuardError('付款确认元素在付款前已经存在，无法验证成功状态','ORDER_CONFIRMATION_UNVERIFIED');
        let pendingSelector=checks.pendingSelector;
        if(checks.semantic&&pendingSelector){
          const pending=await one(pendingSelector),marker=randomUUID();
          await pending.evaluate((el,id)=>el.setAttribute('data-order-payment-pending',id),marker);
          pendingSelector='[data-order-payment-pending="'+marker+'"]';
        }
        await onBeforePayment(checked);paymentStarted=true;gatewayHandoff=null;
        paymentPermit={url:target,invoiceField:invoice.name,invoiceId:invoice.id,used:false,...(choice.field?{methodField:choice.field,methodValue:choice.value}:{})};
        const permit=paymentPermit;note('付款','正在支付账单 '+invoice.id+' · '+choice.label+' · '+currency+' '+total);
        try{await sendPermittedRequest(button,permit);}catch(error){if(!gatewayHandoff)throw error;}finally{paymentPermit=null;}
        if(!permit.used)throw orderGuardError(blockedRequest||'网站没有提交已核对的付款请求','ORDER_PAYMENT_UNVERIFIED');
        receipt={...receipt,payment:checked,paymentMethod:checked.paymentMethod};
        if(gatewayHandoff)return defer('external_payment','已进入 '+choice.label+' 收银台，需要扫码或验证后完成付款',{cashierUrl:gatewayHandoff.url,cashierSource:gatewayHandoff.source});
        return verifyWriteResult(async observation=>{
          await ensure();
          if(pendingSelector){
            const pending=checks.semantic?page.locator(pendingSelector):await one(pendingSelector),count=checks.semantic?await pending.count():1;
            if(checks.semantic&&count===0)note('付款状态核验','pending 标记因页面重渲染或跳转丢失，未能判断扫码状态；请在网站收银台确认是否需要扫码或验证');
            if(count===1&&await pending.isVisible()&&/scan|qr|verify|authentication|扫码|二维码|驗證|验证|認証/i.test(await pending.innerText()))return defer('payment_verification','付款已发起，请在网站收银台完成扫码或验证',{cashierUrl:page.url(),cashierSource:'merchant_page'});
          }
          const semanticConfirmation=checks.semantic?await waitSemanticConfirmation('payment',beforeConfirmation,observation):null;
          if(!checks.semantic)await page.locator(checks.confirmationSelector).waitFor({state:'visible'});await ensure();
          const confirmation=semanticConfirmation?.text||await page.locator(checks.confirmationSelector).innerText();
          if(/unpaid|not\s+paid|unsuccessful|pending|failed|declined|未支付|未付款|失败|失敗|impayé|non\s+payé|unbezahlt|nicht\s+bezahlt|no\s+pagado|non\s+pagato/i.test(confirmation)||!/\bpaid\b|\bpayment\s+(?:successful|complete)\b|\bsuccess\b|已支付|支付成功|已付款|payée?|bezahlt|pagad[oa]|pagat[oa]|оплачен|支払済|支払い完了|결제\s*완료/i.test(confirmation))throw orderGuardError('网站尚未确认付款成功','ORDER_CONFIRMATION_UNVERIFIED');
          receipt={...receipt,status:'paid',payment:checked,confirmation:clean(confirmation),url:clean(page.url())};return receipt;
        });
      }

    };
    // Keep a background timer separate from a write caused by a preparation
    // action. Reads/waits do not grant mutation permission or poison login.
    // Waiting for a field to become editable does not make unrelated timers
    // foreground actions. Unknown writes stay blocked without poisoning reads.
    for(const key of ['click','cart','login']){
      const action=methods[key];methods[key]=async(...args)=>{orderInteraction++;try{return await action(...args);}finally{orderInteraction--;}};
    }
    const remote = {
      view: async () => {
        await ensure(true);
        const login=await page.evaluate(inspectOrderLogin,loginProof||loginCheck?.proof);
        const result=await page.evaluate(({next,loggedIn})=>{const fields=loggedIn?[]:[...document.querySelectorAll('input')].filter(el=>el.getClientRects().length&&!el.disabled&&!/search|搜索|查询/i.test(el.name+' '+el.placeholder)&&['text','email','password','tel','number','checkbox'].includes(el.type)&&(el.closest('[data-order-login-form]')||!el.form&&/username|email|password|otp|captcha|verification|验证码/i.test(el.name+' '+el.autocomplete+' '+el.getAttribute('aria-label')))).slice(0,20).map(el=>{if(!el.dataset.orderLoginField)el.dataset.orderLoginField='field-'+(next++);return{key:el.dataset.orderLoginField,type:el.type,label:(el.labels?.[0]?.innerText||el.getAttribute('aria-label')||el.placeholder||el.name||el.type).slice(0,100)};});return {fields,next};},{next:remoteFieldCounter,loggedIn:login.status==='authenticated'});
        remoteFieldCounter=result.next;const fields=result.fields;
        return {url:clean(page.url()),loginStatus:login.status,width:1280,height:900,fields,image:'data:image/png;base64,'+(await page.screenshot()).toString('base64')};
      },
      act: async input => {
        if(!loginOnly)throw orderGuardError('此浏览器不是登录会话','ORDER_LOGIN_UNVERIFIED');
        await ensure(true);
        if(input.type==='fill'){
          if(!/^field-\d+$/.test(input.key)||typeof input.value!=='string'||input.value.length>512)throw orderGuardError('登录输入无效','ORDER_LOGIN_UNVERIFIED');
          const field=page.locator('[data-order-login-field="'+input.key+'"]');if(await field.count()!==1)throw orderGuardError('登录表单已变化，请刷新登录页面','ORDER_LOGIN_UNVERIFIED');
          if(input.value)loginValues.push(input.value);await field.fill(input.value);
        }else if(input.type==='scroll'){await page.mouse.wheel(0,Math.max(-900,Math.min(900,Number(input.delta)||0)));}
        else if(input.type==='click'){
          const x=Number(input.x),y=Number(input.y);if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1280||y<0||y>900)throw orderGuardError('登录点击位置无效','ORDER_LOGIN_UNVERIFIED');
          const target=await page.evaluate(({x,y})=>{const node=document.elementFromPoint(x,y)?.closest('a,button,input,label');if(!node)return null;return{text:node.innerText||node.value||'',href:node.getAttribute('href')||'',action:node.form?(node.hasAttribute('formaction')?node.formAction:node.form.action):'',loginForm:node.form?.hasAttribute('data-order-login-form'),fields:node.form?[...node.form.elements].map(el=>el.name||el.id).join(' '):''};},{x,y});
          const financialTarget=target&&[target.href,target.action].filter(Boolean).some(value=>isOrderAccountAction(new URL(value,page.url()).href));
          if(target&&(financialTarget||/cardnumber|cvv|cvc/i.test(target.fields)||!target.loginForm&&(/\b(?:pay|checkout|cart|orders?|register|signup)\b|购买|下单|付款|支付|注册/i.test(target.text)||/billing|quantity/i.test(target.fields))))throw orderGuardError('登录窗口只用于登录，商品和付款请使用下单配置','ORDER_PAYMENT_UNVERIFIED');
          await page.mouse.click(x,y);
        }else if(input.type==='check'){
          if(!/^field-\d+$/.test(input.key))throw orderGuardError('登录选项无效','ORDER_LOGIN_UNVERIFIED');await page.locator('[data-order-login-field="'+input.key+'"]').setChecked(Boolean(input.checked));
        }else if(input.type==='refresh'){await browserAuthenticatedNavigation(()=>page.reload({waitUntil:'domcontentloaded'}),authentication,Boolean(proxy));}else throw orderGuardError('不支持的登录操作','ORDER_LOGIN_UNVERIFIED');
        await page.waitForTimeout(250);await ensure(true);return remote.view();
      },
      finish: async () => {
        if(task.checkUrl&&page.url()!==sameOrigin(task.checkUrl))await navigate(sameOrigin(task.checkUrl),{waitUntil:'domcontentloaded'});
        const check=await verifyLogin();
        const state=await browserOperation(()=>context.storageState({indexedDB:true}),{signal,timeoutMs:15000,code:'ORDER_LOGIN_SAVE_TIMEOUT',message:'读取登录存储超时；当前登录窗口保留，请稍后重试'});
        if(clearanceUserAgent)state.radarUserAgent=clearanceUserAgent;
        const storage=await readPage(()=>page.evaluate(()=>Object.fromEntries(Object.entries(sessionStorage))));
        if(JSON.stringify([state,storage]).length>1024*1024)throw orderGuardError('网站登录状态过大，无法保存','ORDER_LOGIN_UNVERIFIED');
        if(check.proof){
          // A public heading must not turn a user-selected marker into proof
          // of authentication. Check absence without this account's storage.
          let anonymous;
          try{
            anonymous=await createOrderBrowser({url:check.url},{proxyUrl,launch,loginOnly:true,accountReadOnly:true,restoringSession:true,loginProof:check.proof,timeoutMs:15000,signal,onTrace});
            if((await anonymous.remote.view()).loginStatus==='authenticated')throw Object.assign(new Error('所选账户标记在未登录时也存在，请选择仅登录后可见的账户信息'),{code:'ORDER_LOGIN_UNVERIFIED'});
          }finally{if(anonymous)await closeOrderBrowser(anonymous);}
        }
        for(let attempt=0;attempt<2;attempt++){
        let restored;
        try{
          restored=await createOrderBrowser({url:check.url,credentials:task.credentials,accountId:task.accountId},{proxyUrl,launch,challengeSolver,restoringSession:true,timeoutMs:30000,signal,storageState:state,sessionStorageState:storage,loginCheck:check,loginVerificationTimeoutMs,onTrace});
          const restoredState=await browserOperation(()=>restored.accountState(),{signal,timeoutMs:10000,code:'ORDER_BROWSER_TIMEOUT',message:'读取恢复后的会话超时，当前登录窗口保留'});
          return {...restoredState,check:restoredState.check||check,redactions:[...loginValues,...(check.proof?.text?[check.proof.text]:[])],testedAt:new Date().toISOString()};
        }catch(error){
          signal?.throwIfAborted();
          if(!attempt&&['ORDER_BROWSER_CLOSED','ORDER_BROWSER_TIMEOUT'].includes(error.code))continue;
          if(['ORDER_LOGIN_REQUIRED','ORDER_LOGIN_UNVERIFIED'].includes(error.code))throw Object.assign(new Error('当前窗口的会话尚不能在新浏览器恢复，请等待网站完成登录或选择记住登录后再保存；当前窗口会保留'),{code:'ORDER_LOGIN_UNVERIFIED'});
          throw error;
        }finally{if(restored)await closeOrderBrowser(restored);}
        }
      }
    };
    if(loginCheck){
      await methods.goto(loginCheck.url);
      if(trigger==='restock'&&!readOnlyAccount&&!loginOnly&&task.credentials?.username&&task.credentials?.password){
        const state=await page.evaluate(inspectOrderLogin,loginCheck.proof||loginProof);
        if(state.status==='logged_out'){
          const fields=await page.evaluate(()=>{
            const forms=[...document.querySelectorAll('[data-order-login-form]')];if(forms.length!==1)return null;
            const visible=el=>!!el.getClientRects().length&&!el.disabled;
            const inputs=[...forms[0].elements].filter(visible),passwords=inputs.filter(el=>el.type==='password'&&el.autocomplete!=='new-password'),users=inputs.filter(el=>['text','email'].includes(el.type)&&/username|email|login/i.test(el.name+' '+el.autocomplete+' '+el.id)),buttons=inputs.filter(el=>(el.tagName==='BUTTON'||el.tagName==='INPUT')&&el.type==='submit');
            if(passwords.length!==1||users.length!==1||buttons.length!==1)return null;
            const selectors=[users[0],passwords[0],buttons[0]].map((el,index)=>{el.setAttribute('data-order-login-refresh',String(index));return '[data-order-login-refresh="'+index+'"]';});return selectors;
          });
          if(fields){refreshingLogin=true;try{await methods.login(...fields);}finally{refreshingLogin=false;}note('账户预热','已使用保存凭据刷新登录，等待账户验证');}
        }
      }
      await verifyLogin(loginCheck);note('账户验证','已验证事先保存的登录会话');
    }
    if(!loginOnly)await visitAffiliate();
    if(page.url()!==sameOrigin(task.url)&&!(loginCheck&&sameOrigin(task.url)===sameOrigin(loginCheck.url)))await methods.goto(task.url);
    if(task.productSelection){
      if(sameOrigin(task.productSelection.url)!==sameOrigin(task.url))throw orderGuardError('点选商品的页面已变化','ORDER_PRODUCT_UNVERIFIED');
      const selectedText=task.productSelection.text.replace(/\s+/g,' ').trim();
      if(task.program?.workflow?.version===1){
        const chosen=await one(task.productSelection.selector);
        if(!matchesProductSelection(selectedText,await chosen.innerText()))throw orderGuardError('点选商品身份或规格已变化，请重新点选并试跑','ORDER_PRODUCT_UNVERIFIED');
      }else{
        const visibleText=await readPage(()=>page.evaluate(()=>document.body.innerText));
        const identity=productIdentityText(selectedText),visibleIdentity=' '+productIdentityText(visibleText)+' ';
        if(!/[\p{L}\p{N}]/u.test(identity)||!visibleIdentity.includes(' '+identity+' '))throw orderGuardError('点选商品身份或规格已变化，请重新点选','ORDER_PRODUCT_UNVERIFIED');
      }
      note('商品点选','已核对用户手动选中的真实网页区域');
    }
    if(storageSeed){await storageSeed.dispose();await readPage(()=>page.evaluate(marker=>sessionStorage.removeItem(marker),seedMarker));}
    verifyingAccount=false;freshProductNavigation=true;
    return { keepAlive:milliseconds=>{if(browserClosing)return false;armWatchdog(milliseconds);return true;}, methods, snapshot, captureEvidence, trace, remote, verifyLogin, dryRun:Boolean(task.dryRun||task.executionMode==='prepare'), productHtml:async()=>{await ensure();return page.content();}, get paymentOptions(){return paymentOptions;}, get submissionStarted() { return submissionStarted; }, get paymentStarted() { return paymentStarted; }, get receipt() { return receipt; }, accountState:async()=>{
      const state=await browserOperation(()=>context.storageState({indexedDB:true}),{signal,timeoutMs:stateTimeoutMs,code:'ORDER_ACCOUNT_STATE_TIMEOUT',message:'读取登录存储超时，原保存会话仍保留',onTimeout:stop});
      if(clearanceUserAgent)state.radarUserAgent=clearanceUserAgent;
      const newAffiliateCookies=(affiliateEvidence?.changedCookieNames||[]).filter(name=>!accountBeforeAffiliate.cookies.some(cookie=>cookie.name===name));
      const affiliateNames=new Set([...newAffiliateCookies,affiliateCookie?.name,task.program?.affiliate?.cookieName].filter(Boolean));
      state.cookies=state.cookies.filter(cookie=>!affiliateNames.has(cookie.name));
      for(const cookie of (accountBeforeAffiliate||storageState)?.cookies||[])if(affiliateNames.has(cookie.name))state.cookies.push(cookie);
      let sessionStorage=sessionStorageState||{};
      if(new URL(page.url()).origin===origin){
        try{sessionStorage=await readPage(()=>page.evaluate(()=>Object.fromEntries(Object.entries(window.sessionStorage))));}
        catch(error){
          // Chromium can retain the merchant URL on an opaque error document.
          // Do not discard freshly rotated cookies because that document has
          // no storage access. The next use must still verify authentication.
          if(!/SecurityError:.*sessionStorage[\s\S]*Access is denied/i.test(error.message))throw error;
          note('会话存储保留','错误页面无法读取会话存储，保留原值并保存更新后的 Cookie；下次使用仍须核验登录');
        }
      }
      if(JSON.stringify([state,sessionStorage]).length>1024*1024)throw orderGuardError('登录状态过大','ORDER_LOGIN_UNVERIFIED');return {state,sessionStorage,...(verifiedLoginCheck?{check:verifiedLoginCheck}:{})};
    }, diagnostics:async()=>{
      const base={url:clean(page.url()),submissionStarted,paymentStarted,blockedRequest:clean(blockedRequest),authentication:{proxyRejected:Boolean(authentication.proxyRejected),websiteRequired:Boolean(authentication.websiteRequired)}};
      try{const info=await browserOperation(()=>page.evaluate(()=>({title:document.title,controls:[...document.querySelectorAll('a,button,input,select,textarea,form')].slice(0,100).map(el=>({tag:el.tagName.toLowerCase(),id:el.id,name:el.getAttribute('name'),type:el.getAttribute('type'),href:el.tagName==='A'?el.getAttribute('href'):undefined,action:el.tagName==='FORM'?el.getAttribute('action'):undefined}))})),{signal,timeoutMs:1500,code:'ORDER_DIAGNOSTIC_TIMEOUT',message:'页面诊断读取超时'});return diagnosticPage({...base,...info});}catch(error){return {...base,unavailable:clean(error.message)};}
    }, close: async () => { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await stop(); } };
  } catch (error) { clearTimeout(watchdog); signal?.removeEventListener('abort', stop); await closeOrderBrowser({close:stop});signal?.throwIfAborted();error=browserAuthenticationError(error,authentication,Boolean(proxy));if(blockedRequestCode&&!timedOut&&!authentication.proxyRejected&&!authentication.websiteRequired&&!isBrowserClosedError(error))error=blockedError();if(timedOut)throw Object.assign(new Error('浏览器校验登录会话超时，原会话仍保留，请稍后重试'),{code:'ORDER_BROWSER_TIMEOUT'});if(isBrowserClosedError(error))throw Object.assign(new Error('浏览器恢复登录会话时意外关闭，原会话仍保留，请稍后重试'),{code:'ORDER_BROWSER_CLOSED'});throw Object.assign(new Error(clean(error.message)),{code:error.code}); }
}
