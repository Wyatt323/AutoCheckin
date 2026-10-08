const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTelegramNotifications,formatRunResult}=require('../telegram_notifications');
const token='123456:offline_notification_token_123456';
const wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('notification fixture timeout');};
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tg-notifications-'));let notifier;
  try {
    let clock=Date.now(),calls=[],mode='ok';
    const fetchImpl=async(url,options)=>{
      calls.push({url,body:JSON.parse(options.body)});
      if(mode==='network')throw Error('secret '+token);
      if(mode==='429')return {ok:false,status:429,json:async()=>({ok:false,error_code:429,parameters:{retry_after:5}})};
      if(mode==='403')return {ok:false,status:403,json:async()=>({ok:false,error_code:403,description:token})};
      return {ok:true,status:200,json:async()=>({ok:true})};
    };
    notifier=await createTelegramNotifications({dataDir:root,fetchImpl,now:()=>clock});
    const run={id:'run-1',trigger:'scheduled',account:'first',state:'completed',startedAt:new Date(clock-5000).toISOString(),finishedAt:new Date(clock).toISOString()};
    assert.equal(await notifier.notifyRun(run),false);
    await assert.rejects(notifier.update({enabled:true,chatId:'123'}),/填写/);
    await assert.rejects(notifier.update({enabled:true,botToken:token,chatId:'https://evil.invalid'}),/Chat ID/);
    await notifier.update({enabled:true,botToken:token,chatId:'-100123456'});
    await notifier.update({enabled:true,botToken:'',chatId:'-100123456'});
    assert.ok(!JSON.stringify(notifier.view()).includes(token));
    assert.equal(await notifier.notifyRun({...run,trigger:'manual'}),false);
    await notifier.notifyRun(run,'My account');await wait(()=>notifier.view().deliveries[0]?.state==='sent');
    assert.equal(calls.length,1);assert.equal(calls[0].body.chat_id,'-100123456');
    assert.ok(calls[0].body.text.includes('My account') && calls[0].body.text.includes('已完成'));
    assert.equal(calls[0].body.parse_mode,undefined,'plain text template');
    await notifier.notifyRun(run);await notifier.pump();assert.equal(calls.length,1,'one job per run');
    assert.ok(formatRunResult({...run,accountStates:{first:'failed'}}).includes('失败'),'partial failure reflected');
    await notifier.stop();
    notifier=await createTelegramNotifications({dataDir:root,fetchImpl,now:()=>clock});
    await notifier.notifyRun(run);await notifier.pump();assert.equal(calls.length,1,'restart retains delivered run id');
    mode='429';await notifier.notifyRun({...run,id:'retry'});await wait(()=>notifier.view().deliveries.find(job=>job.id==='retry')?.error);
    assert.equal(notifier.view().deliveries.find(job=>job.id==='retry').state,'pending');
    clock+=5000;mode='ok';await notifier.pump();assert.equal(notifier.view().deliveries.find(job=>job.id==='retry').state,'sent');
    mode='403';await notifier.notifyRun({...run,id:'denied'});await wait(()=>notifier.view().deliveries.find(job=>job.id==='denied')?.state==='failed');
    assert.ok(!JSON.stringify(notifier.view()).includes(token),'Telegram descriptions never expose token');
    mode='network';await notifier.notifyRun({...run,id:'network'});await wait(()=>notifier.view().deliveries.find(job=>job.id==='network')?.error);
    for(let i=0;i<2;i++){clock+=10000;await notifier.pump();}
    assert.equal(notifier.view().deliveries.find(job=>job.id==='network').attempts,3);
    assert.equal(notifier.view().deliveries.find(job=>job.id==='network').state,'failed','bounded retry');
    await notifier.update({enabled:false,chatId:'-100123456'});assert.equal(await notifier.notifyRun({...run,id:'disabled'}),false);
    await assert.rejects(notifier.test(),/启用/);
    let document,fail=false;
    const store={read:()=>document,write:async(key,value)=>{if(fail)throw Error('disk failure');document=structuredClone(value);}};
    await notifier.stop();notifier=await createTelegramNotifications({dataDir:root,store,fetchImpl});
    await notifier.update({enabled:true,botToken:token,chatId:'123'});
    fail=true;const before=calls.length;await assert.rejects(notifier.notifyRun({...run,id:'not-durable'}),/disk failure/);
    assert.equal(calls.length,before,'failed outbox write sends nothing');
    fail=false;await notifier.stop();
    notifier=await createTelegramNotifications({dataDir:root,store,fetchImpl});
    assert.equal(notifier.view().hasToken,true,'PostgreSQL document adapter persists settings');
    console.log('TG notifications PASS: scheduled only, result formatting, privacy, durable outbox/dedup, retries, disable and failed-write gate');
  }finally{await notifier?.stop();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
