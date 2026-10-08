const { authenticatePage } = require('./auth-support');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
 if(!process.env.PLAYWRIGHT_MODULE){console.log('Browser skipped: PLAYWRIGHT_MODULE required');return;}
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'random-browser-'));let server,browser;
 try{
  for(const file of ['database.js', 'account_profiles.js','server.js','admin_auth.js','user_auth.js','system_settings.js','telegram_notifications.js','checkin_results.js','automation.js','login.js','schedule_time.js','run_history.js', 'checkin_scheduler.js','telegram_credentials.js']) fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
  fs.cpSync(path.join(__dirname,'../public'),path.join(root,'public'),{recursive:true});
  const today=new Date(Date.now()+28800000).toISOString().slice(0,10);
  const rule={id:'random_rule_01',enabled:true,repeat:'daily',timeMode:'random',rangeStart:'09:00:01',rangeEnd:'09:00:01'};
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{users:[{name:'offline',session:'offline',api_id:123,api_hash:'offline',bot_groups:{button:[],command:[{bot:'@example_bot',command:'/sign full text'}]},checkin_schedules:[rule]}]},ai:{providers:[]},automations:{schedules:[{...rule,id:'message_rule_01',account:'offline',target:'@example_bot',message:'full message\nkept verbatim'}],forwards:[]}}));
  const plan={account:'offline',ruleId:'message_rule_01',date:today,time:'09:00:01',signature:['09:00:01','09:00:01']};
  fs.writeFileSync(path.join(root,'.automation-state.json'),JSON.stringify({sent:{},planned:{test:plan},claimed:{}}));
  const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
  const base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),AUTOCHECKIN_DATA_DIR:root},stdio:'ignore'});
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/state')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await authenticatePage(page, base); await page.goto(base+'/#accounts');await page.locator('[data-open-account="0"][data-section="checkins"]').click();
  const checkin=page.locator('.checkin-rule');
  assert.equal(await checkin.locator('[data-field="rangeStart"]').getAttribute('step'),'1');
  await page.waitForFunction(()=>document.querySelector('[data-planned-kind="checkin"]').textContent.includes('09:00:01'));
  await checkin.locator('[data-field="rangeStart"]').fill('09:00:02');await page.waitForTimeout(2300);assert.equal(await checkin.locator('[data-field="rangeStart"]').inputValue(),'09:00:02');
  await checkin.locator('[data-field="rangeStart"]').fill('23:00:00');await checkin.locator('[data-field="rangeEnd"]').fill('01:00:00');
  const save=async status=>{const response=page.waitForResponse(r=>r.url()===base+'/api/config'&&r.request().method()==='POST');await page.locator('#account-detail .save-btn').first().click();const result=await response;assert.equal(result.status(),status,await result.text());await page.waitForTimeout(100);};
  await save(400);assert.ok((await page.locator('#toast').textContent()).includes('跨午夜'));
  await checkin.locator('[data-field="rangeStart"]').fill('09:00:01');await checkin.locator('[data-field="rangeEnd"]').fill('09:00:01');await save(200);
  await checkin.locator('[data-field="timeMode"]').selectOption('fixed');await checkin.locator('[data-field="time"]').fill('11:22:33');await save(200);
  let persisted=JSON.parse(fs.readFileSync(path.join(root,'config.json')));assert.equal(persisted.telegram.users[0].checkin_schedules[0].time,'11:22:33');
  await page.locator('[data-checkin-repeat="once"]').click();await checkin.locator('[data-field="time"]').fill('2029-01-02T11:22:33');await save(200);persisted=JSON.parse(fs.readFileSync(path.join(root,'config.json')));assert.equal(persisted.telegram.users[0].checkin_schedules[0].time,'2029-01-02T11:22:33');
  await page.locator('[data-account-section="messages"]').click();const message=page.locator('[data-auto-kind="schedules"]');
  await page.waitForFunction(()=>document.querySelector('[data-planned-kind="message"]').textContent.includes('09:00:01'));
  await message.locator('[data-field="rangeEnd"]').fill('10:30:59');await page.waitForTimeout(2300);assert.equal(await message.locator('[data-field="rangeEnd"]').inputValue(),'10:30:59');
  await save(200);persisted=JSON.parse(fs.readFileSync(path.join(root,'config.json')));assert.equal(persisted.automations.schedules[0].rangeEnd,'10:30:59');assert.equal(persisted.automations.schedules[0].message,'full message\nkept verbatim');
  await message.locator('[data-field="timeMode"]').selectOption('fixed');await message.locator('[data-field="time"]').fill('10:20:31');await save(200);
  await message.locator('[data-auto-select][data-field="repeat"]').click();await page.locator('[data-auto-option="once"]').click();await message.locator('[data-field="time"]').fill('2029-01-02T10:20:31');await save(200);
  persisted=JSON.parse(fs.readFileSync(path.join(root,'config.json')));assert.equal(persisted.automations.schedules[0].time,'2029-01-02T10:20:31');assert.equal(persisted.automations.schedules[0].timeMode,'fixed');
  await page.reload();await page.locator('[data-open-account="0"][data-section="messages"]').click();assert.equal(await message.locator('[data-field="time"]').inputValue(),'2029-01-02T10:20:31');assert.deepEqual(errors,[]);
  console.log('Chromium random/fixed/once seconds, both forms, plan display, live poll preserves input, midnight rejection, save/reload, verbatim message PASS');
 }finally{await browser?.close();if(server){server.kill();await new Promise(r=>server.once('close',r));}fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
