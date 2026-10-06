const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createScheduler} = require('../checkin_scheduler');
const {validateTime, due} = require('../schedule_time');
(async () => {
  for (const time of ['00:00:00', '23:59:59', '09:00']) assert.equal(validateTime({repeat:'daily',time},'test').time,time);
  assert.equal(validateTime({repeat:'once',time:'2028-02-29T12:34:56'},'test').time,'2028-02-29T12:34:56');
  for (const time of ['24:00:00','12:60','12:30:60','9:00']) assert.throws(()=>validateTime({repeat:'daily',time},'test'));
  assert.throws(()=>validateTime({repeat:'once',time:'2027-02-29T12:34:56'},'test'));
  assert.throws(()=>validateTime({repeat:'once',timeMode:'random',rangeStart:'09:00',rangeEnd:'10:00'},'test'));
  assert.throws(()=>validateTime({repeat:'daily',timeMode:'random',rangeStart:'23:00',rangeEnd:'01:00'},'test'),/跨午夜/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'random-scheduler-'));
  const rule={id:'random_rule',repeat:'daily',timeMode:'random',rangeStart:'09:00:01',rangeEnd:'09:00:03'};
  const config={telegram:{users:['a','b'].map(session=>({session,checkin_schedules:[{...rule}]}))}};
  let now=new Date('2028-01-01T08:00:00+08:00'), draws=0, busy=true;
  const ran=[];
  const options={root,readConfig:()=>config,runAccount:async a=>ran.push(a),isBusy:()=>busy,now:()=>now,rng:()=>{draws++; return 0;}};
  try {
    let scheduler=createScheduler(options); await scheduler.tick();
    assert.equal(draws,2);assert.deepEqual(scheduler.getState().planned.map(p=>p.time),['09:00:01','09:00:01']);
    const file=path.join(root,'.checkin-schedule-state.json'), stat=fs.statSync(file).mtimeMs;
    await scheduler.tick();assert.equal(fs.statSync(file).mtimeMs,stat);
    scheduler=createScheduler({...options,rng:()=>{throw Error('must not redraw');}}); await scheduler.tick();
    now=new Date('2028-01-01T09:00:01+08:00');await scheduler.tick();assert.equal(scheduler.getState().queued,2);
    config.telegram.users[0].checkin_schedules[0].rangeEnd='09:00:05';await scheduler.tick();assert.equal(scheduler.getState().queued,2);
    busy=false;await scheduler.tick();await scheduler.tick();assert.deepEqual(ran,['a','b']);
    scheduler=createScheduler(options);await scheduler.tick();assert.deepEqual(ran,['a','b']);
    config.telegram.users[0].checkin_schedules[0].enabled=false;await scheduler.tick();assert.equal(scheduler.getState().planned.length,1);
    config.telegram.users[1].checkin_schedules=[];await scheduler.tick();assert.equal(scheduler.getState().planned.length,0);
    config.telegram.users[0].checkin_schedules=[{...rule}];now=new Date('2028-01-02T08:00:00+08:00');await scheduler.tick();assert.equal(scheduler.getState().planned[0].date,'2028-01-02');
    config.telegram.users[0].checkin_schedules[0].rangeStart='09:00:02';scheduler=createScheduler({...options,rng:()=>0.999999});await scheduler.tick();assert.equal(scheduler.getState().planned[0].time,'09:00:03');
    now=new Date('2028-01-02T09:00:13+08:00');await scheduler.tick();assert.equal(ran.length,2);
    // A failed plan commit cannot claim or execute even at its scheduled second.
    fs.mkdirSync(file+'.tmp');now=new Date('2028-01-03T09:00:01+08:00');const original=console.error;console.error=()=>{};
    try {await scheduler.tick();}finally{console.error=original;}assert.equal(ran.length,2);assert.equal(scheduler.getState().planned[0].date,'2028-01-02');fs.rmdirSync(file+'.tmp');
    assert.equal(due({repeat:'daily',time:'09:00'},new Date('2028-01-01T09:00:59+08:00')),true);
    assert.equal(due({repeat:'daily',time:'09:00:00'},new Date('2028-01-01T09:00:10+08:00')),false);
    assert.equal(due({repeat:'once',time:'2028-01-01T09:00:31'},new Date('2028-01-01T09:00:30+08:00')),false);
    console.log('Random JS validation, endpoints, cross-account claims, restart, mutation, cleanup, no-write ticks, missed windows, commit failure PASS');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
