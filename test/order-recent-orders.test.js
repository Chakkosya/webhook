import test from 'node:test';
import assert from 'node:assert/strict';
import {queryRecentOrders} from '../lib/order-recent-orders.js';

const url='https://merchant.example/billing/cart.php?a=add&pid=1';
const listUrl='https://merchant.example/billing/clientarea.php?action=invoices';
const invoiceUrl='https://merchant.example/billing/viewinvoice.php?id=10';
const options={url,product:'KVM 4GB',total:12,currency:'USD',since:'2026-10-14T10:00:00Z',until:'2026-10-14T11:00:00Z'};
const list=(date='2026-10-14',total='$12.00 USD')=>`<table id="tableInvoicesList"><thead><tr><th>Invoice #</th><th>Invoice Date</th><th>Due Date</th><th>Total</th></tr></thead><tbody><tr><td><a href="viewinvoice.php?id=10">10</a></td><td>${date}</td><td>2026-11-14</td><td>${total}</td></tr></tbody></table>`;
const invoice=(product='KVM 4GB',total='$12.00 USD')=>`<table><tr><td>${product} - host.example<br>(14/10/2026 - 14/11/2026)</td><td>$12.00 USD</td></tr><tr><td>Sub Total</td><td>$12.00 USD</td></tr><tr><td>Total</td><td>${total}</td></tr></table>`;
function browser(pages={}){
  let current=url;const visited=[];
  return {visited,methods:{goto:async target=>{visited.push(target);current=target;if(pages[target] instanceof Error)throw pages[target];},snapshot:async()=>({url:current})},productHtml:async()=>pages[current]||'',};
}
test('WHMCS reads invoice details and matches product, amount and date without mutation',async()=>{
  const session=browser({[listUrl]:list(),[invoiceUrl]:invoice()});
  const result=await queryRecentOrders(session,options);
  assert.equal(result.checked,true);assert.equal(result.matched,true);assert.equal(result.unknown,false);
  assert.deepEqual(session.visited,[listUrl,invoiceUrl]);assert.equal(result.invoices[0].total,12);
});
test('old invoices, other products and other totals do not match',async()=>{
  for(const pages of [{[listUrl]:list('2026-09-01')},{[listUrl]:list('2026-10-14','$13.00 USD')},{[listUrl]:list(),[invoiceUrl]:invoice('KVM 24GB')},{[listUrl]:list(),[invoiceUrl]:invoice('KVM 4GB','$13.00 USD')}]){
    const result=await queryRecentOrders(browser(pages),options);
    assert.equal(result.checked,true);assert.equal(result.matched,false);assert.equal(result.unknown,false);
  }
});
test('WHMCS incomplete data and failed navigation prohibit retry',async()=>{
  for(const pages of [{[listUrl]:new Error('timeout')},{[listUrl]:'<form>Login</form>'},{[listUrl]:list('not a date')},{[listUrl]:list(),[invoiceUrl]:'<p>Unavailable</p>'},{[listUrl]:list(),[invoiceUrl]:invoice('KVM 4GB','$12.00')}]){
    const result=await queryRecentOrders(browser(pages),options);
    assert.equal(result.unknown,true);assert.equal(result.checked,false);assert.equal(result.matched,false);
  }
});
test('generic merchants are explicitly unchecked with no navigation',async()=>{
  const session=browser();const result=await queryRecentOrders(session,{...options,url:'https://merchant.example/products/one'});
  assert.equal(result.checked,false);assert.equal(result.unknown,false);assert.equal(result.matched,false);
  assert.match(result.reason,/未核验商家后台/);assert.deepEqual(session.visited,[]);
});
test('WHMCS invoice navigation identifies friendly product URLs',async()=>{
  const session=browser({[url]:'<a href="/billing/clientarea.php?action=invoices">Invoices</a>',[listUrl]:list(),[invoiceUrl]:invoice()});
  assert.equal((await queryRecentOrders(session,{...options,url:'https://merchant.example/billing/store/kvm'})).matched,true);
});
test('unread pagination returns unknown rather than a false absence',async()=>{
  const session=browser({[listUrl]:list('2026-09-01')+'<ul class="pagination"><li class="next"><a href="?page=2">Next</a></li></ul>'});
  assert.equal((await queryRecentOrders(session,options)).unknown,true);
});
test('missing exact retry amount is unknown and never falls back to budget',async()=>{
  const session=browser();assert.equal((await queryRecentOrders(session,{...options,total:undefined})).unknown,true);
  assert.deepEqual(session.visited,[]);
});
test('orders task interface uses verified trial amount and explicit retry window',async()=>{
  const session=browser({[listUrl]:list(),[invoiceUrl]:invoice()});
  const task={url,product:'KVM 4GB',maxTotal:99,verifiedCurrency:'USD',trial:{review:{total:12}}};
  assert.equal((await queryRecentOrders(session,task,{since:Date.parse(options.since),until:Date.parse(options.until)})).matched,true);
});
test('an unloaded invoice table is unknown, not empty',async()=>{
  const session=browser({[listUrl]:'<table id="tableInvoicesList"><tbody></tbody></table>'});
  assert.equal((await queryRecentOrders(session,options)).unknown,true);
});
test('hyphenated product variants do not match their parent product',async()=>{
  const session=browser({[listUrl]:list(),[invoiceUrl]:invoice('KVM 4GB - Premium')});
  assert.equal((await queryRecentOrders(session,options)).matched,false);
});
test('merchant date timezone cannot hide an invoice around midnight',async()=>{
  const session=browser({[listUrl]:list('2026-10-15'),[invoiceUrl]:invoice()});
  assert.equal((await queryRecentOrders(session,{...options,since:'2026-10-14T23:00:00Z',until:'2026-10-14T23:30:00Z'})).matched,true);
});
test('ambiguous numeric date includes both merchant date formats',async()=>{
  const session=browser({[listUrl]:list('10/11/2026'),[invoiceUrl]:invoice()});
  assert.equal((await queryRecentOrders(session,{...options,since:'2026-11-10T10:00:00Z',until:'2026-11-10T11:00:00Z'})).matched,true);
});
