// Real frontend, pointer/keyboard/touch input, offline API; no Telegram operations.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
(async()=>{
  if(!process.env.PLAYWRIGHT_MODULE){console.log('Ordering browser skipped: set PLAYWRIGHT_MODULE');return;}
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1100},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[],writes=[],orders={};let fail=false,configWrites=0;
    page.on('pageerror',error=>errors.push(error.message));
    const two=(kind,fields)=>[1,2].map(i=>({id:kind+'_'+i,name:kind+' '+i,account:'first',enabled:true,...fields}));
    const config={telegram:{apiId:'',hasApiHash:false},providers:[],model:'',users:['first','second','third'].map((session,index)=>({name:session,session,sourceIndex:index,sessionReady:true,apiId:'',hasApiHash:false,botSource:'configured',dialogFolder:'',bots:[1,2].map(i=>({name:'@bot_'+i,mode:'command',command:'/sign',note:'备注 '+i})),checkinSchedules:two('daily_'+session,{repeat:'daily',timeMode:'fixed',time:'09:30:15'})})),automations:{forwards:[],schedules:[...two('message',{repeat:'daily',timeMode:'fixed',time:'10:00:20',target:'@target',message:'原始消息'}),{id:'second_message',account:'second',enabled:true,repeat:'daily',time:'11:00',target:'@second',message:'第二账号'}],forwardPins:two('forward',{sources:['@source'],target:'@target',keywords:[],pinAfterForward:true}),redPackets:two('packet',{groups:['-1001234567'],botUsername:'@example_bot',watchSeconds:120,retryInterval:0.5,buttonKeywords:[],successKeywords:[],emptyKeywords:[]})},plugins:{zeroSpeakers:two('cleanup',{group:'@group'})}};
    const status={python:'offline',run:{state:'idle',lines:[]},automation:{status:'running',lines:[]},checkinScheduler:{events:[],planned:[]}};
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if(url.pathname==='/api/state')return json(url.searchParams.get('config')==='0' ? status : {...status,config});
      if(url.pathname==='/api/ui-order') {
        if(route.request().method()==='GET')return json({orders});
        const input=route.request().postDataJSON();writes.push(input);
        if(fail)return route.fulfill({status:500,contentType:'application/json',body:'{"error":"offline"}'});
        orders[input.scope]=input.keys;return json(input);
      }
      if(url.pathname==='/api/config' || url.pathname==='/api/rules'){configWrites++;return json({...status,config});}
      if(url.pathname==='/api/features/spam')return json({spam:{rules:two('spam',{appealText:'Please review my account limitation.'}),accounts:config.users.map(user=>({account:user.session,sessionReady:true})),events:[]}});
      if(url.pathname==='/api/accounts/chats/resolve')return json({results:route.request().postDataJSON().peers.map(value=>({value,status:'ok',title:'示例群组',id:-1001234567,type:'group'}))});
      if(url.pathname.startsWith('/api/'))return json({login:{active:false,state:'idle'},records:[],revision:0});
      const file=url.pathname==='/' ? 'index.html' : url.pathname.slice(1);
      if(!/^[\w.-]+$/.test(file))return route.abort();
      const target=file==='checkin-results.js' ? path.join(__dirname,'../checkin_results.js') : path.join(__dirname,'../public',file);
      if(!fs.existsSync(target))return route.abort();
      return route.fulfill({body:fs.readFileSync(target),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]});
    });
    const waitSaved=async scope=>{await page.waitForFunction(scope=>{const tools=[...document.querySelectorAll('.sort-list-tools')].find(el=>el.dataset.testScope===scope);return tools?.textContent.includes('排序已保存');},scope);};
    const mark=async(list,scope)=>list.evaluate((el,scope)=>el.previousElementSibling.dataset.testScope=scope,scope);
    const ids=async list=>list.locator(':scope > [data-sort-key]').evaluateAll(nodes=>nodes.map(node=>node.dataset.sortKey));
    const keyboard=async(list,scope)=>{
      await mark(list,scope);const before=await ids(list);
      const card=list.locator(':scope > [data-sort-key]').first();await card.locator('.sort-handle').focus();await page.keyboard.press('End');
      await waitSaved(scope);
      assert.deepEqual(await ids(list),[...before.slice(1),before[0]],scope+' keyboard reorder');
    };
    const pointer=async(list,scope,touch=false)=>{
      await mark(list,scope);const before=await ids(list),source=list.locator(':scope > [data-sort-key]').first(),target=list.locator(':scope > [data-sort-key]').last();
      await source.locator('.sort-handle').scrollIntoViewIfNeeded();const from=await source.locator('.sort-handle').boundingBox(),to=await target.boundingBox();
      const x=from.x+from.width/2,y=from.y+from.height/2,tx=to.x+to.width*.75,ty=to.y+to.height*.65;
      if(touch) {
        const session=await context.newCDPSession(page);
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let step=1;step<=8;step++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+(tx-x)*step/8,y:y+(ty-y)*step/8}]});
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();
      } else {await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:10});await page.mouse.up();}
      await waitSaved(scope);assert.deepEqual(await ids(list),[...before.slice(1),before[0]],scope+' pointer reorder');
    };
    const screenshot=async name=>{if(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.AUTOCHECKIN_TEST_SCREENSHOT_DIR,name+'.png'),fullPage:true});};
    await page.goto('https://autocheckin-offline.test/#accounts');
    const accounts=page.locator('#account-list');await accounts.locator('.sort-handle').first().waitFor();
    await pointer(accounts,'accounts');await screenshot('sortable-accounts-desktop');
    assert.deepEqual(orders.accounts,['second','third','first']);
    await page.reload();await accounts.locator('.sort-handle').first().waitFor();assert.deepEqual(await ids(accounts),orders.accounts,'refresh restores server order');
    // A reordered account still opens its own original index and settings.
    await accounts.locator('[data-sort-key="second"] [data-section="messages"]').click();
    assert.equal(await page.locator('#account-detail-name').textContent(),'second');assert.equal(await page.locator('#schedule-list textarea').inputValue(),'第二账号');
    await page.goto('https://autocheckin-offline.test/#accounts?account=first&section=messages');
    await page.reload();
    const messages=page.locator('#schedule-list');await messages.locator('.sort-handle').first().waitFor();
    await messages.locator('[data-rule-toggle]').first().click();await messages.locator('textarea').first().fill('未保存消息草稿');
    await keyboard(messages,'message:first');assert.equal(await messages.locator('[data-sort-key="message:message_1"] textarea').inputValue(),'未保存消息草稿');
    assert.equal(await messages.locator('[data-sort-key="message:message_1"]').getAttribute('data-expanded'),'true','expanded state survives move');
    await page.evaluate(()=>{readEditors();navigate('features');});await page.locator('#open-checkin').click();
    await page.selectOption('#checkin-account-choice','0');await page.locator('[data-checkin-section="checkins"]').click();
    await keyboard(page.locator('.checkin-rules'),'checkin:first');
    await page.locator('[data-checkin-section="bots"]').click();
    const bots=page.locator('.account-bot-table');
    const botBefore=await ids(bots);await bots.locator('.sort-handle').first().focus();await page.keyboard.press('End');
    await page.waitForFunction(()=>document.querySelector('.bot-table').parentElement.previousElementSibling.textContent.includes('排序已保存'));
    assert.deepEqual(await ids(bots),botBefore.reverse());
    await page.locator('#close-checkin').click();
    for(const [open,close,id,scope] of [['#open-forward-pin','#close-forward-pin','#forward-pin-rules','forward'],['#open-zero-speakers','#close-zero-speakers','#zero-speakers-rules','cleanup'],['#open-red-packet','#close-red-packet','#red-packet-rules','packet'],['#open-spam','#close-spam','#spam-rules','spam']]) {
      await page.locator(open).click();await page.locator(id+' .sort-handle').first().waitFor();await keyboard(page.locator(id),scope);await page.locator(close).click();
    }
    assert.equal(configWrites,0,'sorting never submits config or editor drafts');
    await page.locator('#open-red-packet').click();
    const packets=page.locator('#red-packet-rules');await mark(packets,'packet');const before=await ids(packets);
    fail=true;await packets.locator('.sort-handle').first().focus();await page.keyboard.press('End');
    await page.locator('[data-test-scope="packet"]').filter({hasText:'排序保存失败'}).waitFor();assert.deepEqual(await ids(packets),before,'failure restores committed order');
    fail=false;await page.locator('[data-test-scope="packet"] button').click();await waitSaved('packet');assert.deepEqual(await ids(packets),before.reverse(),'retry saves intended order');
    // Escape cancels a drag without saving or opening a rule.
    const saveCount=writes.length,handle=packets.locator('.sort-handle').first();await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();
    await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+10,box.y+90,{steps:4});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(writes.length,saveCount);
    await page.setViewportSize({width:390,height:844});
    await packets.locator('[data-rules-expand]').click();await packets.locator('[data-rules-collapse]').click();await pointer(packets,'packet',true);await screenshot('sortable-rules-mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile has no horizontal overflow');
    assert.deepEqual(errors,[]);console.log('Ordering browser PASS: grid pointer, touch, keyboard, all rule lists and Bots, refresh, correct account binding, drafts, collapse, failure rollback/retry and cancel');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
