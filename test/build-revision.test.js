import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRevision,getBuildRevision} from '../lib/build-revision.js';
import {createOrderExecutionLogs} from '../lib/order-execution-log.js';

test('build revision preserves the injected image commit',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'radar-build-revision-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(getBuildRevision({env:{MONITOR_BUILD_REVISION:'  image-commit  '},root}),'image-commit');
});

test('local runs report the actual repository HEAD without an injected revision',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(getBuildRevision({env:{},root}),head);
  assert.equal(getBuildRevision({env:{MONITOR_BUILD_REVISION:'unknown'},root}),head);
});

test('source-built images use the revision recorded during the build without Git metadata',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'radar-build-revision-'));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'build-revision'),'source-build-commit\n');
  assert.equal(getBuildRevision({env:{},root}),'source-build-commit');
  assert.equal(getBuildRevision({env:{MONITOR_BUILD_REVISION:'unknown'},root}),'source-build-commit');
  assert.equal(getBuildRevision({env:{MONITOR_BUILD_REVISION:'older-env-commit'},root}),'source-build-commit');
});

test('exported execution logs identify the actual running build',()=>{
  const monitorId='monitor-version',user={monitors:[{id:monitorId,label:'Version'}]},report=createOrderExecutionLogs().report(user,monitorId);
  assert.ok(buildRevision);
  assert.equal(report.runtime.buildRevision,buildRevision);
});
