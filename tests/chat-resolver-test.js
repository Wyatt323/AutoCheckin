const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {EventEmitter}=require('node:events'), {PassThrough}=require('node:stream');
const {createChatResolver}=require('../chat_resolver');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autocheckin-chat-resolver-'));
  let calls=0,lastArgs;
  const opts={root,dataDir:root,readConfig:()=>({telegram:{users:[{session:'one',api_id:123,api_hash:'do-not-expose'},{session:'two',api_id:123,api_hash:'do-not-expose'}]}}),pythonCommand:()=>({name:'python',prefix:[]}),spawnWorker:(name,args,options)=>{
    calls++;lastArgs=args;assert.equal(options.windowsHide,true);assert.ok(!args.includes('do-not-expose'));
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>queueMicrotask(()=>child.emit('close',null));
    queueMicrotask(()=>{child.stdout.write(JSON.stringify({results:JSON.parse(args.at(-1)).map(value=>({value,status:'ok',title:args.at(-2)==='one'?'频道一':'频道二',id:'-100123',type:'channel'}))}));child.emit('close',0);});return child;
  }};
  try {
    for(const account of ['one','two'])fs.writeFileSync(path.join(root,account+'.session'),'offline-fake-session');
    const resolver=createChatResolver(opts);
    assert.equal((await resolver.resolve('one',['@test_channel']))[0].title,'频道一');
    await resolver.resolve('one',['@test_channel']);assert.equal(calls,1,'repeat names use cache');
    assert.equal((await resolver.resolve('two',['@test_channel']))[0].title,'频道二');assert.equal(calls,2,'accounts have distinct results');
    await assert.rejects(resolver.resolve('../one',['@test_channel']));
    await assert.rejects(resolver.resolve('missing',['@test_channel']));
    assert.equal((await resolver.resolve('one',['https://evil.example/abc']))[0].status,'error');assert.equal(calls,2,'invalid references spawn no Telegram process');
    const stamp=new Date(Date.now()+5000);fs.utimesSync(path.join(root,'one.session'),stamp,stamp);
    await resolver.resolve('one',['@test_channel']);assert.equal(calls,3,'a changed session invalidates cached identity');
    await Promise.all([resolver.resolve('one',['@parallel_channel']),resolver.resolve('one',['@parallel_channel'])]);
    assert.equal(calls,4,'simultaneous identical requests share one worker');
    assert.ok(lastArgs.includes(path.join(root,'chat_lookup.py')));
    await resolver.shutdown();await assert.rejects(resolver.resolve('one',['@test_channel']));
    const workers=[];
    const slowOptions={...opts, stopGraceMs:5, spawnWorker:()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.signals=[];
      child.kill=(signal='SIGTERM')=>{child.signals.push(signal);if(signal==='SIGKILL')queueMicrotask(()=>child.emit('close',null));};
      workers.push(child);return child;
    }};
    // A referenced watchdog also ensures unref'd process timers cannot silently end the test.
    async function within(promise) {
      let timer;
      try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker cleanup hung')),2000);})]); }
      finally {clearTimeout(timer);}
    }
    const slow=createChatResolver(slowOptions);
    const cancelled=assert.rejects(slow.resolve('one',['@slow_channel']),/服务正在停止/);
    const stopped=slow.shutdown();assert.equal(slow.shutdown(),stopped,'shutdown shares completion');
    await within(Promise.all([cancelled,stopped]));
    assert.deepEqual(workers[0].signals,['SIGTERM','SIGKILL'],'shutdown escalates without waiting for query timeout');
    const timed=createChatResolver({...slowOptions,timeoutMs:10});
    await within(assert.rejects(timed.resolve('one',['@slow_channel']),/超时/));
    await timed.shutdown();
    assert.deepEqual(workers[1].signals,['SIGTERM','SIGKILL']);
    const oversized=createChatResolver(slowOptions);
    const overflow=assert.rejects(oversized.resolve('one',['@slow_channel']),/无法查询名称/);
    workers[2].stdout.write('x'.repeat(100001));
    workers[2].stdout.write('x'.repeat(100001));
    await within(overflow);await oversized.shutdown();
    assert.deepEqual(workers[2].signals,['SIGTERM','SIGKILL'],'excess output stops once and discards further chunks');
    console.log('Chat resolver PASS: account isolation, Session cache invalidation, credential redaction, validation and shutdown');
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error);process.exitCode=1;});
