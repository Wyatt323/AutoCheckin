// Synthetic API with real local UI assets; no Telegram or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) {console.log('Concurrency browser test skipped: set PLAYWRIGHT_MODULE');return;}
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const page = await browser.newPage({reducedMotion:'reduce'}), errors = [], requests = [], stopped = [];
    page.on('pageerror', error => errors.push(error.message));
    const records = [];
    const config = {telegram:{apiId:'',hasApiHash:false},model:'',providers:[],
      users:['first','second','third'].map((session,sourceIndex) => ({name:session,session,sourceIndex,apiId:'',hasApiHash:false,sessionReady:true,
        profile:{userId:String(sourceIndex+1),dcId:1},dialogFolder:'',discoveredBots:[],
        bots:[{name:'@offline_bot',mode:'command',command:'/sign',schedule:{enabled:false,time:'09:00'}}],checkinSchedules:[]})),
      automations:{schedules:[],forwards:[]}};
    const status = () => {
      const activeRuns = records.filter(run => run.state === 'running');
      return {run:records.at(-1) || {state:'idle',lines:[]},activeRuns,busyAccounts:activeRuns.map(run => run.account),python:'offline',
        automation:{status:'idle',lines:[]},checkinScheduler:{events:[],planned:[]}};
    };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if (url.pathname === '/api/state') return json(url.searchParams.get('config') === '0' ? status() : {...status(),config});
      if (url.pathname === '/api/run') {
        const {account} = route.request().postDataJSON();requests.push(account);
        const run = {id:'run-'+account,account,accounts:[account],trigger:'manual',state:'running',startedAt:new Date().toISOString(),
          accountStates:{[account]:'running'},lines:[{id:1,text:account+' only',account,stream:'stdout',time:new Date().toISOString()}]};
        records.push(run);return json({ok:true,run});
      }
      if (url.pathname === '/api/runs') return json({revision:records.reduce((n,run) => n+(run.state === 'running' ? 1 : 10),0),records});
      if (url.pathname === '/api/stop') {
        const {id} = route.request().postDataJSON();stopped.push(id);
        const run = records.find(item => item.id === id);run.state='stopped';run.finishedAt=new Date().toISOString();return json({ok:true});
      }
      if (url.pathname.startsWith('/api/')) return json({login:{active:false,state:'idle'},records:[],revision:0});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return route.abort();
      const target = file === 'checkin-results.js' ? path.join(__dirname,'../checkin_results.js') : path.join(__dirname,'../public',file);
      if (!fs.existsSync(target)) return route.abort();
      return route.fulfill({body:fs.readFileSync(target),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]});
    });
    await page.goto('http://autocheckin-offline.test/#accounts');
    await page.locator('[data-run-account="0"]').click();
    await page.locator('#run-log-dialog[open]').waitFor();
    await page.locator('#run-log-close').click();
    assert.ok(await page.locator('[data-run-account="0"]').isDisabled());
    assert.ok(await page.locator('[data-run-account="1"]').isEnabled(),'another account stays runnable during a task');
    await page.locator('[data-run-account="1"]').click();
    await page.locator('#run-log-dialog[open]').waitFor();
    await page.locator('#run-log-output').filter({hasText:'second only'}).waitFor();
    assert.ok(!(await page.locator('#run-log-output').innerText()).includes('first only'),'modal follows selected task ID');
    await page.locator('#run-log-close').click();
    await page.waitForFunction(() => document.querySelector('#stat-status').textContent === '2 个账号签到中');
    assert.ok(await page.locator('[data-run-account="0"]').isDisabled());
    assert.ok(await page.locator('[data-run-account="1"]').isDisabled());
    assert.ok(await page.locator('[data-run-account="2"]').isEnabled());
    assert.ok(await page.locator('#hero-run').isDisabled(),'batch cannot overlap its accounts');
    assert.ok(await page.locator('.save-btn').first().isDisabled(),'configuration is protected during concurrent tasks');
    for (const index of [0,1]) assert.ok((await page.locator(`[data-account-index="${index}"] .account-tile-activity`).innerText()).includes('当前签到运行中'));
    await page.evaluate(() => openRunLog(activeRunRecords.find(run => run.account === 'first')));
    await page.locator('#run-log-output').filter({hasText:'first only'}).waitFor();
    await page.locator('#run-log-stop').click();
    await page.locator('.ui-confirm-dialog').getByRole('button',{name:'停止任务',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#stat-status').textContent === '1 个账号签到中');
    assert.deepEqual(stopped,['run-first']);
    assert.equal(records.find(run => run.account === 'second').state,'running');
    await page.locator('#run-log-close').click();
    await page.reload();
    await page.locator('[data-run-account="1"]').waitFor();
    assert.ok(await page.locator('[data-run-account="1"]').isDisabled(),'reload preserves active account state');
    assert.ok(await page.locator('[data-run-account="0"]').isEnabled());
    assert.ok(await page.locator('[data-run-account="2"]').isEnabled());
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(requests,['first','second']);assert.deepEqual(errors,[]);
    console.log('Concurrency browser PASS: account-specific buttons/status, simultaneous runs, isolated live modal, targeted stop, reload and mobile');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
