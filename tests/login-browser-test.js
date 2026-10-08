const { authenticatePage } = require('./auth-support');
// Optional real-browser offline integration: PLAYWRIGHT_MODULE=/path/to/playwright.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), net=require('node:net');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
  if (!process.env.PLAYWRIGHT_MODULE) {console.log('Browser integration skipped: set PLAYWRIGHT_MODULE to run'); return;}
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'login-browser-'));
  let server,browser;
  try {
    for(const file of ['database.js', 'account_profiles.js','server.js','admin_auth.js','user_auth.js','system_settings.js','telegram_notifications.js','checkin_results.js','automation.js','login.js','schedule_time.js', 'run_history.js', 'checkin_scheduler.js','telegram_credentials.js']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.copyFileSync(path.join(__dirname,'fixtures/login_worker.py'),path.join(root,'login_worker.py'));
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'global-offline-hash',users:['offline','cancel'].map(session=>({name:session,session,...(session==='cancel'?{api_id:123,api_hash:'offline-hash'}:{}),bots:[]}))},ai:{providers:[]},automations:{schedules:[],forwards:[]}}));
    const sock=net.createServer(); await new Promise(r=>sock.listen(0,'127.0.0.1',r)); const port=sock.address().port; await new Promise(r=>sock.close(r));
    const base=`http://127.0.0.1:${port}`;
    server=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),AUTOCHECKIN_DATA_DIR:root},stdio:'ignore'});
    for(let i=0;i<50;i++){try {if((await fetch(base+'/api/state')).ok) break;}catch{} await new Promise(r=>setTimeout(r,100));}
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await authenticatePage(page, base); await page.goto(base+'/#accounts'); await page.locator('[data-login-account="0"]').click();
    await page.locator('#login-qr:not([hidden])').waitFor();
    await page.waitForFunction(()=>document.querySelector('#login-qr').naturalWidth>0);
    let status=await (await fetch(base+'/api/login/status')).json(); assert.equal(status.login.active,true);
    const post=(url,data)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await post('/api/run',{})).status,400);
    assert.equal((await post('/api/config',{})).status,400);
    assert.equal((await post('/api/automation/restart',{})).status,400);
    assert.equal((await fetch(base+'/api/login/status')).headers.get('cache-control'),'no-store');
    await page.reload(); await page.locator('#login-dialog[open]').waitFor();
    await page.locator('#login-password-form:not([hidden])').waitFor();
    await page.fill('#login-password','wrong'); await page.locator('#login-password-form button').click();
    await page.waitForFunction(()=>document.querySelector('#login-status').textContent.includes('密码错误'));
    await page.fill('#login-password','offline-password'); await page.locator('#login-password-form button').click();
    await page.waitForFunction(()=>document.querySelector('#login-status').textContent.includes('登录成功'));
    await page.waitForFunction(()=>!document.querySelector('#login-dialog').open);
    assert.equal(await page.locator('#login-password').inputValue(), '');
    assert.equal(await page.locator('#login-qr').getAttribute('src'), null);
    await page.waitForFunction(()=>document.querySelector('[data-account-index="0"] .account-health').textContent.includes('正常'));
    await page.locator('[data-login-account="1"]').click(); await page.locator('#login-qr:not([hidden])').waitFor();
    await page.locator('#login-cancel').click();
    for(let i=0;i<40;i++){status=await(await fetch(base+'/api/login/status')).json(); if(!status.login.active)break; await new Promise(r=>setTimeout(r,100));}
    assert.equal(status.login.state,'cancelled'); assert.equal(status.login.active,false); assert.equal(status.login.png,undefined);
    await page.waitForFunction(()=>!document.querySelector('[data-login-account="1"]').disabled);
    await page.locator('[data-login-account="1"]').click(); await page.locator('#login-qr:not([hidden])').waitFor();
    await page.locator('#login-cancel').click();
    await page.waitForFunction(()=>!document.querySelector('[data-login-account="1"]').disabled);
    await page.locator('[data-open-account="1"][data-section="settings"]').first().click();
    await page.locator('[data-delete="user"]').click();
    assert.equal(await page.locator('#account-editor .account-card').count(),0, 'removed editor must not survive deletion');
    await page.evaluate(()=>readEditors());
    await page.locator('#add-account').click();
    await page.locator('[data-delete="user"]').click();
    await page.locator('[data-open-account="0"][data-section="settings"]').first().click();
    await page.locator('[data-delete="user"]').click();
    await page.evaluate(()=>readEditors());
    assert.equal(await page.locator('.account-tile').count(),0);
    server.kill(); await new Promise(r=>server.once('close',r)); server=null;
    assert.deepEqual(errors,[]); console.log('Real Chromium offline integration PASS: PNG loaded, reload, wrong/correct 2FA, session refresh, cancel, API locks');
  } finally {
    await browser?.close(); if(server){server.kill(); await new Promise(r=>server.once('close',r));} fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
