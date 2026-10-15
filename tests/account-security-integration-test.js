// Authenticated real API/UI with offline workers. No Telegram or internet requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'security-api-'));let server,browser;
  const stop=async()=>{if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;server=null;}};
  const wait=async predicate=>{for(let i=0;i<150;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('security fixture timeout');};
  try {
    for(const file of ['server.js','account_security.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','health_monitor.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline-api-secret',users:['live','idle'].map(session=>({name:session,session,bot_groups:{button:[],command:[]}}))},ai:{providers:[]},automations:{redPackets:[{id:'security_red_rule',enabled:true,account:'live',groups:['-100123']}]}}));
    for(const account of ['live','idle'])fs.writeFileSync(path.join(root,account+'.session'),'fake offline session');
    const fixture=`import json,os,sys,time
from pathlib import Path
root=Path(__file__).parent
def operate(account,command,mode):
    for _ in range(200):
        if not (root/'hold-security').exists():break
        time.sleep(0.02)
    path=root/(account+'-devices.json')
    devices=json.loads(path.read_text()) if path.exists() else [dict(hash='0',current=True,device='AutoCheckin',app='AutoCheckin',ip='192.0.2.1'),dict(hash='9123456789012345678',current=False,device='Offline phone',app='Telegram',country='Example',ip='192.0.2.2')]
    with (root/'operations.jsonl').open('a') as handle:handle.write(json.dumps(dict(account=account,mode=mode,action=command['action']))+'\\n')
    if command['action'].startswith('spam_'):
        return dict(status='reachable',detail='Offline official SpamBot reply',spam=dict(status='limited',reply='Your account is currently limited.',appealState='submitted' if command['action']=='spam_appeal' else 'none',logs=['Offline SpamBot step']))
    if command['action']=='terminate':devices=[d for d in devices if d['hash']!=command['hash']]
    path.write_text(json.dumps(devices))
    return dict(status='reachable',detail='Offline safety inspection',userId='123',twoFactor=account=='idle',recoveryEmail=False,devices=devices,terminated=command['action']=='terminate')
`;
    fs.writeFileSync(path.join(root,'offline_security.py'),fixture);
    fs.writeFileSync(path.join(root,'automation_worker.py'),`from offline_security import *
print(json.dumps(dict(type='ready',securityAccounts=['live'],checkinAccounts=[])),flush=True)
for line in sys.stdin:
    command=json.loads(line)
    if command['type']=='account_security':print(json.dumps(dict(type='account_security',requestId=command['id'],account=command['account'],result=operate(command['account'],command,'shared'))),flush=True)
`);
    fs.writeFileSync(path.join(root,'account_security_worker.py'),`from offline_security import *
print(json.dumps(dict(type='account_security',result=operate(sys.argv[-1],json.loads(sys.stdin.readline()),'standalone'))),flush=True)
`);
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',input,method=input===undefined?'GET':'POST')=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),PYTHONIOENCODING:'utf-8'};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD'])delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
      await wait(async()=>{try{return (await request('/api/auth/status')).ok;}catch{return false;}});
    };
    const login=async(username,password)=>{const response=await request('/api/auth/login','',{username,password});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    await start();let admin=await login('admin','offline-admin-secret');
    const security=async cookie=>(await(await request('/api/account-security',cookie || admin)).json()).security;
    assert.equal((await request('/api/account-security')).status,401);
    assert.equal((await request('/api/features/spam')).status,401);
    assert.equal((await security()).settings.enabled,false);
    assert.equal((await request('/account-security.js',admin)).status,200);
    assert.equal((await request('/api/account-security/check',admin,{account:'foreign'})).status,400);
    await wait(async()=>(await(await request('/api/state',admin)).json()).automation.status==='running');
    for(const account of ['live','idle']){
      fs.writeFileSync(path.join(root,'hold-security'),'hold');
      assert.equal((await request('/api/account-security/check',admin,{account})).status,202);
      const busyState=await(await request('/api/state',admin)).json();
      assert.ok(busyState.busyAccounts.includes(account));
      assert.ok(busyState.securityBusyAccounts.includes(account),'security has its own activity label');
      assert.equal((await request('/api/run',admin,{account})).status,400,'a sign-in cannot open the Session during inspection');
      fs.unlinkSync(path.join(root,'hold-security'));
      await wait(async()=>{const view=await security();return !view.checking && view.accounts.find(row=>row.account===account).lastSuccessAt;});
    }
    const operations=fs.readFileSync(path.join(root,'operations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(operations.map(row=>[row.account,row.mode]),[['live','shared'],['idle','standalone']]);
    let view=await security(),row=view.accounts[0];
    assert.equal(row.twoFactor,false);assert.equal(view.accounts[1].twoFactor,true);
    assert.ok(!JSON.stringify(view).includes('9123456789012345678'));
    assert.ok(!JSON.stringify(view).includes('offline-api-secret'));
    assert.equal((await request('/api/account-security/check',admin,{account:'live'})).status,400,'manual check cannot bypass cooldown');
    assert.equal((await request('/api/account-security/terminate',admin,{account:'live',deviceId:row.devices[1].id})).status,400,'revocation requires explicit confirmation');
    assert.equal((await request('/api/account-security/terminate',admin,{account:'live',deviceId:row.devices[0].id,confirm:true})).status,400,'server protects the current authorization');
    assert.equal(fs.readFileSync(path.join(root,'operations.jsonl'),'utf8').trim().split('\n').length,2);
    const original=(await(await request('/api/state',admin)).json()).config;
    const created=await request('/api/users',admin,{username:'alice'});assert.equal(created.status,201);
    const alice=await login('alice','a123456');assert.equal((await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'offline-alice-secret'})).status,200);
    assert.equal((await security(alice)).accounts.length,0);assert.equal((await security(alice)).events.length,0);
    assert.equal((await request('/api/account-security/trust',alice,{account:'live',deviceId:row.devices[1].id})).status,400);
    const spamRule={id:'offline_spam_rule',name:'Offline appeal',account:'idle',appealText:'Please review this account restriction. Thank you.'};
    assert.equal((await request('/api/features/spam',admin,spamRule,'PUT')).status,200);
    assert.equal((await request('/api/features/spam/run',admin,{ruleId:spamRule.id,mode:'appeal',confirm:true})).status,400,'appeals require an explicit declaration');
    assert.equal((await request('/api/features/spam/run',alice,{ruleId:spamRule.id,mode:'appeal',confirm:true,pledge:true})).status,400,'a tenant cannot execute another tenant rule');
    assert.equal((await(await request('/api/features/spam',alice)).json()).spam.rules.length,0);
    assert.equal((await request('/api/features/spam/run',admin,{account:'live',mode:'check'})).status,202);
    await wait(async()=>(await security()).accounts[0].spam.status==='limited');
    if(process.env.PLAYWRIGHT_MODULE){
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
      await page.goto(base+'/#accounts');
      assert.equal(await page.locator('.nav-item[data-view="security"]').count(),0,'protection is an account menu, not a global menu');
      await page.locator('[data-open-account="0"][data-section="security"]').click();await page.locator('#security-accounts tr').filter({hasText:'live'}).waitFor();
      assert.equal(await page.locator('#security-accounts tr').count(),1,'protection only shows the selected account');
      assert.equal(await page.locator('#security-devices [data-security-terminate]').count(),1);
      assert.match(await page.locator('#security-devices').innerText(),/当前会话受保护/);
      await page.locator('[data-security-trust]').click();await page.getByRole('dialog',{name:'确认本人设备'}).getByRole('button',{name:'是我的设备'}).click();
      await page.locator('#security-devices').filter({hasText:'已确认为本人设备'}).waitFor();
      await page.locator('[data-security-terminate]').click();await page.getByRole('dialog',{name:'下线登录设备'}).getByRole('button',{name:'取消',exact:true}).click();
      assert.equal((await security()).accounts[0].devices.length,2);
      await page.locator('[data-security-terminate]').click();await page.getByRole('dialog',{name:'下线登录设备'}).getByRole('button',{name:'确认下线'}).click();
      await page.locator('#toast').filter({hasText:'设备已下线'}).waitFor();
      assert.equal((await security()).accounts[0].devices.length,1);
      await page.evaluate(()=>openAccount(1,'security'));await page.waitForTimeout(3200);
      assert.equal(await page.locator('#security-account').inputValue(),'idle','polling preserves account selection');
      await page.locator('#security-enabled').check();await page.locator('#security-intervalMinutes').fill('90');
      await page.locator('#security-settings-form [type="submit"]').click();await page.locator('#toast').filter({hasText:'账号防护设置已保存'}).waitFor();
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`account protection fits ${width}`);
        if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR && width!==320)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,`account-security-${width}.png`),fullPage:true});
      }
      await page.reload();await page.locator('#security-intervalMinutes').filter({visible:true}).waitFor();await page.waitForFunction(()=>document.querySelector('#security-intervalMinutes').value==='90');
      const own=(await security()).accounts;assert.equal(own[0].settings.enabled,false);assert.equal(own[1].settings.enabled,true);
      await page.locator('#account-back').click();await page.locator('[data-restriction-account="live"]').filter({hasText:'双向受限'}).waitFor();
      await page.locator('.nav-item[data-view="features"]').click();await page.locator('#open-spam').click();await page.locator('[data-spam-rule]').waitFor();
      const card=page.locator('[data-spam-rule="offline_spam_rule"]');
      assert.equal(await card.getAttribute('data-expanded'),'false','saved Spam rules begin folded');
      await card.locator('[data-spam-toggle]').click();await card.locator('[data-spam-field="name"]').fill('账号误封申诉');
      await card.locator('[data-spam-save]').click();await page.locator('#toast').filter({hasText:'Spam 规则已保存'}).waitFor();
      assert.equal(await card.getAttribute('data-expanded'),'false');
      const count=()=>fs.readFileSync(path.join(root,'operations.jsonl'),'utf8').trim().split('\n').length;
      const before=count();await card.locator('[data-spam-submit]').click();await page.getByRole('dialog',{name:'确认提交误封申诉'}).getByRole('button',{name:'取消',exact:true}).click();assert.equal(count(),before);
      await card.locator('[data-spam-submit]').click();await page.getByRole('dialog',{name:'确认提交误封申诉'}).getByRole('button',{name:'确认声明并提交'}).click();
      await card.locator('[data-spam-runtime]').filter({hasText:'官方已受理'}).waitFor();
      assert.match(await card.locator('[data-spam-runtime]').innerText(),/双向受限/);
      assert.ok(await card.locator('[data-spam-log-content]').isVisible(),'each rule contains its own account logs');
      assert.ok(await card.locator('[data-spam-submit]').isDisabled(),'repeat submissions are blocked by durable cooldown');
      for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Spam plugin fits ${width}`);if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR && width!==320)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,`spam-plugin-${width}.png`),fullPage:true});}
      assert.deepEqual(errors,[]);await browser.close();browser=null;
    }else {
      assert.equal((await request('/api/account-security/trust',admin,{account:'live',deviceId:row.devices[1].id})).status,200);
      assert.equal((await request('/api/account-security/terminate',admin,{account:'live',deviceId:row.devices[1].id,confirm:true})).status,200);
    }
    assert.deepEqual((await(await request('/api/state',admin)).json()).config,original,'security never changes plugin/account configuration');
    const expected=await security();await stop();await start();admin=await login('admin','offline-admin-secret');view=await security();
    assert.equal(view.accounts[0].devices.length,1);assert.equal(view.events.length,expected.events.length);assert.equal(view.settings.intervalMinutes,expected.settings.intervalMinutes);
    assert.equal(view.accounts[0].spam.status,'limited');assert.equal((await(await request('/api/features/spam',admin)).json()).spam.rules.length,1);
    console.log('Account security/Spam API/UI PASS: account-scoped navigation/settings, tenant isolation, shared/idle Session ownership, current-device guard, status badges, appeal confirmation/cooldown, rule logs, persistence and responsive UI');
  }finally{await browser?.close();await stop();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
