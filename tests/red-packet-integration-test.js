// Real local API and browser with a fake worker; never connects to Telegram.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto');

(async()=>{
  const tempBase=path.resolve(process.env.AUTOCHECKIN_TEST_TMPDIR || os.tmpdir());
  const root=fs.mkdtempSync(path.join(tempBase,'red-packet-'));
  let server,browser;
  const stop=async()=>{if(server){const closed=new Promise(resolve=>server.once('close',resolve));server.kill();await closed;server=null;}};
  try {
    for(const file of ['server.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','health_monitor.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'automation_worker.py'),`import json,time
from pathlib import Path
config=json.loads(Path('config.json').read_text(encoding='utf-8'))
print(json.dumps(dict(type='ready',message='offline red packet worker')),flush=True)
for rule in config.get('automations',{}).get('redPackets',[]):
    if not rule.get('enabled',True):continue
    group=dict(chatId='-100123',title='Offline group',ruleIds=[rule['id']],received=12,commands=2,packets=1,lastReceivedAt=time.time(),fallbackChecks=3)
    print(json.dumps(dict(type='red_packet_status',account=rule['account'],groups=[group])),flush=True)
print(json.dumps(dict(type='log',account='first',category='red_packet',ruleId='red_rule_001',state='completed',message='offline claim completed')),flush=True)
time.sleep(60)
`);
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:['first','second'].map(session=>({name:session,session,bot_groups:{button:[],command:[]}}))},ai:{providers:[]},automations:{schedules:[],forwards:[]}}));
    fs.mkdirSync(path.join(root,'.account-profiles'));
    for(const account of ['first','second']){
      fs.writeFileSync(path.join(root,account+'.session'),'fake-session');
      fs.writeFileSync(path.join(root,'.account-profiles',createHash('sha256').update(account).digest('hex')+'.json'),JSON.stringify({userId:'123',dcId:1,updatedAt:new Date().toISOString()}));
    }
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',input)=>fetch(base+url,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
      for(let i=0;i<80;i++){try{if((await request('/api/auth/status')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('server not ready');
    };
    const login=async(username,password)=>{const response=await request('/api/auth/login','',{username,password});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    const state=async cookie=>(await(await request('/api/state',cookie)).json());
    await start();let admin=await login('admin','offline-admin-secret');
    const save=(config,cookie=admin)=>request('/api/config',cookie,config);
    let config=(await state(admin)).config;
    assert.deepEqual(config.automations.redPackets,[]);
    config.automations.redPackets=[{id:'red_rule_001',name:'牛逼群红包',enabled:true,account:'first',groups:['https://t.me/group_one','@GROUP_ONE','-100123'],botUsername:'niubi_bot',watchSeconds:120,retryInterval:0.5,buttonKeywords:['好運連連',' 好運連連 '],successKeywords:[],emptyKeywords:[]}];
    assert.equal((await save(config)).status,200);
    config=(await state(admin)).config;
    assert.deepEqual(config.automations.redPackets[0].groups,['@group_one','-100123']);
    assert.deepEqual(config.automations.redPackets[0].buttonKeywords,['好運連連']);
    assert.equal(config.automations.redPackets[0].botUsername,'@niubi_bot');
    for(const change of [r=>r.groups=[],r=>r.groups=Array(21).fill('@group'),r=>r.groups=['bad value'],r=>r.account='other_user',r=>r.watchSeconds=29,r=>r.watchSeconds=601,r=>r.retryInterval=0.1,r=>r.retryInterval=6,r=>r.botUsername='-100123',r=>r.enabled='false',r=>r.successKeywords=Array(31).fill('ok'),r=>r.emptyKeywords=['x'.repeat(81)]]){
      const invalid=structuredClone(config);change(invalid.automations.redPackets[0]);assert.equal((await save(invalid)).status,400);
    }
    const duplicate=structuredClone(config);duplicate.automations.forwardPins=[{id:'red_rule_001',account:'first',enabled:false,sources:['@source'],target:'@target'}];
    assert.equal((await save(duplicate)).status,400,'rule IDs are unique across plugin types');
    const logs=async(cookie=admin,query='?category=red_packet')=>(await(await request('/api/runs'+query,cookie)).json()).records;
    for(let i=0;i<80 && !(await logs()).length;i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await logs())[0].trigger,'automatic');
    assert.equal((await logs(admin,'?account=second&category=red_packet')).length,0);
    const users=[];
    for(const username of ['alice','bob']){
      assert.equal((await request('/api/users',admin,{username})).status,201);
      const cookie=await login(username,'a123456');assert.equal((await request('/api/auth/password',cookie,{currentPassword:'a123456',newPassword:username+'-secret'})).status,200);
      const settings=await fetch(base+'/api/settings',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({telegram:{apiId:'123',apiHash:'offline'},model:'',providers:[]})});assert.equal(settings.status,200);
      const own=(await state(cookie)).config;own.telegram.useSystem=true;own.users=[{name:username,session:'shared',sourceIndex:-1,useGlobalCredentials:true,bots:[],checkinSchedules:[]}];
      own.automations.redPackets=[{...config.automations.redPackets[0],name:username,account:'shared',enabled:false}];
      assert.equal((await save(own,cookie)).status,200);users.push({username,cookie});
      assert.equal((await logs(cookie)).length,0,'another user cannot see administrator logs');
      own.automations.redPackets[0].account='first';assert.equal((await save(own,cookie)).status,400,'cannot use another user TG account');
    }
    for(const user of users)assert.equal((await state(user.cookie)).config.automations.redPackets[0].name,user.username);
    if(process.env.PLAYWRIGHT_MODULE){
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
      browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>{
        if(!route.request().url().startsWith(base))return route.abort();
        if(new URL(route.request().url()).pathname==='/api/accounts/chats/resolve'){
          const {account,peers}=route.request().postDataJSON();return route.fulfill({contentType:'application/json',body:JSON.stringify({results:peers.map(value=>({value,status:'ok',title:account+'的群组 '+value,id:'-100123',type:'group'}))})});
        }
        return route.continue();
      });
      const screenshot=async name=>{if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,name+'.png'),fullPage:true});};
      await page.goto(base+'/#features');assert.equal(await page.locator('#feature-catalog .feature-plugin-card').count(),4);
      await screenshot('red-packet-catalog');await page.locator('#open-red-packet').click();
      const card=page.locator('[data-red-packet-rule="red_rule_001"]');
      await card.locator('[data-rule-toggle]').click();
      await card.locator('[data-feature-peer-name]').first().filter({hasText:'first的群组 @group_one'}).waitFor();
      await card.locator('[data-red-packet-runtime]').filter({hasText:'已接收 12 条实时消息'}).waitFor();
      const runtime=await card.locator('[data-red-packet-runtime]').innerText();
      assert.ok(runtime.includes('已连接 1 个群组') && runtime.includes('/red 2 次') && runtime.includes('红包按钮 1 个') && runtime.includes('备用检查 3 次'));
      assert.equal(await card.locator('.ui-select-trigger').count(),1,'themed account selector');
      await card.locator('[data-red-packet-field="account"]').selectOption('second');
      await card.locator('[data-feature-peer-name]').first().filter({hasText:'second的群组 @group_one'}).waitFor();
      await card.locator('[data-red-packet-add-group]').click();await card.locator('[data-red-packet-group]').last().fill('@new_group');
      await card.locator('[data-feature-peer-name]').last().filter({hasText:'second的群组 @new_group'}).waitFor();
      assert.equal(await card.locator('[data-red-packet-group]').last().evaluate(input=>input===document.activeElement),true);
      await card.locator('.red-packet-options summary').click();await card.locator('[data-red-packet-words="successKeywords"]').fill('入账完成\n已经领取过');
      await card.locator('[data-red-packet-field="watchSeconds"]').fill('180');
      await card.locator('[data-red-packet-field="retryInterval"]').fill('0.8');
      await page.waitForTimeout(2200);assert.equal(await card.locator('[data-red-packet-group]').last().inputValue(),'@new_group','polling preserves unsaved edits');
      await page.locator('#red-packet-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      const saved=(await state(admin)).config.automations.redPackets[0];assert.equal(saved.account,'second');assert.equal(saved.watchSeconds,180);assert.equal(saved.retryInterval,0.8);assert.deepEqual(saved.successKeywords,['入账完成','已经领取过']);assert.equal(saved.groups.length,3);
      await card.locator('[data-red-packet-runtime]').filter({hasText:'已接收 12 条实时消息'}).waitFor();
      await card.locator('[data-rule-toggle]').click();
      await card.locator('.red-packet-options summary').click();
      await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('show'));await screenshot('red-packet-desktop');
      await card.locator('.red-packet-options summary').click();await screenshot('red-packet-options');
      for(const width of [1440,1024,390,320]){
        await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`fits ${width}px`);
        if(width===390)await screenshot('red-packet-mobile');
      }
      await page.setViewportSize({width:1440,height:1100});await page.locator('#add-red-packet').click();
      const added=page.locator('[data-red-packet-rule]').last();await added.locator('[data-red-packet-group]').fill('@other_group');await added.locator('.auto-switch').click();
      await page.locator('#red-packet-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      await page.reload();await page.locator('#open-red-packet').click();assert.equal(await page.locator('[data-red-packet-rule]').count(),2);
      await page.locator('[data-red-packet-rule]').last().locator('[data-red-packet-remove]').click();await page.getByRole('dialog',{name:'删除红包规则'}).getByRole('button',{name:'删除规则'}).click();
      await page.locator('#red-packet-editor .save-btn').click();await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
      await page.locator('#red-packet-logs').click();assert.equal(await page.locator('#log-filter-category').inputValue(),'red_packet');
      assert.deepEqual(errors,[]);await browser.close();browser=null;
    }
    config=(await state(admin)).config;const expected=config.automations.redPackets;
    config.automations.redPackets.forEach(rule=>rule.enabled=false);assert.equal((await save(config)).status,200);
    await stop();await start();admin=await login('admin','offline-admin-secret');
    const persisted=(await state(admin)).config.automations.redPackets;
    assert.deepEqual(persisted,expected.map(rule=>({...rule,enabled:false})),'rules survive restart');
    assert.ok((await logs()).some(run=>run.lines[0].text==='offline claim completed'),'logs survive restart without a worker');
    for(const user of users){user.cookie=await login(user.username,user.username+'-secret');assert.equal((await state(user.cookie)).config.automations.redPackets[0].name,user.username);}
    console.log('Red packet API/UI PASS: validation, user isolation, durable rules/logs, themed controls, group names, keywords, save/delete/reload, responsive layout');
  }finally{
    await browser?.close();await stop();assert.ok(root.startsWith(tempBase+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
