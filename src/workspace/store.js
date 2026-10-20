import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {fail} from '../errors.js';
export class WorkspaceStore {
  constructor(db,key) {
    this.db=db;this.key=key;
    db.exec('CREATE TABLE IF NOT EXISTS workspace_records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS workspace_preferences(name TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  encode(kind,id,value) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(JSON.stringify([kind,id])));
    const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  }
  decode(row) {
    const value=JSON.parse(row.payload),cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.iv,'base64'));
    cipher.setAAD(Buffer.from(JSON.stringify([row.kind,row.id])));cipher.setAuthTag(Buffer.from(value.tag,'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString('utf8'));
  }
  list(kind){return this.db.prepare('SELECT * FROM workspace_records WHERE kind=? ORDER BY rowid').all(kind).map(row=>this.decode(row));}
  get(kind,id){const row=this.db.prepare('SELECT * FROM workspace_records WHERE kind=? AND id=?').get(kind,id);if(!row)fail('NOT_FOUND','记录不存在，请刷新后重试');return this.decode(row);}
  put(kind,value) {
    const record={...value,id:value.id||randomUUID()};
    this.db.prepare('INSERT INTO workspace_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind,record.id,this.encode(kind,record.id,record));
    return record;
  }
  delete(kind,id){this.db.prepare('DELETE FROM workspace_records WHERE kind=? AND id=?').run(kind,id);}
  preference(name,value){if(value!==undefined)this.db.prepare('INSERT INTO workspace_preferences VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,value);return this.db.prepare('SELECT value FROM workspace_preferences WHERE name=?').get(name)?.value;}
}
