import test from 'node:test';
import assert from 'node:assert/strict';
import {createRestockRetries,isRestockRetryable,localOrderConflict} from '../lib/order-restock.js';

function fixture(){
  let now=1000,runs=0,checks=0,notifications=0;
  const task={id:'t',revision:1,monitorId:'m',url:'https://shop.test/p',product:'P',quantity:1,maxTotal:10,currency:'USD',errorCode:'AGENT_ELEMENT_MISSING'};
  const user={id:'u',orderTasks:[task]},timers=new Map();let timerId=0;
  const loop=createRestockRetries({persist:()=>{},now:()=>now,setTimer:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimer:id=>timers.delete(id),notify:async()=>{notifications++;},check:async()=>{checks++;return {safe:true};},run:async()=>{runs++;}});
  return {task,user,loop,timers,advance:ms=>{now+=ms;},counts:()=>({runs,checks,notifications})};
}
test('决战每三分钟重试，两小时到期通知并停止',async()=>{
  const f=fixture();f.loop.start(f.user,f.task);
  assert.equal(f.task.restockRetry.nextAt,181000);
  assert.equal([...f.timers.values()][0].delay,180000);
  f.advance(180000);await f.loop.tick(f.user,f.task);
  assert.deepEqual(f.counts(),{runs:1,checks:1,notifications:0});
  f.advance(7200000);await f.loop.tick(f.user,f.task);
  assert.equal(f.task.restockRetry.state,'expired');assert.equal(f.counts().notifications,1);
});
test('本地成功结果、提交和付款标记任一存在即停止，不查询也不重下',async()=>{
  for(const record of [{result:{orderId:'42'}},{submissionStartedAt:'now'},{paymentStartedAt:'now'},{submissionStarted:true},{paymentStarted:true},{result:{status:'uncertain'}},{purchases:[{submissionStartedAt:'now'}]}]){
    const f=fixture();f.loop.start(f.user,f.task);Object.assign(f.task,record);
    await f.loop.tick(f.user,f.task);
    assert.equal(f.task.restockRetry.state,'needs_input');assert.deepEqual(f.counts(),{runs:0,checks:0,notifications:1});
  }
});
test('同参数其他任务的持久化记录同样判重',()=>{
  const f=fixture();f.user.orderTasks.push({...f.task,id:'old',result:{invoiceId:'42'}});
  assert.equal(localOrderConflict(f.user,f.task).id,'old');
});
test('用户取消和修改配置均停止重试',async()=>{
  const f=fixture();f.loop.start(f.user,f.task);f.loop.cancel(f.user,f.task);await f.loop.tick(f.user,f.task);assert.equal(f.counts().runs,0);assert.equal(f.timers.size,0);
  f.loop.start(f.user,f.task);f.task.revision++;await f.loop.tick(f.user,f.task);assert.equal(f.task.restockRetry.state,'cancelled');
});
test('商家匹配或状态未知必须停止，不能以查询失败当作没有订单',async()=>{
  for(const message of ['已有同参数账单','后台状态未知']){
    const f=fixture();let ran=false;
    const loop=createRestockRetries({persist:()=>{},notify:async()=>{},setTimer:()=>1,clearTimer:()=>{},check:async()=>({safe:false,message}),run:async()=>{ran=true;}});
    loop.start(f.user,f.task);await loop.tick(f.user,f.task);
    assert.equal(ran,false);assert.equal(f.task.restockRetry.state,'needs_input');assert.equal(f.task.error,message);
  }
});
test('只重试临时错误；格式、鉴权与提交付款失败不自动重试',()=>{
  for(const code of ['AGENT_ELEMENT_MISSING','ORDER_AI_TIMEOUT','ORDER_OUT_OF_STOCK'])assert.equal(isRestockRetryable({errorCode:code}),true);
  for(const code of ['AGENT_PLAN_INVALID','AGENT_LOW_CONFIDENCE','ORDER_REQUEST_RESPONSE_TIMEOUT','ORDER_LOGIN_REQUIRED'])assert.equal(isRestockRetryable({errorCode:code}),false);
});
test('连续失败仅告警，不自动暂停决战循环',async()=>{
  const f=fixture();f.loop.start(f.user,f.task);f.task.restockRetry.attempts=4;await f.loop.tick(f.user,f.task);
  assert.equal(f.task.restockRetry.state,'active');assert.equal(f.counts().notifications,1);assert.match(f.task.restockRetry.warning,/告警/);
});
