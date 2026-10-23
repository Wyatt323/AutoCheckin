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
  proxyReq.socket.remoteAddress = '192.0.2.1'; assert.equal(requestSecurity(proxyReq, { trustProxy: true }).secure, true, 'explicit proxy trust supports separate hosts and Docker bridge');
  const checkRequest = (host, origin, options = {}, headers = {}, method = 'POST') => requestSecurity({ method, headers: { host, origin, ...headers }, socket: { remoteAddress: '192.0.2.1' } }, options);
  for (const host of ['localhost:8765', '192.0.2.10:19000', 'ack.wyattu.net', 'ack.wyattu.net:9443', '[::1]:8765']) {
    assert.equal(checkRequest(host, `http://${host}`).secure, false, host);
    assert.ok(checkRequest(host, 'https://evil.example').error, host);
  }
  assert.equal(checkRequest('ack.wyattu.net:80', 'http://ack.wyattu.net').secure, false);
  assert.equal(checkRequest('ack.wyattu.net:443', 'https://ack.wyattu.net', { trustProxy: true }, { 'x-forwarded-proto': 'https' }).secure, true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(checkRequest('ack.wyattu.net', 'https://evil.example', { trustProxy: true }, {
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example;proto=https'
    }, method).error, `${method}: forwarded host cannot bypass CSRF`);
  }
  for (const proto of ['https,http', 'https, http', 'HTTPS', 'garbage']) assert.ok(checkRequest('ack.wyattu.net', 'https://ack.wyattu.net', { trustProxy: true }, { 'x-forwarded-proto': proto }).error);
  assert.ok(checkRequest('ack.wyattu.net', 'null').error);
  for (const host of [undefined, '', 'evil.example/path', 'user@evil.example', 'example:99999', 'example,evil', 'example\\evil', 'example#evil']) assert.ok(checkRequest(host, undefined).error, `invalid host: ${host}`);
  assert.equal(checkRequest('127.0.0.1:8765', undefined, { strictPublicHost: true }).secure, false);
  assert.ok(checkRequest('ack.wyattu.net', undefined, { strictPublicHost: true }).error);
  assert.equal(checkRequest('example:9000', 'http://example:9000', { strictPublicHost: true, publicHost: 'example', port: 9000 }).secure, false);
  assert.equal(checkRequest('example:9000', undefined).secure, false, 'non-browser clients without Origin remain supported');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
  let child, browser;
  const sock = net.createServer(); await new Promise(r => sock.listen(0, '127.0.0.1', r)); const port = sock.address().port; await new Promise(r => sock.close(r));
  const base = `http://127.0.0.1:${port}`;
  const start = async (password, options = {}) => {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, ADMIN_PASSWORD: password, PORT: String(port), AUTOCHECKIN_DATA_DIR: directory, BIND_HOST: '', PUBLIC_HOST: '127.0.0.1', STRICT_PUBLIC_HOST: 'false', TRUST_PROXY: 'false', ...options }, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/auth/status')).ok) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Fixture server failed to start');
  };
  const stop = async () => { const exited = new Promise(r => child.once('close', r)); child.kill(); await exited; child = null; };
  // Node fetch may discard a custom Host; use HTTP directly for proxy fixtures.
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const outgoing = require('node:http').request(url, { method, headers }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: key => {
        const value = response.headers[key.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value || null;
      } }, text: async () => text }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
  const post = (url, input, headers = {}) => request(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
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
    for (const host of ['localhost:19000', '192.0.2.10:9876', 'ack.wyattu.net']) {
      assert.equal((await request(base + '/api/auth/status', { headers: { Host: host } })).status, 200);
      assert.equal((await request(base + '/api/state', { headers: { Host: host } })).status, 401, 'alternate hosts still require authentication');
      assert.equal((await post('/api/auth/login', { password: 'integration-secret' }, { Host: host, Origin: `http://${host}` })).status, 200);
    }
    const lan = Object.values(os.networkInterfaces()).flat().find(item => item.family === 'IPv4' && !item.internal);
    if (lan) assert.equal((await fetch(`http://${lan.address}:${port}/api/auth/status`)).status, 200, 'default listener accepts non-loopback access');
    assert.equal((await post('/api/auth/login', { password: 'integration-secret' }, { Host: 'ack.wyattu.net', Origin: 'https://ack.wyattu.net', 'X-Forwarded-Proto': 'https' })).status, 403, 'proxy protocol ignored by default');
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
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base); await page.waitForURL('**/login');
      await page.locator('#admin-password').waitFor();
      await page.waitForFunction(()=>document.querySelector('#admin-password') === document.activeElement);
      assert.equal(await page.locator('#admin-password').evaluate(el => el === document.activeElement), true);
      const artifacts = process.env.AUTOCHECKIN_TEST_ARTIFACT_DIR; if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-desktop.png'), fullPage: true });
      await page.fill('#admin-password', 'wrong'); await page.click('#auth-submit'); await page.waitForFunction(() => document.querySelector('#auth-error').textContent.includes('不正确'));
      assert.equal(await page.inputValue('#admin-password'), ''); assert.equal(await page.locator('#admin-password').evaluate(el => el === document.activeElement), true);
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-error.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (artifacts) await page.screenshot({ path: path.join(artifacts, 'admin-login-mobile.png'), fullPage: true });
      await page.fill('#admin-password', 'integration-secret'); await page.click('#auth-reveal'); assert.equal(await page.locator('#admin-password').getAttribute('type'), 'text'); await page.click('#auth-reveal');
      await page.click('#auth-submit'); await page.waitForURL(base + '/');
      // Mobile navigation is a closed drawer, including the logout action.
      assert.equal(await page.locator('#admin-logout').isVisible(), false);
      await page.locator('#nav-drawer-open').click();
      assert.equal(await page.locator('#nav-drawer-open').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.main').evaluate(el => el.inert), true);
      await page.locator('#admin-logout').waitFor();
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      await page.click('#admin-logout'); await page.waitForURL('**/login');
      assert.equal((await page.request.get(base + '/api/state')).status(), 401);
      await page.fill('#admin-password', 'integration-secret'); await page.click('#auth-submit'); await page.waitForURL(base + '/'); await page.context().clearCookies();
      // Natural application polling detects expiry; evaluating during redirect races navigation.
      await page.waitForURL('**/login', { timeout: 15000 }); assert.deepEqual(errors, []);
      console.log('Real Chromium admin auth PASS: desktop/mobile/error screenshots, autofocus, reveal, password clearing, login/logout, 401 expiry redirect, no browser storage');
    }
    await stop(); await start('integration-secret', { TRUST_PROXY: 'true' });
    const proxyHeaders = { Host: 'ack.wyattu.net', Origin: 'https://ack.wyattu.net', 'X-Forwarded-Proto': 'https' };
    const proxyLogin = await post('/api/auth/login', { password: 'integration-secret' }, proxyHeaders);
    assert.equal(proxyLogin.status, 200); assert.match(proxyLogin.headers.get('set-cookie'), /; Secure/);
    assert.equal((await post('/api/auth/logout', {}, { ...proxyHeaders, Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', Forwarded: 'host=evil.example;proto=https', Cookie: proxyLogin.headers.get('set-cookie').split(';')[0] })).status, 403);
    await stop(); await start('integration-secret', { STRICT_PUBLIC_HOST: 'true', PUBLIC_PORT: String(port) });
    assert.equal((await request(base + '/api/auth/status', { headers: { Host: 'ack.wyattu.net' } })).status, 403);
    assert.equal((await fetch(base + '/api/auth/status')).status, 200);
    console.log('Admin auth security PASS: fail closed, every API/static route, unrestricted valid hosts, non-loopback listener, same-origin CSRF, strict-host opt-in, TTL, bounds, rate limit cleanup, explicit proxy trust, secret redaction, logout');
  } finally { await browser?.close(); if (child) await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
