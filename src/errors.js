export class Fault extends Error {
  constructor(code,message,options={}) { super(message,options); this.name='Fault'; this.code=code; this.details=options.details; }
}
export const fail=(code,message,details)=>{throw new Fault(code,message,{details});};
export function classify(error) {
  if(error.code)return error.code;
  const text=String(error.message);
  if(/timeout|timed out/i.test(text))return 'TIMEOUT';
  if(/net::|ECONN|ENOTFOUND|socket/i.test(text))return 'NETWORK';
  return 'SITE_CHANGED';
}
export function errorRecord(error) {
  return {category:classify(error),name:error.name,message:error.message,code:error.code,
    stack:error.stack,cause:error.cause?errorRecord(error.cause):undefined,details:error.details};
}
