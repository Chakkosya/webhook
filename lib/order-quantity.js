import {parseOrderQuantity} from './order-evidence.js';
export function quantityLimit(quantity,reason){
  return Object.assign(new Error(reason),{code:'ORDER_QUANTITY_LIMIT',availableQuantity:quantity});
}
export function checkQuantityCapacity(field,requested){
  if(!field)return;
  let maximum;
  if(field.tag==='select'){
    const values=(field.options||[]).filter(option=>!option.disabled).map(option=>parseOrderQuantity(option.text)).filter(value=>Number.isInteger(value)&&value>0&&value<=requested);
    if(values.length)maximum=Math.max(...values);
  }else if(field.max!==null&&field.max!==undefined&&field.max!==''&&Number.isInteger(Number(field.max))&&Number(field.max)>0)maximum=Number(field.max);
  if(maximum&&maximum<requested)throw quantityLimit(maximum,'网站当前数量选项最多支持 '+maximum+' 件，将按实际数量重新核价');
}
export function checkStockCapacity(text,requested){
  const counts=[...String(text||'').matchAll(/\b(\d+)\s+(?:available|in stock)\b|库存\s*[:：]\s*(\d+)/gi)].map(match=>Number(match[1]??match[2]));
  if(new Set(counts).size!==1)return;
  if(counts[0]===0)throw Object.assign(new Error('当前商品区域显示缺货'),{code:'ORDER_OUT_OF_STOCK'});
  if(counts[0]<requested)throw quantityLimit(counts[0],'当前商品库存 '+counts[0]+' 件，将按库存数量重新核价');
}
export function purchaseSummary(task,receipts,reason=''){
  const quantity=receipts.reduce((sum,receipt)=>sum+(receipt.review?.quantity||0),0);
  const total=Math.round(receipts.reduce((sum,receipt)=>sum+(receipt.review?.total||0),0)*1e6)/1e6;
  return {requestedQuantity:task.quantity,quantity,total,maxTotal:task.maxTotal,currency:receipts[0]?.review?.currency||task.currency,remainingQuantity:task.quantity-quantity,reason};
}
