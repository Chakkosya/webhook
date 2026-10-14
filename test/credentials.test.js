import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createStore } from '../lib/store.js';
import { createCredentialsCipher, requireCredentialHttps } from '../lib/credentials.js';
import { createOrderAccountService } from '../lib/order-account.js';

const key = 'ab'.repeat(32);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.credentials-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.CREDENTIALS_KEY;
  t.after(() => { if (previous === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = previous; });
  process.env.CREDENTIALS_KEY = key;
  return { dir, file: path.join(dir, 'state.json') };
}
function legacyUser() {
  return { id: 'user', orderAccounts: [{ monitorId: 'monitor', loginUrl: 'https://shop.example/login', credentials: { username: 'fixture-user-secret', password: 'fixture-password-secret' }, session: { state: { cookies: [{ name: 'auth', value: 'fixture-cookie-secret' }], origins: [], radarUserAgent: 'fixture-agent' }, redactions: ['fixture-typed-secret'] } }], orderTasks: [{ id: 'task', credentials: { username: 'fixture-task-user', password: 'fixture-task-password' } }] };
}

test('legacy credentials and full session migrate to ciphertext and round trip without rewriting unchanged state', t => {
  const { dir, file } = fixture(t), user = legacyUser();
  fs.writeFileSync(file, JSON.stringify({ users: [user] }));
  const store = createStore(dir), text = fs.readFileSync(file, 'utf8');
  for (const value of ['fixture-user-secret', 'fixture-password-secret', 'fixture-cookie-secret', 'fixture-typed-secret', 'fixture-task-user', 'fixture-task-password']) assert.ok(!text.includes(value));
  assert.equal(JSON.parse(text).users[0].orderAccounts[0].session.encrypted, 'aes-256-gcm');
  assert.deepEqual(createStore(dir).state.users[0].orderAccounts, user.orderAccounts);
  assert.deepEqual(createStore(dir).state.users[0].orderTasks, user.orderTasks);
  const marker = new Date('2001-01-01'); fs.utimesSync(file, marker, marker);
  store.persist(); assert.equal(fs.statSync(file).mtimeMs, marker.getTime());
  const publicText = JSON.stringify(store.publicWorkspace(store.state.users[0]));
  assert.ok(!publicText.includes('fixture-')); assert.ok(!publicText.includes('aes-256-gcm'));
});

test('missing key cannot persist new credentials or migrate plaintext and wrong key cannot overwrite encrypted data', t => {
  const { dir, file } = fixture(t);
  process.env.CREDENTIALS_KEY = '';
  const store = createStore(dir), original = fs.readFileSync(file, 'utf8');
  store.state.users.push(legacyUser());
  assert.throws(() => store.persist(), /CREDENTIALS_KEY/);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(fs.existsSync(file + '.tmp'), false);
  const legacy = JSON.stringify({ users: [legacyUser()] }); fs.writeFileSync(file, legacy);
  assert.throws(() => createStore(dir), /CREDENTIALS_KEY/); assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  const previous = process.env.CREDENTIALS_KEY;
  t.after(() => { if (previous === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = previous; });
  process.env.CREDENTIALS_KEY = key; createStore(dir); const encrypted = fs.readFileSync(file, 'utf8');
  for (const value of ['', 'cd'.repeat(32)]) {
    process.env.CREDENTIALS_KEY = value; assert.throws(() => createStore(dir), /CREDENTIALS_KEY/); assert.equal(fs.readFileSync(file, 'utf8'), encrypted);
  }
});

test('authenticated encryption rejects altered ciphertext and swapped account context', () => {
  assert.throws(() => createCredentialsCipher('short'), /64/);
  const cipher = createCredentialsCipher(key), value = cipher.encrypt({ password: 'fixture' }, 'account-a');
  assert.throws(() => cipher.decrypt(value, 'account-b'), /无法解密/);
  const bytes = Buffer.from(value.data, 'base64'); bytes[0] ^= 1;
  assert.throws(() => cipher.decrypt({ ...value, data: bytes.toString('base64') }, 'account-a'), /无法解密/);
});

test('credential transport requires TLS or explicitly trusted HTTPS proxy, never plain loopback HTTP', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.throws(() => requireCredentialHttps(request, {}), error => error.status === 403);
  request.headers['x-forwarded-proto'] = 'https';
  assert.throws(() => requireCredentialHttps(request, {}), /HTTPS/);
  requireCredentialHttps(request, { TRUST_PROXY: '1' });
  request.headers['x-forwarded-proto'] = 'https,http';
  assert.throws(() => requireCredentialHttps(request, { TRUST_PROXY: '1' }), /HTTPS/);
  request.socket.encrypted = true; requireCredentialHttps(request, {});
});

test('account password submission rejects HTTP merchant URL and rolls back when encryption key is missing', t => {
  const { dir } = fixture(t); process.env.CREDENTIALS_KEY = '';
  const store = createStore(dir), user = { id: 'user', orderAccounts: [] }, monitor = { id: 'monitor' };
  store.state.users.push(user); store.persist();
  const service = createOrderAccountService({ persist: store.persist });
  assert.throws(() => service.save(user, monitor, { loginUrl: 'http://shop.example/login', password: 'fixture-secret' }), /HTTPS/);
  assert.throws(() => service.save(user, monitor, { loginUrl: 'https://shop.example/login', password: 'fixture-secret' }), /CREDENTIALS_KEY/);
  assert.deepEqual(user.orderAccounts, []);
});

test('HTTP UI neither renders credential fields nor sends remote login input', async () => {
  const target = { textContent: '' }, status = { textContent: '' };
  const context = vm.createContext({ window: { location: { protocol: 'http:' }, addEventListener() {} }, document: { addEventListener() {} }, $: selector => selector === '#order-login-window' ? target : status, api: () => assert.fail('must not submit credentials') });
  vm.runInContext(fs.readFileSync(new URL('../public/orders-ui.js', import.meta.url), 'utf8'), context);
  context.renderLoginView({ view: { fields: [{ key: 'password', type: 'password' }] } });
  assert.match(target.textContent, /HTTPS/);
  await context.queueLoginAction({ type: 'fill', value: 'fixture-secret' }); assert.match(status.textContent, /HTTPS/);
});

test('real HTTP server rejects credential routes and accepts only explicitly trusted HTTPS proxy', async t => {
  const { dir, file } = fixture(t), store = createStore(dir);
  const { user } = store.register('route-user', 'fixture-login-password', process.env.SIGNUP_CODE);
  user.monitors.push({ id: 'monitor', kind: 'reminder-fixture', enabled: false });
  user.orderTasks.push({ id: 'task', monitorId: 'monitor', status: 'draft', enabled: false });
  store.persist();
  const cookie = store.issueCookie(user).split(';')[0];
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '1', CREDENTIALS_KEY: key, RESEND_API_KEY: '', MAIL_FROM: '', FLARESOLVERR_ENABLED: '0' }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'isolated server must start');
  const before = fs.readFileSync(file, 'utf8');
  const accountPath = '/api/monitors/monitor/order-account';
  for (const [endpoint, method, body] of [
    ...['start', 'action', 'finish'].map(action => [accountPath + '/' + action, 'POST', { sessionId: 'fixture', type: 'fill', value: 'route-secret' }]),
    [accountPath, 'PUT', { loginUrl: 'https://shop.example/login', username: 'route-user-secret', password: 'route-password-secret' }],
    ['/api/order-tasks', 'POST', { username: 'route-user-secret', password: 'route-password-secret' }],
    ['/api/order-tasks/task', 'PUT', { username: 'route-user-secret', password: 'route-password-secret' }]
  ]) {
    const response = await fetch(base + endpoint, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 403, endpoint); assert.match((await response.json()).error, /HTTPS/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const response = await fetch(base + accountPath, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ loginUrl: 'https://shop.example/login', username: 'route-user-secret', password: 'route-password-secret' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).account.hasCredentials, true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('route-password-secret'));
});

test('password-free login preserves clearance and stable account identity through save, check and preview', async () => {
  const user = { id: 'user', orderAccounts: [] }, monitor = { id: 'monitor' }, calls = [];
  const session = { state: { cookies: [{ name: 'cf_clearance', value: 'fixture-clearance' }, { name: 'auth', value: 'fixture-auth' }], origins: [], radarUserAgent: 'fixture-agent' }, check: { url: 'https://shop.example/account' }, redactions: [] };
  const service = createOrderAccountService({ persist() {}, openBrowser: async (task, options) => {
    calls.push({ task, options });
    return { close: async () => {}, productHtml: async () => '<p>product</p>', accountState: async () => session, remote: { view: async () => ({ fields: [] }), finish: async () => session } };
  } });
  service.save(user, monitor, { loginUrl: 'https://shop.example/login' });
  const opened = await service.start(user, monitor);
  const account = await service.finish(user, monitor, { sessionId: opened.sessionId });
  assert.equal(account.status, 'saved'); assert.equal(account.hasCredentials, false);
  assert.deepEqual(user.orderAccounts[0].session.state, session.state);
  await service.check(user, monitor); await service.productPreview(user, monitor, { url: 'https://shop.example/product' });
  assert.equal(calls.length, 3);
  for (const { task } of calls) assert.equal(task.accountId, 'user:monitor');
  for (const { options } of calls.slice(1)) assert.deepEqual(options.storageState, session.state);
});
