import {serve} from './src/server.js';
const app=await serve();
console.log('Browser Workflow: http://'+(process.env.HOST||'127.0.0.1')+':'+app.server.address().port);
if(app.runtime.config)void app.runtime.warm().catch(error=>app.runtime.event({type:'warmup-failed',category:error.code,message:error.message}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit();});
