// Isolated server + fake workers; never sends Telegram messages or changes real memberships.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  const tempBase=path.resolve(process.env.AUTOCHECKIN_TEST_TMPDIR || os.tmpdir());
  const root=fs.mkdtempSync(path.join(tempBase,'group-cleanup-'));
  let server,browser;
  const stop=async()=>{if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;server=null;}};
  try {
    for(const file of ['server.js','cleanup.js','user_auth.js','system_settings.js','telegram_notifications.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:['admin_account','second_account'].map(session=>({name:session==='admin_account' ? '管理员TG' : '第二个TG账号',session,bot_groups:{button:[],command:[]}}))},ai:{providers:[]},automations:{schedules:[],forwards:[]}}));
    fs.writeFileSync(path.join(root,'admin_account.session'),'fake');
    fs.writeFileSync(path.join(root,'second_account.session'),'fake');
    fs.writeFileSync(path.join(root,'cleanup_worker.py'),`import os,sys,json,time,threading
from pathlib import Path
root=Path(os.environ['AUTOCHECKIN_DATA_DIR'])/'.cleanup-jobs'
job_id=sys.argv[sys.argv.index('--job')+1]
job=json.loads((root/(job_id+'.json')).read_text(encoding='utf-8'))
(root/(job_id+'.xlsx')).write_bytes(b'PK offline xlsx fixture')
job.update(phase='awaiting_confirmation',total=10,zeroCount=3,eligibleCount=2,reportReady=True)
(root/(job_id+'.json')).write_text(json.dumps(job),encoding='utf-8')
print(json.dumps(dict(type='log',message='正在查看0发言人数')),flush=True)
print(json.dumps(dict(type='cleanup_progress',progress=dict(phase='awaiting_confirmation',total=10,zeroCount=3,eligibleCount=2,reportReady=True))),flush=True)
control=root/(job_id+'.answer')
stopped=threading.Event()
def watch_parent():
    while os.read(sys.stdin.fileno(),1):
        pass
    stopped.set()
threading.Thread(target=watch_parent,daemon=True).start()
for _ in range(900):
    if stopped.is_set():break
    if control.exists():
        phase='cancelled' if control.read_text()=='no' else 'completed'
        job['phase']=phase
        (root/(job_id+'.json')).write_text(json.dumps(job),encoding='utf-8')
        print(json.dumps(dict(type='log',message='已取消本次清理任务' if phase=='cancelled' else '本次清理完成')),flush=True)
        print(json.dumps(dict(type='cleanup_result',state=phase)),flush=True)
        break
    time.sleep(.1)
`);
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',input)=>fetch(base+url,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const wait=async predicate=>{for(let i=0;i<100;i++){try{const result=await predicate();if(result)return result;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('cleanup test timeout');};
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});await wait(async()=>(await request('/api/auth/status')).ok);
    };
    const login=async(name,password)=>{const response=await request('/api/auth/login','',{username:name,password});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    const state=async cookie=>(await(await request('/api/state',cookie)).json());
    const runs=async cookie=>(await(await request('/api/features/zero-speakers',cookie)).json()).runs;
    const awaitPrompt=async cookie=>wait(async()=>{const values=await runs(cookie);return values.find(run=>run.state==='running' && run.featureProgress.phase==='awaiting_confirmation');});
    await start();let admin=await login('admin','offline-admin-secret');
    let adminConfig=(await state(admin)).config;assert.deepEqual(adminConfig.plugins.zeroSpeakers,[]);
    adminConfig.plugins.zeroSpeakers=[{id:'cleanup_admin_001',name:'群成员检测',account:'admin_account',group:'https://t.me/example_group'}, {id:'cleanup_admin_002',name:'第二个群组检测',account:'second_account',group:'@second_group'}];
    assert.equal((await request('/api/config',admin,adminConfig)).status,200);
    adminConfig=(await state(admin)).config;assert.equal(adminConfig.plugins.zeroSpeakers[0].group,'@example_group');
    for(const mutate of [rule=>rule.account='foreign',rule=>rule.group='https://evil.invalid/group',rule=>rule.id='../../bad']) {
      const invalid=structuredClone(adminConfig);mutate(invalid.plugins.zeroSpeakers[0]);assert.equal((await request('/api/config',admin,invalid)).status,400);
    }
    const tenants=[];
    for(const name of ['alice','bob']) {
      const created=await request('/api/users',admin,{username:name});assert.equal(created.status,201);const {user}=await created.json();
      const cookie=await login(name,'a123456');assert.equal((await request('/api/auth/password',cookie,{currentPassword:'a123456',newPassword:name+'-secret'})).status,200);
      const directory=path.join(root,'.user-workspaces',user.id);fs.writeFileSync(path.join(directory,'shared.session'),'fake');
      const config=(await state(cookie)).config;config.telegram={apiId:'123',apiHash:'offline'};
      config.users=[{name,session:'shared',sourceIndex:-1,useGlobalCredentials:true,bots:[],checkinSchedules:[]}];
      config.plugins.zeroSpeakers=[{id:'cleanup_rule_001',name,account:'shared',group:'@example_group'}];
      assert.equal((await request('/api/config',cookie,config)).status,200);
      assert.equal((await request('/api/features/zero-speakers/run',cookie,{ruleId:'cleanup_rule_001'})).status,202);
      tenants.push({name,cookie,directory,run:await awaitPrompt(cookie)});
    }
    for(const tenant of tenants) {
      const other=tenants.find(item=>item!==tenant), run=tenant.run;
      assert.equal((await state(tenant.cookie)).busyAccounts[0],'shared');
      assert.equal((await request('/api/features/zero-speakers/run',tenant.cookie,{ruleId:'cleanup_rule_001'})).status,400);
      assert.equal((await request('/api/run',tenant.cookie,{account:'shared'})).status,400);
      assert.equal((await request('/api/features/zero-speakers/stop',other.cookie,{id:run.id})).status,400);
      assert.equal((await request('/api/features/zero-speakers/report?id='+run.id,other.cookie)).status,400);
      const report=await request('/api/features/zero-speakers/report?id='+run.id,tenant.cookie);assert.equal(report.status,200);assert.match(report.headers.get('content-type'),/spreadsheetml/);assert.match(await report.text(),/^PK/);
      const records=(await(await request('/api/runs?category=plugin&account=shared',tenant.cookie)).json()).records;
      assert.equal(records.length,1);assert.equal(records[0].plugin,'zeroSpeakers');assert.ok(!JSON.stringify(records).includes(other.run.id));
      fs.writeFileSync(path.join(tenant.directory,'.cleanup-jobs',run.id+'.answer'),'no');
    }
    await wait(async()=>(await Promise.all(tenants.map(t=>runs(t.cookie)))).every(items=>items[0].state==='cancelled'));
    assert.equal((await state(tenants[0].cookie)).busyAccounts.length,0);
    if(process.env.PLAYWRIGHT_MODULE) {
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>{
        if(!route.request().url().startsWith(base))return route.abort();
        if(new URL(route.request().url()).pathname==='/api/accounts/chats/resolve') {const {peers}=route.request().postDataJSON();return route.fulfill({contentType:'application/json',body:JSON.stringify({results:peers.map(value=>({value,status:'ok',title:'测试交流群',id:'-100123',type:'group'}))})});}
        return route.continue();
      });
      await page.goto(base+'/#features');assert.equal(await page.locator('.feature-plugin-card').count(),2);
      await page.locator('#open-zero-speakers').click();const card=page.locator('[data-cleanup-rule="cleanup_admin_001"]');
      await card.locator('[data-feature-peer-name]').filter({hasText:'测试交流群'}).waitFor();
      assert.equal(await card.locator('.ui-select-trigger').count(),1);
      await card.locator('[data-cleanup-field="name"]').fill('测试成员清理');await page.waitForTimeout(2200);
      assert.equal(await card.locator('[data-cleanup-field="name"]').inputValue(),'测试成员清理');
      await card.locator('[data-cleanup-run]').click();await card.locator('[data-cleanup-runtime]').filter({hasText:'等待执行账号'}).waitFor();
      assert.equal((await state(admin)).config.plugins.zeroSpeakers[0].name,'测试成员清理');
      const otherCard=page.locator('[data-cleanup-rule="cleanup_admin_002"]');
      await otherCard.locator('[data-cleanup-run]').click();await otherCard.locator('[data-cleanup-runtime]').filter({hasText:'等待执行账号'}).waitFor();
      assert.deepEqual((await state(admin)).busyAccounts.sort(),['admin_account','second_account'],'saved rules on separate accounts start concurrently from the page');
      const secondActive=(await runs(admin)).find(run=>run.ruleId==='cleanup_admin_002' && run.state==='running');
      await request('/api/features/zero-speakers/stop',admin,{id:secondActive.id});await page.reload();await page.locator('#open-zero-speakers').click();
      await card.locator('[data-cleanup-runtime]').filter({hasText:'等待执行账号'}).waitFor();
      await card.locator('[data-cleanup-log]').click();await page.locator('#run-log-output').filter({hasText:'正在查看0发言人数'}).waitFor();await page.locator('#run-log-close').click();
      for(const width of [1440,1024,390,320]) {await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`cleanup fits ${width}px`);}
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) {
        await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('show'));
        await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'zero-speakers-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:1000});await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'zero-speakers-mobile.png'),fullPage:true});
      }
      const active=await awaitPrompt(admin);
      await card.locator('[data-cleanup-stop]').click();await page.getByRole('dialog',{name:'停止清理任务'}).getByRole('button',{name:'停止任务'}).click();
      await wait(async()=>(await runs(admin)).find(run=>run.id===active.id)?.state==='stopped');
      assert.equal((await state(admin)).busyAccounts.length,0);assert.deepEqual(errors,[]);
      await browser.close();browser=null;
    }
    // A restart interrupts an unconfirmed run and cannot resume destructive work.
    const response=await request('/api/features/zero-speakers/run',admin,{ruleId:'cleanup_admin_001'});assert.equal(response.status,202);const interrupted=await awaitPrompt(admin);
    await stop();await start();admin=await login('admin','offline-admin-secret');
    const restored=(await runs(admin)).find(run=>run.id===interrupted.id);assert.equal(restored.state,'failed');assert.ok(restored.lines.some(line=>line.text.includes('服务重启')));
    assert.equal((await state(admin)).busyAccounts.length,0);assert.equal((await state(admin)).config.plugins.zeroSpeakers[0].id,'cleanup_admin_001');
    assert.equal((await request('/api/features/zero-speakers/report?id='+interrupted.id,admin)).status,200);
    for(const tenant of tenants){tenant.cookie=await login(tenant.name,tenant.name+'-secret');assert.equal((await runs(tenant.cookie))[0].state,'cancelled');}
    console.log('Group cleanup PASS: persisted config/report/history, account reservation, tenant isolation, explicit run/stop, restart does not resume cleanup'+(process.env.PLAYWRIGHT_MODULE ? ', themed desktop/mobile controls, live progress, logs and save/start flow' : ' (browser skipped)'));
  }finally{await browser?.close();await stop();assert.ok(root.startsWith(tempBase+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
