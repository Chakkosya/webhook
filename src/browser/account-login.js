import {perform,until} from './wait.js';
import {fail,Fault} from '../errors.js';
import {hideCredentials} from './session.js';
const policy={absoluteMs:180000,idleMs:45000};
export async function authenticated(browser,recipe){
 if(!recipe)return false;
 const marker=browser.page.locator(recipe.authenticated);
 return await marker.count()===1&&await marker.isVisible()&&!await browser.page.locator('input[type="password"]:visible').count();
}
async function learnForm(page){
 return page.evaluate(()=>{
  const visible=element=>!!element.getBoundingClientRect().width&&!!element.getBoundingClientRect().height;
  const selector=element=>{
   if(element.id&&document.querySelectorAll('#'+CSS.escape(element.id)).length===1)return '#'+CSS.escape(element.id);
   const parts=[];for(let node=element;node&&node!==document.body;node=node.parentElement){const siblings=[...node.parentElement.children].filter(item=>item.tagName===node.tagName);parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');}
   return 'body > '+parts.join(' > ');
  };
  const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);
  if(passwords.length!==1)return null;
  const password=passwords[0],form=password.form;if(!form)return null;
  const fields=[...form.querySelectorAll('input')].filter(element=>visible(element)&&element!==password&&['text','email'].includes(element.type));
  const usernames=fields.filter(element=>element.autocomplete==='username'||element.type==='email');
  const username=usernames.length===1?usernames[0]:fields.length===1?fields[0]:null;
  const buttons=[...form.querySelectorAll('button,input[type="submit"]')].filter(element=>visible(element)&&element.type==='submit'&&!element.disabled);
  if(!username||buttons.length!==1)return null;
  const button=buttons[0],method=(button.getAttribute('formmethod')||form.method).toUpperCase(),url=new URL(button.getAttribute('formaction')||form.action,location.href);
  if(method!=='POST'||url.origin!==location.origin)return null;
  return {username:selector(username),password:selector(password),submit:selector(button),url:url.href,method};
 });
}
async function learnMarker(page){
 return page.evaluate(()=>{
  const elements=[...document.querySelectorAll('a,button')].filter(el=>el.getBoundingClientRect().width&&el.getBoundingClientRect().height&&(/(?:log[ -]?out|sign[ -]?out|退出登录|退出|登出|注销)/i.test(el.textContent.trim())||el.tagName==='A'&&/(?:logout|signout)/i.test(el.getAttribute('href')||'')));
  if(elements.length!==1)return null;
  const element=elements[0];
  if(element.id&&document.querySelectorAll('#'+CSS.escape(element.id)).length===1)return '#'+CSS.escape(element.id);
  const parts=[];for(let node=element;node&&node!==document.body;node=node.parentElement){const siblings=[...node.parentElement.children].filter(item=>item.tagName===node.tagName);parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');}
  return 'body > '+parts.join(' > ');
 });
}
export async function loginAccount(browser){
 const account=browser.account;
 if(account.health?.status==='uncertain')fail('AUTH_UNCERTAIN','上次登录结果未确认，请在任务账户中手动检测');
 if(account.health?.status==='rejected')fail('LOGIN_REJECTED','站点已拒绝账号密码，请编辑账户后手动检测');
 await browser.navigate(account.loginUrl,policy);
 const form=await learnForm(browser.page);
 if(!form)fail('LOGIN_FORM','未找到唯一的账号密码登录表单；此页面可能需要人工验证码或站点专用学习');
 await browser.page.bringToFront();
 await browser.page.locator(form.username).fill(account.username);
 await browser.page.locator(form.password).fill(account.password);
 const request=await browser.page.locator(form.submit).evaluate(button=>{
  const form=button.form,values=[...new FormData(form)];if(button.name)values.push([button.name,button.value]);
  return {url:new URL(button.getAttribute('formaction')||form.action,location.href).href,method:'POST',body:new URLSearchParams(values).toString()};
 });
 let sent=false;
 browser.authPermit={...request,onSent:()=>{sent=true;}};browser.authSent=false;
 try{
  await perform(()=>browser.page.locator(form.submit).click({timeout:policy.absoluteMs}),policy,browser.progress);
  let marker;
  await until(async()=>{
   if(!sent)return false;
   marker=await learnMarker(browser.page);
   if(marker)return true;
   if(await browser.page.locator('input[type="password"]:visible').count()&&browser.authSent)fail('LOGIN_REJECTED','登录未通过，请核对账号密码或完成站点人机验证');
   return false;
  },policy,browser.progress);
  const recipe={...form,authenticated:marker};
  if(!await authenticated(browser,recipe))fail('SESSION','没有可核验的已登录标识');
  browser.account={...account,recipe,health:{status:'ready',at:new Date().toISOString()}};
  browser.onAccount?.({recipe,health:browser.account.health});
 }catch(error){
  const cause=hideCredentials(error,[account.password,account.username]),message=cause.message;
  const health={status:error.code==='LOGIN_REJECTED'?'rejected':sent?'uncertain':'failed',message,at:new Date().toISOString()};
  browser.account={...account,health};browser.onAccount?.({health});
  throw new Fault(error.code||'SESSION',message,{cause});
 }finally{browser.authPermit=null;}
}
