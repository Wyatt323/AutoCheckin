const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { createAdminAuth, requestSecurity } = require('../admin_auth');
(async () => {
  let time = 0;
  const req = (cookie = '', ip = '127.0.0.1') => ({ headers: { cookie }, socket: { remoteAddress: ip } });
  const auth = createAdminAuth({ password: 'unit-secret', ttlMs: 2000, now: () => time, maxSessions: 2, maxIps: 2 });
  assert.equal(auth.login(req(), { password: 'wrong' }, false).status, 401);
  const result = auth.login(req(), { password: 'unit-secret' }, true);
  assert.match(result.cookie, /HttpOnly; SameSite=Strict; Max-Age=2; Secure/);
  const cookie = result.cookie.split(';')[0];
  assert.ok(auth.authenticated(req(cookie))); assert.ok(!auth.authenticated(req(cookie + '; ' + cookie)));
  time = 2000; assert.ok(!auth.authenticated(req(cookie)));
  let first = auth.login(req(), { password: 'unit-secret' }, false).cookie.split(';')[0];
  auth.logout(req(first), false); assert.ok(!auth.authenticated(req(first)));
  first = auth.login(req(), { password: 'unit-secret' }, false).cookie.split(';')[0];
  auth.login(req(), { password: 'unit-secret' }, false); auth.login(req(), { password: 'unit-secret' }, false);
  assert.ok(!auth.authenticated(req(first)), 'bounded sessions evict oldest');
  for (let i = 0; i < 10; i++) assert.equal(auth.login(req('', 'bad'), { password: 'x' }, false).status, 401);
  assert.equal(auth.login(req('', 'bad'), { password: 'unit-secret' }, false).status, 429);
  time += 900001; assert.equal(auth.login(req('', 'bad'), { password: 'unit-secret' }, false).status, 200);
  const capped = createAdminAuth({ password: 'x', maxIps: 1 });
  capped.login(req('', 'a'), { password: 'bad' }, false);
  assert.equal(capped.login(req('', 'b'), { password: 'bad' }, false).status, 429);
  const proxyReq = { method: 'POST', headers: { host: 'example:8765', origin: 'https://example:8765', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(requestSecurity(proxyReq, { publicHost: 'example', port: 8765, trustProxy: true }).secure, true);
  assert.ok(requestSecurity(proxyReq, { publicHost: 'example', port: 8765 }).error);
  proxyReq.socket.remoteAddress = '192.0.2.1'; assert.ok(requestSecurity(proxyReq, { publicHost: 'example', port: 8765, trustProxy: true }).error);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
  let child, browser;
  const sock = net.createServer(); await new Promise(r => sock.listen(0, '127.0.0.1', r)); const port = sock.address().port; await new Promise(r => sock.close(r));
  const base = `http://127.0.0.1:${port}`;
  const start = async password => {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, ADMIN_PASSWORD: password, PORT: String(port), AUTOCHECKIN_DATA_DIR: directory, PUBLIC_HOST: '127.0.0.1', TRUST_PROXY: 'false' }, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Fixture server failed to start');
  };
  const stop = async () => { const exited = new Promise(r => child.once('close', r)); child.kill(); await exited; child = null; };
  const post = (url, input, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  try {
    await start('');
    assert.equal((await fetch(base + '/login')).status, 200);
    assert.equal((await post('/api/auth/login', { password: 'anything' })).status, 503);
    assert.equal((await fetch(base + '/api/state')).status, 401);
    await stop(); await start('integration-secret');
    for (const [method, url] of [['GET','/api/state'],['GET','/api/login/status'],['POST','/api/config'],['POST','/api/run'],['POST','/api/stop'],['POST','/api/automation/restart'],['POST','/api/accounts/chats/resolve'],['POST','/api/login/start'],['POST','/api/login/password'],['POST','/api/login/cancel'],['GET','/api/unknown']]) {
      assert.equal((await fetch(base + url, { method })).status, 401, url);
    }
    for (const url of ['/', '/index.html', '/app.js', '/login.js', '/auth.html', '/%69ndex.html', '/foo/../index.html']) {
      const response = await fetch(base + url, { redirect: 'manual' }); assert.equal(response.status, 302, url); assert.equal(response.headers.get('location'), '/login');
    }
    assert.equal((await post('/api/auth/login', { password: 'integration-secret' }, { Origin: 'https://evil.example' })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      require('node:http').get(base + '/api/auth/status', { headers: { Host: 'evil:8765' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 401);
    const logged = await post('/api/auth/login', { password: 'integration-secret' }, { Origin: base });
    assert.equal(logged.status, 200); const session = logged.headers.get('set-cookie').split(';')[0];
    assert.ok(!logged.headers.get('set-cookie').includes('Secure')); assert.equal(logged.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: session } })).status, 200);
    assert.ok(!(await (await fetch(base + '/api/state', { headers: { Cookie: session } })).text()).includes('integration-secret'));
    assert.equal((await post('/api/auth/logout', {}, { Cookie: session })).status, 200);
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: session } })).status, 401);
    if (process.env.PLAYWRIGHT_MODULE) {
      const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base); await page.waitForURL('**/login');
      await page.locator('#admin-password').waitFor(); assert.equal(await page.locator('#admin-password').evaluate(el => el === document.activeElement), true);
      const artifacts = process.env.AUTOCHECKIN_TEST_ARTIFACT_DIR; if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-desktop.png'), fullPage: true });
      await page.fill('#admin-password', 'wrong'); await page.click('#auth-submit'); await page.waitForFunction(() => document.querySelector('#auth-error').textContent.includes('不正确'));
      assert.equal(await page.inputValue('#admin-password'), ''); assert.equal(await page.locator('#admin-password').evaluate(el => el === document.activeElement), true);
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-error.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-mobile.png'), fullPage: true });
      await page.fill('#admin-password', 'integration-secret'); await page.click('#auth-reveal'); assert.equal(await page.locator('#admin-password').getAttribute('type'), 'text'); await page.click('#auth-reveal');
      await page.click('#auth-submit'); await page.waitForURL(base + '/'); await page.locator('#admin-logout').waitFor();
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      await page.click('#admin-logout'); await page.waitForURL('**/login');
      assert.equal((await page.request.get(base + '/api/state')).status(), 401);
      await page.fill('#admin-password', 'integration-secret'); await page.click('#auth-submit'); await page.waitForURL(base + '/'); await page.context().clearCookies();
      // Natural application polling detects expiry; evaluating during redirect races navigation.
      await page.waitForURL('**/login', { timeout: 15000 }); assert.deepEqual(errors, []);
      console.log('Real Chromium admin auth PASS: desktop/mobile/error screenshots, autofocus, reveal, password clearing, login/logout, 401 expiry redirect, no browser storage');
    }
    console.log('Admin auth security PASS: fail closed, every API/static route, host/origin, TTL, bounds, rate limit cleanup, proxy trust, secret redaction, logout');
  } finally { await browser?.close(); if (child) await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
