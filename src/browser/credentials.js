import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fail,Fault} from '../errors.js';
function decodeKey(value,source) {
  if(Buffer.isBuffer(value)&&value.length===32)return value;
  const hex=value.toString('utf8').trim();
  if(!/^[a-f\d]{64}$/i.test(hex))fail('CREDENTIALS_KEY',source==='credentials.key'?'credentials.key 必须是 32 字节二进制或 64 位十六进制密钥':'CREDENTIALS_KEY 必须是 64 位十六进制密钥');
  return Buffer.from(hex,'hex');
}
export class CredentialStore {
  constructor(db,dataDir,key=process.env.CREDENTIALS_KEY){this.db=db;this.keyFile=join(dataDir,'credentials.key');this.configuredKey=key;}
  async open() {
    this.db.exec('CREATE TABLE IF NOT EXISTS credentials(origin TEXT NOT NULL,account TEXT NOT NULL,secret TEXT NOT NULL,needs_login INTEGER NOT NULL,PRIMARY KEY(origin,account))');
    if(this.configuredKey){this.key=decodeKey(this.configuredKey,'CREDENTIALS_KEY');return this;}
    try{this.key=await readFile(this.keyFile);}
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      const workspace=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_records'").get();
      if(this.db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n||(workspace&&this.db.prepare('SELECT COUNT(*) AS n FROM workspace_records').get().n))fail('CREDENTIALS_KEY','已保存凭据缺少密钥，请恢复 CREDENTIALS_KEY 或 credentials.key');
      const key=randomBytes(32);
      try{await writeFile(this.keyFile,key,{flag:'wx',mode:0o600});this.key=key;}
      catch(error){if(error.code!=='EEXIST')throw error;this.key=await readFile(this.keyFile);}
    }
    this.key=decodeKey(this.key,'credentials.key');
    return this;
  }
  get(origin,account) {
    const row=this.db.prepare('SELECT secret FROM credentials WHERE origin=? AND account=?').get(origin,account);
    if(!row)return null;
    try {
      const {iv,tag,data}=JSON.parse(row.secret),cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(iv,'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify([origin,account])));cipher.setAuthTag(Buffer.from(tag,'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8'));
    }catch(error){throw new Fault('CREDENTIALS_KEY','已保存账号无法解密，请核对 CREDENTIALS_KEY 或 credentials.key',{cause:error});}
  }
  status(origin,account) {
    const value=origin&&account?this.get(origin,account):null;
    return {saved:!!value,username:value?.username||null};
  }
  save(origin,account,{username,password}) {
    if(typeof username!=='string'||!username.trim()||typeof password!=='string'||!password)fail('CREDENTIALS','账号和密码不能为空');
    username=username.trim();
    const previous=this.get(origin,account),needsLogin=!previous||previous.username!==username||this.needsLogin(origin,account);
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(JSON.stringify([origin,account])));
    const data=Buffer.concat([cipher.update(JSON.stringify({username,password}),'utf8'),cipher.final()]);
    const secret=JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
    this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?) ON CONFLICT(origin,account) DO UPDATE SET secret=excluded.secret,needs_login=excluded.needs_login').run(origin,account,secret,Number(needsLogin));
    return this.status(origin,account);
  }
  needsLogin(origin,account){return !!this.db.prepare('SELECT needs_login FROM credentials WHERE origin=? AND account=?').get(origin,account)?.needs_login;}
  loggedIn(origin,account,username) {
    if(this.get(origin,account)?.username===username)this.db.prepare('UPDATE credentials SET needs_login=0 WHERE origin=? AND account=?').run(origin,account);
  }
  delete(origin,account){this.db.prepare('DELETE FROM credentials WHERE origin=? AND account=?').run(origin,account);}
}
