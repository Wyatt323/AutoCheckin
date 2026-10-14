// Real authenticated API/browser; worker/network operations are offline fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'health-api-'));let server,browser;
  const stop=async()=>{if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;server=null;}};
  try {
    for(const file of ['server.js','health_monitor.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline-secret',users:['first','idle'].map(session=>({name:session,session,bot_groups:{button:[],command:[]}}))},ai:{providers:[]},automations:{redPackets:[{id:'health_red_rule',name:'红包任务',enabled:true,account:'first',groups:['-100123']} ]}}));
    for(const account of ['first','idle'])fs.writeFileSync(path.join(root,account+'.session'),'offline');
    fs.writeFileSync(path.join(root,'automation_worker.py'),`import json,time
print(json.dumps(dict(type='ready',message='offline listener')),flush=True)
while True:
    print(json.dumps(dict(type='health',source='automation',account='first',status='online',detail='offline fixture connected')),flush=True)
    print(json.dumps(dict(type='health',source='automation',status='running')),flush=True)
    time.sleep(1)
`);
    fs.writeFileSync(path.join(root,'health_worker.py'),`import sys,json,pathlib
account=sys.argv[-1]
p=pathlib.Path('probes.json')
rows=json.loads(p.read_text()) if p.exists() else []
rows.append(account);p.write_text(json.dumps(rows))
print(json.dumps(dict(type='health',source='probe',account=account,status='online',detail='offline account check')),flush=True)
`);
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',body,method=body===undefined ? 'GET' : 'POST')=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('health fixture timeout');};
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32' ? 'Scripts/python.exe' : 'bin/python')};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
      await wait(async()=>{try{return (await request('/api/auth/status')).ok;}catch{return false;}});
    };
    const login=async(name,password)=>{const response=await request('/api/auth/login','',{username:name,password});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    await start();let admin=await login('admin','offline-admin-secret');
    assert.equal((await request('/api/health')).status,401);
    const health=async cookie=>(await(await request('/api/health',cookie || admin)).json()).health;
    await wait(async()=>(await health()).accounts.find(row=>row.session==='first')?.status==='online');
    assert.equal((await health()).settings.enabled,false);
    assert.equal((await request('/api/health/check',admin,{})).status,202);
    await wait(async()=>(await health()).accounts.every(row=>row.status==='online'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'probes.json'))),['idle'],'never opens a second connection to the active listener Session');
    const settings={...(await health()).settings,enabled:true,alertsEnabled:false,intervalSeconds:60};
    assert.equal((await request('/api/health',admin,settings,'PUT')).status,200);
    assert.equal((await request('/api/health',admin,{...settings,graceSeconds:0},'PUT')).status,400);
    assert.ok(!JSON.stringify(await health()).includes('offline-secret'));
    const userResponse=await request('/api/users',admin,{username:'alice'});assert.equal(userResponse.status,201);
    const alice=await login('alice','a123456');assert.equal((await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'offline-alice-secret'})).status,200);
    assert.equal((await health(alice)).accounts.length,0);assert.equal((await health(alice)).settings.enabled,false,'monitor settings are user scoped');
    assert.equal((await request('/api/admin/health',alice)).status,403);
    const all=await(await request('/api/admin/health',admin)).json();assert.equal(all.workspaces.length,2);assert.equal(all.workspaces.find(row=>row.user.username==='alice').health.accounts.length,0);
    if(process.env.PLAYWRIGHT_MODULE) {
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base+'/#health');await page.locator('#health-accounts').filter({hasText:'first'}).waitFor();
      assert.equal(await page.locator('#health-account-count').innerText(),'2');
      assert.equal(await page.locator('#health-enabled').isChecked(),true);
      assert.ok((await page.locator('#health-scope-field .ui-select-trigger').count())>0,'themed scope dropdown');
      await page.locator('#health-alertCooldownMinutes').fill('45');await page.waitForTimeout(3200);assert.equal(await page.locator('#health-alertCooldownMinutes').inputValue(),'45','status polling preserves drafts');
      await page.locator('#health-settings-form [type="submit"]').click();await page.locator('#toast').filter({hasText:'健康监控设置已保存'}).waitFor();assert.equal((await health()).settings.alertCooldownMinutes,45);
      const shot=async name=>{if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,name+'.png'),fullPage:true});};
      await shot('health-desktop');
      for(const width of [1024,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`health fits ${width}px`);if(width===390)await shot('health-mobile');}
      await page.setViewportSize({width:1440,height:1100});await page.locator('#health-scope').selectOption('all');await page.locator('#health-summary').filter({hasText:'2 个用户'}).waitFor();assert.equal(await page.locator('#health-settings-panel').isVisible(),false);assert.ok((await page.locator('#health-accounts').innerText()).includes('admin'));
      await page.context().clearCookies();await page.context().addCookies([{name:'ac_session',value:alice.slice(alice.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);await page.reload();await page.locator('#health-summary').filter({hasText:'定期检查未启用'}).waitFor();assert.equal(await page.locator('#health-scope-field').isVisible(),false);assert.equal(await page.locator('#health-account-count').innerText(),'0');
      assert.deepEqual(errors,[]);
    }
    await stop();await start();admin=await login('admin','offline-admin-secret');assert.equal((await health()).settings.alertCooldownMinutes,process.env.PLAYWRIGHT_MODULE ? 45 : 30);
    assert.equal((await health()).settings.enabled,true);
    console.log('Health API/UI PASS: authentication, tenant/admin scope, Session ownership, manual check, validation, durable settings, themed controls, polling drafts, responsive layout');
  }finally{await browser?.close();await stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
