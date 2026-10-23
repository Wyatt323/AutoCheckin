// Actual frontend with an offline API: folding must never discard or submit a draft.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  if(!process.env.PLAYWRIGHT_MODULE){console.log('Rule cards browser skipped: set PLAYWRIGHT_MODULE');return;}
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[],saves=[],queries=[];
    let saveFailure=false,failAfterCommit=false,releaseSave=null,holdSave=false;
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
      if(url.pathname==='/api/rules'){
        const input=route.request().postDataJSON();
        if(saveFailure)return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'offline validation error'})});
        if(holdSave)await new Promise(resolve=>releaseSave=resolve);
        const list=input.kind==='checkin' ? stored.users.find(user=>user.session===input.account).checkinSchedules : input.kind==='cleanup' ? stored.plugins.zeroSpeakers : stored.automations[({packet:'redPackets',forward:'forwardPins',message:'schedules'})[input.kind]];
        const index=list.findIndex(rule=>rule.id===input.id);
        if(route.request().method()==='DELETE')list.splice(index,1);
        else if(route.request().method()==='PATCH')list[index]={...list[index],enabled:input.enabled};
        else if(index<0)list.push(input.rule);else list[index]=input.rule;
        saves.push({...input,method:route.request().method()});
        if(failAfterCommit)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'offline response failure'})});
        return json({...status,rule:list.find(rule=>rule.id===input.id) || null});
      }
      if(url.pathname==='/api/runs'){
        queries.push(url.search);
        // Deliberately return unrelated records too: browser filters must still isolate the rule.
        return json({revision:1,records:['packet_1','packet_2'].map((ruleId,index)=>({id:'run_'+index,ruleId,account:'Labubu',category:'red_packet',state:'completed',trigger:'automatic',lines:[{time:'2026-10-15T00:00:00Z',stream:'system',text:'only '+ruleId}]}))});
      }
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
    const save=async card=>{if(await toggle(card).getAttribute('aria-expanded')==='false')await toggle(card).click();await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/rules')&&r.request().method()==='POST'),card.locator('[data-rule-save]').click()]);await page.waitForFunction(()=>!savingConfig);};
    const switchRule=async card=>{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/rules')&&r.request().method()==='PATCH'),card.locator('.automation-card-actions .auto-switch').click()]);await page.waitForFunction(()=>!savingConfig);};
    const catalog=async close=>{await page.locator(close).click();await page.locator('#feature-catalog').waitFor();};
    const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'rules fit mobile viewport');
    const compactHeader=async(card,name)=>{
      const layout=await card.evaluate(card=>{
        const head=card.querySelector('.automation-card-head,.checkin-rule-head'),toggle=head.querySelector('[data-rule-toggle]');
        const center=el=>{const rect=el.getBoundingClientRect();return rect.top+rect.height/2;};
        const actions=[...card.querySelectorAll('[data-rule-logs],.delete-btn,[data-cleanup-run],[data-cleanup-stop],[data-cleanup-report]')].filter(el=>el.getClientRects().length && !el.hidden);
        return {inHeader:actions.every(el=>head.contains(el)),sameRow:actions.every(el=>Math.abs(center(el)-center(toggle))<2),
          statusInHeader:head.contains(card.querySelector('[data-rule-save-status]')),
          saveInBody:card.querySelector('.rule-card-body').contains(card.querySelector('[data-rule-save]')),
          runtimeBeforeBody:!card.querySelector('.cleanup-rule-runtime') || Boolean(card.querySelector('.cleanup-rule-runtime').compareDocumentPosition(card.querySelector('.rule-card-body')) & Node.DOCUMENT_POSITION_FOLLOWING)};
      });
      assert.deepEqual(layout,{inHeader:true,sameRow:true,statusInHeader:true,saveInBody:true,runtimeBeforeBody:true},name+' keeps actions on one desktop row and save inside configuration');
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await card.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'rule-card-'+name+'.png')});
      await toggle(card).click();await isOpen(card,true);
      if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await card.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'rule-card-'+name+'-expanded.png')});
      for(const width of [390,768]){await page.setViewportSize({width,height:844});await noOverflow();}
      await page.setViewportSize({width:1440,height:1100});
      await toggle(card).click();await isOpen(card,false);
    };
    const packetFormLayout=async(card,width,columns)=>{
      await page.setViewportSize({width,height:1100});await noOverflow();
      await card.locator('.peer-name.resolved').first().waitFor();
      const layout=await card.evaluate(card=>{
        const grid=card.querySelector('.packet-rule-fields'),fields=[...grid.querySelectorAll(':scope > label')].map(el=>el.getBoundingClientRect());
        const row=card.querySelector('.peer-input-row').getBoundingClientRect(),badge=card.querySelector('.peer-name.resolved').getBoundingClientRect();
        const runtime=card.querySelector('[data-red-packet-runtime]'),state=runtime.querySelector('strong').getBoundingClientRect(),metrics=runtime.querySelector('.rule-runtime-metrics').getBoundingClientRect();
        return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,tops:fields.map(rect=>rect.top),
          groupsBelowFields:row.top>=Math.max(...fields.map(rect=>rect.bottom)),
          badgeInsideInput:badge.left>row.left && badge.right<row.right && badge.top>row.top && badge.bottom<row.bottom,
          runtimeOnOneRow:Math.abs(state.top+state.height/2-metrics.top-metrics.height/2)<2};
      });
      assert.equal(layout.columns,columns,width+'px packet form column count');
      assert.equal(layout.groupsBelowFields,true,'groups occupy their own row');
      assert.equal(layout.badgeInsideInput,true,'resolved group name stays inside the input frame');
      if(columns===3)assert.ok(layout.tops.every(top=>Math.abs(top-layout.tops[0])<2),'name, account and bot align on one desktop row');
      if(columns===2){assert.ok(Math.abs(layout.tops[0]-layout.tops[1])<2);assert.ok(layout.tops[2]>layout.tops[1]);}
      if(columns===1)assert.ok(layout.tops[0]<layout.tops[1] && layout.tops[1]<layout.tops[2],'mobile fields stack in order');
      if(width===1440)assert.equal(layout.runtimeOnOneRow,true,'connection state and metrics share one desktop row');
    };
    await page.goto('https://autocheckin-offline.test/#features');
    await page.locator('#open-red-packet').click();
    const packets=page.locator('#red-packet-rules'),first=packets.locator('[data-red-packet-rule]').first();
    await isOpen(first,false);
    await compactHeader(first,'red-packet');
    const layoutExample=packets.locator('[data-red-packet-rule]').nth(1);
    await toggle(layoutExample).click();
    for(const [width,columns] of [[1440,3],[768,2],[390,1]])await packetFormLayout(layoutExample,width,columns);
    await page.setViewportSize({width:1440,height:1100});
    await layoutExample.locator('[data-red-packet-field="name"]').fill('交流群红包 · 每日红包');
    assert.equal(await layoutExample.locator('[data-rule-save]').isEnabled(),true);
    if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR){
      await layoutExample.locator('[data-red-packet-field="name"]').blur();
      await packets.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,'rule-cards-actual-layout.png')});
    }
    await layoutExample.locator('[data-red-packet-field="name"]').fill('交流群红包');
    await toggle(layoutExample).click();
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.inert),true);
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.getBoundingClientRect().height),0);
    assert.match(await toggle(first).innerText(),/Labubu.*1 个群组/);
    assert.ok(await first.locator('[data-red-packet-runtime]').isVisible(),'connection status remains visible');
    assert.equal(await first.locator('[data-rule-save]').isVisible(),false,'save button folds with configuration');
    assert.equal(await first.locator('[data-rule-logs]').isVisible(),true,'logs remain available while collapsed');
    await toggle(first).focus();await page.keyboard.press('Enter');await isOpen(first,true);
    assert.equal(await first.locator('[data-rule-save]').isDisabled(),true,'unchanged content does not need saving');
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
    await switchRule(first);await isOpen(first,false);
    assert.equal(stored.automations.redPackets[0].enabled,false,'switch immediately persists disabled state');
    assert.deepEqual(saves.at(-1),{kind:'packet',id:'packet_1',enabled:false,method:'PATCH'},'switch submits only enabled state');
    assert.equal(stored.automations.redPackets[0].name,'牛币群红包','switch never submits this rule draft');
    assert.equal(stored.automations.redPackets[0].watchSeconds,120);
    assert.match(await first.locator('[data-red-packet-runtime] strong').innerText(),/规则已关闭/);
    assert.doesNotMatch(await first.locator('[data-red-packet-runtime] strong').innerText(),/保存后生效/);
    saveFailure=true;await switchRule(first);
    assert.equal(await first.locator('[data-red-packet-field="enabled"]').isChecked(),false,'failed switch rolls back');
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'牛币群红包 · 已修改','failed switch retains draft');
    saveFailure=false;failAfterCommit=true;await switchRule(first);
    assert.equal(stored.automations.redPackets[0].enabled,true);
    assert.equal(await first.locator('[data-red-packet-field="enabled"]').isChecked(),true,'failed response reconciles actual committed state');
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'牛币群红包 · 已修改','reconciliation preserves content draft');
    failAfterCommit=false;await switchRule(first);
    holdSave=true;const switching=switchRule(first);switching.catch(()=>{});
    await page.waitForFunction(()=>Boolean(togglingRuleKey));
    assert.equal(await first.locator('[data-red-packet-field="enabled"]').isDisabled(),true,'disable repeated clicks while saving state');
    while(!releaseSave)await new Promise(resolve=>setTimeout(resolve,10));
    await toggle(first).click();await first.locator('[data-red-packet-field="name"]').fill('切换请求中的草稿');
    holdSave=false;releaseSave();await switching;releaseSave=null;
    assert.equal(stored.automations.redPackets[0].enabled,true,'switch immediately enables saved rule');
    assert.equal(stored.automations.redPackets[0].name,'牛币群红包','in-flight edits never enter switch request');
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'切换请求中的草稿','in-flight switch preserves new edits');
    await isOpen(first,true);await first.locator('[data-red-packet-field="name"]').fill('牛币群红包 · 已修改');await toggle(first).click();
    await switchRule(first);assert.equal(stored.automations.redPackets[0].enabled,false);
    await packets.locator('[data-rules-expand]').click();await isOpen(first,true);
    assert.equal(await first.locator('[data-red-packet-group]').last().inputValue(),'@another_group');
    await packets.locator('[data-rules-collapse]').click();await isOpen(first,false);
    await catalog('#close-red-packet');await page.locator('#open-red-packet').click();await isOpen(first,false);
    await page.locator('#add-red-packet').click();
    const added=packets.locator('[data-red-packet-rule]').last();await isOpen(added,true);await isOpen(first,false);
    const beforeNewSwitch=saves.length;await added.locator('.auto-switch').click();
    assert.equal(saves.length,beforeNewSwitch,'new rule remains a draft until first save');
    await added.locator('[data-red-packet-field="name"]').fill('新规则');await added.locator('[data-red-packet-group]').fill('@new_group');
    await save(added);await isOpen(added,false);
    assert.equal(stored.automations.redPackets[0].name,'牛币群红包','saving new rule leaves another draft uncommitted');
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'牛币群红包 · 已修改','another draft survives rerender');
    await save(first);await isOpen(first,false);
    assert.equal(stored.automations.redPackets[0].name,'牛币群红包 · 已修改');assert.equal(stored.automations.redPackets[0].enabled,false);
    assert.equal(await first.locator('[data-rule-save]').isDisabled(),true);
    assert.equal(stored.automations.redPackets[0].watchSeconds,180);assert.deepEqual(stored.automations.redPackets[0].buttonKeywords,['领取红包','领取']);
    assert.deepEqual(stored.automations.redPackets[0].groups,['-1001234567','@another_group']);
    await screenshot('rule-cards-desktop-collapsed');
    await catalog('#close-red-packet');await page.locator('#open-forward-pin').click();
    const forward=page.locator('[data-feature-rule]').first();await isOpen(forward,false);
    await compactHeader(forward,'forward');
    assert.match(await toggle(forward).innerText(),/重要通知同步/);await switchRule(forward);
    assert.equal(stored.automations.forwardPins[0].enabled,false);await toggle(forward).click();
    await forward.locator('[data-feature-add-keyword]').click();await isOpen(forward,true);
    await forward.locator('[data-feature-keyword]').last().fill('测试');await toggle(forward).click();await toggle(forward).click();
    assert.equal(await forward.locator('[data-feature-keyword]').last().inputValue(),'测试');await save(forward);await isOpen(forward,false);
    await catalog('#close-forward-pin');await page.locator('#open-zero-speakers').click();
    const cleanup=page.locator('[data-cleanup-rule]').first();await isOpen(cleanup,false);
    await compactHeader(cleanup,'cleanup');
    assert.ok(await cleanup.locator('[data-cleanup-run]').isVisible(),'cleanup actions remain visible when folded');
    await toggle(cleanup).click();await cleanup.locator('[data-cleanup-field="name"]').fill('检查任务草稿');
    await toggle(cleanup).click();await toggle(cleanup).click();assert.equal(await cleanup.locator('[data-cleanup-field="name"]').inputValue(),'检查任务草稿');
    await save(cleanup);await isOpen(cleanup,false);
    await catalog('#close-zero-speakers');await page.locator('#open-checkin').click();await page.locator('[data-checkin-section="checkins"]').click();
    const checkin=page.locator('.checkin-rule').first();await isOpen(checkin,false);await compactHeader(checkin,'checkin');await switchRule(checkin);
    assert.equal(stored.users[0].checkinSchedules[0].enabled,false);await toggle(checkin).click();
    await page.selectOption('.checkin-rule [data-field="timeMode"]','random');await isOpen(checkin,true);
    await checkin.locator('[data-field="rangeStart"]').fill('11:12:13');await checkin.locator('[data-field="rangeEnd"]').fill('12:13:14');
    await toggle(checkin).click();assert.match(await toggle(checkin).innerText(),/11:12:13–12:13:14/);
    await page.selectOption('#checkin-account-choice','1');await isOpen(checkin,false);
    await page.selectOption('#checkin-account-choice','0');await isOpen(checkin,false);
    await toggle(checkin).click();assert.equal(await checkin.locator('[data-field="rangeEnd"]').inputValue(),'12:13:14');
    await save(checkin);await isOpen(checkin,false);
    assert.equal(stored.users[1].checkinSchedules[0].time,'09:30:15','other account schedules are untouched');
    await page.locator('#checkin-account-settings').click();await page.locator('[data-account-section="messages"]').click();
    const message=page.locator('#schedule-list article').first();await isOpen(message,false);await compactHeader(message,'message');await switchRule(message);
    assert.equal(stored.automations.schedules[0].enabled,false);await toggle(message).click();
    await message.locator('[data-auto-select][data-field="repeat"]').click();await page.locator('[data-auto-option="once"]').click();
    assert.equal(await message.locator('[data-field="time"]').getAttribute('type'),'datetime-local');
    await message.locator('[data-field="time"]').fill('2029-01-02T10:20:31');
    await message.locator('[data-field="message"]').fill('修改消息\n完整保留');
    await toggle(message).click();await toggle(message).click();assert.equal(await message.locator('[data-field="message"]').inputValue(),'修改消息\n完整保留');
    await save(message);await isOpen(message,false);assert.equal(stored.automations.schedules[0].message,'修改消息\n完整保留');
    await page.setViewportSize({width:390,height:844});await noOverflow();await toggle(message).click();await noOverflow();
    await page.locator('[data-view="features"]').click();await page.locator('#close-checkin').click();await page.locator('#open-red-packet').click();
    await noOverflow();await screenshot('rule-cards-mobile-collapsed');
    await first.locator('[data-rule-logs]').click();
    await page.locator('#account-log-dialog[open]').waitFor();
    await page.waitForFunction(()=>document.querySelector('#log-console').textContent.includes('only packet_1'));
    assert.doesNotMatch(await page.locator('#log-console').innerText(),/packet_2/);
    assert.ok(queries.some(query=>query.includes('ruleId=packet_1')&&query.includes('category=red_packet')));
    assert.equal(await page.locator('#log-filter-category').isDisabled(),true);
    await page.locator('#log-filters button[type="reset"]').click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#log-filter-category').inputValue(),'red_packet');
    await page.locator('#account-log-close').click();await page.locator('#account-log-dialog[open]').waitFor({state:'hidden'});
    await packets.locator('[data-red-packet-rule]').nth(1).locator('[data-rule-logs]').click();
    await page.waitForFunction(()=>document.querySelector('#log-console').textContent.includes('only packet_2'));
    assert.doesNotMatch(await page.locator('#log-console').innerText(),/packet_1/);
    await page.locator('#account-log-close').click();await page.locator('#account-log-dialog[open]').waitFor({state:'hidden'});
    await toggle(first).click();await noOverflow();await screenshot('rule-cards-mobile-expanded');
    await page.setViewportSize({width:1440,height:1100});await screenshot('rule-cards-desktop-expanded');
    await page.emulateMedia({reducedMotion:'no-preference'});
    assert.notEqual(await first.locator('.rule-card-body').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    await toggle(first).click();await page.waitForTimeout(300);
    assert.equal(await first.locator('.rule-card-body').evaluate(el=>el.getBoundingClientRect().height),0);
    await page.reload();await page.locator('#open-red-packet').click();await isOpen(first,false);
    await toggle(first).click();
    await first.locator('[data-red-packet-field="name"]').fill('未通过校验的草稿');saveFailure=true;
    await first.locator('[data-rule-save]').click();await page.locator('#toast').filter({hasText:'offline validation error'}).waitFor();
    await isOpen(first,true);assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'未通过校验的草稿');
    saveFailure=false;holdSave=true;
    const saving=save(first);
    await first.locator('[data-rule-save-status]').filter({hasText:'正在保存…'}).waitFor();
    while(!releaseSave)await new Promise(resolve=>setTimeout(resolve,10));
    await first.locator('[data-red-packet-field="name"]').fill('请求期间继续编辑');
    holdSave=false;releaseSave();await saving;
    await isOpen(first,true);
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'请求期间继续编辑');
    assert.equal(stored.automations.redPackets[0].name,'未通过校验的草稿');
    assert.match(await first.locator('[data-rule-save-status]').innerText(),/未保存/);
    const second=packets.locator('[data-red-packet-rule]').nth(1);
    await second.locator('[data-red-packet-remove]').click();await page.locator('.ui-confirm-dialog[open] .primary-btn').click();
    await page.waitForFunction(()=>!document.querySelector('[data-red-packet-rule="packet_2"]'));
    assert.equal(stored.automations.redPackets.length,2,'deleting a saved rule persists without saving other drafts');
    assert.equal(stored.automations.redPackets[0].name,'未通过校验的草稿');
    assert.equal(await first.locator('[data-red-packet-field="name"]').inputValue(),'请求期间继续编辑');
    assert.deepEqual(errors,[]);
    console.log('Rule cards PASS: all five compact headers, desktop action alignment and single-row status, 3/2/1-column packet forms, group names inside input frames, 390/768px expanded layouts, scoped save/delete, sibling drafts, failed/in-flight save edits, rule log isolation/reset, folded actions, keyboard/inert, polling and animation');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
