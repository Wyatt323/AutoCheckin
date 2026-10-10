// Local server and fake automation worker; no real Telegram requests or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');

(async () => {
  const tempBase = path.resolve(process.env.AUTOCHECKIN_TEST_TMPDIR || os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase,'forward-pin-'));
  let server, browser;
  const stop = async () => {if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;server=null;}};
  try {
    for(const file of ['server.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'automation_worker.py'),"import json,time\nprint(json.dumps(dict(type='ready',message='offline feature worker')),flush=True)\ntime.sleep(60)\n");
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:['first','second'].map(session=>({name:session,session,bot_groups:{button:[],command:[]}}))},ai:{providers:[]},automations:{schedules:[],forwards:[]}}));
    fs.mkdirSync(path.join(root,'.account-profiles'));
    for(const account of ['first','second']) {
      fs.writeFileSync(path.join(root,account+'.session'),'fake-session');
      fs.writeFileSync(path.join(root,'.account-profiles',createHash('sha256').update(account).digest('hex')+'.json'),JSON.stringify({userId:'123',dcId:1,updatedAt:new Date().toISOString()}));
    }
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',input)=>fetch(base+url,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD']) delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
      for(let i=0;i<80;i++){try{if((await request('/api/auth/status')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('feature server not ready');
    };
    const login=async(username,password)=>{const response=await request('/api/auth/login','',{username,password});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    const state=async cookie=>(await(await request('/api/state',cookie)).json());
    const save=async(config,cookie=admin)=>request('/api/config',cookie,config);
    await start();let admin=await login('admin','offline-admin-secret');
    let config=(await state(admin)).config;
    assert.deepEqual(config.automations.forwardPins,[]);
    config.automations.forwards=[{id:'legacy_rule_001',enabled:false,account:'first',source:'@legacy_source',target:'@legacy_target'}];
    config.automations.forwardPins=[{id:'forward_pin_001',enabled:true,name:'重要消息',account:'first',sources:['https://t.me/source_one','@SOURCE_ONE','source_two'],target:'destination',keywords:['Sale','sale','  '],pinAfterForward:false}];
    assert.equal((await save(config)).status,200);
    config=(await state(admin)).config;
    assert.deepEqual(config.automations.forwardPins[0].sources,['@source_one','@source_two']);
    assert.deepEqual(config.automations.forwardPins[0].keywords,['Sale']);
    assert.equal(config.automations.forwardPins[0].target,'@destination');
    const committed=fs.readFileSync(path.join(root,'config.json'),'utf8');
    for(const change of [rule=>rule.sources=[],rule=>rule.sources=Array(21).fill('@source_one'),rule=>rule.sources=['@destination'],rule=>rule.account='other_user_account',rule=>rule.keywords=Array(51).fill('word'),rule=>rule.keywords=['x'.repeat(101)],rule=>rule.pinAfterForward='false']) {
      const invalid=structuredClone(config);change(invalid.automations.forwardPins[0]);assert.equal((await save(invalid)).status,400);
      assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),committed,'invalid rule never replaces durable config');
    }
    const cycle=structuredClone(config);
    cycle.automations.forwards.push({id:'cross_cycle_001',enabled:true,account:'first',source:'@destination',target:'@source_two'});
    assert.equal((await save(cycle)).status,400,'cycles involving old forwards and multiple plugin sources are rejected');
    cycle.automations.forwards.at(-1).account='second';
    assert.equal((await save(cycle)).status,400,'forwarding cycles across different TG accounts are rejected');
    const users=[];
    for(const username of ['alice','bob']) {
      const response=await request('/api/users',admin,{username});assert.equal(response.status,201);
      const cookie=await login(username,'a123456');
      assert.equal((await request('/api/auth/password',cookie,{currentPassword:'a123456',newPassword:username+'-secret'})).status,200);
      const own=(await state(cookie)).config;
      own.telegram={apiId:'123',apiHash:'offline'};
      own.users=[{name:username,session:'shared',sourceIndex:-1,useGlobalCredentials:true,bots:[],checkinSchedules:[]}];
      own.automations.forwardPins=[{id:'forward_pin_001',name:username,enabled:false,account:'shared',sources:['@'+username+'_source'],target:'@'+username+'_target',keywords:[],pinAfterForward:true}];
      assert.equal((await save(own,cookie)).status,200);users.push({username,cookie});
    }
    for(const user of users) {
      const own=(await state(user.cookie)).config;
      assert.equal(own.automations.forwardPins[0].name,user.username);
      assert.deepEqual(own.automations.forwardPins[0].keywords,[]);
      assert.equal(own.automations.forwardPins[0].pinAfterForward,true);
    }
    assert.equal((await state(admin)).config.automations.forwardPins[0].name,'重要消息');
    if(process.env.PLAYWRIGHT_MODULE) {
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
      browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({reducedMotion:'reduce',viewport:{width:1440,height:1100}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>{
        if(!route.request().url().startsWith(base))return route.abort();
        if(new URL(route.request().url()).pathname==='/api/accounts/chats/resolve') {
          const {account,peers}=route.request().postDataJSON();return route.fulfill({contentType:'application/json',body:JSON.stringify({results:peers.map(value=>({value,status:'ok',title:account+':'+value,id:'-100123',type:'channel'}))})});
        }
        return route.continue();
      });
      await page.goto(base+'/#features');await page.locator('#open-forward-pin').click();
      const first=page.locator('[data-feature-rule="forward_pin_001"]');
      try {
        await first.locator('[data-feature-source]').first().locator('..').locator('[data-feature-peer-name]').filter({hasText:'first:@source_one'}).waitFor({timeout:10000});
      } catch (error) {
        console.error('Feature UI diagnostics:', errors, await page.evaluate(() => ({currentView,editor:typeof featureEditorOpen==='undefined' ? 'script not loaded' : featureEditorOpen,users:config.users.map(({session,sessionReady})=>({session,sessionReady})),badges:[...document.querySelectorAll('[data-feature-peer-name]')].map(node=>({text:node.textContent,hidden:node.hidden}))})));
        throw error;
      }
      assert.equal(await first.locator('.ui-select-trigger').count(),1,'plugin account dropdown uses themed UI');
      await first.locator('select[data-feature-field="account"]').selectOption('second');
      await first.locator('[data-feature-source]').first().locator('..').locator('[data-feature-peer-name]').filter({hasText:'second:@source_one'}).waitFor();
      await first.locator('[data-feature-add-source]').click();await first.locator('[data-feature-source]').last().fill('@third_source');
      await first.locator('[data-feature-source]').last().locator('..').locator('[data-feature-peer-name]').filter({hasText:'second:@third_source'}).waitFor();
      assert.equal(await first.locator('[data-feature-source]').last().evaluate(input => input === document.activeElement),true,'source name resolves while the input retains focus, without saving');
      await first.locator('[data-feature-field="target"]').fill('-100987654321');
      await first.locator('[data-feature-field="target"]').locator('..').locator('[data-feature-peer-name]').filter({hasText:'second:-100987654321'}).waitFor();
      await first.locator('[data-feature-field="target"]').fill('@destination');
      await first.locator('[data-feature-keyword]').fill('通知');await first.locator('[data-feature-add-keyword]').click();await first.locator('[data-feature-keyword]').last().fill('[重要]');
      await first.locator('.feature-pin-switch').click();
      await page.waitForTimeout(2200);assert.equal(await first.locator('[data-feature-source]').last().inputValue(),'@third_source','polling preserves drafts');
      await page.locator('#forward-pin-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      const saved=(await state(admin)).config.automations.forwardPins[0];
      assert.equal(saved.account,'second');assert.equal(saved.pinAfterForward,true);assert.deepEqual(saved.keywords,['通知','[重要]']);assert.equal(saved.sources.length,3);
      await page.locator('#add-forward-pin').click();
      const second=page.locator('[data-feature-rule]').last();
      assert.match(await second.innerText(),/转发全部新消息/);
      await second.locator('[data-feature-source]').fill('@another_source');await second.locator('[data-feature-field="target"]').fill('@another_target');
      await second.locator('.automation-card-actions .auto-switch').click();
      await page.locator('#forward-pin-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      await page.reload();await page.locator('#open-forward-pin').click();assert.equal(await page.locator('[data-feature-rule]').count(),2);
      await page.locator('[data-feature-rule]').last().locator('[data-feature-remove]').click();await page.getByRole('dialog',{name:'删除插件规则'}).getByRole('button',{name:'删除规则'}).click();
      await page.locator('#forward-pin-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      assert.equal((await state(admin)).config.automations.forwardPins.length,1);
      await page.evaluate(() => openAccount(0,'messages'));
      await page.locator('#add-schedule').click();
      const messageTarget=page.locator('#schedule-list [data-field="target"]').last();
      await messageTarget.fill('@message_group');
      await messageTarget.locator('..').locator('[data-peer-name]').filter({hasText:'first:@message_group'}).waitFor();
      assert.equal(await messageTarget.evaluate(input => input === document.activeElement),true,'scheduled-message target name resolves without blur or saving');
      await page.evaluate(() => navigate('features'));
      for(const width of [1440,1024,390,320]) {await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`plugin fits ${width}px`);}
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) {
        await page.locator('[data-feature-rule]').first().locator('[data-feature-peer-name]').first().filter({hasText:'second:@source_one'}).waitFor();
        await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'));
        await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'forward-pin-plugin-desktop.png'),fullPage:true});
        await page.setViewportSize({width:390,height:1000});await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'forward-pin-plugin-mobile.png'),fullPage:true});
      }
      assert.deepEqual(errors,[]);await browser.close();browser=null;
    }
    const expected=(await state(admin)).config.automations.forwardPins;
    await stop();await start();admin=await login('admin','offline-admin-secret');
    assert.deepEqual((await state(admin)).config.automations.forwardPins,expected,'plugin rules persist across restart');
    for(const user of users) {user.cookie=await login(user.username,user.username+'-secret');assert.equal((await state(user.cookie)).config.automations.forwardPins[0].name,user.username);}
    console.log('Forward/pin plugin PASS: normalized durable config, bounds/permissions/cycles, independent user data, themed browser controls, multiple sources/keywords, pin switch, name lookup, save/delete/reload/mobile');
  } finally {
    await browser?.close();await stop();assert.ok(root.startsWith(tempBase+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
