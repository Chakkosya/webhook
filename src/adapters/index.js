import {LearnedSiteAdapter,validateLearnedSite} from './learned/index.js';
import {WhmcsAdapter} from './whmcs/index.js';
import {fail} from '../errors.js';
export function createAdapter(site) {
  if(site?.adapter==='learned')return new LearnedSiteAdapter(site);
  if(site?.adapter==='whmcs')return new WhmcsAdapter(site);
  fail('CONFIG','站点尚未学习：请选择 learned 流程或 WHMCS 适配器并提供本站点证据');
}
export function validateSite(site){return validateLearnedSite(site,createAdapter(site));}
