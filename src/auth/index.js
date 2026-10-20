import {randomBytes,randomInt,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import nodemailer from 'nodemailer';
import {fail,Fault} from '../errors.js';
import {secureRequest} from './origin.js';
const derive=promisify(scrypt),lifetime=30*86400000;
const emailAddress=value=>{const email=String(value||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail('AUTH_INPUT','请填写有效的邮箱地址');return email;};
export class WebsiteAuth {
 constructor(runtime,{sendMail,now=()=>Date.now()}={}){
  this.runtime=runtime;this.db=runtime.kernel.db;this.store=runtime.workspace;this.sendMail=sendMail;this.now=now;
  this.db.exec('CREATE TABLE IF NOT EXISTS app_users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,owner INTEGER NOT NULL,verified INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS app_sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS app_attempts(email TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL)');
 }
 users(){return this.db.prepare('SELECT id,email,owner,verified FROM app_users').all().map(user=>({...user,owner:!!user.owner,verified:!!user.verified}));}
 user(req){const token=this.token(req);const row=token&&this.db.prepare('SELECT u.id,u.email,u.owner,u.verified FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(token,this.now());return row?{...row,owner:!!row.owner,verified:!!row.verified}:null;}
 token(req){return /(?:^|;\s*)workflow_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie||'')?.[1];}
 cookie(req,res,token,age=30*86400){const secure=secureRequest(req);res.setHeader('Set-Cookie','workflow_session='+token+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+age+(secure?'; Secure':''));}
 session(user,req,res){const token=randomBytes(32).toString('base64url');this.db.prepare('DELETE FROM app_sessions WHERE expires<=?').run(this.now());this.db.prepare('INSERT INTO app_sessions VALUES(?,?,?)').run(token,user.id,this.now()+lifetime);this.cookie(req,res,token);return user;}
 logout(req,res){this.db.prepare('DELETE FROM app_sessions WHERE token=?').run(this.token(req)||'');this.cookie(req,res,'',0);}
 mailConfig(){
  const saved=this.store.list('mail-settings')[0];if(saved)return saved;
  if(process.env.RESEND_API_KEY)return {provider:'resend',key:process.env.RESEND_API_KEY,from:process.env.MAIL_FROM};
  if(process.env.SMTP_HOST)return {provider:'smtp',host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',username:process.env.SMTP_USER,password:process.env.SMTP_PASSWORD,from:process.env.MAIL_FROM};
  return null;
 }
 mailStatus(){const config=this.mailConfig();if(!config)return {configured:false};const {key,password,...value}=config;return {...value,configured:!!config.from,hasKey:!!key,hasPassword:!!password};}
 saveMail(input){
  const previous=this.mailConfig()||{},provider=input.provider,from=String(input.from||'').trim();
  if(!['resend','smtp'].includes(provider)||!from||/[\r\n]/.test(from))fail('MAIL_CONFIG','请选择发信方式并填写发件人邮箱');
  const config={id:'default',provider,from};
  if(provider==='resend'){config.key=input.key||previous.key;if(!config.key)fail('MAIL_CONFIG','请填写 Resend API Key');}
  else {Object.assign(config,{host:String(input.host||'').trim(),port:Number(input.port||587),secure:!!input.secure,username:String(input.username||''),password:input.password||previous.password||''});if(!config.host||!Number.isInteger(config.port)||config.port<1||config.port>65535)fail('MAIL_CONFIG','请填写 SMTP 服务器及有效端口');}
  this.store.put('mail-settings',config);return this.mailStatus();
 }
 async deliver(to,code){
  const config=this.mailConfig();if(!config?.from)fail('MAIL_CONFIG','管理员尚未配置发信服务，请联系管理员完成邮件设置');
  const message={from:config.from,to,subject:'确定性工作流 · 邮箱验证码',text:'你的邮箱验证码是 '+code+'。10 分钟内有效，请勿转发。'};
  try{
   if(this.sendMail)return await this.sendMail(message);
   if(config.provider==='resend'){
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+config.key,'Content-Type':'application/json'},body:JSON.stringify({...message,to:[to]}),signal:AbortSignal.timeout(20000)});
    const value=await response.json();if(!response.ok)throw new Error(value.message||'邮件服务 HTTP '+response.status);
   }else{
    const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.secure,auth:config.username?{user:config.username,pass:config.password}:undefined,connectionTimeout:15000,socketTimeout:20000});
    const result=await transport.sendMail(message);if(!result.accepted?.length)throw new Error('收件人被邮件服务拒绝');
   }
  }catch(error){throw new Fault('MAIL_DELIVERY','邮件发送失败：'+error.message,{cause:error});}
 }
 async code(input){
  const email=emailAddress(input.email);if(this.users().some(user=>user.email===email))fail('AUTH_EXISTS','该邮箱已注册，请直接 Sign In');
  const previous=this.store.list('email-code').find(item=>item.id===email);
  if(previous&&this.now()-previous.sentAt<60000)fail('AUTH_RATE','请等待 60 秒后重新发送验证码');
  const code=String(randomInt(100000,1000000));await this.deliver(email,code);
  this.store.put('email-code',{id:email,code,sentAt:this.now(),expires:this.now()+600000,attempts:0});
  return {sent:true,retryAfter:60};
 }
 async create(input,{setup=false}={}){
  const email=emailAddress(input.email),password=String(input.password||'');
  if(password.length<8||password.length>256)fail('AUTH_INPUT','密码需要 8 至 256 个字符');
  if(this.users().some(user=>user.email===email))fail('AUTH_EXISTS','该邮箱已注册，请直接 Sign In');
  if(setup&&this.users().length)fail('AUTH_SETUP','管理员已创建，请使用邮箱注册');
  if(!setup){
   const record=this.store.list('email-code').find(item=>item.id===email);
   if(!record||record.expires<=this.now()||record.attempts>=5)fail('AUTH_CODE','验证码已失效，请重新获取');
   if(record.code!==String(input.code||'')){this.store.put('email-code',{...record,attempts:record.attempts+1});fail('AUTH_CODE','邮箱验证码不正确');}
  }
  const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64);
  if(setup&&this.users().length)fail('AUTH_SETUP','管理员已创建，请使用邮箱注册');
  const user={id:randomUUID(),email,owner:setup,verified:!setup};
  this.db.prepare('INSERT INTO app_users VALUES(?,?,?,?,?)').run(user.id,email,salt+':'+key.toString('hex'),Number(setup),Number(!setup));
  this.store.delete('email-code',email);return user;
 }
 async signin(input){
  const email=emailAddress(input.email),attempt=this.db.prepare('SELECT * FROM app_attempts WHERE email=?').get(email);
  if(attempt&&attempt.until>this.now()&&attempt.count>=10)fail('AUTH_RATE','登录尝试过多，请 15 分钟后重试');
  const user=this.db.prepare('SELECT * FROM app_users WHERE email=?').get(email);
  let correct=false;
  if(user){const [salt,stored]=user.password.split(':'),key=await derive(String(input.password||'').slice(0,257),salt,64);correct=timingSafeEqual(key,Buffer.from(stored,'hex'));}
  if(!correct){this.db.prepare('INSERT INTO app_attempts VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET count=excluded.count,until=excluded.until').run(email,attempt&&attempt.until>this.now()?attempt.count+1:1,this.now()+900000);fail('AUTH_LOGIN','邮箱或密码不正确');}
  this.db.prepare('DELETE FROM app_attempts WHERE email=?').run(email);
  const {password,...value}=user;return {...value,owner:!!value.owner,verified:!!value.verified};
 }
}
