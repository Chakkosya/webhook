import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));

export function getBuildRevision({env=process.env,root=projectRoot}={}){
  try{const revision=readFileSync(path.join(root,'build-revision'),'utf8').trim();if(revision)return revision;}catch{}
  const injected=env.MONITOR_BUILD_REVISION?.trim();
  if(injected&&injected!=='unknown')return injected;
  try{return execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||null;}catch{return null;}
}

export const buildRevision=getBuildRevision();
