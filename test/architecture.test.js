import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
test('the transitive execution and monitor imports contain no offline AI dependency',async()=>{
  const seen=new Set();
  async function visit(file) {
    file=resolve(file);if(seen.has(file))return;seen.add(file);
    assert.ok(!file.includes(resolve('src/ai')),file);
    const code=await readFile(file,'utf8');
    for(const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g))if(match[1].startsWith('.'))await visit(resolve(dirname(file),match[1]));
  }
  await visit('src/engine/index.js');await visit('src/monitor/index.js');await visit('src/runtime.js');
});
