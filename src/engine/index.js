import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {bind,timing,validateWorkflow,WRITES,matchesUrl} from '../workflow/schema.js';
import {until,conditions,perform} from '../browser/wait.js';
import {formRequest} from '../browser/gate.js';
import {assertMoney,verifyPayment} from '../safety/kernel.js';
import {Locators} from '../locators/index.js';
import {VisualAnchors} from '../locators/visual.js';
import {fail,errorRecord} from '../errors.js';

export class Engine {
  constructor({session,adapter,kernel,repository,dataDir,visual}) {
    Object.assign(this,{session,adapter,kernel,repository,dataDir});
    this.locators=new Locators(repository,{visual});
  }
  execute(options) {return this.session.exclusive(()=>this.#execute(options));}
  async #execute({workflowId,version,intent,parameters={},mode='trial',goal='invoice',captureAnchors=false,accountUsername=null}) {
    if(!['trial','live'].includes(mode)||!['invoice','pay'].includes(goal))fail('MODE','执行模式或付款目标无效');
    if(intent.account!==this.session.site.account||intent.product!==this.session.site.product)fail('INTENT','购买账户或商品与站点配置不一致');
    if(goal==='pay'&&intent.paymentMethod!=='credit')fail('PAYMENT_MISMATCH','自动付款当前仅支持已学习的账户余额付款');
    const bindings={intent,parameters,goal,site:this.session.site,accountUsername};
    const stored=mode==='live'?this.repository.admitted(workflowId,version,bindings):this.repository.get(workflowId,version);
    if(stored.state==='stale')fail('UNVERIFIED','工作流已过期，需要重新学习');
    const template=validateWorkflow(stored.document);
    const workflow=bind(template,{...parameters,intent});
    if(goal==='pay'&&!workflow.steps.some(s=>s.action==='pay'))fail('WORKFLOW','自动付款缺少已学习的付款步骤');
    const run={id:randomUUID(),workflowId,version:Number(version),mode,goal,bindings,startedAt:new Date().toISOString(),status:'running',aiInferenceCalls:0,steps:[],submitted:false};
    let reserved=false,receipt,review,knownIds=[],trialInvoice=false;
    try {
      await this.session.ensure();
      await this.session.goto(this.session.monitorPage,this.session.site.monitorUrl);
      if(await this.session.expired(this.session.monitorPage)){await this.session.ensure(true);await this.session.goto(this.session.monitorPage,this.session.site.monitorUrl);}
      const stock=await this.adapter.stock(this.session.monitorPage);
      if(stock.status!=='in'||stock.quantity!==undefined&&stock.quantity<intent.quantity)fail(stock.status==='out'||stock.quantity!==undefined&&stock.quantity<intent.quantity?'STOCK':'STOCK_UNKNOWN','执行前未确认商品有货',stock);
      let history;
      try{history=await this.adapter.history(this.session);}
      catch(error){if(error.code!=='SESSION')throw error;await this.session.ensure(true);history=await this.adapter.history(this.session);}
      knownIds=history.map(r=>r.invoiceId);
      await this.session.page.bringToFront();
      this.kernel.begin(intent,run.id,history);reserved=true;
      for(const [index,step] of workflow.steps.entries()) {
        if(step.action==='pay'&&goal==='invoice')continue;
        const entry={id:step.id,action:step.action,startedAt:new Date().toISOString(),recipe:template.steps[index],status:'running'};
        run.steps.push(entry);const started=Date.now();
        const policy=timing(step.timing),remaining=()=>{const ms=policy.absoluteMs-(Date.now()-started);if(ms<=0)fail('TIMEOUT','步骤达到实测绝对上限');return {...policy,absoluteMs:ms};};
        this.session.progress.touch();
        if(mode==='live'&&step.action==='pay'&&receipt?.url!==this.session.page.url())await this.session.goto(this.session.page,receipt.url,'order',remaining());
        if(mode==='trial'&&step.action==='pay') {
          receipt=await this.adapter.paymentProbe(this.session,knownIds,remaining());trialInvoice=true;
        }
        if(mode==='trial'&&run.submissionMapped&&step.action==='navigate'){entry.status='read-only-skipped';entry.durationMs=Math.max(1,Date.now()-started);continue;}
        await until(()=>conditions(this.session.page,step.pre),remaining(),this.session.progress);
        await this.adapter.guard(this.session.page);
        this.session.gate.lastError=null;
        let locator,strategy;
        if(step.action!=='navigate')({locator,strategy}=await this.locators.resolve(this.session.page,workflow.id,step));
        entry.locator=strategy;
        if(captureAnchors&&step.action!=='navigate')entry.recipe.target.anchor=await new VisualAnchors(this.session.page,join(this.dataDir,'anchors')).capture(step.target.selector,run.id+'-'+index);
        if(step.action==='navigate') {
          await this.session.goto(this.session.page,step.url,'order',remaining());
        } else if(step.action==='fill')await locator.fill(String(step.value),{timeout:remaining().absoluteMs});
        else if(step.action==='select')await locator.selectOption(String(step.value),{timeout:remaining().absoluteMs});
        else if(step.action==='check')await locator.setChecked(Boolean(step.value),{timeout:remaining().absoluteMs});
        else if(WRITES.includes(step.action)) {
          if(!this.session.site.writes.some(rule=>rule.operation===step.action&&rule.method===step.request.method&&rule.path===step.request.path))fail('REQUEST_MISMATCH','工作流写操作不属于站点已学习的动作');
          if(step.action==='submit') {
            if(!await this.session.authenticated(this.session.page))fail('SESSION','提交前会话已过期');
            review=await this.adapter.quote(this.session.page);assertMoney(review,intent);
            if(goal==='pay')await this.adapter.checkReviewFunds(this.session.page,review,intent);
          }
          if(step.action==='pay') {
            const payment=await this.adapter.paymentQuote(this.session.page,receipt);
            if(mode==='live')verifyPayment(payment,{...intent,invoiceId:receipt.invoiceId,totalMinor:review.totalMinor});
            else {assertMoney(payment,intent);if(!trialInvoice)fail('EVIDENCE','付款定位没有只读账单证据');}
          }
          const request=await formRequest(locator,this.session.site,step.request);
          if(mode==='trial'&&['submit','pay'].includes(step.action)) {
            entry.status='mapped';entry.durationMs=Math.max(1,Date.now()-started);
            entry.verified={readOnly:true,requestMapped:true};
            if(step.action==='submit')run.submissionMapped=true;
            continue;
          }
          const quote=step.action==='pay'?await this.adapter.paymentQuote(this.session.page,receipt):review;
          const permit=this.kernel.issue({intentKey:intent.key,runId:run.id,operation:step.action,mode,request,quote,intent:step.action==='pay'?{...intent,invoiceId:receipt.invoiceId,totalMinor:review.totalMinor}:intent});
          const sentBefore=this.session.gate.sent;
          this.session.gate.arm(permit,request);
          try {
            await perform(()=>locator.click({timeout:remaining().absoluteMs,noWaitAfter:false}),remaining(),this.session.progress);
            await until(async()=>{
              if(this.session.gate.lastError)throw this.session.gate.lastError;
              if(this.session.gate.sent!==sentBefore+1)return false;
              await this.adapter.guard(this.session.page);
              if(step.action==='coupon'&&this.session.site.coupon?.invalid?.length&&await conditions(this.session.page,this.session.site.coupon.invalid))return true;
              return conditions(this.session.page,step.post);
            },remaining(),this.session.progress);
            if(this.session.gate.sent!==sentBefore+1)fail('EVIDENCE','操作没有实际发送唯一写请求');
            let evidence={postconditions:true};
            if(step.action==='submit') {
              receipt=await this.adapter.invoice(this.session.page,knownIds);
              evidence=receipt;run.submitted=true;run.receipt=receipt;
            } else if(step.action==='pay') {
              if(!await this.adapter.paid(this.session.page,receipt))fail('EVIDENCE','没有本次账单的已支付证据');
              evidence={invoiceId:receipt.invoiceId,paid:true};run.paid=true;
            } else if(step.action==='coupon') {
              const rejected=this.session.site.coupon?.invalid?.length&&await conditions(this.session.page,this.session.site.coupon.invalid);
              evidence={accepted:!rejected};
              this.kernel.verified(permit,evidence);
              if(rejected) {
                if((workflow.couponPolicy||'remove-and-continue')==='stop')fail('COUPON','优惠码无效，按配置停止');
                await this.#removeCoupon({workflow,step,run,intent,remaining});
                evidence={accepted:false,removed:true};
              }
            }
            if(step.action!=='coupon')this.kernel.verified(permit,evidence);
            entry.verified=evidence;
          } catch(error) {throw this.session.gate.lastError||error;}
          finally{this.session.gate.disarm();}
        }
        if(step.action!=='coupon')await until(()=>conditions(this.session.page,step.post),remaining(),this.session.progress);
        entry.status='verified';entry.durationMs=Math.max(1,Date.now()-started);
      }
      if(mode==='trial') {
        if(!run.submissionMapped)fail('EVIDENCE','试运行没有验证提交控件与最终报价');
        run.status='trial-ready';
        this.kernel.release(intent.key,run.id);reserved=false;
      } else {
        if(!run.submitted||!receipt?.invoiceId)fail('EVIDENCE','未实际提交并获取新订单或账单凭证，不能标记下单成功');
        run.status=run.paid?'paid':'ordered';
      }
    } catch(error) {
      run.status='failed';run.error=errorRecord(error);
      const step=run.steps.at(-1);if(step?.status==='running'){step.status='failed';step.error=run.error;step.durationMs=Date.now()-Date.parse(step.startedAt);}
      if(reserved&&this.kernel.status(intent.key)?.state==='reserved')this.kernel.release(intent.key,run.id);
      try {
        const dir=join(this.dataDir,'evidence');await mkdir(dir,{recursive:true});
        run.evidence={screenshot:join(dir,run.id+'.png'),structure:await this.session.page.locator('button,input,select,a,form').evaluateAll(elements=>elements.map(e=>({tag:e.tagName,id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type')})))};
        await this.session.page.screenshot({path:run.evidence.screenshot,fullPage:true});
      }catch(evidenceError){run.evidenceError=errorRecord(evidenceError);}
    }
    run.finishedAt=new Date().toISOString();
    this.repository.record(run);
    if(run.error)this.repository.queue(run);
    return run;
  }
  async #removeCoupon({workflow,step,run,intent,remaining}) {
    const removal=this.session.site.coupon?.remove;
    if(!removal?.target?.selector||!removal.post?.length)fail('COUPON','优惠无效且缺少本站点已学习的删码流程');
    const {locator}=await this.locators.resolve(this.session.page,workflow.id,{id:step.id+'-remove',target:removal.target});
    const request=await formRequest(locator,this.session.site,removal.request);
    const permit=this.kernel.issue({intentKey:intent.key,runId:run.id,operation:'coupon-remove',mode:run.mode,request,intent});
    this.session.gate.arm(permit,request);const before=this.session.gate.sent;
    try {
      await perform(()=>locator.click({timeout:remaining().absoluteMs,noWaitAfter:false}),remaining(),this.session.progress);
      await until(()=>conditions(this.session.page,removal.post),remaining(),this.session.progress);
      if(this.session.gate.sent!==before+1)fail('EVIDENCE','优惠删除没有实际发送唯一请求');
      this.kernel.verified(permit,{removed:true});
    } finally{this.session.gate.disarm();}
  }
}
