// Offline UI regression: historical scheduler events must not imply an enabled task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) { console.log('Checkin status browser test skipped: set PLAYWRIGHT_MODULE'); return; }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let failSave = false;
    const ruleWrites = [];
    let config = {
      telegram:{ apiId:'', hasApiHash:false }, model:'', providers:[],
      users:[{
        name:'测试账号', session:'test', sourceIndex:0, apiId:'', hasApiHash:false, sessionReady:false,
        botSource:'configured', dialogFolder:'', discoveredBots:[],
        bots:[{ name:'@test_bot', mode:'command', command:'/sign', schedule:{ enabled:false, time:'09:00' } }],
        checkinSchedules:[{ id:'daily', enabled:false, repeat:'daily', time:'00:00:02', timeMode:'fixed' }]
      }],
      automations:{ schedules:[], forwards:[] }
    };
    const status = {
      python:'offline', run:{ state:'idle', lines:[] }, automation:{ status:'idle', lines:[] },
      checkinScheduler:{ planned:[], events:[{ account:'test', message:'定时签到已启动', level:'info', time:'2026-10-06T16:00:02Z' }] }
    };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ contentType:'application/json', body:JSON.stringify(body) });
      if (url.pathname === '/api/state') return json(url.searchParams.get('config') === '0' ? status : { ...status, config });
      if (url.pathname === '/api/rules') {
        const input = route.request().postDataJSON();
        assert.equal(route.request().method(), 'PATCH');
        assert.equal(input.kind, 'checkin');
        const user = config.users.find(user => user.session === input.account);
        const rule = user.checkinSchedules.find(rule => rule.id === input.id);
        ruleWrites.push(input);
        if (failSave) return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({ error:'模拟保存失败' }) });
        rule.enabled = input.enabled;
        return json({ ...status, rule });
      }
      if (url.pathname === '/api/config') {
        if (failSave) return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({ error:'模拟保存失败' }) });
        config = route.request().postDataJSON();
        return json({ ...status, config });
      }
      if (url.pathname.startsWith('/api/')) return json({ login:{ active:false, state:'idle' }, runs:[], revision:0 });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return route.abort();
      const target = file === 'checkin-results.js' ? path.join(__dirname, '../checkin_results.js') : path.join(__dirname, '../public', file);
      if (!fs.existsSync(target)) return route.abort();
      return route.fulfill({ body:fs.readFileSync(target), contentType:({ '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[path.extname(file)] });
    });
    await page.goto('http://autocheckin-offline.test/#accounts');
    const card = page.locator('.account-tile-activity');
    await card.locator('strong').filter({ hasText:'账号定时已关闭' }).waitFor();
    assert.ok((await card.locator('small').textContent()).startsWith('上次调度：定时签到已触发'));
    assert.ok(!(await card.textContent()).includes('已启动'));
    await page.locator('[data-view="features"]').click();if(await page.locator('#feature-catalog').isVisible())await page.locator('#open-checkin').click();await page.selectOption('#checkin-account-choice','0');
    await page.locator('[data-checkin-section="checkins"]').click();
    const hint = page.locator('.checkin-status');
    assert.ok((await hint.textContent()).startsWith('账号定时已关闭'));
    const toggle = page.locator('.checkin-rule [data-field="enabled"]');
    const switchRule = async () => {
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/rules') && response.request().method() === 'PATCH'),
        page.locator('.checkin-rule .auto-switch').click()
      ]);
      await page.waitForFunction(() => !savingConfig);
    };
    await switchRule();
    assert.deepEqual(ruleWrites.at(-1), { kind:'checkin', id:'daily', account:'test', enabled:true });
    assert.equal(config.users[0].checkinSchedules[0].enabled, true, 'saved switch persists immediately');
    assert.ok((await hint.textContent()).includes('账号定时已启用 · 1 个任务'));
    assert.ok(!(await hint.textContent()).includes('未保存'));
    await page.waitForTimeout(2200);
    assert.ok(await toggle.isChecked(), 'polling must preserve saved switch');
    assert.ok(!(await hint.textContent()).includes('未保存'), 'saved switch stays clean after polling');
    failSave = true;
    await switchRule();
    await page.locator('#toast').filter({ hasText:'模拟保存失败' }).waitFor();
    assert.ok(await toggle.isChecked(), 'failed switch rolls back to persisted state');
    assert.equal(config.users[0].checkinSchedules[0].enabled, true);
    assert.ok((await hint.textContent()).startsWith('账号定时已启用'));
    assert.ok(!(await hint.textContent()).includes('未保存'), 'rolled-back switch is not a draft');
    failSave = false;
    await switchRule();
    assert.equal(config.users[0].checkinSchedules[0].enabled, false);
    assert.ok((await hint.textContent()).startsWith('账号定时已关闭'));
    assert.ok(!(await hint.textContent()).includes('未保存'));

    // Independent Bot schedules still require a save: polling and failed saves retain this draft.
    await page.locator('[data-checkin-section="bots"]').click();
    await page.locator('.bot-schedule-switch').click();
    await page.locator('[data-checkin-section="checkins"]').click();
    await page.waitForTimeout(2200);
    assert.ok((await hint.textContent()).includes('账号定时已关闭 · 1 个 Bot 独立定时已启用'));
    assert.ok((await hint.textContent()).includes('未保存'), 'polling must preserve unsaved Bot hint');
    assert.equal(config.users[0].bots[0].schedule.enabled, false, 'Bot switch remains a draft');
    await page.locator('[data-checkin-section="bots"]').click();
    assert.ok(await page.locator('.bot-schedule-switch input').isChecked(), 'polling must preserve draft Bot switch');
    const save = page.locator('.save-btn:visible').first();
    failSave = true;
    await save.click();
    await page.locator('#toast').filter({ hasText:'模拟保存失败' }).waitFor();
    await page.locator('[data-checkin-section="checkins"]').click();
    assert.ok((await hint.textContent()).includes('未保存'), 'failed save preserves draft hint');
    failSave = false;
    await save.click();
    await page.locator('#toast').filter({ hasText:'配置已保存' }).waitFor();
    await page.locator('[data-checkin-section="checkins"]').click();
    assert.ok((await hint.textContent()).includes('账号定时已关闭 · 1 个 Bot 独立定时已启用'));
    await page.evaluate(() => { config.users[0].botSource = 'folder'; renderConfig(); });
    assert.ok(!(await hint.textContent()).includes('Bot 独立定时已启用'), 'folder mode ignores independent Bot rules');
    await page.evaluate(() => { config.users[0].botSource = 'configured'; renderConfig(); });

    // Current run state is refreshed in the account card without rerendering editors.
    await page.locator('[data-view="accounts"]').click();
    status.run = { state:'running', account:'test', lines:[] };
    await card.locator('strong').filter({ hasText:'当前签到运行中' }).waitFor();
    status.run = { state:'completed', account:'test', lines:[] };
    await page.waitForTimeout(2200);
    assert.ok(!(await card.textContent()).includes('当前签到运行中'));
    status.checkinScheduler.events.push({ account:'test', message:'定时签到启动失败：测试', level:'error', time:'2026-10-07T01:00:00Z' });
    await card.locator('small').filter({ hasText:'启动失败：测试' }).waitFor();
    await page.reload();
    await card.locator('strong').filter({ hasText:'账号定时已关闭' }).waitFor();
    assert.ok(!(await card.textContent()).includes('未保存'), 'saved disabled state survives reload');
    assert.deepEqual(errors, []);
    console.log('Checkin status browser PASS: disabled state, labeled history, draft/save/failure, independent Bots, folder precedence and live polling');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
