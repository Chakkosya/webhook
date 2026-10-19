import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CredentialStore} from '../src/browser/credentials.js';
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'workflow-credentials-')),db=new DatabaseSync(join(dir,'store.sqlite'));
  const store=await new CredentialStore(db,dir).open();
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  return {dir,db,store};
}
test('credentials survive a restart and are encrypted on disk',async t=>{
  const {store,dir,db}=await setup(t);
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-private-password'});
  const reopened=await new CredentialStore(db,dir).open();
  assert.deepEqual(reopened.get('https://shop.example','main'),{username:'fixture-user',password:'fixture-private-password'});
  const bytes=await readFile(join(dir,'store.sqlite'));
  assert.equal(bytes.includes(Buffer.from('fixture-user')),false);
  assert.equal(bytes.includes(Buffer.from('fixture-private-password')),false);
  assert.deepEqual(reopened.status('https://shop.example','main'),{saved:true,username:'fixture-user'});
});
test('credentials are isolated by site and account, and can be updated or deleted',async t=>{
  const {store}=await setup(t);
  store.save('https://one.example','main',{username:'first',password:'first-password'});
  store.save('https://two.example','main',{username:'second',password:'second-password'});
  assert.equal(store.get('https://one.example','other'),null);
  assert.equal(store.get('https://two.example','main').username,'second');
  store.save('https://one.example','main',{username:'first',password:'new-password'});
  assert.equal(store.get('https://one.example','main').password,'new-password');
  store.delete('https://one.example','main');
  assert.deepEqual(store.status('https://one.example','main'),{saved:false,username:null});
});
test('existing encrypted credentials are not overwritten when the key is missing',async t=>{
  const {store,dir,db}=await setup(t);
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-secret'});
  await rm(join(dir,'credentials.key'));
  await assert.rejects(()=>new CredentialStore(db,dir).open(),{code:'CREDENTIALS_KEY'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n,1);
});
test('empty credentials do not replace a saved account',async t=>{
  const {store}=await setup(t);
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-secret'});
  assert.throws(()=>store.save('https://shop.example','main',{username:'fixture-user',password:''}),{code:'CREDENTIALS'});
  assert.equal(store.get('https://shop.example','main').password,'fixture-secret');
});
