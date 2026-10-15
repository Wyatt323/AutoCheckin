// Actual frontend with an offline API: folding must never discard or submit a draft.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  if(!process.env.PLAYWRIGHT_MODULE){console.log('Rule cards browser skipped: set PLAYWRIGHT_MODULE');return;}
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[],saves=[];
    page.on('pageerror',error=>errors.push(error.message));
    let stored={telegram:{apiId:'',hasApiHash:false},model:'',providers:[],users:['Labubu','second'].map((session,index)=>({
      name:session,session,sourceIndex:index,sessionReady:true,apiId:'',hasApiHash:false,botSource:'configured',dialogFolder:'',
      bots:[{name:'@checkin_bot',mode:'command',command:'/sign',note:'签到 Bot'}],
      checkinSchedules:[{id:'daily_'+session,enabled:true,repeat:'daily',timeMode:'fixed',time:'09:30:15'}]
    })),automations:{forwards:[],schedules:[{id:'message_1',enabled:true,account:'Labubu',repeat:'daily',timeMode:'fixed',time:'10:00:20',target:'@announcements',message:'原始消息\n完整保留'}],
      forwardPins:[{id:'forward_1',enabled:true,name:'重要通知同步',account:'Labubu',sources:['@source'],target:'@announcements',keywords:['通知'],pinAfterForward:true}],
      redPackets:[1,2].map(id=>({id:'packet_'+id,enabled:true,name:id===1 ? '牛币群红包' : '交流群红包',account:'Labubu',groups:['-1001234567'],botUsername:'@example_bot',watchSeconds:120,retryInterval:0.5,buttonKeywords:[],successKeywords:[],emptyKeywords:[]}))},
      plugins:{zeroSpeakers:[{id:'cleanup_1',name:'群成员检查',account:'Labubu',group:'@members'}]}};
    const status={python:'offline',run:{state:'idle',lines:[]},automation:{status:'running',message:'离线测试监听',lines:[],redPackets:{Labubu:{groups:[{ruleIds:['packet_1','packet_2'],received:12,commands:2,packets:2,fallbackChecks:5}]}}},checkinScheduler:{events:[],planned:[]}};
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/state')return json(url.searchParams.get('config')==='0' ? status : {...status,config:stored});
      if(url.pathname==='/api/config'){stored=route.request().postDataJSON();saves.push(structuredClone(stored));return json({...status,config:stored});}
      if(url.pathname==='/api/accounts/chats/resolve')return json({results:route.request().postDataJSON().peers.map(value=>({value,status:'ok',title:value==='-1001234567' ? '示例红包群' : '示例频道',id:-1001234567,type:'group'}))});
      if(url.pathname.startsWith('/api/'))return json({login:{active:false,state:'idle'},records:[],revision:0});
      const file=url.pathname==='/' ? 'index.html' : url.pathname.slice(1);
      if(!/^[\w.-]+$/.test(file))return route.abort();
      const target=file==='checkin-results.js' ? path.join(__dirname,'../checkin_results.js') : path.join(__dirname,'../public',file);
      if(!fs.existsSync(target))return route.abort();
      return route.fulfill({body:fs.readFileSync(target),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]});
    });
    const screenshot=async name=>{if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,name+'.png'),fullPage:true});};
    const toggle=card=>card.locator('[data-rule-toggle]');
    const isOpen=async(card,value)=>assert.equal(await toggle(card).getAttribute('aria-expanded'),String(value));
    const save=async selector=>{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/config')&&r.request().method()==='POST'),page.locator(selector+' .save-btn:visible').first().click()]);await page.locator('#toast').filter({hasText:'配置已保存'}).waitFor();};
    const catalog=async close=>{await page.locator(close).click();await page.locator('#feature-catalog').waitFor();};
    const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'rules fit mobile viewport');
    await page.goto('https://autocheckin-offline.test/#features');
    await page.locator('#open-red-packet').click();
    const packets=page.locator('#red-packet-rules'),first=packets.locator('[data-red-packet-rule]').first();
    await isOpen(first,false);
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.inert),true);
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.getBoundingClientRect().height),0);
    assert.match(await toggle(first).innerText(),/Labubu.*1 个群组/);
    assert.ok(await first.locator('[data-red-packet-runtime]').isVisible(),'connection status remains visible');
    await toggle(first).focus();await page.keyboard.press('Enter');await isOpen(first,true);
    await first.locator('[data-red-packet-field="name"]').fill('牛币群红包 · 已修改');
    await first.locator('.red-packet-options summary').click();await first.locator('[data-red-packet-field="watchSeconds"]').fill('180');
    await first.locator('[data-red-packet-words="buttonKeywords"]').fill('领取红包\n领取');
    await first.locator('[data-red-packet-add-group]').click();
    await isOpen(first,true);
    await first.locator('[data-red-packet-group]').last().fill('@another_group');
    await toggle(first).click();await isOpen(first,false);
    await page.waitForTimeout(2100);
    assert.equal(saves.length,0,'folding and polling never save config');
    assert.equal(await first.locator('[data-red-packet-field="watchSeconds"]').inputValue(),'180');
    await toggle(first).focus();await first.locator('[data-red-packet-field="name"]').evaluate(el=>el.focus());
    assert.equal(await toggle(first).evaluate(el=>el===document.activeElement),true,'collapsed fields cannot receive focus');
    await first.locator('.auto-switch').click();await isOpen(first,false);
    await packets.locator('[data-rules-expand]').click();await isOpen(first,true);
    assert.equal(await first.locator('[data-red-packet-group]').last().inputValue(),'@another_group');
    await packets.locator('[data-rules-collapse]').click();await isOpen(first,false);
    await catalog('#close-red-packet');await page.locator('#open-red-packet').click();await isOpen(first,false);
    await page.locator('#add-red-packet').click();
    const added=packets.locator('[data-red-packet-rule]').last();await isOpen(added,true);await isOpen(first,false);
    await added.locator('[data-red-packet-field="name"]').fill('新规则');await added.locator('[data-red-packet-group]').fill('@new_group');
    await save('#red-packet-editor');await isOpen(added,false);
    assert.equal(stored.automations.redPackets[0].name,'牛币群红包 · 已修改');assert.equal(stored.automations.redPackets[0].enabled,false);
    assert.equal(stored.automations.redPackets[0].watchSeconds,180);assert.deepEqual(stored.automations.redPackets[0].buttonKeywords,['领取红包','领取']);
    assert.deepEqual(stored.automations.redPackets[0].groups,['-1001234567','@another_group']);
    await screenshot('rule-cards-desktop-collapsed');
    await catalog('#close-red-packet');await page.locator('#open-forward-pin').click();
    const forward=page.locator('[data-feature-rule]').first();await isOpen(forward,false);
    assert.match(await toggle(forward).innerText(),/重要通知同步/);await toggle(forward).click();
    await forward.locator('[data-feature-add-keyword]').click();await isOpen(forward,true);
    await forward.locator('[data-feature-keyword]').last().fill('测试');await toggle(forward).click();await toggle(forward).click();
    assert.equal(await forward.locator('[data-feature-keyword]').last().inputValue(),'测试');await save('#forward-pin-editor');await isOpen(forward,false);
    await catalog('#close-forward-pin');await page.locator('#open-zero-speakers').click();
    const cleanup=page.locator('[data-cleanup-rule]').first();await isOpen(cleanup,false);
    assert.ok(await cleanup.locator('[data-cleanup-run]').isVisible(),'cleanup actions remain visible when folded');
    await toggle(cleanup).click();await cleanup.locator('[data-cleanup-field="name"]').fill('检查任务草稿');
    await toggle(cleanup).click();await toggle(cleanup).click();assert.equal(await cleanup.locator('[data-cleanup-field="name"]').inputValue(),'检查任务草稿');
    await save('#zero-speakers-editor');await isOpen(cleanup,false);
    await catalog('#close-zero-speakers');await page.locator('#open-checkin').click();await page.locator('[data-checkin-section="checkins"]').click();
    const checkin=page.locator('.checkin-rule').first();await isOpen(checkin,false);await toggle(checkin).click();
    await page.selectOption('.checkin-rule [data-field="timeMode"]','random');await isOpen(checkin,true);
    await checkin.locator('[data-field="rangeStart"]').fill('11:12:13');await checkin.locator('[data-field="rangeEnd"]').fill('12:13:14');
    await toggle(checkin).click();assert.match(await toggle(checkin).innerText(),/11:12:13–12:13:14/);
    await page.selectOption('#checkin-account-choice','1');await isOpen(checkin,false);
    await page.selectOption('#checkin-account-choice','0');await isOpen(checkin,false);
    await toggle(checkin).click();assert.equal(await checkin.locator('[data-field="rangeEnd"]').inputValue(),'12:13:14');
    await save('#checkin-plugin-editor');await isOpen(checkin,false);
    assert.equal(stored.users[1].checkinSchedules[0].time,'09:30:15','other account schedules are untouched');
    await page.locator('#checkin-account-settings').click();await page.locator('[data-account-section="messages"]').click();
    const message=page.locator('#schedule-list article').first();await isOpen(message,false);await toggle(message).click();
    await message.locator('[data-auto-select][data-field="repeat"]').click();await page.locator('[data-auto-option="once"]').click();
    assert.equal(await message.locator('[data-field="time"]').getAttribute('type'),'datetime-local');
    await message.locator('[data-field="time"]').fill('2029-01-02T10:20:31');
    await message.locator('[data-field="message"]').fill('修改消息\n完整保留');
    await toggle(message).click();await toggle(message).click();assert.equal(await message.locator('[data-field="message"]').inputValue(),'修改消息\n完整保留');
    await save('#account-detail');await isOpen(message,false);assert.equal(stored.automations.schedules[0].message,'修改消息\n完整保留');
    await page.setViewportSize({width:390,height:844});await noOverflow();await toggle(message).click();await noOverflow();
    await page.locator('[data-view="features"]').click();await page.locator('#close-checkin').click();await page.locator('#open-red-packet').click();
    await noOverflow();await screenshot('rule-cards-mobile-collapsed');
    await toggle(first).click();await noOverflow();await screenshot('rule-cards-mobile-expanded');
    await page.setViewportSize({width:1440,height:1100});await screenshot('rule-cards-desktop-expanded');
    await page.emulateMedia({reducedMotion:'no-preference'});
    assert.notEqual(await first.locator('.rule-card-body').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    await toggle(first).click();await page.waitForTimeout(300);
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.getBoundingClientRect().height),0);
    await page.reload();await page.locator('#open-red-packet').click();await isOpen(first,false);
    assert.deepEqual(errors,[]);
    console.log('Rule cards PASS: all five editors, saved/new defaults, keyboard/inert, drafts and polling, rerenders/account switching, bulk controls, saved payloads, runtime visibility, animation and mobile layout');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
