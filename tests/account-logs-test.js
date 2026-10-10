require('./auth-support');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-logs-'));
  let server;
  const stop = async () => { if (server) { const done = new Promise(resolve => server.once('close', resolve)); server.kill(); await done; server = null; } };
  try {
    for (const file of ['server.js','database.js','admin_auth.js','user_auth.js','system_settings.js','outgoing_proxy.js','telegram_notifications.js','checkin_results.js','automation.js','login.js','schedule_time.js','run_history.js','checkin_scheduler.js','telegram_credentials.js','account_profiles.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(root, file));
    const config = { telegram:{users:['alpha','beta'].map(session => ({name:session,session,api_id:123,api_hash:'offline',bots:['@example_bot']}))}, ai:{providers:[]}, automations:{schedules:[{id:'offline_message',account:'alpha',enabled:true}],forwards:[{id:'offline_forward',account:'beta',enabled:true}]} };
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
    for (const account of ['alpha','beta']) fs.writeFileSync(path.join(root,account+'.session'),'offline fake session');
    fs.writeFileSync(path.join(root,'automation_worker.py'), `import json,time
for account,category,state in [('alpha','message','completed'),('beta','forward','failed')]:
 print(json.dumps(dict(type='log',account=account,category=category,state=state,ruleId='offline',level='error' if state=='failed' else 'info',message=account+' '+category+' event')),flush=True)
print(json.dumps(dict(type='ready')),flush=True)
time.sleep(60)
`);
    fs.writeFileSync(path.join(root,'allinone.py'), `import json
for account,state in [('alpha','completed'),('beta','failed')]:
 print(json.dumps(dict(type='checkin_log',account=account,stream='stdout',text=account+' checkin')),flush=True)
 print(json.dumps(dict(type='account_result',account=account,state=state)),flush=True)
raise SystemExit(1)
`);
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const python = process.env.PYTHON_BIN || path.join(__dirname,'../.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const launch = async () => {
      server = spawn(process.execPath,[path.join(root,'server.js')],{env:{...process.env,PORT:String(port),AUTOCHECKIN_DATA_DIR:root,PYTHON_BIN:fs.existsSync(python)?python:process.platform==='win32'?'python':'python3'},stdio:'ignore'});
      for(let i=0;i<80;i++) {try {if((await fetch(base+'/api/state')).ok)return;}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
      throw new Error('offline server did not start');
    };
    const logs = async query => (await (await fetch(base+'/api/runs'+query)).json()).records;
    await launch();
    for(let i=0;i<80 && (await logs('?category=forward')).length===0;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await logs('?account=alpha&category=message'))[0].lines[0].text,'alpha message event');
    assert.equal((await logs('?account=beta&category=forward'))[0].state,'failed');
    assert.equal((await logs('?account=alpha&category=forward')).length,0);
    assert.equal((await fetch(base+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
    for(let i=0;i<80;i++) {const state=await(await fetch(base+'/api/state')).json();if(state.run.state==='failed')break;await new Promise(resolve=>setTimeout(resolve,50));}
    const alpha = await logs('?account=alpha&category=checkin');
    assert.equal(alpha.length,1); assert.equal(alpha[0].state,'completed');
    assert.deepEqual(alpha[0].lines.map(line=>line.text),['alpha checkin']);
    assert.deepEqual((await logs('?account=beta&category=checkin'))[0].lines.map(line=>line.text),['beta checkin']);
    assert.equal((await logs('?account=unknown')).length,0);
    await stop();
    config.automations={schedules:[],forwards:[]};fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
    require('./auth-support').resetAuth(base);await launch();
    assert.ok((await logs('?account=alpha&category=message')).length>0,'message logs survive restart');
    assert.ok((await logs('?account=beta&category=forward')).length>0,'forward logs survive restart');
    assert.equal((await logs('?account=alpha&category=checkin'))[0].state,'completed');
    console.log('Account logs API PASS: structured automation events, batch ownership/status, category/account isolation and restart persistence');
  } finally { await stop(); fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
})().catch(error => { console.error(error); process.exitCode=1; });
