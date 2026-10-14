import test from 'node:test';
import assert from 'node:assert/strict';
import {whmcsConfigurationPermit,whmcsPreparationRequest} from '../lib/order-whmcs.js';
import {matchesNativeRequest} from '../lib/order-contract.js';
const configuration={url:'https://merchant.example/cart.php',item:'0',billingCycle:'monthly',entries:[['configure','true'],['i','0'],['billingcycle','monthly'],['configoption[40]','64'],['token','private-token'],['rootpw','']]};
const request=(entries,url=configuration.url)=>({url:()=>url,method:()=>'POST',isNavigationRequest:()=>false,resourceType:()=>'xhr',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>new URLSearchParams(entries).toString()});
const quote=[['ajax','1'],['a','confproduct'],['calctotal','true'],...configuration.entries];
test('WHMCS price and cycle requests bind to the current configuration',()=>{
  assert.equal(whmcsPreparationRequest(request(quote),configuration),'quote');
  const cycle=[['a','cyclechange'],['ajax','1'],['i','0'],['billingcycle','monthly']];
  assert.equal(whmcsPreparationRequest(request(cycle),configuration),'cycle');
  assert.equal(whmcsPreparationRequest(request(cycle),{...configuration,billingCycle:'annually'}),null);
  assert.equal(whmcsPreparationRequest(request(quote),null),null);
});
test('WHMCS recommendation lookup and configuration submission have separate permits',()=>{
  const recommendations=request([['addproductajax','1'],['a','confproduct'],...configuration.entries]);
  assert.equal(whmcsPreparationRequest(recommendations,configuration),null);
  assert.equal(whmcsPreparationRequest(recommendations,configuration,{recommendations:true}),'recommendations');
  const submitted=request([['ajax','1'],['a','confproduct'],...configuration.entries]);
  assert.equal(whmcsPreparationRequest(submitted,configuration),null);
  assert.equal(matchesNativeRequest(whmcsConfigurationPermit(configuration),submitted),true);
  assert.equal(matchesNativeRequest(whmcsConfigurationPermit(configuration),request(quote)),false);
});
test('WHMCS quotes cannot authorize checkout, another cart item or changed form values',()=>{
  const replace=(key,value)=>quote.map(([name,current])=>[name,name===key?value:current]);
  for(const entries of [replace('a','complete'),replace('i','1'),replace('configoption[40]','128'),replace('calctotal','false'),[...quote,['action','pay']],[...quote,['a','complete']],[...quote,['quantity','2']]])assert.equal(whmcsPreparationRequest(request(entries),configuration),null);
  assert.equal(whmcsPreparationRequest(request(quote,configuration.url+'?a=complete'),configuration),null);
  assert.equal(whmcsPreparationRequest(request(quote,'https://other.example/cart.php'),configuration),null);
  assert.equal(whmcsPreparationRequest({...request(quote),isNavigationRequest:()=>true},configuration),null);
});


test('WHMCS group-prefixed product titles retain exact model and variant boundaries',async()=>{
  const {whmcsProductMatches}=await import('../lib/order-whmcs.js');
  assert.equal(whmcsProductMatches('NY RYZEN KVM 4GB',{productTitles:['New York - AMD RYZEN KVM - NY RYZEN KVM 4GB']}),true);
  for(const title of ['New York - NY RYZEN KVM 24GB','New York - NY RYZEN KVM 4GB V2','NY RYZEN KVM 4GB - Annual'])assert.equal(whmcsProductMatches('NY RYZEN KVM 4GB',{productTitles:[title]}),false);
  assert.equal(whmcsProductMatches('NY RYZEN KVM 4GB',null),false);
});
