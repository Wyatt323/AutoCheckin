// Real local server and fake workers; never contacts Telegram.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {createUserAuth} = require('../user_auth');
const {scopedStore} = require('../database');
(async()=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'multi-user-'));
  let server, browser;
  const baseFiles = ['server.js','user_auth.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'];
  const stop = async()=>{if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;server=null;}};
  try {
    // Exercise the same registry and prefix wrapper used with PostgreSQL.
    const docs = new Map();
    const store = {read:key=>docs.get(key),write:async(key,value)=>docs.set(key,structuredClone(value)),refresh:async key=>docs.get(key),keys:()=>[...docs.keys()]};
    let auth = await createUserAuth({dataDir:root,store,password:'admin-secret'});
    const created = await auth.add('stored_user');
    assert.ok(!JSON.stringify(created).includes('hash'));
    assert.ok(!JSON.stringify(docs.get('web-users')).includes('a123456'));
    auth = await createUserAuth({dataDir:root,store,password:'admin-secret'});
    assert.equal(auth.list()[0].id,created.id,'user registry persists through store reload');
    const firstStore = scopedStore(store,'tenant:first:');
    const secondStore = scopedStore(store,'tenant:second:');
    await firstStore.write('config',{only:'first'}); await secondStore.write('config',{only:'second'});
    assert.equal(firstStore.read('config').only,'first'); assert.equal(secondStore.read('config').only,'second');
    assert.deepEqual(firstStore.keys(),['config']);
    let failWrite = false;
    const failingAuth = await createUserAuth({dataDir:root,store:{...store,write:async(...args)=>{if(failWrite)throw Error('injected write failure');return store.write(...args);}},password:'admin-secret'});
    failWrite=true; await assert.rejects(failingAuth.add('not_committed'),/write failure/);
    assert.ok(!failingAuth.list().some(user=>user.username==='not_committed'),'failed persistent write does not add usable user');

    for(const file of baseFiles) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    const original={telegram:{api_id:123,api_hash:'admin-only',users:[{name:'legacy',session:'legacy',bot_groups:{button:[],command:[]}}]},ai:{providers:[]},automations:{schedules:[],forwards:[]}};
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(original));
    fs.writeFileSync(path.join(root,'allinone.py'),`import os,time,json
print(json.dumps(dict(type='checkin_log',account='shared',text=os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX','ADMIN'))),flush=True)
time.sleep(3)
print(json.dumps(dict(type='account_result',account='shared',state='completed')),flush=True)
`);
    fs.writeFileSync(path.join(root,'automation_worker.py'),`import os,time,json
print(json.dumps(dict(type='log',category='message',account='shared',state='completed',message=os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX','ADMIN'))),flush=True)
print(json.dumps(dict(type='ready')),flush=True)
time.sleep(60)
`);
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const start=async()=>{
      const env={...process.env,ADMIN_PASSWORD:'admin-secret',ADMIN_USERNAME:'admin',PORT:String(port),AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),PYTHONIOENCODING:'utf-8'};
      for(const key of ['DATABASE_URL','PGHOST']) delete env[key];
      let output='';
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:['ignore','pipe','pipe']});
      server.stdout.on('data',chunk=>output+=chunk); server.stderr.on('data',chunk=>output+=chunk);
      for(let i=0;i<100;i++){try{if((await fetch(base+'/api/auth/status')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error('multi-user server failed: '+output);
    };
    const request=(url,cookie='',input)=>fetch(base+url,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)}),redirect:'manual'});
    const login=async(username,password)=>{
      const response=await request('/api/auth/login','',{username,password});
      assert.equal(response.status,200,await response.clone().text());
      return response.headers.get('set-cookie').split(';')[0];
    };
    const state=async cookie=>(await(await request('/api/state',cookie)).json());
    const waitFor=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,60));}throw Error('fixture state timeout');};
    await start();
    let admin=await login('admin','admin-secret');
    for(const username of ['alice','bob']) assert.equal((await request('/api/users',admin,{username})).status,201);
    assert.equal((await request('/api/users',admin,{username:'ALICE'})).status,400);
    const users=(await(await request('/api/users',admin)).json()).users;
    let alice=await login('alice','a123456'),bob=await login('bob','a123456');
    for(const url of ['/api/state','/api/runs','/api/login/status','/api/users']) assert.equal((await request(url,alice)).status,403,url);
    assert.equal((await request('/',alice)).headers.get('location'),'/password');
    assert.equal((await request('/api/auth/password',alice,{currentPassword:'wrong',newPassword:'alice-secret'})).status,400);
    assert.equal((await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'a123456'})).status,400);
    const oldAlice=await login('alice','a123456');
    assert.equal((await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'alice-secret'})).status,200);
    assert.equal((await request('/api/state',oldAlice)).status,401,'password change invalidates other browser sessions');
    assert.equal((await request('/api/auth/password',bob,{currentPassword:'a123456',newPassword:'bob-secret'})).status,200);
    assert.equal((await request('/api/users',alice)).status,403);
    assert.equal((await request('/api/users',alice,{username:'intruder'})).status,403);
    assert.equal((await state(alice)).config.users.length,0,'new users do not inherit admin Telegram accounts');
    assert.equal((await state(alice)).config.telegram.hasApiHash,false,'new users do not inherit admin API secret');
    assert.equal((await state(admin)).config.users[0].session,'legacy','legacy data stays with administrator');
    const userDir=username=>path.join(root,'.user-workspaces',users.find(user=>user.username===username).id);
    for(const [name,cookie] of [['alice',alice],['bob',bob]]) {
      const config=(await state(cookie)).config;
      config.telegram={apiId:'123',apiHash:`${name}-only`};
      config.users=[{name,session:'shared',sourceIndex:-1,useGlobalCredentials:true,bots:[{name:'@example_bot',mode:'command',command:'/sign'}],checkinSchedules:[]}];
      config.automations={schedules:[{id:'same_rule_001',account:'shared',enabled:true,target:'@example_bot',repeat:'daily',time:'09:00',message:name}],forwards:[]};
      fs.writeFileSync(path.join(userDir(name),'shared.session'),'fake session');
      assert.equal((await request('/api/config',cookie,config)).status,200);
    }
    await waitFor(async()=>((await(await request('/api/runs',alice)).json()).records.length>0));
    const aliceId=users.find(user=>user.username==='alice').id,bobId=users.find(user=>user.username==='bob').id;
    assert.ok(JSON.stringify((await(await request('/api/runs',alice)).json())).includes(aliceId));
    assert.ok(!JSON.stringify((await(await request('/api/runs',alice)).json())).includes(bobId));
    assert.equal((await request('/api/accounts/avatar?account=legacy',alice)).status,404);
    assert.equal((await request('/api/run',alice,{account:'legacy'})).status,400);
    const startedAlice=await request('/api/run',alice,{account:'shared'});
    const runAlice=(await startedAlice.json()).run; assert.equal(startedAlice.status,200);
    const startedBob=await request('/api/run',bob,{account:'shared'});
    const runBob=(await startedBob.json()).run; assert.equal(startedBob.status,200,'different users may execute concurrently');
    assert.notEqual(runAlice.id,runBob.id);
    assert.equal((await request('/api/stop',bob,{id:runAlice.id})).status,400,'other user run id cannot stop a task');
    await waitFor(async()=>(await state(alice)).run.state==='completed' && (await state(bob)).run.state==='completed');
    assert.ok((await state(alice)).run.lines.some(line=>line.text.includes(aliceId)));
    assert.ok(!(await state(alice)).run.lines.some(line=>line.text.includes(bobId)));
    assert.equal((await state(admin)).run.state,'idle');
    const raw=fs.readFileSync(path.join(root,'.web-users.json'),'utf8');
    assert.ok(!raw.includes('a123456') && !raw.includes('alice-secret') && !raw.includes('bob-secret'),'only salted hashes stored');
    await stop(); await start();
    assert.equal((await request('/api/state',alice)).status,401,'server restart expires sessions');
    alice=await login('alice','alice-secret'); bob=await login('bob','bob-secret'); admin=await login('admin','admin-secret');
    assert.equal((await state(alice)).config.users[0].name,'alice'); assert.equal((await state(bob)).config.users[0].name,'bob');
    assert.equal((await state(alice)).run.id,runAlice.id); assert.equal((await state(bob)).run.id,runBob.id);
    assert.equal((await request('/api/auth/login','',{username:'alice',password:'a123456'})).status,401);
    assert.equal((await request('/api/register','',{username:'self_register'})).status,401,'no public registration route');

    if(process.env.PLAYWRIGHT_MODULE) {
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
      browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
      await page.goto(base+'/login'); await page.fill('#auth-username','admin');await page.fill('#admin-password','admin-secret');await page.click('#auth-submit');await page.waitForURL(base+'/');
      await page.locator('#nav-users').click();await page.fill('#web-new-username','charlie');await page.locator('#web-user-create button').click();
      await page.locator('#web-users-list').filter({hasText:'charlie'}).waitFor();
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'web-user-management.png'),fullPage:true});
      await page.click('#admin-logout');await page.waitForURL('**/login');
      await page.fill('#auth-username','charlie');await page.fill('#admin-password','a123456');await page.click('#auth-submit');await page.waitForURL('**/password');
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'web-user-first-password.png'),fullPage:true});
      assert.equal((await page.request.get(base+'/api/state')).status(),403);
      await page.fill('#admin-password','a123456');await page.fill('#auth-new-password','charlie-secret');await page.fill('#auth-confirm-password','charlie-secret');await page.click('#auth-submit');await page.waitForURL(base+'/');
      await page.locator('#web-user-name').filter({hasText:'charlie'}).waitFor();
      assert.equal(await page.locator('#nav-users').isVisible(),false);
      await page.locator('[data-view="accounts"]').click(); assert.equal(await page.locator('.account-tile').count(),0);
      await page.locator('#add-account').click();
      await page.locator('.account-fields [data-field="name"]').fill('charlie TG');
      await page.locator('.account-fields [data-field="session"]').fill('charlie_tg');
      await page.locator('[data-use-global]').uncheck();
      await page.locator('.account-fields [data-field="apiId"]').fill('123');
      await page.locator('.account-fields [data-field="apiHash"]').fill('charlie-key');
      await page.locator('[data-account-section="bots"]').click();
      await page.locator('[data-add-bot]').click();
      await page.locator('.account-bot-table [data-field="name"]').fill('@example_bot');
      await page.locator('[data-account-section="checkins"]').click();
      await page.locator('[data-add-checkin]').click();
      await page.locator('.checkin-rule .auto-switch').click();
      await page.locator('#account-detail .save-btn').first().click();
      await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      assert.equal((await(await page.request.get(base+'/api/state')).json()).config.users[0].checkinSchedules.length,1,'regular user can create and persist own tasks through UI');
      await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(errors,[]);
    }
    console.log('Multi-user PASS: admin-only creation, salted durable passwords, mandatory change, API gates, duplicate names, independent sessions/config/logs/workers, cross-user stop rejection, restart persistence and browser flow');
  } finally {await browser?.close();await stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
