import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const executable = process.env.MONITOR_BROWSER_EXECUTABLE || (process.platform === 'win32' && existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : null);
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }

test('AI 设置可新增、切换、保留草稿、测试和删除 Key，生成前保存当前选择', { skip: !executable, timeout: 45000 }, async t => {
  const authorizations = [], pageErrors = [];
  const fixture = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    authorizations.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'answer', message: '支持定时提醒。' }) } }] }));
  });
  const fixturePort = await listen(fixture);
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'radar-ai-keys-ui-'));
  t.after(async () => { assert.equal(path.dirname(dataDir), path.resolve(tmpdir())); assert.ok(path.basename(dataDir).startsWith('radar-ai-keys-ui-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const reservation = http.createServer(), port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', RESEND_API_KEY: '', MAIL_FROM: '', SIGNUP_CODE: '', MONITOR_BROWSER_ENABLED: '0' } });
  t.after(async () => { if (child.exitCode !== null) return; const exited = once(child, 'exit'); child.kill(); await exited; });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(ready, true, '应用应成功启动');
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const registered = await context.request.post(base + '/api/auth/register', { data: { username: 'ui-key-user', password: 'ui-key-password-123' } });
  assert.equal(registered.status(), 201);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + '/#ai-settings');
  await page.locator('#add-ai-key-button').click();
  await page.locator('#ai-base-url').fill('http://127.0.0.1:' + fixturePort + '/v1');
  await page.locator('#ai-model').fill('ui-key-model');
  await page.locator('#ai-key-name').fill('常用');
  await page.locator('#ai-key').fill('ui-primary-private-key');
  const first = await page.locator('#ai-key-select').inputValue();
  await page.locator('#add-ai-key-button').click();
  await page.locator('#ai-key-name').fill('备用');
  await page.locator('#ai-key').fill('ui-backup-private-key');
  const second = await page.locator('#ai-key-select').inputValue();
  await page.locator('#ai-key-select').selectOption(first);
  assert.equal(await page.locator('#ai-key-name').inputValue(), '常用');
  assert.equal(await page.locator('#ai-key').inputValue(), 'ui-primary-private-key');
  await page.locator('#ai-key-select').selectOption(second);
  assert.equal(await page.locator('#ai-key').inputValue(), 'ui-backup-private-key');
  const testResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/test') && response.request().method() === 'POST');
  await page.locator('#ai-test-button').click();
  assert.equal((await testResponse).status(), 200);
  assert.equal(authorizations.at(-1), 'Bearer ui-backup-private-key');
  assert.equal((await (await context.request.get(base + '/api/state')).json()).settings.aiKeys.length, 0);

  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await page.locator('#save-button').click();
  const saved = await (await savedResponse).json();
  assert.equal(saved.settings.activeAiKeyId, second);
  assert.equal(saved.settings.aiKeys.length, 2);
  await page.waitForFunction(() => document.querySelector('#settings-dirty').textContent === '');
  assert.equal(await page.locator('#ai-key').inputValue(), '');
  await page.reload();
  await page.locator('#ai-key-select').selectOption(first);
  assert.equal(await page.locator('#ai-key-name').inputValue(), '常用');
  assert.equal(await page.locator('#ai-key').inputValue(), '');
  await page.locator('a.nav-link[href="#create"]').click();
  await page.locator('#instruction').fill('支持哪些定时提醒？');
  const parseResponse = page.waitForResponse(response => response.url().endsWith('/api/parse') && response.request().method() === 'POST');
  await page.locator('#parse-button').click();
  assert.equal((await parseResponse).status(), 200);
  assert.equal(authorizations.at(-1), 'Bearer ui-primary-private-key');
  assert.equal((await (await context.request.get(base + '/api/state')).json()).settings.activeAiKeyId, first);

  await page.locator('a.nav-link[href="#ai-settings"]').click();
  await page.locator('#clear-ai-key-button').click();
  assert.equal(await page.locator('#ai-key-select').inputValue(), second);
  const deleteResponse = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT');
  await page.locator('#save-button').click();
  const deleted = await (await deleteResponse).json();
  assert.equal(deleted.settings.activeAiKeyId, second);
  assert.deepEqual(deleted.settings.aiKeys, [{ id: second, name: '备用', hasKey: true }]);
  assert.deepEqual(pageErrors, []);
});