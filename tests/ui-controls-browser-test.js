const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  if (!process.env.PLAYWRIGHT_MODULE) { console.log('UI controls browser test skipped: set PLAYWRIGHT_MODULE'); return; }
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox'], executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage({ viewport:{ width:390, height:780 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<form><label><span>时间模式</span><select id="mode"><option value="fixed">固定时间</option><option value="random">每日区间随机</option></select></label><label><span>每日时间</span><input id="time" type="time" step="1" value="09:30:00"></label><label><span>执行日期</span><input id="date" type="date" value="2026-10-07"></label><button type="reset">重置</button></form>');
    await page.addStyleTag({ path:path.join(__dirname, '../public/ui-controls.css') });
    await page.addScriptTag({ path:path.join(__dirname, '../public/ui-controls.js') });
    const trigger = page.getByRole('combobox', { name:'时间模式' });
    await trigger.click();
    await page.getByRole('option', { name:'每日区间随机' }).click();
    assert.equal(await page.locator('#mode').inputValue(), 'random');
    assert.equal(await trigger.innerText(), '每日区间随机');
    await page.getByRole('button', { name:'重置', exact:true }).click();
    await page.waitForFunction(() => document.querySelector('.ui-select-trigger').textContent === '固定时间');
    await trigger.press('ArrowDown');
    await page.getByRole('option', { name:'固定时间' }).press('ArrowDown');
    await page.getByRole('option', { name:'每日区间随机' }).press('Enter');
    assert.equal(await page.locator('#mode').inputValue(), 'random');
    await page.getByRole('button', { name:'选择每日时间' }).click();
    await page.locator('.ui-time-list').nth(2).getByRole('button', { name:'17', exact:true }).click();
    await page.locator('.ui-picker-footer').getByRole('button', { name:'确定', exact:true }).click();
    assert.equal(await page.locator('#time').inputValue(), '09:30:17');
    await page.getByRole('button', { name:'选择每日时间' }).click();
    await page.locator('.ui-time-list').nth(0).getByRole('button', { name:'12', exact:true }).click();
    await page.locator('.ui-picker-footer').getByRole('button', { name:'取消', exact:true }).click();
    assert.equal(await page.locator('#time').inputValue(), '09:30:17', 'cancel preserves value');
    await page.getByRole('button', { name:'选择执行日期' }).click();
    const bounds = await page.locator('.ui-picker:not([aria-hidden="true"])').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'popover fits mobile viewport');
    await page.getByRole('button', { name:'2026-10-10', exact:true }).click();
    await page.locator('.ui-picker-footer').getByRole('button', { name:'确定', exact:true }).click();
    assert.equal(await page.locator('#date').inputValue(), '2026-10-10');
    await trigger.click();
    await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    const confirmation = page.evaluate(() => { window.result = null; UIControls.confirm({ title:'停止任务', message:'确认停止？' }).then(value => { window.result = value; }); });
    await confirmation;
    await page.locator('.ui-confirm-dialog .outline-btn').click();
    await page.waitForFunction(() => window.result === false);
    assert.deepEqual(errors, []);
    console.log('UI controls PASS: dropdown/keyboard/reset, seconds/cancel, calendar/mobile bounds, Escape/focus, themed confirmation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
