// Persistent submission intent, tenant scope, cooldowns and independent account settings.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAccountSecurity,DEFAULTS}=require('../account_security');
const {scopedStore}=require('../database');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'spam-policy-')),docs=new Map();
  let time=Date.now(),fail=false,calls=0,mode='limited',skip=false;
  const store={read:key=>docs.get(key),write:async(key,value)=>{if(fail)throw Error('write failed');docs.set(key,structuredClone(value));},keys:()=>[...docs.keys()]};
  const options={dataDir:root,store,readAccounts:()=>['first','second'].map(session=>({session,name:session,sessionReady:true})),now:()=>time,execute:async(account,action,args)=>{
    calls++;
    if(action==='inspect')return {status:'reachable',detail:'offline',devices:[]};
    assert.ok(docs.get('account-security').accounts[account].spam.nextCheckAt>time,'intent is durable before sending anything');
    if(action==='spam_appeal'){assert.ok(docs.get('account-security').accounts[account].spam.nextAppealAt>time);assert.ok(args.pledge);}
    return skip ? {skipped:true,detail:'Session busy'} : mode==='flood' ? {status:'rate_limited',detail:'Telegram wait',waitSeconds:7200} : {status:'reachable',detail:'offline SpamBot',spam:{status:mode,reply:'bot reply',appealState:action==='spam_appeal' ? 'submitted' : 'none',logs:['offline step']}};
  }};
  let security=await createAccountSecurity(options);
  const settle=async()=>{while(security.view().checking)await new Promise(resolve=>setTimeout(resolve,1));};
  try{
    await security.update({...DEFAULTS,enabled:true,intervalMinutes:90},'first');
    assert.equal(security.view().accounts[0].settings.enabled,true);assert.equal(security.view().accounts[1].settings.enabled,false);
    assert.equal(security.view().settings.enabled,false,'account preferences do not enable other accounts');
    const rule={id:'first_spam_rule',name:'first',account:'first',appealText:'Please review the restriction on my account.'};
    await security.saveSpamRule(rule);
    await assert.rejects(security.saveSpamRule({...rule,id:'another_rule'}),/已有/);
    await assert.rejects(security.saveSpamRule({...rule,account:'foreign'}),/不存在/);
    await assert.rejects(security.startSpam('first','appeal',{ruleId:rule.id,confirm:true}),/声明/);
    assert.equal(calls,0);
    await security.startSpam('first','check');await settle();
    assert.equal(security.spamView().accounts[0].spam.status,'limited');
    await assert.rejects(security.startSpam('first','check'),/冷却/);
    time+=121000;await security.startSpam('first','appeal',{ruleId:rule.id,confirm:true,pledge:true});await settle();
    assert.equal(security.spamView().accounts[0].spam.status,'limited','an accepted appeal is never labelled unrestricted');
    assert.equal(security.spamView().accounts[0].spam.appealState,'submitted');
    time+=121000;await assert.rejects(security.startSpam('first','appeal',{ruleId:rule.id,confirm:true,pledge:true}),/24/);
    await security.stop();security=await createAccountSecurity(options);
    assert.equal(security.spamView().rules.length,1);await assert.rejects(security.startSpam('first','appeal',{ruleId:rule.id,confirm:true,pledge:true}),/24/);
    mode='clear';await security.startSpam('first','check');await settle();assert.equal(security.spamView().accounts[0].spam.status,'clear');
    time+=121000;mode='flood';await security.startSpam('first','check');await settle();assert.equal(security.spamView().accounts[0].spam.status,'unknown');
    assert.equal(security.spamView().accounts[0].spam.lastKnownStatus,'clear','inconclusive checks retain the previous known result separately');
    time+=121000;await assert.rejects(security.startSpam('first','check'),/限流/);
    const tenant=await createAccountSecurity({...options,store:scopedStore(store,'tenant:b:')});assert.equal(tenant.spamView().rules.length,0);assert.equal(tenant.spamView().events.length,0);await tenant.stop();
    time+=86400000;mode='limited';fail=true;const before=calls;
    await security.startSpam('second','check');await settle();assert.equal(calls,before,'failed intent writes never send outbound messages');fail=false;
    skip=true;await security.startSpam('second','check');await settle();assert.equal(security.spamView().accounts[1].spam.status,'unchecked');
    assert.equal(security.spamView().accounts[1].spam.nextCheckAt,null,'a busy Session is not charged as an outbound query');
    const persisted=structuredClone(docs.get('account-security'));persisted.accounts.first.spam.running=true;persisted.accounts.first.spam.appealState='running';docs.set('account-security',persisted);
    await security.stop();security=await createAccountSecurity(options);assert.equal(security.spamView().accounts[0].spam.appealState,'unconfirmed');assert.ok(security.spamView().events.some(event=>event.kind==='spam_interrupted'));
    let automaticChecks=0;
    const automatic=await createAccountSecurity({...options,store:scopedStore(store,'automatic:'),execute:async(account,action)=>{if(action==='spam_check')automaticChecks++;return action==='inspect' ? {status:'reachable',detail:'offline inspection',devices:[]} : {status:'reachable',detail:'offline status',spam:{status:'clear',appealState:'none'}};}});
    await automatic.update({...DEFAULTS,enabled:true,spamCheckEnabled:true},'first');
    await automatic.tick();assert.equal(automaticChecks,1);
    time+=3600001;await automatic.tick();assert.equal(automaticChecks,1,'hourly inspections do not query SpamBot hourly');
    time+=21600001;await automatic.tick();assert.equal(automaticChecks,2);await automatic.stop();
    console.log('Spam policy PASS: per-account settings, tenant isolation, durable pre-send intent, no replay, cooldowns/restart, conservative status and failed-write protection');
  }finally{await security.stop();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
