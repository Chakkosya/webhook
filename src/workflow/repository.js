import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateWorkflow} from './schema.js';
import {fail} from '../errors.js';
export class WorkflowRepository {
  constructor(db) {
    this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS workflows(id TEXT NOT NULL,version INTEGER NOT NULL,document TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'candidate',streak INTEGER NOT NULL DEFAULT 0,bindings TEXT,failures INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,version INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repairs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,document TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS locator_stats(workflow_id TEXT NOT NULL,step_id TEXT NOT NULL,strategy TEXT NOT NULL,successes INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(workflow_id,step_id,strategy));`);
  }
  create(document) {
    validateWorkflow(document);
    const version=this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM workflows WHERE id=?').get(document.id).n;
    this.db.prepare('INSERT INTO workflows(id,version,document) VALUES(?,?,?)').run(document.id,version,JSON.stringify({...document,version}));
    return this.get(document.id,version);
  }
  get(id,version) {
    const row=this.db.prepare('SELECT * FROM workflows WHERE id=? AND version=?').get(id,Number(version));
    if(!row)fail('WORKFLOW','工作流版本不存在');
    return {...row,document:JSON.parse(row.document),bindings:row.bindings?JSON.parse(row.bindings):null};
  }
  list(){return this.db.prepare('SELECT id,version,state,streak,failures FROM workflows ORDER BY id,version DESC').all();}
  record(run) {
    this.db.prepare('INSERT INTO runs(id,workflow_id,version,mode,status,document) VALUES(?,?,?,?,?,?)').run(run.id,run.workflowId,run.version,run.mode,run.status,JSON.stringify(run));
    const row=this.get(run.workflowId,run.version);
    if(run.mode==='trial') {
      const same=isDeepStrictEqual(row.bindings,run.bindings);
      const streak=run.status==='trial-ready'?(same?row.streak+1:1):0;
      this.db.prepare('UPDATE workflows SET streak=?,bindings=?,failures=? WHERE id=? AND version=?').run(streak,JSON.stringify(run.bindings),run.status==='failed'?row.failures+1:0,row.id,row.version);
    } else this.db.prepare('UPDATE workflows SET failures=? WHERE id=? AND version=?').run(run.status==='failed'?row.failures+1:0,row.id,row.version);
    const next=this.get(row.id,row.version);
    if(next.failures>=3)this.db.prepare("UPDATE workflows SET state='stale' WHERE id=? AND version=?").run(row.id,row.version);
  }
  publish(id,version) {
    const row=this.get(id,version);
    if(row.streak<2||row.state==='stale')fail('UNVERIFIED','同一参数必须连续试运行通过两次，过期版本需重新学习');
    this.db.prepare("UPDATE workflows SET state='verified' WHERE id=? AND version=?").run(id,version);
    this.db.prepare('INSERT INTO releases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version').run(id,version);
    return this.get(id,version);
  }
  rollback(id,version) {
    const row=this.get(id,version);
    if(row.state!=='verified'||row.streak<2)fail('UNVERIFIED','只能回滚到仍有效的已验证版本');
    this.db.prepare('INSERT INTO releases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version').run(id,version);
    return row;
  }
  released(id) {const row=this.db.prepare('SELECT version FROM releases WHERE id=?').get(id);if(!row)fail('UNPUBLISHED','工作流尚未发布');return this.get(id,row.version);}
  admitted(id,version,bindings) {
    const row=this.released(id);
    if(row.version!==Number(version)||row.state!=='verified'||row.streak<2||!isDeepStrictEqual(row.bindings,bindings))fail('UNVERIFIED','版本或执行参数未通过两次试运行');
    return row;
  }
  diff(id,a,b) {
    const left=this.get(id,a).document,right=this.get(id,b).document;
    const changes=[];const visit=(x,y,p)=>{if(isDeepStrictEqual(x,y))return;if(x&&y&&typeof x==='object'&&typeof y==='object'){for(const k of new Set([...Object.keys(x),...Object.keys(y)]))visit(x[k],y[k],p? p+'.'+k:k);}else changes.push({path:p,before:x,after:y});};visit(left,right,'');return changes;
  }
  runs(){return this.db.prepare('SELECT document FROM runs ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.document));}
  run(id){const r=this.db.prepare('SELECT document FROM runs WHERE id=?').get(id);if(!r)fail('RUN','执行日志不存在');return JSON.parse(r.document);}
  queue(run) {
    if(['BUDGET','FUNDS','CURRENCY','DUPLICATE','TRIAL_BLOCKED','UNVERIFIED','UNPUBLISHED'].includes(run.error.category))return;
    this.db.prepare('INSERT INTO repairs(id,run_id,document) VALUES(?,?,?)').run(randomUUID(),run.id,JSON.stringify({category:run.error.category,message:run.error.message}));
  }
  saveDiagnosis(runId,result,candidate) {
    const rows=this.db.prepare('SELECT id,document FROM repairs WHERE run_id=?').all(runId);
    for(const row of rows)this.db.prepare('UPDATE repairs SET document=?,state=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.document),diagnosis:result,candidate}),candidate?'candidate':'diagnosed',row.id);
  }
  repairs(){return this.db.prepare('SELECT * FROM repairs ORDER BY rowid DESC').all().map(r=>({...r,document:JSON.parse(r.document)}));}
  locator(id,step,strategy,success) {
    this.db.prepare('INSERT INTO locator_stats VALUES(?,?,?,?,?) ON CONFLICT(workflow_id,step_id,strategy) DO UPDATE SET successes=successes+excluded.successes,attempts=attempts+1').run(id,step,strategy,success?1:0,1);
  }
  ranking(id,step){return this.db.prepare('SELECT *, CAST(successes AS REAL)/attempts AS rate FROM locator_stats WHERE workflow_id=? AND step_id=? ORDER BY rate DESC').all(id,step);}
  metrics() {
    const rows=this.db.prepare("SELECT workflow_id,version,document FROM runs WHERE mode='live' ORDER BY rowid").all();
    const result={};
    for(const r of rows) {
      const key=r.workflow_id+'@'+r.version,run=JSON.parse(r.document),m=result[key]??={attempts:0,successes:0,consecutiveSuccesses:0,consecutiveFailures:0};
      const success=['ordered','paid'].includes(run.status);m.attempts++;m.successes+=Number(success);m.consecutiveSuccesses=success?m.consecutiveSuccesses+1:0;m.consecutiveFailures=success?0:m.consecutiveFailures+1;m.successRate=m.successes/m.attempts;
    }
    return result;
  }
}
