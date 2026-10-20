import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {WorkspaceStore} from '../src/workspace/store.js';
import {ProxyProfiles,parseProxy} from '../src/browser/proxy.js';
import {ApiProfiles} from '../src/workspace/profiles.js';

test('API profiles support multiple providers, retain unchanged keys and never return secrets',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const store=new WorkspaceStore(db,randomBytes(32)),apis=new ApiProfiles(store);
    const first=apis.save({name:'Primary',endpoint:'https://api.example/v1',model:'model-one',key:'private-api-key'});
    const second=apis.save({name:'Backup',endpoint:'https://backup.example/chat/completions',model:'model-two',key:'backup-private-key'});
    assert.equal(apis.list().length,2);
    assert.equal(first.endpoint,'https://api.example/v1/chat/completions');
    assert.equal(first.key,undefined);
    assert.equal(first.hasKey,true);
    apis.save({...first,model:'model-updated',key:''});
    assert.equal(apis.resolve(first.id).key,'private-api-key');
    apis.setDefault(second.id);
    assert.equal(apis.resolve().model,'model-two');
    assert.equal(JSON.stringify(apis.list()).includes('private-key'),false);
    const raw=JSON.stringify(db.prepare('SELECT * FROM workspace_records').all());
    assert.equal(raw.includes('private-api-key'),false);
    apis.delete(first.id);assert.equal(apis.list().length,1);
  } finally {db.close();}
});

test('SS profiles accept share links and manual fields without returning passwords',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const profiles=new ProxyProfiles(new WorkspaceStore(db,randomBytes(32)));
    const encoded=Buffer.from('aes-256-gcm:fixture-password').toString('base64url');
    const first=profiles.save({name:'Tokyo',url:'ss://'+encoded+'@ss.example:8388#Tokyo'});
    assert.equal(first.type,'ss');assert.equal(first.endpoint,'ss://ss.example:8388');
    assert.equal(first.url,undefined);
    const second=profiles.save({name:'Manual',type:'ss',server:'ss2.example',port:8389,method:'chacha20-ietf-poly1305',password:'fixture-other'});
    assert.equal(profiles.get(second.id).node.password,'fixture-other');
    profiles.save({...first,name:'Tokyo renamed',url:''});
    assert.equal(profiles.get(first.id).node.password,'fixture-password');
    assert.equal(JSON.stringify(profiles.list()).includes('fixture-password'),false);
    const raw=JSON.stringify(db.prepare('SELECT * FROM workspace_records').all());
    assert.equal(raw.includes('fixture-password'),false);
    assert.throws(()=>parseProxy('ss://'+encoded+'@ss.example:8388/?plugin=obfs-local'),/插件/);
    assert.throws(()=>parseProxy('ss://not-valid'),/SS/);
  } finally {db.close();}
});

test('authenticated HTTP proxy credentials are passed to Chromium separately from the address',()=>{
  const profile=parseProxy('http://fixture-user:fixture-password@127.0.0.1:8888');
  assert.deepEqual(profile.proxy,{server:'http://127.0.0.1:8888',username:'fixture-user',password:'fixture-password'});
  assert.equal(profile.endpoint.includes('fixture-password'),false);
});
