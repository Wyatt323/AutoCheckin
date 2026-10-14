const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
(async()=>{
  let clock=1700000000000,children=[],timers=[];
  class TestDate extends Date{constructor(...args){super(...(args.length ? args : [clock]));}static now(){return clock;}}
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../automation.js'),'utf8'),{module,process,Date:TestDate,
    setTimeout:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cancelled=true;},
    require:name=>name==='node:fs' ? {existsSync:()=>true} : name==='node:child_process' ? {spawn:()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];
      child.kill=signal=>{child.kills.push(signal);queueMicrotask(()=>child.emit('close',null));};
      child.event=data=>child.stdout.write(JSON.stringify(data)+'\n');children.push(child);return child;
    }} : require(name)});
  const automation=module.exports.createAutomation();
  automation.configure({root:'/offline',store:{read:()=>({}),refresh:async()=>{}},readConfig:()=>({telegram:{users:[{session:'first'}]},automations:{redPackets:[{id:'rule',enabled:true,account:'first'}]}}),pythonCommand:()=>({name:'python'}),retryLimit:()=>2});
  const retry=()=>{const timer=timers.findLast(timer=>timer.ms===15000 && !timer.cancelled);assert.ok(timer);timer.cancelled=true;timer.fn();};
  automation.start();children.at(-1).emit('close',1);assert.equal(automation.getState().retryAttempts,1);retry();
  children.at(-1).emit('close',1);assert.equal(automation.getState().retryAttempts,2);
  const duringBackoff=children.length;automation.start();assert.equal(children.length,duringBackoff,'ordinary resumes cannot bypass recovery backoff');retry();
  children.at(-1).emit('close',1);assert.equal(automation.getState().autoRestartBlocked,true);
  const count=children.length;automation.start();assert.equal(children.length,count,'ordinary resumes cannot bypass recovery limit');
  await automation.restart();assert.equal(automation.getState().autoRestartBlocked,false);assert.equal(automation.getState().retryAttempts,0);
  const healthy=children.at(-1);healthy.event({type:'ready'});healthy.event({type:'fatal',message:'offline failure'});
  assert.deepEqual(Array.from(automation.ownedAccounts()),['first'],'failed workers retain Session ownership until close');
  healthy.event({type:'ready'});automation.recover();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(healthy.kills[0],'SIGTERM');assert.equal(automation.getState().retryAttempts,1);retry();
  children.at(-1).event({type:'ready'});children.at(-1).event({type:'health',account:'first',source:'automation',status:'offline'});
  clock+=120001;children.at(-1).event({type:'health',source:'automation',status:'running'});
  assert.equal(automation.getState().retryAttempts,1,'offline account heartbeats never reset the recovery cap');
  children.at(-1).event({type:'health',account:'first',source:'automation',status:'online'});
  clock+=120001;children.at(-1).event({type:'health',source:'automation',status:'running'});
  assert.equal(automation.getState().retryAttempts,0,'healthy runtime resets failure streak after two minutes');
  await automation.stop();
  assert.equal(automation.ownedAccounts().length,0,'closed workers release ownership');
  console.log('Automation recovery PASS: capped restart, blocked resume, manual reset, graceful recovery and stable reset');
})().catch(error=>{console.error(error);process.exitCode=1;});
