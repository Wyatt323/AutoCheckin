// Real local server with fake workers and isolated data; never contacts Telegram.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createScheduler } = require('../checkin_scheduler');

async function schedulerRace() {
  let busy = false, injected = false, saved, launches = 0;
  const store = {
    read: () => saved,
    async write(key, value) {
      saved = structuredClone(value);
      // A manual request acquires the workspace while PostgreSQL commits dequeue.
      if (!injected && Object.keys(value.claimed).length && !value.pending.length) {
        injected = true;
        busy = true;
      }
    }
  };
  const scheduler = createScheduler({
    root: os.tmpdir(), store, now: () => new Date('2027-01-02T01:30:00Z'),
    readConfig: () => ({ telegram: { users: [{ session:'same', checkin_schedules:[{ id:'same_rule', repeat:'daily', time:'09:30' }] }] } }),
    isBusy: () => busy,
    runAccount: async () => { assert.equal(busy, false, 'must not start after another request acquires the workspace'); launches++; }
  });
  await scheduler.tick();
  assert.equal(scheduler.getState().queued, 1, 'manual/automatic competition must retain the queued occurrence');
  assert.equal(launches, 0);
  const restarted = createScheduler({
    root: os.tmpdir(), store, now: () => new Date('2027-01-02T01:30:00Z'),
    readConfig: () => ({ telegram: { users: [{ session:'same', checkin_schedules:[{ id:'same_rule', repeat:'daily', time:'09:30' }] }] } }),
    isBusy: () => busy, runAccount: async () => { launches++; }
  });
  busy = false;
  await restarted.tick(); await restarted.tick();
  assert.equal(launches, 1, 'retained occurrence runs exactly once after release/restart');

  const runs = [], held = new Set(['first']);
  const parallel = createScheduler({root:os.tmpdir(),store:{read:() => undefined,write:async () => {}},
    now:() => new Date('2027-01-02T01:30:00Z'),
    readConfig:() => ({telegram:{users:['first','second'].map(session => ({session,checkin_schedules:[{id:'same_rule',repeat:'daily',time:'09:30'}]}))}}),
    isBusy:account => held.has(account),runAccount:async account => {runs.push(account);held.add(account);}});
  await parallel.tick();
  assert.deepEqual(runs,['second'],'a busy account must not block another account in the queue');
  assert.equal(parallel.getState().queued,1);
  held.delete('first');await parallel.tick();await parallel.tick();
  assert.deepEqual(runs,['second','first']);
}

async function realServer() {
  const tempBase = path.resolve(process.env.AUTOCHECKIN_TEST_TMPDIR || os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'checkin-concurrency-'));
  let server, output = '';
  const stop = async () => {
    if (!server) return;
    const done = new Promise(resolve => server.once('close', resolve));
    server.kill(); await done; server = null;
  };
  try {
    for (const file of ['server.js','user_auth.js','system_settings.js','telegram_notifications.js','checkin_results.js','admin_auth.js','database.js','automation.js','login.js','run_history.js','schedule_time.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js','config.example.json']) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
    }
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({telegram:{users:[]}, ai:{providers:[]}, automations:{schedules:[],forwards:[]}}));
    fs.writeFileSync(path.join(root, 'allinone.py'), `import os,sys,time,json,concurrent.futures,threading
from pathlib import Path
root=Path(os.environ['AUTOCHECKIN_DATA_DIR'])
output_lock=threading.Lock()
def emit(event):
    with output_lock:
        print(json.dumps(event),flush=True)
def execute(account):
    lock=root/('active-'+account+'.lock')
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    try:
        prefix=os.environ.get('AUTOCHECKIN_DOCUMENT_PREFIX','')
        # Windows append writes from separate handles can overwrite each other.
        with output_lock:
            with (root/'executions.jsonl').open('a') as handle:
                handle.write(json.dumps(dict(account=account,prefix=prefix,started=time.time()))+'\\n')
        emit(dict(type='checkin_log',account=account,text=prefix+' '+account))
        time.sleep(20 if '--bot' in sys.argv else 3)
        emit(dict(type='bot_result',account=account,bot='@offline_bot',status='success',note=prefix,result='success'))
        emit(dict(type='account_result',account=account,state='completed'))
    finally:
        os.close(fd)
        lock.unlink()
if '--parallel' in sys.argv:
    with concurrent.futures.ThreadPoolExecutor() as executor:
        list(executor.map(execute,['shared','second']))
else:
    execute(sys.argv[sys.argv.index('--account')+1])
`);
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const request = (url, cookie = '', input) => fetch(base + url, {
      method: input === undefined ? 'GET' : 'POST',
      headers:{Cookie:cookie,'Content-Type':'application/json'},
      ...(input === undefined ? {} : {body:JSON.stringify(input)})
    });
    const waitFor = async (predicate, timeout = 60000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,100)); }
      throw Error('concurrency fixture timeout: ' + output);
    };
    const start = async () => {
      const env = {...process.env, PORT:String(port), ADMIN_USERNAME:'admin', ADMIN_PASSWORD:'offline-admin-secret', AUTOCHECKIN_DATA_DIR:root,
        PYTHON_BIN:process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')};
      for (const key of ['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD']) delete env[key];
      server = spawn(process.execPath,[path.join(root,'server.js')],{env,stdio:['ignore','pipe','pipe']});
      server.stdout.on('data',chunk => output += chunk); server.stderr.on('data',chunk => output += chunk);
      await waitFor(async () => {try {return (await request('/api/auth/status')).ok;} catch {return false;}},10000);
    };
    const login = async (username, password) => {
      const response = await request('/api/auth/login','',{username,password});
      assert.equal(response.status,200); return response.headers.get('set-cookie').split(';')[0];
    };
    const state = async cookie => (await (await request('/api/state',cookie)).json());
    const records = async cookie => (await (await request('/api/runs?category=checkin',cookie)).json()).records;
    await start();
    const admin = await login('admin','offline-admin-secret');
    const tenants = [];
    for (const username of ['alice','bob']) {
      const response = await request('/api/users',admin,{username});
      assert.equal(response.status,201);
      const {user} = await response.json(), cookie = await login(username,'a123456');
      assert.equal((await request('/api/auth/password',cookie,{currentPassword:'a123456',newPassword:username+'-secret'})).status,200);
      const directory = path.join(root,'.user-workspaces',user.id);
      const config = (await state(cookie)).config;
      config.telegram = {apiId:'123',apiHash:'offline'};
      config.users = ['shared','second'].map(session => ({name:session,session,sourceIndex:-1,useGlobalCredentials:true,bots:[{name:'@offline_bot',mode:'command',command:'/sign'}],checkinSchedules:[]}));
      for (const account of config.users) fs.writeFileSync(path.join(directory,account.session+'.session'),'fake-session');
      assert.equal((await request('/api/config',cookie,config)).status,200);
      tenants.push({username,cookie,directory,id:user.id});
    }
    // All requests really race: one run per account, across and within tenants.
    const waves = await Promise.all(tenants.map(async tenant => {
      const replies = await Promise.all(Array.from({length:8},(_,i) => request('/api/run',tenant.cookie,{account:i % 2 ? 'second' : 'shared'})));
      assert.equal(replies.filter(reply => reply.status === 200).length,2);
      assert.equal(replies.filter(reply => reply.status === 400).length,6);
      return state(tenant.cookie);
    }));
    assert.ok(waves.every(value => value.run.state === 'running'), 'different tenants overlap in time');
    assert.ok(waves.every(value => value.activeRuns.length === 2 && value.busyAccounts.length === 2), 'two accounts in each tenant run concurrently');
    assert.notEqual(waves[0].run.id,waves[1].run.id);
    assert.equal((await request('/api/stop',tenants[1].cookie,{id:waves[0].run.id})).status,400);
    assert.equal((await request('/api/stop',tenants[0].cookie,{})).status,400,'ambiguous stop cannot kill an arbitrary account');
    assert.equal((await request('/api/run',tenants[0].cookie,{})).status,400,'batch cannot reuse sessions owned by individual runs');
    assert.equal((await request('/api/login/start',tenants[0].cookie,{account:'second'})).status,400);
    assert.equal((await request('/api/config',tenants[0].cookie,(await state(tenants[0].cookie)).config)).status,400);
    await waitFor(async () => (await Promise.all(tenants.map(t => state(t.cookie)))).every(value => value.activeRuns.length === 0));
    // Two accounts per tenant, all using the same rule ID and second.
    // Fire after both independently randomized cooldowns have elapsed.
    const time = new Date(Date.now()+28800000+16000).toISOString().slice(0,19);
    for (const tenant of tenants) {
      const config = (await state(tenant.cookie)).config;
      for (const account of config.users) account.checkinSchedules = [{id:'shared_rule',enabled:true,repeat:'once',time}];
      assert.equal((await request('/api/config',tenant.cookie,config)).status,200);
    }
    await waitFor(async () => (await Promise.all(tenants.map(t => records(t.cookie)))).every(items => items.length === 4 && items.every(item => item.state === 'completed')));
    for (const tenant of tenants) {
      const items = await records(tenant.cookie), other = tenants.find(t => t !== tenant);
      const scheduled = items.filter(item => item.trigger === 'scheduled');
      assert.deepEqual(scheduled.map(item => item.account).sort(),['second','shared']);
      assert.ok(Date.parse(scheduled[1].startedAt)<Date.parse(scheduled[0].finishedAt), 'different accounts scheduled together overlap in time');
      for (const account of ['shared','second']) {
        const itemsForAccount=items.filter(item=>item.account===account);
        assert.ok(Date.parse(itemsForAccount[1].startedAt)-Date.parse(itemsForAccount[0].finishedAt)>=5000,'cooldown applies to the same account only');
        assert.ok(itemsForAccount.every(item=>item.lines.every(line=>!line.account || line.account===account) && item.botResults.every(result=>result.account===account)), 'concurrent output remains scoped to its run/account');
      }
      assert.ok(JSON.stringify(items).includes(tenant.id));
      assert.ok(!JSON.stringify(items).includes(other.id));
      const executions = fs.readFileSync(path.join(tenant.directory,'executions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(executions.length,4);
      assert.ok(executions.every(item => item.prefix === `tenant:${tenant.id}:`));
      assert.ok(['shared','second'].every(account=>!fs.existsSync(path.join(tenant.directory,'active-'+account+'.lock'))));
    }
    // Stopping an older concurrent run must leave the newer one alive.
    const tenant=tenants[0];
    const earlier=await request('/api/run',tenant.cookie,{account:'shared',bot:'@offline_bot'});
    assert.equal(earlier.status,200);const first=(await earlier.json()).run;
    const later=await request('/api/run',tenant.cookie,{account:'second'});
    assert.equal(later.status,200);const second=(await later.json()).run;
    assert.equal((await request('/api/stop',tenant.cookie,{id:first.id})).status,200);
    await waitFor(async()=> (await records(tenant.cookie)).find(item=>item.id===second.id)?.state==='completed');
    assert.equal((await records(tenant.cookie)).find(item=>item.id===first.id).state,'stopped');
    // OS termination does not execute Python finally; remove only fixture lockfiles.
    fs.rmSync(path.join(tenant.directory,'active-shared.lock'),{force:true});
    await waitFor(async()=>!(await state(tenant.cookie)).busyAccounts.length);
    const batchResponse=await request('/api/run',tenant.cookie,{});
    assert.equal(batchResponse.status,200);const batch=(await batchResponse.json()).run;
    assert.equal(batch.account,null);assert.deepEqual(batch.accounts,['shared','second']);
    assert.equal((await request('/api/run',tenant.cookie,{account:'second'})).status,400,'batch reserves all its sessions');
    await waitFor(async()=> (await records(tenant.cookie)).find(item=>item.id===batch.id)?.state==='completed');
    const batchRecord=(await records(tenant.cookie)).find(item=>item.id===batch.id);
    assert.deepEqual(batchRecord.accountStates,{shared:'completed',second:'completed'});
    assert.equal(batchRecord.botResults?.length,2,JSON.stringify(batchRecord));
    const batchExecutions=fs.readFileSync(path.join(tenant.directory,'executions.jsonl'),'utf8').trim().split('\n').slice(-2).map(JSON.parse);
    assert.deepEqual(batchExecutions.map(item=>item.account).sort(),['second','shared']);
    assert.ok(Math.abs(batchExecutions[0].started-batchExecutions[1].started)<1,'batch worker starts both accounts in parallel: '+JSON.stringify(batchExecutions));
    const totals=await Promise.all(tenants.map(t=>records(t.cookie).then(items=>items.length)));
    const executionCounts=tenants.map(t=>fs.readFileSync(path.join(t.directory,'executions.jsonl'),'utf8').trim().split('\n').length);
    await stop(); await start();
    for (const tenant of tenants) tenant.cookie = await login(tenant.username,tenant.username+'-secret');
    await new Promise(resolve => setTimeout(resolve,2200));
    for (const [index,tenant] of tenants.entries()) {
      assert.equal((await records(tenant.cookie)).length,totals[index], 'restart must retain history without rerunning claimed schedules');
      assert.equal(fs.readFileSync(path.join(tenant.directory,'executions.jsonl'),'utf8').trim().split('\n').length,executionCounts[index]);
    }
    console.log('Check-in concurrency PASS: cross-user/account overlap, Session exclusion/cooldown, same-second schedules, targeted stop, parallel batch, logs/persistence/restart isolation');
  } finally {
    await stop();
    assert.ok(root.startsWith(tempBase + path.sep));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

(async () => { await schedulerRace(); await realServer(); })().catch(error => {console.error(error);process.exitCode=1;});
