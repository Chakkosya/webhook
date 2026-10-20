const $=selector=>document.querySelector(selector),signup=location.pathname==='/signup';
async function api(path,body){const response=await fetch('/api/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'操作失败');return result;}
const feedback=(text,error=false)=>{$('#auth-feedback').textContent=text;$('#auth-feedback').dataset.error=String(error);};
let status;
try{
 status=await api('auth/status');
 if(status.user)location.replace('/');
 const setup=status.setup&&signup;
 if(signup){
  document.title='Sign Up · 确定性工作流';$('#auth-title').textContent=setup?'创建你的工作台':'Sign Up';$('#auth-eyebrow').textContent=setup?'GET STARTED':'MAKE IT YOURS';
  $('#auth-description').textContent=setup?'首次使用：创建管理员账号，进入后可配置邮件注册。':'用邮箱注册，开启自己的监控空间。';
  $('#auth-password').autocomplete='new-password';$('#auth-submit').textContent=setup?'创建管理员并进入':'Sign Up →';
  $('#verification-field').hidden=setup;$('#auth-code').required=!setup;
  $('#auth-switch').replaceChildren(document.createTextNode('已有账号？ '),Object.assign(document.createElement('a'),{href:'/signin',textContent:'Sign In'}));
  if(!setup&&!status.mailConfigured)feedback('管理员尚未配置发信服务，暂不能发送注册验证码。',true);
 }else if(status.setup){
  $('#auth-description').textContent='工作台尚未初始化，请先创建管理员。';
  $('#auth-switch').replaceChildren(Object.assign(document.createElement('a'),{href:'/signup',textContent:'创建管理员 →'}));
 }
 $('#'+(signup?'signup':'signin')+'-link').setAttribute('aria-current','page');
}catch(error){feedback(error.message,true);}
$('#send-code').onclick=async()=>{
 if(!$('#auth-email').reportValidity())return;
 const button=$('#send-code');button.disabled=true;
 try{await api('auth/code',{email:$('#auth-email').value});feedback('验证码已发送，请检查收件箱与垃圾邮件。');let remaining=60;button.textContent=remaining+' 秒后重发';const timer=setInterval(()=>{remaining--;button.textContent=remaining?remaining+' 秒后重发':'发送验证码';if(!remaining){clearInterval(timer);button.disabled=false;}},1000);}
 catch(error){feedback(error.message,true);button.disabled=false;}
};
$('#auth-form').onsubmit=async event=>{
 event.preventDefault();if(!status)return;const button=$('#auth-submit');button.disabled=true;
 try{
  await api(signup?(status.setup?'auth/setup':'auth/register'):'auth/signin',{email:$('#auth-email').value,password:$('#auth-password').value,code:$('#auth-code').value});
  $('#auth-password').value='';location.replace('/');
 }catch(error){feedback(error.message,true);}finally{button.disabled=false;}
};