import {readFile} from 'node:fs/promises';
const endpoint=process.env.AI_ENDPOINT,model=process.env.AI_MODEL,key=process.env.AI_API_KEY;
if(!endpoint||!model||!key)throw new Error('需要 AI_ENDPOINT、AI_MODEL 和 AI_API_KEY 环境变量');
let text='';for await(const chunk of process.stdin)text+=chunk;
const request=JSON.parse(text);
const template=await readFile(new URL('../../examples/workflow.template.json',import.meta.url),'utf8');
const instructions=[
  '输出 JSON 对象。',
  'diagnose 任务输出 {category,report,fix}，保留原始错误原因，报告使用中文。',
  'generate-workflow 和 repair-workflow 输出 {workflow}。',
  '工作流只使用证据中的本站点选择器、原生请求和成功耗时；缺少实测时返回 {error,missingEvidence}。',
  '每步必须有前置检查、动作、后置验证。付款必须跟在本次提交之后。',
  '工作流采用声明式 JSON，不包含 JavaScript。',
  '站点类型以证据为准，不默认 WHMCS；订单号和库存表达取自实际页面。',
  'JSON 工作流格式：'+template
].join('\n');
const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
  body:JSON.stringify({model,messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(request)}],response_format:{type:'json_object'},stream:false}),
  signal:AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS||120000))});
if(!response.ok)throw new Error('AI HTTP '+response.status+': '+await response.text());
const result=await response.json(),choice=result.choices?.[0];
if(choice?.finish_reason==='length')throw new Error('AI 输出超过长度上限');
if(!choice?.message?.content)throw new Error('AI 响应缺少 JSON 内容');
process.stdout.write(JSON.stringify(JSON.parse(choice.message.content)));
