import {matchesProductSelection} from '../../lib/order-evidence.js';
import {orderRequestKind} from '../../lib/order-request.js';
const interactive=new Set(['button','textbox','spinbutton','combobox','checkbox','radio']);
const purchaseLabel=/^(?:立即购买|购买|选购|立即订购|订购|配置|buy(?: now)?|order(?: now)?|configure(?: now)?)$/i;
const target=ref=>({meaning:'product',ref,confidence:1});

// Resolve the user's product from current page evidence before asking the model.
export function productContext(page,order={}){
  const supplied=order.product||order.productSelection?.text,answer=order.userClarification;
  const name=supplied||(answer?.url===page.url&&answer.question==='请确认当前步骤应操作哪个商品、配置项或入口。'?answer.answer:null);
  if(!name)return null;
  const matches=(page.elements||[]).filter(el=>el.visible!==false&&!interactive.has(el.role)&&matchesProductSelection(name,el.text||el.accessibleName));
  const primary=matches.filter(el=>el.tag==='h1'),headings=matches.filter(el=>el.role==='heading'||/^h[1-6]$/.test(el.tag));
  const anchors=primary.length===1?primary:headings.length?headings:supplied?matches:[];
  const regions=new Set(anchors.map(el=>el.regionRef||el.ref));
  const identified=anchors.length>0&&regions.size===1;
  return {name,status:identified?'identified':anchors.length?'multiple_matches':'not_found',refs:anchors.map(el=>el.ref),regionRefs:[...new Set(anchors.map(el=>el.regionRef).filter(Boolean))],...(identified?{binding:target(anchors[0].ref)}:{})};
}

export function bindKnownProduct(step,page,order){
  const product=productContext(page,order);
  if(!product?.binding||!['cart','configure','verify_cart','review','apply_coupon','verify_coupon'].includes(step?.action))return step;
  const supplied=step.bindings?.product;
  // A conflicting product remains subject to the normal checkout verification.
  if(supplied&&!product.refs.includes(supplied.ref))return step;
  return {...step,bindings:{...step.bindings,product:product.binding}};
}

export function productEntry(input){
  if(input.context?.submissionStarted||input.context?.pendingVerification)return null;
  const page=input.observation,product=productContext(page,input.order);
  if(!product?.binding)return null;
  // A product with editable options must be configured before following its link.
  if(page.elements.some(el=>el.visible!==false&&!el.disabled&&!el.readOnly&&product.regionRefs.includes(el.regionRef)&&['textbox','spinbutton','combobox','checkbox','radio'].includes(el.role)))return null;
  const current=new URL(page.url);
  const entries=page.elements.filter(el=>{
    if(el.tag!=='a'||!el.href||el.visible===false||el.disabled||!product.regionRefs.includes(el.regionRef))return false;
    if(!purchaseLabel.test((el.accessibleName||el.text||'').trim()))return false;
    const destination=new URL(el.href,page.url);
    return ['http:','https:'].includes(destination.protocol)&&destination.origin===current.origin&&destination.pathname+destination.search!==current.pathname+current.search&&!orderRequestKind(destination.href);
  });
  if(entries.length!==1)return null;
  return {action:'click',reason:'已根据商品名称匹配当前商品区域及唯一购买链接',target:{meaning:'purchase_entry',ref:entries[0].ref,confidence:1}};
}
