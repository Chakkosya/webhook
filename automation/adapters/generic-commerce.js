export function pageType(page){
  const elements=(page.elements||[]).filter(el=>el.visible!==false&&!el.disabled);
  const actions=elements.filter(el=>['link','button'].includes(el.role));
  const text=elements.filter(el=>!['link','button'].includes(el.role)).map(el=>el.text||'').join(' ') || page.text || '';
  if(confirmationEvidence(page,'payment'))return 'payment_result';
  if(confirmationEvidence(page,'order'))return 'order_result';
  const hasAction=pattern=>actions.some(el=>pattern.test(el.accessibleName||el.text||''));
  if(hasAction(/pay\s+(?:now|invoice)|支付账单|付款/i)&&/invoice|账单|發票/i.test(text))return 'invoice';
  if(hasAction(/place order|submit order|提交订单|确认下单/i))return 'checkout';
  const entries=actions.filter(el=>/order now|buy now|购买|立即订购/i.test(el.accessibleName||el.text||''));
  if(new Set(entries.map(el=>el.regionRef||el.ref)).size>1)return 'catalog';
  if(hasAction(/checkout|结账|去结算/i)&&/quantity|qty|数量|total|总计|合计/i.test(text))return 'cart';
  if(/catalog|category|商品列表|产品列表|分類|分类/i.test(page.title||''))return 'catalog';
  return 'product_or_other';
}
export function confirmationEvidence(page,kind){
  const negative=kind==='order'?/unsuccessful|failed|declined|not\s+(?:created|placed|confirmed|received)|失败|失敗/i:/unpaid|not\s+paid|unsuccessful|pending|failed|declined|未支付|未付款|失败|失敗/i;
  const success=kind==='payment'?/\bpaid\b|payment\s+(?:successful|complete)|已支付|支付成功|已付款|payée?|bezahlt|pagad[oa]|pagat[oa]|支払済|支払い完了|결제\s*완료/i:/\border\s+confirmation\b|\border\s+(?:(?:(?:number|id)\s*[:#]?\s*|#\s*)[\w-]+\s+)?(?:(?:has\s+been|was|is)\s+)?(?:confirmed|placed|created|received|successful)\b|thank\s+you\s+for\s+your\s+(?:order|purchase)|订单(?:提交|创建)?成功|訂單成功|下单成功/i;
  const idPattern=/(?:order\s*(?:number\b|id\b|#)|订单号|訂單編號|订单编号|注文番号)\s*(?:(?:is\b|为|是)\s*)?[:：#]?\s*((?!is\b)[\w-]{1,100})/i;
  const candidates=(page.elements||[]).filter(el=>el.visible&&el.text&&el.text.length<=500&&!negative.test(el.text));
  const explicit=candidates.find(el=>success.test(el.text));
  const ids=[...new Set(candidates.map(el=>el.text.match(idPattern)?.[1]).filter(Boolean))];
  const id=ids.length===1?ids[0]:null;
  if(kind==='payment')return explicit?{text:explicit.text,orderId:id}:null;
  return explicit&&id?{text:explicit.text,orderId:id}:null;
}
