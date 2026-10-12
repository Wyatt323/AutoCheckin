// Real UI with an offline API; checks account ownership and preservation during the move.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) {console.log('Checkin feature browser skipped: set PLAYWRIGHT_MODULE');return;}
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const errors = [], started = [], saves = [];
    page.on('pageerror',error => errors.push(error.message));
    let stored = {telegram:{apiId:'',hasApiHash:false},model:'',providers:[],users:['first','second'].map((session,index) => ({
      name:session,session,sourceIndex:index,apiId:'',hasApiHash:false,sessionReady:true,
      botSource:index ? 'folder' : 'configured',dialogFolder:index ? 'saved-folder' : '',
      discoveredBots:index ? [{bot:'@discovered_bot',mode:'command',command:'/checkin',lastResult:'success'}] : [],
      bots:[{name:`@${session}_bot`,mode:'command',command:'/sign',note:`${session} original`,schedule:{enabled:true,time:'11:22:37'}}],
      checkinSchedules:[{id:`daily_${session}`,enabled:true,repeat:'daily',time:'09:30:15',timeMode:'fixed'}]
    })),automations:{schedules:[],forwards:[],forwardPins:[{id:'forward_1',enabled:false,name:'Saved forward',account:'second',sources:['@source'],target:'@target',keywords:[],pinAfterForward:false}]},plugins:{zeroSpeakers:[]}};
    const status = {python:'offline',run:{state:'idle',lines:[]},automation:{status:'idle',lines:[]},checkinScheduler:{events:[],planned:[]}};
    const records = [];
    await page.route('**/*',async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if (url.pathname === '/api/state') return json(url.searchParams.get('config') === '0' ? status : {...status,config:stored});
      if (url.pathname === '/api/config') {
        stored = route.request().postDataJSON();saves.push(structuredClone(stored));return json({...status,config:stored});
      }
      if (url.pathname === '/api/run') {
        const input = route.request().postDataJSON();started.push(input);
        const run = {id:`run-${started.length}`,state:'completed',account:input.account || null,accounts:input.account ? [input.account] : stored.users.map(user=>user.session),category:'checkin',trigger:'manual',lines:[],startedAt:new Date().toISOString()};
        records.push(run);return json({run});
      }
      if (url.pathname === '/api/runs') return json({revision:records.length,records});
      if (url.pathname.startsWith('/api/')) return json({login:{active:false,state:'idle'},records:[],revision:0});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return route.abort();
      const target = file === 'checkin-results.js' ? path.join(__dirname,'../checkin_results.js') : path.join(__dirname,'../public',file);
      if (!fs.existsSync(target)) return route.abort();
      return route.fulfill({body:fs.readFileSync(target),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]});
    });
    const screenshot = async name => {
      if (process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,name+'.png'),fullPage:true});
    };
    await page.goto('http://autocheckin-offline.test/#accounts');
    await page.locator('.account-tile').first().waitFor();
    assert.equal(await page.locator('#view-accounts [data-open-checkin],#account-checkin,[data-run-account],[data-account-section="bots"],[data-account-section="checkins"]').count(),0,'account management has no checkin entry buttons');
    await page.locator('.account-tile-main[data-open-account="0"]').click();
    assert.equal(await page.locator('#account-detail').getByRole('button',{name:/签到/}).count(),0,'account details also have no checkin button');
    await page.locator('[data-view="features"]').click();
    assert.equal(await page.locator('#feature-catalog .feature-plugin-card').count(),4);
    await screenshot('checkin-feature-catalog');
    await page.locator('#open-checkin').click();
    assert.equal(await page.locator('#checkin-account-choice').inputValue(),'0');
    assert.equal(await page.locator('[data-field="note"]').inputValue(),'first original');
    await page.locator('[data-field="note"]').fill('first edited');
    await page.locator('[data-bot-schedule-time]').fill('12:34:56');
    await page.selectOption('#checkin-account-choice','1');
    assert.equal(await page.locator('[data-dialog-folder]').inputValue(),'saved-folder');
    assert.match(await page.locator('.discovered-bots').innerText(),/discovered_bot/);
    assert.ok(await page.locator('[data-bot-schedule-enabled]').isDisabled(),'folder mode still suspends independent timers');
    await page.selectOption('#checkin-account-choice','0');
    assert.equal(await page.locator('[data-field="note"]').inputValue(),'first edited');
    assert.equal(await page.locator('[data-bot-schedule-time]').inputValue(),'12:34:56');
    await page.locator('[data-checkin-section="checkins"]').click();
    await page.selectOption('.checkin-rule [data-field="timeMode"]','random');
    await page.locator('[data-field="rangeStart"]').fill('10:11:12');
    await page.locator('[data-field="rangeEnd"]').fill('10:11:13');
    assert.equal(await page.locator('[data-planned-kind="checkin"]').getAttribute('data-planned-account'),'first');
    await page.waitForTimeout(2200);
    assert.equal(await page.locator('[data-field="rangeStart"]').inputValue(),'10:11:12','polling preserves plugin drafts');
    await page.locator('#checkin-plugin-editor .save-btn').click();
    await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
    assert.equal(stored.users[0].bots[0].note,'first edited');
    assert.equal(stored.users[0].bots[0].schedule.time,'12:34:56');
    assert.equal(stored.users[0].checkinSchedules[0].rangeStart,'10:11:12');
    assert.equal(stored.users[1].checkinSchedules[0].time,'09:30:15','editing first account cannot modify second');
    assert.equal(stored.users[1].dialogFolder,'saved-folder');
    assert.equal(stored.users[1].discoveredBots[0].command,'/checkin');
    assert.equal(stored.automations.forwardPins[0].name,'Saved forward');
    await page.reload();
    await page.locator('[data-field="rangeStart"]').waitFor();
    assert.equal(await page.locator('#checkin-account-choice').inputValue(),'0');
    assert.equal(await page.locator('[data-field="rangeEnd"]').inputValue(),'10:11:13');
    await screenshot('checkin-feature-schedules');
    await page.locator('[data-checkin-section="bots"]').click();
    await screenshot('checkin-feature-bots');
    await page.locator('[data-field="note"]').fill('draft survives logs');
    await page.locator('#checkin-account-logs').click();
    await page.locator('#account-log-dialog[open]').waitFor();
    assert.equal(await page.locator('#log-filter-account').inputValue(),'first');
    assert.ok(await page.locator('#log-filter-account').isDisabled());
    await page.locator('#account-log-close').click();
    assert.equal(await page.locator('[data-field="note"]').inputValue(),'draft survives logs');
    await page.locator('#checkin-run').click();
    await page.locator('#run-log-dialog[open]').waitFor();
    await page.locator('#run-log-close').click();
    await page.locator('#checkin-run-all').click();
    await page.locator('#run-log-dialog[open]').waitFor();
    await page.locator('#run-log-close').click();
    assert.deepEqual(started,[{account:'first'},{}]);
    await page.locator('#checkin-account-settings').click();
    await page.locator('#account-detail .save-btn').first().click();
    await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();
    assert.equal(stored.users[1].dialogFolder,'saved-folder','saving account credentials cannot clear another account folder');
    await page.locator('[data-view="accounts"]').click();
    await page.locator('[data-view="features"]').click();
    await page.selectOption('#checkin-account-choice','1');
    assert.equal(await page.locator('#checkin-account-choice').inputValue(),'1','feature center selects the execution account');
    await page.locator('#close-checkin').click();
    await page.locator('#open-forward-pin').click();
    assert.ok(await page.locator('#checkin-plugin-editor').isHidden());
    await page.locator('#close-forward-pin').click();
    await page.locator('#open-checkin').click();
    await page.selectOption('#checkin-account-choice','0');
    for (const layout of ['horizontal','vertical']) {
      await page.evaluate(value => {localStorage.setItem('autocheckin-navigation-layout',value);},layout);
      await page.reload();await page.locator('#checkin-run').waitFor();
      for (const width of [1440,1024,768,390,320]) {
        await page.setViewportSize({width,height:950});
        for (const section of ['bots','checkins']) {
          await page.locator(`[data-checkin-section="${section}"]`).click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`${layout} ${width} ${section} fits viewport`);
          if (width===390 && section==='bots') await screenshot('checkin-feature-mobile-'+layout);
        }
      }
    }
    // Deleting an account before the selected one must not attach its editor to a different user.
    await page.setViewportSize({width:1440,height:1000});
    await page.selectOption('#checkin-account-choice','1');
    await page.locator('#checkin-account-settings').click();
    await page.evaluate(() => openAccount(0));
    await page.locator('[data-delete="user"]').click();
    await page.locator('[data-view="features"]').click();
    assert.equal(await page.locator('[data-dialog-folder]').inputValue(),'saved-folder');
    await page.locator('#checkin-plugin-editor .save-btn').click();
    assert.equal(stored.users.length,1);assert.equal(stored.users[0].session,'second');
    // An empty workspace offers account setup and cannot start an empty batch.
    await page.locator('#checkin-account-settings').click();
    await page.locator('[data-delete="user"]').click();
    await page.locator('[data-view="features"]').click();
    await page.locator('#checkin-no-accounts').waitFor();
    assert.ok(await page.locator('#checkin-run-all').isDisabled());
    assert.deepEqual(errors,[]);assert.ok(saves.length>=3);
    console.log('Checkin feature browser PASS: moved entry points, account-owned drafts/save/reload, folder/records preserved, random/seconds, scoped logs, execution, deletion and 20 responsive layouts');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
