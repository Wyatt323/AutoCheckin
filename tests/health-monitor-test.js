const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHealthMonitor,DEFAULTS}=require('../health_monitor');
(async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'health-monitor-'));
  let monitor;
  try {
    let clock=1700000000000,ready=true,accounts=[{session:'first',name:'First',sessionReady:true}],proxies=[],proxyOk=true;
    let autoStatus='running',owned=true,heartbeat=()=>new Date(clock).toISOString(),restarts=0,document,failWrites=false;
    const notices=[],store={read:key=>document,write:async(key,value)=>{assert.equal(key,'health-state');if(failWrites)throw Error('write failed');document=structuredClone(value);}};
    const options={dataDir:directory,store,now:()=>clock,readAccounts:()=>accounts,readProxies:()=>proxies,
      runtime:()=>({automation:{status:autoStatus,message:autoStatus,lastHeartbeatAt:heartbeat()},hasAutomation:true,runs:[],ownedAccounts:owned ? ['first'] : []}),
      testProxy:async()=>({ok:proxyOk,latencyMs:12}),probeAccount:async()=>null,notificationReady:()=>ready,
      recoverAutomation:()=>restarts++,notify:async notice=>{notices.push(notice);return true;}};
    monitor=await createHealthMonitor(options);
    const settings={...DEFAULTS,enabled:true,alertsEnabled:true,intervalSeconds:30,graceSeconds:30,alertCooldownMinutes:1};
    await monitor.update(settings);
    const observe=status=>monitor.observe({type:'health',source:'automation',account:'first',status,detail:status});
    observe('online');await monitor.tick(true);assert.equal(notices.length,0);
    clock+=10000;observe('offline');await monitor.tick();
    clock+=10000;observe('online');await monitor.tick();assert.equal(notices.length,0,'short reconnect is not an alert');
    clock+=10000;observe('offline');await monitor.tick();
    clock+=35000;observe('offline');await monitor.tick();
    assert.equal(notices.length,1);assert.equal(notices[0].kind,'health_alert');assert.equal(notices[0].account,null,'use workspace default route when the failing account proxy is down');
    assert.ok(notices[0].text.includes('First') && notices[0].text.includes('北京时间'));assert.equal(restarts,1);
    await monitor.tick();assert.equal(notices.length,1,'repeat checks obey alert cooldown');
    await monitor.stop();monitor=await createHealthMonitor(options);
    clock+=10000;observe('offline');await monitor.tick();assert.equal(notices.length,1,'restart retains alert cooldown');
    clock+=10000;observe('online');await monitor.tick();
    assert.equal(notices.at(-1).kind,'health_recovery');assert.equal(monitor.view().incidents.length,0);
    assert.equal(monitor.view().events[0].detail,'online','recovery history describes the restored state');
    clock+=10000;observe('offline');await monitor.tick();
    clock+=35000;observe('offline');await monitor.tick();
    const beforePause=notices.length;autoStatus='paused';owned=false;await monitor.tick();
    assert.equal(notices.length,beforePause,'intentional account pause sends no false recovery');
    clock+=35000;await monitor.tick();assert.equal(notices.length,beforePause,'inactive worker telemetry cannot raise an outage');
    autoStatus='running';owned=true;observe('online');
    // A single proxy test failure is not two failed samples, even over many ticks.
    proxies=[{id:'proxy',name:'出口',type:'socks5',password:'never-expose'}];proxyOk=false;
    clock+=10000;observe('online');await monitor.tick(true);const before=notices.length;
    clock+=31000;observe('online');await monitor.tick();
    assert.equal(notices.length,before+1);assert.ok(notices.at(-1).text.includes('出口代理'));
    assert.ok(!JSON.stringify(monitor.view()).includes('never-expose'));
    proxyOk=true;clock+=31000;observe('online');await monitor.tick();assert.equal(notices.at(-1).kind,'health_recovery');
    autoStatus='paused';clock+=120000;observe('online');await monitor.tick();assert.ok(!monitor.view().incidents.some(issue=>issue.name.includes('转发')),'intentional pause never raises a task outage');
    autoStatus='running';owned=true;heartbeat=()=>new Date(clock-100000).toISOString();
    clock+=10000;observe('online');await monitor.tick();assert.ok(monitor.view().incidents.some(issue=>issue.name.includes('抢红包')),'task heartbeat detects a hung loop without relying on group messages');
    const beforeFailure=notices.length;failWrites=true;
    clock+=35000;observe('online');await assert.rejects(monitor.tick(),/write failed/);
    assert.equal(notices.length,beforeFailure,'no alert is dispatched before durable incident state');failWrites=false;
    await assert.rejects(monitor.update({...settings,intervalSeconds:1}),/范围/);
    const previous=monitor.view().settings;failWrites=true;await assert.rejects(monitor.update({...settings,maxRestarts:1}),/write failed/);assert.deepEqual(monitor.view().settings,previous);failWrites=false;
    assert.equal(monitor.view().accounts.length,1);accounts=[];await monitor.tick();assert.equal(monitor.view().accounts.length,0);
    await monitor.stop();
    let release,entered;
    const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
    monitor=await createHealthMonitor({...options,store:{read:()=>null,write:async()=>{}},readProxies:()=>[],
      readAccounts:()=>[{session:'first',name:'First',sessionReady:true},{session:'idle',name:'Idle',sessionReady:true}],
      runtime:()=>({automation:{status:'running',lastHeartbeatAt:new Date(clock).toISOString()},hasAutomation:true,runs:[],ownedAccounts:['first']}),
      probeAccount:async account=>{assert.equal(account,'idle');entered();return blocked;}});
    await monitor.update(settings);observe('offline');const scan=monitor.tick(true);await started;
    try {
      const beforeSlowProbe=notices.length;await monitor.tick();
      clock+=35000;observe('offline');await monitor.tick();
      assert.equal(notices.length,beforeSlowProbe+1,'a slow idle-account probe does not delay live outage alerts');
      assert.equal(monitor.view().checking,true);
    }finally{release({status:'online',detail:'idle check complete'});await scan;}
    console.log('Health monitor PASS: grace, distinct failure samples, cooldown, durable restart/recovery, paused tasks, stale heartbeats, privacy, failed-write gate');
  }finally{await monitor?.stop();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
