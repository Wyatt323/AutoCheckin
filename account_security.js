'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const DEFAULTS={enabled:false,alertsEnabled:false,spamCheckEnabled:false,intervalMinutes:60,alertCooldownMinutes:60};
const STATES=new Set(['reachable','restricted','banned','deactivated','login_required','rate_limited','unavailable','action_blocked']);
const text=(value,max=250)=>String(value ?? '').slice(0,max);
const deviceId=(account,hash)=>createHash('sha256').update(JSON.stringify([account,String(hash)])).digest('hex');

// Only allow display data and the opaque Telegram authorization ID into the store.
function cleanResult(input,account) {
  if(!input || !STATES.has(input.status))throw Error('账号防护进程响应无效');
  const result={status:input.status,detail:text(input.detail),terminated:input.terminated===true};
  if(Number.isFinite(input.waitSeconds) && input.waitSeconds>0)result.waitSeconds=Math.min(Math.ceil(input.waitSeconds),31536000);
  if(input.spam && ['clear','limited','unknown'].includes(input.spam.status))result.spam={status:input.spam.status,reply:text(input.spam.reply,5000),appealState:['none','not_needed','pending','submitted','manual','sent_unconfirmed','unconfirmed','error'].includes(input.spam.appealState) ? input.spam.appealState : 'error',appealSent:input.spam.appealSent===true,logs:(Array.isArray(input.spam.logs) ? input.spam.logs : []).slice(0,15).map(value=>text(value,200))};
  if(Array.isArray(input.devices)) {
    if(input.devices.length>200)throw Error('登录设备数量超出检查范围');
    result.userId=text(input.userId,32);
    result.twoFactor=typeof input.twoFactor==='boolean' ? input.twoFactor : null;
    result.recoveryEmail=typeof input.recoveryEmail==='boolean' ? input.recoveryEmail : null;
    result.flags=Object.fromEntries(['restricted','scam','fake'].map(key=>[key,input.flags?.[key]===true]));
    result.restrictionReasons=(input.restrictionReasons || []).slice(0,10).map(value=>text(value,300));
    const seen=new Set();
    result.devices=input.devices.map(item=>{
      const hash=String(item.hash);
      if(!/^-?\d{1,20}$/.test(hash) || seen.has(hash))throw Error('登录设备标识无效');
      seen.add(hash);
      const device={id:deviceId(account,hash),hash,current:item.current===true,unconfirmed:item.unconfirmed===true,passwordPending:item.passwordPending===true};
      for(const key of ['device','platform','system','app','version','ip','country','region'])device[key]=text(item[key],120);
      for(const key of ['createdAt','activeAt'])device[key]=Number.isFinite(Date.parse(item[key])) ? new Date(item[key]).toISOString() : null;
      return device;
    });
  }
  return result;
}

async function createAccountSecurity({dataDir,store=null,readAccounts,execute,notify=async()=>false,notificationReady=()=>false,now=Date.now,tickMs=30000}) {
  const file=path.join(dataDir,'.account-security.json');
  const saved=store ? store.read('account-security') : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
  let data={settings:{...DEFAULTS,...saved?.settings},accounts:saved?.accounts || {},events:saved?.events || [],spamRules:saved?.spamRules || []};
  let queue=Promise.resolve(),timer,closed=false,scanning=false;
  const jobs=new Map();
  const iso=()=>new Date(now()).toISOString();
  const settingsFor=account=>({...data.settings,...data.accounts[account]?.settings});
  function accountFor(account) {const user=readAccounts().find(user=>user.session===account);if(!user)throw Error('账号不存在');return user;}
  function mutate(operation) {
    const pending=queue.then(async()=>{
      const next=structuredClone(data),value=operation(next);
      next.events=next.events.slice(-200);
      if(store)await store.write('account-security',next);
      else {fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      data=next;return value;
    });
    queue=pending.catch(()=>{});return pending;
  }
  function event(next,account,kind,detail) {next.events.push({id:randomUUID(),time:iso(),account,kind,detail});}
  function issues(record) {
    const result=[];
    if(record.status && record.status!=='reachable')result.push(record.detail);
    if(record.twoFactor===false)result.push('尚未开启 Telegram 两步验证');
    const unknown=(record.devices || []).filter(device=>!device.current && !(record.trusted || []).includes(device.id));
    if(unknown.length)result.push(`${unknown.length} 台登录设备尚未确认为本人设备`);
    if(record.flags?.scam || record.flags?.fake)result.push('Telegram 返回诈骗或仿冒标记，请在官方客户端核实');
    if(record.spam?.status==='limited')result.push('SpamBot 返回此账号存在垃圾信息限制（双向限制）');
    if((record.devices || []).some(device=>device.passwordPending || device.unconfirmed))result.push('存在待确认登录或等待密码验证的设备');
    return result;
  }
  async function alert(account) {
    const record=data.accounts[account],warnings=issues(record);
    const settings=settingsFor(account);
    if(!settings.alertsEnabled || !notificationReady() || !warnings.length)return;
    const fingerprint=createHash('sha256').update(JSON.stringify([warnings,(record.devices || []).filter(d=>!d.current && !record.trusted.includes(d.id)).map(d=>d.id).sort()])).digest('hex');
    if(record.alert?.fingerprint===fingerprint && now()-record.alert.time<settings.alertCooldownMinutes*60000)return;
    let alertId;
    await mutate(next=>{
      const row=next.accounts[account];
      if(row.pendingAlert?.fingerprint!==fingerprint)row.pendingAlert={fingerprint,id:'security:'+randomUUID()};
      alertId=row.pendingAlert.id;
    });
    const user=accountFor(account);
    const queued=await notify({id:alertId,kind:'account_security',text:`⚠️ AutoCheckin · 账号防护\n\n账号：${user.name}（${account}）\n${warnings.map(warning=>'• '+warning).join('\n')}\n\n请打开网页「账号防护」核实。\n时间：${new Date(now()+28800000).toISOString().slice(0,19).replace('T',' ')}（北京时间）`});
    if(queued)await mutate(next=>{next.accounts[account].alert={fingerprint,time:now()};delete next.accounts[account].pendingAlert;event(next,account,'alert','账号防护提醒已加入 TG 通知队列');});
  }
  async function apply(account,result,action='inspect',id=null) {
    await mutate(next=>{
      const old=next.accounts[account] || {trusted:[]};
      const row={...old,status:result.status,detail:result.detail,deferred:'',lastAttemptAt:iso(),nextAllowedAt:result.waitSeconds ? now()+result.waitSeconds*1000 : now()+60000};
      if(result.devices) {
        if(old.userId && old.userId!==result.userId){row.trusted=[];row.spam={};row.alert=null;row.pendingAlert=null;event(next,account,'identity_changed','此 Session 的 Telegram 用户 ID 已变化，请重新核对设备及查询双向限制');}
        const oldIds=new Set((old.devices || []).map(device=>device.id));
        for(const device of result.devices)if(!oldIds.has(device.id) && !device.current)event(next,account,'device_found',`发现登录设备：${device.device || device.app || '未知设备'} · ${device.country || '地区未知'}`);
        Object.assign(row,{userId:result.userId,twoFactor:result.twoFactor,recoveryEmail:result.recoveryEmail,flags:result.flags,restrictionReasons:result.restrictionReasons,devices:result.devices,lastSuccessAt:iso()});
        row.trusted=row.trusted.filter(id=>result.devices.some(device=>device.id===id));
      }
      if(result.terminated){row.devices=(row.devices || []).filter(device=>device.id!==id);row.trusted=row.trusted.filter(value=>value!==id);event(next,account,'device_terminated','已按用户确认下线指定登录设备');}
      next.accounts[account]=row;
      if(action==='inspect')event(next,account,'inspection',result.detail);
      else if(!result.terminated)event(next,account,'action_failed',result.detail);
    });
    if(!closed)await alert(account);
  }
  function inspect(account) {
    accountFor(account);
    if(closed || jobs.has(account))throw Error('此账号正在检查或操作，请稍候');
    if((data.accounts[account]?.nextAllowedAt || 0)>now())throw Error('账号巡检正在冷却，请等待页面显示的时间后重试');
    const task=(async()=>{
      let result;
      try {result=await execute(account,'inspect');}
      catch{result={status:'unavailable',detail:'无法执行检查，请检查运行环境与连接状态'};}
      if(result.skipped){await mutate(next=>{event(next,account,'deferred',text(result.detail));next.accounts[account]={...(next.accounts[account] || {trusted:[]}),lastDeferredAt:iso(),deferred:text(result.detail)};});return;}
      await apply(account,cleanResult(result,account));
    })();
    jobs.set(account,task);
    task.finally(()=>jobs.delete(account)).catch(()=>{});
    return task;
  }
  function startCheck(account='') {
    if(account){const task=inspect(account);task.catch(()=>console.error('账号防护结果保存失败'));}
    else {
      if(scanning || jobs.size)throw Error('账号防护正在检查，请稍候');
      if(!readAccounts().length)throw Error('请先添加 Telegram 账号');
      void tick(true).catch(()=>console.error('账号防护检查失败'));
    }
    return view();
  }
  async function tick(force=false) {
    if(closed || scanning)return;
    scanning=true;
    try {
      for(const user of readAccounts()) {
        if(closed)break;
        const row=data.accounts[user.session];
        const settings=settingsFor(user.session);
        if(!force && !settings.enabled)continue;
        const attempted=Date.parse(row?.lastAttemptAt || '') || 0,deferred=Date.parse(row?.lastDeferredAt || '') || 0;
        if(jobs.has(user.session) || (row?.nextAllowedAt || 0)>now() || !force && (now()-attempted<settings.intervalMinutes*60000 || now()-deferred<60000))continue;
        await inspect(user.session);
        if(!closed && settings.spamCheckEnabled && !data.accounts[user.session]?.deferred && now()-(Date.parse(data.accounts[user.session]?.spam?.checkedAt || '') || 0)>=21600000 && (data.accounts[user.session]?.spam?.nextAppealAt || 0)<=now()) {
          await startSpam(user.session,'check');
          await jobs.get(user.session);
        }
      }
    }finally{scanning=false;}
  }
  function view() {
    return {settings:{...data.settings},checking:scanning || jobs.size>0,notificationReady:notificationReady(),accounts:readAccounts().map(user=>{
      const row=data.accounts[user.session] || {trusted:[]};
      return {account:user.session,name:user.name,sessionReady:user.sessionReady,settings:settingsFor(user.session),spam:publicSpam(row.spam),status:row.status || 'unchecked',detail:row.detail || '尚未检查',lastAttemptAt:row.lastAttemptAt || null,lastSuccessAt:row.lastSuccessAt || null,
        nextAllowedAt:row.nextAllowedAt || null,checking:jobs.has(user.session),deferred:row.deferred || '',userId:row.userId || null,twoFactor:row.twoFactor ?? null,recoveryEmail:row.recoveryEmail ?? null,flags:row.flags || {},restrictionReasons:row.restrictionReasons || [],
        issues:issues(row),devices:(row.devices || []).map(({hash,...device})=>({...device,trusted:device.current || row.trusted.includes(device.id)}))};
    }),events:data.events.slice().reverse()};
  }
  async function update(input,account='') {
    if(!input || typeof input!=='object')throw Error('账号防护设置无效');
    if(account)accountFor(account);
    const settings={};
    for(const key of ['enabled','alertsEnabled','spamCheckEnabled']){if(typeof input[key]!=='boolean')throw Error('账号防护开关无效');settings[key]=input[key];}
    for(const [key,min,max] of [['intervalMinutes',15,1440],['alertCooldownMinutes',15,1440]]){
      const value=Number(input[key]);if(!Number.isInteger(value) || value<min || value>max)throw Error('检查或提醒间隔须为 15–1440 分钟');settings[key]=value;
    }
    await mutate(next=>{if(account){next.accounts[account] ||= {trusted:[]};next.accounts[account].settings=settings;}else next.settings=settings;});return view();
  }
  function publicSpam(record={}) {
    const running=jobs.has(record.account) && record.running===true;
    return {status:record.status || 'unchecked',checkedAt:record.checkedAt || null,detail:record.running && !running ? '上次操作结果未保存，请到 @SpamBot 核实' : record.detail || '尚未向 @SpamBot 查询',reply:record.reply || '',lastKnownStatus:record.lastKnownStatus || null,lastKnownAt:record.lastKnownAt || null,appealState:record.appealState==='running' && !running ? 'unconfirmed' : record.appealState || 'none',appealAt:record.appealAt || null,nextCheckAt:record.nextCheckAt || null,nextAppealAt:record.nextAppealAt || null,running};
  }
  const spamAccounts=()=>readAccounts().map(user=>({account:user.session,name:user.name,sessionReady:user.sessionReady,checking:jobs.has(user.session),spam:publicSpam(data.accounts[user.session]?.spam)}));
  const accountSummaries=()=>spamAccounts().map(({account,spam:{status,detail,checkedAt,lastKnownStatus,lastKnownAt}})=>({account,spam:{status,detail,checkedAt,lastKnownStatus,lastKnownAt}}));
  function spamView() {
    return {rules:structuredClone(data.spamRules),accounts:spamAccounts(),events:data.events.filter(event=>event.kind.startsWith('spam_')).slice().reverse()};
  }
  async function saveSpamRule(input) {
    if(!input || typeof input!=='object')throw Error('Spam 规则无效');
    accountFor(input.account);
    const id=input.id || randomUUID();
    if(!/^[\w-]{8,80}$/.test(id))throw Error('规则 ID 无效');
    if(jobs.has(input.account))throw Error('账号正在操作，请稍后保存');
    const rule={id,name:text(input.name || 'Spam 申诉',80).trim(),account:input.account,appealText:String(input.appealText || '').trim()};
    if(rule.appealText.length<10 || rule.appealText.length>2000)throw Error('申诉内容应为 10–2000 字，请根据真实情况填写');
    await mutate(next=>{
      if(next.spamRules.some(row=>row.account===rule.account && row.id!==id))throw Error('此账号已有 Spam 规则，请编辑已有规则');
      const index=next.spamRules.findIndex(row=>row.id===id);
      if(index>=0){if(jobs.has(next.spamRules[index].account))throw Error('原账号正在操作，请稍后保存');next.spamRules[index]=rule;}
      else {if(next.spamRules.length>=100)throw Error('最多保存 100 条规则');next.spamRules.push(rule);}
    });return spamView();
  }
  async function deleteSpamRule(id) {
    const rule=data.spamRules.find(row=>row.id===id);if(!rule)throw Error('规则不存在');
    if(jobs.has(rule.account))throw Error('此账号正在操作，请稍后删除');
    await mutate(next=>{next.spamRules=next.spamRules.filter(row=>row.id!==id);});return spamView();
  }
  async function startSpam(account,mode='check',options={}) {
    accountFor(account);
    if(!['check','appeal'].includes(mode))throw Error('Spam 操作无效');
    if(closed || jobs.has(account))throw Error('此账号正在检查或操作，请稍候');
    const row=data.accounts[account],spam=row?.spam || {};
    if(row?.status==='rate_limited' && row.nextAllowedAt>now())throw Error('Telegram 限流冷却中，请等待后重试');
    if(spam.nextCheckAt>now())throw Error('SpamBot 查询正在冷却，请稍后重试');
    const rule=data.spamRules.find(rule=>rule.id===options.ruleId && rule.account===account);
    if(mode==='appeal') {
      if(options.confirm!==true || options.pledge!==true)throw Error('请确认误封申诉声明后提交');
      if(!rule)throw Error('请先保存此账号的申诉规则');
      if(spam.nextAppealAt>now())throw Error('此账号最近已尝试申诉，请等待 24 小时或前往 @SpamBot 继续处理');
    }
    const task=(async()=>{
      // Persist intent before any outbound message; a crash cannot cause automatic replay.
      await mutate(next=>{
        next.accounts[account] ||= {trusted:[]};const row=next.accounts[account];
        row.spam={...row.spam,account,running:true,nextCheckAt:now()+120000,...(mode==='appeal' ? {nextAppealAt:now()+86400000,appealAt:iso(),appealState:'running'} : {})};
        event(next,account,'spam_started',mode==='appeal' ? '开始向 @SpamBot 提交误封申诉' : '开始向 @SpamBot 查询双向限制状态');
      });
      let result;
      try{result=await execute(account,mode==='appeal' ? 'spam_appeal' : 'spam_check',{appealText:mode==='appeal' ? rule.appealText : '',pledge:options.pledge===true});}
      catch{result={status:'unavailable',detail:'SpamBot 操作中断，请到 Telegram 核实；不会自动重复提交'};}
      if(result.skipped) {
        await mutate(next=>{const saved=next.accounts[account].spam;saved.running=false;saved.nextCheckAt=spam.nextCheckAt || null;saved.nextAppealAt=spam.nextAppealAt || null;saved.appealState=spam.appealState || 'none';saved.detail=text(result.detail);event(next,account,'spam_deferred',saved.detail);});return;
      }
      try{result=cleanResult(result,account);}catch{result={status:'unavailable',detail:'SpamBot 返回无效结果，请到 Telegram 核实；不会重复提交'};}
      await mutate(next=>{
        const row=next.accounts[account],saved=row.spam,payload=result.spam;
        saved.running=false;saved.checkedAt=iso();saved.detail=result.detail;
        saved.status=payload?.status || 'unknown';saved.reply=payload?.reply || '';
        if(['clear','limited'].includes(saved.status)){saved.lastKnownStatus=saved.status;saved.lastKnownAt=iso();}
        if(mode==='appeal')saved.appealState=payload?.appealState || 'unconfirmed';
        if(result.waitSeconds){row.status='rate_limited';row.detail=result.detail;row.nextAllowedAt=now()+result.waitSeconds*1000;saved.nextCheckAt=Math.max(saved.nextCheckAt,row.nextAllowedAt);}
        for(const detail of payload?.logs || [])event(next,account,'spam_step',detail);
        event(next,account,mode==='appeal' ? 'spam_appeal' : 'spam_check',result.detail);
      });
      if(!closed)await alert(account);
    })();
    jobs.set(account,task);
    task.finally(()=>jobs.delete(account)).catch(()=>console.error('SpamBot 结果保存失败，请到官方客户端核实'));
    return spamView();
  }
  async function trust(account,id) {
    accountFor(account);
    if(!data.accounts[account]?.devices?.some(device=>device.id===id))throw Error('设备不存在，请先检查设备列表');
    await mutate(next=>{const row=next.accounts[account];if(!row.trusted.includes(id))row.trusted.push(id);event(next,account,'device_trusted','已由用户确认为本人设备');});
    return view();
  }
  async function terminate(account,id) {
    accountFor(account);
    if(closed || jobs.has(account))throw Error('此账号正在检查或操作，请稍候');
    const record=data.accounts[account],device=record?.devices?.find(device=>device.id===id);
    if(!device || device.current)throw Error('设备不存在或为 AutoCheckin 当前会话，无法下线');
    if(record.status==='rate_limited' && record.nextAllowedAt>now())throw Error('Telegram 限流冷却中，请等待后重试');
    const task=(async()=>{
      const result=await execute(account,'terminate',{hash:device.hash});
      if(result.skipped)throw Error(text(result.detail));
      const clean=cleanResult(result,account);await apply(account,clean,'terminate',id);
      if(!clean.terminated)throw Error(clean.detail);
      return view();
    })();
    jobs.set(account,task);try{return await task;}finally{jobs.delete(account);}
  }
  for(const [account,row] of Object.entries(data.accounts))if(row.spam?.running)await mutate(next=>{const spam=next.accounts[account].spam;spam.running=false;spam.detail='上次 SpamBot 操作被中断，请到 Telegram 核实；不会自动重试';if(spam.appealState==='running')spam.appealState='unconfirmed';event(next,account,'spam_interrupted',spam.detail);});
  return {view,update,trust,terminate,startCheck,tick,spamView,saveSpamRule,deleteSpamRule,startSpam,accountSummaries,
    start(){if(!timer){timer=setInterval(()=>void tick().catch(()=>console.error('账号防护检查或保存失败')),tickMs);timer.unref();}},
    async stop(){closed=true;clearInterval(timer);await Promise.allSettled([...jobs.values()]);await queue;}};
}

function runSecurityWorker({root,dataDir,workerEnv,python,account,action,hash,appealText,pledge,signal}) {
  return new Promise((resolve,reject)=>{
    let child,timer,killTimer,output='',result,error;
    if(signal?.aborted){reject(Error('服务正在停止'));return;}
    try {child=spawn(python.name,[...(python.prefix || []),'-u','account_security_worker.py','--account',account],{cwd:root,env:{...process.env,...workerEnv,AUTOCHECKIN_DATA_DIR:dataDir,PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch{reject(Error('无法启动账号防护进程'));return;}
    const terminate=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();};
    signal?.addEventListener('abort',terminate,{once:true});
    timer=setTimeout(()=>{error=Error('账号防护检查超时');terminate();},action.startsWith('spam_') ? 140000 : 80000);timer.unref();
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      output+=chunk;
      if(output.length>256*1024){error=Error('账号防护进程响应过大');terminate();return;}
      const lines=output.split('\n');output=lines.pop();
      for(const line of lines)try{const event=JSON.parse(line);if(event.type==='account_security')result=event.result;}catch{}
    });
    child.on('error',()=>{error=Error('无法启动账号防护进程');});
    child.once('close',()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',terminate);if(error || !result)reject(error || Error('账号防护检查未完成'));else resolve(result);});
    child.stdin.end(JSON.stringify({action,hash,appealText,pledge})+'\n');
  });
}
module.exports={createAccountSecurity,runSecurityWorker,cleanResult,DEFAULTS};
