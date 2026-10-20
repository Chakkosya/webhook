import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceStore} from '../src/workspace/store.js';
import {CredentialStore} from '../src/browser/credentials.js';
async function setup(t) {
  const dir=await mkdtemp(join(tmpdir(),'workflow-credentials-')),db=new DatabaseSync(join(dir,'store.sqlite'));
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  const store=await new CredentialStore(db,dir,'').open();
  return {dir,db,store};
}

test('credentials survive a restart and are encrypted on disk',async t=>{
  const {store,dir,db}=await setup(t);
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-private-password'});
  const key=await readFile(join(dir,'credentials.key'));
  assert.equal(key.length,32);
  const reopened=await new CredentialStore(db,dir,'').open();
  assert.deepEqual(reopened.get('https://shop.example','main'),{username:'fixture-user',password:'fixture-private-password'});
  assert.deepEqual(await readFile(join(dir,'credentials.key')),key);
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
  await assert.rejects(()=>new CredentialStore(db,dir,'').open(),{code:'CREDENTIALS_KEY'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n,1);
});

test('empty credentials do not replace a saved account',async t=>{
  const {store}=await setup(t);
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-secret'});
  assert.throws(()=>store.save('https://shop.example','main',{username:'fixture-user',password:''}),{code:'CREDENTIALS'});
  assert.equal(store.get('https://shop.example','main').password,'fixture-secret');
});

test('hexadecimal key files decrypt existing credentials without changing the key or ciphertext',async t=>{
  const {store,dir,db}=await setup(t),file=join(dir,'credentials.key');
  const credentials={username:'fixture-user',password:'fixture-secret'};
  store.save('https://shop.example','main',credentials);
  const ciphertext=db.prepare('SELECT secret FROM credentials').get().secret;
  const hex=(await readFile(file)).toString('hex').toUpperCase()+'\n';
  await writeFile(file,hex);
  const reopened=await new CredentialStore(db,dir,'').open();
  assert.deepEqual(reopened.get('https://shop.example','main'),credentials);
  assert.equal(await readFile(file,'utf8'),hex);
  assert.equal(db.prepare('SELECT secret FROM credentials').get().secret,ciphertext);
});

test('malformed key files fail without replacing the key or encrypted credentials',async t=>{
  const {store,dir,db}=await setup(t),file=join(dir,'credentials.key');
  store.save('https://shop.example','main',{username:'fixture-user',password:'fixture-secret'});
  const ciphertext=db.prepare('SELECT secret FROM credentials').get().secret,invalid='z'.repeat(64)+'\n';
  await writeFile(file,invalid);
  await assert.rejects(()=>new CredentialStore(db,dir,'').open(),{code:'CREDENTIALS_KEY'});
  assert.equal(await readFile(file,'utf8'),invalid);
  assert.equal(db.prepare('SELECT secret FROM credentials').get().secret,ciphertext);
});

test('a configured hexadecimal key can decrypt credentials when no key file exists',async t=>{
  const {store,dir,db}=await setup(t),file=join(dir,'credentials.key');
  const credentials={username:'fixture-user',password:'fixture-secret'};
  store.save('https://shop.example','main',credentials);
  const hex=(await readFile(file)).toString('hex');
  await rm(file);
  const reopened=await new CredentialStore(db,dir,hex).open();
  assert.deepEqual(reopened.get('https://shop.example','main'),credentials);
  await assert.rejects(()=>readFile(file),{code:'ENOENT'});
});

test('the configured key takes precedence and leaves an existing key file untouched',async t=>{
  const {store,dir,db}=await setup(t),file=join(dir,'credentials.key');
  const credentials={username:'fixture-user',password:'fixture-secret'};
  store.save('https://shop.example','main',credentials);
  const hex=(await readFile(file)).toString('hex'),otherKey=Buffer.alloc(32,42);
  await writeFile(file,otherKey);
  const reopened=await new CredentialStore(db,dir,hex).open();
  assert.deepEqual(reopened.get('https://shop.example','main'),credentials);
  assert.deepEqual(await readFile(file),otherKey);
});

test('an invalid configured key fails without falling back to the key file',async t=>{
  const {dir,db}=await setup(t),file=join(dir,'credentials.key'),key=await readFile(file);
  await assert.rejects(()=>new CredentialStore(db,dir,'invalid-key').open(),{code:'CREDENTIALS_KEY'});
  assert.deepEqual(await readFile(file),key);
});

test('encrypted workspace profiles also prevent generation of a replacement key',async t=>{
  const {dir,db,store}=await setup(t);
  new WorkspaceStore(db,store.key).put('api',{name:'Fixture',key:'fixture-private-api-key'});
  await rm(join(dir,'credentials.key'));
  await assert.rejects(()=>new CredentialStore(db,dir,'').open(),{code:'CREDENTIALS_KEY'});
  await assert.rejects(()=>readFile(join(dir,'credentials.key')),{code:'ENOENT'});
});
