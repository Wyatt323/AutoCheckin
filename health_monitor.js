'use strict';
const fs = require('node:fs'), path = require('node:path');
const {randomUUID} = require('node:crypto');
const DEFAULTS = {enabled:false,alertsEnabled:false,intervalSeconds:120,failureThreshold:2,
  graceSeconds:60,alertCooldownMinutes:30,recoveryNotifications:true,maxRestarts:3};
const BAD = new Set(['offline','login_required','failed','unavailable','stale']);

async function createHealthMonitor({dataDir,store=null,readAccounts,readProxies,runtime,
    testProxy,probeAccount,notify,recoverAutomation=()=>{},notificationReady=()=>false,now=Date.now,tickMs=5000}) {
  const file=path.join(dataDir,'.health-state.json');
  const saved=store ? store.read('health-state') : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
  let data={settings:{...DEFAULTS,...saved?.settings},incidents:saved?.incidents || {},events:saved?.events || []};
  const observations=new Map(),proxyResults=new Map(),ruleResults=new Map();
  let timer,closed=false,checking=false,evaluating=false,lastCheckAt=null,lastProbe=0,queue=Promise.resolve();
  let savedSignature=JSON.stringify(data);
  const iso=()=>new Date(now()).toISOString();
  const localTime=()=>new Date(now()+28800000).toISOString().slice(0,19).replace('T',' ')+'（北京时间）';
  async function save() {
    const snapshot=structuredClone(data);
    const pending=queue.then(async()=>{
      const signature=JSON.stringify(snapshot);
      if(signature===savedSignature)return;
      if(store)await store.write('health-state',snapshot);
      else {fs.writeFileSync(file+'.tmp',JSON.stringify(snapshot),{mode:0o600});fs.renameSync(file+'.tmp',file);}
      savedSignature=signature;
    });
    queue=pending.catch(()=>{});return pending;
  }
  function observe(event) {
    if(['message','forward','red_packet'].includes(event.category) && event.ruleId && event.account && readAccounts().some(a=>a.session===event.account)) {
      const previous=ruleResults.get(event.ruleId);
      ruleResults.set(event.ruleId,{state:event.state,detail:String(event.message || '').slice(0,250),at:now(),
        lastSuccessAt:event.state==='completed' ? iso() : previous?.lastSuccessAt || null});
      return;
    }
    if(event.type!=='health' || !event.account || !readAccounts().some(a=>a.session===event.account))return;
    if(!['online','offline','login_required','rate_limited'].includes(event.status))return;
    observations.set(event.account,{status:event.status,detail:String(event.detail || '').slice(0,250),source:event.source,at:now()});
  }
  function taskRows() {
    const current=runtime(),auto=current.automation;
    const rows=[];
    if(current.hasAutomation)rows.push({id:'automation',name:'定时消息 / 监听转发 / 抢红包',status:auto.status,
      detail:auto.message,heartbeatAt:auto.lastHeartbeatAt || null,retryAttempts:auto.retryAttempts || 0,
      retryLimit:auto.retryLimit ?? data.settings.maxRestarts,autoRestartBlocked:Boolean(auto.autoRestartBlocked)});
    for(const rule of current.rules || []) {
      const result=ruleResults.get(rule.id);
      const recent=result && result.at>=Date.parse(auto.startedAt || 0);
      rows.push({id:'rule:'+rule.id,name:({message:'定时消息',forward:'监听转发',red_packet:'抢红包'})[rule.category]+' · '+(rule.name || rule.id),
        account:rule.account,status:recent && result.state==='failed' && auto.status==='running' ? 'failed' : auto.status,
        heartbeatAt:auto.lastHeartbeatAt || null,lastSuccessAt:result?.lastSuccessAt || null,
        detail:recent ? result.detail : '共用自动化连接与心跳，等待执行或收到消息'});
    }
    for(const run of current.runs)rows.push({id:run.id,name:(run.bot ? 'Bot 独立签到' : '签到任务')+' · '+(run.account || '批量'),
      account:run.account,status:run.state,heartbeatAt:run.lastHeartbeatAt || run.startedAt,
      detail:run.state==='running' ? '任务执行中' : '任务正在停止'});
    return rows;
  }
  function accountRows() {
    const current=runtime();
    return readAccounts().map(account=>{
      const observed=observations.get(account.session);
      const owns=current.ownedAccounts.includes(account.session);
      const stale=owns && observed && now()-observed.at>90000;
      const status=!account.sessionReady ? 'login_required' : stale ? 'stale' : observed?.status || 'unknown';
      return {...account,status,detail:!account.sessionReady ? '账号尚未登录' : stale ? '连接心跳超过 90 秒未更新' : observed?.detail || '尚未检查',
        checkedAt:observed ? new Date(observed.at).toISOString() : null,source:observed?.source || null,
        active:owns,lastRun:current.lastRuns?.[account.session] || null};
    });
  }
  function proxyRows() {
    return readProxies().map(proxy=>({id:proxy.id,name:proxy.name,type:proxy.type,
      ...(proxyResults.get(proxy.id) || {status:'unknown',latencyMs:null,checkedAt:null,detail:'尚未检查'})}));
  }
  function event(kind,issue) {
    data.events.push({id:randomUUID(),time:iso(),kind,name:issue.name,detail:issue.detail,account:issue.account || null});
    data.events=data.events.slice(-100);
  }
  async function evaluate(key,bad,metadata) {
    let issue=data.incidents[key];
    if(!bad) {
      if(!issue)return;
      if(metadata.recovery!==false && issue.alerted && data.settings.alertsEnabled && data.settings.recoveryNotifications && notificationReady())
        await notify({id:`health:${issue.id}:recovered`,kind:'health_recovery',account:null,
          text:`✅ AutoCheckin · 运行恢复\n\n${issue.name}\n${metadata.detail || '运行恢复正常'}\n持续时间：${Math.max(0,Math.round((now()-issue.since)/1000))} 秒\n时间：${localTime()}`});
      event(metadata.recovery===false ? 'closed' : 'recovered',{...issue,detail:metadata.detail || issue.detail});delete data.incidents[key];return;
    }
    if(!issue) {
      issue=data.incidents[key]={id:randomUUID(),since:now(),failures:1,alerted:false,sequence:0,...metadata};
      event('detected',issue);
    }
    if(issue.sample!==metadata.sample)issue.failures++;
    Object.assign(issue,metadata);
    if(issue.failures<data.settings.failureThreshold || now()-issue.since<data.settings.graceSeconds*1000)return;
    if(metadata.recoverable && data.settings.maxRestarts>0)recoverAutomation();
    if(!data.settings.alertsEnabled || !notificationReady())return;
    if(issue.lastAlertAt!=null && now()-issue.lastAlertAt<data.settings.alertCooldownMinutes*60000)return;
    // Persist a stable outbox ID before enqueueing. Retrying after a crash is idempotent.
    issue.pendingId ||= `health:${issue.id}:alert:${issue.sequence}`;
    await save();
    const queued=await notify({id:issue.pendingId,kind:'health_alert',account:null,
      text:`⚠️ AutoCheckin · 运行异常\n\n${issue.name}\n${issue.detail}\n持续时间：${Math.max(0,Math.round((now()-issue.since)/1000))} 秒\n请查看网页「运行健康监控」。\n时间：${localTime()}`});
    if(queued){issue.alerted=true;issue.lastAlertAt=now();issue.sequence++;delete issue.pendingId;event('alert',issue);}
  }
  async function tick(force=false) {
    if(closed)return;
    if(!data.settings.enabled && !force)return;
    // A slow proxy/idle-account scan must not delay live heartbeats and alerts.
    if(checking || !force && now()-lastProbe<data.settings.intervalSeconds*1000) {
      await evaluateAll();return;
    }
    checking=true;
    try {
      lastProbe=now();
      for(const proxy of readProxies()) {
        if(closed)break;
        let result;
        try{result=await testProxy(proxy);}catch{result={ok:false};}
        if(result.skipped)continue;
        proxyResults.set(proxy.id,{status:result.ok ? 'online' : 'offline',latencyMs:result.ok ? result.latencyMs : null,
          checkedAt:iso(),detail:result.ok ? 'Telegram HTTPS 连通正常' : '代理连接失败或超时'});
      }
      const accounts=readAccounts();let index=0;
      await Promise.all(Array.from({length:Math.min(3,accounts.length)},async()=>{
        while(!closed && index<accounts.length) {
          const account=accounts[index++];
          const observed=observations.get(account.session);
          if(!account.sessionReady || observed && now()-observed.at<data.settings.intervalSeconds*1000)continue;
          const result=await probeAccount(account.session);
          if(result)observe({type:'health',source:'probe',account:account.session,...result});
        }
      }));
      lastCheckAt=iso();
    } finally {checking=false;}
    await evaluateAll();
  }
  async function evaluateAll() {
    if(closed || evaluating || !data.settings.enabled)return;
    evaluating=true;
    try {
        const keys=new Set();
        for(const account of accountRows()) {
          const key='account:'+account.session;keys.add(key);
          if(account.status==='unknown')continue;
          if(account.sessionReady && !account.active && ['automation','checkin'].includes(account.source)) {
            await evaluate(key,false,{detail:'账号任务已暂停或结束，等待下次连接检查',recovery:false});
            continue;
          }
          await evaluate(key,BAD.has(account.status),{name:'账号：'+account.name+'（'+account.session+'）',account:account.session,detail:account.detail,
            sample:account.status==='stale' || !account.sessionReady ? iso() : account.checkedAt,
            recoverable:account.source==='automation' && ['offline','stale'].includes(account.status)});
        }
        for(const proxy of proxyRows()) {
          const key='proxy:'+proxy.id;keys.add(key);
          if(proxy.status==='unknown')continue;
          await evaluate(key,proxy.status==='offline',{name:'出口代理：'+proxy.name,detail:proxy.detail,sample:proxy.checkedAt});
        }
        for(const task of taskRows()) {
          const key='task:'+task.id;keys.add(key);
          const stale=['running','starting'].includes(task.status) && task.heartbeatAt && now()-Date.parse(task.heartbeatAt)>90000;
          if(['starting','recovering'].includes(task.status) && !stale)continue;
          await evaluate(key,BAD.has(task.status) || stale,{name:task.name,account:task.account,detail:stale ? '任务心跳超过 90 秒未更新' : task.detail,
            sample:iso(),recoverable:task.id==='automation' && stale,recovery:!['paused','stopping','idle'].includes(task.status)});
        }
        for(const key of Object.keys(data.incidents))if(!keys.has(key))await evaluate(key,false,{detail:'任务已结束或配置已移除',recovery:false});
      await save();
    } finally {evaluating=false;}
  }
  function view() {
    return {settings:{...data.settings},accounts:accountRows(),proxies:proxyRows(),tasks:taskRows(),
      incidents:Object.values(data.incidents).map(issue=>({...issue,confirmed:issue.failures>=data.settings.failureThreshold && now()-issue.since>=data.settings.graceSeconds*1000})),
      events:data.events.slice().reverse(),checking,lastCheckAt,notificationReady:notificationReady()};
  }
  async function update(input) {
    if(!input || typeof input!=='object' || Array.isArray(input))throw Error('健康监控配置格式不正确');
    const next={...data.settings};
    for(const key of ['enabled','alertsEnabled','recoveryNotifications']) {
      if(typeof input[key]!=='boolean')throw Error('健康监控开关格式不正确');next[key]=input[key];
    }
    for(const [key,min,max] of [['intervalSeconds',30,3600],['failureThreshold',1,10],['graceSeconds',30,600],['alertCooldownMinutes',1,1440],['maxRestarts',0,10]]) {
      const value=Number(input[key]);if(!Number.isInteger(value) || value<min || value>max)throw Error('健康监控参数超出允许范围');next[key]=value;
    }
    const old=data.settings;data.settings=next;
    try{await save();}catch(error){data.settings=old;throw error;}
    return view();
  }
  return {view,update,observe,tick,retryLimit:()=>data.settings.maxRestarts,
    start(){if(!timer){timer=setInterval(()=>void tick().catch(()=>console.error('健康监控检查或状态保存失败')),tickMs);timer.unref();}},
    async stop(){closed=true;clearInterval(timer);while(checking || evaluating)await new Promise(resolve=>setTimeout(resolve,20));await queue;}};
}
module.exports={createHealthMonitor,DEFAULTS};
