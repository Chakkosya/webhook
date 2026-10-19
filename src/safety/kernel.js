import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fail} from '../errors.js';

export function assertMoney(quote,intent) {
  if(!Number.isSafeInteger(intent.budgetMinor)||intent.budgetMinor<0||!Number.isSafeInteger(quote.totalMinor)||quote.totalMinor<0)
    fail('BUDGET','金额必须是非负整数最小货币单位');
  if(quote.currency!==intent.currency)fail('CURRENCY','报价币种与许可币种不一致');
  if(quote.totalMinor>intent.budgetMinor)fail('BUDGET','订单总额超过预算',{totalMinor:quote.totalMinor,budgetMinor:intent.budgetMinor});
  if(quote.product!==intent.product||quote.quantity!==intent.quantity)fail('ORDER_MISMATCH','商品或数量与购买意图不一致');
  if(quote.paymentMethod!==intent.paymentMethod)fail('PAYMENT_MISMATCH','付款方式与购买意图不一致');
}
export function verifyPayment(quote,intent) {
  assertMoney(quote,intent);
  if(!intent.invoiceId||quote.invoiceId!==intent.invoiceId||quote.totalMinor!==intent.totalMinor)
    fail('PAYMENT_MISMATCH','账单号或付款金额与本次订单不一致');
  if(intent.paymentMethod==='credit'&&(!Number.isSafeInteger(quote.balanceMinor)||quote.balanceCurrency!==intent.currency||quote.balanceMinor<quote.totalMinor))
    fail('FUNDS','账户余额不足或无法核实余额',{balanceMinor:quote.balanceMinor,totalMinor:quote.totalMinor});
}
const identity=value=>({key:value.key,account:value.account,product:value.product,quantity:value.quantity,currency:value.currency,budgetMinor:value.budgetMinor,paymentMethod:value.paymentMethod});
export class SafetyKernel {
  #permits=new Map();
  constructor(file) {
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS intents(key TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,invoice_id TEXT,resolution TEXT);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,intent_key TEXT NOT NULL,run_id TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,evidence TEXT);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  status(key){return this.db.prepare('SELECT * FROM intents WHERE key=?').get(key);}
  begin(intent,runId,merchantHistory) {
    if(!intent.key||!intent.account||!intent.product||!Number.isSafeInteger(intent.quantity)||intent.quantity<1)fail('INTENT','购买意图缺少标识、账户、商品或有效数量');
    if(intent.historySince&&!Number.isFinite(Date.parse(intent.historySince)))fail('INTENT','商家判重起始时间无效');
    if(!Array.isArray(merchantHistory))fail('MERCHANT_HISTORY','无法完整读取商家近期订单，停止执行');
    if(merchantHistory.some(row=>row.account===intent.account&&row.product===intent.product&&row.quantity===intent.quantity&&row.currency===intent.currency&&(!intent.historySince||!row.createdAt||Date.parse(row.createdAt)>=Date.parse(intent.historySince))))
      fail('DUPLICATE','商家已存在匹配订单');
    return this.transaction(()=>{
      if(this.status(intent.key))fail('DUPLICATE','本地已存在该购买意图，不能重复执行');
      this.db.prepare('INSERT INTO intents(key,run_id,state,data) VALUES(?,?,?,?)').run(intent.key,runId,'reserved',JSON.stringify(identity(intent)));
    });
  }
  issue({intentKey,runId,operation,mode,request,quote,intent}) {
    if(!['trial','live'].includes(mode))fail('MODE','执行模式无效');
    if(!['cart','configure','coupon','coupon-remove','submit','pay'].includes(operation))fail('OPERATION','写操作类型无效');
    if(mode==='trial'&&['submit','pay'].includes(operation))fail('TRIAL_BLOCKED','试运行禁止提交订单和付款');
    if(!request?.url||!['GET','POST'].includes(request.method)||typeof request.body!=='string')fail('REQUEST','缺少可绑定的原生表单请求');
    if(operation==='submit'||operation==='pay')assertMoney(quote,intent);
    if(operation==='pay')verifyPayment(quote,intent);
    const row=this.status(intentKey);
    if(!row||row.run_id!==runId||intent.key!==intentKey||!isDeepStrictEqual(JSON.parse(row.data),identity(intent)))fail('RUN_MISMATCH','操作许可与当前执行或购买意图不一致');
    if(row.state==='uncertain')fail('UNCERTAIN','上一次写操作尚未核验，禁止重放');
    if(operation==='pay'?row.state!=='ordered':row.state!=='reserved')fail('REPLAY','当前交易状态不允许该操作');
    const id=randomUUID();
    this.db.prepare('INSERT INTO operations(id,intent_key,run_id,operation,state) VALUES(?,?,?,?,?)').run(id,intentKey,runId,operation,'issued');
    this.#permits.set(id,{request:structuredClone(request),intentKey,runId,operation});
    return id;
  }
  consume(id,request) {
    const permit=this.#permits.get(id);
    if(!permit)fail('REPLAY','操作许可不存在或已消费');
    if(!isDeepStrictEqual(permit.request,request))fail('REQUEST_MISMATCH','实际写请求与已批准的表单不一致');
    this.transaction(()=>{
      const row=this.status(permit.intentKey);
      if(row?.run_id!==permit.runId||row.state==='uncertain')fail('UNCERTAIN','交易已发出或执行所有者已变化');
      this.db.prepare("UPDATE operations SET state='sent' WHERE id=?").run(id);
      this.db.prepare("UPDATE intents SET state='uncertain' WHERE key=?").run(permit.intentKey);
    });
    this.#permits.delete(id);
  }
  verified(id,evidence) {
    const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    if(!op||op.state!=='sent')fail('EVIDENCE','不能核验未发送的操作');
    if(op.operation==='submit') {
      if(!evidence.invoiceId)fail('EVIDENCE','提交缺少账单证据');
      this.confirm(op.intent_key,op.run_id,evidence);
    } else if(op.operation==='pay') {
      const row=this.status(op.intent_key);
      if(!evidence.paid||evidence.invoiceId!==row.invoice_id)fail('EVIDENCE','付款缺少本次账单的已支付证据');
      this.db.prepare("UPDATE intents SET state='paid' WHERE key=?").run(op.intent_key);
    } else this.db.prepare("UPDATE intents SET state='reserved' WHERE key=?").run(op.intent_key);
    this.db.prepare("UPDATE operations SET state='verified',evidence=? WHERE id=?").run(JSON.stringify(evidence),id);
  }
  confirm(key,runId,evidence) {
    const row=this.status(key);
    if(!evidence.invoiceId||row?.run_id!==runId||row.state!=='uncertain')fail('EVIDENCE','缺少本次提交的账单核验');
    this.db.prepare("UPDATE intents SET state='ordered',invoice_id=? WHERE key=?").run(String(evidence.invoiceId),key);
  }
  release(key,runId) {
    const row=this.status(key);if(!row)return;
    if(row.run_id!==runId)fail('RUN_MISMATCH','执行标识不匹配');
    if(row.state!=='reserved')fail('UNCERTAIN','已发出的交易不能自动释放');
    this.db.prepare('DELETE FROM intents WHERE key=?').run(key);
  }
  resolve(key,{outcome,note,invoiceId}) {
    const row=this.status(key);
    if(!row||!note?.trim())fail('RESOLUTION','人工处理必须提供核对说明');
    if(outcome==='not-created') {
      if(row.state==='paid'||row.state==='ordered')fail('RESOLUTION','已核验订单不能声明未创建');
      this.db.prepare('DELETE FROM intents WHERE key=?').run(key);
    } else if(outcome==='created'&&invoiceId) {
      this.db.prepare("UPDATE intents SET state='ordered',invoice_id=?,resolution=? WHERE key=?").run(String(invoiceId),note,key);
    } else fail('RESOLUTION','人工处理需要明确结果和账单号');
    this.db.prepare("UPDATE operations SET state='resolved',evidence=? WHERE intent_key=? AND state IN ('issued','sent')").run(JSON.stringify({outcome,note,invoiceId}),key);
    for(const [id,p] of this.#permits)if(p.intentKey===key)this.#permits.delete(id);
  }
  close(){this.#permits.clear();this.db.close();}
}
