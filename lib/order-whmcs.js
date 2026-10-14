import {matchesProductSelection} from './order-evidence.js';
import {nativeRequestPermit,matchesNativeRequest,formRequestEntries} from './order-contract.js';

// WHMCS serializes this form for price calculation and configuration AJAX.
// https://github.com/WHMCS/orderforms-standard_cart/blob/master/js/scripts.js
export function inspectWhmcsConfiguration(button){
  const current=new URL(location.href),form=button?.form||document.getElementById('frmConfigureProduct');
  if(!form||form.id!=='frmConfigureProduct'||!current.pathname.endsWith('/cart.php')||current.searchParams.get('a')!=='confproduct')return null;
  const entries=[...new FormData(form)];
  if(entries.some(([,value])=>typeof value!=='string'))return null;
  const values=new URLSearchParams(entries),item=values.get('i');
  if(['a','action','ajax','calctotal','addproductajax'].some(key=>values.has(key)))return null;
  if(values.get('configure')!=='true'||!/^\d+$/.test(item||'')||current.searchParams.get('i')!==item)return null;
  current.search='';current.hash='';
  const productTitles=[...form.querySelectorAll('h1,h2,h3')].filter(el=>el.getClientRects().length).map(el=>el.textContent.trim());
  return {url:current.href,entries,item,productTitles,billingCycle:values.get('billingcycle')};
}

export function whmcsConfigurationPermit(configuration){
  return nativeRequestPermit({nativeSubmit:true,url:configuration.url,method:'POST',encoding:'application/x-www-form-urlencoded',entries:[['ajax','1'],['a','confproduct'],...configuration.entries]});
}

export function whmcsPreparationRequest(request,configuration,{recommendations=false}={}){
  if(!configuration||request.method()!=='POST'||request.isNavigationRequest()||!['xhr','fetch'].includes(request.resourceType()))return null;
  let values;try{values=new URLSearchParams(formRequestEntries(request));}catch{return null;}
  const matches=entries=>matchesNativeRequest(nativeRequestPermit({nativeSubmit:true,url:configuration.url,method:'POST',encoding:'application/x-www-form-urlencoded',entries}),request);
  if(values.get('a')==='confproduct'&&values.get('calctotal')==='true'&&matches([['ajax','1'],['a','confproduct'],['calctotal','true'],...configuration.entries]))return 'quote';
  if(values.get('a')==='cyclechange'&&configuration.billingCycle&&matches([['a','cyclechange'],['ajax','1'],['i',configuration.item],['billingcycle',configuration.billingCycle]]))return 'cycle';
  if(recommendations&&values.get('addproductajax')==='1'&&matches([['addproductajax','1'],['a','confproduct'],...configuration.entries]))return 'recommendations';
  return null;
}

// WHMCS configuration headings render groupname + " - " + product name.
export function whmcsProductMatches(product,configuration){
  return (configuration?.productTitles||[]).some(title=>{
    const parts=title.split(/\s+[-–—]\s+/);
    return parts.slice(1).some((_,index)=>matchesProductSelection(product,parts.slice(index+1).join(' - ')));
  });
}
