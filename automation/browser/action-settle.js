// Observe after the action's document/XHR/fetch work settles. Inspired by Stagehand's
// waitForDomNetworkQuiet; implemented with the existing Playwright page events.
// https://github.com/browserbase/stagehand/blob/stagehand-server-v3/v3.7.6/packages/core/lib/v3/handlers/handlerUtils/actHandlerUtils.ts
export async function settledPageAction(page, action, {timeoutMs=10000, quietMs=250, signal}={}) {
  const pending=new Set();let changedAt=Date.now();
  const origin=new URL(page.url()).origin;
  const request=req=>{
    if(!['document','xhr','fetch'].includes(req.resourceType())||new URL(req.url()).origin!==origin)return;
    pending.add(req);changedAt=Date.now();
  };
  const finish=req=>{if(pending.delete(req))changedAt=Date.now();};
  const navigated=frame=>{if(frame===page.mainFrame())changedAt=Date.now();};
  page.on('request',request);page.on('requestfinished',finish);page.on('requestfailed',finish);page.on('framenavigated',navigated);
  try {
    const result=await action(),deadline=Date.now()+timeoutMs;changedAt=Date.now();
    while(pending.size||Date.now()-changedAt<quietMs){
      signal?.throwIfAborted();
      if(page.isClosed())throw new Error('浏览器页面已关闭');
      if(Date.now()>=deadline)throw Object.assign(new Error('页面仍在加载商品或价格，请稍后重试'),{code:'ORDER_PAGE_NOT_READY'});
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await page.waitForLoadState('domcontentloaded',{timeout:Math.max(1,deadline-Date.now())});
    return result;
  } finally {
    page.off('request',request);page.off('requestfinished',finish);page.off('requestfailed',finish);page.off('framenavigated',navigated);
  }
}
