const { authenticatePage } = require('./auth-support');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {resolveCredentials}=require('../telegram_credentials');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'global-api-')); let server,browser;
 try {
  for(const file of ['database.js', 'account_profiles.js','server.js','admin_auth.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','automation.js','login.js','schedule_time.js', 'run_history.js', 'checkin_scheduler.js','telegram_credentials.js']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(dir,file));
  fs.cpSync(path.join(__dirname,'../public'),path.join(dir,'public'),{recursive:true});
  const original={telegram:{users:[{name:'legacy',session:'legacy',api_id:123,api_hash:'old-hash',bot_groups:{button:['@example_bot'],command:[]}}]},ai:{providers:[]}};
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(original));
  const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
  const base=`http://127.0.0.1:${port}`;server=spawn(process.execPath,[path.join(dir,'server.js')],{env:{...process.env,PORT:String(port),AUTOCHECKIN_DATA_DIR:dir},stdio:'ignore'});
  for(let i=0;i<50;i++){try{if((await fetch(base+'/api/state')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const read=()=>JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
  const state=async()=> (await(await fetch(base+'/api/state')).json()).config;
  const save=async c=>{const res=await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});return {status:res.status,data:await res.json()};};
  let c=await state();assert.equal(c.telegram.apiId,'');assert.equal(c.users[0].useGlobalCredentials,false);
  assert.equal((await save(c)).status,200);assert.equal(read().telegram.users[0].api_hash,'old-hash');
  c=await state();c.telegram={apiId:'789',apiHash:'global-secret'};
  assert.equal((await save(c)).status,200);assert.equal(read().telegram.users[0].api_id,123);
  c=await state();assert.ok(!JSON.stringify(c).includes('global-secret'));assert.ok(!JSON.stringify(c).includes('old-hash'));
  assert.equal((await save(c)).status,200);assert.equal(read().telegram.api_hash,'global-secret');
  c.users[0].apiId='';assert.equal((await save(c)).status,200);
  assert.deepEqual(resolveCredentials(read(),read().telegram.users[0]),{apiId:789,apiHash:'old-hash'});
  c=await state();c.users[0].apiId=456;c.users[0].clearApiHash=true;assert.equal((await save(c)).status,200);
  assert.deepEqual(resolveCredentials(read(),read().telegram.users[0]),{apiId:456,apiHash:'global-secret'});assert.equal(read().telegram.users[0].api_hash,'');
  c=await state();c.users[0].useGlobalCredentials=true;assert.equal((await save(c)).status,200);
  assert.equal(read().telegram.users[0].api_id,'');assert.equal(read().telegram.users[0].api_hash,'');
  assert.equal(read().telegram.users[0].name,'legacy');assert.equal(read().telegram.users[0].session,'legacy');assert.deepEqual(read().telegram.users[0].bot_groups,original.telegram.users[0].bot_groups);
  const before=fs.readFileSync(path.join(dir,'config.json'),'utf8');c=await state();c.telegram.apiId='';assert.equal((await save(c)).status,400);assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),before);
  for(const id of ['0','-1','1.5','1e3','9007199254740992']){c=await state();c.telegram.apiId=id;assert.equal((await save(c)).status,400);}
  // Legacy callers omitting the new section do not erase globals.
  c=await state();delete c.telegram;assert.equal((await save(c)).status,200);assert.equal(read().telegram.api_hash,'global-secret');
  if(process.env.PLAYWRIGHT_MODULE){
   const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
   await authenticatePage(page, base); await page.goto(base+'/#accounts');await page.locator('#global-api-id').waitFor();
   const clickSave=async selector=>{const response=page.waitForResponse(r=>r.url()===base+'/api/config'&&r.request().method()==='POST');await page.locator(selector).first().click();const res=await response;assert.equal(res.status(),200);await page.waitForTimeout(100);};
   await page.fill('#global-api-id','999');await page.fill('#global-api-hash','browser-secret');await clickSave('.global-telegram .save-btn');assert.equal(read().telegram.api_hash,'browser-secret');assert.equal(await page.inputValue('#global-api-hash'),'');
   await page.locator('[data-open-account="0"]').first().click();assert.equal(await page.locator('[data-use-global]').isChecked(),true);
   await page.locator('[data-use-global]').uncheck();await page.fill('[data-field="apiId"]','321');await page.fill('[data-field="apiHash"]','browser-account');await clickSave('#account-detail .save-btn');
   assert.equal(read().telegram.users[0].api_hash,'browser-account');await clickSave('#account-detail .save-btn');assert.equal(read().telegram.users[0].api_hash,'browser-account');
   await page.locator('[data-clear-api-hash]').click();await clickSave('#account-detail .save-btn');assert.equal(read().telegram.users[0].api_hash,'');assert.equal(read().telegram.users[0].api_id,321);
   await page.locator('[data-use-global]').check();await clickSave('#account-detail .save-btn');assert.equal(read().telegram.users[0].api_id,'');assert.equal(read().telegram.users[0].api_hash,'');
   await page.locator('#account-back').click();await clickSave('.global-telegram .save-btn');assert.equal(read().telegram.api_hash,'browser-secret');
   await page.locator('#add-account').click();await page.fill('[data-field="name"]','inherited');await page.fill('[data-field="session"]','inherited');await clickSave('#account-detail .save-btn');
   assert.equal(read().telegram.users[1].api_id,'');assert.equal(read().telegram.users[1].api_hash,'');await page.reload();await page.locator('#global-api-id').waitFor();assert.equal(await page.inputValue('#global-api-hash'),'');assert.deepEqual(errors,[]);
   const artifacts=process.env.AUTOCHECKIN_TEST_ARTIFACT_DIR;
   if(artifacts){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'global-api-desktop.png'),fullPage:true});}
   await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile has no horizontal overflow');
   if(artifacts)await page.screenshot({path:path.join(artifacts,'global-api-mobile.png'),fullPage:true});
   console.log('Real Chromium global API save / override / clear / inherit / new account / reload PASS');
  }else console.log('Browser integration skipped: set PLAYWRIGHT_MODULE');
  console.log('Global API Node config regression PASS');
 }finally{await browser?.close();if(server){server.kill();await new Promise(r=>server.once('close',r));}fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
