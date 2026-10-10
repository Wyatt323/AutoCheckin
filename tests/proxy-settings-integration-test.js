// Isolated web API/browser tests. Fake workers only, no outbound Telegram requests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-settings-'));
  let server,browser;
  const stop=async()=>{if(server){const done=new Promise(resolve=>server.once('close',resolve));if(process.platform==='win32'){const result=spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});assert.equal(result.status,0,'test process cleanup denied; run this integration test with process-control permissions');}else server.kill();await done;server=null;}};
  const wait=async check=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('condition timed out');};
  try {
    for(const file of ['server.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:[{name:'offline',session:'offline',bot_groups:{button:['@test_bot'],command:[]}}]},ai:{providers:[]},automations:{schedules:[{id:'message_offline_001',enabled:true,account:'offline',target:'@test_group',time:'09:00',message:'test'}],forwards:[]}}));
    fs.writeFileSync(path.join(root,'offline.session'),'fake session');
    fs.writeFileSync(path.join(root,'allinone.py'),"import time\nprint('offline checkin worker',flush=True)\ntime.sleep(30)\n");
    fs.writeFileSync(path.join(root,'automation_worker.py'),"import json,time,pathlib\np=pathlib.Path('.system-settings.json')\ns=json.loads(p.read_text()) if p.exists() else {}\nprint(json.dumps(dict(type='ready',message='offline proxy '+s.get('proxy',{}).get('type','direct'))),flush=True)\ntime.sleep(60)\n");
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',input,method=input===undefined?'GET':'PUT')=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const start=async()=>{
      const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')};
      for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])delete env[key];
      server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
      await wait(async()=>{try{return (await request('/api/auth/status')).ok;}catch{return false;}});
    };
    const login=async(username,password)=>{const response=await request('/api/auth/login','',{username,password},'POST');assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
    await start();let admin=await login('admin','offline-admin-secret');
    const get=async()=>await(await request('/api/admin/proxy',admin)).json();
    assert.equal((await get()).proxy.enabled,false);
    assert.equal((await request('/api/users',admin,{username:'alice'},'POST')).status,201);
    let alice=await login('alice','a123456');assert.equal((await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'alice-secret'},'POST')).status,200);
    assert.equal((await request('/api/admin/proxy',alice)).status,403);
    const input={enabled:true,type:'http',host:'127.0.0.1',port:7890,username:'proxy-user',password:'proxy-secret'};
    assert.equal((await request('/api/admin/proxy',alice,input)).status,403);
    const saved=await request('/api/admin/proxy',admin,input);assert.equal(saved.status,200);
    assert.ok(!(await saved.text()).includes('proxy-secret'));
    await wait(async()=>(await(await request('/api/state',admin)).json()).automation.message==='offline proxy http');
    assert.ok(!JSON.stringify(await(await request('/api/state',alice)).json()).includes('proxy-secret'));
    assert.equal((await request('/api/admin/proxy',admin,{...input,password:'',type:'socks5'})).status,200);
    await wait(async()=>(await(await request('/api/state',admin)).json()).automation.message==='offline proxy socks5');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.system-settings.json'),'utf8')).proxy.password,'proxy-secret');
    const services={telegram:{apiId:'321',apiHash:'offline-system'},providers:[],model:''};
    assert.equal((await request('/api/admin/settings',admin,services)).status,200);assert.equal((await get()).proxy.type,'socks5');
    assert.equal((await request('/api/admin/proxy',admin,{...input,port:99999})).status,400);
    assert.equal((await get()).proxy.type,'socks5','invalid configuration leaves the saved proxy intact');
    const run=await request('/api/run',admin,{account:'offline'},'POST');assert.equal(run.status,200);const id=(await run.json()).run.id;
    assert.equal((await request('/api/admin/proxy',admin,{...input,type:'https'})).status,400,'active check-in prevents switching an existing direct/proxy connection');
    assert.equal((await get()).proxy.type,'socks5');
    assert.equal((await request('/api/stop',admin,{id},'POST')).status,200);
    await wait(async()=>(await(await request('/api/state',admin)).json()).busyAccounts.length===0);
    if(process.env.PLAYWRIGHT_MODULE) {
      const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
      const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.context().addCookies([{name:'ac_session',value:admin.slice(admin.indexOf('=')+1),url:base,httpOnly:true,sameSite:'Strict'}]);
      await page.route('**/*',route=>route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.goto(base+'/#users');await page.locator('#proxy-status').filter({hasText:'SOCKS5'}).waitFor();
      assert.equal(await page.locator('#proxy-type + .ui-select-trigger').count(),1,'proxy dropdown is themed');
      assert.equal(await page.locator('#proxy-password').inputValue(),'');
      await page.locator('#proxy-type').selectOption('https');await page.locator('#proxy-host').fill('proxy.example.com');await page.locator('#proxy-port').fill('443');
      await page.locator('#proxy-settings-form [type="submit"]').click();await page.locator('#proxy-status').filter({hasText:'HTTPS'}).waitFor();
      assert.equal((await get()).proxy.host,'proxy.example.com');assert.equal((await get()).proxy.hasPassword,true);
      for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`proxy settings fit ${width}px`);}
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) {
        await page.waitForFunction(()=>!document.querySelector('#toast').classList.contains('show'));
        await page.setViewportSize({width:1440,height:1100});await page.locator('.proxy-settings').screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'proxy-settings-desktop.png')});
        await page.setViewportSize({width:390,height:1100});await page.locator('.proxy-settings').screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'proxy-settings-mobile.png')});
      }
      assert.deepEqual(errors,[]);await browser.close();browser=null;
    }
    const expected=(await get()).proxy;await stop();await start();admin=await login('admin','offline-admin-secret');assert.deepEqual((await get()).proxy,expected,'proxy persists across restart');
    assert.equal((await request('/api/admin/proxy',admin,{...input,enabled:false,password:'',clearPassword:true})).status,200);
    assert.equal((await get()).proxy.hasPassword,false);
    console.log('Proxy settings PASS: admin permissions, masked passwords, persistence, credential retention, task guard, worker reconnection and themed browser controls');
  } finally {await browser?.close();await stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
