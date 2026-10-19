import {spawn} from 'node:child_process';
import {validateWorkflow} from '../workflow/schema.js';
import {fail} from '../errors.js';
export class OfflineAssistant {
  constructor({command,args=[],timeoutMs=120000}){Object.assign(this,{command,args,timeoutMs});}
  async request(task,input) {
    if(!this.command)fail('AI_CONFIG','请配置场外 AI 命令');
    return new Promise((resolve,reject)=>{
      const child=spawn(this.command,this.args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const output=[],errors=[];
      const timer=setTimeout(()=>{child.kill();reject(new Error('场外 AI 命令超时'));},this.timeoutMs);
      child.stdout.on('data',d=>output.push(d));child.stderr.on('data',d=>errors.push(d));
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{
        clearTimeout(timer);
        if(code!==0){reject(new Error('场外 AI 命令退出 '+code+': '+Buffer.concat(errors).toString()));return;}
        try{resolve(JSON.parse(Buffer.concat(output).toString()));}catch(error){reject(error);}
      });
      child.stdin.on('error',reject);
      child.stdin.end(JSON.stringify({task,input,contract:{format:'JSON',workflowSchema:1,hotPathInference:false,requiresTwoTrials:true}}));
    });
  }
  async generate(evidence) {
    const result=await this.request('generate-workflow',evidence);
    return validateWorkflow(result.workflow);
  }
  async diagnose(run) {
    return this.request('diagnose',{error:run.error,steps:run.steps.map(({id,action,status,error,durationMs,locator})=>({id,action,status,error,durationMs,locator})),structure:run.evidence?.structure});
  }
  async repair(workflow,run) {
    const result=await this.request('repair-workflow',{workflow,diagnosis:await this.diagnose(run)});
    const candidate=validateWorkflow(result.workflow);
    if(candidate.id!==workflow.id)fail('AI_PATCH','修补不能改变工作流标识');
    return candidate;
  }
}
