import {load} from 'cheerio';
import {explicitOrderCurrency,matchesProductSelection} from './order-evidence.js';

const result=(checked,matched,unknown,reason,invoices=[])=>({checked,matched,unknown,reason,invoices});
const timestamp=value=>typeof value==='number'?value:Date.parse(value);
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
function amount(value){
  const number=clean(value).replace(/\b[A-Z]{3}\b/gi,'').replace(/[$€£¥\s]/g,'');
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(number))return null;
  return Number(number.replace(/,/g,''));
}
function dates(value){
  const text=clean(value);let match=text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\b|$)/);
  if(match)return [Date.UTC(+match[1],+match[2]-1,+match[3])];
  match=text.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if(match){
    const [,a,b,y]=match.map(Number),values=[];
    if(a<=31&&b<=12)values.push(Date.UTC(y,b-1,a));
    if(a<=12&&b<=31)values.push(Date.UTC(y,a-1,b));
    return values;
  }
  if(!/[a-z]/i.test(text))return [];
  const parsed=Date.parse(text);return Number.isFinite(parsed)?[parsed]:[];
}
function invoiceUrl(href,base){
  try{const url=new URL(href,base);return url.origin===new URL(base).origin&&url.pathname.endsWith('/viewinvoice.php')&&/^\d+$/.test(url.searchParams.get('id')||'')&&[...url.searchParams.keys()].every(key=>key==='id')?url.href:null;}catch{return null;}
}
function whmcsBase(url,html){
  const current=new URL(url);
  if(/\/(?:cart|clientarea|viewinvoice)\.php$/.test(current.pathname))return new URL('.',current);
  const $=load(html);
  for(const link of $('a[href]').toArray()){
    const href=$(link).attr('href');let target;try{target=new URL(href,current);}catch{continue;}
    if(target.origin===current.origin&&target.pathname.endsWith('/clientarea.php')&&target.searchParams.get('action')==='invoices')return new URL('.',target);
  }
  return null;
}

/**
 * Read-only WHMCS retry check; the caller owns the authenticated browser and its lifetime.
 * since/until accept epoch milliseconds or ISO strings. Amount comes from the last review,
 * never maxTotal. matched or unknown blocks retry; unchecked generic sites remain optional.
 * Unread pagination, unsupported markup or missing currency evidence returns unknown.
 */
export async function queryRecentOrders(session,task={},window={}){
  const {url,whmcs}=task;
  const review=task.submissionReview||task.result?.review||task.lastAttempt?.review||task.purchases?.at(-1)?.review||task.trial?.review||task.review;
  const product=task.product||task.verifiedProduct||review?.product;
  const total=task.total??review?.total;
  const currency=task.currency||task.verifiedCurrency||review?.currency;
  const since=window.since??task.since,until=window.until??task.until??Date.now();
  let recognized=whmcs===true;
  try{
    const methods=session.methods;
    const initialHtml=session.productHtml?await session.productHtml():'';
    const base=whmcsBase(url,initialHtml)||(recognized?new URL('.',url):null);
    if(!base)return result(false,false,false,'未核验商家后台：非 WHMCS 站点');
    recognized=true;
    const start=timestamp(since),end=timestamp(until);
    if(!product||!Number.isFinite(total)||total<0||!Number.isFinite(start)||!Number.isFinite(end)||end<start)return result(false,false,true,'商家后台核验缺少商品、准确金额或时间窗口');
    if(!session.productHtml)return result(false,false,true,'商家后台核验无法读取完整账单页面');
    const listUrl=new URL('clientarea.php?action=invoices',base).href;
    await methods.goto(listUrl);
    const snapshot=methods.snapshot?await methods.snapshot():await methods.observe();
    const current=new URL(snapshot.url);
    if(current.origin!==base.origin||!current.pathname.endsWith('/clientarea.php')||current.searchParams.get('action')!=='invoices')return result(false,false,true,'商家账单页面不可用或登录已失效');
    const $=load(await session.productHtml());
    const table=$('#tableInvoicesList');
    if(table.length!==1)return result(false,false,true,'商家账单列表无法识别');
    const headers=table.find('thead th').toArray().map(el=>clean($(el).text()));
    const dateIndex=headers.findIndex(text=>/^(?:invoice date|date created|date|账单日期|帳單日期|开票日期|建立日期|创建日期)$/i.test(text));
    const totalIndex=headers.findIndex(text=>/^(?:total|amount|总计|總計|金额|金額)$/i.test(text));
    const rows=table.find('tbody tr').toArray();
    const candidates=[];let incomplete=rows.length===0;
    for(const row of rows){
      const cells=$(row).children('td'),links=cells.find('a[href]').toArray().map(el=>invoiceUrl($(el).attr('href'),listUrl)).filter(Boolean);
      if(!links.length){if(!/no (?:records|invoices|data)|没有|沒有|暂无|暫無/i.test($(row).text()))incomplete=true;continue;}
      const link=links[0],dateValues=dates(cells.eq(dateIndex).text());
      if(dateIndex<0||!dateValues.length){incomplete=true;continue;}
      // Invoice dates omit the merchant timezone and time; retain overlapping local days.
      if(!dateValues.some(date=>date-14*3600000<=end&&date+38*3600000>start))continue;
      const value=totalIndex>=0?amount(cells.eq(totalIndex).text()):null;
      const code=totalIndex>=0?explicitOrderCurrency(cells.eq(totalIndex).text()):null;
      if(value!==null&&Math.abs(value-total)>0.000001||currency&&code&&code!==currency)continue;
      candidates.push({url:link,date:clean(cells.eq(dateIndex).text())});
    }
    const next=$('a[rel="next"],.pagination .next:not(.disabled),.paginate_button.next:not(.disabled)');
    if(next.length)incomplete=true;
    for(const candidate of candidates){
      await methods.goto(candidate.url);
      const detailSnapshot=methods.snapshot?await methods.snapshot():await methods.observe();
      if(invoiceUrl(detailSnapshot.url,listUrl)!==candidate.url){incomplete=true;continue;}
      const detail=load(await session.productHtml());
      let foundTotal=null,foundCurrency=null,productFound=false,itemRows=0;
      for(const row of detail('table tr').toArray()){
        const cells=detail(row).children('td');if(cells.length<2)continue;
        const label=clean(cells.first().text()),value=clean(cells.last().text());
        if(/^(?:total|总计|總計)\s*[:：]?$/i.test(label)) {foundTotal=amount(value);foundCurrency=explicitOrderCurrency(value);continue;}
        if(/^(?:sub ?total|credit|tax|balance|小计|小計|余额|餘額)/i.test(label))continue;
        if(amount(value)===null)continue;
        itemRows++;
        const firstLine=clean(cells.first().html()?.split(/<br\s*\/?\s*>/i)[0].replace(/<[^>]*>/g,'')||label);
        const description=firstLine.replace(/\s*\(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\s*-\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\)\s*$/,'');
        const withoutHost=description.replace(/\s+-\s+[\w-]+(?:\.[\w-]+)+\s*$/,'');
        if(matchesProductSelection(product,label)||matchesProductSelection(product,description)||matchesProductSelection(product,withoutHost))productFound=true;
      }
      if(!itemRows||foundTotal===null||currency&&!foundCurrency){incomplete=true;continue;}
      if(productFound&&Math.abs(foundTotal-total)<0.000001&&(!currency||currency===foundCurrency))return result(true,true,false,'商家后台存在同商品、金额及时间窗口的账单',[{...candidate,total:foundTotal,currency:foundCurrency}]);
    }
    return incomplete?result(false,false,true,'商家账单信息不完整，无法排除已有订单'):result(true,false,false,'商家后台未发现同商品、金额及时间窗口的账单');
  }catch(error){return result(false,false,true,(recognized?'WHMCS 商家后台查询失败：':'商家后台识别失败：')+error.message);}
}
