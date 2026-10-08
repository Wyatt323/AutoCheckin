// Uses local assets and synthetic API responses; never connects to Telegram.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) { console.log('Polling browser test skipped: set PLAYWRIGHT_MODULE'); return; }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage();
    const errors = [], stateRequests = [], lookups = [];
    page.on('pageerror', error => errors.push(error.message));
    const config = {
      telegram:{ apiId:'', hasApiHash:false }, model:'', providers:[],
      users:['first', 'second'].map((session, sourceIndex) => ({
        name:session, session, sourceIndex, apiId:'', hasApiHash:false, sessionReady:false,
        dialogFolder:'', bots:[], checkinSchedules:[], discoveredBots:[]
      })),
      automations:{ schedules:[], forwards:['first', 'second'].map(account => ({
        id:`rule_${account}`, account, source:'@source_channel', target:'@target_group', enabled:true
      })) }
    };
    const status = { python:'offline', run:{ state:'idle', lines:[] }, automation:{ status:'idle', lines:[] }, checkinScheduler:{ events:[], planned:[] } };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ contentType:'application/json', body:JSON.stringify(body) });
      if (url.pathname === '/api/state') {
        stateRequests.push(url.search);
        return json(url.searchParams.get('config') === '0' ? status : { ...status, config });
      }
      if (url.pathname === '/api/accounts/chats/resolve') {
        const input = route.request().postDataJSON();
        lookups.push(input);
        if (input.peers.includes('@slow_channel')) await new Promise(resolve => setTimeout(resolve, 1100));
        return json({ results:input.peers.map(value => ({ value, status:'ok', title:`${input.account}:${value}`, id:'-100123', type:'channel' })) });
      }
      if (url.pathname.startsWith('/api/')) return json({ login:{ active:false, state:'idle' }, runs:[], revision:0 });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return route.abort();
      const target = file === 'checkin-results.js' ? path.join(__dirname, '../checkin_results.js') : path.join(__dirname, '../public', file);
      if (!fs.existsSync(target)) return route.abort();
      return route.fulfill({ body:fs.readFileSync(target), contentType:({ '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml' })[path.extname(file)] });
    });
    await page.goto('http://autocheckin-offline.test/');
    await page.locator('#stat-users').filter({ hasText:'2' }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(lookups.length, 0, 'overview never resolves hidden forwarding rules');
    await page.locator('[data-view="accounts"]').click();
    await page.locator('[data-open-account="0"][data-section="bots"]').click();
    await page.waitForTimeout(800);
    assert.equal(lookups.length, 0, 'Bot tab never resolves hidden forwarding rules');
    await page.locator('[data-account-section="forwards"]').click();
    const badge = page.locator('#forward-list [data-peer-name]').first();
    await badge.filter({ hasText:'first:@source_channel' }).waitFor();
    const source = page.locator('#forward-list input[data-field="source"]');
    await source.fill('@draft_channel');
    await page.locator('[data-account-section="bots"]').click();
    const count = lookups.length;
    await page.waitForTimeout(800);
    assert.equal(lookups.length, count, 'leaving the tab cancels the pending debounce');
    await page.locator('[data-account-section="forwards"]').click();
    await badge.filter({ hasText:'first:@draft_channel' }).waitFor();
    await page.waitForTimeout(2200);
    assert.equal(await source.inputValue(), '@draft_channel', 'status polling preserves unsaved input');
    assert.equal(stateRequests.filter(query => query === '').length, 1, 'configuration is loaded once');
    assert.ok(stateRequests.includes('?config=0'), 'regular polls request status only');

    await source.fill('@slow_channel');
    await page.waitForRequest(request => request.url().endsWith('/api/accounts/chats/resolve'));
    await page.locator('#account-back').click();
    await page.locator('[data-open-account="1"][data-section="forwards"]').click();
    await badge.filter({ hasText:'second:@source_channel' }).waitFor();
    assert.ok(!(await badge.textContent()).includes('first'), 'slow old-account response cannot overwrite current account');

    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable:true, value:true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(100);
    const polls = stateRequests.length;
    await page.waitForTimeout(2200);
    assert.equal(stateRequests.length, polls, 'hidden page stops status polling');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForResponse(response => response.url().includes('/api/state?config=0'));
    assert.deepEqual(errors, []);
    console.log('Polling browser PASS: status-only responses, hidden tab/page suppression, preserved drafts, account isolation and resume');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
