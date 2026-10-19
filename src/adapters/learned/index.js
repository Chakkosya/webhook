import {conditions} from '../../browser/wait.js';
import {fail} from '../../errors.js';
import {verifyPayment} from '../../safety/kernel.js';
import {matchesUrl,timing} from '../../workflow/schema.js';
const read=async(page,selector)=>{
  if(!selector)fail('SITE_CHANGED','缺少站点学习字段');
  const el=page.locator(selector);if(await el.count()!==1)fail('SITE_CHANGED','站点字段不是唯一元素',{selector});
  return el.evaluate(e=>'value' in e?e.value:e.textContent.trim());
};
export function amountMinor(text,decimals=2) {
  const value=String(text).trim();
  if(!/^\d+(?:\.\d+)?$/.test(value))fail('SITE_CHANGED','金额字段必须输出明确的十进制数',{value});
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals)fail('SITE_CHANGED','金额精度超过本站点币种精度');
  const minor=Number(whole)*10**decimals+Number(fraction.padEnd(decimals,'0'));
  if(!Number.isSafeInteger(minor))fail('SITE_CHANGED','金额超出可表示范围');
  return minor;
}
export class LearnedSiteAdapter {
  constructor(site){this.site=site;}
  confirmationDefinition(){return this.site.confirmation;}
  referenceField(){return 'reference';}
  receiptLink(){return this.site.receipt?.confirmationLink;}
  availablePattern(){return this.site.stock.availablePattern;}
  validReference(value){return typeof value==='string'&&value.length>0&&new RegExp(this.confirmationDefinition().idPattern).test(value);}
  async paymentProbe(session,knownIds,policy){
    const probe=this.site.payment?.probeUrl;if(!probe)fail('EVIDENCE','付款试运行需要当前账户已有订单或账单的只读学习链接');
    await session.goto(session.page,probe,'order',policy);const receipt=await this.invoice(session.page);
    if(!knownIds.includes(receipt.invoiceId))fail('EVIDENCE','学习链接不在当前账户的商家订单记录中');
    return receipt;
  }
  async guard(page) {
    if(this.site.loggedOut?.length&&await conditions(page,this.site.loggedOut))fail('SESSION','站点要求重新登录');
    if(this.site.challenge?.length&&await conditions(page,this.site.challenge))fail('RISK','站点正在进行人机验证或风控拦截');
    if(this.site.errors?.length&&await conditions(page,this.site.errors))fail('SITE_CHANGED','站点返回异常页面');
  }
  async stock(page) {
    await this.guard(page);
    const stock=this.site.stock;
    if(!await conditions(page,stock.page))return {status:'unknown',reason:'商品页面身份未确认'};
    if(stock.soldOut?.length&&await conditions(page,stock.soldOut))return {status:'out',signal:'sold-out'};
    if(stock.form) {
      const scope=page.locator(stock.scope);
      if(await scope.count()===1) {
        const form=scope.locator(stock.form);
        if(await form.count()===1&&await form.isVisible()) {
          let fields=true;
          for(const field of stock.fields) {
            const el=form.locator(field.selector);
            if(await el.count()!==1||field.value!==undefined&&await el.inputValue()!==String(field.value)){fields=false;break;}
          }
          const button=form.locator(stock.submit);
          if(fields&&await button.count()===1&&await button.isVisible()&&await button.isEnabled())return {status:'in',signal:'purchase-form'};
        }
      }
    }
    if(stock.available) {
      const scope=page.locator(stock.scope);
      if(await scope.count()===1) {
        const el=scope.locator(stock.available);
        if(await el.count()===1&&await el.isVisible()) {
          const match=String(await el.textContent()).trim().match(new RegExp(this.availablePattern(),'i'));
          if(match&&/^\d+$/.test(match[1])&&Number.isSafeInteger(Number(match[1])))return {status:Number(match[1])>0?'in':'out',signal:'available-count',quantity:Number(match[1])};
        }
      }
    }
    return {status:'unknown',reason:'缺少商品加购字段与提交按钮，且没有明确库存数量'};
  }
  async history(session) {
    const page=session.monitorPage;await session.goto(page,this.site.historyUrl);
    await this.guard(page);
    if(!await session.authenticated(page))fail('SESSION','读取商家订单时会话已过期');
    const h=this.site.history;
    if(!await conditions(page,h.complete))fail('MERCHANT_HISTORY','商家订单列表不完整或未加载完成');
    const rows=page.locator(h.rows),result=[];
    for(let i=0;i<await rows.count();i++) {
      const row=rows.nth(i);
      const field=async name=>{const el=row.locator(h.fields[name]);if(await el.count()!==1)fail('MERCHANT_HISTORY','商家订单行缺少 '+name);return el.evaluate(e=>'value' in e?e.value:e.textContent.trim());};
      const item={account:this.site.account,invoiceId:await field(this.referenceField())};
      if(h.fields.createdAt)item.createdAt=await field('createdAt');
      if(h.detail) {
        const link=row.locator(h.detail.link);
        if(await link.count()!==1)fail('MERCHANT_HISTORY','订单详情链接不是唯一元素');
        item.detailUrl=new URL(await link.getAttribute('href'),page.url()).href;
        if(new URL(item.detailUrl).origin!==this.site.origin||!matchesUrl(this.confirmationDefinition().url,item.detailUrl))fail('MERCHANT_HISTORY','订单详情链接无效');
      } else {
        item.product=await field('product');item.quantity=Number(await field('quantity'));item.currency=await field('currency');
      }
      result.push(item);
    }
    for(const item of result) {
      if(item.detailUrl) {
        await session.goto(page,item.detailUrl);
        await this.guard(page);
        if(!await session.authenticated(page)||!await conditions(page,h.detail.complete))fail('MERCHANT_HISTORY','无法完整读取订单详情');
        const fields=h.detail.fields;
        if(await read(page,fields[this.referenceField()])!==item.invoiceId)fail('MERCHANT_HISTORY','订单详情编号与列表不一致');
        item.product=await read(page,fields.product);item.quantity=Number(await read(page,fields.quantity));item.currency=await read(page,fields.currency);
        if(fields.createdAt)item.createdAt=await read(page,fields.createdAt);
        delete item.detailUrl;
      }
      if(!this.validReference(item.invoiceId)||!item.product||!Number.isSafeInteger(item.quantity)||item.quantity<1||!item.currency)fail('MERCHANT_HISTORY','商家订单字段无效');
      if(item.createdAt&&!Number.isFinite(Date.parse(item.createdAt)))fail('MERCHANT_HISTORY','商家订单时间无法识别');
    }
    return result;
  }
  async quote(page) {
    const f=this.site.quote;
    await this.guard(page);
    const method=await read(page,f.paymentMethod),balanceMethod=this.site.payment?.balanceMethod;
    if(balanceMethod!==undefined&&method!==balanceMethod)fail('PAYMENT_MISMATCH','付款方式与本站点已学习的余额方式不一致');
    return {product:await read(page,f.product),quantity:Number(await read(page,f.quantity)),totalMinor:amountMinor(await read(page,f.total),this.site.currencyDecimals),currency:await read(page,f.currency),paymentMethod:balanceMethod===undefined?method:'credit'};
  }
  async invoice(page,knownInvoiceIds=[]) {
    await this.guard(page);
    const definition=this.confirmationDefinition(),url=new URL(page.url());let resultUrl=url,id;
    if(url.origin===this.site.origin&&matchesUrl(definition.url,page.url())) {
      if(definition.ready?.length&&!await conditions(page,definition.ready))fail('EVIDENCE','订单或账单确认页缺少已学习的完成证据');
      id=await read(page,definition.id);
    } else {
      const receipt=this.site.receipt;
      if(!receipt||url.origin!==this.site.origin||!matchesUrl(receipt.url,page.url())||!await conditions(page,receipt.ready))fail('EVIDENCE','尚未到达本次订单的确认页面');
      const link=page.locator(this.receiptLink());if(await link.count()!==1)fail('EVIDENCE','本次订单缺少唯一确认链接');
      resultUrl=new URL(await link.getAttribute('href'),page.url());
      if(resultUrl.origin!==this.site.origin||!matchesUrl(definition.url,resultUrl.href))fail('EVIDENCE','确认链接不属于本站点的订单结果地址');
      id=receipt.id?await read(page,receipt.id):definition.idQuery?resultUrl.searchParams.get(definition.idQuery):null;
    }
    if(!this.validReference(id)||definition.idQuery&&resultUrl.searchParams.get(definition.idQuery)!==id||knownInvoiceIds.includes(id))fail('EVIDENCE','订单或账单标识无效，或属于提交前已有记录');
    return {invoiceId:id,url:resultUrl.href};
  }
  async checkReviewFunds(page,quote,intent) {
    const f=this.site.payment;
    if(!f?.reviewBalance||!f.reviewBalanceCurrency)fail('FUNDS','缺少提交前余额核验字段');
    verifyPayment({...quote,invoiceId:'review',balanceMinor:amountMinor(await read(page,f.reviewBalance),this.site.currencyDecimals),balanceCurrency:await read(page,f.reviewBalanceCurrency)},{...intent,invoiceId:'review',totalMinor:quote.totalMinor});
  }
  async paymentQuote(page,receipt) {
    const q=await this.quote(page);
    const invoice=await this.invoice(page);
    const f=this.site.payment;
    const result={...q,invoiceId:invoice.invoiceId};
    if(q.paymentMethod==='credit') {
      result.balanceMinor=amountMinor(await read(page,f.balance),this.site.currencyDecimals);
      result.balanceCurrency=await read(page,f.balanceCurrency);
    }
    if(receipt&&receipt.invoiceId!==result.invoiceId)fail('PAYMENT_MISMATCH','付款页面不是本次订单账单');
    return result;
  }
  async paid(page,receipt) {
    if(!await conditions(page,this.site.payment.paid))return false;
    const invoice=await this.invoice(page);
    return invoice.invoiceId===receipt.invoiceId;
  }
}
export function validateLearnedSite(site,adapter) {
  if(!site.account||!site.product||new URL(site.origin).origin!==site.origin)fail('CONFIG','需要明确的站点、账户和商品配置');
  const definition=adapter.confirmationDefinition();
  if(!definition?.url||!definition.id||!definition.idPattern?.startsWith('^')||!definition.idPattern.endsWith('$'))fail('CONFIG','订单结果必须有地址、标识字段和完整匹配模式');
  new RegExp(definition.idPattern);
  if(site.adapter==='learned'&&!definition.ready?.length)fail('CONFIG','已学习站点需要明确的订单完成证据');
  if(site.stock?.available) {
    const pattern=adapter.availablePattern();
    if(!pattern?.startsWith('^')||!pattern.endsWith('$'))fail('CONFIG','库存数量必须提供完整匹配的实测模式');
    new RegExp(pattern);
  }
  if(!site.provenance?.source)fail('PROVENANCE','站点选择器必须注明学习来源');
  for(const key of ['accountUrl','monitorUrl','orderUrl','historyUrl',...(site.warmupUrls||[]).map((_,i)=>'warmupUrls.'+i)]) {
    const value=key.startsWith('warmupUrls.')?site.warmupUrls[Number(key.split('.')[1])]:site[key];
    if(new URL(value).origin!==site.origin)fail('CONFIG','站点入口必须属于同一站点');
  }
  if(site.monitorUrl===site.orderUrl)fail('CONFIG','监控只读入口和下单动作入口必须分开配置');
  if(!site.authenticated?.length||!site.stock?.page?.length||!site.stock.scope||!site.history?.complete?.length||!site.quote)fail('CONFIG','站点缺少登录、库存、订单记录或报价证据');
  if(!site.stock.available&&(!site.stock.form||!site.stock.fields?.length||!site.stock.submit))fail('CONFIG','库存识别需要完整加购表单或商品附近的库存数量');
  if((site.browserRequests||[]).some(rule=>rule.path===new URL(site.orderUrl).pathname))fail('CONFIG','浏览器验证请求不能放行交易入口');
  if(!Number.isInteger(site.currencyDecimals)||site.currencyDecimals<0||site.currencyDecimals>3)fail('CONFIG','需要明确的币种小数位数');
  if(!Array.isArray(site.reads)||!Array.isArray(site.writes)||!site.writes.some(r=>r.operation==='submit'))fail('CONFIG','需要明确的只读请求与提交请求配置');
  if((site.browserRequests||[]).some(r=>(r.pathPrefix||r.allowAnyQuery)&&r.pathPrefix!=='/cdn-cgi/challenge-platform/'))fail('CONFIG','动态验证请求仅限 Cloudflare 挑战路径');
  if((site.browserRequests||[]).some(r=>site.writes.some(w=>w.method===r.method&&w.path===r.path)))fail('CONFIG','验证请求不能覆盖交易动作');
  if(site.login&&new URL(site.login.url).origin!==site.origin)fail('CONFIG','登录页面必须属于当前站点');
  if(site.login&&site.writes.some(w=>w.method===site.login.request.method&&w.path===site.login.request.path))fail('CONFIG','登录请求不能覆盖交易动作');
  timing(site.timing);timing(site.timing,'monitor');return site;
}
