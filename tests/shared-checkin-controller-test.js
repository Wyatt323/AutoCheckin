// Offline worker protocol: check-in cancellation must leave the listener alive.
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
(async()=>{
  let worker;const exported={exports:{}},commands=[],events=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../automation.js'),'utf8'),{module:exported,process,queueMicrotask,setTimeout,clearTimeout,
    require:name=>name==='node:fs' ? {existsSync:()=>true} : name==='node:child_process' ? {spawn:(_command,_args,options)=>{
      assert.equal(options.env.AUTOCHECKIN_CONTROL,'1');assert.equal(options.stdio[0],'pipe');
      worker=new EventEmitter();worker.stdout=new PassThrough();worker.stderr=new PassThrough();worker.stdin=new PassThrough();worker.kills=[];
      worker.stdin.on('data',line=>commands.push(JSON.parse(line)));
      worker.kill=signal=>{worker.kills.push(signal);queueMicrotask(()=>worker.emit('close',null));};
      worker.event=event=>worker.stdout.write(JSON.stringify(event)+'\n');return worker;
    }} : require(name)});
  const automation=exported.exports.createAutomation();
  automation.configure({root:'/offline',store:{read:()=>({}),refresh:async()=>{}},readConfig:()=>({telegram:{users:[{session:'first'}]},automations:{redPackets:[{id:'rule',account:'first'}]}}),pythonCommand:()=>({name:'python'}),onEvent:event=>events.push(event)});
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const ended=job=>new Promise(resolve=>job.once('close',resolve));
  const output=job=>{let value='';job.stdout.on('data',chunk=>value+=chunk);return ()=>value;};
  automation.start();
  let job=automation.runCheckin({id:'request_001',accounts:['first'],scheduled:true}),closed=ended(job),logs=output(job);
  await settle();assert.equal(commands.length,0,'wait for startup to establish clients');
  worker.event({type:'ready',checkinAccounts:['first']});assert.equal(commands[0].type,'checkin');
  assert.equal(commands[0].scheduled,true);
  assert.throws(()=>automation.runCheckin({id:'request_002',accounts:['first']}),/已有签到/);
  worker.event({type:'checkin',requestId:'request_001',event:{type:'checkin_log',account:'first',text:'private result'}});
  worker.event({type:'checkin',requestId:'request_001',event:{type:'checkin_log',account:'other',text:'must ignore'}});
  worker.event({type:'health',account:'first',status:'online'});
  worker.event({type:'log',category:'red_packet',account:'first',ruleId:'rule',state:'completed',message:'packet during checkin'});
  assert.ok(logs().includes('private result'));assert.ok(!logs().includes('must ignore'));
  assert.ok(!events.some(event=>event.message.includes('private result')),'signer logs never leak into packet history');
  automation.recover();assert.equal(worker.kills.length,0,'health recovery cannot kill a shared active checkin');
  job.kill();assert.equal(commands.at(-1).type,'cancel_checkin');assert.equal(worker.kills.length,0);
  worker.event({type:'checkin',requestId:'request_001',event:{type:'finished',code:130}});assert.equal(await closed,130);
  assert.equal(automation.getState().status,'running');assert.ok(events.some(event=>event.message==='packet during checkin'));
  job=automation.runCheckin({id:'request_003',accounts:['first'],bot:'@bot',scheduled:true});closed=ended(job);await settle();
  assert.equal(commands.at(-1).bot,'@bot');worker.event({type:'checkin',requestId:'request_003',event:{type:'finished',code:0}});assert.equal(await closed,0);
  job=automation.runCheckin({id:'request_004',accounts:['first']});closed=ended(job);logs=output(job);await settle();
  worker.emit('close',2);assert.equal(await closed,1);assert.ok(logs() || job.exitCode===1);
  assert.equal(automation.ownedAccounts().length,0,'only exited workers release shared Sessions');
  assert.equal(commands.filter(command=>command.type==='checkin' && command.id==='request_004').length,1,'interrupted sign-in is never automatically replayed');
  await automation.stop();
  console.log('Shared checkin controller PASS: readiness, account exclusion, isolated output, packet continuity, targeted cancel and worker interruption');
})().catch(error=>{console.error(error);process.exitCode=1;});
