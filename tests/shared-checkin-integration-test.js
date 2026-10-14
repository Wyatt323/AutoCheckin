// Real server/API with an offline stdin-controlled listener; no Telegram traffic.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shared-checkin-api-'));let server;
  try {
    for(const file of ['server.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','health_monitor.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json'])fs.copyFileSync(path.join(__dirname,'..',file),path.join(root,file));
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({telegram:{api_id:123,api_hash:'offline',users:['Labubu','other'].map(session=>({name:session,session,bot_groups:{command:[{bot:'@offline_bot',command:'/sign'}]}}))},ai:{providers:[]},automations:{redPackets:[{id:'shared_packet_rule',enabled:true,account:'Labubu',groups:['-100123']} ]}}));
    for(const account of ['Labubu','other'])fs.writeFileSync(path.join(root,account+'.session'),'offline');
    fs.writeFileSync(path.join(root,'allinone.py'),`import sys,json,time
from pathlib import Path
account=sys.argv[sys.argv.index('--account')+1] if '--account' in sys.argv else 'batch'
assert account=='other','listener-owned Session must never open in another worker'
Path('standalone-runs.jsonl').open('a').write(json.dumps(dict(account=account))+'\\n')
time.sleep(1)
print(json.dumps(dict(type='bot_result',account=account,bot='@offline_bot',status='success',result='success')),flush=True)
print(json.dumps(dict(type='account_result',account=account,state='completed')),flush=True)
`);
    fs.writeFileSync(path.join(root,'automation_worker.py'),`import sys,json,time,threading
from pathlib import Path
lock=threading.RLock();jobs={};finished=set();stopped=threading.Event()
p=Path('listener-starts.txt');p.write_text(str(int(p.read_text())+1 if p.exists() else 1))
def emit(event):
    with lock: print(json.dumps(event),flush=True)
def result(id,event): emit(dict(type='checkin',requestId=id,event=event))
def complete(command,code):
    with lock:
        id=command['id']
        if id in finished:return
        finished.add(id);jobs.pop(id,None)
        if code==0:
            for account in command['accounts']:
                result(id,dict(type='bot_result',account=account,bot='@offline_bot',status='success',note='shared note',result='success'))
                result(id,dict(type='account_result',account=account,state='completed'))
        result(id,dict(type='finished',code=code))
def heartbeat():
    while not stopped.wait(0.1):
        emit(dict(type='health',account='Labubu',source='automation',status='online'))
        emit(dict(type='log',category='red_packet',account='Labubu',ruleId='shared_packet_rule',state='running',message='offline packet listener remains active'))
emit(dict(type='ready',checkinAccounts=['Labubu'],message='offline listener'))
threading.Thread(target=heartbeat,daemon=True).start()
try:
    for line in sys.stdin:
        command=json.loads(line);id=command['id']
        with lock:
            Path('shared-runs.jsonl').open('a').write(json.dumps(command)+'\\n')
            if command['type']=='cancel_checkin':
                if id in jobs:
                    original,timer=jobs[id];timer.cancel();complete(original,130)
            else:
                result(id,dict(type='checkin_log',account=command['accounts'][0],text='offline shared signer started'))
                timer=threading.Timer(0.8 if command['scheduled'] else 2,complete,args=(command,0))
                timer.daemon=True;jobs[id]=(command,timer);timer.start()
finally: stopped.set()
`);
    const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const env={...process.env,PORT:String(port),ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'offline-admin-secret',AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform==='win32' ? 'Scripts/python.exe' : 'bin/python')};
    for(const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])delete env[key];
    server=spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:'ignore'});
    const base=`http://127.0.0.1:${port}`;
    const request=(url,cookie='',body,method=body===undefined ? 'GET' : 'POST')=>fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    const wait=async fn=>{const deadline=Date.now()+45000;while(Date.now()<deadline){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,60));}throw Error('shared checkin fixture timeout');};
    await wait(async()=>{try{return(await request('/api/auth/status')).ok;}catch{return false;}});
    const login=async(username,password)=>{const res=await request('/api/auth/login','',{username,password});assert.equal(res.status,200);return res.headers.get('set-cookie').split(';')[0];};
    const admin=await login('admin','offline-admin-secret');
    const state=async()=> (await(await request('/api/state',admin)).json());
    const records=async()=> (await(await request('/api/runs?category=checkin',admin)).json()).records;
    const packets=async()=> (await(await request('/api/runs?category=red_packet',admin)).json()).records;
    await wait(async()=> (await state()).automation.status==='running');
    const initialStart=(await state()).automation.startedAt;
    const userRes=await request('/api/users',admin,{username:'alice'});assert.equal(userRes.status,201);
    const alice=await login('alice','a123456');await request('/api/auth/password',alice,{currentPassword:'a123456',newPassword:'alice-secret'});
    const firstResponse=await request('/api/run',admin,{account:'Labubu'});assert.equal(firstResponse.status,200);const first=(await firstResponse.json()).run;
    await wait(async()=> (await records()).find(run=>run.id===first.id)?.lines.some(line=>line.text==='offline shared signer started'));
    assert.equal((await request('/api/run',admin,{account:'Labubu'})).status,400);
    assert.equal((await request('/api/stop',alice,{id:first.id})).status,400,'other users cannot cancel shared tasks');
    const count=(await packets()).length;await new Promise(resolve=>setTimeout(resolve,250));
    assert.ok((await packets()).length>count,'packets continue while checkin waits');
    assert.equal((await state()).automation.startedAt,initialStart,'listener process never restarted');
    await request('/api/stop',admin,{id:first.id});await wait(async()=> (await records()).find(run=>run.id===first.id)?.state==='stopped');
    assert.equal((await state()).automation.status,'running');
    assert.equal(fs.existsSync(path.join(root,'standalone-runs.jsonl')),false);
    const batchResponse=await request('/api/run',admin,{});assert.equal(batchResponse.status,200);const batch=(await batchResponse.json()).run;
    await wait(async()=> (await records()).find(run=>run.id===batch.id)?.state==='completed');
    const completed=(await records()).find(run=>run.id===batch.id);
    assert.equal(completed.exitCode,0);assert.deepEqual(completed.botResults.map(bot=>bot.account).sort(),['Labubu','other']);
    assert.equal(completed.accountStates.Labubu,'completed');assert.equal(completed.accountStates.other,'completed');
    assert.equal((await state()).automation.startedAt,initialStart);
    assert.ok(!(await packets()).some(run=>run.lines.some(line=>line.text.includes('offline shared signer'))),'shared signer logs stay in checkin history');
    const config=(await state()).config;
    const due=new Date(Date.now()+28800000+20000).toISOString().slice(11,19);
    config.users.find(user=>user.session==='Labubu').bots[0].schedule={enabled:true,time:due};
    assert.equal((await request('/api/config',admin,config)).status,200);
    await wait(async()=> (await state()).automation.status==='running');const scheduledStart=(await state()).automation.startedAt;
    await wait(async()=> (await records()).some(run=>run.trigger==='scheduled' && run.state==='completed'));
    const scheduled=(await records()).find(run=>run.trigger==='scheduled');assert.equal(scheduled.bot,'@offline_bot');
    const commands=fs.readFileSync(path.join(root,'shared-runs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.filter(cmd=>cmd.type==='checkin' && cmd.id===scheduled.id && cmd.scheduled && cmd.bot==='@offline_bot').length,1);
    assert.equal((await state()).automation.startedAt,scheduledStart,'independent bot schedule also keeps listeners alive');
    assert.ok((await packets()).some(run=>Date.parse(run.startedAt)>=Date.parse(scheduled.startedAt) && Date.parse(run.startedAt)<=Date.parse(scheduled.finishedAt)));
    console.log('Shared checkin API PASS: same-account packet continuity, per-account exclusion, user isolation, targeted cancellation, mixed batch results and independent schedule');
  }finally{
    if(server){const done=new Promise(resolve=>server.once('close',resolve));server.kill();await done;}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
