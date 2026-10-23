// Real server behind a deliberately stale CDN fixture. No Telegram connections.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), net = require('node:net');
const {spawn} = require('node:child_process');

(async () => {
  const project = path.resolve(__dirname, '..');
  const tempBase = path.resolve(process.env.AUTOCHECKIN_TEST_TMPDIR || os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'frontend-assets-'));
  let server, proxy, browser;
  try {
    for (const name of fs.readdirSync(project).filter(name => name.endsWith('.js'))) fs.copyFileSync(path.join(project, name), path.join(root, name));
    fs.copyFileSync(path.join(project, 'config.example.json'), path.join(root, 'config.example.json'));
    fs.cpSync(path.join(project, 'public'), path.join(root, 'public'), {recursive:true});
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/config.json'), JSON.stringify({
      telegram:{users:[{name:'离线账号',session:'offline',bot_groups:{button:[],command:[]}}]}, ai:{providers:[]},
      automations:{schedules:[],forwards:[],redPackets:[{id:'cache_rule',name:'缓存验证规则',enabled:false,account:'offline',groups:['-1001234567'],botUsername:'@example_bot',watchSeconds:120,retryInterval:0.5,buttonKeywords:[],successKeywords:[],emptyKeywords:[]}]}
    }));
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const env = {...process.env, PORT:String(port), BIND_HOST:'127.0.0.1', STRICT_PUBLIC_HOST:'false', TRUST_PROXY:'false', ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'offline-ui-secret', AUTOCHECKIN_DATA_DIR:path.join(root, 'data')};
    for (const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGOPTIONS']) delete env[key];
    server = spawn(process.execPath, [path.join(root, 'server.js')], {env,stdio:'ignore'});
    let ready = false;
    for (let i=0;i<100;i++) {
      try {if ((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok) {ready=true;break;}} catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'isolated UI server starts');
    const requestedAssets = [];
    proxy = http.createServer((req,res) => {
      const url = new URL(req.url, 'http://localhost');
      if (/\.(js|css|svg)$/.test(url.pathname)) {
        requestedAssets.push(url.pathname + url.search);
        if (!url.searchParams.has('v')) {
          res.writeHead(200, {'Content-Type':url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css','CF-Cache-Status':'HIT','Cache-Control':'max-age=86400'});
          return res.end(url.pathname.endsWith('.js') ? 'throw Error("stale unversioned CDN script");' : '/* stale CDN style */');
        }
      }
      const upstream = http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers}, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);incoming.pipe(res);
      });
      upstream.on('error', () => {res.writeHead(502);res.end();});req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const noCdnCache = response => {
      assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
      assert.equal(response.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    };
    const versionedPage = async (pathname, cookie='') => {
      const response = await fetch(base + pathname, {headers:{Cookie:cookie},redirect:'manual'});
      const html = await response.text();
      assert.equal(response.status, 200, html);noCdnCache(response);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const version = response.headers.get('x-autocheckin-ui');
      assert.match(version, /^[a-f0-9]{20}$/);
      const assets = [...html.matchAll(/\b(?:src|href)="(\/[^" ]+\.(?:js|css|svg)(?:\?[^" ]*)?)"/g)].map(match => match[1]);
      assert.ok(assets.length>3);
      for (const asset of assets) assert.equal(new URL(asset,base).searchParams.get('v'), version, asset);
      return {version,assets};
    };
    await versionedPage('/login');
    const unauthenticated = await fetch(base + '/app.js?v=protected', {redirect:'manual'});
    assert.equal(unauthenticated.status, 302);assert.equal(unauthenticated.headers.get('location'), '/login');noCdnCache(unauthenticated);
    const login = await fetch(base + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:'admin',password:'offline-ui-secret'})});
    assert.equal(login.status, 200);noCdnCache(login);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const original = await versionedPage('/',cookie);
    assert.equal((await versionedPage('/index.html',cookie)).version, original.version, 'same deployed files produce a stable document version');
    for (const asset of original.assets) {
      const response = await fetch(base + asset,{headers:{Cookie:cookie}});assert.equal(response.status,200);noCdnCache(response);
      const file = new URL(asset,base).pathname.slice(1);
      const expected = fs.readFileSync(file==='checkin-results.js' ? path.join(root,'checkin_results.js') : path.join(root,'public',file));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, asset+' bypasses the old cached URL without changing asset bytes');
    }
    const stale = await fetch(base + '/rule-cards.js');
    assert.equal(stale.headers.get('cf-cache-status'), 'HIT');assert.match(await stale.text(),/stale unversioned CDN/);
    fs.appendFileSync(path.join(root,'public/rule-cards.js'),'\n// changed deployed JavaScript\n');
    const changedScript = await versionedPage('/',cookie);
    assert.notEqual(changedScript.version,original.version,'a JavaScript update versions all dependent resources');
    fs.appendFileSync(path.join(root,'public/rule-cards.css'),'\n/* changed deployed CSS */\n');
    const changedStyle = await versionedPage('/',cookie);
    assert.notEqual(changedStyle.version,changedScript.version,'a CSS update changes resource URLs automatically');
    if (process.env.PLAYWRIGHT_MODULE) {
      const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
      browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page = await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}), errors=[];
      page.on('pageerror',error => errors.push(error.message));
      await page.context().addCookies([{name:cookie.slice(0,cookie.indexOf('=')),value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
      await page.route('**/api/accounts/chats/resolve',route => route.fulfill({contentType:'application/json',body:JSON.stringify({results:[]})}));
      const beforeBrowser = requestedAssets.length;
      await page.goto(base + '/#features');await page.locator('#open-red-packet').click();
      const card = page.locator('[data-red-packet-rule="cache_rule"]');
      assert.equal(await card.locator('.rule-card-footer').count(),0,'old footer is absent even behind a stale CDN');
      assert.equal(await card.locator('.automation-card-head [data-rule-logs]').count(),1);
      assert.equal(await card.locator('.automation-card-head [data-rule-save-status]').innerText(),'已保存');
      assert.equal(await card.locator('[data-red-packet-runtime] .rule-runtime-metrics').count(),1);
      await card.locator('[data-rule-toggle]').click();
      assert.equal(await card.locator('.packet-rule-fields').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
      assert.equal(await card.locator('.rule-card-body [data-rule-save]').isVisible(),true);
      assert.ok(requestedAssets.slice(beforeBrowser).every(asset => asset.includes('?v=')),'the real document never requests stale bare asset URLs');
      assert.deepEqual(errors,[]);
      if (process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'rule-cards-cdn-versioned.png'),fullPage:true});
    }
    console.log('Frontend assets PASS: stable content versions, JS/CSS updates change URLs, exact asset bytes, authentication and CDN no-store headers, stale CDN bypass'+(process.env.PLAYWRIGHT_MODULE ? ', real rule header/form rendering' : ' (browser skipped)'));
  } finally {
    await browser?.close();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    if (server) {const closed=new Promise(resolve => server.once('close',resolve));server.kill();await closed;}
    assert.ok(root.startsWith(tempBase + path.sep));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error => {console.error(error);process.exitCode=1;});
