const { authenticatePage } = require('./auth-support');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) { console.log('Run-log browser test skipped: set PLAYWRIGHT_MODULE'); return; }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-browser-'));
  let server, browser;
  try {
    for (const file of ['server.js','admin_auth.js','automation.js','login.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','run_history.js']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:['alpha','beta'].map(session=>({name:session,session,bots:['@example_bot']}))},ai:{providers:[]},automations:{schedules:[],forwards:[]}}));
    for (const session of ['alpha','beta']) fs.writeFileSync(path.join(root,session+'.session'),'offline fixture');
    fs.writeFileSync(path.join(root,'allinone.py'), 'import time,sys\nprint("fixture line 1",flush=True)\ntime.sleep(2.5)\nprint("fixture line 2",flush=True)\ntime.sleep(2.5)\nprint("fixture done",flush=True)\nsys.exit(1 if "beta" in sys.argv else 0)\n');
    const sock = net.createServer(); await new Promise(r=>sock.listen(0,'127.0.0.1',r)); const port = sock.address().port; await new Promise(r=>sock.close(r));
    const base = `http://127.0.0.1:${port}`;
    function launch() { server = spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),AUTOCHECKIN_DATA_DIR:root},stdio:'ignore'}); }
    async function ready() { for(let i=0;i<80;i++){try{if((await fetch(base+'/api/state')).ok)return;}catch{} await new Promise(r=>setTimeout(r,100));} throw Error('server not ready'); }
    launch(); await ready();
    browser = await chromium.launch({headless:true,args:['--no-sandbox']});
    const page = await browser.newPage({ timezoneId:'America/Los_Angeles' }); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await authenticatePage(page,base); await page.goto(base+'/#accounts');
    await page.locator('[data-run-account="0"]').click(); await page.locator('#run-log-dialog[open]').waitFor();
    assert.equal(new URL(page.url()).hash,'#accounts');
    await page.waitForFunction(()=>document.querySelector('#run-log-output').textContent.includes('fixture line 1'));
    await page.waitForFunction(()=>document.querySelector('#run-log-output').textContent.includes('fixture line 2'));
    await page.locator('#run-log-close').click();
    const first = await (await fetch(base+'/api/state')).json(); assert.equal(first.run.state,'running');
    await page.waitForFunction(()=>document.querySelector('#stat-status').textContent==='已完成');
    await page.locator('[data-run-account="1"]').click(); await page.locator('#run-log-dialog[open]').waitFor();
    await page.waitForFunction(()=>document.querySelector('#run-log-status').textContent.includes('运行失败'));
    assert.equal(await page.locator('#run-log-stop').isDisabled(),true);
    assert.match(await page.locator('#run-log-target').innerText(),/beta/);
    await page.locator('#run-log-close').click();
    await page.locator('[data-view="activity"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#log-console .log-line').length>=8);
    const allCount = await page.locator('#log-console .log-line').count();
    await page.selectOption('#log-filter-account','alpha');
    assert.match(await page.locator('#log-console').innerText(),/alpha/); assert.doesNotMatch(await page.locator('#log-console').innerText(),/beta/);
    await page.selectOption('#log-filter-status','failed'); assert.match(await page.locator('#log-console').innerText(),/没有符合/);
    await page.selectOption('#log-filter-account','beta'); assert.match(await page.locator('#log-console').innerText(),/fixture done/);
    await page.locator('#log-filters button[type="reset"]').click();
    await page.waitForFunction(count=>document.querySelectorAll('#log-console .log-line').length===count,allCount);
    const snapshot = await (await fetch(base+'/api/runs')).json();
    const line = snapshot.records[0].lines[0]; const bj = new Date(Date.parse(line.time)+28800000).toISOString();
    await page.fill('#log-filter-date',bj.slice(0,10));
    await page.fill('#log-filter-start',bj.slice(11,19)); await page.fill('#log-filter-end',bj.slice(11,19));
    assert.ok(await page.locator('#log-console .log-line').count()>=1);
    await page.locator('#log-filter-start').focus();
    await page.waitForTimeout(2300); assert.equal(await page.locator('#log-filter-start').inputValue(),bj.slice(11,19));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'log-filter-start');
    await page.fill('#log-filter-date','2000-01-01'); assert.match(await page.locator('#log-console').innerText(),/没有符合/);
    await page.locator('#log-filters button[type="reset"]').click();
    await page.locator('[data-view="overview"]').click(); await page.locator('#hero-run').click();
    await page.locator('#run-log-dialog[open]').waitFor(); assert.equal(new URL(page.url()).hash,'#overview');
    assert.match(await page.locator('#run-log-target').innerText(),/全部账号/);
    page.once('dialog',d=>d.dismiss()); await page.locator('#run-log-stop').click();
    assert.equal((await(await fetch(base+'/api/state')).json()).run.state,'running');
    page.once('dialog',d=>d.accept()); await page.locator('#run-log-stop').click();
    await page.waitForFunction(()=>document.querySelector('#run-log-status').textContent.includes('已停止'));
    await page.locator('#run-log-close').click(); await page.locator('[data-view="activity"]').click();
    await page.selectOption('#log-filter-account','__all__'); await page.selectOption('#log-filter-status','stopped');
    assert.match(await page.locator('#log-console').innerText(),/正在停止/);
    await page.close(); // Avoid old-session polling/navigation during server restart.
    server.kill(); await new Promise(r=>server.once('close',r)); server=null; require('./auth-support').resetAuth(base); launch(); await ready();
    const restored = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
    restored.on('pageerror', error => errors.push(error.message));
    await restored.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await authenticatePage(restored, base); await restored.goto(base + '/#activity');
    await restored.waitForFunction(()=>document.querySelectorAll('#log-console .log-line').length>0);
    assert.equal((await(await fetch(base+'/api/runs')).json()).records.length,3);
    assert.deepEqual(errors,[]);
    console.log('Real Chromium run-log PASS: account/global stay on page, live stream, close does not stop, confirmed stop, failure/completion, date/seconds/account/status/reset, focus preserved, non-Beijing browser, restart history');
  } finally {
    await browser?.close(); if(server){server.kill();await new Promise(r=>server.once('close',r));} fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
