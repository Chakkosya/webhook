// Purchase requirements travel beside a monitoring rule, never inside its evaluator.
export const orderDraftFields=['label','url','product','productSelection','instruction','quantity','maxTotal','currency','executionMode','affiliateUrl','paymentMethod','couponCode','couponFailurePolicy','autoRepair'];
export function orderDraft(value){
  if(value==null||value===false)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new Error('下单配置格式无效');
  return Object.fromEntries(orderDraftFields.filter(key=>value[key]!==undefined).map(key=>[key,structuredClone(value[key])]));
}
export function mergeOrderDraft(change,current){
  if(change===undefined)return current===undefined?undefined:structuredClone(current);
  if(change==null||change===false)return null;
  const next={...orderDraft(current),...orderDraft(change)};
  if(current?.id){next.id=current.id;next.expectedRevision=current.expectedRevision;}
  if(current?.productSelection&&(next.url!==current.url||next.product!==current.product))next.productSelection=null;
  return next;
}
